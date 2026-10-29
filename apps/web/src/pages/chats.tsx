import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ConversationSummary, PublicUser } from '@friendstar/shared';
import { ApiError, backend } from '../api/index.ts';
import { Composer, ConversationItem, DayDivider, MessageBubble, TypingDots } from '../components/chat/index.tsx';
import { PageHeader } from '../components/layout/index.tsx';
import { Avatar, Button, CountBadge, EmptyState, IconButton, Logo, SearchInput, Spinner } from '../components/ui/index.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import { cn, dayLabel, presenceText } from '../lib/format.ts';
import { useDebounced } from '../lib/hooks.ts';
import { toast, useAuth, useChat, useNotifications } from '../store/index.ts';
import { callUser } from '../store/call.ts';
import { GroupInfoPage } from './groups.tsx';
import { BotBadge, FriendIdChip, PersonRow, shareProfile } from '../components/people/index.tsx';
import { GroupCallBanner, useJoinGroupCall } from '../components/call/GroupCallScreen.tsx';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

/* ================= Layout: list + pane ================= */
export function ChatsLayout() {
  const { pathname } = useLocation();
  const atRoot = pathname === '/';
  return (
    <div className="flex h-full">
      <section className={cn('h-full w-full flex-col border-r border-line bg-surface md:flex md:w-[360px] md:shrink-0 lg:w-[400px]', atRoot ? 'flex' : 'hidden')}>
        <ChatList />
      </section>
      <section className={cn('h-full min-w-0 flex-1', atRoot ? 'hidden md:block' : 'block')}>
        <Outlet />
      </section>
    </div>
  );
}

function ChatList() {
  const navigate = useNavigate();
  const me = useAuth((s) => s.me)!;
  const { conversations, loaded, activeId, typing } = useChat();
  const [filter, setFilter] = useState('');
  const alerts = useNotifications((s) => s.unread);
  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return Object.values(conversations)
      .filter((c) => c.lastMessage || c.kind === 'group' || c.id === activeId)
      .filter((c) => !f || c.peer.displayName.toLowerCase().includes(f) || c.peer.username.includes(f))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [conversations, filter, activeId]);

  return (
    <div className="relative flex h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Logo size={30} className="md:hidden" /> Chats
          </span>
        }
        actions={
          <>
            <IconButton icon="search" label="Search" onClick={() => navigate('/search')} className="md:hidden" />
            <span className="relative md:hidden">
              <IconButton icon="bell" label="Alerts" onClick={() => navigate('/notifications')} />
              <CountBadge count={alerts} className="pointer-events-none absolute right-0.5 top-0.5" />
            </span>
            <IconButton icon="users" label="New group" onClick={() => navigate('/groups/new')} />
            <IconButton icon="edit" label="New chat" onClick={() => navigate('/new')} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter chats" />
      </PageHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!loaded ? (
          <div className="flex justify-center py-16 text-primary">
            <Spinner />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon="chat"
            title={filter ? 'No chats match' : 'No chats yet'}
            body={filter ? 'Try another name.' : 'Find friends by name, email or FriendStar ID and say hello.'}
            action={!filter && <Button icon="people" onClick={() => navigate('/people')}>Find people</Button>}
          />
        ) : (
          list.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              meId={me.id}
              active={c.id === activeId}
              typing={(typing[c.id] ?? 0) > Date.now()}
              onClick={() => navigate(`/chats/${c.id}`)}
            />
          ))
        )}
      </div>
      <button
        onClick={() => navigate('/new')}
        aria-label="New chat"
        className="absolute bottom-5 right-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-on-primary shadow-lg shadow-primary/30 transition active:scale-95 md:hidden"
      >
        <Icon name="plus" size={26} />
      </button>
    </div>
  );
}

export function NoChatSelected() {
  return (
    <div className="chat-bg flex h-full flex-col items-center justify-center p-8 text-center">
      <Logo size={72} />
      <h2 className="mt-6 text-2xl font-extrabold tracking-tight">Pick a chat to start</h2>
      <p className="mt-2 max-w-sm text-sm text-muted">Your conversations appear on the left. Messages are delivered instantly and you’ll see when they’re read.</p>
    </div>
  );
}

