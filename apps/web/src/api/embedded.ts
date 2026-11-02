/**
 * EmbeddedTransport: the ApiClient for standalone mode. Requests never leave
 * the device; they go to @overtone/core's in-process router, which runs the
 * same CoreApi the server runs. Results are passed through JSON, exactly like
 * an HTTP response, so the UI gets identical shapes (dates as strings, no
 * shared object references).
 */
import { ApiError as CoreApiError, LOCAL_USER, PROVIDER_ERROR_HTTP_STATUS, ProviderError, type EmbeddedRequest, type EmbeddedResponse } from '@overtone/core';
import type { CoverRef } from '@overtone/core';
import type { UserDto } from '@overtone/shared';
import { ApiError, withQuery, type ApiClient, type Reachability } from './client';

export interface EmbeddedTransportOptions {
  handle(req: EmbeddedRequest): Promise<EmbeddedResponse>;
  /**
   * A displayable URL for a cached blob (embedded album art), or null when
   * it isn't cached. Android: a WebView-served app file; browser: an object URL.
   */
  blobUrl?: (key: string) => string | null;
  coverArtArchive?: string;
}

const COVER_SIZES = [250, 500, 1200];

/**
 * Cover URLs in standalone mode are opaque API paths carrying what's needed
 * to show the image without a server: the release's MusicBrainz ids (shown
 * straight from the Cover Art Archive) or a marker that the embedded picture
 * is cached on the device. The UI appends `&size=N` and calls `url()`.
 */
export function embeddedCoverUrl(ref: CoverRef): string | null {
  if (ref.status === 'none') return null;
  const base = `/api/artwork/release/${ref.releaseId}?v=1`;
  if (ref.status === 'embedded') return `${base}&c=embedded`;
  if (ref.mbid) return `${base}&m=${encodeURIComponent(ref.mbid)}`;
  if (ref.releaseGroupMbid) return `${base}&g=${encodeURIComponent(ref.releaseGroupMbid)}`;
  return null;
}

export class EmbeddedTransport implements ApiClient {
  readonly mode = 'standalone' as const;
  readonly serverUrl = null;
  readonly user: UserDto = LOCAL_USER;
  readonly reachability: Reachability = 'ok';
  readonly #o: EmbeddedTransportOptions;

  constructor(opts: EmbeddedTransportOptions) {
    this.#o = opts;
  }

  subscribe(): () => void {
    // Nothing about the transport changes at runtime.
    return () => {};
  }

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined | null>, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', withQuery(path, query), { signal });
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body: body ?? {} });
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }
  delete<T = void>(path: string): Promise<T> {
    return this.request<T>('DELETE', path, {});
  }

  async request<T>(method: string, path: string, opts: { body?: unknown; signal?: AbortSignal }): Promise<T> {
    opts.signal?.throwIfAborted();
    // Serialize the body like fetch would (drops undefined, rejects cycles, copies).
    const body = opts.body === undefined ? undefined : (JSON.parse(JSON.stringify(opts.body)) as unknown);
    let res: EmbeddedResponse;
    try {
      res = await this.#o.handle({ method, path, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw toApiError(err);
    }
    if (res.status === 204 || res.body === undefined) return undefined as T;
    return JSON.parse(JSON.stringify(res.body)) as T;
  }

  url(path: string): string {
    if (/^(https?|content|file|blob|data):/.test(path)) return path;
    const art = /^\/api\/artwork\/release\/(\d+)\?(.*)$/.exec(path);
    if (art) {
      const q = new URLSearchParams(art[2]);
      const size = COVER_SIZES.includes(Number(q.get('size'))) ? Number(q.get('size')) : 500;
      const caa = this.#o.coverArtArchive ?? 'https://coverartarchive.org';
      if (q.get('c') === 'embedded') return this.#o.blobUrl?.(`artwork/${art[1]}-embedded`) ?? '';
      if (q.get('m')) return `${caa}/release/${q.get('m')}/front-${size}`;
      if (q.get('g')) return `${caa}/release-group/${q.get('g')}/front-${size}`;
    }
    return '';
  }
}

/** Same error envelope the server's error handler produces. */
function toApiError(err: unknown): unknown {
  if (err instanceof CoreApiError) return new ApiError(err.statusCode, err.code, err.message, err.fields);
  if (err instanceof ProviderError) return new ApiError(PROVIDER_ERROR_HTTP_STATUS[err.code], `provider_${err.code}`, err.message);
  if ((err as Error)?.name === 'AbortError') return err;
  console.error('[overtone] unexpected error', err);
  return new ApiError(500, 'internal', 'Something went wrong on this device. Try again.');
}
