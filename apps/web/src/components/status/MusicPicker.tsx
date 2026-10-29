import { useEffect, useRef, useState } from 'react';
import { LIMITS, STATUS_MUSIC_MIME, type StatusMusicTrackId } from '@friendstar/shared';
import { playStatusMusic, STATUS_MUSIC_TRACKS } from '../../lib/status-music.ts';

export function StatusMusicPicker({ value, onChange, file, onFileChange }: { value: StatusMusicTrackId | null; onChange: (id: StatusMusicTrackId | null) => void; file?: File | null; onFileChange?: (file: File | null) => void }) {
  const player = useRef<ReturnType<typeof playStatusMusic> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) { setFilePreview(null); return; }
    const url = URL.createObjectURL(file); setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function stopPreview() {
    player.current?.stop();
    player.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPreviewing(false);
  }

  useEffect(() => {
    stopPreview();
    return () => {
      player.current?.stop();
      if (timer.current) clearTimeout(timer.current);
    };
    // A selected track change should stop the previous preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function togglePreview() {
    if (!value) return;
    if (previewing) {
      stopPreview();
      return;
    }
    player.current = playStatusMusic(value);
    setPreviewing(true);
    timer.current = setTimeout(stopPreview, 3500);
  }

  return (
    <div className="rounded-2xl border border-line bg-surface-2/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Music library</p>
          <p className="text-xs text-muted">Original instrumental loops · no commercial songs</p>
        </div>
        <button type="button" disabled={!value} onClick={togglePreview} className="rounded-full bg-primary-soft px-3 py-1.5 text-xs font-semibold text-primary disabled:opacity-40">
          {previewing ? 'Stop preview' : 'Preview'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={!value && !file} onClick={() => { onFileChange?.(null); onChange(null); }} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${!value && !file ? 'bg-primary text-on-primary' : 'bg-surface text-muted'}`}>
          No music
        </button>
        {STATUS_MUSIC_TRACKS.map((track) => (
          <button
            type="button"
            key={track.id}
            aria-pressed={value === track.id}
            onClick={() => { onFileChange?.(null); onChange(track.id); }}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${value === track.id ? 'bg-primary text-on-primary' : 'bg-surface text-muted'}`}
          >
            {track.title}
          </button>
        ))}
      </div>
      {onFileChange && (
        <div className="mt-3 border-t border-line pt-3">
          <input ref={input} type="file" accept={STATUS_MUSIC_MIME.join(',')} className="hidden" onChange={(e) => {
            const selected = e.target.files?.[0] ?? null; e.target.value = ''; setError('');
            if (selected && (!STATUS_MUSIC_MIME.includes(selected.type as never) || selected.size > LIMITS.statusMediaBytes)) {
              setError('Choose an MP3, M4A, AAC, OGG, WAV or WebM audio file up to 10 MiB.'); return;
            }
            onFileChange(selected);
            if (selected) onChange(null);
          }} />
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted">{file ? `Device audio · ${file.name}` : 'Or add a song from this device'}</span>
            <div className="flex shrink-0 gap-2">
              <button type="button" onClick={() => input.current?.click()} className="rounded-full bg-surface px-3 py-1.5 text-xs font-semibold text-primary">{file ? 'Change' : 'Choose file'}</button>
              {file && <button type="button" onClick={() => onFileChange(null)} className="rounded-full bg-surface px-3 py-1.5 text-xs font-semibold text-muted">Remove</button>}
            </div>
          </div>
          {file && filePreview && <audio controls preload="metadata" src={filePreview} className="mt-2 h-9 w-full" aria-label="Preview soundtrack" />}
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
