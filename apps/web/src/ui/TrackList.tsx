import { useState } from 'react';
import { Link } from 'react-router';
import type { TrackDto } from '@overtone/shared';
import { useIsAdmin } from '../app/context';
import { usePlayer, usePlayerState } from '../player/react';
import { FindSourcesDialog } from '../views/FindSources';
import { FixMatchDialog } from '../views/FixMatch';
import { Dialog } from './Dialog';
import { formatMs } from './format';
import { Icon } from './Icon';
import { Cover, MatchBadge, SourceBadges } from './media';

export interface TrackListProps {
  tracks: TrackDto[];
  /** Play the list starting at index (default: replaces the queue with `tracks`). */
  onPlay?: (index: number) => void;
  /** Show track numbers instead of covers (album pages). */
  numbered?: boolean;
  showAlbum?: boolean;
  label: string;
}

export function TrackList({ tracks, onPlay, numbered = false, showAlbum = true, label }: TrackListProps) {
  const player = usePlayer();
  const currentId = usePlayerState((s) => s.current?.track.id ?? null);
  const playing = usePlayerState((s) => s.status === 'playing');
  const [menuFor, setMenuFor] = useState<TrackDto | null>(null);
  const [fixFor, setFixFor] = useState<TrackDto | null>(null);
  const [findFor, setFindFor] = useState<TrackDto | null>(null);
  const play = onPlay ?? ((i: number) => player.playTracks(tracks, i));

  return (
    <>
      <ul className="tracks" aria-label={label}>
        {tracks.map((t, i) => {
          const isCurrent = t.id === currentId;
          return (
            <li key={`${t.id}-${i}`} className={`track${isCurrent ? ' current' : ''}`}>
              <button type="button" className="track-main" onClick={() => play(i)}>
                {numbered ? (
                  <span className="track-no" aria-hidden="true">
                    {isCurrent && playing ? <Icon name="bars" size={16} /> : (t.trackNo ?? '·')}
                  </span>
                ) : (
                  <Cover url={t.coverUrl} className="sm" />
                )}
                <span className="track-text">
                  <span className="track-title truncate">
                    <span className="visually-hidden">Play </span>
                    {t.title}
                    <span className="visually-hidden"> by </span>
                  </span>
                  <span className="track-meta small muted">
                    <span className="truncate">
                      {t.artistCredit}
                      {showAlbum && t.album ? ` · ${t.album.title}` : ''}
                    </span>
                    <MatchBadge status={t.matchStatus} />
                    <SourceBadges sources={t.sources} />
                    {isCurrent && <span className="visually-hidden">{playing ? ', now playing' : ', current track'}</span>}
                  </span>
                </span>
                <span className="duration" aria-hidden="true">
                  {formatMs(t.durationMs)}
                </span>
              </button>
              <button type="button" className="icon-btn" aria-label={`More actions for ${t.title}`} onClick={() => setMenuFor(t)}>
                <Icon name="more" />
              </button>
            </li>
          );
        })}
      </ul>
      <TrackActions
        track={menuFor}
        onClose={() => setMenuFor(null)}
        onFixMatch={(t) => {
          setMenuFor(null);
          setFixFor(t);
        }}
        onFindSources={(t) => {
          setMenuFor(null);
          setFindFor(t);
        }}
      />
      {fixFor && <FixMatchDialog track={fixFor} onClose={() => setFixFor(null)} />}
      {findFor && <FindSourcesDialog target={{ kind: 'track', id: findFor.id, albumId: findFor.album?.id, title: findFor.title }} onClose={() => setFindFor(null)} />}
    </>
  );
}

function TrackActions({ track, onClose, onFixMatch, onFindSources }: { track: TrackDto | null; onClose: () => void; onFixMatch: (t: TrackDto) => void; onFindSources: (t: TrackDto) => void }) {
  const player = usePlayer();
  const admin = useIsAdmin();
  const t = track;
  return (
    <Dialog open={Boolean(t)} onClose={onClose} title={t?.title ?? ''}>
      {t && (
        <ul className="sheet-actions">
          <li>
            <button
              type="button"
              onClick={() => {
                player.playNext([t]);
                onClose();
              }}
            >
              <Icon name="next" /> Play next
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={() => {
                player.addToQueue([t]);
                onClose();
              }}
            >
              <Icon name="queue" /> Add to queue
            </button>
          </li>
          <li>
            <button type="button" onClick={() => onFindSources(t)}>
              <Icon name="search" /> Find sources
            </button>
          </li>
          {t.album && (
            <li>
              <Link to={`/albums/${t.album.id}`} onClick={onClose}>
                <Icon name="album" /> Go to album
              </Link>
            </li>
          )}
          {t.artist && (
            <li>
              <Link to={`/artists/${t.artist.id}`} onClick={onClose}>
                <Icon name="user" /> Go to artist
              </Link>
            </li>
          )}
          {admin && (
            <li>
              <button type="button" onClick={() => onFixMatch(t)}>
                <Icon name="wand" /> Fix match
                {t.matchStatus === 'needs_review' || t.matchStatus === 'unmatched' ? <MatchBadge status={t.matchStatus} /> : null}
              </button>
            </li>
          )}
        </ul>
      )}
    </Dialog>
  );
}
