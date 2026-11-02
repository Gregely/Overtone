/**
 * fetch() over CapacitorHttp: provider, MusicBrainz and artwork requests go
 * through Android's native HTTP stack, so CORS doesn't apply. Retry/backoff,
 * rate limits and the User-Agent stay in core (provider fetch layer and
 * MusicBrainz client), above this.
 *
 * Nothing here logs. Capacitor's own bridge logging is disabled in
 * capacitor.config.ts (loggingBehavior: 'none'), so request URLs and headers
 * (which can carry Subsonic tokens or API keys) never reach logcat.
 *
 * Limits: the whole response body is buffered (fine for API calls, artwork
 * and the 256 KB tag probe; audio is streamed by the native player, not
 * here); a request can't be cancelled mid-flight, so an aborted request is
 * abandoned and its result dropped.
 */
import { CapacitorHttp } from '@capacitor/core';
import { fromBase64 } from '@overtone/core';
import type { HttpFetch } from '@overtone/core';

const NULL_BODY = new Set([101, 204, 205, 304]);

export interface NativeFetchOptions {
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

export function createNativeFetch(opts: NativeFetchOptions = {}): HttpFetch {
  return async (input, init = {}) => {
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });

    let data: string | undefined;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') {
        data = init.body;
        headers['content-type'] ??= 'text/plain;charset=UTF-8';
      } else if (init.body instanceof URLSearchParams) {
        data = init.body.toString();
        headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
      } else {
        throw new TypeError('nativeFetch: only string and URLSearchParams bodies are supported');
      }
    }

    const request = CapacitorHttp.request({
      url,
      method,
      headers,
      ...(data !== undefined ? { data } : {}),
      responseType: 'arraybuffer',
      connectTimeout: opts.connectTimeoutMs ?? 15_000,
      readTimeout: opts.readTimeoutMs ?? 30_000,
      // Keep the URL exactly as built (providers already encode their query strings).
      shouldEncodeUrlParams: false,
    });

    let res;
    try {
      res = await (signal ? race(request, signal) : request);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      // Same shape as a browser/Node network failure, so retry logic and isTransient() apply.
      throw new TypeError('fetch failed', { cause: err });
    }

    const resHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers ?? {})) if (typeof v === 'string') resHeaders.set(k, v);
    let body: BodyInit | null = null;
    if (!NULL_BODY.has(res.status) && method !== 'HEAD') {
      if (res.data === null || res.data === undefined) body = '';
      else if (typeof res.data === 'string') {
        // With responseType 'arraybuffer', every non-JSON success body arrives as
        // base64; error bodies (HTTP >= 400) arrive as plain strings.
        body = res.status >= 400 ? res.data : (fromBase64(res.data) as BodyInit);
      } else body = JSON.stringify(res.data); // JSON bodies arrive already parsed
    }
    return new Response(body, { status: res.status, headers: resHeaders });
  };
}

function race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
