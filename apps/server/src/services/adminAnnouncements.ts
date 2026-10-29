import type { AdminAnnouncementPreview, AdminAnnouncementRecord, AppNotification } from '@friendstar/shared';
import { adminAnnouncementDraftSchema } from '@friendstar/shared';
import { all, one, run, tx } from '../db/database.ts';
import { HttpError, newId, nowIso } from '../lib/util.ts';
import { hub } from '../realtime/hub.ts';
import { unreadNotificationCount } from './notifications.ts';
import { requireOwner } from './admin.ts';
import { fileMeta } from './chat.ts';

const PREVIEW_TTL_MS = 10 * 60_000;
const BROADCAST_COOLDOWN_MS = 5 * 60_000;

interface PreviewRow {
  id: string;
  owner_user_id: string;
  title: string;
  body: string;
  file_id: string | null;
  recipient_count: number;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  announcement_id: string | null;
}

interface AnnouncementRow {
  id: string;
  sender_user_id: string;
  sender_email: string;
  title: string;
  body: string;
  file_id: string | null;
  recipient_count: number;
  created_at: string;
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: AppNotification['type'];
  title: string;
  body: string;
  file_id: string | null;
  conversation_id: string | null;
  actor_id: string | null;
  read_at: string | null;
  created_at: string;
}

const toRecord = (row: AnnouncementRow, viewerId: string): AdminAnnouncementRecord => ({
  id: row.id,
  title: row.title,
  body: row.body,
  file: fileMeta(row.file_id, viewerId),
  recipientCount: row.recipient_count,
  senderEmail: row.sender_email,
  createdAt: row.created_at,
});

const toNotification = (row: NotificationRow, viewerId: string): AppNotification => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  file: fileMeta(row.file_id, viewerId),
  conversationId: row.conversation_id,
  actorId: row.actor_id,
  readAt: row.read_at,
  createdAt: row.created_at,
});

function recipientIds() {
  return all<{ id: string }>(
    `SELECT u.id FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = u.id)
     ORDER BY u.created_at, u.id`,
  ).map((row) => row.id);
}

export function createAdminAnnouncementPreview(userId: string, input: unknown): AdminAnnouncementPreview {
  requireOwner(userId);
  const { title, body, fileId } = adminAnnouncementDraftSchema.parse(input);
  if (fileId) {
    const file = one<{ owner_id: string; conversation_id: string | null }>('SELECT owner_id, conversation_id FROM files WHERE id = ?', fileId);
    if (!file || file.owner_id !== userId || file.conversation_id) throw new HttpError(400, 'VALIDATION', 'Choose an attachment uploaded by you');
  }
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();

  return tx(() => {
    // Unsent previews expire; sent preview tokens remain available for safe retry recovery.
    run('DELETE FROM admin_announcement_previews WHERE expires_at <= ? AND announcement_id IS NULL', createdAt);
    const count = recipientIds().length;
    const previewId = newId();
    run(
      `INSERT INTO admin_announcement_previews
       (id, owner_user_id, title, body, file_id, recipient_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      previewId,
      userId,
      title,
      body,
      fileId ?? null,
      count,
      createdAt,
      expiresAt,
    );
    return { previewId, title, body, file: fileMeta(fileId ?? null, userId), recipientCount: count, expiresAt };
  });
}

export function sendAdminAnnouncement(userId: string, previewId: string): AdminAnnouncementRecord {
  const owner = requireOwner(userId);
  const notified: { userId: string; notificationId: string }[] = [];

  const result = tx(() => {
    const preview = one<PreviewRow>(
      'SELECT * FROM admin_announcement_previews WHERE id = ? AND owner_user_id = ?',
      previewId,
      userId,
    );
    if (!preview) throw new HttpError(404, 'NOT_FOUND', 'Announcement preview not found');

    // If the response to a successful request was lost, return its original result without
    // creating another broadcast or another set of user notifications.
    if (preview.announcement_id) {
      const previous = one<AnnouncementRow>('SELECT * FROM admin_announcements WHERE id = ?', preview.announcement_id);
      if (previous) return { record: toRecord(previous, userId), wasAlreadySent: true };
    }
    const now = nowIso();
    if (preview.used_at || preview.expires_at <= now) {
      throw new HttpError(409, 'CONFLICT', 'This preview has expired. Review the announcement again before sending.');
    }

    const recipients = recipientIds();
    if (recipients.length !== preview.recipient_count) {
      throw new HttpError(409, 'CONFLICT', 'The registered-user count changed. Review the announcement again before sending.');
    }
    if (recipients.length === 0) {
      throw new HttpError(409, 'CONFLICT', 'There are no registered people to notify.');
    }

    const cooldownSince = new Date(Date.now() - BROADCAST_COOLDOWN_MS).toISOString();
    const recent = one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM admin_announcements WHERE created_at >= ?',
      cooldownSince,
    )?.n ?? 0;
    if (recent > 0) {
      throw new HttpError(429, 'RATE_LIMITED', 'For safety, wait five minutes between broadcasts.');
    }

    const announcementId = newId();
    run(
      `INSERT INTO admin_announcements
       (id, sender_user_id, sender_email, title, body, file_id, recipient_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      announcementId,
      userId,
      owner.email,
      preview.title,
      preview.body,
      preview.file_id,
      recipients.length,
      now,
    );
    const consumed = run(
      `UPDATE admin_announcement_previews
       SET used_at = ?, announcement_id = ?
       WHERE id = ? AND owner_user_id = ? AND used_at IS NULL AND expires_at > ?`,
      now,
      announcementId,
      previewId,
      userId,
      now,
    );
    if (Number(consumed.changes) !== 1) {
      throw new HttpError(409, 'CONFLICT', 'This preview was already used. Review the announcement again.');
    }

    for (const recipientId of recipients) {
      const notificationId = newId();
      run(
        `INSERT INTO notifications
         (id, user_id, type, title, body, file_id, conversation_id, actor_id, created_at)
         VALUES (?, ?, 'announcement', ?, ?, ?, NULL, ?, ?)`,
        notificationId,
        recipientId,
        preview.title,
        preview.body,
        preview.file_id,
        userId,
        now,
      );
      notified.push({ userId: recipientId, notificationId });
    }

    return {
      record: {
        id: announcementId,
        title: preview.title,
        body: preview.body,
        file: fileMeta(preview.file_id, userId),
        recipientCount: recipients.length,
        senderEmail: owner.email,
        createdAt: now,
      },
      wasAlreadySent: false,
    };
  });

  if (!result.wasAlreadySent) {
    // The durable rows and audit record are committed before notifying connected clients.
    for (const item of notified) {
      const row = one<NotificationRow>('SELECT * FROM notifications WHERE id = ?', item.notificationId);
      if (row) {
        hub.emit(item.userId, 'notification:new', {
          notification: toNotification(row, item.userId),
          unread: unreadNotificationCount(item.userId),
        });
      }
    }
  }
  return result.record;
}

export function listAdminAnnouncements(userId: string): AdminAnnouncementRecord[] {
  requireOwner(userId);
  return all<AnnouncementRow>(
    'SELECT * FROM admin_announcements ORDER BY created_at DESC LIMIT 25',
  ).map((row) => toRecord(row, userId));
}
