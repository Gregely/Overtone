import type { ScanReportDto, ScanStatusDto } from '@overtone/shared';
import type { Database } from '../db/database.js';
import type { BaseLogger } from '../logging.js';
import { parseFilename } from '../metadata/matcher/filename.js';
import type { Matcher, MatchInput } from '../metadata/matcher/matcher.js';
import { MusicBrainzError } from '../metadata/musicbrainz/client.js';
import { probeRemoteTags } from '../metadata/probe.js';
import { mergeTags } from '../metadata/tags.js';
import type { ResolveCache } from '../providers/resolve-cache.js';
import type { FileTags, SourceProvider } from '../providers/types.js';
import type { SourceManager } from '../sources/manager.js';
import { systemClock, type Clock, type HttpFetch } from '../platform/types.js';
import type { LibraryRepo, SourceFileRow } from './repo.js';
export interface ScannerDeps {
  sources: SourceManager;
  library: LibraryRepo;
  resolver: ResolveCache;
  logger: BaseLogger;
  /** Persists the scan queue (jobs table) so scans resume after a restart. */
  db?: Database;
  /** Used to probe remote files' tags with range requests. */
  fetch?: HttpFetch;
  clock?: Clock;
  /** @deprecated use clock */
  now?: () => number;
  /** Called when files are ready for matching. */
  onTagged?: () => void;
  /** Called whenever scanning starts/stops or progresses (foreground-service notifications). */
  onActivity?: () => void;
}

/**
 * Scans sources one at a time:
 *  1. list → upsert files (diffed by id + size/mtime) → remove files not seen
 *  2. read tags for new/changed files (provider tags → embedded → filename)
 *     and attach provisional tracks so the library is browsable immediately
 *  3. hand off to the MatchWorker for MusicBrainz matching (slow, 1 req/s)
 */
export class LibraryScanner {
  readonly #d: ScannerDeps;
  readonly #queue: string[] = [];
  #running: { sourceId: string; startedAt: number; filesSeen: number; abort: AbortController } | null = null;
  readonly #reports: ScanReportDto[] = [];
  #lastScanId = 0;
  #loop: Promise<void> | null = null;
  readonly #watchers = new Map<string, { dispose(): void }>();
  readonly #debounce = new Map<string, () => void>();
  #cancelInterval: (() => void) | undefined;
  #unsubscribe: (() => void) | undefined;
  #persist: Promise<unknown> = Promise.resolve();
  #stopped = false;
  readonly #clock: Clock;

  constructor(deps: ScannerDeps) {
    this.#d = deps;
    this.#clock = deps.clock ?? (deps.now ? { ...systemClock, now: deps.now } : systemClock);
  }

