import { useState } from 'react';
import type { RetrievalJobDto, RetrievalJobStatus } from '@overtone/shared';
import { useCancelRetrievalJob, useRetrievalJobFiles, useRetrievalJobs, useRetryRetrievalJob } from '../api/hooks';
import { useIsAdmin } from '../app/context';
import { Page } from '../layout/Page';
import { usePlayer } from '../player/react';
import { Icon } from '../ui/Icon';
import { formatBytes, formatTime } from '../ui/format';
import { EmptyState, errorMessage, Spinner } from '../ui/states';

const STATUS_LABEL: Record<RetrievalJobStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  complete: 'Complete',
  failed: 'Failed',
  canceled: 'Canceled',
};

const TERMINAL: readonly RetrievalJobStatus[] = ['complete', 'failed', 'canceled'];

/** Downloads: active, completed and failed debrid retrieval jobs, with playback. */
export function RetrievalView() {
  const admin = useIsAdmin();
  const jobs = useRetrievalJobs();
  const cancel = useCancelRetrievalJob();
  const retry = useRetryRetrievalJob();

  if (!admin) return <Page title="Downloads">Only admins can retrieve releases.</Page>;

  const items = jobs.data ?? [];
  const active = items.filter((j) => j.status === 'queued' || j.status === 'processing');
  const done = items.filter((j) => TERMINAL.includes(j.status));

  return (
    <Page title="Downloads">
      <div className="stack">
        {jobs.isPending && !jobs.data && <Spinner label="Loading downloads" />}
        {jobs.error && <p className="banner error" role="alert">{errorMessage(jobs.error)}</p>}

        {!jobs.isPending && items.length === 0 && (
          <EmptyState title="No downloads yet" icon="download">
            <p>Find a release in the library, then “Find sources” to retrieve it.</p>
          </EmptyState>
        )}

        {active.length > 0 && (
          <section className="stack-sm" aria-labelledby="jobs-active">
            <h2 id="jobs-active">Active</h2>
            {active.map((j) => (
              <JobRow key={j.id} job={j} onCancel={() => cancel.mutate(j.id)} onRetry={() => retry.mutate(j.id)} />
            ))}
          </section>
        )}

        {done.length > 0 && (
          <section className="stack-sm" aria-labelledby="jobs-done">
            <h2 id="jobs-done">History</h2>
            {done.map((j) => (
              <JobRow key={j.id} job={j} onCancel={() => cancel.mutate(j.id)} onRetry={() => retry.mutate(j.id)} />
            ))}
          </section>
        )}
      </div>
    </Page>
  );
}

function JobRow({ job, onCancel, onRetry }: { job: RetrievalJobDto; onCancel: () => void; onRetry: () => void }) {
  const active = job.status === 'queued' || job.status === 'processing';
  const subtitle = [job.artist, job.album, job.year, job.size != null ? formatBytes(job.size) : null].filter(Boolean).join(' · ');
  return (
    <div className="card stack-sm">
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="truncate" style={{ flex: 1 }}>
          <strong>{job.title ?? job.infohash ?? 'Unknown release'}</strong>
          {subtitle && <span className="small muted"> · {subtitle}</span>}
        </span>
        <StatusBadge status={job.status} />
      </div>
      <div className="row wrap small muted" style={{ gap: 12 }}>
        <span>{job.providerName}</span>
        <span>Started {new Date(job.createdAt).toLocaleString()}</span>
        {job.completedAt && <span>Finished {new Date(job.completedAt).toLocaleString()}</span>}
      </div>
      {active && (
        <p className="row wrap" style={{ gap: 8 }}>
          <span className="spinner" aria-hidden="true" />
          <span role="status">{job.progress != null ? `${Math.round(job.progress * 100)}%` : 'Waiting for the provider…'}</span>
        </p>
      )}
      {job.error && (
        <p className="banner error" role="alert">
          {job.error}
        </p>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        {job.status === 'complete' && <JobFiles job={job} />}
        {active && (
          <button type="button" className="btn ghost small" onClick={onCancel}>
            Cancel
          </button>
        )}
        {(job.status === 'failed' || job.status === 'canceled') && (
          <button type="button" className="btn small" onClick={onRetry}>
            <Icon name="refresh" size={16} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}

function JobFiles({ job }: { job: RetrievalJobDto }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn small" onClick={() => setOpen(true)}>
        <Icon name="music" size={16} /> View tracks
      </button>
    );
  }
  return <JobFilesList job={job} onClose={() => setOpen(false)} />;
}

function JobFilesList({ job, onClose }: { job: RetrievalJobDto; onClose: () => void }) {
  const files = useRetrievalJobFiles(job.id);
  const player = usePlayer();

  return (
    <div className="stack-sm" style={{ width: '100%' }}>
      <div className="row wrap" style={{ gap: 8 }}>
        {files.isPending && <Spinner label="Loading files" />}
        {files.error && <span className="small muted">{errorMessage(files.error)}</span>}
        {files.data && files.data.tracks.length > 0 && (
          <button
            type="button"
            className="btn primary small"
            onClick={() => player.playTracks(files.data!.tracks, 0, { shuffle: false })}
          >
            <Icon name="play" size={16} /> Play album ({files.data.tracks.length})
          </button>
        )}
        <button type="button" className="btn ghost small" onClick={onClose}>
          <Icon name="close" size={16} /> Close
        </button>
      </div>

      {files.data && (
        <>
          {files.data.files.length === 0 && files.data.imported && <p className="small muted">No playable audio files in this release.</p>}
          <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {files.data.tracks.map((t) => {
              const size = files.data!.files.find((f) => f.trackId === t.id)?.size;
              return (
                <li key={t.id} className="row wrap" style={{ gap: 8 }}>
                  <span className="truncate" style={{ flex: 1 }}>
                    {t.trackNo != null ? `${t.trackNo}. ` : ''}
                    {t.title}
                    <span className="small muted">
                      {size != null ? ` · ${formatBytes(size)}` : ''} · {formatTime((t.durationMs ?? 0) / 1000)}
                    </span>
                  </span>
                  <button type="button" className="btn ghost small" aria-label={`Play ${t.title}`} onClick={() => player.playTracks([t], 0, { shuffle: false })}>
                    <Icon name="play" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: RetrievalJobStatus }) {
  const icon = status === 'complete' ? 'check' : status === 'failed' ? 'alert' : status === 'canceled' ? 'close' : undefined;
  return (
    <span className={`badge${status === 'complete' ? ' accent' : status === 'failed' ? ' error' : ''}`}>
      {icon && <Icon name={icon} size={12} />} {STATUS_LABEL[status]}
    </span>
  );
}
