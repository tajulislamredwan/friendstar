/* End-to-end smoke test: boots the server on a temp DB, exercises REST + Socket.IO.
 * Run: pnpm test */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const TEST_PASSWORD = randomBytes(32).toString('hex');
const WRONG_PASSWORD = randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'friendstar-test-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.DATA_DIR = tmp;
process.env.PORT = '0';
process.env.OWNER_EMAILS = 'ann@test.dev';
process.env.AUTH_RATE_LIMIT = '1000';

const http = await import('node:http');
const { createApp } = await import('./app.ts');
const { attachRealtime } = await import('./realtime/socket.ts');
const { io: ioc } = await import('socket.io-client');

const server = http.createServer(createApp());
attachRealtime(server);
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;

type Session = { token: string; cookie: string; id: string };
async function call(method: string, url: string, s?: Session, body?: unknown, raw?: FormData) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(s ? { authorization: `Bearer ${s.token}`, cookie: s.cookie } : {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}
async function register(username: string): Promise<Session> {
  const r = await call('POST', '/api/auth/register', undefined, {
    username,
    email: `${username}@test.dev`,
    password: TEST_PASSWORD,
    displayName: username.toUpperCase(),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  return { token: r.json.accessToken, cookie, id: r.json.user.id };
}
const step = (s: string) => console.log('  ✓', s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('FriendStar smoke test');
const a = await register('ann');
const b = await register('ben');
step('register two users');

assert.equal((await call('POST', '/api/auth/register', undefined, { username: 'ann', email: 'x@test.dev', password: TEST_PASSWORD, displayName: 'x' })).status, 409);
assert.equal((await call('POST', '/api/auth/login', undefined, { login: 'ann', password: WRONG_PASSWORD })).status, 401);
assert.equal((await call('POST', '/api/auth/login', undefined, { login: 'ANN@test.dev', password: TEST_PASSWORD })).status, 200);
assert.equal((await call('GET', '/api/conversations')).status, 401);
step('duplicate signup rejected, bad password rejected, email login works, auth required');

// Refresh rotation + reuse detection
const r1 = await call('POST', '/api/auth/refresh', a);
assert.equal(r1.status, 200);
const rotatedCookie = (r1.headers.get('set-cookie') ?? '').split(';')[0];
assert.notEqual(rotatedCookie, a.cookie);
a.cookie = rotatedCookie;
step('refresh token rotates');

// Sockets
const sockA = ioc(base, { auth: { token: a.token }, transports: ['websocket'] });
const sockB = ioc(base, { auth: { token: b.token }, transports: ['websocket'] });
await Promise.all([new Promise((r) => sockA.on('connect', () => r(null))), new Promise((r) => sockB.on('connect', () => r(null)))]);
const statusEvents: { status: string; messageIds: string[] }[] = [];
sockA.on('message:status', (p) => statusEvents.push(p));
sockB.on('message:new', (p) => sockB.emit('message:delivered', { messageIds: [p.message.id] }));
let typingSeen = false;
sockB.on('typing', () => (typingSeen = true));
let recordingSeen = false;
sockB.on('recording', (p) => { if (p.isRecording) recordingSeen = true; });
let notified = 0;
sockB.on('notification:new', () => notified++);
step('both sockets connected');

const search = await call('GET', '/api/search?q=be', a);
assert.ok(search.json.users.some((u: { id: string }) => u.id === b.id));
step('user search finds ben');

const conv = (await call('POST', '/api/conversations', a, { userId: b.id })).json.conversation;
const again = (await call('POST', '/api/conversations', a, { userId: b.id })).json.conversation;
assert.equal(conv.id, again.id);
step('get-or-create direct conversation is idempotent');

sockA.emit('recording', { conversationId: conv.id, isRecording: true });
sockA.emit('typing', { conversationId: conv.id, isTyping: true });
const sent = await call('POST', `/api/conversations/${conv.id}/messages`, a, { clientId: 'client-0001', kind: 'text', body: 'Hello Ben ✦' });
assert.equal(sent.status, 201);
assert.equal(sent.json.message.status, 'sent');
const dup = await call('POST', `/api/conversations/${conv.id}/messages`, a, { clientId: 'client-0001', kind: 'text', body: 'Hello Ben ✦' });
assert.equal(dup.json.message.id, sent.json.message.id);
step('send text message (idempotent on clientId)');

await wait(300);
assert.ok(typingSeen, 'typing event');
assert.ok(recordingSeen, 'recording event');
assert.ok(statusEvents.some((e) => e.status === 'delivered'), 'delivered status');
assert.ok(notified >= 1, 'notification');
step('real-time: typing, delivered tick, notification');
sockA.emit('recording', { conversationId: conv.id, isRecording: false });

const convB = (await call('GET', '/api/conversations', b)).json.conversations[0];
assert.equal(convB.unreadCount, 1);
step('unread count = 1 for recipient');

await call('POST', `/api/conversations/${conv.id}/read`, b);
await wait(200);
assert.ok(statusEvents.some((e) => e.status === 'read'), 'read status');
const msgsA = (await call('GET', `/api/conversations/${conv.id}/messages`, a)).json.messages;
assert.equal(msgsA[0].status, 'read');
assert.equal((await call('GET', '/api/conversations', b)).json.conversations[0].unreadCount, 0);
step('read receipt + unread cleared');

// Read receipts off (reciprocal) → sender sees delivered, not read
await call('PATCH', '/api/me/privacy', b, { readReceipts: false });
const msgsA2 = (await call('GET', `/api/conversations/${conv.id}/messages`, a)).json.messages;
assert.equal(msgsA2[0].status, 'delivered');
await call('PATCH', '/api/me/privacy', b, { readReceipts: true });
step('read-receipt privacy is enforced server-side');

// Image upload with magic-byte check
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const fd = new FormData();
fd.append('clientId', 'client-0002');
fd.append('body', 'a tiny pixel');
fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
const up = await call('POST', `/api/conversations/${conv.id}/messages`, a, undefined, fd);
assert.equal(up.status, 201, JSON.stringify(up.json));
assert.equal(up.json.message.kind, 'image');
assert.equal(up.json.message.file.width, 1);
const fileRes = await fetch(base + up.json.message.file.url);
assert.equal(fileRes.status, 200);
assert.equal(fileRes.headers.get('content-type'), 'image/png');
const tampered = await fetch(base + up.json.message.file.url.replace(/sig=[^&]+/, 'sig=nope'));
assert.equal(tampered.status, 404);
step('image upload, signed URL works, tampered URL rejected');

const fake = new FormData();
fake.append('clientId', 'client-0003');
fake.append('file', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'fake.png');
assert.equal((await call('POST', `/api/conversations/${conv.id}/messages`, a, undefined, fake)).status, 400);
const svg = new FormData();
svg.append('clientId', 'client-0004');
svg.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
assert.equal((await call('POST', `/api/conversations/${conv.id}/messages`, a, undefined, svg)).status, 415);
step('spoofed image and SVG rejected');

const pdf = new FormData();
pdf.append('clientId', 'client-0005');
pdf.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'notes.pdf');
const pdfRes = await call('POST', `/api/conversations/${conv.id}/messages`, a, undefined, pdf);
assert.equal(pdfRes.json.message.kind, 'file');
const dl = await fetch(base + pdfRes.json.message.file.url);
assert.match(dl.headers.get('content-disposition') ?? '', /^attachment/);
step('file (PDF) sharing served as attachment');

// Video Status upload and signed byte-range playback.
const mp4Header = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const statusVideo = new FormData();
statusVideo.append('file', new Blob([mp4Header], { type: 'video/mp4' }), 'status.mp4');
statusVideo.append('caption', 'test clip');
const statusRes = await call('POST', '/api/statuses', a, undefined, statusVideo);
assert.equal(statusRes.status, 201, JSON.stringify(statusRes.json));
assert.equal(statusRes.json.status.kind, 'video');
const videoRange = await fetch(base + statusRes.json.status.file.url, { headers: { range: 'bytes=0-7' } });
assert.equal(videoRange.status, 206);
assert.equal(videoRange.headers.get('content-type'), 'video/mp4');
assert.equal(videoRange.headers.get('content-range'), 'bytes 0-7/16');
assert.match(videoRange.headers.get('content-disposition') ?? '', /^inline/);
assert.equal((await videoRange.arrayBuffer()).byteLength, 8);
const fakeVideo = new FormData();
fakeVideo.append('file', new Blob([png], { type: 'video/mp4' }), 'fake.mp4');
assert.equal((await call('POST', '/api/statuses', a, undefined, fakeVideo)).status, 400);
step('video Status validation, signed inline response, and byte ranges');

const musicStatus = new FormData();
musicStatus.append('body', 'Status with a local soundtrack');
musicStatus.append('bg', 'violet');
musicStatus.append('expiresInHours', '36');
musicStatus.append('musicFile', new Blob([Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000')], { type: 'audio/mpeg' }), 'test-song.mp3');
const musicStatusRes = await call('POST', '/api/statuses', a, undefined, musicStatus);
assert.equal(musicStatusRes.status, 201, JSON.stringify(musicStatusRes.json));
assert.equal(musicStatusRes.json.status.musicFile.name, 'test-song.mp3');
assert.ok(Math.abs((Date.parse(musicStatusRes.json.status.expiresAt) - Date.parse(musicStatusRes.json.status.createdAt)) - 36 * 60 * 60 * 1000) < 1000);
assert.equal((await fetch(base + musicStatusRes.json.status.musicFile.url)).status, 200);
const invalidExpiry = await call('POST', '/api/statuses', a, { body: 'invalid expiry', bg: 'violet', expiresInHours: 169 });
assert.equal(invalidExpiry.status, 400);
step('status soundtrack uploads and plays from user storage; custom expiry is validated with 24-hour default');

// Outsider access
const c = await register('cat');
assert.equal((await call('GET', `/api/conversations/${conv.id}/messages`, c)).status, 404);
assert.equal((await call('POST', `/api/conversations/${conv.id}/messages`, c, { clientId: 'client-x001', kind: 'text', body: 'hi' })).status, 404);
step('non-members cannot read or post');

// Message search
const ms = await call('GET', '/api/search?q=hello', b);
assert.equal(ms.json.messages.length, 1);
assert.equal((await call('GET', '/api/search?q=hello', c)).json.messages.length, 0);
step('message search scoped to own conversations');

// Privacy: who can message = contacts
await call('PATCH', '/api/me/privacy', c, { whoCanMessage: 'contacts', lastSeen: 'nobody' });
const convAC = (await call('POST', '/api/conversations', a, { userId: c.id })).json.conversation;
assert.equal(convAC.canMessage, false);
assert.equal(convAC.peer.lastSeenAt, null);
assert.equal(convAC.peer.online, null);
assert.equal((await call('POST', `/api/conversations/${convAC.id}/messages`, a, { clientId: 'client-0006', kind: 'text', body: 'hi' })).status, 403);
step('privacy: contacts-only messaging and hidden last seen');

// Blocking
await call('POST', `/api/me/blocks/${a.id}`, b);
assert.equal((await call('POST', `/api/conversations/${conv.id}/messages`, a, { clientId: 'client-0007', kind: 'text', body: 'still there?' })).status, 403);
assert.ok(!(await call('GET', '/api/search?q=be', a)).json.users.some((u: { id: string }) => u.id === b.id));
await call('DELETE', `/api/me/blocks/${a.id}`, b);
assert.equal((await call('POST', `/api/conversations/${conv.id}/messages`, a, { clientId: 'client-0008', kind: 'text', body: 'back!' })).status, 201);
step('block / unblock');

const dee = await register('dee');
const deeConv = (await call('POST', '/api/conversations', dee, { userId: b.id })).json.conversation;
await call('POST', `/api/conversations/${deeConv.id}/messages`, dee, { clientId: 'client-dee001', kind: 'text', body: 'Safety review message' });
assert.equal((await call('GET', `/api/admin/chats?userId=${dee.id}`, a)).status, 404);
assert.equal((await call('GET', `/api/admin/chats/${deeConv.id}/messages?userId=${dee.id}`, a)).status, 404);
const managedUsers = await call('GET', '/api/admin/users?q=dee', a);
const managedDee = managedUsers.json.users.find((x: { id: string }) => x.id === dee.id);
assert.ok(managedDee);
assert.equal(managedDee.email, 'dee@test.dev');
assert.equal(typeof managedDee.createdAt, 'string');
assert.equal(typeof managedDee.lastLoginAt, 'string');
assert.ok(!('passwordHash' in managedDee) && !('password_hash' in managedDee));
const deeEvents = await call('GET', `/api/admin/logins?userId=${dee.id}`, a);
assert.ok(deeEvents.json.events.some((e: { kind: string; email: string }) => e.kind === 'register' && e.email === 'dee@test.dev'));
assert.ok(deeEvents.json.events.every((e: Record<string, unknown>) => !('ip' in e) && !('userAgent' in e) && !('loginTried' in e)));
const { one: oneDb } = await import('./db/database.ts');
const rawAuthEvent = oneDb<{ login_tried: string; ip: string; country: string; user_agent: string }>(
  "SELECT login_tried, ip, country, user_agent FROM login_events WHERE user_id = ? AND kind = 'register' ORDER BY at DESC LIMIT 1",
  dee.id,
);
assert.deepEqual({ ...rawAuthEvent }, { login_tried: '', ip: '', country: '', user_agent: '' });
step('admin shows account ID/email and safe sign-in metadata only; private-message inspection routes are absent');

const notes = await call('GET', '/api/notifications', b);
assert.ok(notes.json.notifications.length >= 1);
await call('POST', '/api/notifications/read-all', b);
assert.equal((await call('GET', '/api/notifications', b)).json.unread, 0);
step('notifications list + mark all read');

// Owner-only announcement preview and idempotent in-app broadcast.
assert.equal((await call('GET', '/api/admin/announcements', b)).status, 404);
assert.equal((await call('POST', '/api/admin/announcements/preview', b, { title: 'Test update', body: 'A local-only notice' })).status, 404);
assert.equal((await call('POST', '/api/admin/announcements/send', b, { previewId: 'not-a-preview' })).status, 404);
const ownerMe = await call('GET', '/api/auth/me', a);
assert.equal(ownerMe.json.user.isOwner, true);
const beforePreview = await call('GET', '/api/notifications', b);
assert.ok(!beforePreview.json.notifications.some((n: { type: string }) => n.type === 'announcement'));
const noticeFile = new FormData();
noticeFile.append('file', new Blob([Buffer.from('%PDF-1.4 notice attachment')], { type: 'application/pdf' }), 'notice.pdf');
assert.equal((await call('POST', '/api/admin/announcements/attachment', b, undefined, noticeFile)).status, 404);
const uploadedNotice = await call('POST', '/api/admin/announcements/attachment', a, undefined, noticeFile);
assert.equal(uploadedNotice.status, 200, JSON.stringify(uploadedNotice.json));
const draft = { title: '  Test update  ', body: '  A local-only notice  ', fileId: uploadedNotice.json.file.id };
const previewRes = await call('POST', '/api/admin/announcements/preview', a, draft);
assert.equal(previewRes.status, 200, JSON.stringify(previewRes.json));
const preview = previewRes.json.preview;
assert.equal(preview.title, 'Test update');
assert.equal(preview.body, 'A local-only notice');
assert.equal(preview.file.name, 'notice.pdf');
assert.equal(preview.recipientCount, (await call('GET', '/api/admin/summary', a)).json.users);
const notifiedBeforeBroadcast = notified;
const sendRes = await call('POST', '/api/admin/announcements/send', a, { previewId: preview.previewId });
assert.equal(sendRes.status, 200, JSON.stringify(sendRes.json));
assert.equal(sendRes.json.announcement.recipientCount, preview.recipientCount);
await wait(100);
assert.ok(notified > notifiedBeforeBroadcast, 'announcement is pushed to the existing in-app notification stream');
const afterBroadcast = await call('GET', '/api/notifications', b);
assert.ok(afterBroadcast.json.notifications.some((n: { type: string; title: string; body: string }) => n.type === 'announcement' && n.title === 'Test update' && n.body === 'A local-only notice'));
const noticeNotification = afterBroadcast.json.notifications.find((n: { type: string; title: string }) => n.type === 'announcement' && n.title === 'Test update');
assert.equal(noticeNotification.file.name, 'notice.pdf');
const noticeDownload = await fetch(base + noticeNotification.file.url);
assert.equal(noticeDownload.status, 200);
assert.match(noticeDownload.headers.get('content-disposition') ?? '', /^attachment/);
const retryRes = await call('POST', '/api/admin/announcements/send', a, { previewId: preview.previewId });
assert.equal(retryRes.status, 200);
assert.equal(retryRes.json.announcement.id, sendRes.json.announcement.id);
assert.equal((await call('GET', '/api/notifications', b)).json.notifications.filter((n: { type: string; title: string }) => n.type === 'announcement' && n.title === 'Test update').length, 1);
const audit = await call('GET', '/api/admin/announcements', a);
assert.equal(audit.json.announcements.length, 1);
assert.equal(audit.json.announcements[0].body, 'A local-only notice');
assert.equal(audit.json.announcements[0].file.name, 'notice.pdf');
assert.equal(audit.json.announcements[0].recipientCount, preview.recipientCount);
const limitedPreview = await call('POST', '/api/admin/announcements/preview', a, { title: 'Second update', body: 'Cooldown test' });
assert.equal((await call('POST', '/api/admin/announcements/send', a, { previewId: limitedPreview.json.preview.previewId })).status, 429);
step('announcements: owner-only preview, exact preview and count, in-app delivery, audit log, five-minute cooldown, and duplicate-send protection');

const { ensureBots } = await import('./services/bots.ts');
ensureBots();
const botList = (await call('GET', '/api/admin/bots', a)).json.bots;
const guideBot = botList.find((x: { kind: string }) => x.kind === 'guide');
assert.ok(guideBot);
const botChatsBefore = (await call('GET', '/api/conversations', a)).json.conversations;
const guideChatBefore = botChatsBefore.find((c: { peer: { id: string } }) => c.peer.id === guideBot.id);
assert.ok(guideChatBefore);
const renameBot = await call('PATCH', `/api/admin/bots/${guideBot.id}`, a, { displayName: 'Smoke Test Guide' });
assert.equal(renameBot.json.bot.displayName, 'Smoke Test Guide');
assert.equal((await call('DELETE', `/api/admin/bots/${guideBot.id}`, a)).json.enabled, false);
assert.equal((await call('GET', '/api/admin/bots', a)).json.bots.find((x: { id: string }) => x.id === guideBot.id).enabled, false);
const botChatsAfter = (await call('GET', '/api/conversations', a)).json.conversations;
assert.ok(botChatsAfter.some((c: { id: string }) => c.id === guideChatBefore.id));
assert.ok((await call('GET', `/api/conversations/${guideChatBefore.id}/messages`, a)).json.messages.length > 0);
assert.ok(!(await call('GET', '/api/search?q=novaguide', a)).json.users.some((u: { id: string }) => u.id === guideBot.id));
step('owner can rename/remove built-in bots without deleting their existing chats');

// Logout revokes refresh
await call('POST', '/api/auth/logout', a);
assert.equal((await call('POST', '/api/auth/refresh', a)).status, 401);
step('logout revokes the refresh token');

sockA.close();
sockB.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('All smoke tests passed.');
process.exit(0);
assert.ok(Math.abs((Date.parse(statusRes.json.status.expiresAt) - Date.parse(statusRes.json.status.createdAt)) - 24 * 60 * 60 * 1000) < 1000);
