/**
 * DebridService — retrieval operations for "Find sources".
 *
 * Lists connected debrid providers (music sources with category "debrid") and
 * exposes their optional check-cached / add-magnet / get-status capabilities.
 * Providers without retrieval support (e.g. Real-Debrid, Premiumize today) are
 * reported as `unavailable` so the UI can grey them out.
 *
 * Cache checks are cached briefly per (source, torrent) and never throw: a
 * provider failure surfaces as an `unknown` status, never a failed search.
 */
import type { BaseLogger } from '../../logging.js';
import type { Clock } from '../../platform/types.js';
import { ProviderError } from '../errors.js';
import type { ProviderRegistry } from '../registry.js';
import type { SourceManager } from '../../sources/manager.js';
import { DebridSourceProvider } from './index.js';
import { isMagnetUri } from './magnet.js';
import type { DebridAdapter, DebridAddResult, DebridCachedResult, DebridTorrentRef, DebridTorrentStatus } from './types.js';

export type CachedStatus = 'cached' | 'uncached' | 'unavailable' | 'unknown';

export interface DebridProviderInfo {
  sourceId: string;
  name: string;
  providerId: string;
  /** Whether the provider supports retrieval (check-cached / add-magnet). */
  retrieval: boolean;
}

export interface DebridCachedStatus {
  providerId: string;
  providerName: string;
  status: CachedStatus;
}

export interface DebridServiceDeps {
  sources: SourceManager;
  registry: ProviderRegistry;
  logger: BaseLogger;
  clock?: Clock;
  /** TTL for cached-availability responses. */
  cacheTtlMs?: number;
}

export class DebridService {
  readonly #d: Required<Omit<DebridServiceDeps, 'sources' | 'registry' | 'logger' | 'clock'>> & DebridServiceDeps;
  readonly #cache = new Map<string, { at: number; value: DebridCachedResult }>();

  constructor(deps: DebridServiceDeps) {
    this.#d = { cacheTtlMs: 5 * 60_000, ...deps };
  }

  #now(): number {
    return this.#d.clock?.now() ?? Date.now();
  }

  /** Connected debrid providers, with their retrieval capability. */
  async listProviders(): Promise<DebridProviderInfo[]> {
    const rows = await this.#d.sources.list();
    const out: DebridProviderInfo[] = [];
    for (const r of rows) {
      const manifest = this.#d.registry.get(r.provider_id)?.manifest;
      if (manifest?.category !== 'debrid') continue;
      out.push({ sourceId: r.id, name: r.name, providerId: r.provider_id, retrieval: Boolean(manifest.capabilities?.retrieval) });
    }
    return out;
  }

  async #adapter(sourceId: string): Promise<DebridAdapter> {
    const provider = await this.#d.sources.instance(sourceId);
    if (!(provider instanceof DebridSourceProvider)) throw new ProviderError('config', 'Not a debrid source');
    return provider.adapter;
  }

  /** Cached availability across connected debrid providers. Never throws. */
  async checkCached(ref: DebridTorrentRef, sourceIds?: string[]): Promise<DebridCachedStatus[]> {
    const providers = await this.listProviders();
    const targets = sourceIds ? providers.filter((p) => sourceIds.includes(p.sourceId)) : providers;
    return Promise.all(
      targets.map(async (p): Promise<DebridCachedStatus> => {
        if (!p.retrieval) return { providerId: p.sourceId, providerName: p.name, status: 'unavailable' };
        try {
          const adapter = await this.#adapter(p.sourceId);
          if (!adapter.checkCached) return { providerId: p.sourceId, providerName: p.name, status: 'unavailable' };
          const result = await this.#cached(p.sourceId, ref, adapter);
          if (result.unknown) return { providerId: p.sourceId, providerName: p.name, status: 'unknown' };
          return { providerId: p.sourceId, providerName: p.name, status: result.cached ? 'cached' : 'uncached' };
        } catch {
          return { providerId: p.sourceId, providerName: p.name, status: 'unknown' };
        }
      }),
    );
  }

  async #cached(sourceId: string, ref: DebridTorrentRef, adapter: DebridAdapter): Promise<DebridCachedResult> {
    const key = `${sourceId}\u0000${ref.infoHash ?? ''}\u0000${ref.magnet ?? ''}`;
    const hit = this.#cache.get(key);
    if (hit && this.#now() - hit.at < this.#d.cacheTtlMs) return hit.value;
    const value = await adapter.checkCached!(ref, { signal: AbortSignal.timeout(10_000) });
    this.#cache.set(key, { at: this.#now(), value });
    return value;
  }

  async addMagnet(sourceId: string, magnet: string): Promise<DebridAddResult> {
    if (!isMagnetUri(magnet)) throw new ProviderError('config', 'Not a valid magnet link');
    const adapter = await this.#adapter(sourceId);
    if (!adapter.addMagnet) throw new ProviderError('config', 'This provider does not support adding magnets');
    return adapter.addMagnet(magnet, { signal: AbortSignal.timeout(30_000) });
  }

  async getStatus(sourceId: string, id: string): Promise<DebridTorrentStatus> {
    const adapter = await this.#adapter(sourceId);
    if (!adapter.getStatus) throw new ProviderError('config', 'This provider does not support status checks');
    return adapter.getStatus(id, { signal: AbortSignal.timeout(20_000) });
  }
}
