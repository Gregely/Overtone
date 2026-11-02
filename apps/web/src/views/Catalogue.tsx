import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { CatalogueArtistDto, CatalogueReleaseDto, CatalogueReleaseGroupDto } from '@overtone/shared';
import { useCatalogueArtist, useCatalogueRelease, useCatalogueSearch, usePlayCatalogue } from '../api/hooks';
import { Page } from '../layout/Page';
import { Icon } from '../ui/Icon';
import { formatTime } from '../ui/format';
import { EmptyState, QueryView, Spinner } from '../ui/states';
import { FindSourcesDialog } from './FindSources';

/** MusicBrainz catalogue results, rendered inside the main Search. */
export function CatalogueResults({ q }: { q: string }) {
  const search = useCatalogueSearch(q);
  if (search.isPending) return <Spinner label="Searching the catalogue" />;
  if (search.error) return null; // catalogue is optional; the library section still shows
  const data = search.data;
  if (!data || (data.artists.length + data.releases.length + data.recordings.length === 0)) {
    return <p className="small muted">No catalogue matches for “{q}”.</p>;
  }
  return (
    <>
      {data.artists.length > 0 && (
        <section aria-labelledby="c-artists" className="stack-sm">
          <h2 id="c-artists">Artists</h2>
          <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {data.artists.map((a) => (
              <li key={a.mbid}>
                <Link to={`/catalogue/artists/${a.mbid}`} className="row" style={{ gap: 8 }}>
                  <Icon name="user" size={18} /> {a.name}
                  {a.disambiguation && <span className="small muted">{a.disambiguation}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.releases.length > 0 && (
        <section aria-labelledby="c-albums" className="stack-sm">
          <h2 id="c-albums">Albums</h2>
          <CatalogueReleaseGroupList items={data.releases} />
        </section>
      )}
      {data.recordings.length > 0 && (
        <section aria-labelledby="c-recordings" className="stack-sm">
          <h2 id="c-recordings">Tracks</h2>
          <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {data.recordings.map((r) => (
              <li key={r.mbid} className="row wrap" style={{ gap: 8 }}>
                <span className="truncate" style={{ flex: 1 }}>
                  {r.title}
                  <span className="small muted"> · {r.artistCredit}</span>
                </span>
                {r.durationMs != null && <span className="small muted">{formatTime(r.durationMs / 1000)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function CatalogueReleaseGroupList({ items }: { items: CatalogueReleaseGroupDto[] }) {
  return (
    <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {items.map((r) => (
        <li key={r.mbid}>
          <Link to={`/catalogue/releases/${r.mbid}`} className="row" style={{ gap: 8 }}>
            <Icon name="album" size={18} />
            <span className="truncate" style={{ flex: 1 }}>
              {r.title}
              <span className="small muted"> · {r.artistCredit}</span>
              {r.year ? <span className="small muted"> · {r.year}</span> : null}
            </span>
            {r.primaryType && r.primaryType !== 'Album' && <span className="badge">{r.primaryType}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function CatalogueArtistView() {
  const mbid = useParams().mbid;
  const artist = useCatalogueArtist(mbid);
  return (
    <QueryView query={artist} label="Loading artist">
      {({ artist: a, releaseGroups }) => (
        <Page title={a.name}>
          {a.disambiguation && <p className="muted">{a.disambiguation}</p>}
          <section aria-labelledby="a-discography" className="stack-sm">
            <h2 id="a-discography">Discography</h2>
            {releaseGroups.length ? <CatalogueReleaseGroupList items={releaseGroups} /> : <p className="muted">No releases found.</p>}
          </section>
        </Page>
      )}
    </QueryView>
  );
}

export function CatalogueReleaseView() {
  const mbid = useParams().mbid;
  const release = useCatalogueRelease(mbid);
  const play = usePlayCatalogue();
  const [picking, setPicking] = useState(false);
  const [result, setResult] = useState<{ status: string; text: string } | null>(null);

  return (
    <QueryView query={release} label="Loading album">
      {(r) => {
        const playAction = () => {
          setResult(null);
          play.mutate(r.mbid, {
            onSuccess: (res) => {
              if (res.status === 'retrieving') setResult({ status: 'ok', text: 'Retrieving… watch Downloads for progress.' });
              else if (res.status === 'no_cached_source') setResult({ status: 'warn', text: 'No cached source found for this album. Pick a source to choose one manually.' });
              else setResult({ status: 'warn', text: 'No playable source found for this album.' });
            },
          });
        };
        return (
          <Page title={r.title}>
            <div className="stack" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
              <div className="row wrap" style={{ alignItems: 'flex-end', gap: 20 }}>
                <CatalogueCover release={r} />
                <div className="stack-sm" style={{ minWidth: 0, flex: '1 1 240px' }}>
                  <p>{r.artistCredit}</p>
                  <p className="small muted">{[r.year, r.date ? r.date.slice(0, 4) : null, `${r.trackCount} tracks`].filter(Boolean).join(' · ')}</p>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <button type="button" className="btn primary" onClick={playAction} disabled={play.isPending}>
                      <Icon name="play" size={18} /> {play.isPending ? 'Searching sources…' : 'Play'}
                    </button>
                    <button type="button" className="btn" onClick={() => setPicking(true)}>
                      <Icon name="search" size={18} /> Pick source
                    </button>
                  </div>
                  {result && (
                    <p className={`banner ${result.status === 'ok' ? 'ok' : result.status === 'warn' ? '' : 'error'}`} role="status">
                      {result.text}
                      {result.status === 'ok' && (
                        <>
                          {' '}
                          <Link to="/downloads">Open Downloads</Link>
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>
              <section aria-labelledby="c-tracklist" className="stack-sm">
                <h2 id="c-tracklist">Tracklist</h2>
                <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {r.tracks.map((t, i) => (
                    <li key={i} className="row" style={{ gap: 8 }}>
                      <span className="small muted" style={{ width: 28, flex: 'none', textAlign: 'right' }}>
                        {t.trackNo}
                      </span>
                      <span className="truncate" style={{ flex: 1 }}>
                        {t.title}
                        {t.artistCredit !== r.artistCredit && <span className="small muted"> · {t.artistCredit}</span>}
                      </span>
                      {t.durationMs != null && <span className="small muted">{formatTime(t.durationMs / 1000)}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
            {picking && (
              <FindSourcesDialog
                target={{
                  kind: 'catalogue',
                  title: r.title,
                  query: { title: r.title, artist: r.artistCredit, album: r.title, ...(r.year ? { year: r.year } : {}) },
                }}
                onClose={() => setPicking(false)}
              />
            )}
          </Page>
        );
      }}
    </QueryView>
  );
}

function CatalogueCover({ release }: { release: CatalogueReleaseDto }) {
  const [failed, setFailed] = useState(false);
  if (!release.coverUrl || failed) {
    return (
      <div className="cover" style={{ width: 180, height: 180 }}>
        <Icon name="album" size={36} />
      </div>
    );
  }
  return <img className="cover" style={{ width: 180, height: 180 }} src={release.coverUrl} alt={`Cover of ${release.title}`} loading="lazy" onError={() => setFailed(true)} />;
}
