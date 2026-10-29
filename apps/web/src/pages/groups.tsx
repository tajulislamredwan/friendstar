import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GROUP_LIMITS, type GroupMember, type PublicUser } from '@friendstar/shared';
import { ApiError, backend } from '../api/index.ts';
import { PageHeader } from '../components/layout/index.tsx';
import { Avatar, Button, Card, EmptyState, IconButton, SearchInput, SectionLabel, Spinner, TextField } from '../components/ui/index.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import { cn, presenceText } from '../lib/format.ts';
import { useDebounced } from '../lib/hooks.ts';
import { toast, useAuth, useChat } from '../store/index.ts';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

/* ---------- Reusable people picker ---------- */
function usePeopleSearch(exclude: Set<string>) {
  const conversations = useChat((s) => s.conversations);
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const [results, setResults] = useState<PublicUser[] | null>(null);

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

  const recent = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.kind === 'direct' && c.lastMessage)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c) => c.peer),
    [conversations],
  );
  const list = (results ?? recent).filter((u) => !exclude.has(u.id));
  return { q, setQ, list, searching: !!results };
}

function PickRow({ user, picked, onToggle }: { user: PublicUser; picked: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-pressed={picked} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-surface-2">
      <Avatar name={user.displayName} src={user.avatarUrl} online={user.online} size={46} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{user.displayName}</span>
        <span className="block truncate text-sm text-muted">@{user.username}</span>
      </span>
      <span className={cn('flex h-6 w-6 items-center justify-center rounded-full border-2 transition', picked ? 'border-primary bg-primary text-on-primary' : 'border-line')}>
        {picked && <Icon name="check" size={16} />}
      </span>
    </button>
  );
}

function PeoplePicker({
  picked,
  setPicked,
  exclude,
}: {
  picked: PublicUser[];
  setPicked: (u: PublicUser[]) => void;
  exclude: Set<string>;
}) {
  const { q, setQ, list, searching } = usePeopleSearch(exclude);
  const ids = new Set(picked.map((u) => u.id));
  const toggle = (u: PublicUser) => setPicked(ids.has(u.id) ? picked.filter((p) => p.id !== u.id) : [...picked, u]);
  return (
    <>
      <div className="px-3 pt-1">
        <SearchInput value={q} onChange={setQ} placeholder="Name, email or FriendStar ID" />
      </div>
      {picked.length > 0 && (
        <div className="scroll-thin flex gap-3 overflow-x-auto px-4 py-3">
          {picked.map((u) => (
            <button key={u.id} onClick={() => toggle(u)} className="flex w-16 shrink-0 flex-col items-center gap-1 text-center" aria-label={`Remove ${u.displayName}`}>
              <span className="relative">
                <Avatar name={u.displayName} src={u.avatarUrl} size={48} />
                <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-surface">
                  <Icon name="x" size={12} />
                </span>
              </span>
              <span className="w-full truncate text-xs">{u.displayName.split(' ')[0]}</span>
            </button>
          ))}
        </div>
      )}
      <p className="px-5 pb-1 pt-2 text-xs font-bold uppercase tracking-wider text-muted">{searching ? 'People' : 'Recent chats'}</p>
      <div className="px-2 pb-28">
        {list.length === 0 ? (
          <EmptyState icon="search" title={searching ? 'No one found' : 'Search for friends'} body={searching ? 'Try their @username.' : 'Find people by name or @username to add them.'} />
        ) : (
          list.map((u) => <PickRow key={u.id} user={u} picked={ids.has(u.id)} onToggle={() => toggle(u)} />)
        )}
      </div>
    </>
  );
}

