import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { busy, useScanStatus } from '../api/hooks';
import { useApiState } from '../app/context';
import { usePlayer, usePlayerState } from '../player/react';
import { Icon } from '../ui/Icon';
import { PlayerBar } from './PlayerBar';

function NavLinks() {
  return (
    <div className="nav">
      <NavLink to="/" end>
        <Icon name="home" /> <span>Home</span>
      </NavLink>
      <NavLink to="/library">
        <Icon name="library" /> <span>Library</span>
      </NavLink>
      <NavLink to="/search">
        <Icon name="search" /> <span>Search</span>
      </NavLink>
      <NavLink to="/settings">
        <Icon name="settings" /> <span>Settings</span>
      </NavLink>
    </div>
  );
}

export function AppShell() {
  useShortcuts();
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Overtone home">
          <Icon name="bars" /> Overtone
        </Link>
        <span className="spacer" />
        <MatchIndicator />
      </header>
      <nav className="sidebar-nav" aria-label="Main">
        <NavLinks />
      </nav>
      <main id="main" className="main" tabIndex={-1}>
        <ConnectionBanner />
        <Outlet />
      </main>
      <div className="bottom">
        <PlayerBar />
        <nav aria-label="Main">
          <NavLinks />
        </nav>
      </div>
      <Announcer />
    </div>
  );
}

/** Scan/match progress and "N to review" for admins. */
function MatchIndicator() {
  const { data } = useScanStatus();
  if (!data) return null;
  const review = data.matching.needsReview + data.matching.unmatched;
  if (data.running || data.queued.length) {
    return (
      <span className="status-pill" role="status">
        <span className="spinner" aria-hidden="true" /> Scanning{data.running ? ` · ${data.running.filesSeen.toLocaleString()} files` : '…'}
      </span>
    );
  }
  if (busy(data)) {
    return (
      <Link to="/review" className="status-pill">
        <span className="spinner" aria-hidden="true" />
        {/* The live region goes inside: role="status" on the <a> itself would hide that it's a link. */}
        <span role="status">Matching · {data.matching.pending.toLocaleString()} left</span>
      </Link>
    );
  }
  if (review > 0) {
    return (
      <Link to="/review" className="status-pill warn">
        <Icon name="wand" size={16} /> {review} to review
        <span className="visually-hidden"> (files needing a match check)</span>
      </Link>
    );
  }
  return null;
}

function ConnectionBanner() {
  const reachability = useApiState((c) => c.reachability);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => {
      removeEventListener('online', on);
      removeEventListener('offline', off);
    };
  }, []);
  if (online && reachability === 'ok') return null;
  return (
    <div className="banner" role="status">
      <Icon name="wifiOff" size={18} />
      {online ? "Can't reach the server right now. Retrying when you try again." : "You're offline."}
      <button type="button" className="btn small" onClick={() => location.reload()}>
        Retry
      </button>
    </div>
  );
}

/** Polite live region: now playing changes and player notices. */
function Announcer() {
  const title = usePlayerState((s) => (s.current ? `Now playing: ${s.current.track.title} by ${s.current.track.artistCredit}` : ''));
  const notice = usePlayerState((s) => s.notice);
  const [text, setText] = useState('');
  const lastTitle = useRef('');
  useEffect(() => {
    if (title && title !== lastTitle.current) setText(title);
    lastTitle.current = title;
  }, [title]);
  useEffect(() => {
    if (notice) setText(notice.text);
  }, [notice]);
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}

const INTERACTIVE = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A']);

/**
 * Space/K play-pause, J/L ±10 s, Shift+N / Shift+P next/previous, "/" search.
 * Ignored while typing or when the focused control handles the key itself.
 */
function useShortcuts() {
  const player = usePlayer();
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      const typing = el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
      if (typing || el.closest('dialog')) return;
      const s = player.getSnapshot();
      switch (e.key) {
        case ' ':
          if (INTERACTIVE.has(el.tagName)) return; // let the button/link handle Space
          if (!s.current) return;
          e.preventDefault();
          player.togglePlay();
          return;
        case 'k':
          if (!s.current) return;
          player.togglePlay();
          return;
        case 'j':
          player.seek(s.position - 10);
          return;
        case 'l':
          player.seek(s.position + 10);
          return;
        case 'N':
          player.next();
          return;
        case 'P':
          player.prev();
          return;
        case '/':
          e.preventDefault();
          navigate('/search');
          return;
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [player, navigate]);
}
