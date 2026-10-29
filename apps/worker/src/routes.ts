/**
 * HTTP API for the Cloudflare build. Mirrors apps/server/src/routes/{auth,api}.ts
 * (same paths, payloads and errors) on top of the shared services.
 */
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import {
  addMembersSchema,
  createGroupSchema,
  createTextStatusSchema,
  adminAnnouncementSendSchema,
  aiImagePromptSchema,
  statusMediaFieldsSchema,
  adminBotUpdateSchema,
  setRoleSchema,
  updateGroupSchema,
  createConversationSchema,
  listMessagesSchema,
  loginSchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  adminPasswordResetIssueSchema,
  offlineReplySchema,
  privacySchema,
  registerSchema,
  searchSchema,
  sendFileFieldsSchema,
  sendTextSchema,
  updateProfileSchema,
  normalizeFriendId,
} from '@friendstar/shared';
import { config } from './platform/config.ts';
import { all, one, run, tx, type FileRow } from './platform/database.ts';
import { liveSockets } from './platform/hub.ts';
import { HttpError, newId, notFound, sha256, signAccessToken, unauthorized, verifyAccessToken, verifyFileSignature } from './platform/util.ts';
import { readFileBytes, storeUpload } from './files.ts';
import {
  issueRefreshToken,
  registerUser,
  revokeByToken,
  rotateRefreshToken,
  verifyLogin,
} from '../../server/src/services/auth.ts';
import {
  getOrCreateDirect,
  isMember,
  listConversations,
  listMessages,
  memberIds,
  markRead,
  searchMessages,
  sendMessage,
  summaryById,
  fileMeta,
  requireMembership,
  isGroupAdmin,
} from '../../server/src/services/chat.ts';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../../server/src/services/notifications.ts';
import { generateAiImage, hasAiImageProvider, takeAiImageQuota } from '../../server/src/services/bots.ts';
import { getOfflineReplySettings, updateOfflineReplySettings } from '../../server/src/services/offlineReply.ts';
import {
  addMembers,
  createGroup,
  purgeUserFromGroups,
  removeMember,
  renameGroup,
  setGroupAvatar,
  setMemberRole,
} from '../../server/src/services/groups.ts';
import { createStatus, deleteStatus, listStatusViewers, listStatuses, markStatusViewed } from '../../server/src/services/statuses.ts';
import { DEFAULT_ICE_SERVERS, listCalls } from '../../server/src/services/calls.ts';
import { iceServersFor } from './turn.ts';
import { adminBots, adminLogins, adminSummary, adminUsers, deleteAdminBot, recordLoginEvent, renameAdminBot, requireOwner } from '../../server/src/services/admin.ts';
import { createAdminAnnouncementPreview, listAdminAnnouncements, sendAdminAnnouncement } from '../../server/src/services/adminAnnouncements.ts';
import { adminPasswordResetRequests, completePasswordReset, createPasswordResetRequest, issueAdminPasswordReset } from '../../server/src/services/passwordResets.ts';
import { refreshBotStatuses } from '../../server/src/services/bots.ts';
import { groupCallsUserOffline, listActiveGroupCalls, listGroupCallHistory } from '../../server/src/services/groupCalls.ts';
import { botKindOf, userIdByFriendId } from '../../server/src/services/identity.ts';
import {
  block,
  broadcastPresence,
  getPrivacyRow,
  getUserRow,
  listBlocked,
  requireUser,
  searchUsers,
  hasBlocked,
  listPeople,
  toMe,
  toPrivacy,
  toPublicUser,
  unblock,
  updatePrivacy,
  updateProfile,
} from '../../server/src/services/users.ts';

type Env = { Variables: { userId: string } };
type C = Context<Env>;

const COOKIE = 'fs_rt';
const cookieOpts = {
  httpOnly: true,
  sameSite: 'Strict' as const,
  secure: true,
  path: '/api/auth',
  maxAge: Math.floor(config.refreshTokenTtlMs / 1000),
};

const parse = <S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> => schema.parse(data);
const query = (c: C) => Object.fromEntries(new URL(c.req.url).searchParams);
const ua = (c: C) => c.req.header('user-agent') ?? '';

async function jsonBody(c: C): Promise<unknown> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > 100 * 1024) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request too large');
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'VALIDATION', 'Malformed JSON');
  }
}

