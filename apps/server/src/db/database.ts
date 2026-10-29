import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from '../config.ts';
import { SCHEMA_SQL } from './schema.ts';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(SCHEMA_SQL);
for (const migration of [
  'ALTER TABLE statuses ADD COLUMN music_track_id TEXT NULL',
  'ALTER TABLE statuses ADD COLUMN music_file_id TEXT NULL',
  'ALTER TABLE bots ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE notifications ADD COLUMN file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL',
  'ALTER TABLE admin_announcements ADD COLUMN file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL',
  'ALTER TABLE admin_announcement_previews ADD COLUMN file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL',
]) {
  try { db.exec(migration); } catch { /* Column already exists. */ }
}

type Params = SQLInputValue[];

export function one<T>(sql: string, ...params: Params): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T>(sql: string, ...params: Params): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: Params) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* Row types */
export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  display_name: string;
  bio: string;
  avatar_file_id: string | null;
  last_seen_at: string | null;
  created_at: string;
}
export interface PrivacyRow {
  user_id: string;
  last_seen: 'everyone' | 'contacts' | 'nobody';
  profile_photo: 'everyone' | 'contacts' | 'nobody';
  read_receipts: number;
  who_can_message: 'everyone' | 'contacts';
  discoverable: number;
}
export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_id: string;
  kind: 'text' | 'image' | 'file' | 'system';
  body: string;
  file_id: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}
export interface FileRow {
  id: string;
  owner_id: string;
  conversation_id: string | null;
  storage_name: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
}
export interface ConversationRow {
  id: string;
  kind: string;
  direct_key: string;
  last_message_id: string | null;
  updated_at: string;
  created_at: string;
}
