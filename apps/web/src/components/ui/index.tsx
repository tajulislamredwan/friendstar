import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/format.ts';
import { Icon, type IconName } from './Icon.tsx';

/* ---------- Logo ---------- */
export function Logo({ size = 40, withWord = false, className }: { size?: number; withWord?: boolean; className?: string }) {
  const gid = useId();
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6D5DF6" />
            <stop offset="1" stopColor="#9B4BDB" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="18" fill={`url(#${gid})`} />
        <path
          d="M32 13.5c1.1 0 2 .6 2.5 1.6l4.4 9 9.9 1.4c2.3.3 3.2 3.1 1.5 4.7l-7.2 7 1.7 9.8c.4 2.3-2 4-4 2.9L32 45.3l-8.8 4.6c-2 1.1-4.4-.6-4-2.9l1.7-9.8-7.2-7c-1.7-1.6-.8-4.4 1.5-4.7l9.9-1.4 4.4-9c.5-1 1.4-1.6 2.5-1.6z"
          fill="#fff"
        />
        <circle cx="46" cy="17" r="4.5" fill="#FFB020" />
      </svg>
      {withWord && (
        <span className="text-xl font-extrabold tracking-tight">
          Friend<span className="text-primary">Star</span>
        </span>
      )}
    </span>
  );
}

/* ---------- Button ---------- */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'onMedia';
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean; icon?: IconName; block?: boolean }
>(function Button({ variant = 'primary', loading, icon, block, className, children, disabled, ...rest }, ref) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-primary text-on-primary hover:bg-primary-strong shadow-sm shadow-primary/25',
    secondary: 'bg-primary-soft text-primary hover:brightness-95',
    ghost: 'text-ink hover:bg-surface-2',
    // White pill for use on top of photos, video and coloured story backgrounds.
    onMedia: 'bg-white text-[#1a1630] hover:bg-white/90 shadow-sm',
    danger: 'bg-danger/10 text-danger hover:bg-danger/15',
  };
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex h-11 items-center justify-center gap-2 rounded-2xl px-5 text-[15px] font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60',
        styles[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={18} /> : icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  );
});

export function IconButton({
  icon,
  label,
  className,
  badge,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; badge?: number }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink/80 transition hover:bg-surface-2 active:scale-95 disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={22} />
      {!!badge && <CountBadge count={badge} className="absolute -right-0.5 -top-0.5" />}
    </button>
  );
}

/* ---------- Inputs ---------- */
export const TextField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }
>(function TextField({ label, error, hint, className, id, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label htmlFor={inputId} className={cn('block', className)}>
      <span className="mb-1.5 block text-sm font-medium text-ink/80">{label}</span>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={!!error}
        aria-describedby={error || hint ? `${inputId}-msg` : undefined}
        className={cn(
          'h-12 w-full rounded-2xl border bg-surface px-4 text-[15px] text-ink outline-none transition placeholder:text-muted/70 focus:border-primary focus:ring-4 focus:ring-primary/15',
          error ? 'border-danger' : 'border-line',
        )}
        {...rest}
      />
      {(error || hint) && (
        <span id={`${inputId}-msg`} className={cn('mt-1.5 block text-xs', error ? 'text-danger' : 'text-muted')}>
          {error ?? hint}
        </span>
      )}
    </label>
  );
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }>(
  function TextArea({ label, hint, className, ...rest }, ref) {
    const id = useId();
    return (
      <label htmlFor={id} className={cn('block', className)}>
        <span className="mb-1.5 block text-sm font-medium text-ink/80">{label}</span>
        <textarea
          ref={ref}
          id={id}
          className="min-h-24 w-full resize-none rounded-2xl border border-line bg-surface px-4 py-3 text-[15px] text-ink outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15"
          {...rest}
        />
        {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
      </label>
    );
  },
);

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative">
      <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-11 w-full rounded-full border border-transparent bg-surface-2 pl-10 pr-4 text-[15px] text-ink outline-none transition placeholder:text-muted focus:border-primary/40 focus:bg-surface"
      />
    </div>
  );
}

/* ---------- Avatar ---------- */
const HUES = [252, 280, 320, 200, 170, 30, 12];
export function Avatar({
  name,
  src,
  size = 48,
  online,
  className,
  group,
  ring,
}: {
  name: string;
  src?: string | null;
  size?: number;
  online?: boolean | null;
  className?: string;
  /** Show a group glyph instead of initials when there is no photo. */
  group?: boolean;
  /** Status-story ring: bright for unseen updates, muted once seen. */
  ring?: 'new' | 'seen' | null;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  const hue = HUES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {src ? (
        <img src={src} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full font-bold text-white"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${hue + 30} 65% 48%))`,
            fontSize: size * 0.38,
          }}
        >
          {group ? <Icon name="users" size={size * 0.5} /> : initials || '?'}
        </span>
      )}
      {ring && (
        <span
          aria-hidden="true"
          className={cn('pointer-events-none absolute rounded-full border-[2.5px]', ring === 'new' ? 'status-ring-new' : 'border-line')}
          style={{ inset: -4 }}
        />
      )}
      {online && (
        <span
          className="absolute bottom-0 right-0 rounded-full border-2 border-surface bg-success"
          style={{ width: Math.max(10, size * 0.26), height: Math.max(10, size * 0.26) }}
          aria-label="online"
        />
      )}
    </span>
  );
}

/* ---------- Badges, spinners, toggles ---------- */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-star px-1.5 text-[11px] font-bold text-[#2a1a00]',
        className,
      )}
      aria-label={`${count} unread`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function SoonTag({ className }: { className?: string }) {
  return (
    <span className={cn('rounded-full bg-star/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#9a5b00] dark:text-star', className)}>
      Soon
    </span>
  );
}

export function Spinner({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} width={size} height={size} viewBox="0 0 24 24" aria-label="Loading">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50', checked ? 'bg-primary' : 'bg-line')}
    >
      <span className={cn('absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-6' : 'left-1')} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-2xl bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-sm font-semibold transition',
            value === o.value ? 'bg-surface text-primary shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {o.icon && <Icon name={o.icon} size={16} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
      <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-primary-soft text-primary">
        <Icon name={icon} size={30} />
      </span>
      <h3 className="text-lg font-bold">{title}</h3>
      {body && <p className="mt-1 max-w-xs text-sm text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-3xl border border-line bg-surface', className)}>{children}</div>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 mt-6 px-1 text-xs font-bold uppercase tracking-wider text-muted first:mt-0">{children}</h2>;
}
