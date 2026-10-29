/**
 * Realtime hub backed by Durable Object hibernatable WebSockets. Each socket is tagged
 * with its user id, so emits and presence survive the object hibernating between events.
 */
import type { ServerToClientEvents } from '@friendstar/shared';

let ctx: DurableObjectState | null = null;
/** Sockets currently closing; excluded from presence while their close handler runs. */
const closing = new Set<WebSocket>();

export const userTag = (userId: string) => `u:${userId}`;

export function liveSockets(userId: string): WebSocket[] {
  if (!ctx) return [];
  return ctx.getWebSockets(userTag(userId)).filter((ws) => !closing.has(ws) && ws.deserializeAttachment() != null);
}

export const hub = {
  attach(state: DurableObjectState) {
    ctx = state;
  },
  emit<E extends keyof ServerToClientEvents>(userId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>) {
    const frame = JSON.stringify({ event, data: args[0] });
    for (const ws of liveSockets(userId)) {
      try {
        ws.send(frame);
      } catch {
        /* socket already gone */
      }
    }
  },
  isOnline(userId: string) {
    return liveSockets(userId).length > 0;
  },
  markClosing(ws: WebSocket) {
    closing.add(ws);
  },
  doneClosing(ws: WebSocket) {
    closing.delete(ws);
  },
};
