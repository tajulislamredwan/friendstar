import { normalizeFriendId, type Audience, type Me, type PeoplePage, type PrivacySettings, type PublicUser } from '@friendstar/shared';
import { botKindOf, getFriendId, isBotEnabled, isOwnerEmail, userIdByFriendId } from './identity.ts';
import { all, one, run, type PrivacyRow, type UserRow } from '../db/database.ts';
import { likeEscape, notFound, nowIso, signFileUrl } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';

export function getUserRow(id: string): UserRow | undefined {
  return one<UserRow>('SELECT * FROM users WHERE id = ?', id);
}
export function requireUser(id: string): UserRow {
  const u = getUserRow(id);
  if (!u) throw notFound('User not found');
  return u;
}

export function getPrivacyRow(userId: string): PrivacyRow {
  const row = one<PrivacyRow>('SELECT * FROM privacy_settings WHERE user_id = ?', userId);
  if (row) return row;
  run('INSERT OR IGNORE INTO privacy_settings (user_id) VALUES (?)', userId);
  return one<PrivacyRow>('SELECT * FROM privacy_settings WHERE user_id = ?', userId)!;
}

export function toPrivacy(row: PrivacyRow): PrivacySettings {
  return {
    lastSeen: row.last_seen,
    profilePhoto: row.profile_photo,
    readReceipts: !!row.read_receipts,
    whoCanMessage: row.who_can_message,
    discoverable: !!row.discoverable,
  };
}

/** Two users are "contacts" once they share a conversation that has at least one message. */
export function areContacts(a: string, b: string): boolean {
  if (a === b) return true;
  const row = one<{ ok: number }>(
    `SELECT 1 AS ok FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
     WHERE c.kind = 'direct' AND c.last_message_id IS NOT NULL LIMIT 1`,
    a,
    b,
  );
  return !!row;
}

export function hasBlocked(blocker: string, blocked: string): boolean {
  return !!one('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', blocker, blocked);
}
export function eitherBlocked(a: string, b: string): boolean {
  return !!one(
    'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
    a,
    b,
    b,
    a,
  );
}

function audienceAllows(audience: Audience, ownerId: string, viewerId: string): boolean {
  if (ownerId === viewerId) return true;
  if (audience === 'everyone') return true;
  if (audience === 'contacts') return areContacts(ownerId, viewerId);
  return false;
}

/** Serialize a user for a specific viewer; all privacy filtering happens here, server-side. */
export function toPublicUser(user: UserRow, viewerId: string): PublicUser {
  const privacy = getPrivacyRow(user.id);
  const blockedViewer = user.id !== viewerId && hasBlocked(user.id, viewerId);
  const showPresence = !blockedViewer && audienceAllows(privacy.last_seen, user.id, viewerId);
  const showPhoto = !blockedViewer && audienceAllows(privacy.profile_photo, user.id, viewerId);
  const bot = botKindOf(user.id);
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    bio: blockedViewer ? '' : user.bio,
    avatarUrl: showPhoto && user.avatar_file_id ? signFileUrl(user.avatar_file_id, viewerId) : null,
    lastSeenAt: showPresence ? user.last_seen_at : null,
    online: showPresence ? hub.isOnline(user.id) || bot !== null : null,
    isBlocked: user.id !== viewerId ? hasBlocked(viewerId, user.id) : false,
    friendId: getFriendId(user.id),
    bot,
  };
}

export function toMe(user: UserRow): Me {
  return {
    ...toPublicUser(user, user.id),
    email: user.email,
    online: true,
    createdAt: user.created_at,
    isOwner: isOwnerEmail(user.email),
  };
}

export function updateProfile(userId: string, patch: { displayName?: string; bio?: string }) {
  const u = requireUser(userId);
  run(
    'UPDATE users SET display_name = ?, bio = ? WHERE id = ?',
    patch.displayName ?? u.display_name,
    patch.bio ?? u.bio,
    userId,
  );
  return requireUser(userId);
}

export function updatePrivacy(userId: string, patch: Partial<PrivacySettings>) {
  const cur = toPrivacy(getPrivacyRow(userId));
  const next = { ...cur, ...patch };
  run(
    `UPDATE privacy_settings SET last_seen = ?, profile_photo = ?, read_receipts = ?, who_can_message = ?, discoverable = ?
     WHERE user_id = ?`,
    next.lastSeen,
    next.profilePhoto,
    next.readReceipts ? 1 : 0,
    next.whoCanMessage,
    next.discoverable ? 1 : 0,
    userId,
  );
  return next;
}

