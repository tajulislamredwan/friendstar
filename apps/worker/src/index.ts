/**
 * FriendStar on Cloudflare.
 * - Static web app: served by Workers Static Assets (SPA fallback), never touches this code.
 * - /api/*: forwarded to a single SQLite-backed Durable Object that owns all data and
 *   all realtime WebSockets, so ordering and presence stay consistent.
 */
import { DurableObject } from 'cloudflare:workers';
import { app } from './routes.ts';
import { configureTurn } from './turn.ts';
import { config } from './platform/config.ts';
import { attachDatabase, one, run } from './platform/database.ts';
import { hub, liveSockets, userTag } from './platform/hub.ts';
import { randomSecret, verifyAccessToken } from './platform/util.ts';
import { markStarted } from './platform/bcrypt.ts';
import { markDelivered } from '../../server/src/services/chat.ts';
import { hooks } from '../../server/src/services/hooks.ts';
import { AI_LIMITS, ensureBots, setAiImageProvider, setAiProvider } from '../../server/src/services/bots.ts';
import { handleClientEvent, handleUserOffline, SOCKET_EVENT_BUDGET } from '../../server/src/services/events.ts';
import { broadcastPresence, getUserRow, touchLastSeen } from '../../server/src/services/users.ts';

export interface Env {
  HUB: DurableObjectNamespace<FriendStarHub>;
  ASSETS: Fetcher;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Comma-separated owner emails (admin area). */
  OWNER_EMAILS?: string;
  /** Workers AI binding (free daily allowance) used by the Star AI bot. */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
}

/** Multilingual (good Bangla) first, smaller fast model as a fallback. */
const AI_MODELS = ['@cf/google/gemma-3-12b-it', '@cf/meta/llama-3.1-8b-instruct-fast'];

const WS_PROTOCOL = 'friendstar.v1';
const CLOSE_UNAUTHORIZED = 4401;

interface SocketMeta {
  userId: string;
  tokens: number;
  refillAt: number;
}

export class FriendStarHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    markStarted();
    attachDatabase(ctx.storage);
    hub.attach(ctx);
    configureTurn(env);
    // Signing secret is generated once and never leaves this object's storage.
    let secret = one<{ value: string }>("SELECT value FROM meta WHERE key = 'jwt_secret'")?.value;
    if (!secret) {
      secret = randomSecret();
      run("INSERT INTO meta (key, value) VALUES ('jwt_secret', ?)", secret);
    }
    config.jwtSecret = secret;
    config.ownerEmails = (env.OWNER_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    // Bot replies finish after the HTTP response; keep the object alive until they do.
    hooks.setBackgroundRunner((task) => ctx.waitUntil(task));
    const ai = env.AI;
    if (ai) {
      // Stay comfortably inside the free daily Workers AI allowance.
      AI_LIMITS.perAppPerDay = 200;
      setAiProvider(async (turns) => {
        let lastErr: unknown;
        for (const model of AI_MODELS) {
          try {
            const out = (await ai.run(model, { messages: turns, max_tokens: 450 })) as { response?: string };
            if (out?.response) return out.response;
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr ?? new Error('Empty AI response');
      });
      setAiImageProvider(async (prompt) => {
        const result = (await ai.run('@cf/black-forest-labs/flux-1-schnell', { prompt, steps: 4 })) as { image?: string };
        if (!result.image) throw new Error('Image model returned no image');
        return result.image;
      });
    }
    ensureBots();
    // Keep-alive pings are answered without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/ws') return this.acceptSocket(request);
    return app.fetch(request);
  }

  private acceptSocket(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      return new Response('Forbidden origin', { status: 403 });
    }
    const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim());
    if (protocols[0] !== WS_PROTOCOL) return new Response('Unsupported protocol', { status: 400 });

    let userId: string | null = null;
    try {
      userId = verifyAccessToken(protocols[1] ?? '');
      if (!getUserRow(userId)) userId = null;
    } catch {
      userId = null;
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const headers = { 'Sec-WebSocket-Protocol': WS_PROTOCOL };

    if (!userId) {
      // Accept-then-close so the browser sees a meaningful close code and refreshes its token.
      server.accept();
      server.addEventListener('error', () => {});
      server.close(CLOSE_UNAUTHORIZED, 'UNAUTHORIZED');
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    const first = liveSockets(userId).length === 0;
    this.ctx.acceptWebSocket(server, [userTag(userId)]);
    server.serializeAttachment({ userId, tokens: SOCKET_EVENT_BUDGET, refillAt: Date.now() + 10_000 } satisfies SocketMeta);
    touchLastSeen(userId);
    if (first) broadcastPresence(userId);
    // Anything sent while this user was offline is now delivered.
    markDelivered(userId);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta || typeof raw !== 'string' || raw.length > 64 * 1024) return;
    // Token bucket per socket.
    const now = Date.now();
    if (now >= meta.refillAt) {
      meta.tokens = SOCKET_EVENT_BUDGET;
      meta.refillAt = now + 10_000;
    }
    if (meta.tokens <= 0) return;
    meta.tokens--;
    ws.serializeAttachment(meta);

    let msg: { event?: unknown; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    handleClientEvent(meta.userId, msg.event, msg.data);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.release(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket) {
    this.release(ws);
  }

  private release(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    hub.markClosing(ws);
    ws.serializeAttachment(null);
    try {
      touchLastSeen(meta.userId);
      if (liveSockets(meta.userId).length === 0) {
        broadcastPresence(meta.userId);
        handleUserOffline(meta.userId);
      }
    } finally {
      hub.doneClosing(ws);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.HUB.get(env.HUB.idFromName('friendstar-main'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
