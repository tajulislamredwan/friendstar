import type { BotKind, PublicUser } from '@friendstar/shared';
import { cn } from '../../lib/format.ts';
import { toast } from '../../store/index.ts';
import { Avatar } from '../ui/index.tsx';
import { Icon } from '../ui/Icon.tsx';

/** Public invite link that opens someone's profile by FriendStar ID. */
export function profileLink(friendId: string) {
  return `${location.origin}/u/${encodeURIComponent(friendId)}`;
}

export async function copyText(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: what, tone: 'success' });
  } catch {
    toast({ title: 'Couldn’t copy', body: text, tone: 'error' });
  }
}

/** Uses the phone's share sheet when available, otherwise copies the link. */
export async function shareProfile(user: Pick<PublicUser, 'displayName' | 'friendId'>) {
  const url = profileLink(user.friendId);
  const text = `Join me on FriendStar and find my profile: ${user.displayName} · ID ${user.friendId}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Invite a friend to FriendStar', text, url });
      return;
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
    }
  }
  await copyText(`${text}\n${url}`, 'Friend invite copied');
}

/** "FS-7K2QX9" with a one-tap copy button. */
export function FriendIdChip({ code, className, compact }: { code: string; className?: string; compact?: boolean }) {
  if (!code) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void copyText(code, `ID ${code} copied`);
      }}
      title="Copy FriendStar ID"
      aria-label={`FriendStar ID ${code}, tap to copy`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary-soft font-mono font-semibold tracking-wide text-primary transition hover:border-primary/50 active:scale-95',
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-[13px]',
        className,
      )}
    >
      <Icon name={compact ? 'idcard' : 'idcard'} size={compact ? 12 : 15} />
      {code}
      {!compact && <Icon name="copy" size={14} className="opacity-70" />}
    </button>
  );
}

const BOT_LABEL: Record<BotKind, string> = { ai: 'AI', guide: 'Guide', echo: 'Bot', fun: 'Bot' };

export function BotBadge({ kind, className }: { kind: BotKind | null | undefined; className?: string }) {
  if (!kind) return null;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-full bg-star/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-star', className)}>
      <Icon name={kind === 'ai' ? 'sparkles' : 'bot'} size={11} />
      {BOT_LABEL[kind]}
    </span>
  );
}

/** One person in a list: avatar, name (+ bot badge), @username and ID. */
export function PersonRow({
  user,
  onClick,
  right,
  subtitle,
  busy,
}: {
  user: PublicUser;
  onClick?: () => void;
  right?: React.ReactNode;
  subtitle?: string;
  busy?: boolean;
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={busy ? undefined : onClick}
      onKeyDown={(e) => onClick && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}
      className={cn('flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition', onClick && 'cursor-pointer hover:bg-surface-2', busy && 'opacity-60')}
    >
      <Avatar name={user.displayName} src={user.avatarUrl} online={user.bot ? null : user.online} size={46} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{user.displayName}</span>
          <BotBadge kind={user.bot} />
        </p>
        <p className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
          <span className="truncate">{subtitle ?? `@${user.username}`}</span>
          <FriendIdChip code={user.friendId} compact className="shrink-0" />
        </p>
      </div>
      {right}
    </div>
  );
}
