import { create } from 'zustand';
import type { CallInfo, CallMedia, CallSignal, IceServer, PublicUser } from '@friendstar/shared';
import { backend } from '../api/index.ts';
import { startRingtone, type Ringtone } from '../lib/ringtone.ts';

/**
 * One-to-one WebRTC calls.
 * Caller: grabs media → `call:start` → waits for `ongoing` → sends the offer.
 * Callee: sees `ringing` → accepts (grabs media, builds the peer connection) → answers the offer.
 * The server only relays signalling; audio/video go peer-to-peer.
 */
export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'ended';

const RING_TIMEOUT_MS = 45_000;

const END_TEXT: Record<string, string> = {
  ended: 'Call ended',
  missed: 'No answer',
  declined: 'Call declined',
  unavailable: 'Unavailable right now',
  busy: 'On another call',
};

interface CallState {
  phase: CallPhase;
  call: CallInfo | null;
  peer: PublicUser | null;
  media: CallMedia;
  local: MediaStream | null;
  remote: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  peerCamOn: boolean;
  peerMicOn: boolean;
  connectedAt: number | null;
  endText: string | null;
  minimized: boolean;
  start(conversationId: string, peer: PublicUser, media: CallMedia): Promise<void>;
  accept(): Promise<void>;
  decline(): void;
  hangUp(): void;
  toggleMic(): void;
  toggleCam(): void;
  flipCamera(): Promise<void>;
  setMinimized(v: boolean): void;
  onUpdate(call: CallInfo, meId: string): void;
  onSignal(callId: string, data: CallSignal): void;
}

/* ---- non-reactive session internals ---- */
let pc: RTCPeerConnection | null = null;
let pendingCandidates: RTCIceCandidateInit[] = [];
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let ringtone: Ringtone | null = null;
let iceCache: { servers: IceServer[]; at: number } | null = null;
/** Calls this tab has taken part in; other tabs of the same user stay quiet. */
let ownedCallId: string | null = null;
let facing: 'user' | 'environment' = 'user';

export async function iceServers(): Promise<RTCIceServer[]> {
  if (!iceCache || Date.now() - iceCache.at > 30 * 60_000) {
    const servers = await backend.iceServers().catch(() => []);
    iceCache = { servers: servers.length ? servers : [{ urls: 'stun:stun.l.google.com:19302' }], at: Date.now() };
  }
  return iceCache.servers as RTCIceServer[];
}

export function newCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export async function getMedia(media: CallMedia): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t make calls. Try the latest Chrome, Safari or Firefox.');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: media === 'video' ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError') throw new Error('Allow microphone' + (media === 'video' ? ' and camera' : '') + ' access to make calls.');
    if (name === 'NotFoundError') throw new Error(media === 'video' ? 'No camera or microphone found.' : 'No microphone found.');
    throw new Error('Couldn’t start your ' + (media === 'video' ? 'camera' : 'microphone') + '.');
  }
}

function stopRinging() {
  ringtone?.stop();
  ringtone = null;
  if (ringTimer) clearTimeout(ringTimer);
  ringTimer = null;
}

function teardown() {
  stopRinging();
  if (pc) {
    pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
    pc.close();
  }
  pc = null;
  pendingCandidates = [];
  const { local } = useCall.getState();
  local?.getTracks().forEach((t) => t.stop());
}

