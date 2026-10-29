import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@friendstar/shared';
import { config } from '../config.ts';
import { verifyAccessToken } from '../lib/util.ts';
import { markDelivered } from '../services/chat.ts';
import { handleClientEvent, handleUserOffline, SOCKET_EVENT_BUDGET } from '../services/events.ts';
import { broadcastPresence, getUserRow, touchLastSeen } from '../services/users.ts';
import { hub } from './hub.ts';

export function attachRealtime(server: HttpServer) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: config.isProd ? undefined : { origin: config.webOrigin, credentials: true },
    maxHttpBufferSize: 64 * 1024,
  });
  hub.attach(io);

  io.use((socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const userId = verifyAccessToken(token);
      if (!getUserRow(userId)) throw new Error('unknown user');
      socket.data.userId = userId;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);
    const first = hub.connected(userId);
    touchLastSeen(userId);
    if (first) broadcastPresence(userId);
    // Anything sent while this user was offline is now delivered.
    markDelivered(userId);

    // Simple token bucket per socket; every client event goes through the shared dispatcher.
    let tokens = SOCKET_EVENT_BUDGET;
    const refill = setInterval(() => (tokens = SOCKET_EVENT_BUDGET), 10_000);
    socket.onAny((event: string, payload: unknown) => {
      if (tokens-- <= 0) return;
      handleClientEvent(userId, event, payload);
    });
    socket.on('disconnect', () => {
      clearInterval(refill);
      touchLastSeen(userId);
      if (hub.disconnected(userId)) {
        broadcastPresence(userId);
        handleUserOffline(userId);
      }
    });
  });

  return io;
}
