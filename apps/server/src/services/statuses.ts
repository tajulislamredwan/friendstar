import type { StatusBackground, StatusFeedEntry, StatusItem, StatusMusicTrackId, StatusViewer } from '@friendstar/shared';
import { all, one, run } from '../db/database.ts';
import { STATUS_MUSIC_MIME } from '@friendstar/shared';
import { forbidden, HttpError, newId, notFound, nowIso } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';
import { fileMeta } from './chat.ts';
import { areContacts, eitherBlocked, requireUser, toPublicUser } from './users.ts';

/** Stories last 24 hours and are shared with people you have a one-to-one chat with. */
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 30;

interface StatusRow {
  id: string;
  user_id: string;
  kind: 'text' | 'image' | 'video';
  body: string;
  bg: StatusBackground;
  music_track_id: StatusMusicTrackId | null;
  music_file_id: string | null;
  file_id: string | null;
  created_at: string;
  expires_at: string;
}

/** Direct-chat contacts, minus anyone blocked in either direction. */
export function statusAudience(userId: string): string[] {
  return all<{ user_id: string }>(
    `SELECT DISTINCT m2.user_id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id != m1.user_id
     WHERE c.kind = 'direct' AND c.last_message_id IS NOT NULL`,
    userId,
  )
    .map((r) => r.user_id)
    .filter((id) => !eitherBlocked(userId, id));
}

function canView(ownerId: string, viewerId: string) {
  return ownerId === viewerId || (areContacts(ownerId, viewerId) && !eitherBlocked(ownerId, viewerId));
}

function purgeExpired() {
  const now = nowIso();
  const expired = all<{ id: string; file_id: string | null; music_file_id: string | null }>('SELECT id, file_id, music_file_id FROM statuses WHERE expires_at <= ?', now);
  for (const s of expired) {
    run('DELETE FROM statuses WHERE id = ?', s.id);
    for (const fileId of [s.file_id, s.music_file_id]) {
      if (fileId && !one('SELECT 1 FROM statuses WHERE file_id = ? OR music_file_id = ?', fileId, fileId)) {
        run('DELETE FROM files WHERE id = ? AND conversation_id IS NULL', fileId);
      }
    }
  }
}

function toItem(s: StatusRow, viewerId: string): StatusItem {
  const viewed = !!one('SELECT 1 FROM status_views WHERE status_id = ? AND viewer_id = ?', s.id, viewerId);
  const item: StatusItem = {
    id: s.id,
    userId: s.user_id,
    kind: s.kind,
    body: s.body,
    bg: s.bg,
    musicTrackId: s.music_track_id,
    musicFile: fileMeta(s.music_file_id, viewerId),
    file: fileMeta(s.file_id, viewerId),
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    viewed: s.user_id === viewerId ? true : viewed,
  };
  if (s.user_id === viewerId) {
    item.viewCount = one<{ n: number }>('SELECT COUNT(*) AS n FROM status_views WHERE status_id = ?', s.id)?.n ?? 0;
  }
  return item;
}

function activeRows(userId: string): StatusRow[] {
  return all<StatusRow>('SELECT * FROM statuses WHERE user_id = ? AND expires_at > ? ORDER BY created_at ASC', userId, nowIso());
}

export function listStatuses(viewerId: string): { mine: StatusItem[]; feed: StatusFeedEntry[] } {
  purgeExpired();
  const mine = activeRows(viewerId).map((s) => toItem(s, viewerId));
  const feed: StatusFeedEntry[] = [];
  for (const ownerId of statusAudience(viewerId)) {
    const rows = activeRows(ownerId);
    if (!rows.length) continue;
    const items = rows.map((s) => toItem(s, viewerId));
    feed.push({
      user: toPublicUser(requireUser(ownerId), viewerId),
      items,
      allViewed: items.every((i) => i.viewed),
      latestAt: items[items.length - 1].createdAt,
    });
  }
  // Unseen first, then most recent.
  feed.sort((a, b) => Number(a.allViewed) - Number(b.allViewed) || b.latestAt.localeCompare(a.latestAt));
  return { mine, feed };
}

