import { GROUP_CALL_MAX, type CallMedia, type GroupCallInfo } from '@friendstar/shared';
import { all, one, run } from '../db/database.ts';
import { nowIso } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';
import { addSystemMessage, getGroupRow, isMember, memberIds } from './chat.ts';
import { ID_RE, isBusy, validSignal } from './calls.ts';
import { botKindOf } from './identity.ts';
import { requireUser, toPublicUser } from './users.ts';

/**
 * Group voice/video calls as a WebRTC mesh: every participant connects directly to every other
 * participant, so it needs no media server (free) but tops out at GROUP_CALL_MAX people.
 * The server tracks who is in the call and relays signalling between specific pairs.
 */
interface GroupCallRow {
  id: string;
  conversation_id: string;
  started_by: string;
  media: CallMedia;
  status: 'ongoing' | 'ended';
  created_at: string;
  ended_at: string | null;
}

const getCall = (id: string) => one<GroupCallRow>('SELECT * FROM group_calls WHERE id = ?', id);

function activeParticipantIds(callId: string): string[] {
  return all<{ user_id: string }>(
    'SELECT user_id FROM call_participants WHERE call_id = ? AND left_at IS NULL ORDER BY joined_at',
    callId,
  ).map((r) => r.user_id);
}

function toInfo(c: GroupCallRow, viewerId: string): GroupCallInfo {
  const parts = all<{ user_id: string; joined_at: string }>(
    'SELECT user_id, joined_at FROM call_participants WHERE call_id = ? AND left_at IS NULL ORDER BY joined_at',
    c.id,
  );
  return {
    id: c.id,
    conversationId: c.conversation_id,
    title: getGroupRow(c.conversation_id)?.title ?? 'Group',
    media: c.media,
    status: c.status,
    startedBy: c.started_by,
    createdAt: c.created_at,
    endedAt: c.ended_at,
    participants: parts.map((p) => ({ user: toPublicUser(requireUser(p.user_id), viewerId), joinedAt: p.joined_at })),
  };
}

function broadcast(c: GroupCallRow, ring = false) {
  for (const m of memberIds(c.conversation_id)) {
    if (botKindOf(m)) continue;
    hub.emit(m, 'gcall:update', { call: toInfo(c, m), ...(ring ? { ring: true } : {}) });
  }
}

