import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { normalizeFriendId, type PublicUser } from '@friendstar/shared';
import { ApiError, backend } from '../api/index.ts';
import { PageHeader } from '../components/layout/index.tsx';
import { BotBadge, FriendIdChip, PersonRow, shareProfile } from '../components/people/index.tsx';
import { Avatar, Button, EmptyState, SearchInput, Spinner } from '../components/ui/index.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import { presenceText } from '../lib/format.ts';
import { useDebounced } from '../lib/hooks.ts';
import { toast, useAuth, useChat } from '../store/index.ts';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

/** Open (or create) the one-to-one chat with someone and go there. */
function useOpenChat() {
  const navigate = useNavigate();
  const [opening, setOpening] = useState<string | null>(null);
  async function open(user: PublicUser) {
    setOpening(user.id);
    try {
      const c = await backend.openConversation(user.id);
      useChat.getState().upsertConversation(c);
      navigate(`/chats/${c.id}`);
    } catch (e) {
      toast({ title: 'Couldn’t open chat', body: errMsg(e), tone: 'error' });
    } finally {
      setOpening(null);
    }
  }
  return { open, opening };
}

/** Card with my own ID, for sharing with friends. */
export function MyIdCard() {
  const me = useAuth((s) => s.me);
  if (!me) return null;
  return (
    <div className="rounded-3xl border border-primary/20 bg-gradient-to-br from-primary-soft to-surface p-4">
      <div className="flex items-center gap-3">
        <Avatar name={me.displayName} src={me.avatarUrl} size={48} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-muted">Your FriendStar ID</p>
          <FriendIdChip code={me.friendId} className="mt-1" />
        </div>
      </div>
      <p className="mt-3 text-[13px] text-muted">Invite a friend with your link so they can find you and connect on FriendStar.</p>
      <Button variant="secondary" icon="share" className="mt-3 h-10 text-sm" onClick={() => void shareProfile(me)}>
        Invite friends
      </Button>
    </div>
  );
}

export function PeoplePage() {
  const me = useAuth((s) => s.me)!;
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  const [people, setPeople] = useState<PublicUser[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [results, setResults] = useState<PublicUser[] | null>(null);
  const { open, opening } = useOpenChat();

  useEffect(() => {
    backend
      .listPeople()
      .then((p) => {
        setPeople(p.people);
        setTotal(p.total);
        setCursor(p.nextCursor);
      })
      .catch(() => setPeople([]));
  }, []);

  useEffect(() => {
    if (!query) return setResults(null);
    let alive = true;
    backend
      .search(query)
      .then((r) => alive && setResults(r.users))
      .catch(() => alive && setResults([]));
    return () => {
      alive = false;
    };
  }, [query]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const p = await backend.listPeople(cursor);
      setPeople((prev) => [...(prev ?? []), ...p.people.filter((u) => !prev?.some((x) => x.id === u.id))]);
      setCursor(p.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  const list = (results ?? people ?? []).filter((u) => u.id !== me.id);
  const bots = results ? [] : list.filter((u) => u.bot);
  const humans = results ? list : list.filter((u) => !u.bot);
  const looksLikeId = !!normalizeFriendId(q);
  const row = (u: PublicUser) => (
    <PersonRow
      key={u.id}
      user={u}
      busy={opening === u.id}
      onClick={() => void open(u)}
      subtitle={u.bot ? u.bio || `@${u.username}` : u.online ? 'Online' : `@${u.username}`}
      right={opening === u.id ? <Spinner size={18} className="text-primary" /> : <Icon name="chat" size={20} className="text-primary" />}
    />
  );

  return (
    <div className="flex h-full flex-col bg-surface">
      <PageHeader title="People">
        <SearchInput value={q} onChange={setQ} placeholder="Name, email or FriendStar ID" />
      </PageHeader>
      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-10 pt-2">
        <div className="mx-auto max-w-2xl">
          {!results && (
            <div className="px-2 pb-2">
              <MyIdCard />
            </div>
          )}
          {people === null ? (
            <div className="flex justify-center py-16 text-primary">
              <Spinner />
            </div>
          ) : results && results.length === 0 ? (
            <EmptyState
              icon="search"
              title="No one found"
              body={
                looksLikeId
                  ? 'No one has that FriendStar ID. Check the letters and numbers.'
                  : 'Names only show people who appear in search. A full email or FriendStar ID always finds them.'
              }
            />
          ) : (
            <>
              {bots.length > 0 && (
                <>
                  <p className="px-3 pb-1 pt-3 text-xs font-bold uppercase tracking-wider text-muted">FriendStar bots</p>
                  {bots.map(row)}
                </>
              )}
              <p className="px-3 pb-1 pt-3 text-xs font-bold uppercase tracking-wider text-muted">
                {results ? 'Results' : `Everyone · ${Math.max(0, total - bots.length)} ${total - bots.length === 1 ? 'person' : 'people'}`}
              </p>
              {humans.length === 0 && !results ? (
                <p className="px-3 py-6 text-center text-sm text-muted">You’re one of the first here. Share your ID to invite friends!</p>
              ) : (
                humans.map(row)
              )}
              {!results && cursor && (
                <div className="flex justify-center py-3">
                  <Button variant="secondary" className="h-9 text-sm" loading={loadingMore} onClick={() => void more()}>
                    Show more
                  </Button>
                </div>
              )}
              {!results && (
                <p className="px-4 pt-4 text-center text-xs text-muted">
                  People who turned off “Appear in search” aren’t listed, but their email or ID still finds them.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** /u/:code — opens someone's profile from a shared link. */
export function InvitePage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const me = useAuth((s) => s.me)!;
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined);
  const { open, opening } = useOpenChat();

  useEffect(() => {
    const id = normalizeFriendId(code);
    if (!id) return setUser(null);
    backend
      .userByFriendId(id)
      .then(setUser)
      .catch(() => setUser(null));
  }, [code]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <PageHeader title="Profile" back="/people" />
      <div className="flex flex-1 items-start justify-center px-4 pt-8">
        {user === undefined ? (
          <Spinner className="text-primary" />
        ) : user === null ? (
          <EmptyState icon="search" title="Profile not found" body="This link or ID doesn’t match anyone on FriendStar." action={<Button onClick={() => navigate('/people')}>Find people</Button>} />
        ) : (
          <div className="w-full max-w-sm rounded-3xl border border-line bg-surface p-6 text-center shadow-sm">
            <Avatar name={user.displayName} src={user.avatarUrl} size={104} online={user.bot ? null : user.online} className="mx-auto" />
            <h2 className="mt-4 flex items-center justify-center gap-2 text-2xl font-extrabold">
              {user.displayName}
              <BotBadge kind={user.bot} />
            </h2>
            <p className="text-muted">@{user.username}</p>
            <FriendIdChip code={user.friendId} className="mt-3" />
            {!user.bot && <p className="mt-2 text-sm text-primary">{presenceText(user.online, user.lastSeenAt)}</p>}
            {user.bio && <p className="mt-3 text-[15px]">{user.bio}</p>}
            {user.id === me.id ? (
              <p className="mt-5 text-sm text-muted">This is you. Share this link so friends can find you.</p>
            ) : (
              <Button block icon="chat" className="mt-6" loading={opening === user.id} onClick={() => void open(user)}>
                Message {user.displayName.split(' ')[0]}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