export function createStatus(
  userId: string,
  input: { kind: 'text' | 'image' | 'video'; body: string; bg?: StatusBackground; fileId?: string | null; musicTrackId?: StatusMusicTrackId | null; musicFileId?: string | null; expiresInHours?: number },
): StatusItem {
  purgeExpired();
  const active = one<{ n: number }>('SELECT COUNT(*) AS n FROM statuses WHERE user_id = ? AND expires_at > ?', userId, nowIso())?.n ?? 0;
  if (active >= MAX_ACTIVE) throw new HttpError(400, 'VALIDATION', `You can have up to ${MAX_ACTIVE} active status updates`);
  const hours = input.expiresInHours ?? 24;
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new HttpError(400, 'VALIDATION', 'Status expiry must be between 1 and 168 hours');
  if (input.musicFileId) {
    const music = one<{ owner_id: string; conversation_id: string | null; mime_type: string }>('SELECT owner_id, conversation_id, mime_type FROM files WHERE id = ?', input.musicFileId);
    if (!music || music.owner_id !== userId || music.conversation_id || !STATUS_MUSIC_MIME.includes(music.mime_type as (typeof STATUS_MUSIC_MIME)[number])) {
      throw new HttpError(400, 'VALIDATION', 'Choose an audio file from your device');
    }
  }
  const id = newId();
  const now = new Date();
  run(
    'INSERT INTO statuses (id, user_id, kind, body, bg, music_track_id, music_file_id, file_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    userId,
    input.kind,
    input.body,
    input.bg ?? 'violet',
    input.musicTrackId ?? null,
    input.musicFileId ?? null,
    input.fileId ?? null,
    now.toISOString(),
    new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
  );
  for (const viewer of statusAudience(userId)) hub.emit(viewer, 'status:new', { userId });
  hub.emit(userId, 'status:new', { userId });
  return toItem(one<StatusRow>('SELECT * FROM statuses WHERE id = ?', id)!, userId);
}

function requireVisible(statusId: string, viewerId: string): StatusRow {
  const s = one<StatusRow>('SELECT * FROM statuses WHERE id = ? AND expires_at > ?', statusId, nowIso());
  if (!s || !canView(s.user_id, viewerId)) throw notFound('Status not found');
  return s;
}

export function markStatusViewed(viewerId: string, statusId: string) {
  const s = requireVisible(statusId, viewerId);
  if (s.user_id === viewerId) return;
  run('INSERT OR IGNORE INTO status_views (status_id, viewer_id, viewed_at) VALUES (?, ?, ?)', statusId, viewerId, nowIso());
}

export function listStatusViewers(ownerId: string, statusId: string): StatusViewer[] {
  const s = requireVisible(statusId, ownerId);
  if (s.user_id !== ownerId) throw forbidden('Only the owner can see who viewed this');
  return all<{ viewer_id: string; viewed_at: string }>(
    'SELECT viewer_id, viewed_at FROM status_views WHERE status_id = ? ORDER BY viewed_at DESC',
    statusId,
  ).map((v) => ({ user: toPublicUser(requireUser(v.viewer_id), ownerId), viewedAt: v.viewed_at }));
}

export function deleteStatus(ownerId: string, statusId: string) {
  const s = one<StatusRow>('SELECT * FROM statuses WHERE id = ?', statusId);
  if (!s || s.user_id !== ownerId) throw notFound('Status not found');
  run('DELETE FROM statuses WHERE id = ?', statusId);
  for (const fileId of [s.file_id, s.music_file_id]) {
    if (fileId && !one('SELECT 1 FROM statuses WHERE file_id = ? OR music_file_id = ?', fileId, fileId)) {
      run('DELETE FROM files WHERE id = ? AND conversation_id IS NULL', fileId);
    }
  }
}
