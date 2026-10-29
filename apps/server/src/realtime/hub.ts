import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@friendstar/shared';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
let io: IO | null = null;
const socketCounts = new Map<string, number>();

export const hub = {
  attach(server: IO) {
    io = server;
  },
  emit<E extends keyof ServerToClientEvents>(
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ) {
    // Socket.IO's typed emit needs the tuple spread; the cast keeps the generic simple.
    (io?.to(`user:${userId}`).emit as (e: string, ...a: unknown[]) => void)?.(event, ...args);
  },
  /** Returns true if this was the user's first live socket. */
  connected(userId: string): boolean {
    const n = (socketCounts.get(userId) ?? 0) + 1;
    socketCounts.set(userId, n);
    return n === 1;
  },
  /** Returns true if this was the user's last live socket. */
  disconnected(userId: string): boolean {
    const n = (socketCounts.get(userId) ?? 1) - 1;
    if (n <= 0) socketCounts.delete(userId);
    else socketCounts.set(userId, n);
    return n <= 0;
  },
  isOnline(userId: string) {
    return (socketCounts.get(userId) ?? 0) > 0;
  },
};
