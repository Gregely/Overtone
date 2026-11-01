/**
 * Real-Debrid adapter: lists audio files already in the user's account
 * (finished torrents and existing downloads) and resolves them to direct
 * links. Read-only: never adds torrents/magnets/links and never unrestricts a
 * link that isn't already part of an item in the account.
 *
 * API docs: https://api.real-debrid.com/ (REST 1.0 + OAuth2 device flow for
 * open-source apps). Checked 2026-11-01.
 *  - Base https://api.real-debrid.com/rest/1.0, `Authorization: Bearer <token>`
 *  - 250 requests/minute; excess → HTTP 429
 *  - Errors: HTTP 401 bad token (expired/invalid), 403 permission denied /
 *    account locked, 404 unknown resource, 503 unavailable; JSON body
 *    `{ error, error_code }`
 *  - GET /user → { username, type: 'premium'|'free', premium (s), expiration }
 *  - GET /torrents?page&limit (≤5000, X-Total-Count) → [{ id, filename, status, links, added, ended }]
 *  - GET /torrents/info/{id} → { files: [{ id, path, bytes, selected }], links: [...] }
 *    (the docs don't specify the links↔files mapping; links follow the
 *    selected files in order, which we verify by filename after resolving)
 *  - POST /unrestrict/link (link) → { filename, filesize, mimeType, download }
 *  - GET /downloads?page&limit → [{ id, filename, filesize, link, download, generated }]
 *  - OAuth device flow (client_id X245A4XAIBGVM for open-source apps):
 *    GET /oauth/v2/device/code?client_id&new_credentials=yes
 *      → { device_code, user_code, interval, expires_in, verification_url }
 *    GET /oauth/v2/device/credentials?client_id&code=device_code
 *      → errors until approved, then { client_id, client_secret }
 *    POST /oauth/v2/token (client_id, client_secret, code, grant_type=
 *      http://oauth.net/grant_type/device/1.0) → { access_token, expires_in, refresh_token }
 *    Refresh: same endpoint with code=refresh_token.
 */
import { ProviderError } from '../../../errors.js';
import { basename, form, readJson, send } from '../../../http.js';
import type { CallOptions, DeviceFlowContext, DeviceFlowHandler, ProviderContext, ResolveOptions } from '../../../types.js';
import type { DebridAccountInfo, DebridAdapter, DebridAdapterDefinition, DebridCredentials, DebridFile, DebridResolvedLink } from '../../types.js';

export const RD_OPEN_SOURCE_CLIENT_ID = 'X245A4XAIBGVM';
const DEVICE_GRANT = 'http://oauth.net/grant_type/device/1.0';
const PAGE = 1000;

export interface RealDebridOptions {
  apiBase?: string;
  oauthBase?: string;
  now?: () => number;
}

interface RdTorrent {
  id: string;
  filename: string;
  status: string;
  links: string[];
  added?: string;
  ended?: string;
}
interface RdTorrentInfo extends RdTorrent {
  files: Array<{ id: number; path: string; bytes: number; selected: number }>;
}
interface RdDownload {
  id: string;
  filename: string;
  filesize: number;
  link: string;
  download: string;
  generated?: string;
}

const MANAGED = ['clientId', 'clientSecret', 'accessToken', 'refreshToken', 'accessTokenExpiresAt'] as const;

export function createRealDebridAdapter(opts: RealDebridOptions = {}): DebridAdapterDefinition {
  const apiBase = opts.apiBase ?? 'https://api.real-debrid.com/rest/1.0';
  const oauthBase = opts.oauthBase ?? 'https://api.real-debrid.com/oauth/v2';
  const now = opts.now ?? Date.now;
  return {
    id: 'real-debrid',
    name: 'Real-Debrid',
    apiKeyUrl: 'https://real-debrid.com/apitoken',
    managedSecrets: MANAGED,
    deviceFlow: realDebridDeviceFlow(oauthBase, now),
    deviceLoginHelp: 'Opens real-debrid.com/device, where you enter the code shown. Overtone gets its own revocable access, not your password.',
    create: (credentials, ctx) => new RealDebridAdapter(credentials, ctx, { apiBase, oauthBase, now }),
  };
}

export const realDebridAdapter = createRealDebridAdapter();