function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60}s` : `${s}s`;
}

/** Drops participants whose devices went away without saying goodbye; ends empty calls. */
function sweep(c: GroupCallRow): GroupCallRow {
  if (c.status !== 'ongoing') return c;
  const now = nowIso();
  for (const uid of activeParticipantIds(c.id)) {
    if (!hub.isOnline(uid)) run('UPDATE call_participants SET left_at = ? WHERE call_id = ? AND user_id = ?', now, c.id, uid);
  }
  if (activeParticipantIds(c.id).length === 0) return finish(c);
  return getCall(c.id)!;
}

function finish(c: GroupCallRow): GroupCallRow {
  const now = nowIso();
  run("UPDATE group_calls SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'ongoing'", now, c.id);
  run('UPDATE call_participants SET left_at = ? WHERE call_id = ? AND left_at IS NULL', now, c.id);
  const ended = getCall(c.id)!;
  const people = one<{ n: number }>('SELECT COUNT(*) AS n FROM call_participants WHERE call_id = ?', c.id)?.n ?? 1;
  const kind = c.media === 'video' ? 'Group video call' : 'Group voice call';
  addSystemMessage(
    c.conversation_id,
    c.started_by,
    `${kind} ended · ${people} ${people === 1 ? 'person' : 'people'} · ${formatDuration(Date.parse(now) - Date.parse(c.created_at))}`,
  );
  broadcast(ended);
  return ended;
}

export function activeGroupCall(conversationId: string): GroupCallRow | undefined {
  const c = one<GroupCallRow>(
    "SELECT * FROM group_calls WHERE conversation_id = ? AND status = 'ongoing' ORDER BY created_at DESC LIMIT 1",
    conversationId,
  );
  if (!c) return undefined;
  const swept = sweep(c);
  return swept.status === 'ongoing' ? swept : undefined;
}

/** Ongoing calls in all of the viewer's groups (for the chat list banner after a reload). */
export function listActiveGroupCalls(userId: string): GroupCallInfo[] {
  const rows = all<GroupCallRow>(
    `SELECT g.* FROM group_calls g
     JOIN conversation_members m ON m.conversation_id = g.conversation_id AND m.user_id = ?
     WHERE g.status = 'ongoing'`,
    userId,
  );
  return rows
    .map(sweep)
    .filter((c) => c.status === 'ongoing')
    .map((c) => toInfo(c, userId));
}

function join(c: GroupCallRow, userId: string): boolean {
  const already = activeParticipantIds(c.id).includes(userId);
  if (already) return true;
  if (activeParticipantIds(c.id).length >= GROUP_CALL_MAX) return false;
  run(
    `INSERT INTO call_participants (call_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT (call_id, user_id) DO UPDATE SET joined_at = excluded.joined_at, left_at = NULL`,
    c.id,
    userId,
    nowIso(),
  );
  return true;
}

/** Start a call in a group, or join the one already running there. */
export function startGroupCall(userId: string, p: { callId?: unknown; conversationId?: unknown; media?: unknown }) {
  const { callId, conversationId, media } = p;
  if (typeof callId !== 'string' || !ID_RE.test(callId) || typeof conversationId !== 'string') return;
  if (media !== 'audio' && media !== 'video') return;
  if (!getGroupRow(conversationId) || !isMember(conversationId, userId)) return;
  if (isBusy(userId)) return;
  const existing = activeGroupCall(conversationId);
  if (existing) {
    if (join(existing, userId)) broadcast(getCall(existing.id)!);
    return;
  }
  if (getCall(callId)) return;
  run(
    `INSERT INTO group_calls (id, conversation_id, started_by, media, status, created_at) VALUES (?, ?, ?, ?, 'ongoing', ?)`,
    callId,
    conversationId,
    userId,
    media,
    nowIso(),
  );
  const c = getCall(callId)!;
  join(c, userId);
  broadcast(c, true);
}

export function joinGroupCall(userId: string, callId: unknown) {
  if (typeof callId !== 'string') return;
  const c = getCall(callId);
  if (!c || c.status !== 'ongoing' || !isMember(c.conversation_id, userId)) return;
  if (!activeParticipantIds(c.id).includes(userId) && isBusy(userId)) return;
  const live = sweep(c);
  if (live.status !== 'ongoing') return;
  if (!join(live, userId)) {
    hub.emit(userId, 'gcall:update', { call: toInfo(live, userId) });
    return;
  }
  broadcast(getCall(c.id)!);
}

export function leaveGroupCall(userId: string, callId: unknown) {
  if (typeof callId !== 'string') return;
  const c = getCall(callId);
  if (!c || c.status !== 'ongoing') return;
  run('UPDATE call_participants SET left_at = ? WHERE call_id = ? AND user_id = ? AND left_at IS NULL', nowIso(), c.id, userId);
  if (activeParticipantIds(c.id).length === 0) finish(c);
  else broadcast(getCall(c.id)!);
}

/** Relay offer/answer/ICE/media-state from one participant to another participant of the same call. */
export function relayGroupSignal(userId: string, p: { callId?: unknown; toUserId?: unknown; data?: unknown }) {
  const { callId, toUserId, data } = p;
  if (typeof callId !== 'string' || typeof toUserId !== 'string' || toUserId === userId || !validSignal(data)) return;
  const c = getCall(callId);
  if (!c || c.status !== 'ongoing') return;
  const parts = activeParticipantIds(c.id);
  if (!parts.includes(userId) || !parts.includes(toUserId)) return;
  hub.emit(toUserId, 'gcall:signal', { callId, fromUserId: userId, data });
}

/** Last device disconnected: leave any group calls. */
export function groupCallsUserOffline(userId: string) {
  const rows = all<{ call_id: string }>(
    `SELECT cp.call_id FROM call_participants cp JOIN group_calls g ON g.id = cp.call_id
     WHERE cp.user_id = ? AND cp.left_at IS NULL AND g.status = 'ongoing'`,
    userId,
  );
  for (const r of rows) leaveGroupCall(userId, r.call_id);
}

/** Someone removed from (or leaving) a group also leaves its call. */
export function leaveGroupCallsIn(conversationId: string, userId: string) {
  const c = activeGroupCall(conversationId);
  if (c) leaveGroupCall(userId, c.id);
}

/** Recent group calls in groups the user is still in, for the Calls tab. */
export function listGroupCallHistory(userId: string, limit = 50): GroupCallInfo[] {
  const rows = all<GroupCallRow>(
    `SELECT gc.* FROM group_calls gc
     JOIN conversation_members gm ON gm.conversation_id = gc.conversation_id AND gm.user_id = ?
     ORDER BY gc.created_at DESC LIMIT ?`,
    userId,
    limit,
  );
  return rows.map((r) => {
    const c = sweep(r);
    const joined = one<{ n: number; me: number }>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(user_id = ?), 0) AS me FROM call_participants WHERE call_id = ?',
      userId,
      c.id,
    );
    return { ...toInfo(c, userId), history: { joined: joined?.n ?? 0, iJoined: (joined?.me ?? 0) > 0 } };
  });
}