async function formBody(c: C, maxBytes: number): Promise<FormData> {
  const len = Number(c.req.header('content-length') ?? 0);
  // Multipart overhead is small; reject obviously oversized bodies before buffering them.
  if (len > maxBytes + 64 * 1024) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'That file is too large');
  try {
    return await c.req.formData();
  } catch {
    throw new HttpError(400, 'VALIDATION', 'Malformed upload');
  }
}

function session(c: C, userId: string, refreshToken: string) {
  setCookie(c, COOKIE, refreshToken, cookieOpts);
  c.header('Cache-Control', 'no-store');
  return { user: toMe(requireUser(userId)), accessToken: signAccessToken(userId) };
}

/* ---------- Simple in-memory rate limiting (single Durable Object instance) ---------- */
const buckets = new Map<string, { count: number; resetAt: number }>();
function hit(key: string, limit: number): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  b.count++;
  return b.count <= limit;
}
const rateLimited = () => new HttpError(429, 'RATE_LIMITED', 'Too many requests, slow down a little.');
const clientIp = (c: C) => c.req.header('cf-connecting-ip') ?? 'unknown';

export const app = new Hono<Env>().basePath('/api');

app.use('*', async (c, next) => {
  if (!hit(`api:${clientIp(c)}`, config.apiRateLimitPerMin)) throw rateLimited();
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

app.onError((err, c) => {
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) fields[issue.path.join('.') || 'form'] ??= issue.message;
    return c.json({ error: { code: 'VALIDATION', message: Object.values(fields)[0] ?? 'Invalid input', fields } }, 400);
  }
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, fields: err.fields } }, err.status as 400);
  }
  console.error('[error]', err instanceof Error ? err.stack : err);
  return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong' } }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));

/* ---------- Auth ---------- */
/** Only failed credential attempts count toward the brute-force limit. */
async function guardCredentials<T>(c: C, fn: () => Promise<T>): Promise<T> {
  const key = `auth:${clientIp(c)}`;
  const b = buckets.get(key);
  if (b && b.resetAt > Date.now() && b.count >= config.authRateLimitPerMin) throw rateLimited();
  try {
    return await fn();
  } catch (err) {
    hit(key, config.authRateLimitPerMin);
    throw err;
  }
}

app.post('/auth/register', async (c) => {
  const body = await jsonBody(c);
  const input = parse(registerSchema, body);
  const user = await guardCredentials(c, () => registerUser(input));
  recordLoginEvent('register', user.id);
  return c.json(session(c, user.id, issueRefreshToken(user.id, ua(c))), 201);
});

app.post('/auth/login', async (c) => {
  const body = await jsonBody(c);
  const { login, password } = parse(loginSchema, body);
  const user = await guardCredentials(c, async () => {
    try {
      return await verifyLogin(login, password);
    } catch (err) {
      recordLoginEvent('login_failed', null);
      throw err;
    }
  });
  recordLoginEvent('login', user.id);
  return c.json(session(c, user.id, issueRefreshToken(user.id, ua(c))));
});

app.post('/auth/password-reset/request', async (c) => {
  const { identifier } = parse(passwordResetRequestSchema, await jsonBody(c));
  if (!hit(`password-reset:${clientIp(c)}`, 5) || !hit(`password-reset-identifier:${sha256(identifier.toLowerCase())}`, 5)) throw rateLimited();
  return c.json(createPasswordResetRequest(identifier));
});

app.post('/auth/password-reset/complete', async (c) => {
  if (!hit(`password-reset-complete:${clientIp(c)}`, 5)) throw rateLimited();
  const { token, password } = parse(passwordResetCompleteSchema, await jsonBody(c));
  await completePasswordReset(token, password);
  return c.json({ message: 'Password updated. Please sign in again.' });
});

app.post('/auth/refresh', (c) => {
  try {
    const { userId, token } = rotateRefreshToken(getCookie(c, COOKIE), ua(c));
    return c.json(session(c, userId, token));
  } catch (err) {
    deleteCookie(c, COOKIE, { path: cookieOpts.path, secure: true });
    throw err;
  }
});

app.post('/auth/logout', (c) => {
  revokeByToken(getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: cookieOpts.path, secure: true });
  return c.body(null, 204);
});

