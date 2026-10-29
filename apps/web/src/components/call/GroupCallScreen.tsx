import { useEffect } from 'react';
import { GROUP_CALL_MAX, type GroupCallInfo } from '@friendstar/shared';
import { useGroupCall, type PeerState } from '../../store/groupCall.ts';
import { useAuth, useToasts } from '../../store/index.ts';
import { cn } from '../../lib/format.ts';
import { Avatar } from '../ui/index.tsx';
import { Icon } from '../ui/Icon.tsx';
import { RemoteAudio, RoundButton, Video, formatDuration, useTicker } from './CallScreen.tsx';

/** Join (or start) a group call from any screen, turning errors into toasts. */
export function useJoinGroupCall() {
  const me = useAuth((s) => s.me);
  const toast = useToasts((s) => s.push);
  return async (conversationId: string, media: 'audio' | 'video') => {
    if (!me) return;
    try {
      await useGroupCall.getState().startOrJoin(conversationId, media, me.id);
    } catch (e) {
      toast({ title: (e as Error).message || 'Couldn’t start the call', tone: 'error' });
    }
  };
}

interface TileProps {
  name: string;
  avatarUrl: string | null;
  stream: MediaStream | null;
  video: boolean;
  camOn: boolean;
  micOn: boolean;
  state?: PeerState['state'];
  self?: boolean;
}

function Tile({ name, avatarUrl, stream, video, camOn, micOn, state, self }: TileProps) {
  const showVideo = video && camOn && !!stream?.getVideoTracks().length && (self || state === 'connected');
  return (
    <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-3xl bg-white/[0.06] ring-1 ring-white/10">
      {showVideo ? (
        <Video stream={stream} muted={self} mirror={self} className="absolute inset-0 h-full w-full" />
      ) : (
        <>
          {!self && !video && <RemoteAudio stream={stream} />}
          {!self && video && <Video stream={stream} className="hidden" />}
          <Avatar name={name} src={avatarUrl} size={72} />
        </>
      )}
      <div className="absolute inset-x-2 bottom-2 flex items-center gap-1.5">
        <span className="max-w-full truncate rounded-full bg-black/45 px-2.5 py-1 text-[12px] font-semibold backdrop-blur">
          {self ? 'You' : name}
        </span>
        {!micOn && (
          <span className="rounded-full bg-black/45 p-1 backdrop-blur" aria-label="Muted">
            <Icon name="micOff" size={14} />
          </span>
        )}
      </div>
      {!self && state !== 'connected' && (
        <span className="absolute right-2 top-2 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-semibold backdrop-blur">
          {state === 'failed' ? 'Can’t connect' : 'Connecting…'}
        </span>
      )}
    </div>
  );
}

function gridClass(n: number) {
  if (n <= 1) return 'grid-cols-1 grid-rows-1';
  if (n === 2) return 'grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1';
  if (n <= 4) return 'grid-cols-2 grid-rows-2';
  return 'grid-cols-2 grid-rows-3 md:grid-cols-3 md:grid-rows-2';
}

export function GroupCallOverlay() {
  const s = useGroupCall();
  const me = useAuth((x) => x.me);
  const toast = useToasts((x) => x.push);
  useTicker(s.phase === 'in-call');

  useEffect(() => {
    if (s.error) {
      toast({ title: s.error, tone: 'error' });
      useGroupCall.setState({ error: null });
    }
  }, [s.error, toast]);

  if (s.phase === 'idle' || !me) return null;
  const call = s.call;
  const video = (call?.media ?? (s.camOn ? 'video' : 'audio')) === 'video';
  const others = (call?.participants ?? []).filter((p) => p.user.id !== me.id);
  const elapsed = formatDuration(Date.now() - (s.joinedAt ?? Date.now()));
  const status = s.phase === 'joining' ? 'Joining…' : others.length === 0 ? `Waiting for others · ${elapsed}` : elapsed;

  if (s.minimized) {
    return (
      <button
        onClick={() => s.setMinimized(false)}
        aria-label={`Return to group call in ${call?.title ?? 'group'}`}
        className="pop-in fixed bottom-24 right-4 z-[60] flex items-center gap-3 rounded-full bg-[#1a1630] py-2 pl-2 pr-4 text-white shadow-2xl md:bottom-6"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15">
          <Icon name="users" size={20} />
        </span>
        <span className="text-left text-sm leading-tight">
          <span className="block max-w-[10rem] truncate font-semibold">{call?.title ?? 'Group call'}</span>
          <span className="block text-white/70">
            {others.length + 1} in call · {elapsed}
          </span>
        </span>
        <span className="ml-1 h-2.5 w-2.5 animate-pulse rounded-full bg-[#22c27a]" />
        {others.map((p) => (
          <RemoteAudio key={p.user.id} stream={s.peers[p.user.id]?.stream ?? null} />
        ))}
      </button>
    );
  }

  const tiles = 1 + others.length;
  return (
    <div className="call-stage fixed inset-0 z-[60] flex flex-col text-white" role="dialog" aria-label={`Group call in ${call?.title ?? 'group'}`}>
      <div className="safe-top flex items-center justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-extrabold tracking-tight">{call?.title ?? 'Group call'}</h2>
          <p className="text-[13px] text-white/75" aria-live="polite">
            {video ? 'Group video call' : 'Group voice call'} · {status}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold">
            {tiles}/{GROUP_CALL_MAX}
          </span>
          <button onClick={() => s.setMinimized(true)} aria-label="Minimise call" className="rounded-full bg-white/10 p-2 hover:bg-white/20">
            <Icon name="minimize" size={20} />
          </button>
        </div>
      </div>

      <div className={cn('grid min-h-0 flex-1 gap-2 p-3 md:gap-3 md:p-5', gridClass(tiles))}>
        <Tile name={me.displayName} avatarUrl={me.avatarUrl} stream={s.local} video={video} camOn={s.camOn} micOn={s.micOn} self />
        {others.map((p) => {
          const peer = s.peers[p.user.id];
          return (
            <Tile
              key={p.user.id}
              name={p.user.displayName}
              avatarUrl={p.user.avatarUrl}
              stream={peer?.stream ?? null}
              video={video}
              camOn={peer?.camOn ?? video}
              micOn={peer?.micOn ?? true}
              state={peer?.state ?? 'connecting'}
            />
          );
        })}
      </div>

      <div className="safe-bottom pb-8 pt-2">
        <div className="flex items-center justify-center gap-5">
          <RoundButton icon={s.micOn ? 'mic' : 'micOff'} label={s.micOn ? 'Mute' : 'Unmute'} active={!s.micOn} onClick={s.toggleMic} />
          {video && <RoundButton icon={s.camOn ? 'video' : 'videoOff'} label={s.camOn ? 'Camera' : 'Camera off'} active={!s.camOn} onClick={s.toggleCam} />}
          <RoundButton icon="hangup" label="Leave" tone="danger" onClick={s.leave} />
        </div>
      </div>
    </div>
  );
}

