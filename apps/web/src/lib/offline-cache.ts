import type { ConversationSummary, Me, Message } from '@friendstar/shared';

export interface OfflineSnapshot {
  userId: string;
  me: Me;
  conversations: ConversationSummary[];
  messages: Record<string, Message[]>;
  savedAt: number;
}

const DB_NAME = 'friendstar-offline-v1';
const STORE_NAME = 'snapshots';
const CURRENT_USER_KEY = 'fs_offline_user';
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 200;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Offline storage is unavailable'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'userId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open offline storage'));
      request.onblocked = () => reject(new Error('Offline storage upgrade is blocked'));
    });
  }
  return dbPromise;
}

function getSnapshot(db: IDBDatabase, userId: string): Promise<OfflineSnapshot | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(userId);
    request.onsuccess = () => resolve((request.result as OfflineSnapshot | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('Could not read offline data'));
  });
}

function putSnapshot(db: IDBDatabase, snapshot: OfflineSnapshot): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(snapshot);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save offline data'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Offline save was cancelled'));
  });
}

function deleteSnapshot(db: IDBDatabase, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(userId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear offline data'));
  });
}

function withoutSignedMediaUrls(message: Message): Message {
  return message.file ? { ...message, file: { ...message.file, url: '' } } : message;
}

export async function readOfflineSnapshot(userId: string): Promise<OfflineSnapshot | null> {
  try {
    return await getSnapshot(await openDb(), userId);
  } catch {
    return null;
  }
}

export async function readOfflineMe(): Promise<Me | null> {
  try {
    const userId = localStorage.getItem(CURRENT_USER_KEY);
    if (!userId) return null;
    return (await readOfflineSnapshot(userId))?.me ?? null;
  } catch {
    return null;
  }
}

export async function saveOfflineUser(me: Me): Promise<void> {
  try {
    const db = await openDb();
    const old = await getSnapshot(db, me.id);
    await putSnapshot(db, {
      userId: me.id,
      me,
      conversations: old?.conversations ?? [],
      messages: old?.messages ?? {},
      savedAt: Date.now(),
    });
    localStorage.setItem(CURRENT_USER_KEY, me.id);
  } catch {
    // Best-effort only; authentication must work even when browser storage is disabled.
  }
}

export async function saveOfflineSnapshot(me: Me, conversations: ConversationSummary[], messages: Record<string, Message[]>): Promise<void> {
  try {
    const db = await openDb();
    const old = await getSnapshot(db, me.id);
    const safeMessages: Record<string, Message[]> = {};
    for (const [conversationId, items] of Object.entries(messages)) {
      safeMessages[conversationId] = items
        .filter((message) => !message.id.startsWith('local:') && message.status !== 'sending' && message.status !== 'failed')
        .slice(-MAX_MESSAGES_PER_CONVERSATION)
        .map(withoutSignedMediaUrls);
    }
    const safeConversations = conversations
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_CONVERSATIONS)
      .map((conversation) => ({
        ...conversation,
        lastMessage: conversation.lastMessage ? withoutSignedMediaUrls(conversation.lastMessage) : null,
      }));
    const validConversationIds = new Set(safeConversations.map((conversation) => conversation.id));
    const retainedMessages = Object.fromEntries(Object.entries(old?.messages ?? {}).filter(([id]) => validConversationIds.has(id)));
    await putSnapshot(db, {
      userId: me.id,
      me,
      conversations: safeConversations,
      messages: { ...retainedMessages, ...safeMessages },
      savedAt: Date.now(),
    });
    localStorage.setItem(CURRENT_USER_KEY, me.id);
  } catch {
    // Offline persistence is best-effort and must never interrupt live chat.
  }
}

export async function clearOfflineSnapshot(userId: string | null): Promise<void> {
  try {
    if (userId) await deleteSnapshot(await openDb(), userId);
    if (!userId || localStorage.getItem(CURRENT_USER_KEY) === userId) localStorage.removeItem(CURRENT_USER_KEY);
  } catch {
    try { localStorage.removeItem(CURRENT_USER_KEY); } catch { /* ignore */ }
  }
}
