import { one, run } from '../db/database.ts';
import { nowIso } from '../lib/util.ts';

export const DEFAULT_OFFLINE_REPLY = 'I am away right now. I will reply when I am back.';

interface OfflineReplyRow {
  enabled: number;
  message: string;
}

export interface OfflineReplySettings {
  enabled: boolean;
  message: string;
}

export function getOfflineReplySettings(userId: string): OfflineReplySettings {
  const row = one<OfflineReplyRow>('SELECT enabled, message FROM offline_reply_settings WHERE user_id = ?', userId);
  return row ? { enabled: row.enabled === 1, message: row.message } : { enabled: false, message: DEFAULT_OFFLINE_REPLY };
}

export function updateOfflineReplySettings(userId: string, patch: Partial<OfflineReplySettings>): OfflineReplySettings {
  const current = getOfflineReplySettings(userId);
  const next = {
    enabled: patch.enabled ?? current.enabled,
    message: patch.message?.trim() ?? current.message,
  };
  run(
    `INSERT INTO offline_reply_settings (user_id, enabled, message) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, message = excluded.message`,
    userId,
    next.enabled ? 1 : 0,
    next.message,
  );
  return next;
}

/** Claim one reply per recipient/contact per UTC day. */
export function claimOfflineReply(recipientId: string, senderId: string, day: string, messageId: string): boolean {
  run('DELETE FROM offline_reply_log WHERE day < ?', day);
  return run(
    'INSERT OR IGNORE INTO offline_reply_log (recipient_id, sender_id, day, message_id, created_at) VALUES (?, ?, ?, ?, ?)',
    recipientId,
    senderId,
    day,
    messageId,
    nowIso(),
  ).changes > 0;
}