/** IDs of users who share a conversation with this user (for presence fan-out). */
export function peerIds(userId: string): string[] {
  return all<{ user_id: string }>(
    `SELECT DISTINCT m2.user_id FROM conversation_members m1
       JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id AND m2.user_id != m1.user_id
     WHERE m1.user_id = ?`,
    userId,
  ).map((r) => r.user_id);
}

export function broadcastPresence(userId: string) {
  const user = getUserRow(userId);
  if (!user) return;
  for (const peerId of peerIds(userId)) {
    const view = toPublicUser(user, peerId);
    hub.emit(peerId, 'presence', { userId, online: view.online, lastSeenAt: view.lastSeenAt });
  }
}

export function touchLastSeen(userId: string) {
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', nowIso(), userId);
}

/**
 * People search. An exact FriendStar ID or exact email always finds the person (that is how
 * friends share themselves); partial name/username matches respect the "appear in search" setting.
 * People who blocked the viewer never appear.
 */
export function searchUsers(viewerId: string, q: string): PublicUser[] {
  const exact: UserRow[] = [];
  const code = normalizeFriendId(q);
  if (code) {
    const id = userIdByFriendId(code);
    const u = id ? getUserRow(id) : undefined;
    if (u) exact.push(u);
  }
  if (q.includes('@') && q.includes('.')) {
    const u = one<UserRow>('SELECT * FROM users WHERE email = ?', q.trim().toLowerCase());
    if (u) exact.push(u);
  }
  const handle = q.replace(/^@/, '');
  const like = `%${likeEscape(handle)}%`;
  const rows = all<UserRow>(
    `SELECT u.* FROM users u
     WHERE u.id != ?
       AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
     ORDER BY CASE WHEN u.username LIKE ? ESCAPE '\\' THEN 0 WHEN u.display_name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
              u.display_name
     LIMIT 60`,
    viewerId,
    like,
    like,
    `${likeEscape(handle)}%`,
    `${likeEscape(handle)}%`,
  ).filter((u) => getPrivacyRow(u.id).discoverable || areContacts(u.id, viewerId));
  const seen = new Set<string>();
  return [...exact, ...rows]
    .filter((u) => u.id !== viewerId && (!botKindOf(u.id) || isBotEnabled(u.id)) && !hasBlocked(u.id, viewerId) && !seen.has(u.id) && seen.add(u.id))
    .slice(0, 25)
    .map((u) => toPublicUser(u, viewerId));
}

/**
 * Everyone on FriendStar who allows being found, newest first, bots pinned on the first page.
 * Cursor = created_at|id of the last row.
 */
export function listPeople(viewerId: string, cursor?: string, limit = 30): PeoplePage {
  const visible = `u.id != ? AND p.discoverable = 1
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = ?)
       AND NOT EXISTS (SELECT 1 FROM bots bx WHERE bx.user_id = u.id AND bx.enabled = 0)`;
  const total =
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM users u JOIN privacy_settings p ON p.user_id = u.id WHERE ${visible}`, viewerId, viewerId)?.n ?? 0;
  const [cAt, cId] = cursor ? cursor.split('|') : [];
  const rows = all<UserRow>(
    `SELECT u.* FROM users u JOIN privacy_settings p ON p.user_id = u.id
     LEFT JOIN bots bt ON bt.user_id = u.id
     WHERE ${visible}
       AND (? IS NULL OR (bt.user_id IS NULL AND (u.created_at < ? OR (u.created_at = ? AND u.id < ?))))
     ORDER BY CASE WHEN bt.user_id IS NULL THEN 1 ELSE 0 END, u.created_at DESC, u.id DESC
     LIMIT ?`,
    viewerId,
    viewerId,
    cAt ?? null,
    cAt ?? '',
    cAt ?? '',
    cId ?? '',
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    people: page.map((u) => toPublicUser(u, viewerId)),
    nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null,
    total,
  };
}
export function listBlocked(userId: string): PublicUser[] {
  return all<UserRow>(
    'SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC',
    userId,
  ).map((u) => toPublicUser(u, userId));
}

export function block(userId: string, targetId: string) {
  requireUser(targetId);
  if (userId === targetId) return;
  run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', userId, targetId, nowIso());
}
export function unblock(userId: string, targetId: string) {
  run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', userId, targetId);
}
