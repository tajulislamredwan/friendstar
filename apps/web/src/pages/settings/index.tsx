import { FriendIdChip, shareProfile } from '../../components/people/index.tsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LIMITS, type Audience, type OfflineReplySettings, type PrivacySettings, type PublicUser } from '@friendstar/shared';
import { ApiError, backend, isDemo } from '../../api/index.ts';
import { Page, PageHeader } from '../../components/layout/index.tsx';
import { Avatar, Button, Card, SectionLabel, Segmented, Spinner, TextArea, TextField, Toggle } from '../../components/ui/index.tsx';
import { Icon, type IconName } from '../../components/ui/Icon.tsx';
import { StatusTicks } from '../../components/chat/index.tsx';
import { cn } from '../../lib/format.ts';
import { getNotifyPrefs, notificationsSupported, playChime, requestDesktopPermission, setNotifyPrefs, type NotifyPrefs } from '../../lib/notify.ts';
import { toast, useAuth, useTheme, type ThemeMode } from '../../store/index.ts';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

function Row({ icon, title, subtitle, to, onClick, right, danger }: { icon: IconName; title: string; subtitle?: string; to?: string; onClick?: () => void; right?: ReactNode; danger?: boolean }) {
  const inner = (
    <>
      <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl', danger ? 'bg-danger/10 text-danger' : 'bg-primary-soft text-primary')}>
        <Icon name={icon} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block font-semibold', danger && 'text-danger')}>{title}</span>
        {subtitle && <span className="block truncate text-sm text-muted">{subtitle}</span>}
      </span>
      {right ?? (to && <Icon name="chevron" size={20} className="text-muted" />)}
    </>
  );
  const cls = 'flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-2 border-b border-line last:border-0';
  return to ? (
    <Link to={to} className={cls}>
      {inner}
    </Link>
  ) : (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

function SettingsFrame({ title, children, back = '/settings' }: { title: string; children: ReactNode; back?: string }) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={title} back={back} />
      <Page className="mx-auto w-full max-w-2xl px-4 py-5 pb-12">{children}</Page>
    </div>
  );
}

/* ================= Settings home ================= */
export function SettingsPage() {
  const { me, logout } = useAuth();
  const mode = useTheme((s) => s.mode);
  if (!me) return null;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" />
      <Page className="mx-auto w-full max-w-2xl px-4 py-5 pb-12">
        <Link to="/settings/profile" className="mb-6 flex items-center gap-4 rounded-3xl border border-line bg-surface p-4 transition hover:bg-surface-2">
          <Avatar name={me.displayName} src={me.avatarUrl} size={64} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg font-bold">{me.displayName}</span>
            <span className="block truncate text-sm text-muted">@{me.username}</span>
            {me.bio && <span className="block truncate text-sm">{me.bio}</span>}
          </span>
          <Icon name="chevron" className="text-muted" />
        </Link>
        <div className="-mt-3 mb-6 flex flex-wrap items-center gap-2 rounded-3xl border border-line bg-surface px-4 py-3">
          <span className="text-sm font-semibold text-muted">Your ID</span>
          <FriendIdChip code={me.friendId} />
          <span className="flex-1" />
          <button onClick={() => void shareProfile(me)} className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1.5 text-[13px] font-semibold text-primary">
            <Icon name="share" size={15} /> Share
          </button>
        </div>
        <Card>
          <Row icon="user" title="Profile" subtitle="Name, photo and bio" to="/settings/profile" />
          <Row icon="lock" title="Privacy" subtitle="Last seen, read receipts, blocked people" to="/settings/privacy" />
          <Row icon="chat" title="Offline reply" subtitle="Set a message for when you’re away" to="/settings/offline-reply" />
          <Row icon="palette" title="Appearance" subtitle={`Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`} to="/settings/appearance" />
          <Row icon="bell" title="Notifications" subtitle="Alerts, sounds and previews" to="/settings/notifications" />
        </Card>
        {me.isOwner && (
          <Card className="mt-4">
            <Row icon="chart" title="Admin dashboard" subtitle="Account IDs, emails and sign-in dates" to="/admin" />
          </Card>
        )}
        <Card className="mt-4">
          <Row icon="logout" title="Sign out" danger onClick={() => void logout()} />
        </Card>
        <p className="mt-6 text-center text-xs text-muted">FriendStar{isDemo ? ' · preview mode' : ''} · made with ★</p>
      </Page>
    </div>
  );
}

