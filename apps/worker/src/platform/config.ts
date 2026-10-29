/** Runtime config for the Cloudflare build. jwtSecret is loaded from Durable Object storage at startup. */
export const config = {
  isProd: true,
  jwtSecret: '',
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  refreshReuseGraceMs: 10_000,
  bcryptCost: 11,
  authRateLimitPerMin: 20,
  apiRateLimitPerMin: 300,
  /** Filled from the OWNER_EMAILS Worker variable at startup. */
  ownerEmails: [] as string[],
  aiApiBase: '',
  aiApiKey: '',
  aiModel: '',
};