/* ================= New group ================= */
export function NewGroupPage() {
  const navigate = useNavigate();
  const me = useAuth((s) => s.me)!;
  const [step, setStep] = useState<'members' | 'details'>('members');
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const exclude = useMemo(() => new Set([me.id]), [me.id]);

  async function create() {
    setBusy(true);
    try {
      const c = await backend.createGroup(title.trim(), picked.map((u) => u.id));
      useChat.getState().upsertConversation(c);
      navigate(`/chats/${c.id}`, { replace: true });
    } catch (e) {
      toast({ title: 'Couldn’t create the group', body: errMsg(e), tone: 'error' });
      setBusy(false);
    }
  }

  return (
    <div className="relative flex h-full flex-col bg-surface">
      {step === 'members' ? (
        <>
          <PageHeader title="New group" back="/" />
          <p className="px-5 pt-3 text-sm text-muted">Add people to your group. You can add more later.</p>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <PeoplePicker picked={picked} setPicked={setPicked} exclude={exclude} />
          </div>
          <div className="absolute inset-x-0 bottom-0 border-t border-line bg-surface/95 p-3 backdrop-blur">
            <Button block disabled={picked.length === 0} onClick={() => setStep('details')}>
              Next · {picked.length} selected
            </Button>
          </div>
        </>
      ) : (
        <>
          <PageHeader title="Name your group" actions={<IconButton icon="back" label="Back to members" onClick={() => setStep('members')} />} />
          <div className="scroll-thin flex-1 overflow-y-auto px-4 pb-10 pt-6">
            <div className="mx-auto max-w-md">
              <div className="flex items-center gap-4">
                <Avatar name={title || 'Group'} group size={72} />
                <TextField
                  label="Group name"
                  className="flex-1"
                  value={title}
                  maxLength={GROUP_LIMITS.titleMax}
                  autoFocus
                  placeholder="Weekend plans ✨"
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && title.trim() && void create()}
                />
              </div>
              <SectionLabel>Members · {picked.length + 1}</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {[{ id: me.id, displayName: 'You', avatarUrl: me.avatarUrl }, ...picked].map((u) => (
                  <span key={u.id} className="inline-flex items-center gap-2 rounded-full bg-surface-2 py-1 pl-1 pr-3 text-sm">
                    <Avatar name={u.displayName} src={u.avatarUrl} size={26} />
                    {u.displayName}
                  </span>
                ))}
              </div>
              <Button block className="mt-8" icon="check" loading={busy} disabled={!title.trim()} onClick={create}>
                Create group
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ================= Group info ================= */
export function GroupInfoPage({ conversationId: id }: { conversationId: string }) {
  const navigate = useNavigate();
  const me = useAuth((s) => s.me)!;
  const conversation = useChat((s) => s.conversations[id]);
  const [mode, setMode] = useState<'info' | 'add'>('info');
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<GroupMember | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const group = conversation?.group;
  const exclude = useMemo(() => new Set(group?.members.map((m) => m.id) ?? []), [group?.members]);
  if (!conversation || !group) {
    return (
      <div className="flex h-full items-center justify-center text-primary">
        <Spinner />
      </div>
    );
  }
  const isAdmin = group.myRole === 'admin';
  const members = [...group.members].sort((a, b) =>
    a.id === me.id ? -1 : b.id === me.id ? 1 : a.role !== b.role ? (a.role === 'admin' ? -1 : 1) : a.displayName.localeCompare(b.displayName),
  );

  async function act(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    try {
      await fn();
      if (done) toast({ title: done, tone: 'success' });
    } catch (e) {
      toast({ title: 'Couldn’t update the group', body: errMsg(e), tone: 'error' });
    } finally {
      setBusy(null);
    }
  }
  const upsert = (c: Awaited<ReturnType<typeof backend.renameGroup>>) => useChat.getState().upsertConversation(c);

  if (mode === 'add') {
    return (
      <div className="relative flex h-full flex-col bg-surface">
        <PageHeader title="Add members" actions={<IconButton icon="x" label="Cancel" onClick={() => setMode('info')} />} />
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <PeoplePicker picked={picked} setPicked={setPicked} exclude={exclude} />
        </div>
        <div className="absolute inset-x-0 bottom-0 border-t border-line bg-surface/95 p-3 backdrop-blur">
          <Button
            block
            disabled={!picked.length}
            loading={busy === 'add'}
            onClick={() =>
              act('add', async () => {
                upsert(await backend.addGroupMembers(id, picked.map((u) => u.id)));
                setPicked([]);
                setMode('info');
              }, 'Members added')
            }
          >
            Add {picked.length || ''} {picked.length === 1 ? 'person' : 'people'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <PageHeader title="Group info" back={`/chats/${id}`} />
      <div className="scroll-thin flex-1 overflow-y-auto px-4 pb-10">
        <div className="mx-auto max-w-md">
          <div className="flex flex-col items-center pt-6 text-center">
            <button
              className="group relative rounded-full"
              disabled={!isAdmin}
              onClick={() => photoInput.current?.click()}
              aria-label={isAdmin ? 'Change group photo' : undefined}
            >
              <Avatar name={conversation.peer.displayName} src={group.avatarUrl} group size={112} />
              {isAdmin && (
                <span className="absolute bottom-1 right-1 flex h-9 w-9 items-center justify-center rounded-full bg-primary text-on-primary shadow-lg">
                  {busy === 'photo' ? <Spinner size={16} /> : <Icon name="camera" size={18} />}
                </span>
              )}
            </button>
            <input
              ref={photoInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void act('photo', async () => upsert(await backend.setGroupAvatar(id, f)), 'Group photo updated');
              }}
            />
            {editing ? (
              <div className="mt-4 flex w-full items-end gap-2">
                <TextField label="Group name" className="flex-1" value={title} maxLength={GROUP_LIMITS.titleMax} autoFocus onChange={(e) => setTitle(e.target.value)} />
                <Button
                  loading={busy === 'rename'}
                  disabled={!title.trim()}
                  onClick={() =>
                    act('rename', async () => {
                      upsert(await backend.renameGroup(id, title.trim()));
                      setEditing(false);
                    })
                  }
                >
                  Save
                </Button>
              </div>
            ) : (
              <h2 className="mt-4 flex items-center gap-1 text-2xl font-extrabold">
                {conversation.peer.displayName}
                {isAdmin && (
                  <IconButton
                    icon="edit"
                    label="Rename group"
                    onClick={() => {
                      setTitle(conversation.peer.displayName);
                      setEditing(true);
                    }}
                  />
                )}
              </h2>
            )}
            <p className="text-muted">Group · {group.memberCount} members</p>
          </div>

          <SectionLabel>{group.memberCount} members</SectionLabel>
          <Card className="overflow-hidden p-1">
            {isAdmin && (
              <button onClick={() => setMode('add')} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left font-semibold text-primary hover:bg-surface-2">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-on-primary">
                  <Icon name="plus" />
                </span>
                Add members
              </button>
            )}
            {members.map((m) => (
              <button
                key={m.id}
                onClick={() => m.id !== me.id && setMenuFor(m)}
                className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left hover:bg-surface-2"
              >
                <Avatar name={m.displayName} src={m.avatarUrl} online={m.online} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{m.id === me.id ? 'You' : m.displayName}</span>
                  <span className="block truncate text-sm text-muted">{m.id === me.id ? `@${m.username}` : presenceText(m.online, m.lastSeenAt) || `@${m.username}`}</span>
                </span>
                {m.role === 'admin' && <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-bold text-primary">Admin</span>}
              </button>
            ))}
          </Card>

          <Button
            variant="danger"
            block
            icon="logout"
            className="mt-6"
            loading={busy === 'leave'}
            onClick={() => {
              if (!confirm(`Leave “${conversation.peer.displayName}”?`)) return;
              void act('leave', async () => {
                await backend.removeGroupMember(id, me.id);
                useChat.getState().removeConversation(id);
                navigate('/', { replace: true });
              }, 'You left the group');
            }}
          >
            Leave group
          </Button>
        </div>
      </div>

      {menuFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center" onClick={() => setMenuFor(null)} role="dialog" aria-label={`Options for ${menuFor.displayName}`}>
          <div className="pop-in w-full max-w-sm rounded-t-3xl bg-surface p-3 pb-6 md:rounded-3xl md:pb-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar name={menuFor.displayName} src={menuFor.avatarUrl} size={44} />
              <span className="min-w-0">
                <span className="block truncate font-bold">{menuFor.displayName}</span>
                <span className="text-sm text-muted">@{menuFor.username}</span>
              </span>
            </div>
            <MenuItem
              icon="chat"
              label={`Message ${menuFor.displayName.split(' ')[0]}`}
              onClick={async () => {
                const c = await backend.openConversation(menuFor.id).catch((e) => {
                  toast({ title: 'Couldn’t open chat', body: errMsg(e), tone: 'error' });
                  return null;
                });
                if (c) {
                  useChat.getState().upsertConversation(c);
                  navigate(`/chats/${c.id}`);
                }
              }}
            />
            {isAdmin && (
              <>
                <MenuItem
                  icon="shield"
                  label={menuFor.role === 'admin' ? 'Dismiss as admin' : 'Make group admin'}
                  onClick={() => {
                    const target = menuFor;
                    setMenuFor(null);
                    void act('role', async () => upsert(await backend.setGroupRole(id, target.id, target.role === 'admin' ? 'member' : 'admin')));
                  }}
                />
                <MenuItem
                  icon="trash"
                  danger
                  label={`Remove ${menuFor.displayName.split(' ')[0]}`}
                  onClick={() => {
                    const target = menuFor;
                    setMenuFor(null);
                    void act('remove', async () => {
                      const c = await backend.removeGroupMember(id, target.id);
                      if (c) upsert(c);
                    }, `${target.displayName} removed`);
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: 'chat' | 'shield' | 'trash'; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn('flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left font-semibold hover:bg-surface-2', danger ? 'text-danger' : 'text-ink')}>
      <Icon name={icon} />
      {label}
    </button>
  );
}
