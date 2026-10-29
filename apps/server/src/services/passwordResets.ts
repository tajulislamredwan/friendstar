import bcrypt from 'bcryptjs';
import type { AdminPasswordResetRequest } from '@friendstar/shared';
import { config } from '../config.ts';
import { all, one, run, tx } from '../db/database.ts';
import { HttpError, newId, nowIso, randomToken, sha256 } from '../lib/util.ts';
import { botKindOf } from './identity.ts';
import { requireOwner } from './admin.ts';

const RESET_TTL_MS = 15 * 60 * 1000;
const REQUEST_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const GENERIC_RESET_MESSAGE = 'If those details match an account, a reset request is available for owner review. No email was sent.';

interface ResetRequestRow {
  id: string;
  identifier: string;
  user_id: string | null;
  status: AdminPasswordResetRequest['status'];
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

interface ResetTokenRow {
  id: string;
  request_id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

/** Persist a privacy-preserving, owner-reviewable audit record. The public result is identical for matches and non-matches. */
export function createPasswordResetRequest(identifier: string): { message: string } {
  const normalized = identifier.trim().toLowerCase();
  const account = one<{ id: string }>(
    `SELECT u.id FROM users u
     WHERE (u.username = ? OR u.email = ?)
       AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = u.id)
     LIMIT 1`,
    normalized,
    normalized,
  );
  const id = newId();
  const createdAt = nowIso();
  run(
    `INSERT INTO password_reset_requests (id, identifier, user_id, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
    id,
    normalized,
    account?.id ?? null,
    createdAt,
  );
  run('DELETE FROM password_reset_requests WHERE created_at < ?', new Date(Date.now() - REQUEST_RETENTION_MS).toISOString());
  return { message: GENERIC_RESET_MESSAGE };
}

/** Owner-only queue. It contains account identity and request details, never password data or reset tokens. */
export function adminPasswordResetRequests(ownerId: string): AdminPasswordResetRequest[] {
  requireOwner(ownerId);
  const rows = all<{
    id: string;
    identifier: string;
    user_id: string | null;
    username: string | null;
    display_name: string | null;
    email: string | null;
    status: AdminPasswordResetRequest['status'];
    created_at: string;
    reviewed_at: string | null;
    expires_at: string | null;
  }>(
    `SELECT r.id, r.identifier, r.user_id, u.username, u.display_name, u.email,
            r.status, r.created_at, r.reviewed_at,
            (SELECT t.expires_at FROM password_reset_tokens t WHERE t.request_id = r.id ORDER BY t.created_at DESC LIMIT 1) AS expires_at
     FROM password_reset_requests r
     LEFT JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at DESC
     LIMIT 500`,
  );
  return rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    requestedAt: row.created_at,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
  }));
}

/** Issue a short-lived token only after the owner explicitly confirms out-of-band verification. */
export function issueAdminPasswordReset(ownerId: string, requestId: string, verified: boolean): { token: string; expiresAt: string } {
  requireOwner(ownerId);
  if (!verified) throw new HttpError(400, 'VALIDATION', 'Verify the requester before issuing a reset link.');

  const request = one<ResetRequestRow>('SELECT * FROM password_reset_requests WHERE id = ?', requestId);
  if (!request || !request.user_id || !['pending', 'issued'].includes(request.status)) {
    throw new HttpError(404, 'NOT_FOUND', 'Reset request is not available.');
  }
  const user = one<{ id: string }>('SELECT id FROM users WHERE id = ?', request.user_id);
  if (!user || botKindOf(user.id)) throw new HttpError(404, 'NOT_FOUND', 'Reset request is not available.');

  const token = randomToken();
  const tokenId = newId();
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
  tx(() => {
    const fresh = one<ResetRequestRow>('SELECT * FROM password_reset_requests WHERE id = ?', requestId);
    if (!fresh || fresh.user_id !== user.id || !['pending', 'issued'].includes(fresh.status)) {
      throw new HttpError(404, 'NOT_FOUND', 'Reset request is not available.');
    }
    run(
      `UPDATE password_reset_tokens SET revoked_at = COALESCE(revoked_at, ?)
       WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      issuedAt,
      user.id,
    );
    run(
      `UPDATE password_reset_requests SET status = 'superseded'
       WHERE user_id = ? AND id != ? AND status = 'issued'`,
      user.id,
      requestId,
    );
    run(
      `INSERT INTO password_reset_tokens (id, request_id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenId,
      requestId,
      user.id,
      sha256(token),
      expiresAt,
      issuedAt,
    );
    run(
      `UPDATE password_reset_requests SET status = 'issued', reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
      issuedAt,
      ownerId,
      requestId,
    );
  });
  return { token, expiresAt };
}

function invalidLink(): never {
  throw new HttpError(400, 'VALIDATION', 'This reset link is invalid or expired. Request a new one.');
}

/** Set a new password once; only the token digest is stored. Existing refresh sessions are revoked. */
export async function completePasswordReset(token: string, password: string): Promise<void> {
  const tokenHash = sha256(token);
  const row = one<ResetTokenRow>('SELECT * FROM password_reset_tokens WHERE token_hash = ?', tokenHash);
  if (!row || row.used_at || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) invalidLink();

  const passwordHash = await bcrypt.hash(password, config.bcryptCost);
  const completedAt = nowIso();
  tx(() => {
    const current = one<ResetTokenRow>('SELECT * FROM password_reset_tokens WHERE token_hash = ?', tokenHash);
    if (!current || current.used_at || current.revoked_at || Date.parse(current.expires_at) <= Date.now()) invalidLink();
    run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, current.user_id);
    run('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL', completedAt, current.user_id);
    run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', completedAt, current.user_id);
    run(
      `UPDATE password_reset_requests SET status = 'completed'
       WHERE user_id = ? AND status IN ('pending', 'issued')`,
      current.user_id,
    );
  });
}