/* ================= Chat room ================= */
export function ChatRoomPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const highlightId = params.get('m');
  const navigate = useNavigate();
  const me = useAuth((s) => s.me)!;
  const joinGroupCall = useJoinGroupCall();
  const conversation = useChat((s) => s.conversations[id]);
  const messages = useChat((s) => s.messages[id]);
  const hasMore = useChat((s) => s.hasMore[id]);
  const typing = useChat((s) => (s.typing[id] ?? 0) > Date.now());
  const recordingState = useChat((s) => s.recording[id]);
  const recording = !!recordingState && recordingState.expiresAt > Date.now();
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const chat = useChat.getState();
    chat.setActive(id);
    setError(null);
    stickToBottom.current = true;
    chat
      .ensureConversation(id)
      .then(() => chat.loadMessages(id))
      .then(() => {
        if (document.visibilityState === 'visible') return chat.markRead(id).catch(() => undefined);
      })
      .catch((e) => setError(errMsg(e)));
    return () => useChat.getState().setActive(null);
  }, [id]);

  // Keep pinned to the newest message unless the user scrolled up to read history.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    if (highlightId && document.getElementById(`msg-${highlightId}`)) {
      document.getElementById(`msg-${highlightId}`)!.scrollIntoView({ block: 'center' });
      return;
    }
    const last = messages[messages.length - 1];
    if (stickToBottom.current || last?.senderId === me.id) el.scrollTop = el.scrollHeight;
  }, [messages?.length, typing, highlightId, me.id, messages]);

  if (error) {
    return (
      <div className="flex h-full flex-col bg-surface">
        <PageHeader title="Chat" back="/" />
        <EmptyState icon="alert" title="Can’t open this chat" body={error} action={<Button onClick={() => navigate('/')}>Back to chats</Button>} />
      </div>
    );
  }
  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center text-primary">
        <Spinner />
      </div>
    );
  }

  const peer = conversation.peer;
  const isGroup = conversation.kind === 'group';
  const members = conversation.group?.members ?? [];
  const memberLine = isGroup
    ? members
        .map((u) => (u.id === me.id ? 'You' : u.displayName.split(' ')[0]))
        .sort((a, b) => (a === 'You' ? 1 : b === 'You' ? -1 : a.localeCompare(b)))
        .join(', ')
    : null;
  const status = typing ? null : isGroup ? memberLine : presenceText(peer.online, peer.lastSeenAt);
  const nameOf = (userId: string) => members.find((u) => u.id === userId)?.displayName ?? 'Former member';
  const recorderName = recordingState ? (isGroup ? nameOf(recordingState.userId).split(' ')[0] : peer.displayName.split(' ')[0]) : '';
  const call = (media: 'audio' | 'video') =>
    isGroup ? void joinGroupCall(id, media) : void callUser(id, peer, media, (msg) => toast({ title: 'Can’t start the call', body: msg, tone: 'error' }));
  const canCall = conversation.canMessage && !peer.bot;

  async function loadOlder() {
    const el = scroller.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setLoadingOlder(true);
    stickToBottom.current = false;
    await useChat.getState().loadOlder(id).catch(() => undefined);
    setLoadingOlder(false);
    requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - prevHeight));
  }

  const send = (fn: () => Promise<void>) => fn().catch((e) => toast({ title: 'Message not sent', body: errMsg(e), tone: 'error' }));
  async function generateAIImage(prompt: string) {
    try {
      const result = await backend.generateAIImage(id, prompt);
      useChat.getState().receive(result.message, result.conversation);
    } catch (e) {
      toast({ title: 'Couldn’t generate image', body: errMsg(e), tone: 'error' });
      throw e;
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="z-20 flex items-center gap-1 border-b border-line bg-surface/95 px-2 py-2 backdrop-blur">
        <IconButton icon="back" label="Back to chats" onClick={() => navigate('/')} className="md:hidden" />
        <Link to={`/chats/${id}/info`} className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-1 py-1 hover:bg-surface-2">
          <Avatar name={peer.displayName} src={peer.avatarUrl} online={isGroup ? null : peer.online} group={isGroup} size={42} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-bold leading-tight">{peer.displayName}</span>
              <BotBadge kind={peer.bot} />
            </span>
            <span className={cn('block truncate text-xs', recording || typing || (!isGroup && peer.online) ? 'text-primary' : 'text-muted')}>
              {recording ? (
                <span className="inline-flex items-center gap-1.5"><Icon name="mic" size={13} /> {isGroup ? `${recorderName} recording voice` : 'recording voice'}<TypingDots /></span>
              ) : typing ? (
                <span className="inline-flex items-center gap-1.5">
                  typing <TypingDots />
                </span>
              ) : (
                (peer.bot ? 'Bot · replies instantly' : status) || `@${peer.username}`
              )}
            </span>
          </span>
        </Link>
        {canCall && (
          <>
            <IconButton icon="phone" label={isGroup ? 'Group voice call' : 'Voice call'} onClick={() => call('audio')} />
            <IconButton icon="video" label={isGroup ? 'Group video call' : 'Video call'} onClick={() => call('video')} />
          </>
        )}
      </header>
      {isGroup && <GroupCallBanner conversationId={id} />}

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="chat-bg scroll-thin min-h-0 flex-1 overflow-y-auto py-2"
      >
        {!messages ? (
          <div className="flex justify-center py-16 text-primary">
            <Spinner />
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="flex justify-center py-2">
                <Button variant="secondary" className="h-9 text-sm" loading={loadingOlder} onClick={loadOlder}>
                  Load earlier messages
                </Button>
              </div>
            )}
            {messages.length === 0 && (
              <div className="mx-auto mt-10 max-w-xs rounded-3xl bg-surface/90 p-5 text-center shadow-sm">
                <Avatar name={peer.displayName} src={peer.avatarUrl} group={isGroup} size={64} className="mx-auto" />
                <p className="mt-3 font-bold">{isGroup ? `Welcome to ${peer.displayName}` : `Say hello to ${peer.displayName.split(' ')[0]} 👋`}</p>
                <p className="mt-1 text-sm text-muted">{peer.bot ? 'Say “help” to see what I can do.' : 'Messages and files you share appear here.'}</p>
              </div>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
              return (
                <Fragment key={m.clientId || m.id}>
                  {newDay && <DayDivider label={dayLabel(m.createdAt)} />}
                  {prev && prev.senderId !== m.senderId && !newDay && <div className="h-2" />}
                  <MessageBubble
                    message={m}
                    mine={m.senderId === me.id}
                    senderName={isGroup && (newDay || !prev || prev.senderId !== m.senderId || prev.kind === 'system') ? nameOf(m.senderId) : null}
                    highlight={m.id === highlightId}
                    onOpenImage={setLightbox}
                    onRetry={() => send(() => useChat.getState().retry(m.clientId))}
                  />
                </Fragment>
              );
            })}
            {(typing || recording) && (
              <div className="px-3 py-1">
                <span className="bubble-other inline-flex rounded-3xl rounded-bl-lg border border-line/60 px-4 py-3 text-muted">
                  {recording ? <span className="inline-flex items-center gap-2 text-primary"><Icon name="mic" size={15} /> Recording voice…</span> : <TypingDots />}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <Composer
        disabled={!conversation.canMessage}
        disabledReason={
          isGroup
            ? 'You can’t send messages to this group.'
            : peer.isBlocked
              ? `You blocked ${peer.displayName}. Unblock them from their profile to chat.`
              : `You can’t message ${peer.displayName} right now.`
        }
        onTyping={(t) => backend.emitTyping(id, t)}
        onRecording={(r) => backend.emitRecording(id, r)}
        onSend={(text) => send(() => useChat.getState().sendText(id, text))}
        onSendFile={(file, caption) => send(() => useChat.getState().sendFile(id, file, caption))}
        onGenerateImage={peer.bot === 'ai' ? generateAIImage : undefined}
      />

      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={() => setLightbox(null)} role="dialog" aria-label="Image preview">
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded-xl" />
          <IconButton icon="x" label="Close" className="absolute right-4 top-4 bg-white/10 text-white hover:bg-white/20" onClick={() => setLightbox(null)} />
        </div>
      )}
    </div>
  );
}

