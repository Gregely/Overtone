import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client';
import { useApi, useApiState, useIsAdmin } from '../app/context';
import { Page } from '../layout/Page';
import { useSession } from '../session/session';
import { getTheme, setTheme, type ThemePref } from '../theme';
import { Icon } from '../ui/Icon';
import { errorMessage } from '../ui/states';
import { ServerField } from './Auth';

export function SettingsView() {
  const session = useSession();
  const user = useApiState((c) => c.user);
  const serverUrl = useApiState((c) => c.serverUrl);
  const admin = useIsAdmin();
  const version = session.state.phase === 'ready' ? session.state.version : '';
  const [theme, setThemeState] = useState<ThemePref>(getTheme());

  return (
    <Page title="Settings">
      {admin && (
        <section className="card stack-sm" aria-labelledby="set-sources">
          <h2 id="set-sources">Sources</h2>
          <p className="muted small">Folders, servers and accounts Overtone plays music from.</p>
          <div>
            <Link to="/settings/sources" className="btn">
              <Icon name="library" size={18} /> Manage sources
            </Link>{' '}
            <Link to="/review" className="btn ghost">
              <Icon name="wand" size={18} /> Review matches
            </Link>
          </div>
        </section>
      )}

      <section className="card stack-sm" aria-labelledby="set-server">
        <h2 id="set-server">Server</h2>
        <ServerField serverUrl={serverUrl} />
        <p className="small muted">Overtone server {version}</p>
      </section>

      <section className="card stack-sm" aria-labelledby="set-account">
        <h2 id="set-account">Account</h2>
        <p>
          Signed in as <strong>{user?.username}</strong>
          {user?.isAdmin ? ' (admin)' : ''}
        </p>
        <ChangePassword />
        <div>
          <button type="button" className="btn" onClick={() => void session.logout()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="card stack-sm" aria-labelledby="set-look">
        <h2 id="set-look">Appearance</h2>
        <fieldset className="field">
          <legend>Theme</legend>
          {(['system', 'light', 'dark'] as const).map((t) => (
            <label key={t} className="checkbox">
              <input
                type="radio"
                name="theme"
                value={t}
                checked={theme === t}
                onChange={() => {
                  setTheme(t);
                  setThemeState(t);
                }}
              />
              {t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark'}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card stack-sm" aria-labelledby="set-keys">
        <h2 id="set-keys">Keyboard shortcuts</h2>
        <dl className="meta">
          <dt>
            <span className="kbd">Space</span> / <span className="kbd">K</span>
          </dt>
          <dd>Play / pause</dd>
          <dt>
            <span className="kbd">J</span> / <span className="kbd">L</span>
          </dt>
          <dd>Back / forward 10 seconds</dd>
          <dt>
            <span className="kbd">Shift</span>+<span className="kbd">N</span> / <span className="kbd">P</span>
          </dt>
          <dd>Next / previous track</dd>
          <dt>
            <span className="kbd">/</span>
          </dt>
          <dd>Search</dd>
        </dl>
      </section>
    </Page>
  );
}

function ChangePassword() {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <div>
        <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
          Change password
        </button>
      </div>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/api/me/password', { currentPassword: current, newPassword: next });
      setMsg({ ok: true, text: 'Password changed. Other devices have been signed out.' });
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError && err.fields ? Object.values(err.fields).join(' ') : errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack-sm" onSubmit={submit} aria-label="Change password">
      <div className="field">
        <label htmlFor="pw-current">Current password</label>
        <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="pw-new">New password</label>
        <input id="pw-new" className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
      </div>
      {msg && (
        <p className={`banner ${msg.ok ? 'ok' : 'error'}`} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy}>
          Save password
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
