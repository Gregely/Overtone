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
import { readJson, send, type RequestInitWithTimeout } from '../../../http.js';
import type { CallOptions, DeviceFlowContext, DeviceFlowHandler, ProviderContext, ResolveOptions } from '../../../types.js';
import type { DebridAccountInfo, DebridAdapter, DebridAdapterDefinition, DebridCredentials, DebridFile, DebridResolvedLink } from '../../types.js';

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
/** mylist with bypass_cache can be slow on large accounts; the 20 s default is too tight. */
const LIST_TIMEOUT_MS = 90_000;
const LINK_TTL_MS = 3 * 3600_000; // "This endpoint opens the link for 3 hours"
const PLANS: Record<number, string> = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Standard' };

export function createTorBoxAdapter(opts: TorBoxOptions = {}): DebridAdapterDefinition {
  const o: Required<TorBoxOptions> = { apiBase: opts.apiBase ?? 'https://api.torbox.app/v1/api', now: opts.now ?? Date.now };
  return {
    id: 'torbox',
    name: 'TorBox',
    apiKeyUrl: 'https://torbox.app/settings',
    defaultLinkTtlMs: LINK_TTL_MS,
    deviceFlow: torBoxDeviceFlow(o),
    deviceLoginHelp: 'Shows a code to enter on torbox.app. Overtone receives an API token for this device.',
    create: (credentials, ctx) => new TorBoxAdapter(credentials, ctx, o),
  };
}

export const torBoxAdapter = createTorBoxAdapter();

async function call<T>(ctx: Pick<ProviderContext, 'fetch'>, url: string, what: string, init: RequestInitWithTimeout): Promise<T> {
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

  #get<T>(path: string, what: string, signal: AbortSignal, timeoutMs?: number): Promise<T> {
    return call<T>(this.#ctx, `${this.#o.apiBase}${path}`, what, {
      headers: { authorization: `Bearer ${this.#key}` },
      signal,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
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

  /**
   * Lists torrents, then usenet, then web downloads. A failure in one list
   * (e.g. usenet on a plan without it, a TorBox 5xx, a timeout) doesn't stop
   * the others: everything that could be listed is yielded first, then the
   * first error is re-thrown so the scanner knows the listing was incomplete
   * (and keeps existing library entries instead of removing them).
   * Auth errors stop immediately: no other list would succeed either.
   */
  async *listFiles({ signal }: CallOptions): AsyncIterable<DebridFile> {
    const log = this.#ctx.logger;
    let firstError: unknown;
    for (const k of KINDS) {
      const stats = { items: 0, available: 0, notReady: 0, files: 0, badFiles: 0, pages: 0 };
      const seen = new Set<number>();
      try {
        for (let offset = 0; ; offset += PAGE) {
          const data = await this.#get<unknown>(`/${k.kind}/mylist?bypass_cache=true&offset=${offset}&limit=${PAGE}`, `List ${k.kind}`, signal, LIST_TIMEOUT_MS);
          if (data !== null && data !== undefined && !Array.isArray(data)) {
            throw new ProviderError('unavailable', `List ${k.kind}: unexpected response from TorBox`);
          }
          const items = (data ?? []) as TbItem[];
          stats.pages++;
          let fresh = 0;
          for (const item of items) {
            if (typeof item?.id !== 'number' || seen.has(item.id)) continue;
            seen.add(item.id);
            fresh++;
            stats.items++;
            if (!isAvailable(item)) {
              stats.notReady++;
              continue;
            }
            stats.available++;
            for (const f of Array.isArray(item.files) ? item.files : []) {
              if (typeof f?.id !== 'number' || typeof f.name !== 'string' || !f.name) {
                stats.badFiles++;
                continue;
              }
              const name = f.short_name || f.name.split('/').pop() || f.name;
              stats.files++;
              yield {
                id: `${k.prefix}:${item.id}:${f.id}`,
                name,
                // `name` is the path inside the download, usually prefixed with the item folder.
                path: f.name.includes('/') ? f.name : `${item.name}/${name}`,
                size: typeof f.size === 'number' ? f.size : 0,
                ...(item.updated_at ? { modifiedAt: new Date(item.updated_at) } : {}),
              };
            }
          }
          // A short page is the last one. A page with nothing new means the API
          // ignored `offset`; stop rather than loop forever.
          if (items.length < PAGE || fresh === 0) break;
        }
        log.info('torbox listing', { kind: k.kind, ...stats });
      } catch (err) {
        log.warn('torbox listing failed', { kind: k.kind, ...stats, error: (err as Error).message });
        if (signal.aborted || (err instanceof ProviderError && err.code === 'auth')) throw err;
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
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
}

/**
 * Finished and stored on TorBox, so requestdl will work. Both fields are
 * optional in TorBox's schema: an explicit `false` on either excludes the
 * item; otherwise one of them must be `true`.
 */
function isAvailable(item: TbItem): boolean {
  if (item.download_finished === false || item.download_present === false) return false;
  return item.download_finished === true || item.download_present === true;
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
