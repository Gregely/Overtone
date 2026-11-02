/**
 * RetrievalService — persistent, backend-managed debrid retrieval jobs.
 *
 * Replaces the fragile frontend-orchestrated "add magnet then poll" flow with
 * server-owned jobs persisted in `retrieval_jobs`. The backend is authoritative
 * for job state: it submits the magnet, polls the provider, and reconciles any
 * jobs left active by a crash on the next start.
 *
 * Safety properties:
 *  - Idempotency: at most one active job per (provider, infohash), enforced by
 *    a partial unique index; a duplicate request returns the existing job.
 *  - No auto-resubmission: a magnet whose submission outcome is ambiguous
 *    (network error) is marked failed, never blindly re-submitted. Retry is an
 *    explicit user action.
 *  - Restart recovery: orphaned `queued` jobs (crashed mid-submission) are
 *    failed rather than re-submitted; `processing` jobs resume polling.
 *
 * The stored `remote_id` (provider torrent id) + `provider_id` are the hook the
 * next increment uses to list/resolve a job's files without scanning the whole
 * debrid account.
 */
import type { CreateRetrievalJobRequestDto, CreateRetrievalJobResultDto, RetrievalJobDto, RetrievalJobStatus } from '@overtone/shared';
import { randomId } from '../crypto.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import type { BaseLogger } from '../logging.js';
import type { Clock } from '../platform/types.js';
import { isMagnetUri, magnetInfoHash } from '../providers/debrid/magnet.js';
import type { DebridService } from '../providers/debrid/service.js';
import { ProviderError } from '../providers/errors.js';

export interface RetrievalServiceDeps {
  db: Database;
  debrid: DebridService;
  clock: Clock;
  logger: BaseLogger;
  /** How often active jobs are polled. */
  pollIntervalMs?: number;
}

interface RetrievalJobRow {
  id: string;
  user_id: number;
  provider_id: string;
  provider_name: string;
  infohash: string;
  magnet: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  size: number | null;
  remote_id: string | null;
  status: RetrievalJobStatus;
  progress: number | null;
  error: string | null;
  files_processed: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const ACTIVE: readonly RetrievalJobStatus[] = ['queued', 'processing'];

/** The synthetic source id under which retrieval-job files live in the library. */
export const RETRIEVAL_SOURCE_ID = 'retrieval';

/** A completed job, for the retrieval source's file listing. */
export interface CompletedJob {
  id: string;
  providerId: string;
  remoteId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
}

/** A file of a retrieval job that has been imported into the library. */
export interface ImportedFile {
  fileId: string;
  name: string;
  path: string;
  size: number;
  mime: string | null;
  trackId: number | null;
}

export class RetrievalService {
  readonly #d: Required<Pick<RetrievalServiceDeps, 'pollIntervalMs'>> & RetrievalServiceDeps;
  #started = false;
  #cancel: (() => void) | undefined;

  /** Invoked (fire-and-forget) when a job reaches `complete`, to import its files. */
  onComplete: ((jobId: string) => void) | undefined;

  constructor(deps: RetrievalServiceDeps) {
    this.#d = { pollIntervalMs: 30_000, ...deps };
  }

  #now(): number {
    return this.#d.clock.now();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Recover interrupted jobs, then poll active jobs periodically. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.recover().catch((err) => this.#d.logger.warn({ error: (err as Error).message }, 'retrieval recovery failed'));
    this.#schedule();
  }

  stop(): void {
    this.#started = false;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #schedule(): void {
    this.#cancel = this.#d.clock.schedule(this.#d.pollIntervalMs, () => {
      if (!this.#started) return;
      void this.tick().catch((err) => this.#d.logger.warn({ error: (err as Error).message }, 'retrieval poll failed'));
      this.#schedule();
    });
  }

