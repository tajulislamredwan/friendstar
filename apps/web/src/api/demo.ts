/**
 * DemoBackend — a complete in-browser implementation of the Backend contract, used for the
 * static hosted preview. Data lives in localStorage (shared by tabs); each tab has its own
 * session (sessionStorage), and BroadcastChannel carries real-time events between tabs.
 * "Nova" is a built-in guide bot that shows delivered → read → typing → reply.
 */
import {
  loginSchema,
  privacySchema,
  registerSchema,
  updateProfileSchema,
  type AppNotification,
  type ConversationSummary,
  type FileMeta,
  type Me,
  type Message,
  type MessageHit,
  type MessageStatus,
  type PrivacySettings,
  type OfflineReplySettings,
  type PublicUser,
} from '@friendstar/shared';
import { ZodError } from 'zod';
import type { AdminAnnouncementPreview, AdminAnnouncementRecord, AdminBotRow, AdminLoginEvent, AdminPasswordResetRequest, AdminSummary, AdminUserRow } from '@friendstar/shared';

/** Stable pseudo FriendStar ID for demo users (derived from their id). */
function demoFriendId(id: string): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet[h % alphabet.length];
    h = Math.floor(h / alphabet.length) + (i + 1) * 7919;
  }
  return `FS-${out.slice(0, 5)}${(h % 8) + 2}`;
}
import { ApiError, Emitter, type Backend, type ConnectionState } from './backend.ts';

/* ---------- storage model ---------- */
interface DUser {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
  bio: string;
  avatarFileId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  bot?: boolean;
}
interface DConv {
  id: string;
  members: [string, string];
  lastRead: Record<string, string | null>;
  lastMessageId: string | null;
  updatedAt: string;
}
interface DMsg {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string;
  kind: 'text' | 'image' | 'file';
  body: string;
  fileId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}
interface DFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  width: number | null;
  height: number | null;
}
interface DNote extends AppNotification {
  userId: string;
}
interface DB {
  version: number;
  users: DUser[];
  privacy: Record<string, PrivacySettings>;
  blocks: { blocker: string; blocked: string }[];
  conversations: DConv[];
  messages: DMsg[];
  files: Record<string, DFile>;
  notifications: DNote[];
}

type Signal =
  | { type: 'message:new'; messageId: string }
  | { type: 'status'; to: string; conversationId: string; messageIds: string[]; status: 'delivered' | 'read'; at: string }
  | { type: 'typing'; to: string; conversationId: string; userId: string; isTyping: boolean }
  | { type: 'presence'; userId: string }
  | { type: 'notification'; to: string; notificationId: string }
  | { type: 'conv'; to: string; conversationId: string };

const DB_KEY = 'fs_demo_db_v1';
const PRESENCE_KEY = 'fs_demo_presence';
const SESSION_KEY = 'fs_demo_session';
const DEMO_PASSWORD = crypto.randomUUID();
const DEMO_FILE_LIMIT = 1.5 * 1024 * 1024;
const BOT_ID = 'u_nova';

