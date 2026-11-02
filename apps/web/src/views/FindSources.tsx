import { useEffect, useState } from 'react';
import type { DebridProviderDto, DiscoverCachedStatus, DiscoverRequestDto, DiscoverResultDto } from '@overtone/shared';
import { useCreateRetrievalJob, useDebridProviders, useDiscover, usePreferences, useSavePreferences } from '../api/hooks';
import { useIsAdmin } from '../app/context';
import { Dialog } from '../ui/Dialog';
import { formatBytes, plural } from '../ui/format';
import { Icon } from '../ui/Icon';
import { EmptyState, ErrorState, errorMessage, Spinner } from '../ui/states';

export type FindSourcesTarget =
  | { kind: 'track' | 'album'; id: number; albumId?: number; title: string }
  | { kind: 'catalogue'; title: string; query: { title: string; artist?: string; album?: string; year?: number } };

const CACHED_LABEL: Record<DiscoverCachedStatus, string> = {
  cached: 'Cached',
  uncached: 'Not cached',
  unknown: 'Unknown',
  unavailable: 'Coming soon',
};

/** "Find sources": discover and retrieve releases for a track, album or catalogue entry. */
export function FindSourcesDialog({ target, onClose }: { target: FindSourcesTarget; onClose: () => void }) {
  const discover = useDiscover();
  const prefs = usePreferences();
  const body = (): DiscoverRequestDto => {
    if (target.kind === 'catalogue') return { query: target.query, type: 'album' };
    if (target.kind === 'album') return { albumId: target.id };
    const scope = prefs.data?.searchScope ?? 'auto';
    return scope === 'album' && target.albumId ? { albumId: target.albumId } : { trackId: target.id };
  };
  const run = () => discover.mutate(body());
  const key =
    target.kind === 'catalogue'
      ? `cat:${target.query.title}:${target.query.artist ?? ''}:${target.query.album ?? ''}:${target.query.year ?? ''}`
      : `${target.kind}:${target.id}:${target.albumId ?? ''}`;
  useEffect(() => {
    if (!prefs.isPending) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, prefs.data?.searchScope, prefs.isPending]);

  return (
    <Dialog open onClose={onClose} title={`Find sources · ${target.title}`}>
      {discover.isPending && <Spinner label="Searching indexers" />}
      {discover.error && <ErrorState error={discover.error} onRetry={run} />}
      {discover.data && (
        <ResultList results={discover.data.results} errors={discover.data.errors} />
      )}
    </Dialog>
  );
}

