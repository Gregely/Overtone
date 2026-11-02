/**
 * TorBox adapter: lists audio files already in the user's account (finished
 * torrents, usenet downloads and web downloads) and requests direct links on
 * demand. Read-only: never creates torrents / usenet / web downloads.
 *
 * API docs: https://api-docs.torbox.app/ (Postman collection "Main API") and
 * the OpenAPI spec at https://api.torbox.app/openapi.json. Checked 2026-11-01.
 *  - Base https://api.torbox.app/v1/api, `Authorization: Bearer <api key>`
 *  - Envelope { success, error, detail, data }; HTTP 403 = auth error,
 *    400 = client error, 500 = TorBox error. Codes: NO_AUTH, BAD_TOKEN,
 *    AUTH_ERROR, ITEM_NOT_FOUND, DATABASE_ERROR, UNKNOWN_ERROR, …
 *  - 300 requests/min per API token
 *  - GET /user/me → { email, plan (0 Free, 1 Essential, 2 Pro, 3 Standard), premium_expires_at }
 *  - GET /{torrents|usenet|webdl}/mylist?bypass_cache&offset&limit →
 *    [{ id, name, download_finished, download_present, updated_at, files: [{ id, name, short_name, size, mimetype }] }]
 *  - GET /{kind}/requestdl?token&{torrent_id|usenet_id|web_id}&file_id → data: CDN URL,
 *    open for 3 hours to start a download (the URL embeds a token → proxy only)
 *  - Device login: GET /user/auth/device/start?app → { device_code, code,
 *    verification_url, friendly_verification_url, interval, expires_at };
 *    POST /user/auth/device/token { device_code } → { access_token } |
 *    DEVICE_CODE_NOT_USED (keep waiting), ITEM_NOT_FOUND (expired), DEVICE_CODE_USED
 */
import { ProviderError } from '../../../errors.js';
import { readJson, send } from '../../../http.js';
import type { CallOptions, DeviceFlowContext, DeviceFlowHandler, ProviderContext, ResolveOptions } from '../../../types.js';
import { refToInfoHash } from '../../magnet.js';
import type { DebridAccountInfo, DebridAdapter, DebridAdapterDefinition, DebridAddResult, DebridCachedResult, DebridCredentials, DebridFile, DebridResolvedLink, DebridTorrentRef, DebridTorrentStatus } from '../../types.js';

export interface TorBoxOptions {
  apiBase?: string;
  now?: () => number;
}

interface Envelope<T> {
  success: boolean;
  error: string | null;
  detail?: string;
  data: T;
}
interface TbItem {
  id: number;
  name: string;
  download_finished?: boolean;
  download_present?: boolean;
  updated_at?: string;
  files?: Array<{ id: number; name: string; short_name?: string; size: number; mimetype?: string }>;
}

const KINDS = [
  { kind: 'torrents', prefix: 't', idParam: 'torrent_id' },
  { kind: 'usenet', prefix: 'u', idParam: 'usenet_id' },
  { kind: 'webdl', prefix: 'w', idParam: 'web_id' },
] as const;
const PAGE = 1000;
const LINK_TTL_MS = 3 * 3600_000; // "This endpoint opens the link for 3 hours"
const PLANS: Record<number, string> = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };

export function createTorBoxAdapter(opts: TorBoxOptions = {}): DebridAdapterDefinition {
  const o: Required<TorBoxOptions> = { apiBase: opts.apiBase ?? 'https://api.torbox.app/v1/api', now: opts.now ?? Date.now };
  return {
    id: 'torbox',
    name: 'TorBox',
    apiKeyUrl: 'https://torbox.app/settings',
    defaultLinkTtlMs: LINK_TTL_MS,
    retrieval: true,
    deviceFlow: torBoxDeviceFlow(o),
    deviceLoginHelp: 'Shows a code to enter on torbox.app. Overtone receives an API token for this device.',
    create: (credentials, ctx) => new TorBoxAdapter(credentials, ctx, o),
  };
}

export const torBoxAdapter = createTorBoxAdapter();

async function call<T>(ctx: Pick<ProviderContext, 'fetch'>, url: string, what: string, init: RequestInit & { idempotent?: boolean }): Promise<T> {
  const res = await send(ctx, url, init, what);
  if (res.status === 429) {
    await res.body?.cancel();
    const retry = Number(res.headers.get('retry-after'));
    throw new ProviderError('rate_limited', `${what}: TorBox rate limit reached`, retry > 0 ? { retryAfterMs: retry * 1000 } : {});
  }
  const body = await readJson<Envelope<T>>(res, what);
  if (body.success) return body.data;
  throw mapError(body.error ?? '', res.status, what);
}