/* ================= Profile ================= */
export function ProfileSettingsPage() {
  const { me, setMe } = useAuth();
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!me) return null;
  const dirty = displayName.trim() !== me.displayName || bio.trim() !== me.bio;

  async function save() {
    setSaving(true);
    try {
      setMe(await backend.updateProfile({ displayName, bio }));
      toast({ title: 'Profile saved', tone: 'success' });
    } catch (e) {
      toast({ title: 'Couldn’t save', body: errMsg(e), tone: 'error' });
    } finally {
      setSaving(false);
    }
  }
  async function upload(file: File) {
    setUploading(true);
    try {
      setMe(await backend.uploadAvatar(file));
    } catch (e) {
      toast({ title: 'Couldn’t update photo', body: errMsg(e), tone: 'error' });
    } finally {
      setUploading(false);
    }
  }

  return (
    <SettingsFrame title="Profile">
      <div className="flex flex-col items-center">
        <button onClick={() => fileRef.current?.click()} className="group relative" aria-label="Change profile photo">
          <Avatar name={me.displayName} src={me.avatarUrl} size={112} />
          <span className="absolute bottom-0 right-0 flex h-10 w-10 items-center justify-center rounded-full border-4 border-bg bg-primary text-on-primary">
            {uploading ? <Spinner size={16} /> : <Icon name="camera" size={18} />}
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
        {me.avatarUrl && (
          <button className="mt-2 text-sm font-semibold text-danger" onClick={async () => setMe(await backend.removeAvatar())}>
            Remove photo
          </button>
        )}
      </div>
      <div className="mt-6 space-y-4">
        <TextField label="Name" value={displayName} maxLength={LIMITS.displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <TextArea label="Bio" value={bio} maxLength={LIMITS.bio} onChange={(e) => setBio(e.target.value)} hint={`${bio.length}/${LIMITS.bio}`} />
        <TextField label="Username" value={`@${me.username}`} disabled hint="Usernames can’t be changed yet." />
        <TextField label="Email" value={me.email} disabled />
        <Button block onClick={save} loading={saving} disabled={!dirty || !displayName.trim()}>
          Save changes
        </Button>
      </div>
    </SettingsFrame>
  );
}

/* ================= Privacy ================= */
const AUDIENCE: { value: Audience; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'nobody', label: 'Nobody' },
];

