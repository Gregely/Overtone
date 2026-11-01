import type { ScanReportDto, ScanStatusDto } from '@overtone/shared';
import type { BaseLogger } from '../http/redact.js';
import { parseFilename } from '../metadata/matcher/filename.js';
import type { Matcher, MatchInput } from '../metadata/matcher/matcher.js';
import { MusicBrainzError } from '../metadata/musicbrainz/client.js';
import { probeRemoteTags } from '../metadata/probe.js';
import { mergeTags } from '../metadata/tags.js';
import type { ResolveCache } from '../providers/resolve-cache.js';
import type { FileTags, SourceProvider } from '../providers/types.js';
import type { SourceManager } from '../sources/manager.js';
import type { LibraryRepo, SourceFileRow } from './repo.js';


export interface ScannerDeps {
  sources: SourceManager;
  library: LibraryRepo;
  resolver: ResolveCache;
  logger: BaseLogger;
  /** Used to probe remote files' tags with range requests. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Called when files are ready for matching. */
  onTagged?: () => void;
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
  readonly #debounce = new Map<string, NodeJS.Timeout>();
  #interval: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(deps: ScannerDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  // ── Scheduling ───────────────────────────────────────────────────────────

  /** Scan everything now, then every `intervalMinutes`; watch sources that support it. */
  start(intervalMinutes: number): void {
    for (const s of this.#d.sources.list()) if (s.enabled) this.#watchSource(s.id);
    this.enqueueAll();
    if (intervalMinutes > 0) this.#interval = setInterval(() => this.enqueueAll(), intervalMinutes * 60_000).unref();
    this.#unsubscribe = this.#d.sources.onChange((e) => {
      this.#unwatch(e.sourceId);
      if (e.type === 'deleted') {
        this.#d.library.cleanupOrphans();
        return;
      }
      const row = this.#d.sources.get(e.sourceId);
      if (row?.enabled) {
        this.#watchSource(e.sourceId);
        this.enqueue(e.sourceId);
      }
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.#interval);
    this.#unsubscribe?.();
    for (const id of [...this.#watchers.keys()]) this.#unwatch(id);
    this.#queue.length = 0;
    this.#running?.abort.abort();
    await this.#loop?.catch(() => undefined);
  }

  #watchSource(sourceId: string): void {
    try {
      const provider = this.#d.sources.instance(sourceId);
      if (!provider.watch) return;
      const w = provider.watch(() => {
        clearTimeout(this.#debounce.get(sourceId));
        this.#debounce.set(sourceId, setTimeout(() => this.enqueue(sourceId), 15_000).unref());
      });
      this.#watchers.set(sourceId, w);
    } catch (err) {
      this.#d.logger.warn({ sourceId, error: (err as Error).message }, 'could not watch source');
    }
  }

  #unwatch(sourceId: string): void {
    this.#watchers.get(sourceId)?.dispose();
    this.#watchers.delete(sourceId);
    clearTimeout(this.#debounce.get(sourceId));
    this.#debounce.delete(sourceId);
  }

  enqueueAll(): void {
    for (const s of this.#d.sources.list()) if (s.enabled) this.enqueue(s.id);
  }

  enqueue(sourceId: string): void {
    if (this.#running?.sourceId !== sourceId && !this.#queue.includes(sourceId)) this.#queue.push(sourceId);
    this.#loop ??= this.#drain().finally(() => {
      this.#loop = null;
    });
  }

  /** Resolves when the queue is empty (tests, CLI). */
  async idle(): Promise<void> {
    while (this.#loop) await this.#loop;
  }

  async #drain(): Promise<void> {
    while (this.#queue.length) {
      const id = this.#queue.shift()!;
      if (!this.#d.sources.get(id)) continue;
      await this.scanSource(id);
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
    try {
      const provider = this.#d.sources.instance(sourceId);
      const before = this.#d.library.countFiles(sourceId);
      let seen = 0;
      for await (const file of provider.listLibrary({ signal: abort.signal })) {
        const r = this.#d.library.upsertSourceFile(sourceId, file, scanId);
        report[r.status]++;
        this.#running.filesSeen = ++seen;
      }
      if (seen === 0 && before > 0) {
        // An empty listing from a previously populated source is far more likely an
        // unmounted drive or an API hiccup than a deliberate wipe. Keep the library.
        report.error = 'Source returned no files; kept existing library entries. Rescan once the source is back.';
        log.warn({ sourceId, before }, 'empty listing; skipping removals');
      } else {
        report.removed = this.#d.library.removeUnseen(sourceId, scanId);
      }
      await this.#tagPending(sourceId, provider, abort.signal);
    } catch (err) {
      report.error = (err as Error).message;
      log.warn({ sourceId, error: report.error }, 'scan failed');
    } finally {
      this.#running = null;
    }
    report.finishedAt = new Date(this.#now()).toISOString();
    this.#d.sources.setScanResult(sourceId, this.#now(), report.error);
    this.#reports.unshift(report);
    this.#reports.length = Math.min(this.#reports.length, 20);
    log.info({ ...report }, 'scan finished');
    this.#d.onTagged?.();
    return report;
  }

  async #tagPending(sourceId: string, provider: SourceProvider, signal: AbortSignal): Promise<void> {
    for (;;) {
      const batch = this.#d.library.filesNeedingTags(sourceId, 100);
      if (!batch.length) return;
      await mapLimit(batch, 4, async (file) => {
        signal.throwIfAborted();
        const tags = await this.#readTags(sourceId, provider, file, signal);
        this.#d.library.saveTags(file, tags);
      });
      this.#d.onTagged?.();
    }
  }

  async #readTags(sourceId: string, provider: SourceProvider, file: SourceFileRow, signal: AbortSignal): Promise<FileTags> {
    const listed = file.tags_json ? (JSON.parse(file.tags_json) as FileTags) : null;
    let embedded: FileTags | null = null;
    try {
      if (provider.readTags) embedded = await provider.readTags(file.file_id, { signal });
      else if (!listed?.title) embedded = await this.#probeRemote(sourceId, provider, file, signal);
    } catch (err) {
      this.#d.logger.debug({ sourceId, fileId: file.id, error: (err as Error).message }, 'tag read failed');
    }
    const tags = mergeTags(mergeTags(listed, embedded), parseFilename(file.path));
    if (!tags.durationMs && file.duration_ms) tags.durationMs = file.duration_ms;
    return tags;
  }

  /** Probe a remote file's tags through the shared resolve cache (same link playback will use). */
  async #probeRemote(sourceId: string, provider: SourceProvider, file: SourceFileRow, signal: AbortSignal): Promise<FileTags | null> {
    const stream = await this.#d.resolver.resolve(sourceId, provider, file.file_id, { signal });
    return probeRemoteTags(this.#d.fetch ?? fetch, stream, { mimeType: file.mime, size: file.size }, signal);
  }
}

/**
 * Drains pending matches in the background, one folder group at a time.
 * MusicBrainz outages back off and retry instead of marking files unmatched.
 */
export class MatchWorker {
  #active = false;
  #stopped = false;
  #retry: NodeJS.Timeout | undefined;

  constructor(
    private readonly library: LibraryRepo,
    private readonly matcher: Matcher,
    private readonly logger: BaseLogger,
    private readonly retryMs = 5 * 60_000,
  ) {}

  get active(): boolean {
    return this.#active;
  }

  kick(): void {
    if (this.#active || this.#stopped) return;
    this.#active = true;
    void this.#run().finally(() => {
      this.#active = false;
    });
  }

  /** For tests: run until nothing is pending. */
  async drain(): Promise<void> {
    while (await this.#step()) {
      /* keep going */
    }
    this.library.cleanupOrphans();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
  }

  async #run(): Promise<void> {
    try {
      while (!this.#stopped && (await this.#step())) {
        /* keep going */
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'matching paused; MusicBrainz unavailable?');
      clearTimeout(this.#retry);
      this.#retry = setTimeout(() => this.kick(), this.retryMs).unref();
    } finally {
      this.library.cleanupOrphans();
    }
  }

  /** Match one batch of folder groups. Returns false when nothing was pending. */
  async #step(): Promise<boolean> {
    const groups = this.library.pendingMatchGroups(100);
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
        for (const input of inputs) this.library.applyMatch(input.key, 'unmatched', 0, null, []);
        continue;
      }
      for (const input of inputs) {
        const r = results.get(input.key);
        if (!r) continue;
        // Re-check: a user may have pinned a manual match while we were waiting on MB.
        if (this.library.getFile(input.key)?.match_status !== 'pending') continue;
        this.library.applyMatch(input.key, r.status, r.score, r.best, r.candidates);
      }
    }
    this.library.cleanupOrphans();
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
