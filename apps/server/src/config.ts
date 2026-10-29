import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

const isProd = process.env.NODE_ENV === 'production';
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(serverRoot, 'data'));
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? path.join(serverRoot, 'uploads'));
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

/** Use JWT_SECRET from the environment; in development persist a generated one (mode 600). */
function loadSecret(): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  if (isProd && process.env.REQUIRE_JWT_SECRET === '1') {
    throw new Error('JWT_SECRET (>= 32 chars) is required in production');
  }
  const file = path.join(dataDir, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  dbFile: process.env.DB_FILE ?? path.join(dataDir, 'friendstar.db'),
  uploadDir,
  webDist: path.resolve(serverRoot, '../web/dist'),
  jwtSecret: loadSecret(),
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  refreshReuseGraceMs: 60_000,
  bcryptCost: 12,
  authRateLimitPerMin: Number(process.env.AUTH_RATE_LIMIT ?? 20),
  apiRateLimitPerMin: Number(process.env.API_RATE_LIMIT ?? 300),
  /** Comma-separated emails of owner accounts (admin area). Local default: the alice demo account. */
  ownerEmails: (process.env.OWNER_EMAILS ?? 'alice@friendstar.dev')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  /** Optional OpenAI-compatible endpoint for the AI bot in the Node build. */
  aiApiBase: process.env.OPENAI_API_BASE ?? process.env.OPENAI_BASE_URL ?? '',
  aiApiKey: process.env.OPENAI_API_KEY ?? '',
  aiModel: process.env.AI_MODEL ?? 'gpt-4.1-mini',
};
