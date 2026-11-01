import type { ProviderFetch, ProviderLogger } from '../providers/types.js';

export interface ProviderFetchOptions {
  userAgent: string;
  logger: ProviderLogger;
  /** Underlying fetch (injectable for tests). */
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
  /** Retries for 429/503/network errors on idempotent requests. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip query + credentials from a URL for logging. Query strings often carry API keys. */
export function urlForLog(input: string | URL): string {
  try {
    const u = new URL(String(input));
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
}

export function createProviderFetch(opts: ProviderFetchOptions): ProviderFetch {
  const base = opts.fetch ?? fetch;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? sleepReal;

  return async (input, init = {}) => {
    const { timeoutMs = opts.defaultTimeoutMs ?? 20_000, ...rest } = init;
    const method = (rest.method ?? 'GET').toUpperCase();
    const idempotent = method === 'GET' || method === 'HEAD';
    const headers = new Headers(rest.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', opts.userAgent);

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = rest.signal ? AbortSignal.any([rest.signal, timeout]) : timeout;
      const started = Date.now();
      try {
        const res = await base(input, { ...rest, headers, signal });
        opts.logger.debug('provider http', { method, url: urlForLog(input), status: res.status, ms: Date.now() - started });
        if (idempotent && attempt < retries && (res.status === 429 || res.status === 503)) {
          await res.body?.cancel();
          await sleep(retryDelay(res.headers.get('retry-after'), attempt));
          continue;
        }
        return res;
      } catch (err) {
        if (rest.signal?.aborted) throw err;
        const retryable = idempotent && attempt < retries;
        opts.logger.debug('provider http error', { method, url: urlForLog(input), error: (err as Error).name, retryable });
        if (!retryable) throw err;
        await sleep(retryDelay(null, attempt));
      }
    }
  };
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  const secs = Number(retryAfter);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 30_000);
  return 500 * 2 ** attempt;
}
