import type { ApiErrorDto, AuthStatusDto, AuthTokensDto, LoginRequestDto, UserDto } from '@overtone/shared';
import type { KeyValueStore } from '../platform/storage';

/** The server answered with an error envelope. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** The server could not be reached at all (offline, DNS, refused, timeout, CORS). */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

export type Reachability = 'ok' | 'unreachable';

interface StoredSession {
  serverUrl: string;
  tokens: AuthTokensDto;
}

export interface ApiClientOptions {
  storage: KeyValueStore;
  serverUrl: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** Serialize token refresh across tabs (Web Locks). Injectable for tests. */
  withLock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  timeoutMs?: number;
}

const SESSION_KEY = 'overtone.session';
const SERVER_KEY = 'overtone.serverUrl';
/** Refresh access tokens this long before they expire. */
const REFRESH_EARLY_MS = 60_000;

function defaultLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks ? (locks.request(name, fn) as Promise<T>) : fn();
}

type Listener = () => void;

/**
 * Thin, typed REST client.
 *
 * - Attaches the access token, refreshing it shortly before expiry or on a 401.
 * - Refresh tokens are single-use: refreshes are single-flight within a tab and
 *   serialized across tabs with a Web Lock, re-reading storage first so a
 *   token another tab already rotated is adopted rather than replayed (which
 *   the server would treat as theft and revoke the session).
 * - Distinguishes "server said no" (ApiError) from "couldn't reach it" (NetworkError).
 */
export class ApiClient {
  readonly #storage: KeyValueStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #withLock: NonNullable<ApiClientOptions['withLock']>;
  readonly #timeoutMs: number;
  #serverUrl: string | null;
  #tokens: AuthTokensDto | null = null;
  #refreshing: Promise<AuthTokensDto> | null = null;
  #reachability: Reachability = 'ok';
  readonly #listeners = new Set<Listener>();
  /** Called when the session is gone for good (refresh rejected). */
  onSessionExpired: (() => void) | null = null;