function ResultList({ results, errors }: { results: DiscoverResultDto[]; errors: Array<{ name: string; message: string }> }) {
  if (!results.length) {
    return (
      <EmptyState title="No sources found" icon="search">
        <p>No matching releases were found on your indexers.</p>
        {errors.length > 0 && <p className="small muted">{plural(errors.length, 'indexer')} couldn't be reached.</p>}
      </EmptyState>
    );
  }
  return (
    <div className="stack">
      {errors.length > 0 && (
        <p className="small muted" role="status">
          {plural(errors.length, 'indexer')} couldn't be reached.
        </p>
      )}
      <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Available releases">
        {results.map((r) => (
          <ResultItem key={r.key} result={r} />
        ))}
      </ul>
    </div>
  );
}

function ResultItem({ result: r }: { result: DiscoverResultDto }) {
  const [open, setOpen] = useState(false);
  const subtitle = [r.artist, r.year, r.format?.toUpperCase(), r.quality, r.type !== 'unknown' ? r.type : null].filter(Boolean).join(' · ');
  return (
    <li className="card stack-sm">
      <button type="button" className="row wrap" style={{ width: '100%', background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="stack-sm" style={{ flex: '1 1 200px', minWidth: 0 }}>
          <strong className="truncate">{r.title}</strong>
          {subtitle && <span className="small muted truncate">{subtitle}</span>}
          <span className="small muted">
            {[r.size != null ? formatBytes(r.size) : null, r.seeders != null ? plural(r.seeders, 'seeder') : null, r.leechers != null ? plural(r.leechers, 'leecher') : null, r.files != null ? plural(r.files, 'file') : null].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="row wrap" style={{ gap: 6, flex: 'none' }}>
          <span className="badge accent" title="Match confidence">{Math.round(r.score * 100)}%</span>
          <CachedBadges cached={r.cached} />
          <Icon name={open ? 'close' : 'more'} size={18} />
        </span>
      </button>
      {open && <ResultDetails result={r} />}
    </li>
  );
}

function CachedBadges({ cached }: { cached: DiscoverResultDto['cached'] }) {
  if (!cached.length) return null;
  return (
    <>
      {cached.map((c) => (
        <span key={c.providerId} className={`badge${c.status === 'cached' ? ' accent' : ''}`} title={`${c.providerName}: ${CACHED_LABEL[c.status]}`}>
          {c.status === 'cached' && <Icon name="check" size={12} />}
          {c.status === 'cached' ? c.providerName : `${c.providerName} · ${CACHED_LABEL[c.status]}`}
        </span>
      ))}
    </>
  );
}

function ResultDetails({ result: r }: { result: DiscoverResultDto }) {
  return (
    <div className="stack-sm">
      {r.reasons.length > 0 && (
        <p className="small muted">Ranked: {r.reasons.join(' · ')}</p>
      )}
      <p className="small muted">From {r.sources.map((s) => s.name).join(', ')}</p>
      <RetrievalPanel result={r} />
      {r.magnet && (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>Technical details</summary>
          <div className="small muted stack-sm" style={{ paddingTop: 6, overflowWrap: 'anywhere' }}>
            <div>Info hash: {r.infoHash ?? '—'}</div>
            <div>Magnet: {r.magnet}</div>
            {r.downloadUrl && <div>Torrent: {r.downloadUrl}</div>}
          </div>
        </details>
      )}
    </div>
  );
}

function RetrievalPanel({ result }: { result: DiscoverResultDto }) {
  const admin = useIsAdmin();
  const providers = useDebridProviders();
  const create = useCreateRetrievalJob();
  const prefs = usePreferences();
  const savePrefs = useSavePreferences();
  const magnet = result.magnet ?? (result.infoHash ? `magnet:?xt=urn:btih:${result.infoHash}` : null);

  const [confirming, setConfirming] = useState<DebridProviderDto | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  if (!admin) return <p className="small muted">Only admins can retrieve releases.</p>;
  if (!magnet) return <p className="small muted">This result has no magnet link to retrieve.</p>;

  const preferred = prefs.data?.preferredProvider;
  const list = [...(providers.data ?? [])].sort((a, b) => (a.sourceId === preferred ? -1 : b.sourceId === preferred ? 1 : 0));

  return (
    <div className="stack-sm">
      <h3 className="small">Retrieve with a connected provider</h3>
      {providers.isPending && <Spinner label="Loading providers" />}
      {list.map((p) => {
        const cached = result.cached.find((c) => c.providerId === p.sourceId)?.status;
        return (
          <div key={p.sourceId} className="row wrap" style={{ gap: 8 }}>
            <span className="truncate" style={{ flex: 1 }}>
              {p.name}
              {p.sourceId === preferred && <span className="badge accent">Preferred</span>}
              {!p.retrieval ? <span className="badge">Coming soon</span> : cached ? <span className={`badge${cached === 'cached' ? ' accent' : ''}`}>{CACHED_LABEL[cached]}</span> : null}
            </span>
            <button type="button" className="btn small" disabled={!p.retrieval} aria-label={`Retrieve with ${p.name}`} onClick={() => setConfirming(p)}>
              Retrieve
            </button>
          </div>
        );
      })}
      {notice && (
        <p className={`banner ${notice.ok ? 'ok' : 'error'}`} role="status">
          {notice.text}
        </p>
      )}
      {create.error && <p className="banner error" role="alert">{errorMessage(create.error)}</p>}
      <Dialog open={Boolean(confirming)} onClose={() => setConfirming(null)} title={`Add to ${confirming?.name}?`}>
        <p>This adds “{result.title}” to your {confirming?.name} account. Overtone only retrieves content you explicitly choose.</p>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={create.isPending}
            onClick={() => {
              const provider = confirming!;
              setConfirming(null);
              create.mutate(
                {
                  providerId: provider.sourceId,
                  magnet,
                  ...(result.title ? { title: result.title } : {}),
                  ...(result.artist ? { artist: result.artist } : {}),
                  ...(result.album ? { album: result.album } : {}),
                  ...(result.year != null ? { year: result.year } : {}),
                  ...(result.size != null ? { size: result.size } : {}),
                },
                {
                  onSuccess: (res) => {
                    if (prefs.data?.rememberLastProvider) savePrefs.mutate({ ...prefs.data, preferredProvider: provider.sourceId });
                    setNotice({
                      ok: true,
                      text: res.duplicate ? 'This release is already being retrieved.' : `Added to ${provider.name}. Track its progress in Downloads.`,
                    });
                  },
                },
              );
            }}
          >
            Add to {confirming?.name}
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  );
}
