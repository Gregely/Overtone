import { Link, useLocation } from 'react-router';
import { usePlayer, usePlayerState } from '../player/react';
import { Icon } from '../ui/Icon';
import { Cover } from '../ui/media';

export function PlayerBar() {
  const player = usePlayer();
  const current = usePlayerState((s) => s.current);
  const status = usePlayerState((s) => s.status);
  const progress = usePlayerState((s) => (s.duration > 0 ? Math.min(1, s.position / s.duration) : 0));
  const onNowPlaying = useLocation().pathname === '/now-playing';
  if (!current || onNowPlaying) return null;
  const t = current.track;
  const playing = status === 'playing' || status === 'loading';
  return (
    <section className="player-bar" aria-label="Player">
      <div className="progress" aria-hidden="true">
        <div style={{ width: `${progress * 100}%` }} />
      </div>
      <Link to="/now-playing" className="now">
        <Cover url={t.coverUrl} className="sm" />
        <span style={{ minWidth: 0, display: 'grid' }}>
          <span className="truncate" style={{ fontWeight: 600 }}>
            <span className="visually-hidden">Now playing: </span>
            {t.title}
            <span className="visually-hidden"> by </span>
          </span>
          <span className="small muted truncate">
            {status === 'error' ? "Couldn't play this track" : t.artistCredit}
            <span className="visually-hidden">. Open player.</span>
          </span>
        </span>
      </Link>
      <button type="button" className="icon-btn" onClick={() => player.togglePlay()} aria-label={playing ? 'Pause' : 'Play'}>
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <button type="button" className="icon-btn" onClick={() => player.next()} aria-label="Next track">
        <Icon name="next" />
      </button>
    </section>
  );
}
