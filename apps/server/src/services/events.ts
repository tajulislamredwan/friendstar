import { markDelivered, relayRecording, relayTyping } from './chat.ts';
import { acceptCall, callsUserOffline, declineCall, endCall, relaySignal, startCall } from './calls.ts';
import { groupCallsUserOffline, joinGroupCall, leaveGroupCall, relayGroupSignal, startGroupCall } from './groupCalls.ts';

/**
 * Handles every client → server realtime event. Shared by the Node (Socket.IO) server and
 * the Cloudflare Durable Object (native WebSocket), so both behave identically.
 */
export function handleClientEvent(userId: string, event: unknown, data: unknown) {
  const p = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  try {
    switch (event) {
      case 'typing':
        if (typeof p.conversationId === 'string') relayTyping(userId, p.conversationId, !!p.isTyping);
        break;
      case 'recording':
        if (typeof p.conversationId === 'string') relayRecording(userId, p.conversationId, !!p.isRecording);
        break;
      case 'message:delivered': {
        if (!Array.isArray(p.messageIds)) return;
        const ids = p.messageIds.filter((x): x is string => typeof x === 'string').slice(0, 200);
        if (ids.length) markDelivered(userId, ids);
        break;
      }
      case 'call:start':
        startCall(userId, p);
        break;
      case 'call:accept':
        acceptCall(userId, p.callId);
        break;
      case 'call:decline':
        declineCall(userId, p.callId);
        break;
      case 'call:end':
        endCall(userId, p.callId);
        break;
      case 'call:signal':
        relaySignal(userId, p);
        break;
      case 'gcall:start':
        startGroupCall(userId, p);
        break;
      case 'gcall:join':
        joinGroupCall(userId, p.callId);
        break;
      case 'gcall:leave':
        leaveGroupCall(userId, p.callId);
        break;
      case 'gcall:signal':
        relayGroupSignal(userId, p);
        break;
      default:
        break;
    }
  } catch {
    // Realtime events are fire-and-forget; invalid ones are ignored.
  }
}

/** The user's last live connection closed. */
export function handleUserOffline(userId: string) {
  try {
    callsUserOffline(userId);
    groupCallsUserOffline(userId);
  } catch {
    /* ignore */
  }
}

/** Events per socket per 10 s window (ICE candidate bursts during call setup need headroom). */
export const SOCKET_EVENT_BUDGET = 120;