export const useCall = create<CallState>((set, get) => {
  const signal = (data: CallSignal) => {
    const call = get().call;
    if (call) backend.emitCall('call:signal', { callId: call.id, data });
  };

  const finish = (text: string) => {
    teardown();
    ownedCallId = null;
    set({ phase: 'ended', endText: text, local: null, remote: null, connectedAt: null });
    setTimeout(() => {
      if (get().phase === 'ended') set({ phase: 'idle', call: null, peer: null, endText: null, minimized: false });
    }, 1800);
  };

  async function buildPeer(stream: MediaStream) {
    const conn = new RTCPeerConnection({ iceServers: await iceServers() });
    pc = conn;
    stream.getTracks().forEach((t) => conn.addTrack(t, stream));
    const remote = new MediaStream();
    set({ remote });
    conn.ontrack = (ev) => {
      ev.streams[0]?.getTracks().forEach((t) => remote.getTracks().includes(t) || remote.addTrack(t));
      if (!ev.streams[0] && !remote.getTracks().includes(ev.track)) remote.addTrack(ev.track);
      set({ remote: new MediaStream(remote.getTracks()) });
    };
    conn.onicecandidate = (ev) => {
      if (ev.candidate) {
        const c = ev.candidate.toJSON();
        signal({ type: 'candidate', candidate: { candidate: c.candidate ?? '', sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } });
      }
    };
    conn.onconnectionstatechange = () => {
      const st = conn.connectionState;
      if (st === 'connected' && get().phase !== 'connected') set({ phase: 'connected', connectedAt: Date.now() });
      if (st === 'failed') {
        const call = get().call;
        if (call) backend.emitCall('call:end', { callId: call.id });
        finish('Couldn’t connect — the network may be blocking calls');
      }
    };
    return conn;
  }

  async function flushCandidates() {
    if (!pc?.remoteDescription) return;
    for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
  }

  return {
    phase: 'idle',
    call: null,
    peer: null,
    media: 'audio',
    local: null,
    remote: null,
    micOn: true,
    camOn: true,
    peerCamOn: true,
    peerMicOn: true,
    connectedAt: null,
    endText: null,
    minimized: false,

    async start(conversationId, peer, media) {
      if (get().phase !== 'idle' && get().phase !== 'ended') throw new Error('You’re already in a call.');
      facing = 'user';
      const local = await getMedia(media);
      const id = newCallId();
      ownedCallId = id;
      const now = new Date().toISOString();
      set({
        phase: 'outgoing',
        media,
        peer,
        local,
        remote: null,
        micOn: true,
        camOn: media === 'video',
        peerCamOn: media === 'video',
        peerMicOn: true,
        endText: null,
        minimized: false,
        call: { id, conversationId, callerId: '', calleeId: peer.id, media, status: 'ringing', createdAt: now, answeredAt: null, endedAt: null, peer },
      });
      ringtone = startRingtone('outgoing');
      backend.emitCall('call:start', { callId: id, conversationId, media });
      ringTimer = setTimeout(() => {
        if (get().phase === 'outgoing') {
          backend.emitCall('call:end', { callId: id });
          finish(END_TEXT.missed);
        }
      }, RING_TIMEOUT_MS);
    },

    async accept() {
      const { call } = get();
      if (!call || get().phase !== 'incoming') return;
      stopRinging();
      ownedCallId = call.id;
      set({ phase: 'connecting' });
      try {
        const local = await getMedia(call.media);
        set({ local, camOn: call.media === 'video' });
        await buildPeer(local);
        backend.emitCall('call:accept', { callId: call.id });
      } catch (e) {
        backend.emitCall('call:decline', { callId: call.id });
        finish((e as Error).message);
      }
    },

    decline() {
      const { call } = get();
      if (call) backend.emitCall('call:decline', { callId: call.id });
      finish(END_TEXT.declined);
    },

    hangUp() {
      const { call } = get();
      if (call) backend.emitCall('call:end', { callId: call.id });
      finish(END_TEXT.ended);
    },

    toggleMic() {
      const on = !get().micOn;
      get().local?.getAudioTracks().forEach((t) => (t.enabled = on));
      set({ micOn: on });
      signal({ type: 'media', audio: on, video: get().camOn });
    },

    toggleCam() {
      const tracks = get().local?.getVideoTracks() ?? [];
      if (!tracks.length) return;
      const on = !get().camOn;
      tracks.forEach((t) => (t.enabled = on));
      set({ camOn: on });
      signal({ type: 'media', audio: get().micOn, video: on });
    },

    async flipCamera() {
      const { local } = get();
      const old = local?.getVideoTracks()[0];
      if (!local || !old) return;
      facing = facing === 'user' ? 'environment' : 'user';
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
        const track = fresh.getVideoTracks()[0];
        const sender = pc?.getSenders().find((s) => s.track?.kind === 'video');
        await sender?.replaceTrack(track);
        local.removeTrack(old);
        old.stop();
        local.addTrack(track);
        track.enabled = get().camOn;
        set({ local: new MediaStream(local.getTracks()) });
      } catch {
        facing = facing === 'user' ? 'environment' : 'user';
      }
    },

    setMinimized(v) {
      set({ minimized: v });
    },

    onUpdate(call, meId) {
      const state = get();
      const mine = state.call?.id === call.id;
      // A new incoming call.
      if (call.status === 'ringing' && call.calleeId === meId) {
        if (state.phase !== 'idle' && state.phase !== 'ended') return; // server already marks us busy
        set({
          phase: 'incoming',
          call,
          peer: call.peer,
          media: call.media,
          peerCamOn: call.media === 'video',
          peerMicOn: true,
          micOn: true,
          camOn: call.media === 'video',
          endText: null,
          minimized: false,
        });
        ringtone = startRingtone('incoming');
        return;
      }
      if (!mine) return;
      // Ignore echoes of calls another tab of mine picked up.
      if (call.status === 'ongoing' && ownedCallId !== call.id) {
        finish('Answered on another device');
        return;
      }
      set({ call: { ...call } });
      if (call.status === 'ongoing' && state.phase === 'outgoing') {
        stopRinging();
        set({ phase: 'connecting' });
        void (async () => {
          const local = get().local;
          if (!local) return;
          const conn = await buildPeer(local);
          const offer = await conn.createOffer();
          await conn.setLocalDescription(offer);
          signal({ type: 'offer', sdp: offer.sdp ?? '' });
        })().catch(() => {
          backend.emitCall('call:end', { callId: call.id });
          finish('Couldn’t start the call');
        });
        return;
      }
      if (call.status !== 'ringing' && call.status !== 'ongoing') {
        if (state.phase !== 'ended' && state.phase !== 'idle') finish(END_TEXT[call.status] ?? 'Call ended');
      }
    },

    onSignal(callId, data) {
      if (get().call?.id !== callId || ownedCallId !== callId) return;
      void (async () => {
        if (data.type === 'offer' && pc) {
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          await flushCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          signal({ type: 'answer', sdp: answer.sdp ?? '' });
        } else if (data.type === 'answer' && pc) {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          await flushCandidates();
        } else if (data.type === 'candidate') {
          const c: RTCIceCandidateInit = { candidate: data.candidate.candidate, sdpMid: data.candidate.sdpMid, sdpMLineIndex: data.candidate.sdpMLineIndex };
          if (pc?.remoteDescription) await pc.addIceCandidate(c).catch(() => undefined);
          else pendingCandidates.push(c);
        } else if (data.type === 'media') {
          set({ peerCamOn: data.video, peerMicOn: data.audio });
        }
      })().catch(() => undefined);
    },
  };
});

/** Hang up cleanly if the tab is closed mid-call. */
window.addEventListener('pagehide', () => {
  const { call, phase } = useCall.getState();
  if (call && phase !== 'idle' && phase !== 'ended') backend.emitCall(phase === 'incoming' ? 'call:decline' : 'call:end', { callId: call.id });
});

/** Start a call from any screen, surfacing permission / busy errors as toasts. */
export async function callUser(conversationId: string, peer: PublicUser, media: CallMedia, onError: (msg: string) => void) {
  try {
    await useCall.getState().start(conversationId, peer, media);
  } catch (e) {
    onError((e as Error).message || 'Couldn’t start the call');
  }
}
