import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@friendstar/shared';
import type { ConnectionState } from './backend.ts';

export type ServerEvent = keyof ServerToClientEvents;
export type ClientEvent = keyof ClientToServerEvents;

export interface RealtimeHandlers {
  onEvent: (event: ServerEvent, payload: unknown) => void;
  onState: (state: ConnectionState) => void;
  /** Called when the server rejects the token; return a fresh one (or null to give up). */
  onUnauthorized: () => Promise<string | null>;
}

/** The app talks to the realtime layer only through this interface. */
export interface RealtimeTransport {
  connect(token: string): void;
  disconnect(): void;
  emit<E extends ClientEvent>(event: E, payload: Parameters<ClientToServerEvents[E]>[0]): void;
}

export const SERVER_EVENTS: ServerEvent[] = [
  'conversation:removed',
  'status:new',
  'call:update',
  'call:signal',
  'gcall:update',
  'gcall:signal',
  'message:new',
  'message:status',
  'conversation:updated',
  'presence',
  'typing',
  'recording',
  'notification:new',
];

/* ---------- Socket.IO (Node server) ---------- */

export class SocketIoTransport implements RealtimeTransport {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private token = '';
  constructor(private h: RealtimeHandlers) {}

  connect(token: string) {
    this.token = token;
    if (this.socket) {
      this.socket.auth = { token };
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    this.h.onState('connecting');
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      auth: { token },
      transports: ['websocket', 'polling'],
    });
    socket.on('connect', () => this.h.onState('online'));
    socket.on('disconnect', () => this.h.onState('offline'));
    socket.on('connect_error', async (err) => {
      this.h.onState('offline');
      if (err.message === 'UNAUTHORIZED') {
        const fresh = await this.h.onUnauthorized();
        if (fresh) {
          this.token = fresh;
          socket.auth = { token: fresh };
          socket.connect();
        }
      }
    });
    socket.io.on('reconnect_attempt', () => {
      socket.auth = { token: this.token };
      this.h.onState('connecting');
    });
    for (const ev of SERVER_EVENTS) {
      socket.on(ev as 'presence', (payload: unknown) => this.h.onEvent(ev, payload));
    }
    this.socket = socket;
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
    this.h.onState('offline');
  }

  emit<E extends ClientEvent>(event: E, payload: Parameters<ClientToServerEvents[E]>[0]) {
    (this.socket?.emit as ((e: string, p: unknown) => void) | undefined)?.call(this.socket, event, payload);
  }
}

/* ---------- Native WebSocket (Cloudflare Durable Object) ----------
 * Frames are JSON: { event, data }. The access token travels as the second
 * WebSocket subprotocol so it never appears in URLs or access logs. */

const WS_PROTOCOL = 'friendstar.v1';
/** Close code the server uses for an invalid or expired token. */
const CLOSE_UNAUTHORIZED = 4401;

export class NativeWsTransport implements RealtimeTransport {
  private ws: WebSocket | null = null;
  private token = '';
  private wanted = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private h: RealtimeHandlers) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.wanted && !this.ws && this.open());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.wanted && !this.ws) this.open();
      });
    }
  }

  connect(token: string) {
    const changed = token !== this.token;
    this.token = token;
    this.wanted = true;
    if (this.ws && !changed) return;
    // New token: reopen so the server sees the fresh credentials.
    this.close();
    this.open();
  }

  disconnect() {
    this.wanted = false;
    this.close();
    this.h.onState('offline');
  }

  emit<E extends ClientEvent>(event: E, payload: Parameters<ClientToServerEvents[E]>[0]) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event, data: payload }));
  }

  private close() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        /* ignore */
      }
    }
  }

  private open() {
    if (!this.token) return;
    this.h.onState('connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
    const ws = new WebSocket(url, [WS_PROTOCOL, this.token]);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.h.onState('online');
      // Keep NATs and proxies from dropping an idle socket; the server auto-replies without waking up.
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30_000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return;
      try {
        const msg = JSON.parse(e.data) as { event: ServerEvent; data: unknown };
        if (SERVER_EVENTS.includes(msg.event)) this.h.onEvent(msg.event, msg.data);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = async (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.h.onState('offline');
      if (!this.wanted) return;
      if (e.code === CLOSE_UNAUTHORIZED) {
        const fresh = await this.h.onUnauthorized();
        if (!fresh) return;
        this.token = fresh;
      }
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() / 2);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }
}

export function createTransport(h: RealtimeHandlers): RealtimeTransport {
  return import.meta.env.VITE_REALTIME === 'ws' ? new NativeWsTransport(h) : new SocketIoTransport(h);
}
