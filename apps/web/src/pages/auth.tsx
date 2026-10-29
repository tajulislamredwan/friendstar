import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

/** Where to land after signing in (e.g. a shared /u/FS-XXXXXX profile link). */
function takeReturnPath() {
  const p = sessionStorage.getItem('fs_after_login');
  sessionStorage.removeItem('fs_after_login');
  return p && /^\/u\/[A-Za-z0-9-]{1,12}$/.test(p) ? p : '/';
}
import { ApiError, backend, isDemo } from '../api/index.ts';
import { passwordSchema } from '@friendstar/shared';
import { DownloadBanner } from '../components/DownloadBanner.tsx';
import { Button, Logo, TextField } from '../components/ui/index.tsx';
import { Icon } from '../components/ui/Icon.tsx';
import { useAuth } from '../store/index.ts';

function AuthFrame({ children, title, subtitle }: { children: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <DownloadBanner />
      <div className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          <Link to="/welcome" className="mb-8 flex justify-center">
            <Logo size={52} withWord />
          </Link>
          <h1 className="text-center text-2xl font-extrabold tracking-tight">{title}</h1>
          <p className="mt-1 text-center text-sm text-muted">{subtitle}</p>
          <div className="mt-7">{children}</div>
        </div>
      </div>
    </div>
  );
}

function DemoAccounts({ onPick }: { onPick: (username: string) => void }) {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-line p-3 text-sm">
      <p className="mb-2 font-semibold">Demo accounts — select an account to preview. In local server mode, enter the configured DEMO_PASSWORD.</p>
      <div className="flex flex-wrap gap-2">
        {['alice', 'bob', 'carol', 'dan'].map((u) => (
          <button key={u} type="button" onClick={() => onPick(u)} className="rounded-full bg-primary-soft px-3 py-1 font-semibold text-primary">
            {u}
          </button>
        ))}
      </div>
    </div>
  );
}

