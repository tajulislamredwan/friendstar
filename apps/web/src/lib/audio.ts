let audioContext: AudioContext | null = null;
let unlockInstalled = false;

function createContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioContext) return audioContext;
  try {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return null;
    audioContext = new AudioContextCtor();
    return audioContext;
  } catch {
    return null;
  }
}

export function getAudioContext(): AudioContext | null {
  return createContext();
}

/** Call this from a real tap/click before relying on Web Audio in mobile browsers. */
export async function unlockAudio(): Promise<boolean> {
  const ctx = createContext();
  if (!ctx) return false;
  try {
    if (ctx.state !== 'running') await ctx.resume();
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

/** Unlock once on the first user gesture; the context is reused instead of repeatedly closed. */
export function installAudioUnlock(): () => void {
  if (typeof window === 'undefined' || unlockInstalled) return () => undefined;
  unlockInstalled = true;
  let active = true;
  const events: (keyof WindowEventMap)[] = ['pointerdown', 'touchstart', 'keydown'];
  const onGesture = () => {
    void unlockAudio().then((ok) => {
      if (!ok || !active) return;
      active = false;
      for (const event of events) window.removeEventListener(event, onGesture, true);
    });
  };
  for (const event of events) window.addEventListener(event, onGesture, { capture: true, passive: true });
  return () => {
    active = false;
    for (const event of events) window.removeEventListener(event, onGesture, true);
  };
}
