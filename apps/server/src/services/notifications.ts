import type { AppNotification } from '@friendstar/shared';
import { all, one, run, type MessageRow } from '../db/database.ts';
import { newId, nowIso } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';
import { getUserRow } from './users.ts';
import { fileMeta } from './chat.ts';

interface NotificationRow {
  id: string;
  user_id: string;
  type: 'new_message' | 'system' | 'announcement' | 'missed_call' | 'group';
  title: string;
  body: string;
  file_id: string | null;
  conversation_id: string | null;
  actor_id: string | null;
  read_at: string | null;
  created_at: string;
}

const toNotification = (n: NotificationRow, viewerId: string): AppNotification => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  file: fileMeta(n.file_id, viewerId),
  conversationId: n.conversation_id,
  actorId: n.actor_id,
  readAt: n.read_at,
  createdAt: n.created_at,
});

export function unreadNotificationCount(userId: string): number {
  return one<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId)?.n ?? 0;
}

export function listNotifications(userId: string) {
  const rows = all<NotificationRow>(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
    userId,
  );
  return { notifications: rows.map((n) => toNotification(n, userId)), unread: unreadNotificationCount(userId) };
}

export function preview(m: Pick<MessageRow, 'kind' | 'body'>): string {
  if (m.kind === 'image') return m.body ? `📷 ${m.body}` : '📷 Photo';
  if (m.kind === 'file') return m.body ? `📎 ${m.body}` : '📎 File';
  return m.body.length > 120 ? `${m.body.slice(0, 117)}…` : m.body;
}

/** Unread notifications for one conversation collapse into a single item with a running count. */
/** For groups, the title is the group name and the body is prefixed with the sender. */
export function notifyNewMessage(recipientId: string, senderId: string, conversationId: string, m: MessageRow, groupTitle?: string) {
  const muted = one<{ muted: number }>(
    'SELECT muted FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    conversationId,
    recipientId,
  );
  if (muted?.muted) return;
  const sender = getUserRow(senderId);
  if (!sender) return;
  const heading = groupTitle ?? sender.display_name;
  const body = groupTitle ? `${sender.display_name}: ${preview(m)}` : preview(m);
  const now = nowIso();
  const existing = one<NotificationRow & { count?: number }>(
    `SELECT * FROM notifications WHERE user_id = ? AND conversation_id = ? AND type = 'new_message' AND read_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    recipientId,
    conversationId,
  );
  let id: string;
  if (existing) {
    const match = /\((\d+) new\)$/.exec(existing.title);
    const count = (match ? Number(match[1]) : 1) + 1;
    id = existing.id;
    run(
      'UPDATE notifications SET title = ?, body = ?, created_at = ? WHERE id = ?',
      `${heading} (${count} new)`,
      body,
      now,
      id,
    );
  } else {
    id = newId();
    run(
      `INSERT INTO notifications (id, user_id, type, title, body, conversation_id, actor_id, created_at)
       VALUES (?, ?, 'new_message', ?, ?, ?, ?, ?)`,
      id,
      recipientId,
      heading,
      body,
      conversationId,
      senderId,
      now,
    );
  }
  const row = one<NotificationRow>('SELECT * FROM notifications WHERE id = ?', id)!;
  hub.emit(recipientId, 'notification:new', { notification: toNotification(row, recipientId), unread: unreadNotificationCount(recipientId) });
}

export function markConversationNotificationsRead(userId: string, conversationId: string) {
  run(
    'UPDATE notifications SET read_at = ? WHERE user_id = ? AND conversation_id = ? AND read_at IS NULL',
    nowIso(),
    userId,
    conversationId,
  );
}

export function markAllNotificationsRead(userId: string) {
  run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), userId);
}

export function markNotificationRead(userId: string, notificationId: string): number {
  run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', nowIso(), notificationId, userId);
  return unreadNotificationCount(userId);
}

export function createSystemNotification(userId: string, title: string, body: string) {
  run(
    `INSERT INTO notifications (id, user_id, type, title, body, created_at) VALUES (?, ?, 'system', ?, ?, ?)`,
    newId(),
    userId,
    title,
    body,
    nowIso(),
  );
}

/** Store a notification and push it live (missed calls, "added you to a group", ...). */
export function pushNotification(
  userId: string,
  type: 'missed_call' | 'group' | 'system',
  title: string,
  body: string,
  conversationId: string | null,
  actorId: string | null,
) {
  const id = newId();
  run(
    `INSERT INTO notifications (id, user_id, type, title, body, conversation_id, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    type,
    title,
    body,
    conversationId,
    actorId,
    nowIso(),
  );
  const row = one<NotificationRow>('SELECT * FROM notifications WHERE id = ?', id)!;
  hub.emit(userId, 'notification:new', { notification: toNotification(row, userId), unread: unreadNotificationCount(userId) });
}
