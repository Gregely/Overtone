/**
 * DiscoveryService — the "Find sources" pipeline.
 *
 * Turns a discovery target into an ordered list of release candidates by
 * searching every enabled torrent indexer (concurrently, with per-indexer
 * timeouts and graceful failure), de-duplicating across indexers while
 * retaining source attribution, and ranking by metadata agreement.
 *
 * Results are cached briefly; any change to indexer configuration clears the
 * cache. No content is requested or added here — this stage only searches.
 */
import type { DiscoverResponseDto, DiscoverResultDto, DiscoverSourceDto } from '@overtone/shared';
import { normalize } from '../metadata/matcher/normalize.js';
import type { BaseLogger } from '../logging.js';
import type { Clock } from '../platform/types.js';
import type { DebridService } from '../providers/debrid/service.js';
import type { TorrentSourceManager, TorrentSourceRow } from './manager.js';
import { buildQueries, type DiscoveryTarget } from './query-builder.js';
import { rankHit, type RankPreferences } from './ranking.js';
import type { IndexerHit } from './types.js';

interface AggregatedHit {
  hit: IndexerHit;
  sourceId: string;
  sourceName: string;
}

interface Group {
  key: string;
  primary: IndexerHit;
  sources: DiscoverSourceDto[];
  maxSeeders: number | null;
  maxLeechers: number | null;
}

interface CacheEntry {
  value: DiscoverResponseDto;
  expiresAt: number;
}

export interface DiscoveryServiceDeps {
  sources: TorrentSourceManager;
  logger: BaseLogger;
  clock?: Clock;
  /** Cached-availability checks for the ranked results. */
  debrid?: DebridService;
  /** Result cache lifetime. */
  cacheTtlMs?: number;
  maxResults?: number;
  /** Per-indexer search timeout. */
  timeoutMs?: number;
  /** How many query variations to try before stopping. */
  maxQueries?: number;
  /** Stop trying further queries once this many results reach this score. */
  earlyStopScore?: number;
  earlyStopCount?: number;
  /** How many of the top results to annotate with cached availability. */
  cachedCheckLimit?: number;
}

interface ResolvedDeps {
  sources: TorrentSourceManager;
  logger: BaseLogger;
  clock?: Clock;
  debrid?: DebridService;
  cacheTtlMs: number;
  maxResults: number;
  timeoutMs: number;
  maxQueries: number;
  earlyStopScore: number;
  earlyStopCount: number;
  cachedCheckLimit: number;
}

const PER_QUERY_CAP = 200;

/** Preferences applied to ranking and result filtering (see DiscoveryPreferencesDto). */
export interface DiscoveryOptions extends RankPreferences {
  /** Give already-cached releases a small ranking advantage. */
  prioritizeCached?: boolean;
  /** Hide releases that no connected provider has cached. */
  hideUncached?: boolean;
}

export class DiscoveryService {
  readonly #d: ResolvedDeps;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #unsubscribe: () => void;

