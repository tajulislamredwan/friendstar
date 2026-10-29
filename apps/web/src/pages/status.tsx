import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { IMAGE_MIME, LIMITS, STATUS_BACKGROUNDS, VIDEO_MIME, type PublicUser, type StatusBackground, type StatusItem, type StatusMusicTrackId, type StatusViewer } from '@friendstar/shared';
import { ApiError, backend } from '../api/index.ts';
import { PageHeader } from '../components/layout/index.tsx';
import { Avatar, Button, EmptyState, IconButton, Spinner } from '../components/ui/index.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import { cn, formatListTime } from '../lib/format.ts';
import { toast, useAuth } from '../store/index.ts';
import { useStatus } from '../store/status.ts';
import { StatusMusicPicker } from '../components/status/MusicPicker.tsx';
import { playStatusMusic } from '../lib/status-music.ts';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');
const STORY_MS = 6000;
const STATUS_MEDIA_TYPES = new Set<string>([...IMAGE_MIME, ...VIDEO_MIME]);
const timeAgo = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
};

/* ================= Feed ================= */
export function StatusPage() {
  const navigate = useNavigate();
  const me = useAuth((s) => s.me)!;
  const { mine, feed, loaded } = useStatus();
  const media = useRef<HTMLInputElement>(null);
  const [posting, setPosting] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [musicTrackId, setMusicTrackId] = useState<StatusMusicTrackId | null>(null);
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedMedia) {
      setMediaPreview(null);
      return;
    }
    const url = URL.createObjectURL(selectedMedia);
    setMediaPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedMedia]);

  useEffect(() => {
    void useStatus.getState().load().catch(() => undefined);
  }, []);

  const unseen = feed.filter((e) => !e.allViewed);
  const seen = feed.filter((e) => e.allViewed);

  async function postMedia(file: File, text: string, track: StatusMusicTrackId | null, hours: number, soundtrack: File | null) {
    if (!STATUS_MEDIA_TYPES.has(file.type)) {
      toast({ title: 'Unsupported media', body: 'Choose an image, MP4 video, or WebM video.', tone: 'error' });
      return;
    }
    if (file.size > LIMITS.statusMediaBytes) {
      toast({ title: 'Media is too large', body: 'Status photos and videos must be 10 MB or smaller.', tone: 'error' });
      return;
    }
    setPosting(true);
    try {
      await useStatus.getState().postMedia(file, text, track, hours, soundtrack);
      setSelectedMedia(null);
      setCaption('');
      setMusicTrackId(null);
      setMusicFile(null);
      toast({ title: 'Status shared', body: `Visible to your contacts for ${hours} hour${hours === 1 ? '' : 's'}.`, tone: 'success' });
    } catch (e) {
      toast({ title: 'Couldn’t share status', body: errMsg(e), tone: 'error' });
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="relative flex h-full flex-col bg-surface">
      <PageHeader title="Status" actions={<IconButton icon="text" label="New text status" onClick={() => navigate('/status/new')} />} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-28">
        <div className="mx-auto max-w-2xl">
          <button
            onClick={() => (mine.length ? navigate(`/status/view/${me.id}`) : navigate('/status/new'))}
            className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition hover:bg-surface-2"
          >
            <span className="relative">
              <Avatar name={me.displayName} src={me.avatarUrl} size={54} ring={mine.length ? 'seen' : null} />
              {!mine.length && (
                <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-primary text-on-primary">
                  <Icon name="plus" size={14} />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">My status</span>
              <span className="block text-sm text-muted">
                {mine.length ? `${mine.length} update${mine.length > 1 ? 's' : ''} · ${timeAgo(mine[mine.length - 1].createdAt)}` : 'Tap to share a moment · default 24h'}
              </span>
            </span>
            {posting && <Spinner size={18} className="text-primary" />}
          </button>

          {!loaded ? (
            <div className="flex justify-center py-16 text-primary">
              <Spinner />
            </div>
          ) : feed.length === 0 ? (
            <EmptyState icon="stories" title="No updates yet" body="When your contacts share a status, it shows up here for 24 hours." />
          ) : (
            <>
              {unseen.length > 0 && <FeedSection title="Recent updates" entries={unseen} />}
              {seen.length > 0 && <FeedSection title="Viewed" entries={seen} />}
            </>
          )}
          <p className="mt-6 flex items-center justify-center gap-1.5 px-6 text-center text-xs text-muted">
            <Icon name="lock" size={14} /> Status updates are shared with people you chat with, and follow your profile-photo privacy setting.
          </p>
        </div>
      </div>

      <div className="absolute bottom-5 right-5 flex flex-col items-end gap-3">
        <button
          onClick={() => navigate('/status/new')}
          aria-label="New text status"
          className="flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-2 text-ink shadow-md transition active:scale-95"
        >
          <Icon name="edit" size={20} />
        </button>
        <button
          onClick={() => media.current?.click()}
          aria-label="New photo or video status"
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-on-primary shadow-lg shadow-primary/30 transition active:scale-95"
        >
          <Icon name="camera" size={26} />
        </button>
      </div>
      <input
        ref={media}
        type="file"
        accept={[...IMAGE_MIME, ...VIDEO_MIME].join(',')}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) setSelectedMedia(f);
        }}
      />
      {selectedMedia && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" role="dialog" aria-label="Create photo or video status">
          <div className="scroll-thin max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-3xl bg-surface p-4 text-ink shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold">New media Status</h2>
              <IconButton icon="x" label="Cancel" onClick={() => { setSelectedMedia(null); setCaption(''); setMusicTrackId(null); setMusicFile(null); }} />
            </div>
            {mediaPreview && (selectedMedia.type.startsWith('video/') ? (
              <video src={mediaPreview} controls playsInline className="mb-3 max-h-64 w-full rounded-2xl bg-black object-contain" />
            ) : (
              <img src={mediaPreview} alt="Status preview" className="mb-3 max-h-64 w-full rounded-2xl bg-black object-contain" />
            ))}
            <label className="mb-3 block text-sm font-semibold">
              Caption <span className="font-normal text-muted">({caption.length}/700)</span>
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value.slice(0, 700))}
                maxLength={700}
                rows={3}
                placeholder="Add a caption (optional)"
                className="mt-1 w-full resize-none rounded-2xl border border-line bg-bg px-3 py-2 text-sm font-normal text-ink outline-none focus:border-primary"
              />
            </label>
            <StatusMusicPicker value={musicTrackId} onChange={setMusicTrackId} file={musicFile} onFileChange={setMusicFile} />
            <label className="mt-3 block text-sm font-semibold">Show status for
              <span className="ml-2 inline-flex items-center gap-2 font-normal"><input type="number" min={1} max={168} value={expiresInHours} onChange={(e) => setExpiresInHours(Math.min(168, Math.max(1, Number(e.target.value) || 1)))} className="w-20 rounded-lg border border-line bg-bg px-2 py-1 text-center" /> hours <span className="text-xs text-muted">(default 24)</span></span>
            </label>
            <div className="mt-4 flex justify-end">
              <Button icon="send" loading={posting} onClick={() => void postMedia(selectedMedia, caption.trim(), musicTrackId, expiresInHours, musicFile)}>
                Share Status
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FeedSection({ title, entries }: { title: string; entries: { user: PublicUser; items: StatusItem[]; allViewed: boolean; latestAt: string }[] }) {
  const navigate = useNavigate();
  return (
    <>
      <p className="px-3 pb-1 pt-4 text-xs font-bold uppercase tracking-wider text-muted">{title}</p>
      {entries.map((e) => (
        <button
          key={e.user.id}
          onClick={() => navigate(`/status/view/${e.user.id}`)}
          className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-surface-2"
        >
          <Avatar name={e.user.displayName} src={e.user.avatarUrl} size={52} ring={e.allViewed ? 'seen' : 'new'} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{e.user.displayName}</span>
            <span className="block text-sm text-muted">
              {e.items.length} update{e.items.length > 1 ? 's' : ''} · {timeAgo(e.latestAt)}
            </span>
          </span>
        </button>
      ))}
    </>
  );
}

