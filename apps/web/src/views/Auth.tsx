import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { isNativeApp } from '../platform/server-url';
import { useMode } from '../app/mode';
import { useSession } from '../session/session';
import { Icon } from '../ui/Icon';
import { errorMessage } from '../ui/states';

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Overtone`;
  }, [title]);
  return (
    <main className="auth" id="main">
      <div className="card">
        <div className="brand">
          <Icon name="bars" /> Overtone
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/**
 * Shows which server we're talking to, with an inline editor. The URL is
 * persisted, so the Android build (not served from the server) remembers it.
 */
export function ServerField({ serverUrl, startEditing = false }: { serverUrl: string | null; startEditing?: boolean }) {
  const session = useSession();
  const [editing, setEditing] = useState(startEditing || !serverUrl);
  const [value, setValue] = useState(serverUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && serverUrl) input.current?.focus();
  }, [editing, serverUrl]);

  if (!editing && serverUrl) {
    return (
      <div className="server-line">
        <Icon name="bars" size={16} />
        <span className="truncate" style={{ flex: 1 }}>
          <span className="visually-hidden">Server: </span>
          {serverUrl}
        </span>
        <button type="button" className="btn small ghost" onClick={() => setEditing(true)} aria-label={`Change server (currently ${serverUrl})`}>
          Change
        </button>
      </div>
    );
  }

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.changeServer(value);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="field" onSubmit={connect} aria-label="Server">
      <label htmlFor={id}>Server address</label>
      <div className="row">
        <input
          ref={input}
          id={id}
          className="input"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={isNativeApp() ? 'https://music.example.com' : 'http://192.168.1.10:4800'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : `${id}-help`}
          required
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {error ? (
        <p id={`${id}-err`} className="error-text" role="alert">
          {error}
        </p>
      ) : (
        <p id={`${id}-help`} className="help">
          The address of your Overtone server, e.g. its LAN IP and port or your HTTPS domain.
        </p>
      )}
      {serverUrl && (
        <div>
          <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}

/** Android: a way back to standalone mode from the server screens. */
function UseOnDeviceLink() {
  const mode = useMode();
  if (!mode.canSwitch) return null;
  return (
    <p className="small muted">
      No server?{' '}
      <button type="button" className="btn small ghost" onClick={() => void mode.switchMode('standalone')}>
        Use Overtone on this device instead
      </button>
    </p>
  );
}

function CredentialsForm({
  submitLabel,
  onSubmit,
  newPassword = false,
  disabled = false,
}: {
  submitLabel: string;
  onSubmit: (u: string, p: string) => Promise<void>;
  newPassword?: boolean;
  disabled?: boolean;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFields({});
    if (newPassword && password !== confirm) {
      setFields({ confirm: "Passwords don't match" });
      return;
    }
    setBusy(true);
    try {
      await onSubmit(username.trim(), password);
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (k: string) =>
    fields[k] ? (
      <p id={`err-${k}`} className="error-text">
        {fields[k]}
      </p>
    ) : null;

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      <div className="field">
        <label htmlFor="username">Username</label>
        <input
          id="username"
          className="input"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-invalid={fields.username ? true : undefined}
          aria-describedby={fields.username ? 'err-username' : undefined}
          required
        />
        {fieldError('username')}
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete={newPassword ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={fields.password ? true : undefined}
          aria-describedby={fields.password ? 'err-password' : newPassword ? 'pw-help' : undefined}
          required
          minLength={newPassword ? 8 : undefined}
        />
        {newPassword && !fields.password && (
          <p id="pw-help" className="help">
            At least 8 characters.
          </p>
        )}
        {fieldError('password')}
      </div>
      {newPassword && (
        <div className="field">
          <label htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={fields.confirm ? true : undefined}
            aria-describedby={fields.confirm ? 'err-confirm' : undefined}
            required
          />
          {fieldError('confirm')}
        </div>
      )}
      <button type="submit" className="btn primary" disabled={busy || disabled || !username || !password}>
        {busy ? 'Please wait…' : submitLabel}
      </button>
    </form>
  );
}

export function SetupScreen({ serverUrl }: { serverUrl: string }) {
  const session = useSession();
  return (
    <AuthCard title="Welcome">
      <p className="muted">This server is new. Create the admin account to get started.</p>
      <ServerField serverUrl={serverUrl} />
      <CredentialsForm newPassword submitLabel="Create account" onSubmit={(username, password) => session.setup({ username, password, deviceName: deviceName() })} />
    </AuthCard>
  );
}

export function LoginScreen({ serverUrl, notice }: { serverUrl: string | null; notice?: string | undefined }) {
  const session = useSession();
  return (
    <AuthCard title="Sign in">
      {notice && (
        <p className="banner" role="status">
          {notice}
        </p>
      )}
      <ServerField serverUrl={serverUrl} />
      <CredentialsForm
        submitLabel="Sign in"
        disabled={!serverUrl}
        onSubmit={(username, password) => session.login({ username, password, deviceName: deviceName() })}
      />
      <UseOnDeviceLink />
    </AuthCard>
  );
}

export function UnreachableScreen({ serverUrl }: { serverUrl: string }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard title="Can't reach the server">
      <div className="banner" role="alert">
        <Icon name="wifiOff" size={18} />
        <span>
          Overtone couldn't connect to <strong style={{ overflowWrap: 'anywhere' }}>{serverUrl}</strong>.
        </span>
      </div>
      <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
        <li>Check that you're online, or on the same network as the server.</li>
        <li>Make sure the Overtone server is running.</li>
        <li>Outside your home network, use your Tailscale or HTTPS address.</li>
      </ul>
      <button
        type="button"
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await session.retry();
          setBusy(false);
        }}
      >
        <Icon name="refresh" size={18} /> {busy ? 'Trying…' : 'Try again'}
      </button>
      <ServerField serverUrl={serverUrl} />
    </AuthCard>
  );
}

export function BootScreen({ label = 'Connecting…' }: { label?: string }) {
  return (
    <main className="auth" id="main">
      <div className="state" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </main>
  );
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
}
