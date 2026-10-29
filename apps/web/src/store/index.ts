import { create } from 'zustand';
import type {
  AppNotification,
  ConversationSummary,
  LoginInput,
  Me,
  Message,
  MessageStatus,
  RegisterInput,
} from '@friendstar/shared';
import { backend } from '../api/index.ts';
import { ApiError } from '../api/index.ts';
import { useStatus } from './status.ts';
import { newClientId } from '../lib/format.ts';
import { clearOfflineSnapshot, readOfflineMe, readOfflineSnapshot, saveOfflineSnapshot, saveOfflineUser } from '../lib/offline-cache.ts';

/* ================= Auth ================= */
let restoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
let offlinePersistTimer: ReturnType<typeof setTimeout> | null = null;
interface AuthState {
  status: 'loading' | 'guest' | 'authed';
  me: Me | null;
  init(): Promise<void>;
  login(input: LoginInput): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  logout(): Promise<void>;
  setMe(me: Me): void;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  me: null,
  async init() {
    try {
      const me = await backend.restoreSession();
      if (restoreRetryTimer) clearTimeout(restoreRetryTimer);
      restoreRetryTimer = null;
      if (me) {
        set({ me, status: 'authed' });
        void saveOfflineUser(me);
      } else if (!navigator.onLine) {
        const cachedMe = await readOfflineMe();
        set(cachedMe ? { me: cachedMe, status: 'authed' } : { me: null, status: 'guest' });
      } else set({ me: null, status: 'guest' });
    } catch (error) {
      if ((error instanceof ApiError && (error.status === 0 || error.status >= 500)) || !navigator.onLine) {
        const cachedMe = await readOfflineMe();
        if (cachedMe) set({ me: cachedMe, status: 'authed' });
        else set({ me: null, status: 'loading' });
        if (!restoreRetryTimer) {
          restoreRetryTimer = setTimeout(() => {
            restoreRetryTimer = null;
            void useAuth.getState().init();
          }, 4000);
        }
        return;
      }
      set({ me: null, status: 'guest' });
    }
  },
  async login(input) {
    const me = await backend.login(input);
    set({ me, status: 'authed' });
    void saveOfflineUser(me);
  },
  async register(input) {
    const me = await backend.register(input);
    set({ me, status: 'authed' });
    void saveOfflineUser(me);
  },
  async logout() {
    const userId = get().me?.id ?? null;
    await backend.logout();
    if (offlinePersistTimer) clearTimeout(offlinePersistTimer);
    offlinePersistTimer = null;
    set({ me: null, status: 'guest' });
    useChat.getState().reset();
    useNotifications.getState().reset();
    useStatus.getState().reset();
    await clearOfflineSnapshot(userId);
  },
  setMe(me) {
    set({ me });
    void saveOfflineUser(me);
  },
}));

/* ================= Chat ================= */
const RANK: Record<MessageStatus, number> = { failed: 0, sending: 0, sent: 1, delivered: 2, read: 3 };

interface PendingSend {
  conversationId: string;
  body: string;
  file?: File;
}

interface ChatState {
  conversations: Record<string, ConversationSummary>;
  loaded: boolean;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, number>; // conversationId -> expiry timestamp
  recording: Record<string, { userId: string; expiresAt: number }>;
  activeId: string | null;
  pending: Record<string, PendingSend>;

  loadConversations(): Promise<void>;
  upsertConversation(c: ConversationSummary): void;
  removeConversation(id: string): void;
  ensureConversation(id: string): Promise<ConversationSummary>;
  loadMessages(id: string): Promise<void>;
  loadOlder(id: string): Promise<void>;
  sendText(id: string, body: string): Promise<void>;
  sendFile(id: string, file: File, caption: string): Promise<void>;
  retry(clientId: string): Promise<void>;
  receive(message: Message, conversation: ConversationSummary): void;
  applyStatus(conversationId: string, ids: string[], status: 'delivered' | 'read'): void;
  applyPresence(userId: string, online: boolean | null, lastSeenAt: string | null): void;
  setTyping(conversationId: string, isTyping: boolean): void;
  setRecording(conversationId: string, userId: string, isRecording: boolean): void;
  setActive(id: string | null): void;
  markRead(id: string): Promise<void>;
  reset(): void;
}

