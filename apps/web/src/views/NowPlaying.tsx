import { Link } from 'react-router';
import { hasNext, hasPrev } from '../player/queue';
import { usePlayer, usePlayerState } from '../player/react';
import { Page } from '../layout/Page';
import { formatMs, formatTime, spokenTime } from '../ui/format';
import { Icon } from '../ui/Icon';
import { Cover, MatchBadge, SourceBadges } from '../ui/media';
import { EmptyState } from '../ui/states';

export function NowPlayingView() {
  const player = usePlayer();
  const current = usePlayerState((s) => s.current);
  const status = usePlayerState((s) => s.status);
  const buffering = usePlayerState((s) => s.buffering);
  const error = usePlayerState((s) => s.error);
  const position = usePlayerState((s) => s.position);
  const duration = usePlayerState((s) => s.duration);
  const volume = usePlayerState((s) => s.volume);
  const source = usePlayerState((s) => s.source);
  const queue = usePlayerState((s) => s.queue);

  if (!current) {
    return (
      <Page title="Now playing">
        <EmptyState title="Nothing playing">
          <Link to="/library" className="btn">
            Browse your library
          </Link>
        </EmptyState>
      </Page>
    );
  }
  const t = current.track;
  const playing = status === 'playing' || status === 'loading';
  const repeatLabel = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one track' }[queue.repeat];
  const upNext = queue.order.slice(queue.cursor + 1).map((i, k) => ({ item: queue.items[i]!, position: queue.cursor + 1 + k }));

  return (
    <Page title={`${t.title} · ${t.artistCredit}`} heading="Now playing">
      <div className="now-playing">
        <div className="art">
          <Cover url={t.coverUrl} size={500} alt={t.album ? `Cover of ${t.album.title}` : ''} />
        </div>
        <div className="stack-sm" style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: '1.35rem' }}>{t.title}</h2>
          <p>
            {t.artist ? <Link to={`/artists/${t.artist.id}`}>{t.artistCredit}</Link> : t.artistCredit}
            {t.album && (
              <>
                {' · '}
                <Link to={`/albums/${t.album.id}`}>{t.album.title}</Link>
              </>
            )}
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <MatchBadge status={t.matchStatus} />
            {source ? <SourceBadges sources={[source]} /> : <SourceBadges sources={t.sources} />}
          </div>
        </div>

        {error && (
          <div className="banner error" role="alert">
            <Icon name="alert" size={18} /> {error}
            <button type="button" className="btn small" onClick={() => player.play()}>
              Try again
            </button>
          </div>
        )}

        <div className="seek">
          <label htmlFor="seek" className="visually-hidden">
            Seek
          </label>
          <input
            id="seek"
            type="range"
            min={0}
            max={Math.max(1, Math.round(duration))}
            step={1}
            value={Math.round(position)}
            onChange={(e) => player.seek(Number(e.target.value))}
            aria-valuetext={`${spokenTime(position)} of ${spokenTime(duration)}`}
          />
          <div className="times small muted" aria-hidden="true">
            <span>{formatTime(position)}</span>
            <span>{buffering || status === 'loading' ? 'Loading…' : formatTime(duration)}</span>
          </div>
        </div>

        <div className="controls">
          <button type="button" className="icon-btn" aria-pressed={queue.shuffle} aria-label="Shuffle" onClick={() => player.toggleShuffle()}>
            <Icon name="shuffle" />
          </button>
          <button type="button" className="icon-btn" aria-label="Previous track" onClick={() => player.prev()} disabled={!hasPrev(queue) && position < 1}>
            <Icon name="prev" size={28} />
          </button>
          <button type="button" className="icon-btn big" aria-label={playing ? 'Pause' : 'Play'} onClick={() => player.togglePlay()}>
            <Icon name={playing ? 'pause' : 'play'} size={30} />
          </button>
          <button type="button" className="icon-btn" aria-label="Next track" onClick={() => player.next()} disabled={!hasNext(queue)}>
            <Icon name="next" size={28} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-pressed={queue.repeat !== 'off'}
            aria-label={repeatLabel}
            title={repeatLabel}
            onClick={() => player.cycleRepeat()}
            style={{ position: 'relative' }}
          >
            <Icon name="repeat" />
            {queue.repeat === 'one' && (
              <span aria-hidden="true" style={{ position: 'absolute', fontSize: 10, fontWeight: 800, bottom: 6, right: 8 }}>
                1
              </span>
            )}
          </button>
        </div>

        <div className="row">
          <label htmlFor="volume" className="row muted">
            <Icon name="volume" size={18} />
            <span className="visually-hidden">Volume</span>
          </label>
          <input id="volume" type="range" min={0} max={100} value={Math.round(volume * 100)} onChange={(e) => player.setVolume(Number(e.target.value) / 100)} aria-valuetext={`${Math.round(volume * 100)} percent`} />
        </div>

        <section aria-labelledby="up-next" className="stack-sm">
          <div className="section-head">
            <h2 id="up-next">Up next</h2>
            {upNext.length > 0 && (
              <button type="button" className="btn small ghost" onClick={() => upNext.slice().reverse().forEach((u) => player.remove(u.position))}>
                Clear
              </button>
            )}
          </div>
          {upNext.length === 0 ? (
            <p className="muted small">{queue.repeat === 'all' ? 'The queue will start over.' : 'Nothing queued after this track.'}</p>
          ) : (
            <ol className="tracks">
              {upNext.map(({ item, position: pos }) => (
                <li key={item.uid} className="track">
                  <button type="button" className="track-main" onClick={() => player.jump(pos)}>
                    <Cover url={item.track.coverUrl} className="sm" />
                    <span className="track-text">
                      <span className="track-title truncate">
                        <span className="visually-hidden">Play </span>
                        {item.track.title}
                        <span className="visually-hidden"> by </span>
                      </span>
                      <span className="small muted truncate">{item.track.artistCredit}</span>
                    </span>
                    <span className="spacer" />
                    <span className="duration" aria-hidden="true">
                      {formatMs(item.track.durationMs)}
                    </span>
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Remove ${item.track.title} from the queue`} onClick={() => player.remove(pos)}>
                    <Icon name="close" size={18} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Page>
  );
}
