import { Link } from 'react-router';
import { busy, useHome, useScanStatus } from '../api/hooks';
import { useIsAdmin } from '../app/context';
import { useMode } from '../app/mode';
import { Page } from '../layout/Page';
import { plural } from '../ui/format';
import { AlbumGrid } from '../ui/media';
import { EmptyState, QueryView } from '../ui/states';
import { FirstSourceGuide } from './Welcome';

export function HomeView() {
  const home = useHome();
  const admin = useIsAdmin();
  const scan = useScanStatus();
  const { mode } = useMode();
  return (
    <Page title="Home">
      <QueryView query={home} label="Loading your library">
        {(h) =>
          h.stats.tracks === 0 ? (
            <EmptyState title={scan.data && busy(scan.data) ? 'Building your library…' : 'Your library is empty'}>
              {scan.data && busy(scan.data) ? (
                <p>Files appear here as they're scanned.</p>
              ) : mode === 'standalone' && h.stats.tracks === 0 ? (
                <>
                  <p>Add your first source: somewhere your music already is.</p>
                  <FirstSourceGuide compact />
                </>
              ) : admin ? (
                <>
                  <p>Add a music source to get started.</p>
                  <Link to="/settings/sources" className="btn primary">
                    Manage sources
                  </Link>
                </>
              ) : (
                <p>Ask the server admin to add a music source.</p>
              )}
            </EmptyState>
          ) : (
            <>
              <p className="muted small">
                {plural(h.stats.albums, 'album')} · {plural(h.stats.artists, 'artist')} · {plural(h.stats.tracks, 'track')}
              </p>
              <section aria-labelledby="h-recent">
                <div className="section-head">
                  <h2 id="h-recent">Recently added</h2>
                  <Link to="/library/albums?sort=recent" className="small">
                    See all
                  </Link>
                </div>
                <AlbumGrid albums={h.recentlyAdded} strip label="Recently added albums" />
              </section>
              {h.random.length > 3 && (
                <section aria-labelledby="h-random">
                  <div className="section-head">
                    <h2 id="h-random">Rediscover</h2>
                  </div>
                  <AlbumGrid albums={h.random} strip label="Random albums" />
                </section>
              )}
            </>
          )
        }
      </QueryView>
    </Page>
  );
}
