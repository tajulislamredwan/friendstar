import { create } from 'zustand';
import type { StatusBackground, StatusFeedEntry, StatusItem, StatusMusicTrackId } from '@friendstar/shared';
import { backend } from '../api/index.ts';

interface StatusState {
  mine: StatusItem[];
  feed: StatusFeedEntry[];
  loaded: boolean;
  load(): Promise<void>;
  postText(body: string, bg: StatusBackground, musicTrackId?: StatusMusicTrackId | null, expiresInHours?: number, musicFile?: File | null): Promise<void>;
  postMedia(file: File, caption: string, musicTrackId?: StatusMusicTrackId | null, expiresInHours?: number, musicFile?: File | null): Promise<void>;
  remove(id: string): Promise<void>;
  /** Optimistically mark a story seen and tell the server. */
  view(item: StatusItem): void;
  reset(): void;
}

let loadPromise: Promise<void> | null = null;

export const useStatus = create<StatusState>((set, get) => ({
  mine: [],
  feed: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = backend.listStatuses().then(({ mine, feed }) => set({ mine, feed, loaded: true })).finally(() => { loadPromise = null; });
    return loadPromise;
  },
  async postText(body, bg, musicTrackId, expiresInHours = 24, musicFile = null) {
    const item = await backend.postTextStatus(body, bg, musicTrackId, expiresInHours, musicFile);
    set((s) => ({ mine: [...s.mine, item] }));
  },
  async postMedia(file, caption, musicTrackId, expiresInHours = 24, musicFile = null) {
    const item = await backend.postStatusMedia(file, caption, musicTrackId, expiresInHours, musicFile);
    set((s) => ({ mine: [...s.mine, item] }));
  },
  async remove(id) {
    await backend.deleteStatus(id);
    set((s) => ({ mine: s.mine.filter((m) => m.id !== id) }));
  },
  view(item) {
    if (item.viewed || get().mine.some((m) => m.id === item.id)) return;
    set((s) => ({
      feed: s.feed.map((e) => {
        if (e.user.id !== item.userId) return e;
        const items = e.items.map((i) => (i.id === item.id ? { ...i, viewed: true } : i));
        return { ...e, items, allViewed: items.every((i) => i.viewed) };
      }),
    }));
    void backend.viewStatus(item.id).catch(() => undefined);
  },
  reset() {
    set({ mine: [], feed: [], loaded: false });
  },
}));
