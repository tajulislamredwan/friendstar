import { hooks } from './hooks.ts';
import { botKindOf } from './identity.ts';
import bcrypt from 'bcryptjs';
import type { RegisterInput } from '@friendstar/shared';
import { config } from '../config.ts';
import { one, run, tx, type UserRow } from '../db/database.ts';
import { HttpError, newId, nowIso, randomToken, sha256, unauthorized } from '../lib/util.ts';
import { createSystemNotification } from './notifications.ts';

interface RefreshRow {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: string;
  revoked_at: string | null;
}

// A real hash so failed lookups take the same time as wrong passwords (no user enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('friendstar-timing-guard', 10);

export async function registerUser(input: RegisterInput): Promise<UserRow> {
  const taken = one<{ username: string; email: string }>(
    'SELECT username, email FROM users WHERE username = ? OR email = ?',
    input.username,
    input.email,
  );
  if (taken) {
    const fields: Record<string, string> = {};
    if (taken.username.toLowerCase() === input.username) fields.username = 'That username is taken';
    if (taken.email.toLowerCase() === input.email) fields.email = 'That email is already registered';
    throw new HttpError(409, 'CONFLICT', 'Account already exists', fields);
  }
  const hash = await bcrypt.hash(input.password, config.bcryptCost);
  const id = newId();
  tx(() => {
    run(
      `INSERT INTO users (id, username, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.username,
      input.email,
      hash,
      input.displayName,
      nowIso(),
    );
    run('INSERT INTO privacy_settings (user_id) VALUES (?)', id);
  });
  createSystemNotification(id, 'Welcome to FriendStar ✦', 'Find a friend with Search and say hello.');
  const created = one<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
  hooks.emitRegister(created);
  return created;
}

export async function verifyLogin(login: string, password: string): Promise<UserRow> {
  const user = one<UserRow>('SELECT * FROM users WHERE username = ? OR email = ?', login.toLowerCase(), login.toLowerCase());
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || botKindOf(user.id)) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid username or password');
  return user;
}

export function issueRefreshToken(userId: string, userAgent: string, familyId = newId()): string {
  const token = randomToken();
  run(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    userId,
    sha256(token),
    familyId,
    new Date(Date.now() + config.refreshTokenTtlMs).toISOString(),
    userAgent.slice(0, 200),
    nowIso(),
  );
  return token;
}

/**
 * Rotate a refresh token. Reusing an already-rotated token revokes the whole family
 * (likely theft) — except within a short grace window, which covers two tabs refreshing at once.
 */
export function rotateRefreshToken(token: string | undefined, userAgent: string): { userId: string; token: string } {
  if (!token) throw unauthorized();
  const row = one<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ?', sha256(token));
  if (!row) throw unauthorized();
  if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('Session expired');
  if (row.revoked_at) {
    const sinceRevoked = Date.now() - new Date(row.revoked_at).getTime();
    // Grace only applies to a token that was just rotated (its family still has a live token),
    // never to a token that was revoked by logout.
    const familyAlive = !!one('SELECT 1 FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NULL', row.family_id);
    if (!familyAlive || sinceRevoked > config.refreshReuseGraceMs) {
      revokeFamily(row.family_id);
      throw unauthorized('Session ended for your security. Please sign in again.');
    }
  } else {
    run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', nowIso(), row.id);
  }
  return { userId: row.user_id, token: issueRefreshToken(row.user_id, userAgent, row.family_id) };
}

export function revokeFamily(familyId: string) {
  run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?', nowIso(), familyId);
}

export function revokeByToken(token: string | undefined) {
  if (!token) return;
  const row = one<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ?', sha256(token));
  if (row) revokeFamily(row.family_id);
}