/* ================= Text composer ================= */
export function StatusComposerPage() {
  const navigate = useNavigate();
  const [body, setBody] = useState('');
  const [bg, setBg] = useState<StatusBackground>('violet');
  const [musicTrackId, setMusicTrackId] = useState<StatusMusicTrackId | null>(null);
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [busy, setBusy] = useState(false);

  async function share() {
    setBusy(true);
    try {
      await useStatus.getState().postText(body.trim(), bg, musicTrackId, expiresInHours, musicFile);
      toast({ title: 'Status shared', body: `Visible to your contacts for ${expiresInHours} hour${expiresInHours === 1 ? '' : 's'}.`, tone: 'success' });
      navigate('/status', { replace: true });
    } catch (e) {
      toast({ title: 'Couldn’t share status', body: errMsg(e), tone: 'error' });
      setBusy(false);
    }
  }

  return (
    <div className={cn('fixed inset-0 z-40 flex flex-col text-white', `story-bg-${bg}`)}>
      <div className="flex items-center justify-between p-3">
        <IconButton icon="x" label="Discard" className="text-white hover:bg-white/15" onClick={() => navigate('/status')} />
        <div className="flex gap-2" role="radiogroup" aria-label="Background">
          {STATUS_BACKGROUNDS.map((b) => (
            <button
              key={b}
              role="radio"
              aria-checked={bg === b}
              aria-label={b}
              onClick={() => setBg(b)}
              className={cn('h-7 w-7 rounded-full border-2', `story-bg-${b}`, bg === b ? 'border-white' : 'border-white/30')}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center px-6">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 700))}
          autoFocus
          placeholder="Type a status"
          aria-label="Status text"
          className="w-full max-w-lg resize-none bg-transparent text-center text-3xl font-bold leading-snug text-white placeholder:text-white/60 focus:outline-none"
          rows={5}
        />
      </div>
      <div className="px-4 pb-2">
        <StatusMusicPicker value={musicTrackId} onChange={setMusicTrackId} file={musicFile} onFileChange={setMusicFile} />
      </div>
      <div className="safe-bottom flex items-center justify-between p-4">
        <label className="flex items-center gap-2 text-sm text-white/80">Expires in <input type="number" min={1} max={168} value={expiresInHours} onChange={(e) => setExpiresInHours(Math.min(168, Math.max(1, Number(e.target.value) || 1)))} className="w-16 rounded-lg border border-white/20 bg-black/20 px-2 py-1 text-center" /> h <span className="text-xs text-white/60">default 24</span></label>
        <Button variant="onMedia" icon="send" loading={busy} disabled={!body.trim()} onClick={share}>
          Share
        </Button>
      </div>
    </div>
  );
}

/* ================= Viewer ================= */
export function StatusViewerPage() {
  const { userId = '' } = useParams();
  const navigate = useNavigate();
  const me = useAuth((s) => s.me)!;
  const { mine, feed, loaded } = useStatus();
  const isMine = userId === me.id;
  const entry = isMine ? { user: me as PublicUser, items: mine } : feed.find((e) => e.user.id === userId);
  const items = entry?.items ?? [];
  const [index, setIndex] = useState(() => {
    const firstUnseen = items.findIndex((i) => !i.viewed);
    return isMine || firstUnseen < 0 ? 0 : firstUnseen;
  });
  const [paused, setPaused] = useState(false);
  const [viewers, setViewers] = useState<StatusViewer[] | null>(null);
  const [videoProgress, setVideoProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const item = items[Math.min(index, items.length - 1)];

  useEffect(() => {
    if (!loaded) void useStatus.getState().load().catch(() => undefined);
  }, [loaded]);

  // Mark as viewed and auto-advance.
  useEffect(() => {
    if (!item) return;
    if (!isMine) useStatus.getState().view(item);
    if (paused || viewers || item.kind === 'video') return;
    const t = setTimeout(() => next(), STORY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, paused, viewers]);

  useEffect(() => {
    setVideoProgress(0);
  }, [item?.id]);

  useEffect(() => {
    if (!item?.musicTrackId || item.musicFile || paused || viewers) return;
    const player = playStatusMusic(item.musicTrackId);
    return () => player.stop();
  }, [item?.id, item?.musicTrackId, paused, viewers]);

  useEffect(() => {
    if (!item?.musicFile?.url || paused || viewers) return;
    const audio = new Audio(item.musicFile.url);
    audio.loop = true;
    void audio.play().catch(() => undefined);
    return () => { audio.pause(); audio.currentTime = 0; };
  }, [item?.id, item?.musicFile?.url, paused, viewers]);

  useEffect(() => {
    if (viewers) videoRef.current?.pause();
  }, [viewers]);

  function close() {
    navigate('/status', { replace: true });
  }
  function next() {
    if (index < items.length - 1) setIndex(index + 1);
    else {
      // Continue with the next unseen contact, like flipping pages.
      const nextEntry = !isMine && feed.find((e) => e.user.id !== userId && !e.allViewed);
      if (nextEntry) {
        setIndex(0);
        navigate(`/status/view/${nextEntry.user.id}`, { replace: true });
      } else close();
    }
  }
  function prev() {
    if (index > 0) setIndex(index - 1);
  }

  useEffect(() => {
    setIndex(0);
    setViewers(null);
  }, [userId]);

  if (!loaded) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black text-white">
        <Spinner />
      </div>
    );
  }
  if (!entry || !item) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-[#0e0c1d] p-6 text-center text-white">
        <Icon name="stories" size={40} />
        <p className="font-semibold">This status is no longer available.</p>
        <Button onClick={close}>Back to Status</Button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black text-white" role="dialog" aria-label={`${entry.user.displayName}’s status`}>
      <div className={cn('absolute inset-0', item.kind === 'text' && `story-bg-${item.bg}`)}>
        {item.kind === 'image' && item.file && <img src={item.file.url} alt={item.body || 'Status photo'} className="h-full w-full object-contain" />}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/60 to-transparent" />

      {/* progress */}
      <div className="safe-top relative flex gap-1 px-3 pt-3">
        {items.map((it, i) => (
          <span key={it.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/30">
            <span
              key={`${it.id}-${i === index ? 'on' : 'off'}`}
              className={cn('block h-full bg-white', i === index && item.kind !== 'video' && 'story-progress', i === index && (paused || viewers) && 'paused')}
              style={i === index ? item.kind === 'video' ? { transform: `scaleX(${videoProgress})`, transformOrigin: 'left' } : { animationDuration: `${STORY_MS}ms` } : { transform: i < index ? 'scaleX(1)' : 'scaleX(0)', transformOrigin: 'left' }}
            />
          </span>
        ))}
      </div>
      <div className="relative flex items-center gap-3 px-3 py-3">
        <Avatar name={entry.user.displayName} src={entry.user.avatarUrl} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{isMine ? 'My status' : entry.user.displayName}</span>
          <span className="text-xs text-white/75">{timeAgo(item.createdAt)}</span>
        </span>
        {isMine && (
          <IconButton
            icon="trash"
            label="Delete this status"
            className="text-white hover:bg-white/15"
            onClick={async () => {
              if (!confirm('Delete this status update?')) return;
              await useStatus.getState().remove(item.id).catch((e) => toast({ title: 'Couldn’t delete', body: errMsg(e), tone: 'error' }));
              if (items.length <= 1) close();
              else setIndex(Math.max(0, index - 1));
            }}
          />
        )}
        <IconButton icon="x" label="Close" className="text-white hover:bg-white/15" onClick={close} />
      </div>

      {item.kind === 'video' ? (
        <div className="relative flex min-h-0 flex-1 flex-col justify-center">
          {item.file ? (
            <video
              key={item.id}
              ref={videoRef}
              src={item.file.url}
              autoPlay
              muted={Boolean(item.musicTrackId)}
              controls
              playsInline
              preload="metadata"
              className="min-h-0 w-full flex-1 bg-black object-contain"
              onTimeUpdate={(event) => {
                const video = event.currentTarget;
                if (video.duration > 0) setVideoProgress(video.currentTime / video.duration);
              }}
              onEnded={next}
              onError={() => toast({ title: 'Couldn’t play video', body: 'Try an MP4 or WebM video.', tone: 'error' })}
            />
          ) : (
            <p className="text-center text-white/75">This video is no longer available.</p>
          )}
          <div className="flex items-center justify-between px-5 py-2">
            <button onClick={prev} className="inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold"><Icon name="back" size={18} /> Previous</button>
            <button onClick={next} className="inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold">Next <Icon name="chevron" size={18} /></button>
          </div>
        </div>
      ) : (
        /* tap zones */
        <div className="relative flex flex-1" onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)} onPointerLeave={() => setPaused(false)}>
          <button className="h-full w-1/3" aria-label="Previous" onClick={prev} />
          <div className="flex h-full w-1/3 items-center justify-center" />
          <button className="h-full w-1/3" aria-label="Next" onClick={next} />
          {item.kind === 'text' && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center whitespace-pre-wrap break-words px-8 text-center text-3xl font-bold leading-snug">
              {item.body}
            </p>
          )}
        </div>
      )}

      <div className="safe-bottom relative px-4 pb-6 pt-2 text-center">
        {(item.kind === 'image' || item.kind === 'video') && item.body && <p className="mb-3 text-[15px]">{item.body}</p>}
        {isMine && (
          <button
            onClick={async () => {
              setViewers(await backend.statusViewers(item.id).catch(() => []));
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold backdrop-blur"
          >
            <Icon name="eye" size={18} /> {item.viewCount ?? 0} view{item.viewCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {viewers && (
        <div className="absolute inset-0 z-10 flex items-end justify-center bg-black/50 md:items-center" onClick={() => setViewers(null)}>
          <div className="pop-in max-h-[60%] w-full max-w-sm overflow-y-auto rounded-t-3xl bg-surface p-4 text-ink md:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <p className="mb-2 font-bold">Viewed by {viewers.length}</p>
            {viewers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No views yet.</p>
            ) : (
              viewers.map((v) => (
                <div key={v.user.id} className="flex items-center gap-3 py-2">
                  <Avatar name={v.user.displayName} src={v.user.avatarUrl} size={40} />
                  <span className="flex-1 font-semibold">{v.user.displayName}</span>
                  <span className="text-xs text-muted">{formatListTime(v.viewedAt)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
