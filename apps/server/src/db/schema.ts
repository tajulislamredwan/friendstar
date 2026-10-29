/** SQL schema shared by the Node server and the Cloudflare Durable Object. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NULL,
  storage_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL,
  last_seen_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS privacy_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen TEXT NOT NULL DEFAULT 'everyone',
  profile_photo TEXT NOT NULL DEFAULT 'everyone',
  read_receipts INTEGER NOT NULL DEFAULT 1,
  who_can_message TEXT NOT NULL DEFAULT 'everyone',
  discoverable INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refresh_family ON refresh_tokens(family_id);
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  reviewed_at TEXT NULL,
  reviewed_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS password_reset_requests_created ON password_reset_requests(created_at);
CREATE INDEX IF NOT EXISTS password_reset_requests_user ON password_reset_requests(user_id, status);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES password_reset_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  revoked_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user ON password_reset_tokens(user_id, expires_at);
CREATE INDEX IF NOT EXISTS password_reset_tokens_request ON password_reset_tokens(request_id, created_at);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'direct',
  direct_key TEXT UNIQUE NOT NULL,
  last_message_id TEXT NULL,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON conversation_members(user_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  file_id TEXT NULL REFERENCES files(id),
  created_at TEXT NOT NULL,
  delivered_at TEXT NULL,
  read_at TEXT NULL,
  UNIQUE (sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS messages_conv_created ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL,
  conversation_id TEXT NULL,
  actor_id TEXT NULL,
  read_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user_created ON notifications(user_id, created_at);
CREATE TABLE IF NOT EXISTS offline_reply_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT 'I am away right now. I will reply when I am back.'
);
CREATE TABLE IF NOT EXISTS offline_reply_log (
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipient_id, sender_id, day)
);
CREATE TABLE IF NOT EXISTS group_info (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  avatar_file_id TEXT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_admins (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_receipts (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TEXT NULL,
  read_at TEXT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_receipts_user ON group_receipts(user_id, delivered_at);
CREATE TABLE IF NOT EXISTS statuses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  bg TEXT NOT NULL DEFAULT 'violet',
  music_track_id TEXT NULL,
  music_file_id TEXT NULL,
  file_id TEXT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS statuses_user ON statuses(user_id, expires_at);
CREATE TABLE IF NOT EXISTS status_views (
  status_id TEXT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (status_id, viewer_id)
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  callee_id TEXT NOT NULL,
  media TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT NULL,
  ended_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS calls_caller ON calls(caller_id, created_at);
CREATE INDEX IF NOT EXISTS calls_callee ON calls(callee_id, created_at);

-- Phase 3: public IDs, login history, bots, group calls, AI usage caps
CREATE TABLE IF NOT EXISTS friend_ids (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS login_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  login_tried TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_events_at ON login_events(at);
CREATE INDEX IF NOT EXISTS login_events_user ON login_events(user_id, at);
CREATE TABLE IF NOT EXISTS bots (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS group_calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  started_by TEXT NOT NULL,
  media TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS group_calls_conv ON group_calls(conversation_id, status);
CREATE TABLE IF NOT EXISTS call_participants (
  call_id TEXT NOT NULL REFERENCES group_calls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT NULL,
  PRIMARY KEY (call_id, user_id)
);
CREATE INDEX IF NOT EXISTS call_participants_user ON call_participants(user_id, left_at);
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);
CREATE TABLE IF NOT EXISTS ai_image_usage (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

CREATE TABLE IF NOT EXISTS admin_announcements (
  id TEXT PRIMARY KEY,
  sender_user_id TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL,
  recipient_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_announcements_created ON admin_announcements(created_at);
CREATE TABLE IF NOT EXISTS admin_announcement_previews (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL,
  recipient_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  announcement_id TEXT NULL REFERENCES admin_announcements(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS admin_announcement_previews_owner ON admin_announcement_previews(owner_user_id, expires_at);
`;