function mergeMessage(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id || x.clientId === m.clientId);
  if (i === -1) return [...list, m].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const prev = list[i];
  const status = RANK[m.status] >= RANK[prev.status] || prev.status === 'failed' || prev.status === 'sending' ? m.status : prev.status;
  // Keep the local preview URL until the server copy has loaded once, to avoid a flash.
  const next = [...list];
  next[i] = { ...m, status };
  return next;
}

const emptyChat = {
  conversations: {},
  loaded: false,
  messages: {},
  hasMore: {},
  typing: {},
  recording: {},
  activeId: null,
  pending: {},
};

export const useChat = create<ChatState>((set, get) => {
  function localMessage(conversationId: string, clientId: string, body: string, file?: File): Message {
    const me = useAuth.getState().me!;
    const isImage = !!file && file.type.startsWith('image/');
    return {
      id: `local:${clientId}`,
      clientId,
      conversationId,
      senderId: me.id,
      kind: file ? (isImage ? 'image' : 'file') : 'text',
      body,
      file: file
        ? { id: 'local', name: file.name, mimeType: file.type, size: file.size, url: URL.createObjectURL(file), width: null, height: null }
        : null,
      createdAt: new Date().toISOString(),
      status: 'sending',
    };
  }

  function putMessage(m: Message) {
    set((s) => ({ messages: { ...s.messages, [m.conversationId]: mergeMessage(s.messages[m.conversationId] ?? [], m) } }));
  }

  async function deliver(clientId: string) {
    const p = get().pending[clientId];
    if (!p) return;
    try {
      const saved = p.file
        ? await backend.sendFile(p.conversationId, clientId, p.file, p.body)
        : await backend.sendText(p.conversationId, clientId, p.body);
      putMessage(saved);
      set((s) => {
        const pending = { ...s.pending };
        delete pending[clientId];
        const c = s.conversations[p.conversationId];
        return {
          pending,
          conversations: c
            ? { ...s.conversations, [c.id]: { ...c, lastMessage: saved, updatedAt: saved.createdAt } }
            : s.conversations,
        };
      });
    } catch (err) {
      set((s) => ({
        messages: {
          ...s.messages,
          [p.conversationId]: (s.messages[p.conversationId] ?? []).map((m) =>
            m.clientId === clientId ? { ...m, status: 'failed' as const } : m,
          ),
        },
      }));
      throw err;
    }
  }

  return {
    ...emptyChat,

    async loadConversations() {
      try {
        const list = await backend.listConversations();
        set({ conversations: Object.fromEntries(list.map((c) => [c.id, c])), loaded: true });
      } catch (error) {
        const userId = useAuth.getState().me?.id;
        const cached = userId ? await readOfflineSnapshot(userId) : null;
        if (!cached) throw error;
        set({ conversations: Object.fromEntries(cached.conversations.map((c) => [c.id, c])), loaded: true });
      }
    },
    upsertConversation(c) {
      set((s) => ({ conversations: { ...s.conversations, [c.id]: c } }));
    },
    removeConversation(id) {
      set((s) => {
        const conversations = { ...s.conversations };
        const messages = { ...s.messages };
        delete conversations[id];
        delete messages[id];
        return { conversations, messages, activeId: s.activeId === id ? null : s.activeId };
      });
    },
    async ensureConversation(id) {
      const existing = get().conversations[id];
      if (existing) return existing;
      try {
        const c = await backend.getConversation(id);
        get().upsertConversation(c);
        return c;
      } catch (error) {
        const userId = useAuth.getState().me?.id;
        const cached = userId ? await readOfflineSnapshot(userId) : null;
        const c = cached?.conversations.find((item) => item.id === id);
        if (!c) throw error;
        get().upsertConversation(c);
        return c;
      }
    },
    async loadMessages(id) {
      try {
        const { messages, hasMore } = await backend.listMessages(id);
        set((s) => {
          // Keep unsent local messages for this conversation.
          const local = (s.messages[id] ?? []).filter((m) => m.status === 'sending' || m.status === 'failed');
          let merged = messages;
          for (const m of local) merged = mergeMessage(merged, m);
          return { messages: { ...s.messages, [id]: merged }, hasMore: { ...s.hasMore, [id]: hasMore } };
        });
      } catch (error) {
        const userId = useAuth.getState().me?.id;
        const cached = userId ? await readOfflineSnapshot(userId) : null;
        const messages = cached?.messages[id];
        if (!messages) throw error;
        set((s) => ({ messages: { ...s.messages, [id]: messages }, hasMore: { ...s.hasMore, [id]: messages.length >= 200 } }));
      }
    },
    async loadOlder(id) {
      const first = get().messages[id]?.find((m) => !m.id.startsWith('local:'));
      if (!first) return;
      const { messages, hasMore } = await backend.listMessages(id, first.createdAt);
      set((s) => ({
        messages: { ...s.messages, [id]: [...messages, ...(s.messages[id] ?? [])] },
        hasMore: { ...s.hasMore, [id]: hasMore },
      }));
    },
    async sendText(id, body) {
      const clientId = newClientId();
      set((s) => ({ pending: { ...s.pending, [clientId]: { conversationId: id, body } } }));
      putMessage(localMessage(id, clientId, body));
      await deliver(clientId);
    },
    async sendFile(id, file, caption) {
      const clientId = newClientId();
      set((s) => ({ pending: { ...s.pending, [clientId]: { conversationId: id, body: caption, file } } }));
      putMessage(localMessage(id, clientId, caption, file));
      await deliver(clientId);
    },
    async retry(clientId) {
      const p = get().pending[clientId];
      if (!p) return;
      set((s) => ({
        messages: {
          ...s.messages,
          [p.conversationId]: (s.messages[p.conversationId] ?? []).map((m) =>
            m.clientId === clientId ? { ...m, status: 'sending' as const } : m,
          ),
        },
      }));
      await deliver(clientId);
    },
    receive(message, conversation) {
      if (get().messages[message.conversationId]) putMessage(message);
      get().upsertConversation(conversation);
      if (message.senderId !== useAuth.getState().me?.id) get().setTyping(message.conversationId, false);
    },
    applyStatus(conversationId, ids, status) {
      const idSet = new Set(ids);
      set((s) => {
        const list = s.messages[conversationId];
        const c = s.conversations[conversationId];
        const bump = (m: Message) => (idSet.has(m.id) && RANK[status] > RANK[m.status] ? { ...m, status } : m);
        return {
          messages: list ? { ...s.messages, [conversationId]: list.map(bump) } : s.messages,
          conversations:
            c && c.lastMessage ? { ...s.conversations, [conversationId]: { ...c, lastMessage: bump(c.lastMessage) } } : s.conversations,
        };
      });
    },
    applyPresence(userId, online, lastSeenAt) {
      set((s) => {
        const conversations = { ...s.conversations };
        for (const c of Object.values(conversations)) {
          if (c.peer.id === userId) conversations[c.id] = { ...c, peer: { ...c.peer, online, lastSeenAt } };
        }
        return { conversations };
      });
    },
    setTyping(conversationId, isTyping) {
      set((s) => {
        const typing = { ...s.typing };
        if (isTyping) typing[conversationId] = Date.now() + 5000;
        else delete typing[conversationId];
        return { typing };
      });
    },
    setRecording(conversationId, userId, isRecording) {
      set((s) => {
        const recording = { ...s.recording };
        if (isRecording) recording[conversationId] = { userId, expiresAt: Date.now() + 20_000 };
        else if (recording[conversationId]?.userId === userId) delete recording[conversationId];
        return { recording };
      });
    },
    setActive(id) {
      set({ activeId: id });
    },
    async markRead(id) {
      const c = get().conversations[id];
      if (c && c.unreadCount === 0) {
        useNotifications.getState().markConversationRead(id);
        await backend.markRead(id);
        return;
      }
      if (c) get().upsertConversation({ ...c, unreadCount: 0 });
      const fresh = await backend.markRead(id);
      get().upsertConversation(fresh);
      useNotifications.getState().markConversationRead(id);
    },
    reset() {
      set({ ...emptyChat });
    },
  };
});