/** "Someone started a call in <group>" card with Join / Not now. */
export function GroupCallInvite() {
  const invite = useGroupCall((s) => s.invite);
  const dismiss = useGroupCall((s) => s.dismissInvite);
  const join = useJoinGroupCall();
  if (!invite) return null;
  const starter = invite.participants.find((p) => p.user.id === invite.startedBy)?.user;
  const video = invite.media === 'video';
  return (
    <div className="safe-top pointer-events-none fixed inset-x-0 top-0 z-[61] flex justify-center px-3 pt-3">
      <div className="pop-in pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-3xl bg-[#1a1630] p-3 text-white shadow-2xl ring-1 ring-white/10" role="alertdialog" aria-label="Incoming group call">
        <span className="call-pulse flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/15">
          <Icon name={video ? 'video' : 'phone'} size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{invite.title}</p>
          <p className="truncate text-[13px] text-white/75">
            {starter ? `${starter.displayName.split(' ')[0]} started a ` : 'Group '}
            {video ? 'video' : 'voice'} call
          </p>
        </div>
        <button onClick={dismiss} className="rounded-full bg-white/10 px-3 py-2 text-[13px] font-semibold hover:bg-white/20">
          Not now
        </button>
        <button
          onClick={() => void join(invite.conversationId, invite.media)}
          className="rounded-full bg-[#22c27a] px-4 py-2 text-[13px] font-bold shadow-lg shadow-[#22c27a]/30"
        >
          Join
        </button>
      </div>
    </div>
  );
}

/** Banner inside a group chat while a call is running there. */
export function GroupCallBanner({ conversationId }: { conversationId: string }) {
  const call = useGroupCall((s) => s.active[conversationId]) as GroupCallInfo | undefined;
  const phase = useGroupCall((s) => s.phase);
  const myCall = useGroupCall((s) => s.call?.id);
  const setMin = useGroupCall((s) => s.setMinimized);
  const join = useJoinGroupCall();
  useTicker(!!call);
  if (!call) return null;
  const inThis = phase !== 'idle' && myCall === call.id;
  const full = call.participants.length >= GROUP_CALL_MAX;
  return (
    <div className="flex items-center gap-3 border-b border-line bg-[#22c27a]/12 px-4 py-2.5">
      <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-[#22c27a]" />
      <div className="flex -space-x-2">
        {call.participants.slice(0, 4).map((p) => (
          <span key={p.user.id} className="rounded-full ring-2 ring-surface">
            <Avatar name={p.user.displayName} src={p.user.avatarUrl} size={26} />
          </span>
        ))}
      </div>
      <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">
        {call.media === 'video' ? 'Video' : 'Voice'} call · {call.participants.length} in call · {formatDuration(Date.now() - Date.parse(call.createdAt))}
      </p>
      {inThis ? (
        <button onClick={() => setMin(false)} className="rounded-full bg-[#22c27a] px-3.5 py-1.5 text-[13px] font-bold text-white">
          Open
        </button>
      ) : (
        <button
          disabled={full}
          onClick={() => void join(conversationId, call.media)}
          className="rounded-full bg-[#22c27a] px-3.5 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {full ? 'Full' : 'Join'}
        </button>
      )}
    </div>
  );
}