class RealDebridAdapter implements DebridAdapter {
  readonly #ctx: ProviderContext;
  readonly #o: Required<RealDebridOptions>;
  #creds: Record<string, string>;
  #refreshing: Promise<string> | null = null;

  constructor(credentials: DebridCredentials, ctx: ProviderContext, o: Required<RealDebridOptions>) {
    this.#creds = { ...credentials };
    this.#ctx = ctx;
    this.#o = o;
  }

  // ── auth ─────────────────────────────────────────────────────────────────

  get #oauth(): boolean {
    return !this.#creds.apiKey && Boolean(this.#creds.refreshToken);
  }

  async #token(signal: AbortSignal): Promise<string> {
    if (this.#creds.apiKey) return this.#creds.apiKey;
    const exp = Date.parse(this.#creds.accessTokenExpiresAt ?? '');
    if (this.#creds.accessToken && Number.isFinite(exp) && exp - this.#o.now() > 60_000) return this.#creds.accessToken;
    if (!this.#oauth) throw new ProviderError('auth', 'Real-Debrid: not signed in');
    return this.#refresh(signal);
  }

  /** OAuth access tokens expire (~1 h); refresh with the stored client credentials. */
  #refresh(signal: AbortSignal): Promise<string> {
    this.#refreshing ??= (async () => {
      const res = await send(
        this.#ctx,
        `${this.#o.oauthBase}/token`,
        {
          method: 'POST',
          body: form({ client_id: this.#creds.clientId, client_secret: this.#creds.clientSecret, code: this.#creds.refreshToken, grant_type: DEVICE_GRANT }),
          signal,
        },
        'Real-Debrid sign-in',
      );
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        throw new ProviderError('auth', 'Real-Debrid: your login expired or was revoked. Log in again in Settings › Sources.');
      }
      if (!res.ok) throw await this.#error(res, 'Real-Debrid sign-in');
      const t = await readJson<{ access_token: string; expires_in: number; refresh_token?: string }>(res, 'Real-Debrid sign-in');
      const patch: Record<string, string> = {
        accessToken: t.access_token,
        accessTokenExpiresAt: new Date(this.#o.now() + t.expires_in * 1000).toISOString(),
        ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      };
      this.#creds = { ...this.#creds, ...patch };
      await this.#ctx.updateSecrets(patch);
      return t.access_token;
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  async #call<T>(path: string, what: string, opts: { signal: AbortSignal; method?: string; body?: URLSearchParams }, retried = false): Promise<{ data: T; res: Response }> {
    const token = await this.#token(opts.signal);
    const res = await send(
      this.#ctx,
      `${this.#o.apiBase}${path}`,
      {
        method: opts.method ?? 'GET',
        headers: { authorization: `Bearer ${token}` },
        ...(opts.body ? { body: opts.body } : {}),
        signal: opts.signal,
        idempotent: true, // only read-only calls and /unrestrict/link on the account's own links
      },
      what,
    );
    if (res.status === 401 && this.#oauth && !retried) {
      await res.body?.cancel();
      this.#creds.accessTokenExpiresAt = '';
      return this.#call<T>(path, what, opts, true);
    }
    if (!res.ok) throw await this.#error(res, what);
    if (res.status === 204) return { data: undefined as T, res };
    return { data: await readJson<T>(res, what), res };
  }

  async #error(res: Response, what: string): Promise<ProviderError> {
    let code: number | undefined;
    try {
      code = ((await res.json()) as { error_code?: number }).error_code;
    } catch {
      /* no JSON body */
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.status === 429 || code === 34 || code === 5) {
      return new ProviderError('rate_limited', `${what}: Real-Debrid rate limit reached`, retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {});
    }
    if (res.status === 401 || code === 8) {
      return new ProviderError('auth', `${what}: Real-Debrid rejected the credentials (expired or invalid). Log in again or paste a new API key.`);
    }
    if (code === 14 || code === 9 || res.status === 403) return new ProviderError('auth', `${what}: Real-Debrid denied access (account locked or permission denied)`);
    if (code === 20 || code === 23 || code === 36) return new ProviderError('subscription', `${what}: this needs an active Real-Debrid premium plan`);
    if (res.status === 404 || code === 7 || code === 24 || code === 35) return new ProviderError('not_found', `${what}: file is no longer available in your Real-Debrid account`);
    return new ProviderError('unavailable', `${what}: Real-Debrid returned HTTP ${res.status}${code !== undefined ? ` (code ${code})` : ''}`);
  }

  // ── adapter ──────────────────────────────────────────────────────────────

  async testConnection({ signal }: CallOptions): Promise<DebridAccountInfo> {
    const { data: u } = await this.#call<{ username: string; type: string; expiration?: string }>('/user', 'Check account', { signal });
    const premium = u.type === 'premium';
    return {
      username: u.username,
      premium,
      plan: premium ? 'Premium' : 'Free',
      ...(premium && u.expiration ? { premiumUntil: new Date(u.expiration) } : {}),
    };
  }

  async *listFiles({ signal }: CallOptions): AsyncIterable<DebridFile> {
    const torrentLinks = new Set<string>();
    for await (const t of this.#paged<RdTorrent>('/torrents', 'List torrents', signal)) {
      for (const l of t.links ?? []) torrentLinks.add(l);
      if (t.status !== 'downloaded') continue;
      const info = await this.#torrentInfo(t, signal, false);
      for (const { file, link } of mapFilesToLinks(info)) {
        if (!link) continue;
        const name = basename(file.path);
        yield {
          id: `t:${t.id}:${file.id}`,
          name,
          path: `${t.filename}${file.path.startsWith('/') ? '' : '/'}${file.path}`,
          size: file.bytes,
          ...(t.ended ? { modifiedAt: new Date(t.ended) } : t.added ? { modifiedAt: new Date(t.added) } : {}),
        };
      }
    }
    // Existing unrestricted downloads (links the user already generated), minus torrent duplicates.
    for await (const d of this.#paged<RdDownload>('/downloads', 'List downloads', signal)) {
      if (torrentLinks.has(d.link)) continue;
      yield {
        id: `d:${d.id}`,
        name: d.filename,
        path: `Downloads/${d.filename}`,
        size: d.filesize,
        ...(d.generated ? { modifiedAt: new Date(d.generated) } : {}),
      };
    }
  }

  async *#paged<T>(path: string, what: string, signal: AbortSignal): AsyncIterable<T> {
    for (let page = 1; ; page++) {
      const { data, res } = await this.#call<T[] | undefined>(`${path}?page=${page}&limit=${PAGE}`, what, { signal });
      const items = data ?? [];
      yield* items;
      const total = Number(res.headers.get('x-total-count'));
      if (items.length < PAGE || (Number.isFinite(total) && page * PAGE >= total)) return;
    }
  }

  /** Torrent contents don't change once downloaded: cache per torrent id. */
  async #torrentInfo(t: Pick<RdTorrent, 'id'> & Partial<RdTorrent>, signal: AbortSignal, force: boolean): Promise<RdTorrentInfo> {
    const key = `rd:torrent:${t.id}`;
    const cached = this.#ctx.state.get<RdTorrentInfo>(key);
    if (!force && cached && (!t.ended || cached.ended === t.ended)) return cached;
    const { data } = await this.#call<RdTorrentInfo>(`/torrents/info/${encodeURIComponent(t.id)}`, 'Read torrent', { signal });
    const slim: RdTorrentInfo = {
      id: data.id,
      filename: data.filename,
      status: data.status,
      links: data.links ?? [],
      ...(data.ended ? { ended: data.ended } : {}),
      files: (data.files ?? []).map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, selected: f.selected })),
    };
    this.#ctx.state.set(key, slim);
    return slim;
  }

  async resolveLink(fileId: string, opts: ResolveOptions): Promise<DebridResolvedLink> {
    const { signal } = opts;
    const [kind, a, b] = fileId.split(':');
    if (kind === 't' && a && b) {
      const info = await this.#torrentInfo({ id: a }, signal, Boolean(opts.forceRefresh));
      const entry = mapFilesToLinks(info).find((x) => String(x.file.id) === b);
      if (!entry?.link) throw new ProviderError('not_found', 'File is no longer in this Real-Debrid torrent');
      const link = await this.#unrestrict(entry.link, signal);
      // Guard against a links↔files mapping drift: never play the wrong file.
      if (link.filename && basename(entry.file.path).toLowerCase() !== link.filename.toLowerCase()) {
        this.#ctx.state.delete(`rd:torrent:${a}`);
        throw new ProviderError('not_found', 'Real-Debrid returned a different file than expected; rescan this source');
      }
      return link.resolved;
    }
    if (kind === 'd' && a) {
      for await (const d of this.#paged<RdDownload>('/downloads', 'List downloads', signal)) {
        if (d.id === a) return (await this.#unrestrict(d.link, signal)).resolved;
      }
      throw new ProviderError('not_found', 'Download was removed from your Real-Debrid account');
    }
    throw new ProviderError('not_found', 'Unknown Real-Debrid file');
  }

  /** Only ever called with links taken from the user's own torrents/downloads. */
  async #unrestrict(link: string, signal: AbortSignal): Promise<{ filename: string | undefined; resolved: DebridResolvedLink }> {
    const { data } = await this.#call<{ download: string; filename?: string; filesize?: number; mimeType?: string }>('/unrestrict/link', 'Get stream link', {
      signal,
      method: 'POST',
      body: form({ link }),
    });
    if (!data?.download) throw new ProviderError('unavailable', 'Real-Debrid did not return a download link');
    return {
      filename: data.filename,
      resolved: {
        url: data.download,
        ...(data.filesize ? { size: data.filesize } : {}),
        ...(data.mimeType && data.mimeType.startsWith('audio/') ? { mimeType: data.mimeType } : {}),
      },
    };
  }
}