export function mapError(code: string, status: number, what: string): ProviderError {
  if (['NO_AUTH', 'BAD_TOKEN', 'AUTH_ERROR'].includes(code) || status === 403 || status === 401) {
    return new ProviderError('auth', `${what}: TorBox rejected the API key (expired, reset or invalid). Log in again or paste a new key.`);
  }
  if (code === 'ITEM_NOT_FOUND' || status === 404) return new ProviderError('not_found', `${what}: file is no longer in your TorBox account`);
  if (code === 'PLAN_RESTRICTED_FEATURE' || code === 'ACTIVE_LIMIT') return new ProviderError('subscription', `${what}: your TorBox plan doesn't allow this`);
  return new ProviderError('unavailable', `${what}: TorBox error ${code || `HTTP ${status}`}`);
}

class TorBoxAdapter implements DebridAdapter {
  readonly #key: string;
  readonly #ctx: ProviderContext;
  readonly #o: Required<TorBoxOptions>;

  constructor(credentials: DebridCredentials, ctx: ProviderContext, o: Required<TorBoxOptions>) {
    if (!credentials.apiKey) throw new ProviderError('auth', 'TorBox: no API key configured');
    this.#key = credentials.apiKey;
    this.#ctx = ctx;
    this.#o = o;
  }

  #get<T>(path: string, what: string, signal: AbortSignal): Promise<T> {
    return call<T>(this.#ctx, `${this.#o.apiBase}${path}`, what, { headers: { authorization: `Bearer ${this.#key}` }, signal });
  }

