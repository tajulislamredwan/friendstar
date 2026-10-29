import { getAudioContext, unlockAudio } from './audio.ts';
import type { StatusMusicTrackId } from '@friendstar/shared';

export const STATUS_MUSIC_TRACKS: { id: StatusMusicTrackId; title: string; mood: string; notes: number[]; wave: OscillatorType }[] = [
  { id: 'sunrise', title: 'Sunrise', mood: 'Warm and hopeful', notes: [523.25, 659.25, 783.99, 659.25, 587.33, 698.46, 880, 698.46], wave: 'triangle' },
  { id: 'starlight', title: 'Starlight', mood: 'Soft and dreamy', notes: [440, 523.25, 659.25, 783.99, 659.25, 523.25, 493.88, 587.33], wave: 'sine' },
  { id: 'journey', title: 'Little Journey', mood: 'Bright and playful', notes: [392, 493.88, 587.33, 698.46, 783.99, 698.46, 587.33, 493.88], wave: 'triangle' },
  { id: 'moonlight', title: 'Moonlight', mood: 'Calm and reflective', notes: [392, 466.16, 587.33, 698.46, 587.33, 466.16, 349.23, 440], wave: 'sine' },
];

export function playStatusMusic(id: StatusMusicTrackId): { stop(): void } {
  const track = STATUS_MUSIC_TRACKS.find((item) => item.id === id);
  const ctx = getAudioContext();
  if (!track || !ctx) return { stop() {} };
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const playPhrase = () => {
    if (stopped || ctx.state !== 'running') return;
    const beat = 0.42;
    const start = ctx.currentTime + 0.05;
    track.notes.forEach((frequency, i) => {
      const at = start + i * beat;
      const oscillator = ctx.createOscillator();
      const envelope = ctx.createGain();
      oscillator.type = track.wave;
      oscillator.frequency.setValueAtTime(frequency, at);
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(0.035, at + 0.025);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + beat * 0.78);
      oscillator.connect(envelope).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + beat * 0.8);
    });
  };

  const start = () => {
    if (stopped || ctx.state !== 'running') return;
    playPhrase();
    timer = setInterval(playPhrase, track.notes.length * 0.42 * 1000);
  };
  if (ctx.state === 'running') start();
  else void unlockAudio().then((ok) => ok && start());

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
