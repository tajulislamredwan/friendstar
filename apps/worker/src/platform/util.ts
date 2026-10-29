/** Same API as apps/server/src/lib/util.ts, implemented with Workers-compatible crypto. */
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { nanoid } from 'nanoid';
import type { ErrorCode } from '@friendstar/shared';
import { config } from './config.ts';

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

/* ---------- Access tokens (HS256 JWT) ---------- */
const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');
const JWT_HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function signAccessToken(userId: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ typ: 'access', sub: userId, iat, exp: iat + config.accessTokenTtlSec }));
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${JWT_HEADER}.${payload}`).digest('base64url');
  return `${JWT_HEADER}.${payload}.${sig}`;
}

export function verifyAccessToken(token: string): string {
  try {
    const [header, payload, sig] = token.split('.');
    if (!header || !payload || !sig || header !== JWT_HEADER) throw new Error('bad token');
    const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
    if (!safeEqual(expected, sig)) throw new Error('bad signature');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      typ?: string;
      sub?: unknown;
      exp?: number;
    };
    if (claims.typ !== 'access' || typeof claims.sub !== 'string') throw new Error('bad claims');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('expired');
    return claims.sub;
  } catch {
    throw unauthorized('Session expired');
  }
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const randomSecret = () => crypto.randomBytes(48).toString('base64url');

/* ---------- Signed file URLs ---------- */
const FILE_URL_TTL_SEC = 6 * 60 * 60;

export function signFileUrl(fileId: string, viewerId: string): string {
  const exp = Math.ceil((Date.now() / 1000 + FILE_URL_TTL_SEC) / 3600) * 3600;
  const sig = hmac(`${fileId}.${viewerId}.${exp}`);
  return `/api/files/${fileId}?u=${encodeURIComponent(viewerId)}&exp=${exp}&sig=${sig}`;
}

export function verifyFileSignature(fileId: string, viewerId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(hmac(`${fileId}.${viewerId}.${exp}`), sig);
}

function hmac(value: string) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`file:${value}`).digest('base64url');
}

export const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);