/* ---------- Files (signed URLs, no Bearer header) ---------- */
app.get('/files/:id', (c) => {
  const { u, exp, sig, download } = query(c);
  const id = c.req.param('id');
  if (!u || !exp || !sig || !verifyFileSignature(id, u, Number(exp), sig)) throw notFound('File not found');
  const file = one<FileRow>('SELECT * FROM files WHERE id = ?', id);
  if (!file) throw notFound('File not found');
  if (file.conversation_id && !isMember(file.conversation_id, u)) throw notFound('File not found');
  const bytes = readFileBytes(file.id, file.size_bytes);
  if (!bytes) throw notFound('File not found');
  const inline = (file.mime_type.startsWith('image/') || file.mime_type.startsWith('video/')) && download !== '1';
  const range = c.req.header('range');
  let start = 0;
  let end = bytes.byteLength - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${bytes.byteLength}` } });
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${bytes.byteLength}` } });
      start = Math.max(0, bytes.byteLength - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes.byteLength || end < start) {
      return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${bytes.byteLength}` } });
    }
    end = Math.min(end, bytes.byteLength - 1);
    status = 206;
  }
  const body = status === 206 ? bytes.slice(start, end + 1) : bytes;
  const headers = new Headers({
    'Content-Type': file.mime_type,
    'Content-Length': String(body.byteLength),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  });
  if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${bytes.byteLength}`);
  return new Response(body, { status, headers });
});

/* ---------- Everything below requires a Bearer access token ---------- */
app.use('*', async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw unauthorized();
  const userId = verifyAccessToken(token);
  if (!getUserRow(userId)) throw unauthorized();
  c.set('userId', userId);
  await next();
});

const me = (c: C) => c.get('userId');

app.get('/auth/me', (c) => c.json({ user: toMe(requireUser(me(c))) }));

app.patch('/me', async (c) => c.json({ user: toMe(updateProfile(me(c), parse(updateProfileSchema, await jsonBody(c)))) }));

app.post('/me/avatar', async (c) => {
  const form = await formBody(c, 5 * 1024 * 1024);
  const { id } = await storeUpload(form.get('file'), me(c), 'avatar');
  run('UPDATE users SET avatar_file_id = ? WHERE id = ?', id, me(c));
  return c.json({ user: toMe(requireUser(me(c))) });
});

app.delete('/me/avatar', (c) => {
  run('UPDATE users SET avatar_file_id = NULL WHERE id = ?', me(c));
  return c.json({ user: toMe(requireUser(me(c))) });
});

app.get('/me/privacy', (c) => c.json({ privacy: toPrivacy(getPrivacyRow(me(c))) }));
app.get('/me/offline-reply', (c) => c.json({ settings: getOfflineReplySettings(me(c)) }));
app.patch('/me/offline-reply', async (c) => {
  const patch = parse(offlineReplySchema, await jsonBody(c));
  return c.json({ settings: updateOfflineReplySettings(me(c), patch) });
});

/**
 * Delete my account. Requires the current password. Removes the account, its sessions,
 * settings, notifications, uploaded files and its one-to-one conversations (both sides).
 */
app.delete('/me', async (c) => {
  const body = (await jsonBody(c)) as { password?: unknown };
  const user = requireUser(me(c));
  await guardCredentials(c, () => verifyLogin(user.username, typeof body.password === 'string' ? body.password : ''));
  // Groups live on for the other members; only one-to-one chats are removed entirely.
  groupCallsUserOffline(user.id);
  run('DELETE FROM call_participants WHERE user_id = ?', user.id);
  run('DELETE FROM ai_usage WHERE user_id = ?', user.id);
  purgeUserFromGroups(user.id);
  run('UPDATE group_info SET avatar_file_id = NULL WHERE avatar_file_id IN (SELECT id FROM files WHERE owner_id = ?)', user.id);
  const convIds = all<{ conversation_id: string }>(
    'SELECT conversation_id FROM conversation_members WHERE user_id = ?',
    user.id,
  ).map((r) => r.conversation_id);
  tx(() => {
    for (const id of convIds) {
      run('DELETE FROM notifications WHERE conversation_id = ?', id);
      run('DELETE FROM conversations WHERE id = ?', id); // cascades messages + members
      run('DELETE FROM files WHERE conversation_id = ?', id); // cascades file chunks
    }
    run('UPDATE users SET avatar_file_id = NULL WHERE id = ?', user.id);
    run('DELETE FROM files WHERE owner_id = ? AND id NOT IN (SELECT avatar_file_id FROM users WHERE avatar_file_id IS NOT NULL)', user.id);
    run('DELETE FROM notifications WHERE actor_id = ?', user.id);
    run('DELETE FROM users WHERE id = ?', user.id); // cascades privacy, blocks, tokens, notifications
  });
  for (const ws of liveSockets(user.id)) {
    try {
      ws.close(4401, 'ACCOUNT_DELETED');
    } catch {
      /* ignore */
    }
  }
  deleteCookie(c, COOKIE, { path: cookieOpts.path, secure: true });
  return c.body(null, 204);
});