function SettingBlock({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="border-b border-line px-4 py-4 last:border-0">
      <p className="font-semibold">{title}</p>
      <p className="mb-3 text-sm text-muted">{body}</p>
      {children}
    </div>
  );
}
function ToggleBlock({ title, body, checked, onChange }: { title: string; body: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 border-b border-line px-4 py-4 last:border-0">
      <span className="flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm text-muted">{body}</span>
      </span>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

export function PrivacySettingsPage() {
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [blocked, setBlocked] = useState<PublicUser[]>([]);
  useEffect(() => {
    void backend.getPrivacy().then(setPrivacy);
    void backend.listBlocked().then(setBlocked);
  }, []);

  async function update(patch: Partial<PrivacySettings>) {
    const prev = privacy;
    setPrivacy((p) => (p ? { ...p, ...patch } : p));
    try {
      setPrivacy(await backend.updatePrivacy(patch));
    } catch (e) {
      setPrivacy(prev);
      toast({ title: 'Couldn’t save', body: errMsg(e), tone: 'error' });
    }
  }

  if (!privacy) {
    return (
      <SettingsFrame title="Privacy">
        <div className="flex justify-center py-16 text-primary">
          <Spinner />
        </div>
      </SettingsFrame>
    );
  }

  return (
    <SettingsFrame title="Privacy">
      <p className="mb-4 rounded-2xl bg-primary-soft px-4 py-3 text-sm text-primary">
        <strong>Contacts</strong> are people you’ve already exchanged messages with.
      </p>
      <div className="mb-4 rounded-2xl border border-star/30 bg-star/10 px-4 py-3 text-sm text-ink">
        <p className="font-semibold">Safety and chat access</p>
        <p className="mt-1 text-muted">For safety, the FriendStar owner can review account chats. This access is read-only—messages cannot be changed or deleted—and each chat-list or message review is recorded in an audit log.</p>
      </div>
      <SectionLabel>Who can see my info</SectionLabel>
      <Card>
        <SettingBlock title="Last seen & online" body="If you hide it, you’ll still appear in chats, just without a status.">
          <Segmented label="Last seen & online" value={privacy.lastSeen} options={AUDIENCE} onChange={(v) => update({ lastSeen: v })} />
        </SettingBlock>
        <SettingBlock title="Profile photo" body="People who can’t see it will see your initials.">
          <Segmented label="Profile photo" value={privacy.profilePhoto} options={AUDIENCE} onChange={(v) => update({ profilePhoto: v })} />
        </SettingBlock>
      </Card>

      <SectionLabel>Messages</SectionLabel>
      <Card>
        <ToggleBlock
          title="Read receipts"
          body="Show others when you’ve read their messages. If off, you won’t see theirs either."
          checked={privacy.readReceipts}
          onChange={(v) => update({ readReceipts: v })}
        />
        <SettingBlock title="Who can message me" body="Contacts-only blocks new chats from people you haven’t talked to.">
          <Segmented
            label="Who can message me"
            value={privacy.whoCanMessage}
            options={[
              { value: 'everyone', label: 'Everyone' },
              { value: 'contacts', label: 'Contacts' },
            ]}
            onChange={(v) => update({ whoCanMessage: v })}
          />
        </SettingBlock>
        <ToggleBlock
          title="Find me in search"
          body="Let people who aren’t contacts find you by name or username."
          checked={privacy.discoverable}
          onChange={(v) => update({ discoverable: v })}
        />
      </Card>
      <div className="mt-3 flex items-center gap-4 px-1 text-xs text-muted">
        <span className="flex items-center gap-1"><StatusTicks status="sent" /> Sent</span>
        <span className="flex items-center gap-1"><StatusTicks status="delivered" /> Delivered</span>
        <span className="flex items-center gap-1"><StatusTicks status="read" /> Read</span>
      </div>

      <SectionLabel>Blocked people ({blocked.length})</SectionLabel>
      <Card>
        {blocked.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">You haven’t blocked anyone. You can block someone from their profile.</p>
        ) : (
          blocked.map((u) => (
            <div key={u.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
              <Avatar name={u.displayName} src={u.avatarUrl} size={40} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{u.displayName}</span>
                <span className="block truncate text-sm text-muted">@{u.username}</span>
              </span>
              <Button
                variant="secondary"
                className="h-9 px-3 text-sm"
                onClick={async () => {
                  await backend.unblock(u.id);
                  setBlocked((b) => b.filter((x) => x.id !== u.id));
                }}
              >
                Unblock
              </Button>
            </div>
          ))
        )}
      </Card>
    </SettingsFrame>
  );
}

/* ================= Offline reply ================= */
export function OfflineReplySettingsPage() {
  const [settings, setSettings] = useState<OfflineReplySettings | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void backend.getOfflineReplySettings().then((value) => {
      setSettings(value);
      setDraft(value.message);
    }).catch((e) => toast({ title: 'Couldn’t load offline reply', body: errMsg(e), tone: 'error' }));
  }, []);

  async function setEnabled(enabled: boolean) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, enabled });
    try {
      setSettings(await backend.updateOfflineReplySettings({ enabled }));
    } catch (e) {
      setSettings(previous);
      toast({ title: 'Couldn’t save setting', body: errMsg(e), tone: 'error' });
    }
  }

  async function saveMessage() {
    const message = draft.trim();
    if (!message) return;
    setSaving(true);
    try {
      const next = await backend.updateOfflineReplySettings({ message });
      setSettings(next);
      setDraft(next.message);
      toast({ title: 'Offline reply saved', tone: 'success' });
    } catch (e) {
      toast({ title: 'Couldn’t save message', body: errMsg(e), tone: 'error' });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <SettingsFrame title="Offline reply"><div className="flex justify-center py-16 text-primary"><Spinner /></div></SettingsFrame>;
  }

  return (
    <SettingsFrame title="Offline reply">
      <Card>
        <ToggleBlock
          title="Automatic reply"
          body="When you’re offline, send this once to each person per day in direct chats. Groups are excluded."
          checked={settings.enabled}
          onChange={(value) => void setEnabled(value)}
        />
      </Card>
      <SectionLabel>Your message</SectionLabel>
      <TextArea
        label="Away message"
        value={draft}
        maxLength={500}
        onChange={(e) => setDraft(e.target.value)}
        hint={`${draft.length}/500`}
      />
      <Button block className="mt-4" loading={saving} disabled={!draft.trim() || draft.trim() === settings.message} onClick={() => void saveMessage()}>
        Save message
      </Button>
      <p className="mt-4 rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">This is an automatic direct-message reply, not an AI response. You can turn it off at any time.</p>
    </SettingsFrame>
  );
}

