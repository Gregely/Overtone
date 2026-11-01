import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { LibraryFileDto, MatchCandidateDto, TrackDto } from '@overtone/shared';
import {
  useAlbumMatch,
  useApplyMatch,
  useCandidateSearch,
  useReleaseSearch,
  useRematch,
  useTrackFiles,
} from '../api/hooks';
import { Dialog } from '../ui/Dialog';
import { formatMs } from '../ui/format';
import { Icon } from '../ui/Icon';
import { MatchBadge } from '../ui/media';
import { errorMessage, Spinner } from '../ui/states';

const STATUS_TEXT: Record<LibraryFileDto['matchStatus'], string> = {
  pending: 'Waiting to be matched',
  matched: 'Matched automatically',
  manual: 'Matched by you',
  needs_review: 'Low-confidence match',
  unmatched: 'No match; shown from file tags',
};

/** Fix the MusicBrainz match for a track's file (picks the file first if the track has several). */
export function FixMatchDialog({ track, onClose }: { track: TrackDto; onClose: () => void }) {
  const files = useTrackFiles(track.id);
  const [fileId, setFileId] = useState<number | null>(null);
  const list = files.data?.items ?? [];
  const file = list.find((f) => f.id === fileId) ?? (list.length === 1 ? list[0] : undefined);

  return (
    <Dialog open onClose={onClose} title={`Fix match: ${track.title}`}>
      {files.isPending ? (
        <Spinner label="Loading files" />
      ) : files.error ? (
        <p role="alert">{errorMessage(files.error)}</p>
      ) : file ? (
        <FileMatcher file={file} onDone={onClose} />
      ) : (
        <div className="stack-sm">
          <p>This track exists in several files. Which one do you want to fix?</p>
          <ul className="sheet-actions">
            {list.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => setFileId(f.id)}>
                  <span className="truncate">{f.path}</span>
                  <MatchBadge status={f.matchStatus} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

export function FileMatcher({ file, onDone }: { file: LibraryFileDto; onDone: () => void }) {
  const tags = (file.tags ?? {}) as { title?: string; artist?: string; album?: string };
  const [title, setTitle] = useState(tags.title ?? '');
  const [artist, setArtist] = useState(tags.artist ?? '');
  const search = useCandidateSearch();
  const apply = useApplyMatch();
  const rematch = useRematch();
  const results: MatchCandidateDto[] = search.data ?? file.candidates;

  const runSearch = (e?: FormEvent) => {
    e?.preventDefault();
    search.mutate({ fileId: file.id, title, artist });
  };

  return (
    <div className="stack">
      <dl className="meta">
        <dt>File</dt>
        <dd>{file.path}</dd>
        <dt>Status</dt>
        <dd>
          {STATUS_TEXT[file.matchStatus]}
          {file.matchScore && file.matchStatus !== 'manual' ? ` (best guess ${Math.round(file.matchScore * 100)}%)` : ''}
        </dd>
        {tags.album && (
          <>
            <dt>Album tag</dt>
            <dd>{tags.album}</dd>
          </>
        )}
      </dl>

      <form className="stack-sm" onSubmit={runSearch} aria-label="Search MusicBrainz">
        <div className="field">
          <label htmlFor={`fm-title-${file.id}`}>Title</label>
          <input id={`fm-title-${file.id}`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`fm-artist-${file.id}`}>Artist</label>
          <input id={`fm-artist-${file.id}`} className="input" value={artist} onChange={(e) => setArtist(e.target.value)} />
        </div>
        <div className="row wrap">
          <button type="submit" className="btn primary" disabled={search.isPending || !title.trim()}>
            <Icon name="search" size={18} /> {search.isPending ? 'Searching…' : 'Search MusicBrainz'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={rematch.isPending}
            onClick={() => rematch.mutate(file.id, { onSuccess: onDone })}
          >
            <Icon name="refresh" size={18} /> Retry automatic match
          </button>
        </div>
      </form>

      {search.error && <p role="alert" className="banner error">{errorMessage(search.error)}</p>}
      {apply.error && <p role="alert" className="banner error">{errorMessage(apply.error)}</p>}

      <section aria-label="Candidates" aria-live="polite" aria-busy={search.isPending}>
        {results.length === 0 ? (
          <p className="muted">{search.isSuccess ? 'No candidates found. Try different words.' : 'Search to see candidates.'}</p>
        ) : (
          <ul className="candidates">
            {results.map((c) => (
              <li key={`${c.recordingMbid}-${c.releaseMbid}`} className="candidate">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate">
                    <strong>{c.title}</strong> · {c.artistCredit}
                  </div>
                  <div className="small muted truncate">
                    {c.releaseTitle ?? 'No release'}
                    {c.releaseDate ? ` (${c.releaseDate.slice(0, 4)})` : ''}
                    {c.trackNo ? ` · track ${c.trackNo}` : ''}
                    {c.durationMs ? ` · ${formatMs(c.durationMs)}` : ''} · {Math.round(c.score * 100)}%
                  </div>
                </div>
                <button
                  type="button"
                  className="btn small"
                  disabled={apply.isPending}
                  onClick={() => apply.mutate({ fileId: file.id, recordingMbid: c.recordingMbid, releaseMbid: c.releaseMbid }, { onSuccess: onDone })}
                >
                  Use this{' '}
                  <span className="visually-hidden">
                    for {c.title} from {c.releaseTitle ?? 'no release'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Re-assign a whole album to a MusicBrainz release. */
export function AlbumMatchDialog({ album, onClose }: { album: { id: number; title: string; artistCredit: string }; onClose: () => void }) {
  const [q, setQ] = useState(album.title);
  const [artist, setArtist] = useState(album.artistCredit);
  const search = useReleaseSearch();
  const apply = useAlbumMatch();
  const navigate = useNavigate();
  const { mutate } = search;

  useEffect(() => {
    mutate({ q: album.title, artist: album.artistCredit });
  }, [mutate, album.title, album.artistCredit]);

  return (
    <Dialog open onClose={onClose} title={`Fix album match: ${album.title}`}>
      <form
        className="stack-sm"
        aria-label="Search MusicBrainz releases"
        onSubmit={(e) => {
          e.preventDefault();
          search.mutate({ q, artist });
        }}
      >
        <div className="field">
          <label htmlFor="am-q">Album</label>
          <input id="am-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="am-artist">Artist</label>
          <input id="am-artist" className="input" value={artist} onChange={(e) => setArtist(e.target.value)} />
        </div>
        <div>
          <button type="submit" className="btn primary" disabled={search.isPending || !q.trim()}>
            <Icon name="search" size={18} /> {search.isPending ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>
      {(search.error || apply.error) && <p role="alert" className="banner error">{errorMessage(search.error ?? apply.error)}</p>}
      <section aria-label="Releases" aria-live="polite" aria-busy={search.isPending}>
        {search.data?.length === 0 && <p className="muted">No releases found.</p>}
        <ul className="candidates">
          {search.data?.map((r) => (
            <li key={r.mbid} className="candidate">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="truncate">
                  <strong>{r.title}</strong> · {r.artistCredit}
                </div>
                <div className="small muted">
                  {[r.date?.slice(0, 4), r.country, r.primaryType, r.trackCount ? `${r.trackCount} tracks` : null, r.status].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button
                type="button"
                className="btn small"
                disabled={apply.isPending}
                onClick={() =>
                  apply.mutate(
                    { albumId: album.id, releaseMbid: r.mbid },
                    {
                      onSuccess: (detail) => {
                        onClose();
                        navigate(`/albums/${detail.album.id}`, { replace: true });
                      },
                    },
                  )
                }
              >
                Use this{' '}
                <span className="visually-hidden">
                  release: {r.title}
                  {r.date ? ` (${r.date.slice(0, 4)})` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </Dialog>
  );
}