  constructor(deps: DiscoveryServiceDeps) {
    this.#d = {
      cacheTtlMs: 10 * 60_000,
      maxResults: 50,
      timeoutMs: 10_000,
      maxQueries: 3,
      earlyStopScore: 0.75,
      earlyStopCount: 3,
      cachedCheckLimit: 10,
      ...deps,
    };
    // Config changes invalidate cached results.
    this.#unsubscribe = deps.sources.onChange(() => this.#cache.clear());
  }

  close(): void {
    this.#unsubscribe();
  }

  #now(): number {
    return this.#d.clock?.now() ?? Date.now();
  }

  async discover(target: DiscoveryTarget, opts: DiscoveryOptions = {}): Promise<DiscoverResponseDto> {
    const key = cacheKey(target, this.#d.maxResults, opts);
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.value;

    const value = await this.#search(target, opts);
    this.#set(key, value);
    return value;
  }

  #set(key: string, value: DiscoverResponseDto): void {
    this.#cache.set(key, { value, expiresAt: this.#now() + this.#d.cacheTtlMs });
    while (this.#cache.size > 200) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  async #search(target: DiscoveryTarget, opts: DiscoveryOptions): Promise<DiscoverResponseDto> {
    const queries = buildQueries(target).slice(0, this.#d.maxQueries);
    const sources = dedupeByUrl(await this.#d.sources.list()).filter((s) => s.enabled === 1);

    const errors: DiscoverResponseDto['errors'] = [];
    const all: AggregatedHit[] = [];

    for (const query of queries) {
      const settled = await Promise.allSettled(sources.map((s) => this.#searchSource(s, query)));
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i]!;
        const s = sources[i]!;
        if (r.status === 'fulfilled') all.push(...r.value);
        else errors.push({ sourceId: s.id, name: s.name, message: errorMessage(r.reason) });
      }
      if (this.#enough(all, target, opts)) break;
    }

    const ranked = this.#applyCachedPrefs(await this.#annotateCached(this.#rank(all, target, opts)), opts);
    return {
      query: {
        scope: target.scope,
        title: target.title,
        ...(target.artist ? { artist: target.artist } : {}),
        ...(target.album ? { album: target.album } : {}),
        ...(target.year ? { year: target.year } : {}),
      },
      results: ranked.slice(0, this.#d.maxResults),
      errors: dedupeErrors(errors),
    };
  }

  async #searchSource(source: TorrentSourceRow, query: string): Promise<AggregatedHit[]> {
    const indexer = await this.#d.sources.instance(source.id);
    const out: AggregatedHit[] = [];
    const signal = AbortSignal.timeout(this.#d.timeoutMs);
    for await (const hit of indexer.search({ query, signal })) {
      out.push({ hit, sourceId: source.id, sourceName: source.name });
      if (out.length >= PER_QUERY_CAP) break;
    }
    return out;
  }

  #enough(all: AggregatedHit[], target: DiscoveryTarget, prefs: RankPreferences): boolean {
    let good = 0;
    for (const g of dedupe(all).values()) {
      if (rankHit(target, g.primary, prefs).score >= this.#d.earlyStopScore && ++good >= this.#d.earlyStopCount) return true;
    }
    return false;
  }

  #rank(all: AggregatedHit[], target: DiscoveryTarget, prefs: RankPreferences): DiscoverResultDto[] {
    const out: DiscoverResultDto[] = [];
    for (const g of dedupe(all).values()) {
      const { score, reasons, parsed } = rankHit(target, g.primary, prefs);
      out.push({
        key: g.key,
        title: parsed.title,
        artist: parsed.artist,
        album: parsed.type === 'track' || parsed.type === 'single' || parsed.type === 'unknown' ? null : parsed.title,
        year: parsed.year,
        format: parsed.format,
        quality: parsed.quality,
        type: parsed.type,
        size: g.primary.size,
        seeders: g.maxSeeders,
        leechers: g.maxLeechers,
        files: g.primary.files,
        sources: g.sources,
        magnet: g.primary.magnet ?? null,
        infoHash: g.primary.infoHash ?? null,
        downloadUrl: g.primary.downloadUrl ?? null,
        score,
        reasons,
        cached: [],
      });
    }
    out.sort((a, b) => b.score - a.score || (b.seeders ?? -1) - (a.seeders ?? -1) || a.title.localeCompare(b.title));
    return out;
  }

  /** Annotate the top results with cached availability across debrid providers. */
  async #annotateCached(ranked: DiscoverResultDto[]): Promise<DiscoverResultDto[]> {
    if (!this.#d.debrid) return ranked;
    const providers = await this.#d.debrid.listProviders();
    if (!providers.length) return ranked;
    const sourceIds = providers.map((p) => p.sourceId);
    const toCheck = ranked.slice(0, this.#d.cachedCheckLimit).filter((r) => r.magnet || r.infoHash);
    if (!toCheck.length) return ranked;
    const statuses = await Promise.all(
      toCheck.map((r) =>
        this.#d.debrid!.checkCached(
          { ...(r.magnet ? { magnet: r.magnet } : {}), ...(r.infoHash ? { infoHash: r.infoHash } : {}) },
          sourceIds,
        ),
      ),
    );
    toCheck.forEach((r, i) => {
      r.cached = statuses[i]!.map((s) => ({ providerId: s.providerId, providerName: s.providerName, status: s.status }));
    });
    return ranked;
  }

  /** Apply cached-release preferences: a small ranking bonus and/or filtering. */
  #applyCachedPrefs(ranked: DiscoverResultDto[], opts: DiscoveryOptions): DiscoverResultDto[] {
    const isCached = (r: DiscoverResultDto) => r.cached.some((c) => c.status === 'cached');
    let out = ranked;
    if (opts.hideUncached && ranked.some(isCached)) {
      out = ranked.filter(isCached);
    }
    if (opts.prioritizeCached) {
      for (const r of out) if (isCached(r)) r.score = Math.min(1, Math.round((r.score + 0.03) * 1000) / 1000);
      out.sort((a, b) => b.score - a.score || (b.seeders ?? -1) - (a.seeders ?? -1) || a.title.localeCompare(b.title));
    }
    return out;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Group hits by info hash → magnet → normalized title, keeping every source. */
function dedupe(all: AggregatedHit[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const a of all) {
    const key = dedupeKey(a.hit);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, primary: a.hit, sources: [{ id: a.sourceId, name: a.sourceName }], maxSeeders: a.hit.seeders, maxLeechers: a.hit.leechers });
      continue;
    }
    if (!existing.sources.some((s) => s.id === a.sourceId)) existing.sources.push({ id: a.sourceId, name: a.sourceName });
    if (!existing.primary.infoHash && a.hit.infoHash) existing.primary = a.hit;
    else if (!existing.primary.magnet && a.hit.magnet) existing.primary = a.hit;
    if ((a.hit.seeders ?? -1) > (existing.maxSeeders ?? -1)) existing.maxSeeders = a.hit.seeders;
    if ((a.hit.leechers ?? -1) > (existing.maxLeechers ?? -1)) existing.maxLeechers = a.hit.leechers;
  }
  return groups;
}

function dedupeKey(h: IndexerHit): string {
  if (h.infoHash) return `hash:${h.infoHash}`;
  if (h.magnet) return `mag:${h.magnet}`;
  return `title:${normalize(h.title)}`;
}

/** Skip duplicate endpoints (same URL searched twice is wasted). */
function dedupeByUrl(rows: TorrentSourceRow[]): TorrentSourceRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

function cacheKey(target: DiscoveryTarget, limit: number, opts: DiscoveryOptions): string {
  return [
    target.scope,
    normalize(target.title),
    normalize(target.artist ?? ''),
    normalize(target.album ?? ''),
    target.year ?? '',
    limit,
    opts.preferredFormat ?? '',
    opts.minBitrateKbps ?? '',
    opts.prioritizeCached ? '1' : '0',
    opts.hideUncached ? '1' : '0',
  ].join('\u0000');
}

function dedupeErrors(errors: DiscoverResponseDto['errors']): DiscoverResponseDto['errors'] {
  const seen = new Set<string>();
  return errors.filter((e) => (seen.has(e.sourceId) ? false : (seen.add(e.sourceId), true)));
}

function errorMessage(err: unknown): string {
  const e = err as Error & { name?: string; message?: string };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Timed out';
  return e?.message?.split('\n')[0]?.slice(0, 200) ?? 'Unknown error';
}