/* ================= Appearance ================= */
export function AppearanceSettingsPage() {
  const { mode, setMode } = useTheme();
  return (
    <SettingsFrame title="Appearance">
      <SectionLabel>Theme</SectionLabel>
      <Segmented<ThemeMode>
        label="Theme"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'light', label: 'Light', icon: 'sun' },
          { value: 'dark', label: 'Dark', icon: 'moon' },
          { value: 'system', label: 'System', icon: 'monitor' },
        ]}
      />
      <SectionLabel>Preview</SectionLabel>
      <div className="chat-bg space-y-2 rounded-3xl border border-line p-4">
        <div className="flex">
          <span className="bubble-other max-w-[75%] rounded-3xl rounded-bl-lg border border-line/60 px-3.5 py-2 text-[15px]">Ready for the weekend? ✨</span>
        </div>
        <div className="flex justify-end">
          <span className="bubble-own inline-flex max-w-[75%] items-end gap-2 rounded-3xl rounded-br-lg px-3.5 py-2 text-[15px]">
            Always! See you at 7 <span className="inline-flex items-center gap-1 text-[11px] text-white/75">9:41 <StatusTicks status="read" /></span>
          </span>
        </div>
      </div>
    </SettingsFrame>
  );
}

/* ================= Notifications ================= */
export function NotificationSettingsPage() {
  const [prefs, setPrefs] = useState<NotifyPrefs>(getNotifyPrefs);
  const [permission, setPermission] = useState(notificationsSupported() ? Notification.permission : 'unsupported');
  const update = (p: Partial<NotifyPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    setNotifyPrefs(next);
  };

  return (
    <SettingsFrame title="Notifications">
      <Card>
        <ToggleBlock
          title="Device notifications"
          body={
            permission === 'unsupported'
              ? 'This browser doesn’t support notifications.'
              : permission === 'denied'
                ? 'Blocked in your browser settings. Allow notifications for this site to turn them on.'
                : 'Alert me when a message arrives while FriendStar is in the background.'
          }
          checked={prefs.desktop && permission === 'granted'}
          onChange={async (v) => {
            if (v) {
              const p = await requestDesktopPermission();
              setPermission(p);
              update({ desktop: p === 'granted' });
            } else update({ desktop: false });
          }}
        />
        <ToggleBlock title="Sound" body="Play a soft chime for new messages." checked={prefs.sound} onChange={(v) => update({ sound: v })} />
        <ToggleBlock title="Show previews" body="Include message text in alerts." checked={prefs.previews} onChange={(v) => update({ previews: v })} />
      </Card>
      <Button variant="secondary" block className="mt-4" icon="bell" onClick={() => {
        if (prefs.sound) playChime();
        toast({ title: 'This is a FriendStar alert', body: prefs.previews ? 'Messages will look like this.' : 'New message' });
      }}>
        Send a test alert
      </Button>
    </SettingsFrame>
  );
}