// Confirmed chats remain readable on this device after a temporary loss of network.
useChat.subscribe(() => {
  if (offlinePersistTimer) clearTimeout(offlinePersistTimer);
  const me = useAuth.getState().me;
  if (!me) return;
  offlinePersistTimer = setTimeout(() => {
    const state = useChat.getState();
    void saveOfflineSnapshot(me, Object.values(state.conversations), state.messages);
  }, 350);
});

export const selectTotalUnread = (s: ChatState) =>
  Object.values(s.conversations).reduce((n, c) => n + (c.unreadCount > 0 ? 1 : 0), 0);

/* ================= Notifications ================= */
interface NotificationState {
  items: AppNotification[];
  unread: number;
  load(): Promise<void>;
  upsert(n: AppNotification, unread: number): void;
  markAllRead(): Promise<void>;
  markOneRead(id: string): Promise<void>;
  markConversationRead(conversationId: string): void;
  reset(): void;
}

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  unread: 0,
  async load() {
    const { notifications, unread } = await backend.listNotifications();
    set({ items: notifications, unread });
  },
  upsert(n, unread) {
    set((s) => ({ items: [n, ...s.items.filter((x) => x.id !== n.id)], unread }));
  },
  async markAllRead() {
    const at = new Date().toISOString();
    set((s) => ({ items: s.items.map((n) => ({ ...n, readAt: n.readAt ?? at })), unread: 0 }));
    await backend.readAllNotifications();
  },
  async markOneRead(id) {
    const previous = get();
    const at = new Date().toISOString();
    const items = previous.items.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: at } : n));
    set({ items, unread: items.filter((n) => !n.readAt).length });
    try {
      const unread = await backend.readNotification(id);
      set({ unread });
    } catch (error) {
      set({ items: previous.items, unread: previous.unread });
      throw error;
    }
  },
  markConversationRead(conversationId) {
    const at = new Date().toISOString();
    const items = get().items.map((n) => (n.conversationId === conversationId && !n.readAt ? { ...n, readAt: at } : n));
    set({ items, unread: items.filter((n) => !n.readAt).length });
  },
  reset() {
    set({ items: [], unread: 0 });
  },
}));

/* ================= Theme ================= */
export type ThemeMode = 'light' | 'dark' | 'system';

function applyTheme(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#17152a' : '#5B4BDB');
}

export const useTheme = create<{ mode: ThemeMode; setMode(m: ThemeMode): void }>((set) => {
  const initial = (localStorage.getItem('fs_theme') as ThemeMode) || 'system';
  applyTheme(initial);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useTheme.getState().mode === 'system') applyTheme('system');
  });
  return {
    mode: initial,
    setMode(mode) {
      localStorage.setItem('fs_theme', mode);
      applyTheme(mode);
      set({ mode });
    },
  };
});

/* ================= Toasts ================= */
export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone?: 'info' | 'error' | 'success';
  onClick?: () => void;
}
let toastSeq = 0;
export const useToasts = create<{ toasts: Toast[]; push(t: Omit<Toast, 'id'>): void; dismiss(id: number): void }>((set, get) => ({
  toasts: [],
  push(t) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id }] }));
    setTimeout(() => get().dismiss(id), 4000);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
export const toast = (t: Omit<Toast, 'id'>) => useToasts.getState().push(t);
