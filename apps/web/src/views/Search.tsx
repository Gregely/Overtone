import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useSearch } from '../api/hooks';
import { Page } from '../layout/Page';
import { AlbumGrid } from '../ui/media';
import { EmptyState, ErrorState, Spinner } from '../ui/states';
import { TrackList } from '../ui/TrackList';
import { ArtistList } from './Library';
import { CatalogueResults } from './Catalogue';

export function SearchView() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const [text, setText] = useState(urlQ);
  const input = useRef<HTMLInputElement>(null);
  const results = useSearch(urlQ);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const id = setTimeout(() => {
      if (text.trim() !== urlQ) setParams(text.trim() ? { q: text.trim() } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(id);
  }, [text, urlQ, setParams]);

  const data = results.data;
  const count = data ? data.artists.length + data.albums.length + data.tracks.length : 0;

  return (
    <Page title={urlQ ? `Search: ${urlQ}` : 'Search'} heading="Search">
      <form role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="search-q" className="visually-hidden">
          Search artists, albums and tracks
        </label>
        <input
          ref={input}
          id="search-q"
          className="input"
          type="search"
          placeholder="Artists, albums, tracks"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
        />
      </form>
      <div aria-live="polite" className="visually-hidden">
        {urlQ && data ? `${count} results` : ''}
      </div>
      {!urlQ ? (
        <EmptyState title="Find something to play" icon="search" />
      ) : results.isPending ? (
        <Spinner label="Searching" />
      ) : results.error && !data ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : count === 0 && !results.isPending ? (
        <EmptyState title={`Nothing found for “${urlQ}”`} icon="search">
          <p>Try the catalogue search below for artists and albums not in your library.</p>
        </EmptyState>
      ) : (
        <>
          <section aria-labelledby="s-catalogue" className="stack-sm">
            <h2 id="s-catalogue">Catalogue</h2>
            <CatalogueResults q={urlQ} />
          </section>
          {data!.tracks.length > 0 && (
            <section aria-labelledby="s-tracks" className="stack-sm">
              <h2 id="s-tracks">In your library</h2>
              <TrackList tracks={data!.tracks} label="Matching tracks" />
            </section>
          )}
          {data!.albums.length > 0 && (
            <section aria-labelledby="s-albums" className="stack-sm">
              <h2 id="s-albums">Albums in your library</h2>
              <AlbumGrid albums={data!.albums} label="Matching albums" />
            </section>
          )}
          {data!.artists.length > 0 && (
            <section aria-labelledby="s-artists" className="stack-sm">
              <h2 id="s-artists">Artists in your library</h2>
              <ArtistList artists={data!.artists} />
            </section>
          )}
        </>
      )}
    </Page>
  );
}
