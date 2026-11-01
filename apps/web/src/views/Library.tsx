import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useParams, useSearchParams } from 'react-router';
import type { ArtistDto } from '@overtone/shared';
import { useAlbums, useArtists, useTracks } from '../api/hooks';
import { Page } from '../layout/Page';
import { plural } from '../ui/format';
import { Icon } from '../ui/Icon';
import { AlbumGrid } from '../ui/media';
import { EmptyState, ErrorState, Spinner } from '../ui/states';
import { TrackList } from '../ui/TrackList';

type Tab = 'artists' | 'albums' | 'tracks';
const SORTS: Record<Tab, Array<[string, string]>> = {
  artists: [],
  albums: [
    ['name', 'Title'],
    ['artist', 'Artist'],
    ['recent', 'Recently added'],
    ['year', 'Year'],
  ],
  tracks: [
    ['name', 'Title'],
    ['artist', 'Artist'],
    ['recent', 'Recently added'],
  ],
};

/** Debounced filter text kept in the URL (?q=), so back/forward and reload keep it. */
function useFilter(): [string, string, (v: string) => void, string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'name';
  const [text, setText] = useState(urlQ);
  useEffect(() => setText(urlQ), [urlQ]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (text !== urlQ) {
        const next = new URLSearchParams(params);
        if (text) next.set('q', text);
        else next.delete('q');
        setParams(next, { replace: true });
      }
    }, 250);
    return () => clearTimeout(id);
  }, [text, urlQ, params, setParams]);
  const setSort = (s: string) => {
    const next = new URLSearchParams(params);
    next.set('sort', s);
    setParams(next, { replace: true });
  };
  return [text, urlQ, setText, sort, setSort];
}

export function LibraryView() {
  const { tab = 'albums' } = useParams<{ tab: Tab }>();
  const current: Tab = tab === 'artists' || tab === 'tracks' ? tab : 'albums';
  const [text, q, setText, sort, setSort] = useFilter();
  const label = { artists: 'Artists', albums: 'Albums', tracks: 'Tracks' }[current];
  return (
    <Page title={label} heading="Library">
      <nav className="tabs" aria-label="Library sections">
        <NavLink to="/library/albums">Albums</NavLink>
        <NavLink to="/library/artists">Artists</NavLink>
        <NavLink to="/library/tracks">Tracks</NavLink>
      </nav>
      <div className="toolbar" role="search">
        <label htmlFor="lib-filter" className="visually-hidden">
          Filter {label.toLowerCase()}
        </label>
        <input
          id="lib-filter"
          className="input"
          type="search"
          placeholder={`Filter ${label.toLowerCase()}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {SORTS[current].length > 0 && (
          <>
            <label htmlFor="lib-sort" className="visually-hidden">
              Sort by
            </label>
            <select id="lib-sort" className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS[current].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {current === 'albums' && <AlbumsTab q={q} sort={sort} />}
      {current === 'artists' && <ArtistsTab q={q} />}
      {current === 'tracks' && <TracksTab q={q} sort={sort} />}
    </Page>
  );
}

function Paged({
  query,
  empty,
  children,
}: {
  query: ReturnType<typeof useAlbums> | ReturnType<typeof useArtists> | ReturnType<typeof useTracks>;
  empty: string;
  children: ReactNode;
}) {
  if (query.isPending) return <Spinner />;
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const total = query.data?.pages[0]?.total ?? 0;
  if (total === 0) return <EmptyState title={empty} icon="search" />;
  return (
    <div className="stack">
      <p className="small muted" aria-live="polite">
        {plural(total, 'result')}
      </p>
      {children}
      {query.hasNextPage && (
        <div>
          <button type="button" className="btn" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

function AlbumsTab({ q, sort }: { q: string; sort: string }) {
  const query = useAlbums(q, sort);
  return (
    <Paged query={query} empty="No albums">
      <AlbumGrid albums={query.data?.pages.flatMap((p) => p.items) ?? []} label="Albums" />
    </Paged>
  );
}

function ArtistsTab({ q }: { q: string }) {
  const query = useArtists(q);
  return (
    <Paged query={query} empty="No artists">
      <ArtistList artists={query.data?.pages.flatMap((p) => p.items) ?? []} />
    </Paged>
  );
}

export function ArtistList({ artists }: { artists: ArtistDto[] }) {
  return (
    <ul className="tracks" aria-label="Artists">
      {artists.map((a) => (
        <li key={a.id} className="track">
          <Link to={`/artists/${a.id}`} className="track-main" style={{ textDecoration: 'none' }}>
            <span className="cover sm" aria-hidden="true">
              <Icon name="user" size={18} />
            </span>
            <span className="track-text">
              <span className="track-title truncate">{a.name}</span>
              <span className="small muted">
                {a.albumCount ? plural(a.albumCount, 'album') : plural(a.trackCount, 'track')}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TracksTab({ q, sort }: { q: string; sort: string }) {
  const query = useTracks(q, sort);
  const tracks = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Paged query={query} empty="No tracks">
      <TrackList tracks={tracks} label="Tracks" />
    </Paged>
  );
}
