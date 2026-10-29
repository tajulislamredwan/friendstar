/**
 * Durable Object SQLite adapter exposing the same one/all/run/tx helpers as the Node
 * server's node:sqlite module, so the shared services run unchanged.
 */
import { SCHEMA_SQL } from '../../../server/src/db/schema.ts';
export type {
  ConversationRow,
  FileRow,
  MessageRow,
  PrivacyRow,
  UserRow,
} from '../../../server/src/db/database.ts';

type SqlValue = string | number | null | ArrayBuffer;
let sql: SqlStorage | null = null;
let storage: DurableObjectStorage | null = null;

const EXTRA_SCHEMA = `
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function attachDatabase(s: DurableObjectStorage) {
  storage = s;
  sql = s.sql;
  sql.exec(SCHEMA_SQL);
  for (const migration of [
    'ALTER TABLE statuses ADD COLUMN music_track_id TEXT NULL',
    'ALTER TABLE statuses ADD COLUMN music_file_id TEXT NULL',
    'ALTER TABLE bots ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE notifications ADD COLUMN file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL',
    'ALTER TABLE admin_announcements ADD COLUMN file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL',
    'ALTER TABLE admin_announcement_previews ADD COLUMN file_id TEXT NULL REFERENCES files(id) ON DELETE SET NULL',
  ]) {
    try { sql.exec(migration); } catch { /* Column already exists. */ }
  }
  sql.exec(EXTRA_SCHEMA);
}

function db(): SqlStorage {
  if (!sql) throw new Error('database not attached');
  return sql;
}

const clean = (params: unknown[]) => params.map((p) => (p === undefined ? null : (p as SqlValue)));

export function one<T>(query: string, ...params: unknown[]): T | undefined {
  return db().exec(query, ...clean(params)).toArray()[0] as T | undefined;
}
export function all<T>(query: string, ...params: unknown[]): T[] {
  return db().exec(query, ...clean(params)).toArray() as T[];
}
export function run(query: string, ...params: unknown[]) {
  const cursor = db().exec(query, ...clean(params));
  cursor.toArray();
  return { changes: cursor.rowsWritten };
}
export function tx<T>(fn: () => T): T {
  if (!storage) throw new Error('database not attached');
  return storage.transactionSync(fn);
}
