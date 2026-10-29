export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Chat list timestamps: time today, "Yesterday", weekday this week, otherwise a date. */
export function formatListTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return formatTime(iso);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

export function presenceText(online: boolean | null, lastSeenAt: string | null) {
  if (online) return 'online';
  if (!lastSeenAt) return '';
  const d = new Date(lastSeenAt);
  const now = new Date();
  if (now.getTime() - d.getTime() < 60_000) return 'last seen just now';
  if (sameDay(d, now)) return `last seen today at ${formatTime(lastSeenAt)}`;
  return `last seen ${formatListTime(lastSeenAt)}${sameDay(d, now) ? '' : ` at ${formatTime(lastSeenAt)}`}`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function messagePreview(m: { kind: string; body: string; file?: { name: string } | null } | null) {
  if (!m) return '';
  if (m.kind === 'image') return m.body ? `📷 ${m.body}` : '📷 Photo';
  if (m.kind === 'file') return `📎 ${m.body || m.file?.name || 'File'}`;
  return m.body;
}

export const newClientId = () =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

/** Split text into plain and http(s) link parts; rendered as text nodes, never as HTML. */
export function linkify(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = [];
  const re = /\bhttps?:\/\/[^\s<>"']+/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i) });
    out.push({ text: m[0], href: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
