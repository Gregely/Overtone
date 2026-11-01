import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { TrackDto } from '@overtone/shared';
import { useAlbum, useArtist } from '../api/hooks';
import { useIsAdmin } from '../app/context';
import { Page } from '../layout/Page';
import { usePlayer } from '../player/react';
import { formatTime, plural } from '../ui/format';
import { Icon } from '../ui/Icon';
import { AlbumGrid, Cover } from '../ui/media';
import { QueryView } from '../ui/states';
import { TrackList } from '../ui/TrackList';
import { AlbumMatchDialog } from './FixMatch';

export function AlbumView() {
  const id = Number(useParams().id);
  const album = useAlbum(id);
  const player = usePlayer();
  const admin = useIsAdmin();
  const [fixing, setFixing] = useState(false);

  return (
    <QueryView query={album} label="Loading album">
      {({ album: a, tracks }) => {
        const total = tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0) / 1000;
        const discs = new Set(tracks.map((t) => t.discNo ?? 1));
        return (
          <Page title={a.title}>
            <div className="stack" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
              <div className="row wrap" style={{ alignItems: 'flex-end', gap: 20 }}>
                <div style={{ width: 'min(240px, 60vw)' }}>
                  <Cover url={a.coverUrl} size={500} alt={`Cover of ${a.title}`} />
                </div>
                <div className="stack-sm" style={{ minWidth: 0, flex: '1 1 240px' }}>
                  <p>
                    {a.artist ? <Link to={`/artists/${a.artist.id}`}>{a.artistCredit}</Link> : a.artistCredit}
                  </p>
                  <p className="small muted">
                    {[a.year, plural(tracks.length, 'track'), formatTime(total)].filter(Boolean).join(' · ')}
                  </p>
                  {(a.attention > 0 || !a.mbid) && (
                    <p className="small badge warn" style={{ justifySelf: 'start' }}>
                      {a.mbid ? `${plural(a.attention, 'track')} need a match check` : 'Not matched to MusicBrainz; shown from tags'}
                    </p>
                  )}
                  <div className="row wrap">
                    <button type="button" className="btn primary" onClick={() => player.playTracks(tracks, 0, { shuffle: false })}>
                      <Icon name="play" size={18} /> Play
                    </button>
                    <button type="button" className="btn" onClick={() => player.playTracks(tracks, Math.floor(Math.random() * tracks.length), { shuffle: true })}>
                      <Icon name="shuffle" size={18} /> Shuffle
                    </button>
                    {admin && (
                      <button type="button" className="btn ghost" onClick={() => setFixing(true)}>
                        <Icon name="wand" size={18} /> Fix album match
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {discs.size > 1 ? (
                [...discs].sort().map((d) => (
                  <section key={d} aria-labelledby={`disc-${d}`} className="stack-sm">
                    <h2 id={`disc-${d}`}>Disc {d}</h2>
                    <DiscTracks all={tracks} disc={d} />
                  </section>
                ))
              ) : (
                <TrackList tracks={tracks} numbered showAlbum={false} label={`Tracks on ${a.title}`} onPlay={(i) => player.playTracks(tracks, i, { shuffle: false })} />
              )}
            </div>
            {fixing && <AlbumMatchDialog album={a} onClose={() => setFixing(false)} />}
          </Page>
        );
      }}
    </QueryView>
  );
}

function DiscTracks({ all, disc }: { all: TrackDto[]; disc: number }) {
  const player = usePlayer();
  const tracks = all.filter((t) => (t.discNo ?? 1) === disc);
  return (
    <TrackList
      tracks={tracks}
      numbered
      showAlbum={false}
      label={`Disc ${disc}`}
      onPlay={(i) => player.playTracks(all, all.indexOf(tracks[i]!), { shuffle: false })}
    />
  );
}

export function ArtistView() {
  const id = Number(useParams().id);
  const artist = useArtist(id);
  return (
    <QueryView query={artist} label="Loading artist">
      {({ artist: a, albums }) => (
        <Page title={a.name}>
          <p className="small muted">
            {plural(a.albumCount, 'album')} · {plural(a.trackCount, 'track')}
          </p>
          {albums.length ? <AlbumGrid albums={albums} label={`Albums by ${a.name}`} /> : <p className="muted">No albums; this artist appears on other releases.</p>}
        </Page>
      )}
    </QueryView>
  );
}
