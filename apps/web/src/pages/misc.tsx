import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MessageHit, PublicUser } from '@friendstar/shared';
import { ApiError, backend } from '../api/index.ts';
import { Page, PageHeader } from '../components/layout/index.tsx';
import { Avatar, Button, EmptyState, SearchInput, Spinner } from '../components/ui/index.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import { cn, formatListTime, messagePreview } from '../lib/format.ts';
import { useDebounced } from '../lib/hooks.ts';
import { toast, useChat, useNotifications } from '../store/index.ts';
import { UserRow } from './chats.tsx';

/* ================= Search ================= */
function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return <>{text}</>;
  const start = Math.max(0, i - 30);
  return (
    <>
      {start > 0 && '…'}
      {text.slice(start, i)}
      <mark className="rounded bg-star/30 px-0.5 text-inherit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function SearchPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const [data, setData] = useState<{ users: PublicUser[]; messages: MessageHit[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!term) return setData(null);
    let alive = true;
    setLoading(true);
    backend
      .search(term)
      .then((r) => alive && setData(r))
      .catch(() => alive && setData({ users: [], messages: [] }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [term]);

  async function openUser(u: PublicUser) {
    try {
      const c = await backend.openConversation(u.id);
      useChat.getState().upsertConversation(c);
      navigate(`/chats/${c.id}`);
    } catch (e) {
      toast({ title: 'Couldn’t open chat', body: e instanceof ApiError ? e.message : undefined, tone: 'error' });
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Search">
        <SearchInput value={q} onChange={setQ} placeholder="Name, email, FriendStar ID, messages" autoFocus />
      </PageHeader>
      <Page className="mx-auto w-full max-w-2xl px-2 py-2">
        {!term ? (
          <EmptyState icon="search" title="Search FriendStar" body="Find anyone by name, @username, full email or FriendStar ID (like FS-7K2QX9), and search your messages and shared files." />
        ) : loading && !data ? (
          <div className="flex justify-center py-16 text-primary">
            <Spinner />
          </div>
        ) : data && data.users.length + data.messages.length === 0 ? (
          <EmptyState icon="search" title={`No results for “${term}”`} body="Try a different word or check the spelling." />
        ) : (
          data && (
            <>
              {data.users.length > 0 && <p className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-wider text-muted">People</p>}
              {data.users.map((u) => (
                <UserRow key={u.id} user={u} onClick={() => openUser(u)} />
              ))}
              {data.messages.length > 0 && <p className="px-3 pb-1 pt-4 text-xs font-bold uppercase tracking-wider text-muted">Messages</p>}
              {data.messages.map((h) => (
                <button
                  key={h.message.id}
                  onClick={() => navigate(`/chats/${h.conversationId}?m=${h.message.id}`)}
                  className="flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-left hover:bg-surface-2"
                >
                  <Avatar name={h.peer.displayName} src={h.peer.avatarUrl} size={44} />
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between gap-2">
                      <span className="truncate font-semibold">{h.peer.displayName}</span>
                      <span className="shrink-0 text-xs text-muted">{formatListTime(h.message.createdAt)}</span>
                    </span>
                    <span className="line-clamp-2 text-sm text-muted">
                      <Highlight text={h.message.kind === 'text' ? h.message.body : messagePreview(h.message)} q={term} />
                    </span>
                  </span>
                </button>
              ))}
            </>
          )
        )}
      </Page>
    </div>
  );
}

/* ================= Notifications ================= */
export function NotificationsPage() {
  const navigate = useNavigate();
  const { items, unread, load, markAllRead, markOneRead } = useNotifications();
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Notifications"
        actions={
          unread > 0 && (
            <Button variant="ghost" className="h-9 px-3 text-sm text-primary" onClick={() => void markAllRead()}>
              Mark all read
            </Button>
          )
        }
      />
      <Page className="mx-auto w-full max-w-2xl px-2 py-2">
        {items.length === 0 ? (
          <EmptyState icon="bell" title="You’re all caught up" body="New messages and updates will show up here." />
        ) : (
          items.map((n) => (
            <div key={n.id} className={cn('rounded-2xl transition hover:bg-surface-2', !n.readAt && 'bg-primary-soft/60')}>
            <button
              onClick={() => {
                void markOneRead(n.id).catch(() => undefined);
                if (n.conversationId) navigate(`/chats/${n.conversationId}`);
              }}
              className="flex w-full items-start gap-3 px-3 py-3 text-left"
            >
              <span className={cn('mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl', n.type === 'system' || n.type === 'announcement' ? 'bg-star/20 text-[#9a5b00] dark:text-star' : 'bg-primary-soft text-primary')}>
                <Icon name={n.type === 'system' || n.type === 'announcement' ? 'star' : 'chat'} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex justify-between gap-2">
                  <span className={cn('truncate', n.readAt ? 'font-medium' : 'font-bold')}>{n.title}</span>
                  <span className="shrink-0 text-xs text-muted">{formatListTime(n.createdAt)}</span>
                </span>
                {n.type === 'announcement' && <span className="mt-0.5 block text-[10px] font-bold uppercase tracking-wide text-primary">FriendStar update</span>}
                <span className={cn('text-sm text-muted', n.type === 'announcement' ? 'mt-1 block whitespace-pre-wrap break-words' : 'line-clamp-2')}>{n.body}</span>
              </span>
              {!n.readAt && <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-star" aria-label="unread" />}
            </button>
            {n.file && <a href={`${n.file.url}&download=1`} download={n.file.name} onClick={() => void markOneRead(n.id).catch(() => undefined)} className="ml-16 mb-3 inline-flex max-w-[calc(100%-4rem)] items-center gap-2 truncate rounded-xl bg-surface-2 px-3 py-2 text-xs font-semibold text-primary"><Icon name="file" size={15} /><span className="truncate">{n.file.name}</span></a>}
            </div>
          ))
        )}
      </Page>
    </div>
  );
}
