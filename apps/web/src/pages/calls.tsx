import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CallInfo, GroupCallInfo } from '@friendstar/shared';
import { backend } from '../api/index.ts';
import { PageHeader } from '../components/layout/index.tsx';
import { formatDuration } from '../components/call/CallScreen.tsx';
import { Avatar, EmptyState, IconButton, Spinner } from '../components/ui/index.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import { cn, formatListTime } from '../lib/format.ts';
import { toast, useAuth } from '../store/index.ts';
import { callUser, useCall } from '../store/call.ts';
import { useGroupCall } from '../store/groupCall.ts';
import { useJoinGroupCall } from '../components/call/GroupCallScreen.tsx';

function describe(c: CallInfo, meId: string) {
  const outgoing = c.callerId === meId;
  const kind = c.media === 'video' ? 'Video' : 'Voice';
  const missed = !outgoing && (c.status === 'missed' || c.status === 'unavailable');
  const duration = c.answeredAt && c.endedAt ? formatDuration(new Date(c.endedAt).getTime() - new Date(c.answeredAt).getTime()) : null;
  let label: string;
  if (missed) label = `Missed ${kind.toLowerCase()} call`;
  else if (c.status === 'declined') label = outgoing ? 'Declined' : `Declined ${kind.toLowerCase()} call`;
  else if (c.status === 'busy') label = 'Busy';
  else if (c.status === 'ringing' || c.status === 'ongoing') label = 'In progress';
  else if (!c.answeredAt) label = outgoing ? 'No answer' : `Missed ${kind.toLowerCase()} call`;
  else label = `${outgoing ? 'Outgoing' : 'Incoming'} · ${duration}`;
  return { outgoing, missed: missed || (!outgoing && !c.answeredAt && c.status !== 'declined'), label };
}

function describeGroup(c: GroupCallInfo) {
  const kind = c.media === 'video' ? 'video' : 'voice';
  const live = c.status === 'ongoing';
  const missed = !live && !c.history?.iJoined;
  const duration = c.endedAt ? formatDuration(new Date(c.endedAt).getTime() - new Date(c.createdAt).getTime()) : null;
  const joined = c.history?.joined ?? c.participants.length;
  const label = live
    ? `Live now · ${c.participants.length} in call · tap to join`
    : missed
      ? `Missed group ${kind} call`
      : `Group ${kind} call · ${joined} joined${duration ? ` · ${duration}` : ''}`;
  return { live, missed, label };
}

type Entry = { kind: 'direct'; at: string; call: CallInfo } | { kind: 'group'; at: string; call: GroupCallInfo };

export function CallsPage() {
  const me = useAuth((s) => s.me)!;
  const navigate = useNavigate();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const phase = useCall((s) => s.phase);
  const groupPhase = useGroupCall((s) => s.phase);
  const active = useGroupCall((s) => s.active);
  const joinGroup = useJoinGroupCall();

  useEffect(() => {
    let alive = true;
    Promise.all([backend.listCalls().catch(() => [] as CallInfo[]), backend.groupCallHistory().catch(() => [] as GroupCallInfo[])]).then(
      ([direct, group]) => {
        if (!alive) return;
        const all: Entry[] = [
          ...direct.map((call) => ({ kind: 'direct' as const, at: call.createdAt, call })),
          ...group.map((call) => ({ kind: 'group' as const, at: call.createdAt, call })),
        ];
        setEntries(all.sort((x, y) => y.at.localeCompare(x.at)));
      },
    );
    return () => {
      alive = false;
    };
    // Refresh when a call finishes, or a group call starts/ends somewhere.
  }, [phase === 'idle', groupPhase === 'idle', Object.keys(active).join()]);

  const start = (c: CallInfo, media: CallInfo['media']) =>
    void callUser(c.conversationId, c.peer, media, (msg) => toast({ title: 'Can’t start the call', body: msg, tone: 'error' }));

  return (
    <div className="flex h-full flex-col bg-surface">
      <PageHeader title="Calls" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="mx-auto max-w-2xl">
          <div className="mx-2 mb-3 flex items-start gap-3 rounded-2xl bg-primary-soft p-3 text-sm text-primary">
            <Icon name="lock" size={18} className="mt-0.5 shrink-0" />
            <span>Calls go directly between devices and are encrypted. Call a friend from their chat, or start a group call (up to 6 people) from any group.</span>
          </div>
          {!entries ? (
            <div className="flex justify-center py-16 text-primary">
              <Spinner />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState icon="phone" title="No calls yet" body="Open a chat or group and tap the phone or camera icon to start a call." />
          ) : (
            entries.map((e) => {
              if (e.kind === 'group') {
                const c = e.call;
                const d = describeGroup(c);
                return (
                  <div key={`g-${c.id}`} className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-surface-2">
                    <button
                      onClick={() => (d.live ? void joinGroup(c.conversationId, c.media) : navigate(`/chats/${c.conversationId}`))}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <Avatar name={c.title} src={null} group size={50} />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate font-semibold', d.missed && 'text-danger')}>{c.title}</span>
                        <span className={cn('flex items-center gap-1 text-sm', d.live ? 'font-semibold text-success' : d.missed ? 'text-danger' : 'text-muted')}>
                          <Icon name="users" size={15} />
                          <span className="truncate">
                            {d.label}
                            {!d.live && ` · ${formatListTime(c.createdAt)}`}
                          </span>
                        </span>
                      </span>
                    </button>
                    <IconButton
                      icon={c.media === 'video' ? 'video' : 'phone'}
                      label={`${d.live ? 'Join' : 'Start'} group call in ${c.title}`}
                      onClick={() => void joinGroup(c.conversationId, c.media)}
                      className={d.live ? 'bg-success/15 text-success' : 'text-primary'}
                    />
                  </div>
                );
              }
              const c = e.call;
              const d = describe(c, me.id);
              return (
                <div key={c.id} className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-surface-2">
                  <button onClick={() => navigate(`/chats/${c.conversationId}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Avatar name={c.peer.displayName} src={c.peer.avatarUrl} online={c.peer.online} size={50} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate font-semibold', d.missed && 'text-danger')}>{c.peer.displayName}</span>
                      <span className={cn('flex items-center gap-1 text-sm', d.missed ? 'text-danger' : 'text-muted')}>
                        <Icon name={d.outgoing ? 'callOut' : 'callIn'} size={15} className={cn(!d.missed && (d.outgoing ? 'text-primary' : 'text-success'))} />
                        <span className="truncate">
                          {d.label} · {formatListTime(c.createdAt)}
                        </span>
                      </span>
                    </span>
                  </button>
                  <IconButton icon={c.media === 'video' ? 'video' : 'phone'} label={`${c.media === 'video' ? 'Video' : 'Voice'} call ${c.peer.displayName}`} onClick={() => start(c, c.media)} className="text-primary" />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