  #now(): number {
    return this.#clock.now();
  }

  get busy(): boolean {
    return this.#running !== null || this.#queue.length > 0;
  }

  /** What's running, for progress notifications. */
  get progress(): { sourceId: string; filesSeen: number; queued: number } | null {
    return this.#running ? { sourceId: this.#running.sourceId, filesSeen: this.#running.filesSeen, queued: this.#queue.length } : null;
  }

  // ── Scheduling ───────────────────────────────────────────────────────────

  /**
   * Resume scans interrupted by a restart (or by the app being killed), then
   * optionally scan everything now and every `intervalMinutes` (0 = never;
   * standalone mode scans on demand). Watches sources that support it.
   */
  async start(intervalMinutes: number, opts: { scanAll?: boolean } = {}): Promise<void> {
    this.#stopped = false;
    for (const s of await this.#d.sources.list()) if (s.enabled) await this.#watchSource(s.id);
    for (const id of await this.#pendingJobs()) this.enqueue(id);
    if (opts.scanAll ?? true) await this.enqueueAll();
    if (intervalMinutes > 0) {
      const tick = () => {
        void this.enqueueAll();
        this.#cancelInterval = this.#clock.schedule(intervalMinutes * 60_000, tick);
      };
      this.#cancelInterval = this.#clock.schedule(intervalMinutes * 60_000, tick);
    }
    this.#unsubscribe = this.#d.sources.onChange((e) => {
      this.#unwatch(e.sourceId);
      if (e.type === 'deleted') {
        void this.#d.library.cleanupOrphans();
        return;
      }
      void this.#d.sources.get(e.sourceId).then(async (row) => {
        if (row?.enabled) {
          await this.#watchSource(e.sourceId);
          this.enqueue(e.sourceId);
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelInterval?.();
    this.#unsubscribe?.();
    for (const id of [...this.#watchers.keys()]) this.#unwatch(id);
    this.#queue.length = 0;
    this.#running?.abort.abort();
    await this.#loop?.catch(() => undefined);
    await this.#persist.catch(() => undefined);
  }

  async #watchSource(sourceId: string): Promise<void> {
    try {
      const provider = await this.#d.sources.instance(sourceId);
      if (!provider.watch) return;
      const w = provider.watch(() => {
        this.#debounce.get(sourceId)?.();
        this.#debounce.set(sourceId, this.#clock.schedule(15_000, () => this.enqueue(sourceId)));
      });
      this.#watchers.set(sourceId, w);
    } catch (err) {
      this.#d.logger.warn({ sourceId, error: (err as Error).message }, 'could not watch source');
    }
  }

  #unwatch(sourceId: string): void {
    this.#watchers.get(sourceId)?.dispose();
    this.#watchers.delete(sourceId);
    this.#debounce.get(sourceId)?.();
    this.#debounce.delete(sourceId);
  }

  async enqueueAll(): Promise<void> {
    for (const s of await this.#d.sources.list()) if (s.enabled) this.enqueue(s.id);
  }

  enqueue(sourceId: string): void {
    if (this.#stopped) return;
    if (this.#running?.sourceId !== sourceId && !this.#queue.includes(sourceId)) {
      this.#queue.push(sourceId);
      this.#job('queued', sourceId);
    }
    this.#d.onActivity?.();
    this.#loop ??= this.#drain().finally(() => {
      this.#loop = null;
      this.#d.onActivity?.();
    });
  }

  // ── Persistent queue ─────────────────────────────────────────────────────

  async #pendingJobs(): Promise<string[]> {
    if (!this.#d.db) return [];
    const rows = await this.#d.db.all<{ source_id: string }>(`SELECT source_id FROM jobs WHERE kind = 'scan' ORDER BY created_at, id`);
    return rows.map((r) => r.source_id);
  }

  /** Record queue changes in order (fire-and-forget; awaited by stop()). */
  #job(state: 'queued' | 'running' | 'done', sourceId: string): void {
    const db = this.#d.db;
    if (!db) return;
    const now = this.#now();
    this.#persist = this.#persist
      .then(() =>
        state === 'done'
          ? db.run(`DELETE FROM jobs WHERE kind = 'scan' AND source_id = ?`, [sourceId])
          : db.run(
              `INSERT INTO jobs (kind, source_id, state, created_at, updated_at) VALUES ('scan', ?, ?, ?, ?)
               ON CONFLICT (kind, source_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
              [sourceId, state, now, now],
            ),
      )
      .catch((err) => this.#d.logger.warn({ error: (err as Error).message }, 'could not persist scan queue'));
  }

  /** Resolves when the queue is empty (tests, CLI). */
  async idle(): Promise<void> {
    while (this.#loop) await this.#loop;
  }

  async #drain(): Promise<void> {
    while (this.#queue.length) {
      const id = this.#queue.shift()!;
      if (!(await this.#d.sources.get(id))) {
        this.#job('done', id);
        continue;
      }
      this.#job('running', id);
      await this.scanSource(id);
      // A stop() mid-scan leaves the job in the table, so it resumes next start.
      if (!this.#stopped) this.#job('done', id);
    }
  }

  status(matching: ScanStatusDto['matching']): ScanStatusDto {
    return {
      running: this.#running
        ? { sourceId: this.#running.sourceId, startedAt: new Date(this.#running.startedAt).toISOString(), filesSeen: this.#running.filesSeen }
        : null,
      queued: [...this.#queue],
      matching,
      lastReports: [...this.#reports],
    };
  }

  // ── Scanning ─────────────────────────────────────────────────────────────

  async scanSource(sourceId: string): Promise<ScanReportDto> {
    const startedAt = this.#now();
    const scanId = (this.#lastScanId = Math.max(this.#lastScanId + 1, startedAt));
    const abort = new AbortController();
    this.#running = { sourceId, startedAt, filesSeen: 0, abort };
    const report: ScanReportDto = {
      sourceId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: '',
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
      error: null,
    };
    const log = this.#d.logger;
    let provider: SourceProvider | undefined;
    let seen = 0;
    try {
      provider = await this.#d.sources.instance(sourceId);
      const before = await this.#d.library.countFiles(sourceId);
      log.info({ sourceId, filesInLibrary: before }, 'scan started');
      for await (const file of provider.listLibrary({ signal: abort.signal })) {
        const r = await this.#d.library.upsertSourceFile(sourceId, file, scanId);
        report[r.status]++;
        this.#running.filesSeen = ++seen;
        if (seen % 200 === 0) this.#d.onActivity?.();
      }
      if (seen === 0 && before > 0) {
        // An empty listing from a previously populated source is far more likely an
        // unmounted drive or an API hiccup than a deliberate wipe. Keep the library.
        report.error = 'Source returned no files; kept existing library entries. Rescan once the source is back.';
        log.warn({ sourceId, before }, 'empty listing; skipping removals');
      } else {
        report.removed = await this.#d.library.removeUnseen(sourceId, scanId);
      }
      await this.#tagPending(sourceId, provider, abort.signal);
    } catch (err) {
      report.error = (err as Error).message;
      log.warn({ sourceId, error: report.error, filesListed: seen }, 'scan failed');
      // The listing broke partway (one API list failed, a timeout, a rate limit).
      // Files stored before the failure are real: tag them so they show up in the
      // library instead of sitting invisible until a fully clean scan. Removals
      // stay skipped, since an incomplete listing says nothing about what's gone.
      if (provider && !abort.signal.aborted && !this.#stopped) {
        try {
          await this.#tagPending(sourceId, provider, abort.signal);
        } catch (tagErr) {
          log.warn({ sourceId, error: (tagErr as Error).message }, 'tagging after a failed listing also failed');
        }
      }
    } finally {
      this.#running = null;
    }
    report.finishedAt = new Date(this.#now()).toISOString();
    await this.#d.sources.setScanResult(sourceId, this.#now(), report.error);
    this.#reports.unshift(report);
    this.#reports.length = Math.min(this.#reports.length, 20);
    log.info({ ...report, filesListed: seen }, 'scan finished');
    this.#d.onTagged?.();
    return report;
  }

  async #tagPending(sourceId: string, provider: SourceProvider, signal: AbortSignal): Promise<void> {
    const stats = { tagged: 0, tagReadFailures: 0 };
    try {
      for (;;) {
        const batch = await this.#d.library.filesNeedingTags(sourceId, 100);
        if (!batch.length) return;
        await mapLimit(batch, 4, async (file) => {
          signal.throwIfAborted();
          const tags = await this.#readTags(sourceId, provider, file, signal, stats);
          await this.#d.library.saveTags(file, tags);
          stats.tagged++;
        });
        this.#d.onTagged?.();
      }
    } finally {
      // tagReadFailures fell back to folder/file-name tags; they're still in the library.
      if (stats.tagged || stats.tagReadFailures) this.#d.logger.info({ sourceId, ...stats }, 'tagging finished');
    }
  }

  async #readTags(sourceId: string, provider: SourceProvider, file: SourceFileRow, signal: AbortSignal, stats?: { tagReadFailures: number }): Promise<FileTags> {
    const listed = file.tags_json ? (JSON.parse(file.tags_json) as FileTags) : null;
    let embedded: FileTags | null = null;
    try {
      if (provider.readTags) embedded = await provider.readTags(file.file_id, { signal });
      else if (!listed?.title) embedded = await this.#probeRemote(sourceId, provider, file, signal);
    } catch (err) {
      if (stats) stats.tagReadFailures++;
      this.#d.logger.debug({ sourceId, fileId: file.id, error: (err as Error).message }, 'tag read failed');
    }
    const tags = mergeTags(mergeTags(listed, embedded), parseFilename(file.path));
    if (!tags.durationMs && file.duration_ms) tags.durationMs = file.duration_ms;
    return tags;
  }

  /** Probe a remote file's tags through the shared resolve cache (same link playback will use). */
  async #probeRemote(sourceId: string, provider: SourceProvider, file: SourceFileRow, signal: AbortSignal): Promise<FileTags | null> {
    const stream = await this.#d.resolver.resolve(sourceId, provider, file.file_id, { signal });
    return probeRemoteTags(this.#d.fetch ?? ((u, i) => globalThis.fetch(u, i)), stream, { mimeType: file.mime, size: file.size }, signal);
  }
}

/**
 * Drains pending matches in the background, one folder group at a time.
 * MusicBrainz outages back off and retry instead of marking files unmatched.
 */
export class MatchWorker {
  #active = false;
  #stopped = false;
  /** Background matching (kick) is off until resume() (core.start()); drain() works regardless. */
  #enabled = false;
  #cancelRetry: (() => void) | undefined;
  #run_: Promise<void> | null = null;
  /** Called when matching starts/stops (foreground-service notifications). */
  onActivity: (() => void) | undefined;

  constructor(
    private readonly library: LibraryRepo,
    private readonly matcher: Matcher,
    private readonly logger: BaseLogger,
    private readonly retryMs = 5 * 60_000,
    private readonly clock: Clock = systemClock,
  ) {}

  get active(): boolean {
    return this.#active;
  }

  kick(): void {
    if (this.#active || this.#stopped || !this.#enabled) return;
    this.#active = true;
    this.onActivity?.();
    this.#run_ = this.#run().finally(() => {
      this.#active = false;
      this.#run_ = null;
      this.onActivity?.();
    });
  }

  /** Enable background matching (kick()). Called by core.start(); stop() pauses it again. */
  resume(): void {
    this.#stopped = false;
    this.#enabled = true;
  }

  /** Resolves when the current run (if any) finishes. */
  async idle(): Promise<void> {
    while (this.#run_) await this.#run_;
  }

  /** For tests: run until nothing is pending. */
  async drain(): Promise<void> {
    while (await this.#step()) {
      /* keep going */
    }
    await this.library.cleanupOrphans();
  }

  stop(): void {
    this.#stopped = true;
    this.#enabled = false;
    this.#cancelRetry?.();
  }

  async #run(): Promise<void> {
    try {
      while (!this.#stopped && (await this.#step())) {
        /* keep going */
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'matching paused; MusicBrainz unavailable?');
      this.#cancelRetry?.();
      this.#cancelRetry = this.clock.schedule(this.retryMs, () => this.kick());
    } finally {
      await this.library.cleanupOrphans().catch(() => undefined);
    }
  }

  /** Match one batch of folder groups. Returns false when nothing was pending. */
  async #step(): Promise<boolean> {
    const groups = await this.library.pendingMatchGroups(100);
    if (!groups.length) return false;
    for (const group of groups) {
      if (this.#stopped) return false;
      const inputs: MatchInput[] = group.map((f) => {
        const tags = f.tags_json ? (JSON.parse(f.tags_json) as FileTags) : {};
        if (!tags.durationMs && f.duration_ms) tags.durationMs = f.duration_ms;
        return { key: f.id, path: f.path, tags };
      });
      let results;
      try {
        results = await this.matcher.matchGroup(inputs);
      } catch (err) {
        if (isTransient(err)) throw err; // pause the whole queue; MusicBrainz is unreachable
        // Anything else is specific to this group: don't let it block the queue forever.
        this.logger.error({ error: (err as Error).message, files: inputs.length }, 'matching failed for a folder; marking unmatched');
        for (const input of inputs) await this.library.applyMatch(input.key, 'unmatched', 0, null, []);
        continue;
      }
      for (const input of inputs) {
        const r = results.get(input.key);
        if (!r) continue;
        // Re-check: a user may have pinned a manual match while we were waiting on MB.
        if ((await this.library.getFile(input.key))?.match_status !== 'pending') continue;
        await this.library.applyMatch(input.key, r.status, r.score, r.best, r.candidates);
      }
    }
    await this.library.cleanupOrphans();
    return true;
  }
}

/** Network/MusicBrainz availability problems: retry later rather than give up on files. */
export function isTransient(err: unknown): boolean {
  const e = err as Error & { cause?: unknown };
  return (
    e instanceof MusicBrainzError ||
    e?.name === 'TimeoutError' ||
    e?.name === 'AbortError' ||
    (e instanceof TypeError && /fetch failed/i.test(e.message))
  );
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}
