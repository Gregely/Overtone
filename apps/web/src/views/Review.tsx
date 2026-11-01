import { useState } from 'react';
import { NavLink, useSearchParams } from 'react-router';
import type { LibraryFileDto, MatchStatus } from '@overtone/shared';
import { useFiles, useScanStatus } from '../api/hooks';
import { useIsAdmin } from '../app/context';
import { Page } from '../layout/Page';
import { Dialog } from '../ui/Dialog';
import { plural } from '../ui/format';
import { Icon } from '../ui/Icon';
import { EmptyState, ErrorState, Spinner } from '../ui/states';
import { FileMatcher } from './FixMatch';

/** Queue of files that need a human: low-confidence and unmatched. */
export function ReviewView() {
  const admin = useIsAdmin();
  const [params] = useSearchParams();
  const status: MatchStatus = params.get('status') === 'unmatched' ? 'unmatched' : 'needs_review';
  const files = useFiles(status);
  const scan = useScanStatus();
  const [fixing, setFixing] = useState<LibraryFileDto | null>(null);
  if (!admin) return <Page title="Review matches"><p>Only admins can fix matches.</p></Page>;
  const m = scan.data?.matching;
  const items = files.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Page title="Review matches">
      <p className="muted">
        Files Overtone couldn't confidently identify on MusicBrainz. They still play and show up from their tags; fixing a match improves names,
        artwork and duplicate merging.
        {m && m.pending > 0 ? ` ${plural(m.pending, 'file')} still waiting to be matched.` : ''}
      </p>
      <nav className="tabs" aria-label="Match status">
        <NavLink to="/review?status=needs_review" aria-current={status === 'needs_review' ? 'page' : undefined}>
          Check match{m ? ` (${m.needsReview})` : ''}
        </NavLink>
        <NavLink to="/review?status=unmatched" aria-current={status === 'unmatched' ? 'page' : undefined}>
          No match{m ? ` (${m.unmatched})` : ''}
        </NavLink>
      </nav>
      {files.isPending ? (
        <Spinner />
      ) : files.error ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing to review" icon="check" />
      ) : (
        <ul className="tracks" aria-label="Files to review">
          {items.map((f) => {
            const tags = (f.tags ?? {}) as { title?: string; artist?: string; album?: string };
            const best = f.candidates[0];
            return (
              <li key={f.id} className="track">
                <div className="track-main" style={{ cursor: 'default' }}>
                  <span className="track-text">
                    <span className="track-title truncate">
                      {tags.title ?? f.name}
                      {tags.artist ? ` · ${tags.artist}` : ''}
                    </span>
                    <span className="small muted truncate">{f.path}</span>
                    {best && (
                      <span className="small muted truncate">
                        Best guess: {best.title} · {best.artistCredit}
                        {best.releaseTitle ? ` · ${best.releaseTitle}` : ''} ({Math.round(best.score * 100)}%)
                      </span>
                    )}
                  </span>
                </div>
                <button type="button" className="btn small" onClick={() => setFixing(f)} aria-label={`Fix match for ${tags.title ?? f.name}`}>
                  <Icon name="wand" size={16} /> Fix
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {files.hasNextPage && (
        <button type="button" className="btn" onClick={() => void files.fetchNextPage()}>
          Load more
        </button>
      )}
      <Dialog open={Boolean(fixing)} onClose={() => setFixing(null)} title="Fix match">
        {fixing && <FileMatcher file={fixing} onDone={() => setFixing(null)} />}
      </Dialog>
    </Page>
  );
}
