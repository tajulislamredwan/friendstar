import { getAudioContext, unlockAudio } from './audio.ts';

const PREFS_KEY = 'fs_notify_prefs';

export interface NotifyPrefs {
  desktop: boolean;
  sound: boolean;
  previews: boolean;
}

export function getNotifyPrefs(): NotifyPrefs {
  try {
    return { desktop: true, sound: true, previews: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { desktop: true, sound: true, previews: true };
  }
}
export function setNotifyPrefs(p: NotifyPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

export async function requestDesktopPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

let audioCtx: AudioContext | null = null;
/** A soft two-note "star chime" made with WebAudio — no audio files needed. */
export function playChime() {
  try {
    audioCtx ??= getAudioContext();
    if (!audioCtx) return false;
    if (audioCtx.state !== 'running') {
      void unlockAudio();
      return false;
    }
    const t = audioCtx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.08, t + i * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.35);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(t + i * 0.09);
      osc.stop(t + i * 0.09 + 0.4);
    });
    return true;
  } catch {
    /* audio not available */
    return false;
  }
}

export function showDesktopNotification(title: string, body: string, onClick: () => void) {
  const prefs = getNotifyPrefs();
  if (!prefs.desktop || !notificationsSupported() || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body: prefs.previews ? body : 'New message', icon: '/favicon.svg', tag: title });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}
