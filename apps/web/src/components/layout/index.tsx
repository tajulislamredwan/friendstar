import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { backend, isDemo, type ConnectionState } from '../../api/index.ts';
import { cn } from '../../lib/format.ts';
import { getNotifyPrefs, playChime, showDesktopNotification } from '../../lib/notify.ts';
import { selectTotalUnread, toast, useAuth, useChat, useNotifications, useToasts } from '../../store/index.ts';
import { Avatar, CountBadge, IconButton, Logo } from '../ui/index.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { CallOverlay } from '../call/CallScreen.tsx';
import { GroupCallInvite, GroupCallOverlay } from '../call/GroupCallScreen.tsx';
import { useGroupCall } from '../../store/groupCall.ts';
import { useCall } from '../../store/call.ts';
import { useStatus } from '../../store/status.ts';
import { DownloadBanner } from '../DownloadBanner.tsx';

/* ---------- Realtime wiring ---------- */
function useRealtime() {
  const navigate = useNavigate();
  useEffect(() => {
    const chat = useChat.getState;
    const meId = () => useAuth.getState().me?.id;
    const isViewing = (conversationId: string) => chat().activeId === conversationId && document.visibilityState === 'visible';

    const offs = [
      backend.on('message:new', ({ message, conversation }) => {
        chat().receive(message, conversation);
        if (message.senderId !== meId()) {
          backend.ackDelivered([message.id]);
          if (isViewing(message.conversationId)) void chat().markRead(message.conversationId);
        }
      }),
      backend.on('message:status', ({ conversationId, messageIds, status }) => chat().applyStatus(conversationId, messageIds, status)),
      backend.on('conversation:updated', ({ conversation }) => chat().upsertConversation(conversation)),
      backend.on('presence', ({ userId, online, lastSeenAt }) => chat().applyPresence(userId, online, lastSeenAt)),
      backend.on('typing', ({ conversationId, isTyping }) => chat().setTyping(conversationId, isTyping)),
      backend.on('recording', ({ conversationId, userId, isRecording }) => chat().setRecording(conversationId, userId, isRecording)),
      backend.on('conversation:removed', ({ conversationId }) => {
        const wasViewing = chat().activeId === conversationId;
        chat().removeConversation(conversationId);
        if (wasViewing) {
          toast({ title: 'You’re no longer in that group' });
          navigate('/');
        }
      }),
      backend.on('status:new', () => void useStatus.getState().load().catch(() => undefined)),
      backend.on('call:update', ({ call }) => {
        const me = meId();
        if (me) useCall.getState().onUpdate(call, me);
      }),
      backend.on('call:signal', ({ callId, data }) => useCall.getState().onSignal(callId, data)),
      backend.on('gcall:update', ({ call, ring }) => {
        const me = meId();
        if (me) useGroupCall.getState().onUpdate(call, me, !!ring);
      }),
      backend.on('gcall:signal', ({ callId, fromUserId, data }) => useGroupCall.getState().onSignal(callId, fromUserId, data)),
      backend.on('notification:new', ({ notification, unread }) => {
        if (notification.conversationId && isViewing(notification.conversationId)) return;
        useNotifications.getState().upsert(notification, unread);
        const open = () => notification.conversationId && navigate(`/chats/${notification.conversationId}`);
        if (getNotifyPrefs().sound) playChime();
        if (document.visibilityState === 'visible') {
          toast({ title: notification.title, body: getNotifyPrefs().previews ? notification.body : 'New message', onClick: open });
        } else if (notification.type !== 'announcement') {
          showDesktopNotification(notification.title, notification.body, open);
        }
      }),
    ];
    const onVisible = () => {
      const id = chat().activeId;
      if (id && document.visibilityState === 'visible') void chat().markRead(id);
    };
    document.addEventListener('visibilitychange', onVisible);
    // Expire stale typing and recording indicators.
    const sweep = setInterval(() => {
      const t = chat().typing;
      for (const [id, exp] of Object.entries(t)) if (exp < Date.now()) chat().setTyping(id, false);
      const r = chat().recording;
      for (const [id, state] of Object.entries(r)) if (state.expiresAt < Date.now()) chat().setRecording(id, state.userId, false);
    }, 1500);
    return () => {
      offs.forEach((off) => off());
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(sweep);
    };
  }, [navigate]);
}

function useConnection() {
  const [state, setState] = useState<ConnectionState>('online');
  useEffect(() => backend.onConnection(setState), []);
  return state;
}

