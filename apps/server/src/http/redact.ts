import type { ProviderLogger } from '../providers/types.js';

export interface BaseLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Wrap a pino-style logger for provider use. Any occurrence of a current
 * secret value in messages or data is replaced, as a last line of defence
 * against a provider accidentally logging a key.
 */
export function createRedactingLogger(base: BaseLogger, secrets: () => Iterable<string>): ProviderLogger {
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = value;
      for (const s of secrets()) if (s.length >= 4) out = out.split(s).join('[redacted]');
      return out;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    }
    return value;
  };
  const emit = (level: keyof BaseLogger) => (msg: string, data?: Record<string, unknown>) =>
    base[level]((scrub(data ?? {}) as object) ?? {}, scrub(msg) as string);
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

const TOKEN_PARAMS = /([?&](?:st|at|token|apikey|api_key|key|t|s|p)=)[^&#]*/gi;

/** Redact token-bearing query params from a request URL before logging. */
export function redactUrl(url: string): string {
  return url.replace(TOKEN_PARAMS, '$1[redacted]');
}
