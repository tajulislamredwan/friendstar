import type { BotKind, StatusBackground } from '@friendstar/shared';
import { all, one, run, tx, type MessageRow, type UserRow } from '../db/database.ts';
import { config } from '../config.ts';
import { newId, nowIso } from '../lib/util.ts';
import { getGroupRow, getOrCreateDirect, markRead, memberIds, relayTyping, sendMessage } from './chat.ts';
import { hooks } from './hooks.ts';
import { botKindOf, getFriendId } from './identity.ts';
import { createStatus } from './statuses.ts';

/**
 * Built-in bots. They are ordinary user rows (so chats, ticks, search and groups just work)
 * flagged in the `bots` table. They cannot sign in. Replies run in the background after a
 * message is stored, with a short typing indicator.
 */

interface BotDef {
  kind: BotKind;
  username: string;
  displayName: string;
  bio: string;
  statuses: { body: string; bg: StatusBackground }[];
}

export const BOT_DEFS: BotDef[] = [
  {
    kind: 'ai',
    username: 'starai',
    displayName: 'Star AI',
    bio: 'Your AI helper. Ask me anything, in English or বাংলা.',
    statuses: [
      { body: 'Ask me anything: ideas, translations, recipes, homework help ✦', bg: 'midnight' },
      { body: 'আমাকে বাংলায়ও প্রশ্ন করতে পারো 🙂', bg: 'violet' },
    ],
  },
  {
    kind: 'guide',
    username: 'novaguide',
    displayName: 'Nova Guide',
    bio: 'I show you around FriendStar. Say "help".',
    statuses: [{ body: 'Tip: share your FriendStar ID so friends can find you instantly.', bg: 'ocean' }],
  },
  {
    kind: 'echo',
    username: 'echobot',
    displayName: 'Echo Bot',
    bio: 'I repeat everything you send. Handy for testing ticks and photos.',
    statuses: [{ body: 'Say something… I’ll say it back 🔁', bg: 'forest' }],
  },
  {
    kind: 'fun',
    username: 'luckybot',
    displayName: 'Lucky',
    bio: 'Dice, coin flips, jokes and quotes. Type "help".',
    statuses: [{ body: '🎲 Feeling lucky? Message me "roll" or "joke".', bg: 'sunset' }],
  },
];

/* ---------------- AI provider (platform-specific) ---------------- */

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
type AiProvider = (turns: ChatTurn[]) => Promise<string>;
type AiImageProvider = (prompt: string) => Promise<string>;
let aiImageProvider: AiImageProvider | null = null;

export const AI_IMAGE_LIMITS = { perUserPerDay: 1, perAppPerDay: 5 } as const;
export function setAiImageProvider(fn: AiImageProvider | null) {
  aiImageProvider = fn;
}
export function hasAiImageProvider() {
  return aiImageProvider !== null;
}
export async function generateAiImage(prompt: string) {
  if (!aiImageProvider) throw new Error('Image generation is not available on this server');
  return aiImageProvider(prompt);
}
export function takeAiImageQuota(userId: string): boolean {
  const day = nowIso().slice(0, 10);
  let allowed = false;
  tx(() => {
    const mine = one<{ count: number }>('SELECT count FROM ai_image_usage WHERE day = ? AND user_id = ?', day, userId)?.count ?? 0;
    const total = one<{ n: number }>('SELECT COALESCE(SUM(count), 0) AS n FROM ai_image_usage WHERE day = ?', day)?.n ?? 0;
    if (mine >= AI_IMAGE_LIMITS.perUserPerDay || total >= AI_IMAGE_LIMITS.perAppPerDay) return;
    run(
      `INSERT INTO ai_image_usage (day, user_id, count) VALUES (?, ?, 1)
       ON CONFLICT (day, user_id) DO UPDATE SET count = count + 1`,
      day,
      userId,
    );
    allowed = true;
  });
  run('DELETE FROM ai_image_usage WHERE day < ?', day);
  return allowed;
}