  constructor(opts: ApiClientOptions) {
    this.#storage = opts.storage;
    this.#serverUrl = opts.serverUrl;
    this.#fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.#now = opts.now ?? Date.now;
    this.#withLock = opts.withLock ?? defaultLock;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  // ── state ────────────────────────────────────────────────────────────────

  get serverUrl(): string | null {
    return this.#serverUrl;
  }
  get user(): UserDto | null {
    return this.#tokens?.user ?? null;
  }
  get reachability(): Reachability {
    return this.#reachability;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  #emit(): void {
    for (const fn of this.#listeners) fn();
  }
  #setReachability(r: Reachability): void {
    if (r !== this.#reachability) {
      this.#reachability = r;
      this.#emit();
    }
  }

  /** Load the saved server URL + session. Returns the server URL in effect. */
  async restore(defaultServer: string | null): Promise<string | null> {
    this.#serverUrl = (await this.#storage.get(SERVER_KEY)) ?? defaultServer;
    this.#tokens = await this.#readStoredTokens();
    this.#emit();
    return this.#serverUrl;
  }

  async setServerUrl(url: string): Promise<void> {
    if (url === this.#serverUrl) return;
    this.#serverUrl = url;
    this.#tokens = null; // tokens belong to a server
    await this.#storage.set(SERVER_KEY, url);
    await this.#storage.remove(SESSION_KEY);
    this.#reachability = 'ok';
    this.#emit();
  }

  /** Absolute URL for a server path (stream/artwork URLs come back relative). */
  url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    if (!this.#serverUrl) throw new NetworkError('No server configured');
    return `${this.#serverUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  // ── auth ─────────────────────────────────────────────────────────────────

  status(serverUrl?: string): Promise<AuthStatusDto> {
    return this.#raw<AuthStatusDto>('GET', '/api/auth/status', { base: serverUrl });
  }

  async login(body: LoginRequestDto): Promise<UserDto> {
    return this.#adopt(await this.#raw<AuthTokensDto>('POST', '/api/auth/login', { body }));
  }

  async setup(body: LoginRequestDto): Promise<UserDto> {
    return this.#adopt(await this.#raw<AuthTokensDto>('POST', '/api/auth/setup', { body }));
  }

  async logout(): Promise<void> {
    const t = this.#tokens;
    await this.#clearSession();
    if (t) await this.#raw('POST', '/api/auth/logout', { body: { refreshToken: t.refreshToken } }).catch(() => undefined);
  }

  hasSession(): boolean {
    return this.#tokens !== null;
  }

  async #adopt(tokens: AuthTokensDto): Promise<UserDto> {
    this.#tokens = tokens;
    await this.#storage.set(SESSION_KEY, JSON.stringify({ serverUrl: this.#serverUrl ?? "", tokens } satisfies StoredSession));
    this.#emit();
    return tokens.user;
  }

  async #clearSession(): Promise<void> {
    this.#tokens = null;
    await this.#storage.remove(SESSION_KEY);
    this.#emit();
  }

  async #readStoredTokens(): Promise<AuthTokensDto | null> {
    try {
      const raw = await this.#storage.get(SESSION_KEY);
      const s = raw ? (JSON.parse(raw) as StoredSession) : null;
      return s && s.serverUrl === this.#serverUrl ? s.tokens : null;
    } catch {
      return null;
    }
  }

  #fresh(t: AuthTokensDto | null): t is AuthTokensDto {
    return Boolean(t) && Date.parse(t!.accessTokenExpiresAt) - this.#now() > REFRESH_EARLY_MS;
  }

  async #accessToken(): Promise<string> {
    if (this.#fresh(this.#tokens)) return this.#tokens.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Rotate tokens (single-flight, cross-tab safe). */
  refresh(): Promise<AuthTokensDto> {
    this.#refreshing ??= this.#withLock('overtone-refresh', () => this.#doRefresh()).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<AuthTokensDto> {
    // Another tab may have rotated while we waited for the lock.
    const stored = await this.#readStoredTokens();
    if (stored && stored.refreshToken !== this.#tokens?.refreshToken) {
      this.#tokens = stored;
      if (this.#fresh(stored)) return stored;
    }
    const current = this.#tokens;
    if (!current) throw new ApiError(401, 'unauthorized', 'Not signed in');
    try {
      const next = await this.#raw<AuthTokensDto>('POST', '/api/auth/refresh', { body: { refreshToken: current.refreshToken } });
      await this.#adopt(next);
      return next;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        if (err.code === 'refresh_race') {
          const again = await this.#readStoredTokens();
          if (again && again.refreshToken !== current.refreshToken) {
            this.#tokens = again;
            return again;
          }
        }
        await this.#clearSession();
        this.onSessionExpired?.();
      }
      throw err;
    }
  }

  // ── requests ─────────────────────────────────────────────────────────────

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined | null>, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', withQuery(path, query), { signal });
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body: body ?? {} });
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }
  delete<T = void>(path: string): Promise<T> {
    return this.request<T>('DELETE', path, {});
  }

  /** Authenticated request with one transparent retry after refreshing on 401. */
  async request<T>(method: string, path: string, opts: { body?: unknown; signal?: AbortSignal }): Promise<T> {
    const token = await this.#accessToken();
    try {
      return await this.#raw<T>(method, path, { ...opts, token });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.code === 'invalid_access_token') {
        const fresh = await this.refresh();
        return this.#raw<T>(method, path, { ...opts, token: fresh.accessToken });
      }
      throw err;
    }
  }

  async #raw<T>(method: string, path: string, opts: { body?: unknown; token?: string; signal?: AbortSignal; base?: string } = {}): Promise<T> {
    const base = opts.base ?? this.#serverUrl;
    if (!base) throw new NetworkError('No server configured');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(`${base}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (!opts.base) this.#setReachability('unreachable');
      throw new NetworkError(`Can't reach ${base}`);
    }
    if (!opts.base) this.#setReachability('ok');
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A proxy/captive portal answered with HTML: that's not our server.
      throw new NetworkError(`${base} did not respond like an Overtone server`);
    }
    if (!res.ok) {
      const e = (body as ApiErrorDto | null)?.error;
      throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `HTTP ${res.status}`, e?.fields);
    }
    return body as T;
  }
}

export function withQuery(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