export function WelcomePage() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <DownloadBanner />
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-6 pb-8 pt-14">
        <Logo size={64} />
        <h1 className="mt-8 text-[34px] font-extrabold leading-[1.1] tracking-tight">
          Chat with the people who make you <span className="text-primary">shine</span>
          <span className="text-star">.</span>
        </h1>
        <p className="mt-4 text-[15px] text-muted">
          FriendStar is a calm, private messenger for friends and groups. Instant messages, photos, status updates and
          voice or video calls, with privacy controls you can actually understand.
        </p>
        <ul className="mt-8 space-y-3 text-[15px]">
          {[
            ['chat', 'Real-time chat with sent, delivered and read ticks'],
            ['users', 'Group chats, plus 24-hour status updates'],
            ['video', 'Voice and video calls, straight between devices'],
            ['shield', 'You choose who sees your last seen and photo'],
            ['moon', 'Easy on the eyes in light or dark mode'],
          ].map(([icon, text]) => (
            <li key={text} className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <Icon name={icon as 'chat'} size={18} />
              </span>
              {text}
            </li>
          ))}
        </ul>
        <div className="flex-1" />
        <div className="mt-10 space-y-3">
          <Link to="/register" className="block">
            <Button block>Create your account</Button>
          </Link>
          <Link to="/login" className="block">
            <Button block variant="secondary">
              I already have an account
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const [form, setForm] = useState({ login: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(form);
      navigate(takeReturnPath(), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Welcome back" subtitle="Sign in to continue to FriendStar">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField
          id="friendstar-login-username"
          name="username"
          label="Username or email"
          autoComplete="username"
          autoCapitalize="none"
          value={form.login}
          onChange={(e) => setForm((s) => ({ ...s, login: e.target.value }))}
          required
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={form.password}
          onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
          required
        />
        {!isDemo && <div className="-mt-2 text-right"><Link to="/forgot-password" className="text-sm font-semibold text-primary">Forgot password?</Link></div>}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" block loading={busy}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        New here?{' '}
        <Link to="/register" className="font-semibold text-primary">
          Create an account
        </Link>
      </p>
      {(isDemo || import.meta.env.DEV) && <DemoAccounts onPick={(u) => setForm((s) => ({ ...s, login: u, password: isDemo ? crypto.randomUUID() : s.password }))} />}
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await backend.requestPasswordReset(identifier);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Reset your password" subtitle="Ask the FriendStar owner to review a reset request">
      {isDemo ? (
        <p className="rounded-2xl bg-surface-2 p-4 text-sm text-muted">Password reset is not available in the browser-only demo.</p>
      ) : submitted ? (
        <div role="status" className="space-y-4">
          <p className="rounded-2xl bg-primary-soft p-4 text-sm text-primary">If those details match an account, a reset request is available for owner review. No email was sent.</p>
          <Link to="/login" className="block"><Button block variant="secondary">Back to sign in</Button></Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="text-sm text-muted">Enter your username or account email. For privacy, the confirmation is the same whether or not an account matches.</p>
          <TextField
            label="Username or email"
            autoComplete="username"
            autoCapitalize="none"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            maxLength={254}
          />
          {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" block loading={busy} disabled={!identifier.trim()}>Submit request</Button>
          <Link to="/login" className="block text-center text-sm font-semibold text-primary">Back to sign in</Link>
        </form>
      )}
    </AuthFrame>
  );
}

function takeResetTokenFromFragment(): string | null {
  const hash = window.location.hash;
  const token = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token');
  if (hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  return token;
}

export function PasswordResetPage() {
  const logout = useAuth((s) => s.logout);
  const fragmentConsumed = useRef(false);
  const [token, setToken] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (fragmentConsumed.current) return;
    fragmentConsumed.current = true;
    setToken(takeResetTokenFromFragment());
    setTokenReady(true);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) { setError('This reset link is missing, invalid or expired. Request a new one.'); return; }
    const checked = passwordSchema.safeParse(password);
    if (!checked.success) { setError(checked.error.issues[0]?.message ?? 'Choose a stronger password.'); return; }
    if (password !== confirmation) { setError('The passwords do not match.'); return; }
    setBusy(true);
    try {
      await backend.completePasswordReset(token, password);
      await logout();
      setToken(null);
      setPassword('');
      setConfirmation('');
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Choose a new password" subtitle="The link can be used once and expires after 15 minutes">
      {isDemo ? (
        <p className="rounded-2xl bg-surface-2 p-4 text-sm text-muted">Password reset is not available in the browser-only demo.</p>
      ) : success ? (
        <div role="status" className="space-y-4">
          <p className="rounded-2xl bg-primary-soft p-4 text-sm text-primary">Your password has been updated. Please sign in with the new password.</p>
          <Link to="/login" className="block"><Button block>Sign in</Button></Link>
        </div>
      ) : !tokenReady ? (
        <p role="status" className="text-center text-sm text-muted">Checking reset link…</p>
      ) : !token ? (
        <div className="space-y-4">
          <p role="alert" className="rounded-2xl bg-danger/10 p-4 text-sm text-danger">This reset link is missing, invalid or expired. Request a new one.</p>
          <Link to="/forgot-password" className="block"><Button block variant="secondary">Request a new reset</Button></Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters, with a letter and a number" required />
          <TextField label="Confirm new password" type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required />
          {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" block loading={busy} disabled={!password || !confirmation}>Update password</Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function RegisterPage() {
  const register = useAuth((s) => s.register);
  const navigate = useNavigate();
  const [form, setForm] = useState({ displayName: '', username: '', email: '', password: '' });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await register(form);
      navigate(takeReturnPath(), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setFields(err.fields ?? {});
        if (!err.fields) setError(err.message);
      } else setError('Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Create your account" subtitle="It takes less than a minute">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField label="Your name" autoComplete="name" value={form.displayName} onChange={set('displayName')} error={fields.displayName} maxLength={40} />
        <TextField
          id="friendstar-register-username"
          name="username"
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          value={form.username}
          onChange={set('username')}
          error={fields.username}
          hint="Friends find you by this. 3–20 letters, numbers or _"
        />
        <TextField id="friendstar-register-email" name="email" label="Email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={fields.email} />
        <TextField
          id="friendstar-register-password"
          name="new-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set('password')}
          error={fields.password}
          hint="At least 8 characters with a letter and a number"
        />
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" block loading={busy}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-primary">
          Sign in
        </Link>
      </p>
    </AuthFrame>
  );
}
