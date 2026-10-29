import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import type { ErrorCode } from '@friendstar/shared';
import { config } from '../config.ts';

export const newId = () => nanoid(21);
export const nowIso = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}
export const notFound = (what = 'Not found') => new HttpError(404, 'NOT_FOUND', what);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, 'FORBIDDEN', msg);
export const unauthorized = (msg = 'Please sign in') => new HttpError(401, 'UNAUTHORIZED', msg);

/* ---------- Access tokens ---------- */
export function signAccessToken(userId: string): string {
  return jwt.sign({ typ: 'access' }, config.jwtSecret, {
    subject: userId,
    expiresIn: config.accessTokenTtlSec,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): string {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') throw new Error('bad token');
    return payload.sub;
  } catch {
    throw unauthorized('Session expired');
  }
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

/* ---------- Signed file URLs ----------
 * <img> tags cannot send Authorization headers, so the server hands out short-lived
 * HMAC-signed URLs bound to the viewer, only after its own permission checks pass. */
const FILE_URL_TTL_SEC = 6 * 60 * 60;

export function signFileUrl(fileId: string, viewerId: string): string {
  // Round expiry up to the hour so URLs stay stable (cache-friendly) within the window.
  const exp = Math.ceil((Date.now() / 1000 + FILE_URL_TTL_SEC) / 3600) * 3600;
  const sig = hmac(`${fileId}.${viewerId}.${exp}`);
  return `/api/files/${fileId}?u=${encodeURIComponent(viewerId)}&exp=${exp}&sig=${sig}`;
}

export function verifyFileSignature(fileId: string, viewerId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = hmac(`${fileId}.${viewerId}.${exp}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hmac(value: string) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`file:${value}`).digest('base64url');
}

/** Escape LIKE wildcards so user search terms are matched literally. */
export const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);
