import type { ResolvedStream, SourceProvider } from './types.js';

export interface ResolveCacheOptions {
  /** Re-resolve this long before `expiresAt`, so a track never starts on a dying link. */
  refreshMarginMs?: number;
  /** Lifetime for resolutions without `expiresAt`. 0 disables caching them. */
  defaultTtlMs?: number;
  /** Max cached entries (LRU eviction). */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  stream: ResolvedStream;
  /** Epoch ms after which the entry must not be used. */
  usableUntil: number;
}

/**
 * Caches provider.resolveStream() per (sourceId, fileId) and implements the
 * contract around ResolvedStream.expiresAt:
 *
 *  - entries are reused until `refreshMarginMs` before they expire
 *  - concurrent resolves for the same file share one in-flight request
 *  - `invalidate()` + `forceRefresh` handle links that die early upstream
 *    (the streaming layer calls this on 401/403/404/410 and retries once)
 *
 * `file://` resolutions (LocalFolder) never expire and are cheap; they're
 * cached with the default TTL like anything else.
 */
export class ResolveCache {
  readonly #entries = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<ResolvedStream>>();
  readonly #refreshMarginMs: number;
  readonly #defaultTtlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(opts: ResolveCacheOptions = {}) {
    this.#refreshMarginMs = opts.refreshMarginMs ?? 5 * 60 * 1000;
    this.#defaultTtlMs = opts.defaultTtlMs ?? 10 * 60 * 1000;
    this.#maxEntries = opts.maxEntries ?? 1000;
    this.#now = opts.now ?? Date.now;
  }

  async resolve(
    sourceId: string,
    provider: SourceProvider,
    fileId: string,
    opts: { signal: AbortSignal; forceRefresh?: boolean },
  ): Promise<ResolvedStream> {
    const key = cacheKey(sourceId, fileId);

    if (!opts.forceRefresh) {
      const hit = this.#entries.get(key);
      if (hit && hit.usableUntil > this.#now()) {
        // Refresh LRU position.
        this.#entries.delete(key);
        this.#entries.set(key, hit);
        return hit.stream;
      }
      const pending = this.#inflight.get(key);
      if (pending) return pending;
    }

    this.#entries.delete(key);
    const promise = provider
      .resolveStream(fileId, { signal: opts.signal, ...(opts.forceRefresh ? { forceRefresh: true } : {}) })
      .then((stream) => {
        this.#store(key, stream);
        return stream;
      })
      .finally(() => {
        if (this.#inflight.get(key) === promise) this.#inflight.delete(key);
      });
    this.#inflight.set(key, promise);
    return promise;
  }

  invalidate(sourceId: string, fileId?: string): void {
    if (fileId !== undefined) {
      this.#entries.delete(cacheKey(sourceId, fileId));
      return;
    }
    const prefix = `${sourceId}\u0000`;
    for (const k of this.#entries.keys()) if (k.startsWith(prefix)) this.#entries.delete(k);
  }

  get size(): number {
    return this.#entries.size;
  }

  #store(key: string, stream: ResolvedStream): void {
    const now = this.#now();
    const usableUntil = stream.expiresAt
      ? stream.expiresAt.getTime() - this.#refreshMarginMs
      : now + this.#defaultTtlMs;
    if (usableUntil <= now) return; // too short-lived to be worth caching
    this.#entries.set(key, { stream, usableUntil });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

function cacheKey(sourceId: string, fileId: string): string {
  return `${sourceId}\u0000${fileId}`;
}
