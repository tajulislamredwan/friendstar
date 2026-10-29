import { getAudioContext, unlockAudio } from './audio.ts';

/** Synthesised ring tones; a shared context is unlocked by the first app gesture. */
export interface Ringtone {
  stop(): void;
}

export function startRingtone(kind: 'incoming' | 'outgoing'): Ringtone {
  const audio = getAudioContext();
  if (!audio) return { stop() {} };
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const beep = (freq: number, at: number, len: number) => {
    if (stopped) return;
    const osc = audio.createOscillator();
    const env = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.7, at + 0.02);
    env.gain.setValueAtTime(0.7, at + len - 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, at + len);
    osc.connect(env).connect(audio.destination);
    osc.start(at);
    osc.stop(at + len);
  };

  const pattern = () => {
    if (stopped || audio.state !== 'running') return;
    const t = audio.currentTime + 0.05;
    if (kind === 'incoming') {
      beep(784, t, 0.18);
      beep(988, t + 0.22, 0.18);
      beep(1175, t + 0.44, 0.28);
    } else {
      beep(440, t, 0.9);
    }
  };

  if (audio.state === 'running') pattern();
  else void unlockAudio().then((ok) => ok && pattern());
  timer = setInterval(pattern, kind === 'incoming' ? 1600 : 3000);
  if (kind === 'incoming' && typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.([300, 200, 300]);

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
