import type { ProviderLogger } from './providers/types.js';

export interface BaseLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** A pino-compatible logger with child loggers (the server passes pino). */
export interface Logger extends BaseLogger {
  child(bindings: object): Logger;
}

/** Logger that drops everything. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};

/**
 * Console logger for standalone mode. Debug lines are dropped unless
 * `debug` is set. Messages and data are expected to be credential-free
 * already (provider loggers redact, and the fetch layer strips query strings).
 */
export function consoleLogger(opts: { debug?: boolean; bindings?: object } = {}): Logger {
  const line = (level: 'debug' | 'info' | 'warn' | 'error') => (obj: object, msg?: string) => {
    if (level === 'debug' && !opts.debug) return;
    const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    fn(`[overtone] ${msg ?? ''}`, { ...(opts.bindings ?? {}), ...obj });
  };
  return {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
    child: (b) => consoleLogger({ ...opts, bindings: { ...(opts.bindings ?? {}), ...b } }),
  };
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
