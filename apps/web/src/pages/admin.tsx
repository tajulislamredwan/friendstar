import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { FILE_MIME, type AdminAnnouncementPreview, type AdminAnnouncementRecord, type AdminBotRow, type AdminLoginEvent, type AdminPasswordResetRequest, type AdminSummary, type AdminUserRow, type FileMeta } from '@friendstar/shared';
import { ApiError, backend } from '../api/index.ts';
import { PageHeader } from '../components/layout/index.tsx';
import { BotBadge, FriendIdChip } from '../components/people/index.tsx';
import { Avatar, Button, Card, SearchInput, Spinner, TextArea, TextField } from '../components/ui/index.tsx';
import { Icon, type IconName } from '../components/ui/Icon.tsx';
import { cn } from '../lib/format.ts';
import { useDebounced } from '../lib/hooks.ts';
import { toast, useAuth } from '../store/index.ts';

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

function Stat({ icon, label, value, tone }: { icon: IconName; label: string; value: number; tone?: 'danger' }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <span className={cn('flex h-8 w-8 items-center justify-center rounded-xl', tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-primary-soft text-primary')}>
        <Icon name={icon} size={18} />
      </span>
      <p className="mt-2 text-2xl font-extrabold tabular-nums">{value.toLocaleString()}</p>
      <p className="text-[12px] font-semibold text-muted">{label}</p>
    </div>
  );
}

const KIND: Record<AdminLoginEvent['kind'], { label: string; cls: string }> = {
  register: { label: 'Signed up', cls: 'bg-success/15 text-success' },
  login: { label: 'Signed in', cls: 'bg-primary-soft text-primary' },
};

function AnnouncementComposer() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [attachment, setAttachment] = useState<FileMeta | null>(null);
  const [uploading, setUploading] = useState(false);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<AdminAnnouncementPreview | null>(null);
  const [history, setHistory] = useState<AdminAnnouncementRecord[] | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);

  useEffect(() => {
    let alive = true;
    backend.adminAnnouncements().then((items) => alive && setHistory(items)).catch(() => alive && setHistory([]));
    return () => { alive = false; };
  }, [historyRevision]);

  async function reviewAnnouncement() {
    setReviewing(true);
    setPreview(null);
    try {
      setPreview(await backend.previewAdminAnnouncement({ title, body, fileId: attachment?.id ?? null }));
    } catch (e) {
      toast({ title: 'Couldn’t prepare preview', body: e instanceof ApiError ? e.message : 'Please try again.', tone: 'error' });
    } finally {
      setReviewing(false);
    }
  }

  async function confirmAnnouncement() {
    if (!preview || sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    try {
      const sent = await backend.sendAdminAnnouncement(preview.previewId);
      toast({ title: 'Update sent', body: `In-app notice created for ${sent.recipientCount.toLocaleString()} people.`, tone: 'success' });
      setTitle('');
      setBody('');
      setAttachment(null);
      setPreview(null);
      setHistoryRevision((n) => n + 1);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setPreview(null);
      toast({ title: 'Couldn’t send update', body: e instanceof ApiError ? e.message : 'Please try again.', tone: 'error' });
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  return (
    <div className="mt-3 space-y-3">
      <Card className="p-4">
        <div className="flex items-center gap-2 text-base font-bold">
          <Icon name="bell" size={19} /> Send an update
        </div>
        <p className="mt-1 text-sm text-muted">Create a notice people can read in FriendStar’s Notifications. This does not send email, SMS or push alerts.</p>
        <div className="mt-4 space-y-3">
          <TextField
            label="Update title"
            value={title}
            maxLength={100}
            onChange={(e) => { setTitle(e.target.value); setPreview(null); }}
            placeholder="What’s new?"
          />
          <TextArea
            label="Message"
            value={body}
            maxLength={1000}
            onChange={(e) => { setBody(e.target.value); setPreview(null); }}
            hint={`${body.length}/1000`}
            placeholder="Write the update for everyone…"
          />
          <input ref={attachmentInput} type="file" accept={FILE_MIME.join(',')} className="hidden" onChange={async (e) => {
            const picked = e.target.files?.[0]; e.target.value = ''; if (!picked) return;
            setUploading(true);
            try { setAttachment(await backend.uploadAdminAttachment(picked)); setPreview(null); }
            catch (err) { toast({ title: 'Couldn’t attach file', body: err instanceof ApiError ? err.message : 'Please try again.', tone: 'error' }); }
            finally { setUploading(false); }
          }} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon="clip" loading={uploading} onClick={() => attachmentInput.current?.click()}>Attach file (up to 10 MiB)</Button>
            {attachment && <span className="max-w-full truncate text-sm text-muted">{attachment.name} <button className="ml-2 font-semibold text-danger" onClick={() => { setAttachment(null); setPreview(null); }}>Remove</button></span>}
          </div>
          <Button block loading={reviewing} disabled={!title.trim() || !body.trim() || sending || uploading} onClick={() => void reviewAnnouncement()}>
            Preview for everyone
          </Button>
        </div>
      </Card>

      {preview && (
        <Card className="border-primary/40 p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-primary">Review before sending</p>
          <div className="mt-3 rounded-2xl bg-surface-2 p-4">
            <p className="font-bold">{preview.title}</p>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted">{preview.body}</p>
            {preview.file && <a href={`${preview.file.url}&download=1`} className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-primary" download={preview.file.name}><Icon name="file" size={16} /> {preview.file.name}</a>}
          </div>
          <p className="mt-3 rounded-2xl bg-star/15 px-3 py-2 text-sm text-ink">
            This will create one in-app notification for <b>{preview.recipientCount.toLocaleString()} registered people</b> (built-in bots excluded). No notice is sent until you confirm below.
          </p>
          <p className="mt-2 text-xs text-muted">Preview expires {when(preview.expiresAt)}. A fresh preview is required if the recipient count changes.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button variant="secondary" disabled={sending} onClick={() => setPreview(null)}>Edit announcement</Button>
            <Button variant="danger" loading={sending} disabled={preview.recipientCount === 0} onClick={() => void confirmAnnouncement()}>
              Confirm &amp; send to {preview.recipientCount.toLocaleString()}
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="font-bold">Recent broadcasts</h2>
        <p className="mb-3 text-sm text-muted">Audit history: sender, time, exact message and recipient count.</p>
        {history === null ? (
          <div className="flex justify-center py-4 text-primary"><Spinner /></div>
        ) : history.length === 0 ? (
          <p className="py-3 text-sm text-muted">No announcements have been sent.</p>
        ) : (
          <div className="divide-y divide-line">
            {history.map((item) => (
              <div key={item.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 break-words font-semibold">{item.title}</p>
                  <span className="shrink-0 text-xs text-muted">{when(item.createdAt)}</span>
                </div>
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted">{item.body}</p>
                {item.file && <a href={`${item.file.url}&download=1`} className="mt-1 inline-flex items-center gap-2 text-xs font-semibold text-primary" download={item.file.name}><Icon name="file" size={14} /> {item.file.name}</a>}
                <p className="mt-1 text-xs text-muted">{item.recipientCount.toLocaleString()} people · {item.senderEmail}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function BotManager() {
  const [bots, setBots] = useState<AdminBotRow[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => { backend.adminBots().then((rows) => { setBots(rows); setNames(Object.fromEntries(rows.map((b) => [b.id, b.displayName]))); }).catch(() => setBots([])); }, [reload]);
  async function rename(bot: AdminBotRow) {
    setBusy(bot.id);
    try {
      const updated = await backend.renameAdminBot(bot.id, (names[bot.id] ?? '').trim());
      setBots((rows) => rows?.map((b) => b.id === bot.id ? updated : b) ?? []);
      toast({ title: 'Bot renamed', body: `Name changed to ${updated.displayName}.`, tone: 'success' });
    } catch (e) { toast({ title: 'Couldn’t rename bot', body: e instanceof ApiError ? e.message : 'Please try again.', tone: 'error' }); }
    finally { setBusy(null); }
  }
  async function remove(bot: AdminBotRow) {
    if (!window.confirm(`Remove ${bot.displayName} from active use? Existing chats and messages will be kept.`)) return;
    setBusy(bot.id);
    try { await backend.deleteAdminBot(bot.id); setReload((n) => n + 1); toast({ title: 'Bot removed', body: 'Existing conversations were preserved.', tone: 'success' }); }
    catch (e) { toast({ title: 'Couldn’t remove bot', body: e instanceof ApiError ? e.message : 'Please try again.', tone: 'error' }); }
    finally { setBusy(null); }
  }
  return <Card className="mt-3 p-4"><h2 className="font-bold">Built-in bots</h2><p className="mb-3 text-sm text-muted">Rename a bot or remove it from active use. Removing a bot keeps its account and chat history; it cannot sign in.</p>
    {bots === null ? <div className="flex justify-center py-5 text-primary"><Spinner /></div> : bots.map((bot) => <div key={bot.id} className="flex flex-wrap items-center gap-2 border-t border-line py-3 first:border-0">
      <span className="min-w-20 text-xs font-semibold uppercase text-muted">{bot.kind}</span>
      <TextField label={`Name for ${bot.kind}`} value={names[bot.id] ?? bot.displayName} onChange={(e) => setNames((n) => ({ ...n, [bot.id]: e.target.value }))} />
      <Button variant="secondary" loading={busy === bot.id} disabled={!bot.enabled || !names[bot.id]?.trim()} onClick={() => void rename(bot)}>Rename</Button>
      <Button variant="danger" loading={busy === bot.id} disabled={!bot.enabled} onClick={() => void remove(bot)}>{bot.enabled ? 'Remove' : 'Removed'}</Button>
    </div>)}</Card>;
}

async function copyResetLink(link: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(link);
    return;
  }
  const field = document.createElement('textarea');
  field.value = link;
  field.readOnly = true;
  field.style.position = 'fixed';
  field.style.left = '-10000px';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Clipboard unavailable');
}

function ResetRequestQueue() {
  const [requests, setRequests] = useState<AdminPasswordResetRequest[] | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    backend.adminPasswordResetRequests().then((rows) => alive && setRequests(rows)).catch(() => alive && setRequests([]));
    return () => { alive = false; };
  }, [reload]);

  async function verifyAndIssue(request: AdminPasswordResetRequest) {
    if (!request.userId || !['pending', 'issued'].includes(request.status)) return;
    const confirmed = window.confirm(
      `Have you verified ${request.displayName ?? request.identifier} through a trusted, separate method? A one-time link will be copied to this device's clipboard; it will not be emailed.`,
    );
    if (!confirmed) return;
    setBusy(request.id);
    try {
      const issued = await backend.issueAdminPasswordReset(request.id, true);
      const link = new URL('/reset-password', window.location.origin);
      link.hash = `token=${encodeURIComponent(issued.token)}`;
      await copyResetLink(link.toString());
      toast({ title: 'Reset link copied', body: `Valid for 15 minutes, until ${when(issued.expiresAt)}. The link was not sent.`, tone: 'success' });
      setReload((value) => value + 1);
    } catch (err) {
      toast({ title: 'Couldn’t copy reset link', body: err instanceof ApiError ? err.message : 'The link was not copied. You can issue a fresh link after checking clipboard access.', tone: 'error' });
      setReload((value) => value + 1);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 space-y-3">
      <Card className="p-4">
        <h2 className="font-bold">Password-reset requests</h2>
        <p className="mt-1 text-sm text-muted">Confirm the person out of band before issuing a link. Requests are audited for 90 days. Links expire after 15 minutes, are copied only when you choose, and are never emailed.</p>
      </Card>
      {requests === null ? <div className="flex justify-center py-6 text-primary"><Spinner /></div> : requests.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No reset requests to review.</p>
      ) : requests.map((request) => {
        const expired = !!request.expiresAt && Date.parse(request.expiresAt) <= Date.now();
        const canIssue = !!request.userId && (request.status === 'pending' || request.status === 'issued');
        return (
          <Card key={request.id} className="p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{request.displayName ?? (request.userId ? request.username : 'No matching account')}</p>
                <p className="break-all text-sm text-muted">{request.email ?? request.identifier}</p>
                {request.userId && <p className="text-xs text-muted">@{request.username}</p>}
                <p className="mt-1 text-xs text-muted">Requested {when(request.requestedAt)} · {request.status === 'issued' && expired ? 'link expired' : request.status}</p>
                {request.status === 'issued' && request.expiresAt && !expired && <p className="text-xs text-muted">Latest link expires {when(request.expiresAt)}</p>}
              </div>
              {canIssue && (
                <Button variant="secondary" className="h-10 px-3 text-sm" loading={busy === request.id} disabled={busy !== null} onClick={() => void verifyAndIssue(request)}>
                  {request.status === 'issued' ? 'Verify & copy fresh link' : 'Verify & copy reset link'}
                </Button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

type Tab = 'users' | 'resets' | 'bots' | 'logins' | 'announcements';

export function AdminPage() {
  const me = useAuth((s) => s.me);
  const [tab, setTab] = useState<Tab>('users');
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [events, setEvents] = useState<AdminLoginEvent[] | null>(null);
  const [userFilter, setUserFilter] = useState<AdminUserRow | null>(null);
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const [error, setError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);

  useEffect(() => {
    if (!me?.isOwner) return;
    backend
      .adminSummary()
      .then(setSummary)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Couldn’t load'));
  }, [me?.isOwner]);

  useEffect(() => {
    if (!me?.isOwner) return;
    setUsers(null);
    backend.adminUsers(query).then(setUsers).catch(() => setUsers([]));
  }, [me?.isOwner, query]);

  useEffect(() => {
    if (!me?.isOwner || tab !== 'logins') return;
    setEvents(null);
    backend.adminLogins({ userId: userFilter?.id }).then(setEvents).catch(() => setEvents([]));
  }, [me?.isOwner, tab, userFilter]);

  if (me && !me.isOwner) return <Navigate to="/" replace />;

  async function moreEvents() {
    const last = events?.[events.length - 1];
    if (!last) return;
    setMoreBusy(true);
    try {
      const next = await backend.adminLogins({ userId: userFilter?.id, before: last.at });
      setEvents((prev) => [...(prev ?? []), ...next.filter((e) => !prev?.some((p) => p.id === e.id))]);
    } finally {
      setMoreBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <PageHeader title="Admin" back="/settings" />
      <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-12 pt-3">
        <div className="mx-auto max-w-4xl">
          <p className="flex items-center gap-2 rounded-2xl bg-primary-soft px-3 py-2 text-[13px] text-primary">
            <Icon name="lock" size={16} /> Only you can see this page. Passwords are never stored in readable form, so they can’t be shown.
          </p>
          {error && <p className="mt-3 text-sm text-danger">{error}</p>}

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {summary ? (
              <>
                <Stat icon="people" label="People" value={summary.users} />
                <Stat icon="star" label="Online now" value={summary.onlineNow} />
                <Stat icon="plus" label="Sign-ups today" value={summary.signupsToday} />
                <Stat icon="check" label="Sign-ins today" value={summary.loginsToday} />
                <Stat icon="alert" label="Failed today" value={summary.failedLoginsToday} tone="danger" />
                <Stat icon="chat" label="Messages" value={summary.messages} />
                <Stat icon="users" label="Groups" value={summary.groups} />
                <Stat icon="bot" label="Bots" value={summary.bots} />
              </>
            ) : (
              <div className="col-span-full flex justify-center py-6 text-primary">
                <Spinner />
              </div>
            )}
          </div>

          <div className="mt-5 flex flex-wrap gap-2" role="tablist">
            {(backend.mode === 'server' ? ['users', 'resets', 'logins', 'bots', 'announcements'] as const : ['users', 'logins', 'bots', 'announcements'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn('rounded-full px-4 py-2 text-sm font-semibold transition', tab === t ? 'bg-primary text-on-primary' : 'bg-surface text-muted hover:text-ink')}
              >
                {t === 'users' ? 'People' : t === 'resets' ? 'Reset requests' : t === 'logins' ? 'Sign-in history' : t === 'bots' ? 'Bots' : 'Updates'}
              </button>
            ))}
          </div>

          {tab === 'users' ? (
            <div className="mt-3">
              <SearchInput value={q} onChange={setQ} placeholder="Search name, email, username or ID" />
              <div className="mt-2 space-y-2">
                {users === null ? (
                  <div className="flex justify-center py-8 text-primary">
                    <Spinner />
                  </div>
                ) : users.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted">No one matches.</p>
                ) : (
                  users.map((u) => (
                    <div key={u.id} className="rounded-2xl border border-line bg-surface p-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.displayName} src={null} online={u.bot ? null : u.online} size={42} />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5">
                            <span className="truncate font-semibold">{u.displayName}</span>
                            <BotBadge kind={u.bot} />
                          </p>
                          <p className="truncate text-[13px] text-muted">
                            @{u.username} · {u.email}
                          </p>
                          <p className="truncate font-mono text-[11px] text-muted">Account ID: {u.id}</p>
                        </div>
                        <FriendIdChip code={u.friendId} compact />
                      </div>
                      {!u.bot && (
                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-muted sm:grid-cols-4">
                          <span>
                            <b className="text-ink">Joined</b> {when(u.createdAt)}
                          </span>
                          <span>
                            <b className="text-ink">Last sign-in</b> {when(u.lastLoginAt)}
                          </span>
                          <span>
                            <b className="text-ink">Successful sign-ins</b> {u.loginCount}
                          </span>
                        </div>
                      )}
                      {!u.bot && (
                        <button onClick={() => { setUserFilter(u); setTab('logins'); }} className="mt-2 text-[13px] font-semibold text-primary">
                          View successful sign-in history →
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : tab === 'logins' ? (
            <div className="mt-3">
              {userFilter && (
                <p className="mb-2 flex items-center gap-2 text-sm">
                  Showing <b>{userFilter.displayName}</b>
                  <button onClick={() => setUserFilter(null)} className="rounded-full bg-surface px-2.5 py-1 text-[12px] font-semibold text-primary">
                    Show everyone
                  </button>
                </p>
              )}
              {events === null ? (
                <div className="flex justify-center py-8 text-primary">
                  <Spinner />
                </div>
              ) : events.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted">No sign-ins recorded yet. New sign-ins appear here from now on.</p>
              ) : (
                <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                  {events.map((e) => (
                    <div key={e.id} className="flex items-start gap-3 p-3">
                      <span className={cn('mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold', KIND[e.kind].cls)}>{KIND[e.kind].label}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{e.displayName ?? 'Account activity'}</p>
                        <p className="truncate text-[12px] text-muted">{e.email ?? e.userId ?? 'Account'}</p>
                      </div>
                      <span className="shrink-0 text-[12px] text-muted">{when(e.at)}</span>
                    </div>
                  ))}
                </div>
              )}
              {events && events.length >= 100 && (
                <div className="flex justify-center py-3">
                  <Button variant="secondary" className="h-9 text-sm" loading={moreBusy} onClick={() => void moreEvents()}>
                    Older
                  </Button>
                </div>
              )}
            </div>
          ) : tab === 'resets' ? (
            <ResetRequestQueue />
          ) : tab === 'bots' ? (
            <BotManager />
          ) : (
            <AnnouncementComposer />
          )}
        </div>
      </div>
    </div>
  );
}