  /**
   * Reconcile jobs left non-terminal by a restart: `queued` jobs crashed
   * mid-submission (mark failed — never re-submit), `processing` jobs resume.
   */
  async recover(): Promise<void> {
    const now = this.#now();
    await this.#d.db.run(
      "UPDATE retrieval_jobs SET status = 'failed', error = 'Submission was interrupted; retry to resubmit.', updated_at = ? WHERE status = 'queued'",
      [now],
    );
    await this.tick();
  }

  /** Poll every active (processing) job once. */
  async tick(): Promise<void> {
    const rows = await this.#d.db.all<RetrievalJobRow>("SELECT * FROM retrieval_jobs WHERE status = 'processing'");
    for (const row of rows) {
      try {
        await this.#poll(row);
      } catch (err) {
        this.#d.logger.warn({ job: row.id, error: (err as Error).message }, 'retrieval job poll failed');
      }
    }
  }

  // ── API ───────────────────────────────────────────────────────────────────

  /** Create (or reuse) a retrieval job for an explicitly selected magnet. */
  async create(userId: number, input: CreateRetrievalJobRequestDto): Promise<CreateRetrievalJobResultDto> {
    if (!isMagnetUri(input.magnet)) throw ApiError.badRequest('Not a valid magnet link');
    const infohash = magnetInfoHash(input.magnet)!;
    const provider = (await this.#d.debrid.listProviders()).find((p) => p.sourceId === input.providerId && p.retrieval);
    if (!provider) throw ApiError.badRequest('Unknown debrid provider');

    const existing = await this.#activeJob(input.providerId, infohash);
    if (existing) return { job: toDto(existing), duplicate: true };

    const id = randomId(12);
    const now = this.#now();
    try {
      await this.#d.db.run(
        `INSERT INTO retrieval_jobs
           (id, user_id, provider_id, provider_name, infohash, magnet, title, artist, album, year, size, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        [id, userId, input.providerId, provider.name, infohash, input.magnet, input.title ?? null, input.artist ?? null, input.album ?? null, input.year ?? null, input.size ?? null, now, now],
      );
    } catch {
      // Lost a race to a concurrent create; the unique index rejected us.
      const winner = await this.#activeJob(input.providerId, infohash);
      if (winner) return { job: toDto(winner), duplicate: true };
      throw ApiError.conflict('A job for this release already exists');
    }

    await this.#submit(id);
    return { job: toDto((await this.#get(id))!), duplicate: false };
  }

  async list(userId: number): Promise<RetrievalJobDto[]> {
    const rows = await this.#d.db.all<RetrievalJobRow>('SELECT * FROM retrieval_jobs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    return rows.map(toDto);
  }

  async get(userId: number, id: string): Promise<RetrievalJobDto | undefined> {
    const row = await this.#get(id);
    if (!row || row.user_id !== userId) return undefined;
    return toDto(row);
  }

  /** Stop tracking a job (does not remove it from the provider). */
  async cancel(userId: number, id: string): Promise<RetrievalJobDto> {
    const row = await this.#require(userId, id);
    if (!ACTIVE.includes(row.status)) return toDto(row);
    await this.#update(id, { status: 'canceled' });
    return toDto((await this.#get(id))!);
  }

  /** Explicitly resubmit a failed/canceled job. */
  async retry(userId: number, id: string): Promise<RetrievalJobDto> {
    const row = await this.#require(userId, id);
    if (row.status !== 'failed' && row.status !== 'canceled') throw ApiError.badRequest('Only failed or canceled jobs can be retried');

    const other = await this.#activeJob(row.provider_id, row.infohash, id);
    if (other) throw ApiError.conflict('Another active job for this release already exists');

    await this.#update(id, { status: 'queued', error: null, progress: null, remote_id: null, completed_at: null });
    await this.#submit(id);
    return toDto((await this.#get(id))!);
  }

  /** Completed jobs with a provider id, for the retrieval source's file listing. */
  async completedJobs(): Promise<CompletedJob[]> {
    const rows = await this.#d.db.all<RetrievalJobRow>("SELECT * FROM retrieval_jobs WHERE status = 'complete' AND remote_id IS NOT NULL ORDER BY created_at ASC");
    return rows.map((r) => ({ id: r.id, providerId: r.provider_id, remoteId: r.remote_id!, title: r.title, artist: r.artist, album: r.album }));
  }

  /** A job row by id, regardless of owner (the source resolves files by id). */
  getRow(id: string): Promise<RetrievalJobRow | undefined> {
    return this.#get(id);
  }

  /** Files of one job already imported into the library (empty until imported). */
  async listImportedFiles(jobId: string): Promise<ImportedFile[]> {
    const rows = await this.#d.db.all<{ file_id: string; name: string; path: string; size: number; mime: string | null; track_id: number | null }>(
      'SELECT file_id, name, path, size, mime, track_id FROM source_files WHERE source_id = ? AND file_id LIKE ? ORDER BY path',
      [RETRIEVAL_SOURCE_ID, `j:${jobId}:%`],
    );
    const prefix = `j:${jobId}:`.length;
    return rows.map((r) => ({ fileId: r.file_id.slice(prefix), name: r.name, path: r.path, size: r.size, mime: r.mime, trackId: r.track_id }));
  }

  /** Whether any of this job's files have been imported yet. */
  async hasImportedFiles(jobId: string): Promise<boolean> {
    const row = await this.#d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_files WHERE source_id = ? AND file_id LIKE ?', [RETRIEVAL_SOURCE_ID, `j:${jobId}:%`]);
    return (row?.n ?? 0) > 0;
  }

  async markFilesProcessed(jobId: string): Promise<void> {
    await this.#d.db.run('UPDATE retrieval_jobs SET files_processed = 1 WHERE id = ?', [jobId]);
  }

  /** Ensure the synthetic retrieval source row exists (idempotent). */
  async ensureSource(): Promise<void> {
    await this.#d.db.run(
      `INSERT OR IGNORE INTO sources (id, provider_id, name, enabled, priority, stream_mode, config_json, created_at)
       VALUES (?, 'retrieval', 'Retrieved', 1, 50, 'proxy', '{}', ?)`,
      [RETRIEVAL_SOURCE_ID, this.#now()],
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Submit the job's magnet and record the provider id (or mark failed). */
  async #submit(jobId: string): Promise<void> {
    const row = await this.#get(jobId);
    if (!row) return;
    try {
      const added = await this.#d.debrid.addMagnet(row.provider_id, row.magnet);
      if (added.instant) {
        await this.#update(jobId, { remote_id: added.id, status: 'complete', error: null, completed_at: this.#now() });
      } else {
        await this.#update(jobId, { remote_id: added.id, status: 'processing', error: null });
      }
    } catch (err) {
      await this.#update(jobId, { status: 'failed', error: submissionError(err), remote_id: null });
    }
  }

  /** Poll one job's provider status and persist the transition. */
  async #poll(row: RetrievalJobRow): Promise<void> {
    if (!row.remote_id) {
      // Submitted remotely but we never recorded the id (interrupted): can't poll.
      await this.#update(row.id, { status: 'failed', error: 'Submission was interrupted; retry to resubmit.' });
      return;
    }
    let status;
    try {
      status = await this.#d.debrid.getStatus(row.provider_id, row.remote_id);
    } catch (err) {
      const mapped = pollError(err);
      if (mapped) await this.#update(row.id, { status: 'failed', error: mapped });
      return; // transient errors leave the job processing
    }

    if (status.status === 'finished') {
      await this.#update(row.id, { status: 'complete', progress: null, error: null, completed_at: this.#now() });
      void this.onComplete?.(row.id);
    } else if (status.status === 'error') {
      await this.#update(row.id, { status: 'failed', error: status.message });
    } else {
      await this.#update(row.id, { progress: status.progress });
    }
  }

  async #activeJob(providerId: string, infohash: string, excludeId?: string): Promise<RetrievalJobRow | undefined> {
    return this.#d.db.get<RetrievalJobRow>(
      `SELECT * FROM retrieval_jobs
        WHERE provider_id = ? AND infohash = ? AND status IN ('queued','processing')
          AND (? IS NULL OR id <> ?)
        ORDER BY created_at ASC LIMIT 1`,
      [providerId, infohash, excludeId ?? null, excludeId ?? ''],
    );
  }

  #get(id: string): Promise<RetrievalJobRow | undefined> {
    return this.#d.db.get<RetrievalJobRow>('SELECT * FROM retrieval_jobs WHERE id = ?', [id]);
  }

  async #require(userId: number, id: string): Promise<RetrievalJobRow> {
    const row = await this.#get(id);
    if (!row || row.user_id !== userId) throw ApiError.notFound('Retrieval job');
    return row;
  }

  async #update(id: string, patch: Partial<Pick<RetrievalJobRow, 'status' | 'progress' | 'error' | 'remote_id' | 'completed_at'>>): Promise<void> {
    const fields: string[] = ['updated_at = ?'];
    const params: unknown[] = [this.#now()];
    const set = (col: string, value: unknown) => {
      if (value !== undefined) {
        fields.push(`${col} = ?`);
        params.push(value);
      }
    };
    set('status', patch.status);
    set('progress', patch.progress);
    set('error', patch.error);
    set('remote_id', patch.remote_id);
    set('completed_at', patch.completed_at);
    params.push(id);
    await this.#d.db.run(`UPDATE retrieval_jobs SET ${fields.join(', ')} WHERE id = ?`, params);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Map a submission failure to a user-facing message (never auto-resubmit). */
function submissionError(err: unknown): string {
  if (err instanceof ProviderError) {
    if (err.code === 'unavailable') return 'The submission outcome is unknown (network error). Retry to resubmit.';
    return err.message;
  }
  return 'Submission failed';
}

/** Map a poll failure to a terminal message, or null when it's transient. */
function pollError(err: unknown): string | null {
  if (err instanceof ProviderError) {
    switch (err.code) {
      case 'unavailable':
      case 'rate_limited':
      case 'expired':
        return null; // transient — keep polling
      case 'not_found':
        return 'The torrent was removed from the provider';
      default:
        return err.message; // auth / config / subscription — the source is broken or removed
    }
  }
  return null; // network/timeout — transient
}

export function toDto(row: RetrievalJobRow): RetrievalJobDto {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    status: row.status,
    infohash: row.infohash,
    title: row.title,
    artist: row.artist,
    album: row.album,
    year: row.year,
    size: row.size,
    progress: row.progress,
    error: row.error,
    filesProcessed: row.files_processed === 1,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}