const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hashPassword(password: string, salt: string) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return `${salt}$${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
function checkPassword(_password: string, _stored: string) {
  // This backend is an offline demo with synthetic accounts, not real authentication.
  return true;
}

function zodToApi(err: unknown): never {
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const i of err.issues) fields[i.path.join('.') || 'form'] ??= i.message;
    throw new ApiError('VALIDATION', Object.values(fields)[0] ?? 'Invalid input', fields, 400);
  }
  throw err;
}

const DEFAULT_PRIVACY: PrivacySettings = {
  lastSeen: 'everyone',
  profilePhoto: 'everyone',
  readReceipts: true,
  whoCanMessage: 'everyone',
  discoverable: true,
};

async function seed(): Promise<DB> {
  const db: DB = { version: 1, users: [], privacy: {}, blocks: [], conversations: [], messages: [], files: {}, notifications: [] };
  const people = [
    { id: 'u_alice', username: 'alice', displayName: 'Alice Rahman', bio: 'Coffee, code and constellations ☕✨' },
    { id: 'u_bob', username: 'bob', displayName: 'Bob Chowdhury', bio: 'Weekend cyclist. Weekday debugger.' },
    { id: 'u_carol', username: 'carol', displayName: 'Carol Das', bio: 'Designer who loves rounded corners.' },
    { id: 'u_dan', username: 'dan', displayName: 'Dan Hossain', bio: 'Only takes messages from friends.' },
    { id: BOT_ID, username: 'nova', displayName: 'Nova · FriendStar Guide', bio: 'I reply instantly so you can see ticks in action.', bot: true },
  ];
  for (const p of people) {
    db.users.push({
      ...p,
      email: `${p.username}@friendstar.dev`,
      passwordHash: await hashPassword(DEMO_PASSWORD, p.id),
      avatarFileId: null,
      lastSeenAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      createdAt: now(),
    });
    db.privacy[p.id] = { ...DEFAULT_PRIVACY };
  }
  db.privacy.u_dan = { ...DEFAULT_PRIVACY, whoCanMessage: 'contacts', lastSeen: 'nobody' };

  const chat = (a: string, b: string, lines: [string, string][], minutesAgo: number) => {
    const conv: DConv = { id: rid('c'), members: [a, b], lastRead: { [a]: null, [b]: null }, lastMessageId: null, updatedAt: now() };
    let t = Date.now() - minutesAgo * 60_000;
    for (const [who, body] of lines) {
      t += 45_000;
      const at = new Date(t).toISOString();
      const m: DMsg = { id: rid('m'), conversationId: conv.id, senderId: who, clientId: rid('k'), kind: 'text', body, fileId: null, createdAt: at, deliveredAt: at, readAt: who === a ? at : null };
      db.messages.push(m);
      conv.lastMessageId = m.id;
      conv.updatedAt = at;
    }
    conv.lastRead[a] = conv.updatedAt;
    db.conversations.push(conv);
  };
  chat('u_bob', 'u_alice', [
    ['u_alice', 'Hey Bob! Are we still on for the ride on Friday? 🚴'],
    ['u_bob', 'Absolutely. 7am at the lake?'],
    ['u_alice', 'Perfect. I’ll bring the snacks.'],
    ['u_bob', 'Deal. Also — did you see the new FriendStar dark mode? 🌙'],
    ['u_bob', 'It looks so good.'],
  ], 90);
  chat('u_carol', 'u_alice', [
    ['u_alice', 'Carol, can you send me the logo files?'],
    ['u_carol', 'Sure! Exporting them now.'],
    ['u_carol', 'Sent over email too, just in case.'],
  ], 30);
  chat('u_dan', 'u_bob', [['u_dan', 'Bob, lunch tomorrow?'], ['u_bob', 'Yes! 1pm works.']], 300);
  for (const u of ['u_alice', 'u_bob', 'u_carol', 'u_dan']) {
    chat(BOT_ID, u, [[BOT_ID, 'Hi, I’m Nova ✦ Send me any message and watch it go ✓ sent → ✓✓ delivered → ✓✓ read. Try sending a photo too!']], 5);
  }
  return db;
}

/* ---------- the backend ---------- */
export class DemoBackend implements Backend {
  readonly mode = 'demo' as const;
  private offlineReply: OfflineReplySettings = { enabled: false, message: 'I am away right now. I will reply when I am back.' };
  private bus = new Emitter();
  private conn = new Emitter();
  private channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('friendstar-demo') : null;
  private me: string | null = sessionStorage.getItem(SESSION_KEY);
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = (async () => {
      if (!localStorage.getItem(DB_KEY)) this.save(await seed());
    })();
    this.channel?.addEventListener('message', (e) => this.handle(e.data as Signal));
    window.addEventListener('beforeunload', () => this.setOffline());
  }

  /* ----- storage helpers ----- */
  private load(): DB {
    return JSON.parse(localStorage.getItem(DB_KEY) ?? 'null') as DB;
  }
  private save(db: DB) {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Demo storage is full. Clear site data to reset the preview.', undefined, 413);
    }
  }
  private mutate<T>(fn: (db: DB) => T): T {
    const db = this.load();
    const r = fn(db);
    this.save(db);
    return r;
  }
  private signal(s: Signal) {
    this.channel?.postMessage(s);
    this.handle(s);
  }
  private requireMe(): string {
    if (!this.me) throw new ApiError('UNAUTHORIZED', 'Please sign in', undefined, 401);
    return this.me;
  }

  /* ----- presence ----- */
  private presence(): Record<string, number> {
    return JSON.parse(localStorage.getItem(PRESENCE_KEY) ?? '{}');
  }
  private isOnline(userId: string) {
    if (userId === BOT_ID) return true;
    return Date.now() - (this.presence()[userId] ?? 0) < 12_000;
  }
  private beat() {
    if (!this.me) return;
    const p = this.presence();
    const wasOnline = Date.now() - (p[this.me] ?? 0) < 12_000;
    p[this.me] = Date.now();
    localStorage.setItem(PRESENCE_KEY, JSON.stringify(p));
    if (!wasOnline) this.signal({ type: 'presence', userId: this.me });
  }
  private startSession(userId: string) {
    this.me = userId;
    sessionStorage.setItem(SESSION_KEY, userId);
    this.beat();
    this.heartbeat = setInterval(() => this.beat(), 4_000);
    this.conn.emit('state', 'online');
    this.markAllDelivered(userId);
  }
  private setOffline() {
    if (!this.me) return;
    const me = this.me;
    const p = this.presence();
    delete p[me];
    localStorage.setItem(PRESENCE_KEY, JSON.stringify(p));
    this.mutate((db) => {
      const u = db.users.find((x) => x.id === me);
      if (u) u.lastSeenAt = now();
    });
    this.signal({ type: 'presence', userId: me });
  }

  /* ----- privacy-aware serialization (mirrors the server) ----- */
  private areContacts(db: DB, a: string, b: string) {
    return a === b || db.conversations.some((c) => c.lastMessageId && c.members.includes(a) && c.members.includes(b));
  }
  private hasBlocked(db: DB, a: string, b: string) {
    return db.blocks.some((x) => x.blocker === a && x.blocked === b);
  }
  private allows(db: DB, aud: PrivacySettings['lastSeen'], owner: string, viewer: string) {
    return owner === viewer || aud === 'everyone' || (aud === 'contacts' && this.areContacts(db, owner, viewer));
  }
  private toPublic(db: DB, u: DUser, viewer: string): PublicUser {
    const p = db.privacy[u.id] ?? DEFAULT_PRIVACY;
    const blockedViewer = u.id !== viewer && this.hasBlocked(db, u.id, viewer);
    const showPresence = !blockedViewer && this.allows(db, p.lastSeen, u.id, viewer);
    const showPhoto = !blockedViewer && this.allows(db, p.profilePhoto, u.id, viewer);
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      bio: blockedViewer ? '' : u.bio,
      avatarUrl: showPhoto && u.avatarFileId ? db.files[u.avatarFileId]?.dataUrl ?? null : null,
      lastSeenAt: showPresence ? u.lastSeenAt : null,
      online: showPresence ? this.isOnline(u.id) : null,
      isBlocked: u.id !== viewer && this.hasBlocked(db, viewer, u.id),
      friendId: demoFriendId(u.id),
    };
  }
  private toMeUser(db: DB, id: string): Me {
    const u = db.users.find((x) => x.id === id)!;
    return { ...this.toPublic(db, u, id), email: u.email, online: true, createdAt: u.createdAt, isOwner: false };
  }
  private peerOf(c: DConv, me: string) {
    return c.members[0] === me ? c.members[1] : c.members[0];
  }
  private canMessage(db: DB, from: string, to: string) {
    if (this.hasBlocked(db, from, to) || this.hasBlocked(db, to, from)) return false;
    const p = db.privacy[to] ?? DEFAULT_PRIVACY;
    return !(p.whoCanMessage === 'contacts' && !this.areContacts(db, from, to));
  }
  private status(db: DB, m: DMsg): MessageStatus {
    const conv = db.conversations.find((c) => c.id === m.conversationId)!;
    const recipient = this.peerOf(conv, m.senderId);
    if (m.readAt && db.privacy[m.senderId]?.readReceipts && db.privacy[recipient]?.readReceipts) return 'read';
    return m.deliveredAt || m.readAt ? 'delivered' : 'sent';
  }
  private toMessage(db: DB, m: DMsg): Message {
    const f = m.fileId ? db.files[m.fileId] : null;
    const file: FileMeta | null = f
      ? { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, url: f.dataUrl, width: f.width, height: f.height }
      : null;
    return { id: m.id, clientId: m.clientId, conversationId: m.conversationId, senderId: m.senderId, kind: m.kind, body: m.body, file, createdAt: m.createdAt, status: this.status(db, m) };
  }
  private unread(db: DB, c: DConv, me: string) {
    const lr = c.lastRead[me];
    return db.messages.filter((m) => m.conversationId === c.id && m.senderId !== me && (!lr || m.createdAt > lr)).length;
  }
  private summary(db: DB, c: DConv, me: string): ConversationSummary {
    const peerId = this.peerOf(c, me);
    const last = c.lastMessageId ? db.messages.find((m) => m.id === c.lastMessageId) : undefined;
    return {
      kind: 'direct',
      group: null,
      id: c.id,
      peer: this.toPublic(db, db.users.find((u) => u.id === peerId)!, me),
      lastMessage: last ? this.toMessage(db, last) : null,
      unreadCount: this.unread(db, c, me),
      updatedAt: c.updatedAt,
      canMessage: this.canMessage(db, me, peerId),
    };
  }
  private conv(db: DB, id: string, me: string): DConv {
    const c = db.conversations.find((x) => x.id === id);
    if (!c || !c.members.includes(me)) throw new ApiError('NOT_FOUND', 'Conversation not found', undefined, 404);
    return c;
  }

  /* ----- signal handling (runs in every tab) ----- */
  private handle(s: Signal) {
    const me = this.me;
    if (!me) return;
    const db = this.load();
    if (!db) return;
    switch (s.type) {
      case 'message:new': {
        const m = db.messages.find((x) => x.id === s.messageId);
        const c = m && db.conversations.find((x) => x.id === m.conversationId);
        if (!m || !c || !c.members.includes(me)) return;
        this.bus.emit('message:new', { message: this.toMessage(db, m), conversation: this.summary(db, c, me) });
        return;
      }
      case 'status':
        if (s.to === me) this.bus.emit('message:status', { conversationId: s.conversationId, messageIds: s.messageIds, status: s.status, at: s.at });
        return;
      case 'typing':
        if (s.to === me) this.bus.emit('typing', { conversationId: s.conversationId, userId: s.userId, isTyping: s.isTyping });
        return;
      case 'presence': {
        if (s.userId === me || !this.areContacts(db, s.userId, me)) return;
        const u = db.users.find((x) => x.id === s.userId);
        if (!u) return;
        const v = this.toPublic(db, u, me);
        this.bus.emit('presence', { userId: u.id, online: v.online, lastSeenAt: v.lastSeenAt });
        return;
      }
      case 'notification': {
        if (s.to !== me) return;
        const n = db.notifications.find((x) => x.id === s.notificationId);
        if (n) this.bus.emit('notification:new', { notification: n, unread: db.notifications.filter((x) => x.userId === me && !x.readAt).length });
        return;
      }
      case 'conv': {
        if (s.to !== me) return;
        const c = db.conversations.find((x) => x.id === s.conversationId);
        if (c) this.bus.emit('conversation:updated', { conversation: this.summary(db, c, me) });
      }
    }
  }

  /* ----- delivery / read ----- */
  private markAllDelivered(userId: string, ids?: string[]) {
    const at = now();
    const changed = this.mutate((db) => {
      const mine = new Set(db.conversations.filter((c) => c.members.includes(userId)).map((c) => c.id));
      const hits = db.messages.filter((m) => mine.has(m.conversationId) && m.senderId !== userId && !m.deliveredAt && (!ids || ids.includes(m.id)));
      hits.forEach((m) => (m.deliveredAt = at));
      return hits;
    });
    const groups = new Map<string, DMsg[]>();
    changed.forEach((m) => groups.set(m.conversationId, [...(groups.get(m.conversationId) ?? []), m]));
    for (const [conversationId, list] of groups) {
      this.signal({ type: 'status', to: list[0].senderId, conversationId, messageIds: list.map((m) => m.id), status: 'delivered', at });
    }
  }

  private readAs(userId: string, conversationId: string) {
    const at = now();
    const { ids, peer, receipts } = this.mutate((db) => {
      const c = this.conv(db, conversationId, userId);
      c.lastRead[userId] = at;
      const hits = db.messages.filter((m) => m.conversationId === c.id && m.senderId !== userId && !m.readAt);
      hits.forEach((m) => {
        m.readAt = at;
        m.deliveredAt ??= at;
      });
      db.notifications.forEach((n) => {
        if (n.userId === userId && n.conversationId === conversationId && !n.readAt) n.readAt = at;
      });
      const peer = this.peerOf(c, userId);
      return { ids: hits.map((m) => m.id), peer, receipts: !!(db.privacy[userId]?.readReceipts && db.privacy[peer]?.readReceipts) };
    });
    if (ids.length) this.signal({ type: 'status', to: peer, conversationId, messageIds: ids, status: receipts ? 'read' : 'delivered', at });
  }

  private sendAs(senderId: string, conversationId: string, input: { clientId: string; kind: DMsg['kind']; body: string; fileId?: string | null }): Message {
    const { msg, recipient, existing } = this.mutate((db) => {
      const c = this.conv(db, conversationId, senderId);
      const dup = db.messages.find((m) => m.senderId === senderId && m.clientId === input.clientId);
      if (dup) return { msg: dup, recipient: '', existing: true };
      const recipient = this.peerOf(c, senderId);
      if (!this.canMessage(db, senderId, recipient)) throw new ApiError('FORBIDDEN', 'You can’t message this person', undefined, 403);
      const at = now();
      const m: DMsg = { id: rid('m'), conversationId, senderId, clientId: input.clientId, kind: input.kind, body: input.body, fileId: input.fileId ?? null, createdAt: at, deliveredAt: null, readAt: null };
      db.messages.push(m);
      c.lastMessageId = m.id;
      c.updatedAt = at;
      c.lastRead[senderId] = at;
      return { msg: m, recipient, existing: false };
    });
    const db = this.load();
    if (existing) return this.toMessage(db, msg);
    this.signal({ type: 'message:new', messageId: msg.id });
    this.notify(recipient, senderId, conversationId, msg);
    if (recipient === BOT_ID) void this.botRespond(conversationId, msg);
    return this.toMessage(db, msg);
  }

  private notify(to: string, from: string, conversationId: string, m: DMsg) {
    if (to === BOT_ID) return;
    const id = this.mutate((db) => {
      const sender = db.users.find((u) => u.id === from)!;
      const preview = m.kind === 'image' ? '📷 Photo' : m.kind === 'file' ? '📎 File' : m.body.slice(0, 120);
      const existing = db.notifications.find((n) => n.userId === to && n.conversationId === conversationId && !n.readAt);
      if (existing) {
        const count = Number(/\((\d+) new\)$/.exec(existing.title)?.[1] ?? 1) + 1;
        existing.title = `${sender.displayName} (${count} new)`;
        existing.body = preview;
        existing.createdAt = now();
        return existing.id;
      }
      const n: DNote = { id: rid('n'), userId: to, type: 'new_message', title: sender.displayName, body: preview, file: null, conversationId, actorId: from, readAt: null, createdAt: now() };
      db.notifications.push(n);
      return n.id;
    });
    this.signal({ type: 'notification', to, notificationId: id });
  }

  private botTurn = 0;
  private async botRespond(conversationId: string, incoming: DMsg) {
    const human = incoming.senderId;
    await sleep(700);
    this.markAllDelivered(BOT_ID, [incoming.id]);
    await sleep(900);
    this.readAs(BOT_ID, conversationId);
    await sleep(400);
    this.signal({ type: 'typing', to: human, conversationId, userId: BOT_ID, isTyping: true });
    await sleep(1400);
    this.signal({ type: 'typing', to: human, conversationId, userId: BOT_ID, isTyping: false });
    const text = incoming.body.toLowerCase();
    const replies = [
      'Got it! Notice how your ticks turned amber? That means I read it ✦',
      'Tip: open FriendStar in a second tab, sign in as another demo user, and chat with yourself in real time.',
      'Try Settings → Privacy and switch off read receipts. Your ticks will stop turning amber — for both of us.',
      'This is the offline demo. Groups, Status and calls work on the live FriendStar site.',
      'Dark mode lives in Settings → Appearance 🌙',
    ];
    let reply = replies[this.botTurn++ % replies.length];
    if (incoming.kind === 'image') reply = 'Nice picture! 📷 Images are shown right inside the chat.';
    else if (incoming.kind === 'file') reply = `Thanks for the file “${this.load().files[incoming.fileId ?? '']?.name ?? 'file'}”. Tap it to download.`;
    else if (/^(hi|hey|hello|salam|assalamu)/.test(text)) reply = 'Hey there! 👋 Welcome to FriendStar. Ask me anything about the app.';
    try {
      this.sendAs(BOT_ID, conversationId, { clientId: rid('k'), kind: 'text', body: reply });
    } catch {
      /* blocked etc. */
    }
  }

  /* ---------- Backend: auth ---------- */
  async restoreSession() {
    await this.ready;
    if (!this.me) return null;
    const db = this.load();
    if (!db.users.some((u) => u.id === this.me)) {
      this.me = null;
      return null;
    }
    this.startSession(this.me);
    return this.toMeUser(db, this.me);
  }
  async register(input: Parameters<Backend['register']>[0]) {
    await this.ready;
    let v;
    try {
      v = registerSchema.parse(input);
    } catch (e) {
      zodToApi(e);
    }
    const id = rid('u');
    const hash = await hashPassword(v.password, id);
    this.mutate((db) => {
      const fields: Record<string, string> = {};
      if (db.users.some((u) => u.username === v.username)) fields.username = 'That username is taken';
      if (db.users.some((u) => u.email === v.email)) fields.email = 'That email is already registered';
      if (Object.keys(fields).length) throw new ApiError('CONFLICT', 'Account already exists', fields, 409);
      db.users.push({ id, username: v.username, email: v.email, passwordHash: hash, displayName: v.displayName, bio: '', avatarFileId: null, lastSeenAt: now(), createdAt: now() });
      db.privacy[id] = { ...DEFAULT_PRIVACY };
      db.notifications.push({ id: rid('n'), userId: id, type: 'system', title: 'Welcome to FriendStar ✦', body: 'Find a friend with Search and say hello.', file: null, conversationId: null, actorId: null, readAt: null, createdAt: now() });
      const c: DConv = { id: rid('c'), members: [BOT_ID, id], lastRead: { [BOT_ID]: now(), [id]: null }, lastMessageId: null, updatedAt: now() };
      const m: DMsg = { id: rid('m'), conversationId: c.id, senderId: BOT_ID, clientId: rid('k'), kind: 'text', body: `Welcome, ${v.displayName}! I’m Nova ✦ Send me a message to see sent, delivered and read ticks.`, fileId: null, createdAt: now(), deliveredAt: null, readAt: null };
      c.lastMessageId = m.id;
      db.conversations.push(c);
      db.messages.push(m);
    });
    this.startSession(id);
    return this.toMeUser(this.load(), id);
  }
  async login(input: Parameters<Backend['login']>[0]) {
    await this.ready;
    let v;
    try {
      v = loginSchema.parse(input);
    } catch (e) {
      zodToApi(e);
    }
    const login = v.login.toLowerCase();
    const u = this.load().users.find((x) => x.username === login || x.email === login);
    if (!u || u.bot || !(await checkPassword(v.password, u.passwordHash))) {
      throw new ApiError('UNAUTHORIZED', 'Invalid username or password', undefined, 401);
    }
    this.startSession(u.id);
    return this.toMeUser(this.load(), u.id);
  }
  async requestPasswordReset(): Promise<{ message: string }> { return this.needsServer(); }
  async completePasswordReset(): Promise<void> { return this.needsServer(); }
  async logout() {
    this.setOffline();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.me = null;
    sessionStorage.removeItem(SESSION_KEY);
    this.conn.emit('state', 'offline');
  }

  /* ---------- profile & privacy ---------- */
  async updateProfile(patch: Parameters<Backend['updateProfile']>[0]) {
    const me = this.requireMe();
    let v;
    try {
      v = updateProfileSchema.parse(patch);
    } catch (e) {
      zodToApi(e);
    }
    this.mutate((db) => {
      const u = db.users.find((x) => x.id === me)!;
      if (v.displayName !== undefined) u.displayName = v.displayName;
      if (v.bio !== undefined) u.bio = v.bio;
    });
    return this.toMeUser(this.load(), me);
  }
  async uploadAvatar(file: File) {
    const me = this.requireMe();
    const f = await this.storeFile(file, true);
    this.mutate((db) => {
      db.files[f.id] = f;
      db.users.find((x) => x.id === me)!.avatarFileId = f.id;
    });
    return this.toMeUser(this.load(), me);
  }
  async removeAvatar() {
    const me = this.requireMe();
    this.mutate((db) => (db.users.find((x) => x.id === me)!.avatarFileId = null));
    return this.toMeUser(this.load(), me);
  }
  async getPrivacy() {
    return { ...DEFAULT_PRIVACY, ...this.load().privacy[this.requireMe()] };
  }
  async updatePrivacy(patch: Partial<PrivacySettings>) {
    const me = this.requireMe();
    let v: Partial<PrivacySettings>;
    try {
      v = privacySchema.parse(patch);
    } catch (e) {
      zodToApi(e);
    }
    const next = this.mutate((db) => (db.privacy[me] = { ...DEFAULT_PRIVACY, ...db.privacy[me], ...v }));
    this.signal({ type: 'presence', userId: me });
    return next;
  }
  async getOfflineReplySettings() {
    this.requireMe();
    return { ...this.offlineReply };
  }
  async updateOfflineReplySettings(patch: Partial<OfflineReplySettings>) {
    this.requireMe();
    this.offlineReply = { ...this.offlineReply, ...patch };
    return { ...this.offlineReply };
  }
  async listBlocked() {
    const me = this.requireMe();
    const db = this.load();
    return db.blocks.filter((b) => b.blocker === me).map((b) => this.toPublic(db, db.users.find((u) => u.id === b.blocked)!, me));
  }
  async block(userId: string) {
    const me = this.requireMe();
    this.mutate((db) => {
      if (userId !== me && !this.hasBlocked(db, me, userId)) db.blocks.push({ blocker: me, blocked: userId });
    });
  }
  async unblock(userId: string) {
    const me = this.requireMe();
    this.mutate((db) => (db.blocks = db.blocks.filter((b) => !(b.blocker === me && b.blocked === userId))));
  }

  /* ---------- users & search ---------- */
  async getUser(userId: string) {
    const me = this.requireMe();
    const db = this.load();
    const u = db.users.find((x) => x.id === userId);
    if (!u) throw new ApiError('NOT_FOUND', 'User not found', undefined, 404);
    return this.toPublic(db, u, me);
  }
  async search(q: string) {
    const me = this.requireMe();
    const db = this.load();
    const term = q.trim().toLowerCase();
    if (!term) return { users: [], messages: [] };
    const users = db.users
      .filter((u) => u.id !== me && !this.hasBlocked(db, u.id, me))
      .filter((u) => u.username.includes(term) || u.displayName.toLowerCase().includes(term))
      .filter((u) => db.privacy[u.id]?.discoverable !== false || this.areContacts(db, u.id, me))
      .slice(0, 20)
      .map((u) => this.toPublic(db, u, me));
    const mine = db.conversations.filter((c) => c.members.includes(me));
    const messages: MessageHit[] = db.messages
      .filter((m) => mine.some((c) => c.id === m.conversationId))
      .filter((m) => m.body.toLowerCase().includes(term) || (m.fileId && db.files[m.fileId]?.name.toLowerCase().includes(term)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map((m) => {
        const c = mine.find((x) => x.id === m.conversationId)!;
        return { message: this.toMessage(db, m), conversationId: c.id, peer: this.toPublic(db, db.users.find((u) => u.id === this.peerOf(c, me))!, me) };
      });
    return { users, messages };
  }

  /* ---------- conversations ---------- */
  async listConversations() {
    await this.ready;
    const me = this.requireMe();
    const db = this.load();
    return db.conversations
      .filter((c) => c.members.includes(me) && c.lastMessageId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => this.summary(db, c, me));
  }
  async openConversation(userId: string) {
    const me = this.requireMe();
    if (userId === me) throw new ApiError('VALIDATION', 'You cannot start a chat with yourself', undefined, 400);
    const c = this.mutate((db) => {
      let c = db.conversations.find((x) => x.members.includes(me) && x.members.includes(userId));
      if (!c) {
        c = { id: rid('c'), members: [me, userId], lastRead: { [me]: now(), [userId]: null }, lastMessageId: null, updatedAt: now() };
        db.conversations.push(c);
      }
      return c;
    });
    return this.summary(this.load(), c, me);
  }
  async getConversation(id: string) {
    const me = this.requireMe();
    const db = this.load();
    return this.summary(db, this.conv(db, id, me), me);
  }
  async listMessages(conversationId: string, before?: string) {
    const me = this.requireMe();
    const db = this.load();
    this.conv(db, conversationId, me);
    const all = db.messages
      .filter((m) => m.conversationId === conversationId && (!before || m.createdAt < before))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const page = all.slice(-50);
    return { messages: page.map((m) => this.toMessage(db, m)), hasMore: all.length > page.length };
  }
  async sendText(conversationId: string, clientId: string, body: string) {
    const me = this.requireMe();
    await sleep(120); // a touch of latency so the "sending" state is visible
    const text = body.trim();
    if (!text) throw new ApiError('VALIDATION', 'Message is empty', undefined, 400);
    return this.sendAs(me, conversationId, { clientId, kind: 'text', body: text.slice(0, 4000) });
  }
  async sendFile(conversationId: string, clientId: string, file: File, caption: string) {
    const me = this.requireMe();
    const f = await this.storeFile(file, false);
    this.mutate((db) => (db.files[f.id] = f));
    return this.sendAs(me, conversationId, { clientId, kind: f.mimeType.startsWith('image/') ? 'image' : 'file', body: caption.trim(), fileId: f.id });
  }
  async generateAIImage(): Promise<never> {
    return this.needsServer();
  }
  async markRead(conversationId: string) {
    const me = this.requireMe();
    this.readAs(me, conversationId);
    return this.getConversation(conversationId);
  }

  private async storeFile(file: File, imageOnly: boolean): Promise<DFile> {
    const isImage = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type);
    if (imageOnly && !isImage) throw new ApiError('VALIDATION', 'Choose a JPEG, PNG, GIF or WebP image', undefined, 415);
    if (file.type === 'image/svg+xml') throw new ApiError('VALIDATION', 'That file type isn’t supported', undefined, 415);
    let blob: Blob = file;
    let width: number | null = null;
    let height: number | null = null;
    if (isImage && file.type !== 'image/gif') {
      // Downscale images so the in-browser demo storage doesn't fill up.
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      width = Math.round(bmp.width * scale);
      height = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, width, height);
      blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.82));
    }
    if (blob.size > DEMO_FILE_LIMIT) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Preview mode stores files in your browser — keep them under 1.5 MB.', undefined, 413);
    }
    const dataUrl = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(blob);
    });
    return { id: rid('f'), name: file.name.slice(0, 120) || 'file', mimeType: isImage && file.type !== 'image/gif' ? 'image/jpeg' : file.type || 'application/octet-stream', size: blob.size, dataUrl, width, height };
  }

  /* ---------- notifications ---------- */
  async listNotifications() {
    const me = this.requireMe();
    const list = this.load()
      .notifications.filter((n) => n.userId === me)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
    return { notifications: list, unread: list.filter((n) => !n.readAt).length };
  }
  async readAllNotifications() {
    const me = this.requireMe();
    this.mutate((db) => db.notifications.forEach((n) => n.userId === me && !n.readAt && (n.readAt = now())));
  }
  async readNotification(id: string) {
    const me = this.requireMe();
    this.mutate((db) => db.notifications.forEach((n) => n.userId === me && n.id === id && !n.readAt && (n.readAt = now())));
    return this.load().notifications.filter((n) => n.userId === me && !n.readAt).length;
  }

  /* ---------- realtime ---------- */
  on: Backend['on'] = (event, handler) => this.bus.on(event, handler as (p: never) => void);
  onConnection(handler: (s: ConnectionState) => void) {
    return this.conn.on('state', handler as (p: never) => void);
  }
  emitTyping(conversationId: string, isTyping: boolean) {
    const me = this.me;
    if (!me) return;
    const c = this.load().conversations.find((x) => x.id === conversationId);
    if (c?.members.includes(me)) this.signal({ type: 'typing', to: this.peerOf(c, me), conversationId, userId: me, isTyping });
  }
  ackDelivered(messageIds: string[]) {
    if (this.me && messageIds.length) this.markAllDelivered(this.me, messageIds);
  }
  emitRecording() { /* recording indicators require the live server */ }

  /* ---------- Phase 2 features need the live server ---------- */
  private needsServer(): never {
    throw new ApiError('VALIDATION', 'Groups, status and calls need the live FriendStar server.', undefined, 400);
  }
  async createGroup(): Promise<ConversationSummary> {
    return this.needsServer();
  }
  async renameGroup(): Promise<ConversationSummary> {
    return this.needsServer();
  }
  async setGroupAvatar(): Promise<ConversationSummary> {
    return this.needsServer();
  }
  async addGroupMembers(): Promise<ConversationSummary> {
    return this.needsServer();
  }
  async removeGroupMember(): Promise<ConversationSummary | null> {
    return this.needsServer();
  }
  async setGroupRole(): Promise<ConversationSummary> {
    return this.needsServer();
  }
  async listStatuses() {
    return { mine: [], feed: [] };
  }
  async postTextStatus(): Promise<never> {
    return this.needsServer();
  }
  async postStatusMedia(): Promise<never> {
    return this.needsServer();
  }
  async viewStatus() {}
  async statusViewers() {
    return [];
  }
  async deleteStatus() {}
  async listCalls() {
    return [];
  }
  async groupCallHistory(): Promise<never[]> {
    return [];
  }
  async listGroupCalls() {
    return [];
  }
  async listPeople() {
    const people = (await this.search('')).users;
    return { people, nextCursor: null, total: people.length };
  }
  async userByFriendId(code: string): Promise<PublicUser> {
    const all = (await this.search('')).users;
    const u = all.find((x) => x.friendId === code);
    if (!u) throw new ApiError('NOT_FOUND', 'No one has that FriendStar ID', undefined, 404);
    return u;
  }
  async adminSummary(): Promise<AdminSummary> {
    throw new ApiError('NOT_FOUND', 'Not available in the demo', undefined, 404);
  }
  async adminUsers(): Promise<AdminUserRow[]> {
    throw new ApiError('NOT_FOUND', 'Not available in the demo', undefined, 404);
  }
  async adminPasswordResetRequests(): Promise<AdminPasswordResetRequest[]> { return this.needsServer(); }
  async issueAdminPasswordReset(): Promise<{ token: string; expiresAt: string }> { return this.needsServer(); }
  async adminBots(): Promise<AdminBotRow[]> { return this.needsServer(); }
  async renameAdminBot(): Promise<AdminBotRow> { return this.needsServer(); }
  async deleteAdminBot(): Promise<void> { return this.needsServer(); }
  async uploadAdminAttachment(): Promise<FileMeta> { return this.needsServer(); }
  async adminLogins(): Promise<AdminLoginEvent[]> {
    throw new ApiError('NOT_FOUND', 'Not available in the demo', undefined, 404);
  }
  async previewAdminAnnouncement(_draft: { title: string; body: string; fileId?: string | null }): Promise<AdminAnnouncementPreview> {
    throw new ApiError('NOT_FOUND', 'Not available in the demo', undefined, 404);
  }
  async sendAdminAnnouncement(_previewId: string): Promise<AdminAnnouncementRecord> {
    throw new ApiError('NOT_FOUND', 'Not available in the demo', undefined, 404);
  }
  async adminAnnouncements(): Promise<AdminAnnouncementRecord[]> {
    throw new ApiError('NOT_FOUND', 'Not available in the demo', undefined, 404);
  }
  async iceServers() {
    return [];
  }
  emitCall() {
    /* calls are not simulated in the offline demo */
  }
}