  async testConnection({ signal }: CallOptions): Promise<DebridAccountInfo> {
    const u = await this.#get<{ email?: string; plan: number; premium_expires_at?: string | null }>('/user/me', 'Check account', signal);
    const until = u.premium_expires_at ? new Date(u.premium_expires_at) : undefined;
    const premium = u.plan > 0 && (!until || until.getTime() > this.#o.now());
    return {
      ...(u.email ? { username: u.email } : {}),
      premium,
      plan: PLANS[u.plan] ?? `Plan ${u.plan}`,
      ...(premium && until ? { premiumUntil: until } : {}),
    };
  }

  async *listFiles({ signal }: CallOptions): AsyncIterable<DebridFile> {
    for (const k of KINDS) {
      for (let offset = 0; ; offset += PAGE) {
        const items = (await this.#get<TbItem[] | null>(`/${k.kind}/mylist?bypass_cache=true&offset=${offset}&limit=${PAGE}`, `List ${k.kind}`, signal)) ?? [];
        for (const item of items) {
          if (!item.download_finished || item.download_present === false) continue;
          for (const f of item.files ?? []) {
            const name = f.short_name || f.name.split('/').pop() || f.name;
            yield {
              id: `${k.prefix}:${item.id}:${f.id}`,
              name,
              // `name` is the path inside the download, usually prefixed with the item folder.
              path: f.name.includes('/') ? f.name : `${item.name}/${name}`,
              size: f.size,
              ...(item.updated_at ? { modifiedAt: new Date(item.updated_at) } : {}),
            };
          }
        }
        if (items.length < PAGE) break;
      }
    }
  }

  async resolveLink(fileId: string, { signal }: ResolveOptions): Promise<DebridResolvedLink> {
    const [prefix, itemId, fid] = fileId.split(':');
    const k = KINDS.find((x) => x.prefix === prefix);
    if (!k || !/^\d+$/.test(itemId ?? '') || !/^\d+$/.test(fid ?? '')) throw new ProviderError('not_found', 'Unknown TorBox file');
    // requestdl takes the key as `token` (documented); our fetch logging never includes query strings.
    const q = new URLSearchParams({ token: this.#key, [k.idParam]: itemId!, file_id: fid! });
    const url = await this.#get<string>(`/${k.kind}/requestdl?${q}`, 'Get stream link', signal);
    if (!url) throw new ProviderError('unavailable', 'TorBox did not return a download link');
    return { url, expiresAt: new Date(this.#o.now() + LINK_TTL_MS) };
  }

  async checkCached(ref: DebridTorrentRef, { signal }: CallOptions): Promise<DebridCachedResult> {
    const hash = refToInfoHash(ref);
    if (!hash) return { cached: false, unknown: true };
    const data = await this.#get<Array<{ name?: string; size?: number }> | null>(`/torrents/checkcached?hash=${encodeURIComponent(hash)}&format=list`, 'Check cache', signal);
    if (!data) return { cached: false };
    const files = data.map((f) => ({ name: f.name ?? '', size: Number(f.size) || 0 }));
    return { cached: files.length > 0, files };
  }

  async addMagnet(magnet: string, { signal }: CallOptions): Promise<DebridAddResult> {
    const data = await call<{ torrent_id?: number }>(this.#ctx, `${this.#o.apiBase}/torrents/createtorrent`, 'Add magnet', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ magnet }),
      signal,
      idempotent: false,
    });
    if (!data.torrent_id) throw new ProviderError('unavailable', 'TorBox did not return a torrent id');
    return { id: String(data.torrent_id), status: 'queued' };
  }

  async getStatus(id: string, { signal }: CallOptions): Promise<DebridTorrentStatus> {
    const items = (await this.#get<TbItem[] | null>('/torrents/mylist?bypass_cache=true&offset=0&limit=1000', 'Check torrent', signal)) ?? [];
    const item = items.find((i) => String(i.id) === String(id));
    if (!item) return { status: 'processing', progress: null };
    if (item.download_finished) return { status: 'finished' };
    if (item.download_present === false) return { status: 'error', message: 'TorBox could not download the torrent' };
    return { status: 'processing', progress: null };
  }

  async listTorrentFiles(remoteId: string, { signal }: CallOptions): Promise<DebridFile[]> {
    const items = (await this.#get<TbItem[] | null>('/torrents/mylist?bypass_cache=true&offset=0&limit=1000', 'List torrent files', signal)) ?? [];
    const item = items.find((i) => String(i.id) === String(remoteId));
    if (!item) return [];
    return (item.files ?? []).map((f) => {
      const name = f.short_name || f.name.split('/').pop() || f.name;
      return { id: String(f.id), name, path: f.name, size: f.size };
    });
  }

  async resolveFileLink(remoteId: string, fileId: string, { signal }: ResolveOptions): Promise<DebridResolvedLink> {
    if (!/^\d+$/.test(remoteId) || !/^\d+$/.test(fileId)) throw new ProviderError('not_found', 'Unknown TorBox file');
    // requestdl takes the key as `token` (documented); our fetch logging never includes query strings.
    const q = new URLSearchParams({ token: this.#key, torrent_id: remoteId, file_id: fileId });
    const url = await this.#get<string>(`/torrents/requestdl?${q}`, 'Get stream link', signal);
    if (!url) throw new ProviderError('unavailable', 'TorBox did not return a download link');
    return { url, expiresAt: new Date(this.#o.now() + LINK_TTL_MS) };
  }
}

function torBoxDeviceFlow(o: Required<TorBoxOptions>): DeviceFlowHandler {
  return {
    async start(ctx: DeviceFlowContext) {
      const d = await call<{ device_code: string; code: string; verification_url: string; friendly_verification_url?: string; interval: number; expires_at: string }>(
        ctx,
        `${o.apiBase}/user/auth/device/start?app=Overtone`,
        'TorBox login',
        { signal: ctx.signal },
      );
      return {
        handle: d.device_code,
        userCode: d.code,
        verificationUrl: d.friendly_verification_url ?? d.verification_url,
        verificationUrlComplete: d.verification_url,
        expiresAt: new Date(d.expires_at),
        intervalSeconds: Math.max(1, d.interval || 5),
      };
    },
    async poll(deviceCode: string, ctx: DeviceFlowContext) {
      const res = await send(
        ctx,
        `${o.apiBase}/user/auth/device/token`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: deviceCode }), signal: ctx.signal, idempotent: true },
        'TorBox login',
      );
      const body = await readJson<Envelope<{ access_token?: string } | null>>(res, 'TorBox login');
      if (body.success && body.data?.access_token) return { status: 'complete', secrets: { apiKey: body.data.access_token } };
      if (body.error === 'DEVICE_CODE_NOT_USED' || res.status === 429) return { status: 'pending' };
      if (body.error === 'ITEM_NOT_FOUND' || body.error === 'DEVICE_CODE_USED') return { status: 'expired' };
      return { status: 'denied' };
    },
  };
}
