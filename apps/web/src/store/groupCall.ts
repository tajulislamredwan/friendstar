import { create } from 'zustand';
import { GROUP_CALL_MAX, type CallMedia, type CallSignal, type GroupCallInfo } from '@friendstar/shared';
import { backend } from '../api/index.ts';
import { startRingtone, type Ringtone } from '../lib/ringtone.ts';
import { getMedia, iceServers, newCallId, useCall } from './call.ts';

/**
 * Group calls as a WebRTC mesh: one RTCPeerConnection per other participant.
 * For each pair, the person who joined later sends the offer, so no two sides
 * ever offer at the same time. The server only tracks membership and relays signals.
 */
export type GroupPhase = 'idle' | 'joining' | 'in-call';

export interface PeerState {
  stream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  state: 'connecting' | 'connected' | 'failed';
}

interface GroupCallState {
  phase: GroupPhase;
  call: GroupCallInfo | null;
  /** An incoming ring (someone started a call in one of my groups). */
  invite: GroupCallInfo | null;
  /** Ongoing calls in my groups, keyed by conversation id (for "Join" banners). */
  active: Record<string, GroupCallInfo>;
  local: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  peers: Record<string, PeerState>;
  joinedAt: number | null;
  minimized: boolean;
  error: string | null;
  /** Start a call in a group, or join the one already running there. */
  startOrJoin(conversationId: string, media: CallMedia, meId: string): Promise<void>;
  leave(): void;
  dismissInvite(): void;
  toggleMic(): void;
  toggleCam(): void;
  setMinimized(v: boolean): void;
  loadActive(): Promise<void>;
  onUpdate(call: GroupCallInfo, meId: string, ring: boolean): void;
  onSignal(callId: string, fromUserId: string, data: CallSignal): void;
}

/* ---- non-reactive session internals ---- */
const conns = new Map<string, RTCPeerConnection>();
const pending = new Map<string, RTCIceCandidateInit[]>();
const restarted = new Set<string>();
let ringtone: Ringtone | null = null;
let inviteTimer: ReturnType<typeof setTimeout> | null = null;
/** The call this tab joined; other tabs of the same account stay passive. */
let ownedCallId: string | null = null;
let joiningConv: string | null = null;
let joinSeq = 0;
let meIdCache = '';

function stopRing() {
  ringtone?.stop();
  ringtone = null;
  if (inviteTimer) clearTimeout(inviteTimer);
  inviteTimer = null;
}

function closePeer(userId: string) {
  const pc = conns.get(userId);
  if (pc) {
    pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
    pc.close();
  }
  conns.delete(userId);
  pending.delete(userId);
  restarted.delete(userId);
}

function joinedAtOf(call: GroupCallInfo, userId: string) {
  return call.participants.find((p) => p.user.id === userId)?.joinedAt ?? '';
}

/** Deterministic: the later joiner offers (ties broken by id). */
function iAmOfferer(call: GroupCallInfo, meId: string, otherId: string) {
  const a = joinedAtOf(call, meId);
  const b = joinedAtOf(call, otherId);
  return a === b ? meId > otherId : a > b;
}