/** Node default: any OpenAI-compatible endpoint if configured. The Worker swaps in Workers AI. */
let aiProvider: AiProvider | null =
  config.aiApiKey && config.aiApiBase
    ? async (turns) => {
        const res = await fetch(`${config.aiApiBase.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.aiApiKey}` },
          body: JSON.stringify({ model: config.aiModel, messages: turns, max_tokens: 500 }),
        });
        if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return data.choices?.[0]?.message?.content ?? '';
      }
    : null;

export function setAiProvider(fn: AiProvider | null) {
  aiProvider = fn;
}

/** Free-tier guard rails: per-person and whole-app daily caps on AI replies. */
export const AI_LIMITS = { perUserPerDay: 30, perAppPerDay: 400 };

function takeAiQuota(userId: string): boolean {
  const day = nowIso().slice(0, 10);
  const mine = one<{ count: number }>('SELECT count FROM ai_usage WHERE day = ? AND user_id = ?', day, userId)?.count ?? 0;
  const total = one<{ n: number }>('SELECT COALESCE(SUM(count), 0) AS n FROM ai_usage WHERE day = ?', day)?.n ?? 0;
  if (mine >= AI_LIMITS.perUserPerDay || total >= AI_LIMITS.perAppPerDay) return false;
  run(
    `INSERT INTO ai_usage (day, user_id, count) VALUES (?, ?, 1)
     ON CONFLICT (day, user_id) DO UPDATE SET count = count + 1`,
    day,
    userId,
  );
  if (Math.random() < 0.05) run('DELETE FROM ai_usage WHERE day < ?', day);
  return true;
}

/* ---------------- Bot accounts ---------------- */

export function botUserId(kind: BotKind): string | undefined {
  return one<{ user_id: string }>('SELECT user_id FROM bots WHERE kind = ? AND enabled = 1', kind)?.user_id;
}

/** A bcrypt-shaped hash nobody knows the password for; bots are also refused at sign-in. */
function unusableHash() {
  const bytes = new Uint8Array(40);
  crypto.getRandomValues(bytes);
  const chars = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return `$2a$12$${Array.from(bytes, (b) => chars[b % 64]).join('').padEnd(53, 'x').slice(0, 53)}`;
}

