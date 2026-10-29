import type { CallInfo, CallMedia, CallSignal, CallStatus, IceServer } from '@friendstar/shared';
import { all, one, run } from '../db/database.ts';
import { nowIso } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';
import { canMessage, getConversationRow, isGroupRow, isMember, peerOf } from './chat.ts';
import { pushNotification } from './notifications.ts';
import { requireUser, toPublicUser } from './users.ts';

/**
 * One-to-one voice/video calls. Media flows peer-to-peer over WebRTC; the server only
 * relays signalling (offer / answer / ICE candidates) and keeps a call log.
 */
export const RING_TIMEOUT_MS = 45_000;
export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface CallRow {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  media: CallMedia;
  status: CallStatus;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

/** Free public STUN servers. A TURN relay can be added per platform (see the Worker's ICE route). */
export const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

const getCall = (id: string) => one<CallRow>('SELECT * FROM calls WHERE id = ?', id);
const otherParty = (c: CallRow, userId: string) => (c.caller_id === userId ? c.callee_id : c.caller_id);

function toCallInfo(c: CallRow, viewerId: string): CallInfo {
  return {
    id: c.id,
    conversationId: c.conversation_id,
    callerId: c.caller_id,
    calleeId: c.callee_id,
    media: c.media,
    status: c.status,
    createdAt: c.created_at,
    answeredAt: c.answered_at,
    endedAt: c.ended_at,
    peer: toPublicUser(requireUser(otherParty(c, viewerId)), viewerId),
  };
}

function emitCall(c: CallRow, only?: string) {
  for (const uid of only ? [only] : [c.caller_id, c.callee_id]) hub.emit(uid, 'call:update', { call: toCallInfo(c, uid) });
}

function finish(c: CallRow, status: CallStatus) {
  run('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?', status, nowIso(), c.id);
  const fresh = getCall(c.id)!;
  emitCall(fresh);
  if (status === 'missed') {
    const caller = requireUser(c.caller_id);
    pushNotification(
      c.callee_id,
      'missed_call',
      caller.display_name,
      c.media === 'video' ? 'Missed video call' : 'Missed voice call',
      c.conversation_id,
      c.caller_id,
    );
  }
  return fresh;
}

/** Ringing calls that timed out become missed; "ongoing" calls with someone gone become ended. */
function sweepStale(userId: string) {
  const cutoff = new Date(Date.now() - RING_TIMEOUT_MS).toISOString();
  const live = all<CallRow>(
    `SELECT * FROM calls WHERE (caller_id = ? OR callee_id = ?) AND status IN ('ringing', 'ongoing')`,
    userId,
    userId,
  );
  for (const c of live) {
    if (c.status === 'ringing' && c.created_at < cutoff) finish(c, 'missed');
    else if (c.status === 'ongoing' && (!hub.isOnline(c.caller_id) || !hub.isOnline(c.callee_id))) finish(c, 'ended');
  }
}

/** In a ringing/ongoing one-to-one call. */
export function inDirectCall(userId: string): boolean {
  sweepStale(userId);
  return !!one(`SELECT 1 FROM calls WHERE (caller_id = ? OR callee_id = ?) AND status IN ('ringing', 'ongoing')`, userId, userId);
}

/** In a one-to-one call or currently joined to a group call. */
export function isBusy(userId: string): boolean {
  if (inDirectCall(userId)) return true;
  return !!one(
    `SELECT 1 FROM call_participants cp JOIN group_calls g ON g.id = cp.call_id
     WHERE cp.user_id = ? AND cp.left_at IS NULL AND g.status = 'ongoing'`,
    userId,
  );
}

export function startCall(userId: string, p: { callId?: unknown; conversationId?: unknown; media?: unknown }) {
  const { callId, conversationId, media } = p;
  if (typeof callId !== 'string' || !ID_RE.test(callId) || typeof conversationId !== 'string') return;
  if (media !== 'audio' && media !== 'video') return;
  if (getCall(callId)) return;
  const conv = getConversationRow(conversationId);
  if (!conv || isGroupRow(conv) || !isMember(conversationId, userId)) return;
  const calleeId = peerOf(conversationId, userId);

  const record = (status: CallStatus) => {
    const now = nowIso();
    const ended = status === 'ringing' ? null : now;
    run(
      'INSERT INTO calls (id, conversation_id, caller_id, callee_id, media, status, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      callId,
      conversationId,
      userId,
      calleeId,
      media,
      status,
      now,
      ended,
    );
    return getCall(callId)!;
  };

  // Blocked or not allowed: look exactly like "unavailable" so blocks are never revealed.
  if (!canMessage(userId, calleeId)) return emitCall(record('unavailable'), userId);
  if (isBusy(userId)) return emitCall(record('busy'), userId);
  if (isBusy(calleeId)) {
    const c = record('busy');
    emitCall(c, userId);
    return finishMissedNotice(c);
  }
  if (!hub.isOnline(calleeId)) {
    const c = record('unavailable');
    emitCall(c, userId);
    return finishMissedNotice(c);
  }
  emitCall(record('ringing'));
}

/** The callee still hears about calls they couldn't take. */
function finishMissedNotice(c: CallRow) {
  const caller = requireUser(c.caller_id);
  pushNotification(
    c.callee_id,
    'missed_call',
    caller.display_name,
    c.media === 'video' ? 'Missed video call' : 'Missed voice call',
    c.conversation_id,
    c.caller_id,
  );
  hub.emit(c.callee_id, 'call:update', { call: toCallInfo(c, c.callee_id) });
}

export function acceptCall(userId: string, callId: unknown) {
  const c = typeof callId === 'string' ? getCall(callId) : undefined;
  if (!c || c.callee_id !== userId || c.status !== 'ringing') return;
  run(`UPDATE calls SET status = 'ongoing', answered_at = ? WHERE id = ?`, nowIso(), c.id);
  emitCall(getCall(c.id)!);
}

export function declineCall(userId: string, callId: unknown) {
  const c = typeof callId === 'string' ? getCall(callId) : undefined;
  if (!c || c.callee_id !== userId || c.status !== 'ringing') return;
  finish(c, 'declined');
}

export function endCall(userId: string, callId: unknown) {
  const c = typeof callId === 'string' ? getCall(callId) : undefined;
  if (!c || (c.caller_id !== userId && c.callee_id !== userId)) return;
  if (c.status === 'ringing') finish(c, c.caller_id === userId ? 'missed' : 'declined');
  else if (c.status === 'ongoing') finish(c, 'ended');
}

export function validSignal(d: unknown): d is CallSignal {
  if (!d || typeof d !== 'object') return false;
  const s = d as Record<string, unknown>;
  if (s.type === 'offer' || s.type === 'answer') return typeof s.sdp === 'string' && s.sdp.length < 30_000;
  if (s.type === 'candidate') {
    const c = s.candidate as Record<string, unknown> | undefined;
    return !!c && typeof c.candidate === 'string' && c.candidate.length < 2_000;
  }
  if (s.type === 'media') return typeof s.video === 'boolean' && typeof s.audio === 'boolean';
  return false;
}

export function relaySignal(userId: string, p: { callId?: unknown; data?: unknown }) {
  const c = typeof p.callId === 'string' ? getCall(p.callId) : undefined;
  if (!c || (c.caller_id !== userId && c.callee_id !== userId)) return;
  if (c.status !== 'ongoing' && c.status !== 'ringing') return;
  if (!validSignal(p.data)) return;
  hub.emit(otherParty(c, userId), 'call:signal', { callId: c.id, fromUserId: userId, data: p.data });
}

/** Called when a user's last live connection closes. */
export function callsUserOffline(userId: string) {
  const live = all<CallRow>(
    `SELECT * FROM calls WHERE (caller_id = ? OR callee_id = ?) AND status IN ('ringing', 'ongoing')`,
    userId,
    userId,
  );
  for (const c of live) finish(c, c.status === 'ringing' ? 'missed' : 'ended');
}

export function listCalls(userId: string): CallInfo[] {
  sweepStale(userId);
  return all<CallRow>(
    'SELECT * FROM calls WHERE caller_id = ? OR callee_id = ? ORDER BY created_at DESC LIMIT 100',
    userId,
    userId,
  ).map((c) => toCallInfo(c, userId));
}
