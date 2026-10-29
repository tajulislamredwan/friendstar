import { type AdminBotRow, type AdminLoginEvent, type AdminSummary, type AdminUserRow, type BotKind } from '@friendstar/shared';
import { all, one, run, type UserRow } from '../db/database.ts';
import { HttpError, likeEscape, newId, nowIso } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';
import { getFriendId, isOwnerEmail } from './identity.ts';
import { requireUser } from './users.ts';

/** Keep the most recent N login events; older ones are pruned automatically. */
const MAX_LOGIN_EVENTS = 20_000;

export type LoginKind = AdminLoginEvent['kind'] | 'login_failed';

/** Stores only the event kind, account ID and time; credentials and request/device data are never recorded. */
export function recordLoginEvent(kind: LoginKind, userId: string | null) {
  run(
    `INSERT INTO login_events (id, user_id, login_tried, kind, ip, country, user_agent, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    userId,
    '',
    kind,
    '',
    '',
    '',
    nowIso(),
  );
  // Cheap pruning: roughly 1 in 50 inserts trims the table back to the cap.
  if (Math.random() < 0.02) {
    run(
      `DELETE FROM login_events WHERE id IN (
         SELECT id FROM login_events ORDER BY at DESC LIMIT -1 OFFSET ?)`,
      MAX_LOGIN_EVENTS,
    );
  }
}

/** Throws 404 (not 403) for non-owners so the admin area's existence isn't advertised. */
export function requireOwner(userId: string): UserRow {
  const user = requireUser(userId);
  if (!isOwnerEmail(user.email)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
  return user;
}

const startOfTodayIso = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

export function adminSummary(): AdminSummary {
  const today = startOfTodayIso();
  const n = (sql: string, ...p: (string | number)[]) => one<{ n: number }>(sql, ...p)?.n ?? 0;
  const ids = all<{ id: string }>('SELECT id FROM users');
  return {
    users: n('SELECT COUNT(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = u.id)'),
    bots: n('SELECT COUNT(*) AS n FROM bots WHERE enabled = 1'),
    onlineNow: ids.filter((u) => hub.isOnline(u.id)).length,
    signupsToday: n("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", today),
    loginsToday: n("SELECT COUNT(*) AS n FROM login_events WHERE kind = 'login' AND at >= ?", today),
    failedLoginsToday: n("SELECT COUNT(*) AS n FROM login_events WHERE kind = 'login_failed' AND at >= ?", today),
    messages: n("SELECT COUNT(*) AS n FROM messages WHERE kind != 'system'"),
    groups: n("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'group'"),
  };
}

interface AdminUserQueryRow {
  id: string;
  username: string;
  display_name: string;
  email: string;
  created_at: string;
  bot_kind: BotKind | null;
  bot_enabled: number | null;
  last_login_at: string | null;
  login_count: number;
}

/** Every account with sign-up and last sign-in details. Never includes password hashes. */
export function adminUsers(q = ''): AdminUserRow[] {
  const like = `%${likeEscape(q.trim())}%`;
  const rows = all<AdminUserQueryRow>(
    `SELECT u.id, u.username, u.display_name, u.email, u.created_at,
            b.kind AS bot_kind, b.enabled AS bot_enabled,
            le.at AS last_login_at,
            (SELECT COUNT(*) FROM login_events x WHERE x.user_id = u.id AND x.kind = 'login') AS login_count
     FROM users u
     LEFT JOIN bots b ON b.user_id = u.id
     LEFT JOIN login_events le ON le.id = (
       SELECT id FROM login_events y WHERE y.user_id = u.id AND y.kind IN ('login', 'register') ORDER BY y.at DESC LIMIT 1)
     LEFT JOIN friend_ids f ON f.user_id = u.id
     WHERE (? = '%%' OR u.id LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'
            OR u.email LIKE ? ESCAPE '\\' OR f.code LIKE ? ESCAPE '\\')
     ORDER BY CASE WHEN b.kind IS NULL THEN 0 ELSE 1 END, u.created_at DESC
     LIMIT 1000`,
    like,
    like,
    like,
    like,
    like,
    like,
  );
  return rows.map((u) => ({
    id: u.id,
    friendId: getFriendId(u.id),
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    online: hub.isOnline(u.id),
    bot: u.bot_kind,
    botEnabled: u.bot_kind ? u.bot_enabled !== 0 : false,
    loginCount: u.login_count,
  }));
}

export function adminBots(ownerId: string): AdminBotRow[] {
  requireOwner(ownerId);
  return all<{ id: string; kind: BotKind; username: string; display_name: string; enabled: number }>(
    `SELECT u.id, b.kind, u.username, u.display_name, b.enabled
     FROM bots b JOIN users u ON u.id = b.user_id ORDER BY b.kind`,
  ).map((b) => ({ id: b.id, kind: b.kind, username: b.username, displayName: b.display_name, enabled: b.enabled === 1 }));
}

export function renameAdminBot(ownerId: string, botId: string, displayName: string): AdminBotRow {
  requireOwner(ownerId);
  const bot = one<{ id: string }>('SELECT user_id AS id FROM bots WHERE user_id = ?', botId);
  if (!bot) throw new HttpError(404, 'NOT_FOUND', 'Bot not found');
  run('UPDATE users SET display_name = ? WHERE id = ?', displayName, botId);
  return adminBots(ownerId).find((b) => b.id === botId)!;
}

/** Soft-delete the bot from active use; retained chats/messages remain untouched. */
export function deleteAdminBot(ownerId: string, botId: string) {
  requireOwner(ownerId);
  const bot = one<{ id: string; enabled: number }>('SELECT user_id AS id, enabled FROM bots WHERE user_id = ?', botId);
  if (!bot) throw new HttpError(404, 'NOT_FOUND', 'Bot not found');
  run('UPDATE bots SET enabled = 0 WHERE user_id = ?', botId);
  const statuses = all<{ file_id: string | null; music_file_id: string | null }>('SELECT file_id, music_file_id FROM statuses WHERE user_id = ?', botId);
  run('DELETE FROM statuses WHERE user_id = ?', botId);
  for (const row of statuses) for (const fileId of [row.file_id, row.music_file_id]) {
    if (fileId && !one('SELECT 1 FROM statuses WHERE file_id = ? OR music_file_id = ?', fileId, fileId)) run('DELETE FROM files WHERE id = ? AND conversation_id IS NULL', fileId);
  }
  return { id: botId, enabled: false };
}

interface LoginQueryRow {
  id: string;
  user_id: string | null;
  kind: AdminLoginEvent['kind'];
  at: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
}

export function adminLogins(opts: { userId?: string; before?: string; limit?: number } = {}): AdminLoginEvent[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = all<LoginQueryRow>(
    `SELECT le.id, le.user_id, le.kind, le.at, u.username, u.display_name, u.email FROM login_events le
     LEFT JOIN users u ON u.id = le.user_id
     WHERE le.kind IN ('login', 'register') AND (? = '' OR le.user_id = ?) AND (? = '' OR le.at < ?)
     ORDER BY le.at DESC LIMIT ?`,
    opts.userId ?? '',
    opts.userId ?? '',
    opts.before ?? '',
    opts.before ?? '',
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    email: r.email,
    kind: r.kind,
    at: r.at,
  }));
}
