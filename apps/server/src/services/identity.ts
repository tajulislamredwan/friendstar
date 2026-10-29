import type { BotKind } from '@friendstar/shared';
import { one, run } from '../db/database.ts';
import { config } from '../config.ts';

/** Unambiguous alphabet: no 0/O, 1/I/L. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  // Always include a digit so IDs never look like ordinary words.
  if (!/\d/.test(out)) out = `${ALPHABET[bytes[0]! % 8]}${out.slice(1)}`;
  return `FS-${out}`;
}

/** Returns the user's public FriendStar ID, creating it the first time (also backfills older accounts). */
export function getFriendId(userId: string): string {
  const row = one<{ code: string }>('SELECT code FROM friend_ids WHERE user_id = ?', userId);
  if (row) return row.code;
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    if (one('SELECT 1 AS x FROM friend_ids WHERE code = ?', code)) continue;
    run('INSERT OR IGNORE INTO friend_ids (user_id, code) VALUES (?, ?)', userId, code);
    const saved = one<{ code: string }>('SELECT code FROM friend_ids WHERE user_id = ?', userId);
    if (saved) return saved.code;
  }
  throw new Error('Could not allocate a FriendStar ID');
}

export function userIdByFriendId(code: string): string | undefined {
  return one<{ user_id: string }>('SELECT user_id FROM friend_ids WHERE code = ?', code)?.user_id;
}

export function botKindOf(userId: string): BotKind | null {
  return (one<{ kind: BotKind }>('SELECT kind FROM bots WHERE user_id = ?', userId)?.kind ?? null) as BotKind | null;
}

export function isBotEnabled(userId: string): boolean {
  return one<{ enabled: number }>('SELECT enabled FROM bots WHERE user_id = ?', userId)?.enabled === 1;
}

export function isOwnerEmail(email: string): boolean {
  return config.ownerEmails.includes(email.toLowerCase());
}