/** Selected files in order ↔ links in order (only when the counts agree). */
export function mapFilesToLinks(info: RdTorrentInfo): Array<{ file: RdTorrentInfo['files'][number]; link: string | undefined }> {
  const selected = (info.files ?? []).filter((f) => f.selected === 1).sort((x, y) => x.id - y.id);
  const links = info.links ?? [];
  if (links.length !== selected.length) return selected.map((file) => ({ file, link: undefined })); // archived/split torrent
  return selected.map((file, i) => ({ file, link: links[i] }));
}

// ── Device flow ─────────────────────────────────────────────────────────────

function realDebridDeviceFlow(oauthBase: string, now: () => number): DeviceFlowHandler {
  return {
    async start(ctx: DeviceFlowContext) {
      const res = await send(
        ctx,
        `${oauthBase}/device/code?client_id=${RD_OPEN_SOURCE_CLIENT_ID}&new_credentials=yes`,
        { signal: ctx.signal },
        'Real-Debrid login',
      );
      if (!res.ok) throw new ProviderError('unavailable', `Real-Debrid login: HTTP ${res.status}`);
      const d = await readJson<{ device_code: string; user_code: string; interval: number; expires_in: number; verification_url: string; direct_verification_url?: string }>(
        res,
        'Real-Debrid login',
      );
      return {
        handle: d.device_code,
        userCode: d.user_code,
        verificationUrl: d.verification_url,
        ...(d.direct_verification_url ? { verificationUrlComplete: d.direct_verification_url } : {}),
        expiresAt: new Date(now() + d.expires_in * 1000),
        intervalSeconds: Math.max(1, d.interval || 5),
      };
    },
    async poll(deviceCode: string, ctx: DeviceFlowContext) {
      const cred = await send(
        ctx,
        `${oauthBase}/device/credentials?client_id=${RD_OPEN_SOURCE_CLIENT_ID}&code=${encodeURIComponent(deviceCode)}`,
        { signal: ctx.signal },
        'Real-Debrid login',
      );
      if (!cred.ok) {
        // Errors until the user approves; the flow's own expiry ends polling.
        await cred.body?.cancel();
        return { status: 'pending' };
      }
      const c = await readJson<{ client_id: string; client_secret: string }>(cred, 'Real-Debrid login');
      const tok = await send(
        ctx,
        `${oauthBase}/token`,
        { method: 'POST', body: form({ client_id: c.client_id, client_secret: c.client_secret, code: deviceCode, grant_type: DEVICE_GRANT }), signal: ctx.signal },
        'Real-Debrid login',
      );
      if (!tok.ok) {
        await tok.body?.cancel();
        return { status: 'denied' };
      }
      const t = await readJson<{ access_token: string; expires_in: number; refresh_token: string }>(tok, 'Real-Debrid login');
      return {
        status: 'complete',
        secrets: {
          clientId: c.client_id,
          clientSecret: c.client_secret,
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          accessTokenExpiresAt: new Date(now() + t.expires_in * 1000).toISOString(),
        },
      };
    },
  };
}