app.patch('/me/privacy', async (c) => {
  const privacy = updatePrivacy(me(c), parse(privacySchema, await jsonBody(c)));
  broadcastPresence(me(c));
  return c.json({ privacy });
});

app.get('/me/blocks', (c) => c.json({ users: listBlocked(me(c)) }));
app.post('/me/blocks/:userId', (c) => {
  block(me(c), c.req.param('userId'));
  return c.body(null, 204);
});
app.delete('/me/blocks/:userId', (c) => {
  unblock(me(c), c.req.param('userId'));
  return c.body(null, 204);
});

app.get('/users/:id', (c) => c.json({ user: toPublicUser(requireUser(c.req.param('id')), me(c)) }));

app.get('/search', (c) => {
  const { q } = parse(searchSchema, query(c));
  return c.json({ users: searchUsers(me(c), q), messages: searchMessages(me(c), q) });
});

app.get('/conversations', (c) => c.json({ conversations: listConversations(me(c)) }));

app.post('/conversations', async (c) => {
  const { userId } = parse(createConversationSchema, await jsonBody(c));
  return c.json({ conversation: getOrCreateDirect(me(c), userId) });
});

app.get('/conversations/:id', (c) => c.json({ conversation: summaryById(c.req.param('id'), me(c)) }));

app.get('/conversations/:id/messages', (c) => {
  const { before, limit } = parse(listMessagesSchema, query(c));
  return c.json(listMessages(c.req.param('id'), me(c), before, limit));
});

app.post('/conversations/:id/messages', async (c) => {
  const conversationId = c.req.param('id');
  const userId = me(c);
  if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
    const form = await formBody(c, 10 * 1024 * 1024);
    const fields = parse(sendFileFieldsSchema, {
      clientId: form.get('clientId') ?? undefined,
      body: form.get('body') ?? undefined,
    });
    // Membership and blocking are checked before storing anything.
    if (!isMember(conversationId, userId)) throw notFound('Conversation not found');
    const { id, isImage } = await storeUpload(form.get('file'), userId, 'attachment');
    const message = sendMessage(userId, conversationId, {
      clientId: fields.clientId,
      kind: isImage ? 'image' : 'file',
      body: fields.body,
      fileId: id,
    });
    return c.json({ message }, 201);
  }
  const input = parse(sendTextSchema, await jsonBody(c));
  return c.json({ message: sendMessage(userId, conversationId, input) }, 201);
});

app.post('/conversations/:id/ai-image', async (c) => {
  const userId = me(c);
  const conversationId = c.req.param('id');
  const { prompt } = parse(aiImagePromptSchema, await jsonBody(c));
  if (!hasAiImageProvider()) throw new HttpError(503, 'INTERNAL', 'Image generation is not available right now.');
  const conversation = requireMembership(conversationId, userId);
  const peerId = memberIds(conversationId).find((id) => id !== userId);
  if (conversation.kind !== 'direct' || !peerId || botKindOf(peerId) !== 'ai') {
    throw new HttpError(403, 'FORBIDDEN', 'Image generation is only available in the Star AI chat.');
  }
  if (!takeAiImageQuota(userId)) {
    throw new HttpError(429, 'RATE_LIMITED', 'Free image limit reached: one per person per day, five per day across FriendStar.');
  }
  let encoded: string;
  try {
    encoded = await generateAiImage(prompt);
  } catch {
    throw new HttpError(502, 'INTERNAL', 'Image generation failed. Please try again later.');
  }
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const file = new File([bytes], `star-ai-${newId()}.jpg`, { type: 'image/jpeg' });
  const { id: fileId } = await storeUpload(file, userId, 'attachment');
  const message = sendMessage(userId, conversationId, {
    clientId: `aiimg_${newId()}`,
    kind: 'image',
    body: `AI image prompt: ${prompt}`,
    fileId,
  });
  return c.json({ message, conversation: summaryById(conversationId, userId) }, 201);
});