/** Creates any missing bot accounts. Returns the kinds created this time. */
export function ensureBots(): BotKind[] {
  const created: BotKind[] = [];
  for (const def of BOT_DEFS) {
    if (one('SELECT 1 FROM bots WHERE kind = ?', def.kind)) continue;
    let username = def.username;
    for (let i = 0; one('SELECT 1 AS x FROM users WHERE username = ?', username); i++) username = `${def.username}${i + 2}`;
    const id = newId();
    run(
      `INSERT INTO users (id, username, email, password_hash, display_name, bio, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      username,
      `${username}@bots.friendstar.invalid`,
      unusableHash(),
      def.displayName,
      def.bio,
      // Bots sort before real people in "newest" lists only via the bots pin, not by date.
      '2026-01-01T00:00:00.000Z',
    );
    run('INSERT OR IGNORE INTO privacy_settings (user_id) VALUES (?)', id);
    run('INSERT INTO bots (user_id, kind) VALUES (?, ?)', id, def.kind);
    getFriendId(id);
    created.push(def.kind);
  }
  refreshBotStatuses();
  // First time the guide exists: welcome everyone who joined before bots were added.
  if (created.includes('guide')) {
    const people = all<{ id: string }>('SELECT u.id FROM users u WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = u.id)');
    for (const p of people) welcome(p.id, true);
  }
  return created;
}

/** Keeps one fresh demo status per bot so the Status tab is never empty for newcomers. */
export function refreshBotStatuses() {
  for (const def of BOT_DEFS) {
    const id = botUserId(def.kind);
    if (!id) continue;
    const live = one('SELECT 1 AS x FROM statuses WHERE user_id = ? AND expires_at > ?', id, nowIso());
    if (live) continue;
    const pick = def.statuses[Math.floor(Math.random() * def.statuses.length)]!;
    try {
      createStatus(id, { kind: 'text', body: pick.body, bg: pick.bg });
    } catch {
      /* ignore */
    }
  }
}

function welcome(userId: string, existingUser = false) {
  const nova = botUserId('guide');
  if (!nova || nova === userId) return;
  try {
    const conv = getOrCreateDirect(nova, userId);
    const code = getFriendId(userId);
    const owner = config.ownerEmails
      .map((email) => one<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE lower(email) = ?', email))
      .find((row) => row !== undefined);
    const body = existingUser
      ? `Hi! I’m Nova ✦ FriendStar just got new things: group calls, People with public IDs, and bots.\n\nYour FriendStar ID is ${code}. Share it, or your email, and friends can find you in Search.\n\nSay "help" to see what I can show you.`
      : `Welcome to FriendStar ✦ I’m Nova, your guide.\n\nYour FriendStar ID is ${code}. Share it, or your email, so friends can find you in Search.\n\nTake the short feature tour: https://chat.friendstar.workers.dev/feature-tour.mp4\n\nTry this:\n• Chat with Star AI and generate an image (limited free daily quota)\n• Make a group and start a group call\n• Post a photo or video Status with a caption and music\n• Set an away reply in Settings when you’re offline\n\n${owner ? `Admin contact: ${owner.display_name} · FriendStar ID ${getFriendId(owner.id)} · Portfolio: https://tajul.jayan.workers.dev` : 'Admin contact details are unavailable right now.'}\n\nSay "help" anytime.`;
    sendMessage(nova, conv.id, { clientId: `welcome-${userId}`, kind: 'text', body });
  } catch {
    // The person may only accept messages from contacts; that's fine.
  }
}

/* ---------------- Replies ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pickOne = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const nameOf = (id: string) => one<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', id)?.display_name ?? 'friend';
const firstName = (id: string) => nameOf(id).split(/\s+/)[0] ?? 'friend';
const hasBangla = (s: string) => /[\u0980-\u09FF]/.test(s);

function guideReply(text: string, senderId: string): string {
  const t = text.toLowerCase();
  const code = getFriendId(senderId);
  if (/\b(id|code)\b|আইডি/.test(t))
    return `Your FriendStar ID is ${code}.\n\nAnyone can type an ID, an email address or a name in Search (or open People) to find someone. Copy your ID from Settings → Profile, or share your invite link from there.`;
  if (/group|গ্রুপ/.test(t))
    return 'Groups: on Chats, tap the people icon, pick friends and give the group a name. Admins can rename it, change the photo, and add or remove people. Mention a bot (like @starai) in a group to get an answer there.';
  if (/call|কল|video|ভিডিও/.test(t))
    return `Calls: in any chat, tap the phone or camera icon. In a group, the same buttons start a group call for up to 6 people, and others can join from the green banner. Calls connect directly between phones. On some strict office or mobile networks they may not connect.`;
  if (/status|story|স্ট্যাটাস/.test(t))
    return 'Status: open the Status tab and tap the pencil for a text update, or the camera for a photo. Updates disappear after 24 hours, and you can see who viewed them.';
  if (/privacy|block|hide|প্রাইভেসি/.test(t))
    return 'Privacy: Settings → Privacy lets you hide last seen and your photo, turn off read receipts, choose who can message you, and leave the People list. Your ID and exact email still work for friends you share them with.';
  if (/search|find|people|খুঁজ/.test(t))
    return 'Find people: tap Search on Chats and type a name, a username, an email address or a FriendStar ID (like FS-7K2QX9). The People page lists everyone who’s happy to be found.';
  if (/bot|ai|robot|বট/.test(t))
    return 'Bots: Star AI answers questions (in Bangla too), Echo Bot repeats what you say, and Lucky does dice, coin flips and jokes. Find them all on the People page.';
  if (/^(hi|hello|hey|salam|assalamu|হাই|হ্যালো|আসসালামু)/.test(t))
    return `Hi ${firstName(senderId)}! 👋 What would you like to know? Try: ID, group, call, status, privacy, search or bots.`;
  return `I can explain: ID · group · call · status · privacy · search · bots.\n\nJust send one of those words. Your ID is ${code}.`;
}

const JOKES = [
  'Why don’t programmers like nature? Too many bugs. 🐛',
  'I told my phone a joke about Wi-Fi… it didn’t get the connection. 📶',
  'Why did the scarecrow get promoted? He was outstanding in his field. 🌾',
  'শিক্ষক: “বলো তো, আলো কোথা থেকে আসে?” ছাত্র: “সুইচ থেকে, স্যার!” 💡',
  'What do you call a sleeping dinosaur? A dino-snore. 🦕',
  'রিকশাওয়ালা: “ভাই, কই যাবেন?” আমি: “ভবিষ্যতে।” রিকশাওয়ালা: “ভাড়া বেশি লাগবে।” 🛺',
];
const QUOTES = [
  '“The best way to predict the future is to create it.” – Peter Drucker',
  '“Small deeds done are better than great deeds planned.” – Peter Marshall',
  '“যে মানুষ স্বপ্ন দেখে, সেই এগিয়ে যায়।”',
  '“Kindness is free. Sprinkle it everywhere.”',
  '“Done is better than perfect.”',
];

function funReply(text: string): string {
  const t = text.trim().toLowerCase();
  const dice = /(?:roll|dice|ছক্কা)\s*(\d{1,2})?d?(\d{1,3})?/.exec(t);
  if (dice) {
    const count = Math.min(Math.max(Number(dice[1] ?? 1) || 1, 1), 10);
    const sides = Math.min(Math.max(Number(dice[2] ?? 6) || 6, 2), 100);
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    return `🎲 ${rolls.join(' + ')}${count > 1 ? ` = ${rolls.reduce((a, b) => a + b, 0)}` : ''}`;
  }
  if (/flip|coin|টস/.test(t)) return pickOne(['🪙 Heads!', '🪙 Tails!']);
  if (/joke|কৌতুক|জোক/.test(t)) return pickOne(JOKES);
  if (/quote|উক্তি/.test(t)) return pickOne(QUOTES);
  const pick = /^pick\s+(.+)/.exec(t);
  if (pick) {
    const opts = pick[1]!.split(/,|\bor\b/).map((s) => s.trim()).filter(Boolean);
    if (opts.length > 1) return `I pick… ${pickOne(opts)} ✨`;
  }
  const rps = /^(rock|paper|scissors)$/.exec(t);
  if (rps) {
    const me = pickOne(['rock', 'paper', 'scissors'] as const);
    const you = rps[1]!;
    const wins: Record<string, string> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const result = me === you ? 'Draw!' : wins[you] === me ? 'You win! 🎉' : 'I win! 😎';
    return `You: ${you} · Me: ${me}. ${result}`;
  }
  if (/number|random/.test(t)) return `🔢 ${1 + Math.floor(Math.random() * 100)}`;
  return 'Try: roll · roll 2d6 · flip · joke · quote · pick tea, coffee · rock / paper / scissors · number';
}

function echoReply(m: MessageRow): string {
  if (m.kind === 'image') return `📷 Got your photo${m.body ? `: “${m.body}”` : ''}. Your ticks turned amber because I read it.`;
  if (m.kind === 'file') return '📎 Got your file. I can’t open files, but the upload worked.';
  return `🔁 ${m.body}`;
}

const AI_SYSTEM_PROMPT = `You are Star AI, the friendly assistant inside FriendStar, a private messaging app.
Reply helpfully and concisely (usually under 120 words). Always answer in the language the user wrote in:
Bangla script for Bangla, and Banglish (Bangla in Latin letters) for Banglish. Use plain text with simple
line breaks, no markdown tables or headings. If asked about FriendStar: it has one-to-one and group chats,
group calls up to 6 people, voice and video calls, 24-hour Status, public FriendStar IDs (FS-XXXXXX), and
privacy settings.`;

async function aiReply(convId: string, botId: string, m: MessageRow, isGroup: boolean): Promise<string> {
  const bangla = hasBangla(m.body);
  if (!aiProvider)
    return bangla
      ? 'এই লোকাল ভার্সনে AI চালু নেই। লাইভ অ্যাপে আমি উত্তর দিতে পারি।'
      : 'AI isn’t switched on in this local copy. On the live app I can answer for real.';
  if (!takeAiQuota(m.sender_id))
    return bangla
      ? 'আজকের ফ্রি AI লিমিট শেষ হয়ে গেছে। কাল আবার চেষ্টা করো 🙏'
      : 'I’ve used up today’s free AI allowance. Please try again tomorrow 🙏';
  const history = all<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? AND kind != 'system'
     ORDER BY created_at DESC LIMIT 12`,
    convId,
  ).reverse();
  const turns: ChatTurn[] = [{ role: 'system', content: AI_SYSTEM_PROMPT }];
  for (const h of history) {
    const content = h.kind === 'text' ? h.body : `[${h.kind === 'image' ? 'photo' : 'file'}] ${h.body}`.trim();
    if (!content) continue;
    if (h.sender_id === botId) turns.push({ role: 'assistant', content });
    else turns.push({ role: 'user', content: isGroup ? `${nameOf(h.sender_id)}: ${content}` : content });
  }
  try {
    const out = (await aiProvider(turns)).trim();
    return out.slice(0, 3500) || '…';
  } catch (err) {
    console.error('[ai]', err);
    return bangla ? 'দুঃখিত, এখন উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করো।' : 'Sorry, I couldn’t think of an answer just now. Please try again in a moment.';
  }
}

function mentioned(text: string, botId: string): boolean {
  const u = one<{ username: string; display_name: string }>('SELECT username, display_name FROM users WHERE id = ?', botId);
  if (!u) return false;
  const t = text.toLowerCase();
  return t.includes(`@${u.username}`) || t.includes(u.display_name.toLowerCase());
}

async function respond(kind: BotKind, botId: string, convId: string, m: MessageRow, isGroup: boolean) {
  await sleep(350);
  try {
    markRead(convId, botId);
  } catch {
    return;
  }
  relayTyping(botId, convId, true);
  const started = Date.now();
  let body: string;
  switch (kind) {
    case 'ai':
      body = await aiReply(convId, botId, m, isGroup);
      break;
    case 'guide':
      body = guideReply(m.body, m.sender_id);
      break;
    case 'echo':
      body = echoReply(m);
      break;
    default:
      body = funReply(m.body);
  }
  const minTyping = kind === 'ai' ? 300 : 700;
  if (Date.now() - started < minTyping) await sleep(minTyping - (Date.now() - started));
  relayTyping(botId, convId, false);
  try {
    if (!one('SELECT 1 FROM bots WHERE user_id = ? AND enabled = 1', botId)) return;
    sendMessage(botId, convId, { clientId: `bot-${newId()}`, kind: 'text', body });
  } catch {
    // Conversation may have gone away (left group / deleted account) while we were thinking.
  }
}

hooks.onMessage((m, convId) => {
  if (m.kind === 'system' || botKindOf(m.sender_id)) return;
  if (m.client_id.startsWith('aiimg_')) return;
  const isGroup = !!getGroupRow(convId);
  for (const memberId of memberIds(convId)) {
    if (memberId === m.sender_id) continue;
    const kind = botKindOf(memberId);
    if (!kind || !one('SELECT 1 FROM bots WHERE user_id = ? AND enabled = 1', memberId)) continue;
    if (isGroup && !mentioned(m.body, memberId)) continue;
    hooks.background(respond(kind, memberId, convId, m, isGroup));
  }
});

hooks.onRegister((user: UserRow) => {
  if (botKindOf(user.id)) return;
  welcome(user.id);
});