/* ================= Peer profile ================= */
export function PeerProfilePage() {
  const { id = '' } = useParams();
  const conversation = useChat((s) => s.conversations[id]);
  if (conversation?.kind === 'group') return <GroupInfoPage conversationId={id} />;
  return <DirectProfile id={id} />;
}

function DirectProfile({ id }: { id: string }) {
  const conversation = useChat((s) => s.conversations[id]);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useChat
      .getState()
      .ensureConversation(id)
      .then((c) => (c.kind === 'group' ? Promise.reject(new Error('group')) : backend.getUser(c.peer.id)))
      .then(setUser)
      .catch(() => undefined);
  }, [id]);

  const peer = user ?? conversation?.peer;
  if (!peer) {
    return (
      <div className="flex h-full items-center justify-center text-primary">
        <Spinner />
      </div>
    );
  }

  async function toggleBlock() {
    if (!peer) return;
    setBusy(true);
    try {
      if (peer.isBlocked) await backend.unblock(peer.id);
      else await backend.block(peer.id);
      const [fresh, conv] = await Promise.all([backend.getUser(peer.id), backend.getConversation(id)]);
      setUser(fresh);
      useChat.getState().upsertConversation(conv);
      toast({ title: fresh.isBlocked ? `${peer.displayName} blocked` : `${peer.displayName} unblocked`, tone: 'success' });
    } catch (e) {
      toast({ title: 'Couldn’t update', body: errMsg(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <PageHeader title="Contact info" back={`/chats/${id}`} />
      <div className="scroll-thin flex-1 overflow-y-auto px-4 pb-10">
        <div className="mx-auto max-w-md">
          <div className="flex flex-col items-center pt-6 text-center">
            <Avatar name={peer.displayName} src={peer.avatarUrl} size={112} online={peer.bot ? null : peer.online} />
            <h2 className="mt-4 flex items-center gap-2 text-2xl font-extrabold">
              {peer.displayName}
              <BotBadge kind={peer.bot} />
            </h2>
            <p className="text-muted">@{peer.username}</p>
            <FriendIdChip code={peer.friendId} className="mt-3" />
            <p className="mt-2 text-sm text-primary">{peer.bot ? 'FriendStar bot' : presenceText(peer.online, peer.lastSeenAt)}</p>
            {peer.bio && <p className="mt-4 max-w-xs text-[15px]">{peer.bio}</p>}
          </div>
          <div className="mt-6 grid grid-cols-3 gap-2">
            <Link to={`/chats/${id}`} className="flex flex-col items-center gap-1 rounded-2xl border border-line bg-surface py-3 text-sm font-semibold text-primary">
              <Icon name="chat" />
              Message
            </Link>
            {(['audio', 'video'] as const).map((media) => (
              <button
                key={media}
                disabled={!conversation?.canMessage || !!peer.bot}
                onClick={() => void callUser(id, peer, media, (msg) => toast({ title: 'Can’t start the call', body: msg, tone: 'error' }))}
                className="flex flex-col items-center gap-1 rounded-2xl border border-line bg-surface py-3 text-sm font-semibold text-primary disabled:opacity-50"
              >
                <Icon name={media === 'audio' ? 'phone' : 'video'} />
                {media === 'audio' ? 'Voice' : 'Video'}
              </button>
            ))}
          </div>
          <Button variant="secondary" block icon="share" className="mt-6" onClick={() => void shareProfile(peer)}>
            Share {peer.displayName.split(' ')[0]}’s profile
          </Button>
          <Button variant="danger" block icon="block" className="mt-3" loading={busy} onClick={toggleBlock}>
            {peer.isBlocked ? `Unblock ${peer.displayName}` : `Block ${peer.displayName}`}
          </Button>
          <p className="mt-2 text-center text-xs text-muted">
            Blocked people can’t message you or see your last seen, profile photo or bio.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ================= New chat ================= */
export function NewChatPage() {
  const navigate = useNavigate();
  const conversations = useChat((s) => s.conversations);
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const [results, setResults] = useState<PublicUser[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!debounced) return setResults(null);
    let alive = true;
    backend
      .search(debounced)
      .then((r) => alive && setResults(r.users))
      .catch(() => alive && setResults([]));
    return () => {
      alive = false;
    };
  }, [debounced]);

  const recent = Object.values(conversations)
    .filter((c) => c.lastMessage && c.kind === 'direct')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((c) => c.peer);

  async function open(user: PublicUser) {
    setOpening(user.id);
    try {
      const c: ConversationSummary = await backend.openConversation(user.id);
      useChat.getState().upsertConversation(c);
      navigate(`/chats/${c.id}`, { replace: true });
    } catch (e) {
      toast({ title: 'Couldn’t start chat', body: errMsg(e), tone: 'error' });
      setOpening(null);
    }
  }

  const list = results ?? recent;
  return (
    <div className="flex h-full flex-col bg-surface">
      <PageHeader title="New chat" back="/">
        <SearchInput value={q} onChange={setQ} placeholder="Name, email or FriendStar ID" autoFocus />
      </PageHeader>
      <div className="scroll-thin flex-1 overflow-y-auto px-2 py-2">
        <Link to="/groups/new" className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-surface-2">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-on-primary">
            <Icon name="users" />
          </span>
          <span className="flex-1 font-semibold">New group</span>
          <Icon name="chevron" size={18} className="text-muted" />
        </Link>
        <Link to="/people" className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-surface-2">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Icon name="people" />
          </span>
          <span className="flex-1">
            <span className="block font-semibold">Everyone on FriendStar</span>
            <span className="block text-[13px] text-muted">Browse people and their IDs</span>
          </span>
          <Icon name="chevron" size={18} className="text-muted" />
        </Link>
        <p className="px-3 pb-1 pt-3 text-xs font-bold uppercase tracking-wider text-muted">{results ? 'People' : 'Recent'}</p>
        {list.length === 0 ? (
          <EmptyState icon="search" title={results ? 'No one found' : 'Find your friends'} body={results ? 'Check the spelling, or try their full email or FriendStar ID (like FS-7K2QX9).' : 'Search by name, @username, full email or FriendStar ID.'} />
        ) : (
          list.map((u) => <UserRow key={u.id} user={u} busy={opening === u.id} onClick={() => open(u)} />)
        )}
      </div>
    </div>
  );
}

export function UserRow({ user, onClick, busy }: { user: PublicUser; onClick: () => void; busy?: boolean }) {
  return (
    <PersonRow
      user={user}
      onClick={onClick}
      busy={busy}
      subtitle={`@${user.username}${user.bio ? ` · ${user.bio}` : ''}`}
      right={busy ? <Spinner size={18} className="text-primary" /> : undefined}
    />
  );
}