app.post('/conversations/:id/read', (c) => c.json({ conversation: markRead(c.req.param('id'), me(c)) }));

app.get('/notifications', (c) => c.json(listNotifications(me(c))));
app.post('/notifications/read-all', (c) => {
  markAllNotificationsRead(me(c));
  return c.body(null, 204);
});
app.post('/notifications/:id/read', (c) => c.json({ unread: markNotificationRead(me(c), c.req.param('id')) }));

/* ---------- Groups ---------- */
function setGroupAvatarGuard(userId: string, conversationId: string) {
  const conv = requireMembership(conversationId, userId);
  if (conv.kind !== 'group' || !isGroupAdmin(conversationId, userId)) throw new HttpError(403, 'FORBIDDEN', 'Only group admins can do that');
}
app.post('/groups', async (c) => {
  const { title, memberIds } = parse(createGroupSchema, await jsonBody(c));
  return c.json({ conversation: createGroup(me(c), title, memberIds) }, 201);
});
app.patch('/groups/:id', async (c) => {
  const { title } = parse(updateGroupSchema, await jsonBody(c));
  return c.json({ conversation: renameGroup(me(c), c.req.param('id'), title) });
});
app.post('/groups/:id/avatar', async (c) => {
  // Consume the bounded request before returning a rejection: an unread forwarded
  // multipart stream can outlive its response in workerd. Never store before auth.
  const form = await formBody(c, 5 * 1024 * 1024);
  setGroupAvatarGuard(me(c), c.req.param('id'));
  const { id } = await storeUpload(form.get('file'), me(c), 'avatar');
  return c.json({ conversation: setGroupAvatar(me(c), c.req.param('id'), id) });
});
app.post('/groups/:id/members', async (c) => {
  const { userIds } = parse(addMembersSchema, await jsonBody(c));
  return c.json({ conversation: addMembers(me(c), c.req.param('id'), userIds) });
});
app.delete('/groups/:id/members/:userId', (c) =>
  c.json({ conversation: removeMember(me(c), c.req.param('id'), c.req.param('userId')) }),
);
app.patch('/groups/:id/members/:userId', async (c) => {
  const { role } = parse(setRoleSchema, await jsonBody(c));
  return c.json({ conversation: setMemberRole(me(c), c.req.param('id'), c.req.param('userId'), role) });
});

/* ---------- Status stories ---------- */
app.get('/statuses', (c) => {
  refreshBotStatuses();
  return c.json(listStatuses(me(c)));
});
app.post('/statuses', async (c) => {
  const userId = me(c);
  if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
    const form = await formBody(c, 20 * 1024 * 1024);
    const mediaFile = form.get('file');
    const musicFile = form.get('musicFile');
    if (mediaFile && typeof mediaFile !== 'string') {
      const fields = parse(statusMediaFieldsSchema, {
        caption: form.get('caption') ?? undefined,
        musicTrackId: form.get('musicTrackId') ?? undefined,
        expiresInHours: form.get('expiresInHours') ?? undefined,
      });
      const { id, isVideo } = await storeUpload(mediaFile, userId, 'status');
      const music = musicFile && typeof musicFile !== 'string' ? await storeUpload(musicFile, userId, 'status-music') : null;
      return c.json({ status: createStatus(userId, { kind: isVideo ? 'video' : 'image', body: fields.caption, fileId: id, musicTrackId: fields.musicTrackId, musicFileId: music?.id, expiresInHours: fields.expiresInHours }) }, 201);
    }
    if (musicFile && typeof musicFile !== 'string') {
      const fields = parse(createTextStatusSchema, {
        body: form.get('body') ?? undefined,
        bg: form.get('bg') ?? undefined,
        musicTrackId: form.get('musicTrackId') ?? undefined,
        expiresInHours: form.get('expiresInHours') ?? undefined,
      });
      const music = await storeUpload(musicFile, userId, 'status-music');
      return c.json({ status: createStatus(userId, { kind: 'text', body: fields.body, bg: fields.bg, musicTrackId: fields.musicTrackId, musicFileId: music.id, expiresInHours: fields.expiresInHours }) }, 201);
    }
    throw new HttpError(400, 'VALIDATION', 'Choose a status photo, video or soundtrack');
  }
  const { body, bg, musicTrackId, expiresInHours } = parse(createTextStatusSchema, await jsonBody(c));
  return c.json({ status: createStatus(userId, { kind: 'text', body, bg, musicTrackId, expiresInHours }) }, 201);
});
app.post('/statuses/:id/view', (c) => {
  markStatusViewed(me(c), c.req.param('id'));
  return c.body(null, 204);
});
app.get('/statuses/:id/viewers', (c) => c.json({ viewers: listStatusViewers(me(c), c.req.param('id')) }));
app.delete('/statuses/:id', (c) => {
  deleteStatus(me(c), c.req.param('id'));
  return c.body(null, 204);
});