export const useGroupCall = create<GroupCallState>((set, get) => {
  const send = (toUserId: string, data: CallSignal) => {
    const call = get().call;
    if (call) backend.emitCall('gcall:signal', { callId: call.id, toUserId, data });
  };

  const patchPeer = (userId: string, patch: Partial<PeerState>) => {
    const prev = get().peers[userId] ?? { stream: null, micOn: true, camOn: get().call?.media === 'video', state: 'connecting' as const };
    set({ peers: { ...get().peers, [userId]: { ...prev, ...patch } } });
  };

  async function ensurePeer(userId: string): Promise<RTCPeerConnection> {
    const existing = conns.get(userId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    // Another await may have created it meanwhile.
    const raced = conns.get(userId);
    if (raced) {
      pc.close();
      return raced;
    }
    conns.set(userId, pc);
    const local = get().local;
    local?.getTracks().forEach((t) => pc.addTrack(t, local));
    const remote = new MediaStream();
    patchPeer(userId, { stream: remote, state: 'connecting' });
    pc.ontrack = (ev) => {
      const tracks = ev.streams[0]?.getTracks() ?? [ev.track];
      tracks.forEach((t) => remote.getTracks().includes(t) || remote.addTrack(t));
      patchPeer(userId, { stream: new MediaStream(remote.getTracks()) });
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const c = ev.candidate.toJSON();
      send(userId, { type: 'candidate', candidate: { candidate: c.candidate ?? '', sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } });
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') {
        patchPeer(userId, { state: 'connected' });
        // Tell the new peer our current mic/camera state.
        send(userId, { type: 'media', audio: get().micOn, video: get().camOn });
      } else if (st === 'failed') {
        const call = get().call;
        if (call && !restarted.has(userId) && iAmOfferer(call, meIdCache, userId)) {
          restarted.add(userId);
          void offerTo(userId, true);
        } else {
          patchPeer(userId, { state: 'failed' });
        }
      }
    };
    return pc;
  }

  async function offerTo(userId: string, iceRestart = false) {
    const pc = await ensurePeer(userId);
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    send(userId, { type: 'offer', sdp: offer.sdp ?? '' });
  }

  async function flush(userId: string) {
    const pc = conns.get(userId);
    if (!pc?.remoteDescription) return;
    for (const c of pending.get(userId)?.splice(0) ?? []) await pc.addIceCandidate(c).catch(() => undefined);
  }

  /** Bring the mesh in line with the server's participant list. */
  function reconcile(call: GroupCallInfo, meId: string) {
    const others = call.participants.map((p) => p.user.id).filter((id) => id !== meId);
    for (const id of [...conns.keys()]) {
      if (!others.includes(id)) {
        closePeer(id);
        const { [id]: _gone, ...rest } = get().peers;
        set({ peers: rest });
      }
    }
    for (const id of others) {
      if (conns.has(id)) continue;
      if (iAmOfferer(call, meId, id)) void offerTo(id).catch(() => patchPeer(id, { state: 'failed' }));
      else patchPeer(id, { state: 'connecting' });
    }
  }

  function teardown() {
    stopRing();
    for (const id of [...conns.keys()]) closePeer(id);
    get().local?.getTracks().forEach((t) => t.stop());
    ownedCallId = null;
    joiningConv = null;
    set({ phase: 'idle', call: null, local: null, peers: {}, joinedAt: null, minimized: false });
  }

  return {
    phase: 'idle',
    call: null,
    invite: null,
    active: {},
    local: null,
    micOn: true,
    camOn: true,
    peers: {},
    joinedAt: null,
    minimized: false,
    error: null,

    async startOrJoin(conversationId, media, meId) {
      if (get().phase !== 'idle') throw new Error('You’re already in a group call.');
      const one = useCall.getState().phase;
      if (one !== 'idle' && one !== 'ended') throw new Error('Finish your current call first.');
      const inv = get().invite;
      const existing = get().active[conversationId] ?? (inv?.conversationId === conversationId ? inv : undefined);
      if (existing && existing.participants.length >= GROUP_CALL_MAX && !existing.participants.some((p) => p.user.id === meId)) {
        throw new Error(`This call is full (${GROUP_CALL_MAX} people max).`);
      }
      const callMedia = existing?.media ?? media;
      meIdCache = meId;
      joiningConv = conversationId;
      const seq = ++joinSeq;
      stopRing();
      set({ invite: null, phase: 'joining', error: null, micOn: true, camOn: callMedia === 'video', minimized: false });
      let local: MediaStream;
      try {
        local = await getMedia(callMedia);
      } catch (e) {
        set({ phase: 'idle' });
        throw e;
      }
      set({ local, joinedAt: Date.now() });
      if (existing) {
        ownedCallId = existing.id;
        set({ call: existing });
        backend.emitCall('gcall:join', { callId: existing.id });
      } else {
        const id = newCallId();
        ownedCallId = id;
        backend.emitCall('gcall:start', { callId: id, conversationId, media: callMedia });
      }
      // If the server never confirms (full / busy / lost), don't hang in "joining".
      setTimeout(() => {
        if (seq === joinSeq && get().phase === 'joining') {
          // Tell the server too, in case it seated us in a call we never heard about.
          if (ownedCallId) backend.emitCall('gcall:leave', { callId: ownedCallId });
          teardown();
          set({ error: 'Couldn’t join the call. Please try again.' });
        }
      }, 12_000);
    },

    leave() {
      const call = get().call;
      if (call) backend.emitCall('gcall:leave', { callId: call.id });
      teardown();
    },

    dismissInvite() {
      stopRing();
      set({ invite: null });
    },

    toggleMic() {
      const on = !get().micOn;
      get().local?.getAudioTracks().forEach((t) => (t.enabled = on));
      set({ micOn: on });
      for (const id of conns.keys()) send(id, { type: 'media', audio: on, video: get().camOn });
    },

    toggleCam() {
      const tracks = get().local?.getVideoTracks() ?? [];
      if (!tracks.length) return;
      const on = !get().camOn;
      tracks.forEach((t) => (t.enabled = on));
      set({ camOn: on });
      for (const id of conns.keys()) send(id, { type: 'media', audio: get().micOn, video: on });
    },

    setMinimized(v) {
      set({ minimized: v });
    },

    async loadActive() {
      const calls = await backend.listGroupCalls().catch(() => []);
      set({ active: Object.fromEntries(calls.map((c) => [c.conversationId, c])) });
    },

    onUpdate(call, meId, ring) {
      meIdCache = meId;
      // Keep the banner map current.
      const active = { ...get().active };
      if (call.status === 'ongoing') active[call.conversationId] = call;
      else delete active[call.conversationId];
      set({ active });

      const st = get();
      const meIn = call.participants.some((p) => p.user.id === meId);

      // Incoming ring.
      if (ring && call.status === 'ongoing' && call.startedBy !== meId && st.phase === 'idle') {
        const one = useCall.getState().phase;
        if (one === 'idle' || one === 'ended') {
          set({ invite: call });
          stopRing();
          ringtone = startRingtone('incoming');
          inviteTimer = setTimeout(() => get().dismissInvite(), 30_000);
        }
      }
      if (st.invite?.id === call.id && (call.status !== 'ongoing' || meIn)) {
        stopRing();
        set({ invite: call.status === 'ongoing' && !meIn ? call : null });
      }

      // We asked to start a call but one was already running there: the server seated us in it.
      if (st.phase === 'joining' && ownedCallId !== call.id && call.conversationId === joiningConv && meIn && call.status === 'ongoing') {
        ownedCallId = call.id;
      }
      // My own call.
      if (ownedCallId !== call.id) return;
      if (call.status !== 'ongoing') {
        teardown();
        return;
      }
      if (!meIn) {
        if (st.phase === 'joining') {
          // An update sent before our join reached the server can arrive late. Keep waiting for
          // our own confirmation unless the call is already full; the 12 s timeout covers the rest.
          if (call.participants.length >= GROUP_CALL_MAX) {
            teardown();
            set({ error: `This call is full (${GROUP_CALL_MAX} people max).` });
          } else {
            set({ call });
          }
        } else if (st.phase === 'in-call') {
          teardown();
        }
        return;
      }
      set({ call, phase: 'in-call' });
      reconcile(call, meId);
    },

    onSignal(callId, fromUserId, data) {
      if (ownedCallId !== callId || get().phase === 'idle') return;
      void (async () => {
        if (data.type === 'offer') {
          const pc = await ensurePeer(fromUserId);
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          await flush(fromUserId);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send(fromUserId, { type: 'answer', sdp: answer.sdp ?? '' });
        } else if (data.type === 'answer') {
          const pc = conns.get(fromUserId);
          if (pc && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
            await flush(fromUserId);
          }
        } else if (data.type === 'candidate') {
          const c: RTCIceCandidateInit = { candidate: data.candidate.candidate, sdpMid: data.candidate.sdpMid, sdpMLineIndex: data.candidate.sdpMLineIndex };
          const pc = conns.get(fromUserId);
          if (pc?.remoteDescription) await pc.addIceCandidate(c).catch(() => undefined);
          else pending.set(fromUserId, [...(pending.get(fromUserId) ?? []), c]);
        } else if (data.type === 'media') {
          patchPeer(fromUserId, { micOn: data.audio, camOn: data.video });
        }
      })().catch(() => patchPeer(fromUserId, { state: 'failed' }));
    },
  };
});

/** Leave cleanly if the tab closes mid-call. */
window.addEventListener('pagehide', () => {
  const { call, phase } = useGroupCall.getState();
  if (call && phase !== 'idle') backend.emitCall('gcall:leave', { callId: call.id });
});
