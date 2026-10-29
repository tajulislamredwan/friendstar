import type { IceServer } from '@friendstar/shared';

/**
 * Optional TURN relay via Cloudflare Realtime TURN. Without it, calls use public STUN only,
 * which connects most home / mobile networks but can fail behind strict NATs or firewalls.
 * Enable by setting the Worker secrets TURN_KEY_ID and TURN_KEY_API_TOKEN.
 */
let turnEnv: { keyId?: string; token?: string } = {};
export function configureTurn(env: { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string }) {
  turnEnv = { keyId: env.TURN_KEY_ID, token: env.TURN_KEY_API_TOKEN };
}

const cache = new Map<string, { servers: IceServer[]; until: number }>();
const TTL_S = 6 * 60 * 60;

export async function iceServersFor(userId: string, fallback: IceServer[]): Promise<IceServer[]> {
  if (!turnEnv.keyId || !turnEnv.token) return fallback;
  const hit = cache.get(userId);
  if (hit && hit.until > Date.now()) return hit.servers;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${turnEnv.keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${turnEnv.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_S }),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { iceServers?: IceServer | IceServer[] };
    const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
    const servers = [...fallback, ...list];
    cache.set(userId, { servers, until: Date.now() + (TTL_S - 600) * 1000 });
    return servers;
  } catch {
    return fallback;
  }
}