/* ---------- Calls ---------- */
app.get('/calls', (c) => c.json({ calls: listCalls(me(c)) }));
app.get('/group-calls', (c) => c.json({ calls: listActiveGroupCalls(me(c)) }));
app.get('/group-calls/history', (c) => c.json({ calls: listGroupCallHistory(me(c)) }));

/* ---------- People directory & invite links ---------- */
app.get('/people', (c) => {
  const cursor = c.req.query('cursor')?.slice(0, 80);
  return c.json(listPeople(me(c), cursor));
});
app.get('/people/by-id/:code', (c) => {
  const code = normalizeFriendId(c.req.param('code'));
  const id = code ? userIdByFriendId(code) : undefined;
  if (!id || hasBlocked(id, me(c))) throw notFound('No one has that FriendStar ID');
  return c.json({ user: toPublicUser(requireUser(id), me(c)) });
});

/* ---------- Admin (owner only) ---------- */
const owner = (c: C) => {
  requireOwner(me(c));
  c.header('Cache-Control', 'no-store');
};
app.get('/admin/summary', (c) => {
  owner(c);
  return c.json(adminSummary());
});
app.get('/admin/users', (c) => {
  owner(c);
  return c.json({ users: adminUsers((c.req.query('q') ?? '').slice(0, 120)) });
});
app.get('/admin/logins', (c) => {
  owner(c);
  const str = (v: string | undefined) => v?.slice(0, 80);
  return c.json({
    events: adminLogins({
      userId: str(c.req.query('userId')),
      before: str(c.req.query('before')),
      limit: Number(c.req.query('limit')) || 100,
    }),
  });
});
app.get('/admin/password-reset-requests', (c) => {
  owner(c);
  return c.json({ requests: adminPasswordResetRequests(me(c)) });
});
app.post('/admin/password-reset-requests/:id/issue', async (c) => {
  const body = await jsonBody(c);
  owner(c);
  const { verified } = parse(adminPasswordResetIssueSchema, body);
  return c.json(issueAdminPasswordReset(me(c), c.req.param('id'), verified));
});
app.get('/admin/bots', (c) => {
  owner(c);
  return c.json({ bots: adminBots(me(c)) });
});
app.patch('/admin/bots/:id', async (c) => {
  owner(c);
  const { displayName } = parse(adminBotUpdateSchema, await jsonBody(c));
  return c.json({ bot: renameAdminBot(me(c), c.req.param('id'), displayName) });
});
app.delete('/admin/bots/:id', (c) => {
  owner(c);
  return c.json(deleteAdminBot(me(c), c.req.param('id')));
});
app.post('/admin/announcements/attachment', async (c) => {
  owner(c);
  const form = await formBody(c, 10 * 1024 * 1024);
  const { id } = await storeUpload(form.get('file'), me(c), 'attachment');
  return c.json({ file: fileMeta(id, me(c)) });
});
app.get('/admin/announcements', (c) => {
  owner(c);
  return c.json({ announcements: listAdminAnnouncements(me(c)) });
});
app.post('/admin/announcements/preview', async (c) => {
  const body = await jsonBody(c);
  owner(c);
  return c.json({ preview: createAdminAnnouncementPreview(me(c), body) });
});
app.post('/admin/announcements/send', async (c) => {
  const body = await jsonBody(c);
  owner(c);
  const { previewId } = parse(adminAnnouncementSendSchema, body);
  return c.json({ announcement: sendAdminAnnouncement(me(c), previewId) });
});
app.get('/calls/ice', async (c) => c.json({ iceServers: await iceServersFor(me(c), DEFAULT_ICE_SERVERS) }));

app.all('*', () => {
  throw notFound('Route not found');
});
