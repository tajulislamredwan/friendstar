import { useEffect, useRef, useState } from 'react';
import { useCall } from '../../store/call.ts';
import { cn } from '../../lib/format.ts';
import { unlockAudio } from '../../lib/audio.ts';
import { Avatar } from '../ui/index.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

export function Video({ stream, muted, mirror, className }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={cn('object-cover', mirror && '-scale-x-100', className)} />;
}

/** Plays remote audio for voice calls (video elements carry audio for video calls). */
export function RemoteAudio({ stream, showAudioPrompt = true }: { stream: MediaStream | null; showAudioPrompt?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
      void ref.current.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
    }
  }, [stream]);
  return (
    <>
      <audio ref={ref} autoPlay />
      {blocked && showAudioPrompt && (
        <button
          type="button"
          onClick={() => {
            void unlockAudio();
            void ref.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
          }}
          className="fixed bottom-24 left-1/2 z-[70] -translate-x-1/2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#1a1630] shadow-xl"
        >
          Tap to enable call audio
        </button>
      )}
    </>
  );
}

export function RoundButton({
  icon,
  label,
  onClick,
  tone = 'glass',
  active,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  tone?: 'glass' | 'danger' | 'success';
  active?: boolean;
}) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="flex flex-col items-center gap-1.5 text-[12px] font-semibold text-white/85">
      <span
        className={cn(
          'flex h-14 w-14 items-center justify-center rounded-full transition active:scale-95',
          tone === 'danger' && 'bg-[#ff4d5e] text-white shadow-lg shadow-[#ff4d5e]/30',
          tone === 'success' && 'bg-[#22c27a] text-white shadow-lg shadow-[#22c27a]/30',
          tone === 'glass' && (active ? 'bg-white text-[#1a1630]' : 'bg-white/15 text-white hover:bg-white/25'),
        )}
      >
        <Icon name={icon} size={26} />
      </span>
      {label}
    </button>
  );
}

export function CallOverlay() {
  const s = useCall();
  useTicker(s.phase === 'connected');
  if (s.phase === 'idle' || !s.peer) return null;

  const video = s.media === 'video';
  const hasRemoteVideo = video && s.peerCamOn && !!s.remote?.getVideoTracks().length && s.phase === 'connected';
  const statusText =
    s.phase === 'outgoing'
      ? 'Ringing…'
      : s.phase === 'incoming'
        ? `Incoming ${video ? 'video' : 'voice'} call`
        : s.phase === 'connecting'
          ? 'Connecting…'
          : s.phase === 'connected'
            ? formatDuration(Date.now() - (s.connectedAt ?? Date.now()))
            : (s.endText ?? 'Call ended');

  if (s.minimized && s.phase !== 'incoming') {
    return (
      <button
        onClick={() => s.setMinimized(false)}
        className="pop-in fixed bottom-24 right-4 z-[60] flex items-center gap-3 rounded-full bg-[#1a1630] py-2 pl-2 pr-4 text-white shadow-2xl md:bottom-6"
      >
        <Avatar name={s.peer.displayName} src={s.peer.avatarUrl} size={36} />
        <span className="text-left text-sm leading-tight">
          <span className="block font-semibold">{s.peer.displayName}</span>
          <span className="block text-white/70">{statusText}</span>
        </span>
        <span className="ml-1 h-2.5 w-2.5 animate-pulse rounded-full bg-[#22c27a]" />
        {!video && <RemoteAudio stream={s.remote} showAudioPrompt={false} />}
        {video && <Video stream={s.remote} className="hidden" />}
      </button>
    );
  }

  return (
    <div className="call-stage fixed inset-0 z-[60] flex flex-col text-white" role="dialog" aria-label={`Call with ${s.peer.displayName}`}>
      {hasRemoteVideo ? (
        <Video stream={s.remote} className="absolute inset-0 h-full w-full" />
      ) : (
        <>
          {!video && <RemoteAudio stream={s.remote} />}
          {video && <Video stream={s.remote} className="hidden" />}
        </>
      )}
      {hasRemoteVideo && <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/60" />}

      <div className="safe-top relative flex items-center justify-between px-4 pt-4">
        <span className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold">
          <Icon name="lock" size={14} /> Encrypted peer-to-peer call
        </span>
        {s.phase !== 'incoming' && s.phase !== 'ended' && (
          <button onClick={() => s.setMinimized(true)} aria-label="Minimise call" className="rounded-full bg-white/10 p-2 hover:bg-white/20">
            <Icon name="minimize" size={20} />
          </button>
        )}
      </div>

      <div className={cn('relative flex flex-1 flex-col items-center px-6 text-center', hasRemoteVideo ? 'justify-start pt-6' : 'justify-center')}>
        {!hasRemoteVideo && (
          <span className={cn('rounded-full', (s.phase === 'outgoing' || s.phase === 'incoming') && 'call-pulse')}>
            <Avatar name={s.peer.displayName} src={s.peer.avatarUrl} size={128} />
          </span>
        )}
        <h2 className={cn('font-extrabold tracking-tight', hasRemoteVideo ? 'text-xl' : 'mt-6 text-3xl')}>{s.peer.displayName}</h2>
        <p className="mt-1 text-white/75" aria-live="polite">
          {statusText}
        </p>
        {s.phase === 'connected' && !s.peerMicOn && (
          <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs">
            <Icon name="micOff" size={14} /> {s.peer.displayName.split(' ')[0]} is muted
          </p>
        )}
        {s.phase === 'connected' && video && !s.peerCamOn && <p className="mt-2 text-xs text-white/70">Camera is off</p>}
      </div>

      {video && s.local && s.phase !== 'ended' && (
        <div className="absolute right-4 top-20 h-44 w-28 overflow-hidden rounded-2xl border border-white/20 bg-black/40 shadow-xl md:h-56 md:w-40">
          {s.camOn ? (
            <Video stream={s.local} muted mirror className="h-full w-full" />
          ) : (
            <div className="flex h-full items-center justify-center text-white/60">
              <Icon name="videoOff" size={28} />
            </div>
          )}
        </div>
      )}

      <div className="safe-bottom relative pb-10 pt-4">
        {s.phase === 'incoming' ? (
          <div className="flex items-center justify-center gap-16">
            <RoundButton icon="hangup" label="Decline" tone="danger" onClick={s.decline} />
            <RoundButton icon={video ? 'video' : 'phone'} label="Accept" tone="success" onClick={() => void s.accept()} />
          </div>
        ) : s.phase === 'ended' ? (
          <p className="text-center text-sm text-white/70">Closing…</p>
        ) : (
          <div className="flex items-center justify-center gap-5">
            <RoundButton icon={s.micOn ? 'mic' : 'micOff'} label={s.micOn ? 'Mute' : 'Unmute'} active={!s.micOn} onClick={s.toggleMic} />
            {video && <RoundButton icon={s.camOn ? 'video' : 'videoOff'} label={s.camOn ? 'Camera' : 'Camera off'} active={!s.camOn} onClick={s.toggleCam} />}
            {video && <RoundButton icon="flip" label="Flip" onClick={() => void s.flipCamera()} />}
            <RoundButton icon="hangup" label="End" tone="danger" onClick={s.hangUp} />
          </div>
        )}
      </div>
    </div>
  );
}
