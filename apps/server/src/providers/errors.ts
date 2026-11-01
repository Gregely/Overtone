/**
 * Errors thrown by providers. The API layer maps `code` to an HTTP status and
 * a user-facing message; `message` must never contain secrets (API keys,
 * tokens, signed URLs). Put diagnostic detail in `cause`, which is logged
 * through the redacting logger, never returned to clients.
 */

export type ProviderErrorCode =
  /** Credentials missing, invalid, or revoked. User must fix config. */
  | 'auth'
  /** The file (or the account item containing it) no longer exists. */
  | 'not_found'
  /** Upstream asked us to slow down. `retryAfterMs` may be set. */
  | 'rate_limited'
  /** Upstream down / network error / timeout. Retryable. */
  | 'unavailable'
  /** Config is valid per schema but wrong for this service (bad path, etc.). */
  | 'config'
  /** A previously resolved link expired; caller should re-resolve. */
  | 'expired'
  /** Account lacks a subscription/premium needed for streaming. */
  | 'subscription';

export const PROVIDER_ERROR_HTTP_STATUS: Readonly<Record<ProviderErrorCode, number>> = {
  auth: 502,
  not_found: 404,
  rate_limited: 503,
  unavailable: 502,
  config: 422,
  expired: 502,
  subscription: 402,
};

export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message, { cause: options.cause });
  }

  get retryable(): boolean {
    return this.code === 'unavailable' || this.code === 'rate_limited' || this.code === 'expired';
  }

  /**
   * Map an upstream HTTP status to a ProviderError. `what` describes the
   * operation for the message ("list torrents"); it must not contain secrets.
   */
  static fromStatus(status: number, what: string, retryAfterHeader?: string | null): ProviderError {
    if (status === 401 || status === 403) return new ProviderError('auth', `${what}: authentication failed`);
    if (status === 404 || status === 410) return new ProviderError('not_found', `${what}: not found`);
    if (status === 429) {
      const secs = Number(retryAfterHeader);
      return new ProviderError('rate_limited', `${what}: rate limited`, {
        retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined,
      });
    }
    return new ProviderError('unavailable', `${what}: upstream returned HTTP ${status}`);
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/** Placeholder thrown by providers scheduled for a later build stage. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  constructor(what: string, stage: number) {
    super(`${what} is not implemented yet (planned for stage ${stage})`);
  }
}
