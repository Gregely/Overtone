/**
 * Small helpers shared by provider adapters. They turn transport problems
 * into ProviderErrors with user-presentable messages (never containing URLs,
 * keys or tokens).
 */
import { ProviderError } from './errors.js';
import type { ProviderContext } from './types.js';

export type RequestInitWithTimeout = RequestInit & { timeoutMs?: number; idempotent?: boolean };

/** ctx.fetch, but network failures/timeouts become ProviderError('unavailable'). */
export async function send(ctx: Pick<ProviderContext, 'fetch'>, url: string | URL, init: RequestInitWithTimeout, what: string): Promise<Response> {
  try {
    return await ctx.fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    const timeout = (err as Error).name === 'TimeoutError';
    throw new ProviderError('unavailable', `${what}: ${timeout ? 'timed out' : "couldn't reach the service"}`, { cause: err });
  }
}

/** Parse a JSON body; anything else (HTML error page, captive portal) is 'unavailable'. */
export async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError('unavailable', `${what}: unexpected response (HTTP ${res.status})`);
  }
}

/** Map HTTP 429 / 5xx when the body can't tell us more. */
export function httpError(res: Response, what: string): ProviderError {
  return ProviderError.fromStatus(res.status, what, res.headers.get('retry-after'));
}

/** application/x-www-form-urlencoded body from a flat record (arrays repeat the key). */
export function form(values: Record<string, string | number | ReadonlyArray<string | number> | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) body.append(k, String(x));
    else body.set(k, String(v));
  }
  return body;
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}
