import type { Database } from '../../db/database.js';
import type { HttpFetch } from '../../platform/types.js';
import { mapRecording, mapRelease, mapReleaseRef } from './mapping.js';
import type { MbRecording, MbRelease, MbReleaseRef, MusicBrainzApi } from './types.js';

const DAY = 24 * 3600 * 1000;
const TTL = { entity: 30 * DAY, search: 7 * DAY, miss: 1 * DAY };

export interface MusicBrainzClientOptions {
  db: Database;
  userAgent: string;
  baseUrl?: string;
  fetch?: HttpFetch;
  /** Minimum gap between request starts. MusicBrainz allows 1/s per client. */
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class MusicBrainzError extends Error {
  override readonly name = 'MusicBrainzError';
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Serializes calls so request *starts* are at least `intervalMs` apart,
 * across every caller in the process.
 */
export class RateLimiter {
  #last = -Infinity;
  #chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.#last + this.intervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.#last = this.now();
      return fn();
    };
    const p = this.#chain.then(run, run);
    this.#chain = p.catch(() => undefined);
    return p;
  }
}

/**
 * MusicBrainz WS/2 client: proper User-Agent, global 1 req/s limit, retry
 * with backoff on 503, and an SQLite response cache (including misses).
 */
type ResolvedOptions = Required<MusicBrainzClientOptions>;

export class MusicBrainzClient implements MusicBrainzApi {
  readonly #o: ResolvedOptions;
  readonly #limiter: RateLimiter;
  /** Coalesce identical in-flight requests. */
  readonly #inflight = new Map<string, Promise<unknown>>();

  constructor(opts: MusicBrainzClientOptions) {
    this.#o = {
      baseUrl: 'https://musicbrainz.org/ws/2',
      minIntervalMs: 1100,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      fetch: (u, i) => globalThis.fetch(u, i),
      ...opts,
    };
    this.#limiter = new RateLimiter(this.#o.minIntervalMs, this.#o.now, this.#o.sleep);
  }

  async searchRecordings(query: string, limit = 15): Promise<MbRecording[]> {
    const body = await this.#get(`recording?query=${encodeURIComponent(query)}&limit=${limit}`, TTL.search);
    return ((body?.recordings as unknown[]) ?? []).map((r) => mapRecording(r as never));
  }

  async searchReleases(query: string, limit = 10): Promise<MbReleaseRef[]> {
    const body = await this.#get(`release?query=${encodeURIComponent(query)}&limit=${limit}`, TTL.search);
    return ((body?.releases as unknown[]) ?? []).map((r) => mapReleaseRef(r as never));
  }

  async getRelease(mbid: string): Promise<MbRelease | null> {
    const body = await this.#get(`release/${encodeURIComponent(mbid)}?inc=recordings+artist-credits+release-groups+media`, TTL.entity);
    return body ? mapRelease(body as never) : null;
  }

  async getRecording(mbid: string): Promise<MbRecording | null> {
    const body = await this.#get(
      `recording/${encodeURIComponent(mbid)}?inc=artist-credits+releases+release-groups+media`,
      TTL.entity,
    );
    return body ? mapRecording(body as never) : null;
  }

  /** Returns parsed JSON, or null for 404 (cached as a miss). Identical concurrent calls share one lookup. */
  async #get(pathAndQuery: string, ttl: number): Promise<Record<string, unknown> | null> {
    const key = pathAndQuery;
    const pending = this.#inflight.get(key);
    if (pending) return pending as Promise<Record<string, unknown> | null>;
    const p = this.#lookup(key, ttl);
    this.#inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.#inflight.delete(key);
    }
  }

  async #lookup(key: string, ttl: number): Promise<Record<string, unknown> | null> {
    const cached = await this.#o.db.get<{ status: number; body: string | null; expires_at: number }>(
      'SELECT status, body, expires_at FROM mb_cache WHERE key = ?',
      [key],
    );
    if (cached && cached.expires_at > this.#o.now()) {
      return cached.status === 200 && cached.body ? (JSON.parse(cached.body) as Record<string, unknown>) : null;
    }
    const { status, body } = await this.#fetchWithRetry(key);
    const now = this.#o.now();
    await this.#o.db.run(
      `INSERT INTO mb_cache (key, status, body, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET status = excluded.status, body = excluded.body,
         fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      [key, status, body, now, now + (status === 200 ? ttl : TTL.miss)],
    );
    return status === 200 && body ? (JSON.parse(body) as Record<string, unknown>) : null;
  }

  async #fetchWithRetry(pathAndQuery: string): Promise<{ status: number; body: string | null }> {
    const url = `${this.#o.baseUrl}/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}fmt=json`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.#limiter.schedule(() =>
        this.#o.fetch(url, {
          headers: { 'User-Agent': this.#o.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        }),
      );
      if (res.status === 200) return { status: 200, body: await res.text() };
      if (res.status === 404 || res.status === 400) {
        await res.body?.cancel();
        return { status: res.status, body: null };
      }
      await res.body?.cancel();
      if ((res.status === 503 || res.status === 429 || res.status >= 500) && attempt < 3) {
        await this.#o.sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new MusicBrainzError(res.status, `MusicBrainz returned HTTP ${res.status}`);
    }
  }
}

/** Escape a value for a Lucene phrase query. */
export function luceneEscape(s: string): string {
  return s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
}

export function mbUserAgent(version: string, contact: string): string {
  return `Overtone/${version} ( ${contact} )`;
}