/* ---------- Navigation ---------- */
const NAV: { to: string; label: string; icon: IconName; end?: boolean; desktopOnly?: boolean }[] = [
  { to: '/', label: 'Chats', icon: 'chat', end: true },
  { to: '/status', label: 'Status', icon: 'stories' },
  { to: '/calls', label: 'Calls', icon: 'phone' },
  { to: '/people', label: 'People', icon: 'people' },
  { to: '/search', label: 'Search', icon: 'search', desktopOnly: true },
  // On phones, alerts live behind the bell in the Chats header.
  { to: '/notifications', label: 'Alerts', icon: 'bell', desktopOnly: true },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

function useBadges() {
  const chats = useChat(selectTotalUnread);
  const alerts = useNotifications((s) => s.unread);
  const stories = useStatus((s) => s.feed.filter((e) => !e.allViewed).length);
  return (to: string) => (to === '/' ? chats : to === '/notifications' ? alerts : to === '/status' ? stories : 0);
}

function isChatsPath(pathname: string) {
  return pathname === '/' || pathname.startsWith('/chats');
}

function BottomNav() {
  const badge = useBadges();
  const { pathname } = useLocation();
  return (
    <nav className="safe-bottom grid grid-cols-5 border-t border-line bg-surface/95 backdrop-blur md:hidden" aria-label="Main">
      {NAV.filter((n) => !n.desktopOnly).map((n) => {
        const active = n.end ? isChatsPath(pathname) : pathname.startsWith(n.to);
        return (
          <NavLink key={n.to} to={n.to} className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold">
            <span className={cn('relative flex h-8 w-14 items-center justify-center rounded-full transition', active ? 'bg-primary-soft text-primary' : 'text-muted')}>
              <Icon name={n.icon} size={22} />
              <CountBadge count={badge(n.to)} className="absolute -right-1 -top-1" />
            </span>
            <span className={active ? 'text-primary' : 'text-muted'}>{n.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function SideRail() {
  const badge = useBadges();
  const me = useAuth((s) => s.me);
  const { pathname } = useLocation();
  return (
    <nav className="hidden w-20 shrink-0 flex-col items-center gap-2 border-r border-line bg-surface py-4 md:flex" aria-label="Main">
      <Logo size={40} className="mb-4" />
      {NAV.map((n) => {
        const active = n.end ? isChatsPath(pathname) : pathname.startsWith(n.to);
        return (
          <NavLink
            key={n.to}
            to={n.to}
            title={n.label}
            className={cn(
              'relative flex w-16 flex-col items-center gap-1 rounded-2xl py-2 text-[11px] font-semibold transition',
              active ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Icon name={n.icon} size={22} />
            {n.label}
            <CountBadge count={badge(n.to)} className="absolute right-2 top-1" />
          </NavLink>
        );
      })}
      <div className="flex-1" />
      {me?.isOwner && (
        <NavLink
          to="/admin"
          title="Admin"
          className={cn(
            'relative flex w-16 flex-col items-center gap-1 rounded-2xl py-2 text-[11px] font-semibold transition',
            pathname.startsWith('/admin') ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-ink',
          )}
        >
          <Icon name="chart" size={22} />
          Admin
        </NavLink>
      )}
      {me && (
        <NavLink to="/settings/profile" title="Your profile">
          <Avatar name={me.displayName} src={me.avatarUrl} size={40} />
        </NavLink>
      )}
    </nav>
  );
}

function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => {
            t.onClick?.();
            dismiss(t.id);
          }}
          className={cn(
            'pop-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line bg-surface p-3 text-left shadow-xl shadow-black/10',
            t.tone === 'error' && 'border-danger/40',
          )}
        >
          <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl', t.tone === 'error' ? 'bg-danger/10 text-danger' : 'bg-primary-soft text-primary')}>
            <Icon name={t.tone === 'error' ? 'alert' : 'star'} size={18} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{t.title}</span>
            {t.body && <span className="line-clamp-2 text-sm text-muted">{t.body}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

export function AppShell() {
  useRealtime();
  const conn = useConnection();
  const { pathname } = useLocation();
  const inRoom = /^\/chats\/[^/]+/.test(pathname);
  const deep = inRoom || /^\/(settings|status|groups|u|admin)\/.+/.test(pathname) || pathname === '/new';

  useEffect(() => {
    void useChat.getState().loadConversations().catch(() => undefined);
    const defer = setTimeout(() => {
      void useNotifications.getState().load().catch(() => undefined);
      void useStatus.getState().load().catch(() => undefined);
      void useGroupCall.getState().loadActive();
    }, 1200);
    // After a reconnect, refresh call banners that may have changed while offline.
    const off = backend.onConnection((st) => {
      if (st === 'online') {
        void useChat.getState().loadConversations().catch(() => undefined);
        const activeId = useChat.getState().activeId;
        if (activeId) void useChat.getState().loadMessages(activeId).catch(() => undefined);
        void useGroupCall.getState().loadActive();
      }
    });
    return () => { clearTimeout(defer); off(); };
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-bg">
      <SideRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <DownloadBanner />
        {isDemo && (
          <div className="bg-star/15 px-3 py-1 text-center text-[12px] font-medium text-[#7a4a00] dark:text-star">
            Preview mode · data stays in this browser · open a 2nd tab to chat as another demo user
          </div>
        )}
        {conn !== 'online' && (
          <div className="bg-surface-2 px-3 py-1 text-center text-[12px] font-medium text-muted">
            {conn === 'connecting' ? 'Connecting…' : 'Offline — showing saved messages; new messages need internet.'}
          </div>
        )}
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
        {!deep && <BottomNav />}
      </div>
      <Toasts />
      <CallOverlay />
      <GroupCallOverlay />
      <GroupCallInvite />
    </div>
  );
}

/* ---------- Page scaffolding ---------- */
export function PageHeader({
  title,
  back,
  actions,
  children,
}: {
  title: ReactNode;
  back?: string | true;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 bg-surface/90 px-3 pb-2 pt-3 backdrop-blur">
      <div className="flex min-h-10 items-center gap-1">
        {back && (
          <IconButton icon="back" label="Back" onClick={() => (back === true ? navigate(-1) : navigate(back))} className={typeof back === 'string' && back === '/' ? 'md:hidden' : ''} />
        )}
        <h1 className="min-w-0 flex-1 truncate px-1 text-[22px] font-extrabold tracking-tight">{title}</h1>
        {actions}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </header>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto', className)}>{children}</div>
    </div>
  );
}
