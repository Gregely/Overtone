/**
 * AllDebrid adapter: lists audio files already in the user's account (ready
 * magnets and saved links) and unlocks them to direct links on demand.
 * Read-only: no magnet upload, no saving links, no unlocking of links that
 * aren't already part of the account.
 *
 * API docs: https://docs.alldebrid.com/ (v4 / v4.1). Checked 2026-11-01.
 *  - Base https://api.alldebrid.com, `Authorization: Bearer <apikey>`
 *    (the `agent` parameter is no longer required, changelog 2025-01-15)
 *  - Envelope { status: 'success', data } | { status: 'error', error: { code, message } }
 *  - Limits: 12 req/s and 600 req/min; excess → HTTP 429 or 503
 *  - GET  /v4/user → { user: { username, isPremium, isTrial, premiumUntil (unix s) } }
 *  - POST /v4.1/magnet/status (status=ready) → { magnets: [{ id, filename, size, status, uploadDate, completionDate }] }
 *  - POST /v4/magnet/files (id[]) → { magnets: [{ id, files: [{ n, s, l } | { n, e: [...] }] } | { id, error }] }
 *  - POST /v4/link/unlock (link) → { link, filename, filesize, delayed? }
 *  - POST /v4/link/delayed (id) → { status (2 = ready), link }
 *  - GET  /v4/user/links → { links: [{ link, filename, size, date }] }
 *  - PIN login: GET /v4.1/pin/get → { pin, check, expires_in, user_url, base_url };
 *    POST /v4/pin/check (check, pin) → { activated, apikey?, expires_in }; PIN_EXPIRED / PIN_INVALID
 *  - Errors: AUTH_MISSING_APIKEY, AUTH_BAD_APIKEY, AUTH_BLOCKED, AUTH_USER_BANNED,
 *    MUST_BE_PREMIUM, LINK_DOWN, MAGNET_INVALID_ID, MAINTENANCE, …
 */
import { sha256Hex } from '../../../../crypto.js';
import { ProviderError } from '../../../errors.js';
import { form, readJson, send } from '../../../http.js';
import type { CallOptions, DeviceFlowContext, DeviceFlowHandler, ProviderContext, ResolveOptions } from '../../../types.js';
import { infoHashToMagnet, magnetInfoHash, refToInfoHash, refToMagnet } from '../../magnet.js';
import type { DebridAccountInfo, DebridAdapter, DebridAdapterDefinition, DebridAddResult, DebridCachedResult, DebridCredentials, DebridFile, DebridResolvedLink, DebridTorrentRef, DebridTorrentStatus } from '../../types.js';

export interface AllDebridOptions {
  apiBase?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Envelope<T> = { status: 'success'; data: T } | { status: 'error'; error: { code: string; message?: string } };
interface FileNode {
  n: string;
  s?: number;
  l?: string;
  e?: FileNode[];
}

const BATCH = 50;

export function createAllDebridAdapter(opts: AllDebridOptions = {}): DebridAdapterDefinition {
  const o: Required<AllDebridOptions> = {
    apiBase: opts.apiBase ?? 'https://api.alldebrid.com',
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  return {
    id: 'alldebrid',
    name: 'AllDebrid',
    apiKeyUrl: 'https://alldebrid.com/apikeys/',
    retrieval: true,
    deviceFlow: allDebridPinFlow(o),
    deviceLoginHelp: 'Shows a PIN to enter on alldebrid.com/pin. Overtone receives an API key you can revoke at any time.',
    create: (credentials, ctx) => new AllDebridAdapter(credentials, ctx, o),
  };
}

export const allDebridAdapter = createAllDebridAdapter();

async function call<T>(
  ctx: Pick<ProviderContext, 'fetch'>,
  o: Required<AllDebridOptions>,
  path: string,
  what: string,
  init: { signal: AbortSignal; method?: string; body?: URLSearchParams; apiKey?: string; idempotent?: boolean },
): Promise<T> {
  const res = await send(
    ctx,
    `${o.apiBase}${path}`,
    {
      method: init.method ?? 'GET',
      headers: init.apiKey ? { authorization: `Bearer ${init.apiKey}` } : {},
      ...(init.body ? { body: init.body } : {}),
      signal: init.signal,
      // Read-only calls (status, files, unlock, pin) are safe to retry; adds are not.
      idempotent: init.idempotent ?? true,
    },
    what,
  );
  if (res.status === 429 || res.status === 503) {
    await res.body?.cancel();
    const retry = Number(res.headers.get('retry-after'));
    return Promise.reject(new ProviderError('rate_limited', `${what}: AllDebrid rate limit reached`, retry > 0 ? { retryAfterMs: retry * 1000 } : {}));
  }
  const body = await readJson<Envelope<T>>(res, what);
  if (body.status === 'success') return body.data;
  throw mapError(body.error?.code ?? 'GENERIC', what, res.status);
}

export function mapError(code: string, what: string, httpStatus = 200): ProviderError {
  if (code.startsWith('AUTH_') || code === 'ACCOUNT_INVALID') {
    const msg =
      code === 'AUTH_BLOCKED'
        ? 'AllDebrid blocked this request (IP or region). Check your AllDebrid security settings.'
        : code === 'AUTH_USER_BANNED'
          ? 'this AllDebrid account is banned'
          : 'AllDebrid rejected the API key (expired, revoked or invalid). Log in again or paste a new key.';
    return new ProviderError('auth', `${what}: ${msg}`);
  }
  if (code === 'MUST_BE_PREMIUM' || code === 'MAGNET_MUST_BE_PREMIUM' || code === 'FREE_TRIAL_LIMIT_REACHED') {
    return new ProviderError('subscription', `${what}: this needs an active AllDebrid premium plan`);
  }
  if (['LINK_DOWN', 'MAGNET_INVALID_ID', 'LINK_IS_MISSING', 'USER_LINK_INVALID', 'USER_LINK_MISSING', 'MAGNET_LINKS_REMOVED', 'DELAYED_INVALID_ID'].includes(code)) {
    return new ProviderError('not_found', `${what}: file is no longer available in your AllDebrid account`);
  }
  if (code === 'LINK_TOO_MANY_DOWNLOADS' || code === 'LINK_HOST_LIMIT_REACHED' || httpStatus === 429) {
    return new ProviderError('rate_limited', `${what}: AllDebrid limit reached (${code})`);
  }
  return new ProviderError('unavailable', `${what}: AllDebrid error ${code}`);
}

class AllDebridAdapter implements DebridAdapter {
  readonly #key: string;
  readonly #ctx: ProviderContext;
  readonly #o: Required<AllDebridOptions>;

  constructor(credentials: DebridCredentials, ctx: ProviderContext, o: Required<AllDebridOptions>) {
    if (!credentials.apiKey) throw new ProviderError('auth', 'AllDebrid: no API key configured');
    this.#key = credentials.apiKey;
    this.#ctx = ctx;
    this.#o = o;
  }

  #call<T>(path: string, what: string, init: { signal: AbortSignal; method?: string; body?: URLSearchParams; idempotent?: boolean }): Promise<T> {
    return call<T>(this.#ctx, this.#o, path, what, { ...init, apiKey: this.#key });
  }

  async testConnection({ signal }: CallOptions): Promise<DebridAccountInfo> {
    const { user } = await this.#call<{ user: { username: string; isPremium: boolean; isTrial?: boolean; premiumUntil?: number } }>('/v4/user', 'Check account', { signal });
    return {
      username: user.username,
      premium: Boolean(user.isPremium),
      plan: user.isPremium ? (user.isTrial ? 'Premium (trial)' : 'Premium') : 'Free',
      ...(user.isPremium && user.premiumUntil ? { premiumUntil: new Date(user.premiumUntil * 1000) } : {}),
    };
  }

  async *listFiles({ signal }: CallOptions): AsyncIterable<DebridFile> {
    const { magnets } = await this.#call<{ magnets: Array<{ id: number; filename: string; completionDate?: number }> | Record<string, never> }>(
      '/v4.1/magnet/status',
      'List magnets',
      { signal, method: 'POST', body: form({ status: 'ready' }) },
    );
    const list = Array.isArray(magnets) ? magnets : [];
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const trees = await this.#files(batch.map((m) => m.id), signal);
      for (const m of batch) {
        const tree = trees.get(m.id);
        if (!tree) continue;
        for (const f of flatten(tree)) {
          yield {
            id: `m:${m.id}:${f.path}`,
            name: f.name,
            path: `${m.filename}/${f.path}`,
            size: f.size,
            ...(m.completionDate ? { modifiedAt: new Date(m.completionDate * 1000) } : {}),
          };
        }
      }
    }
    // Links the user saved in their account.
    const { links } = await this.#call<{ links?: Array<{ link: string; filename: string; size: number; date?: number }> }>('/v4/user/links', 'List saved links', { signal });
    for (const l of links ?? []) {
      yield { id: `l:${await hash(l.link)}`, name: l.filename, path: `Saved links/${l.filename}`, size: l.size, ...(l.date ? { modifiedAt: new Date(l.date * 1000) } : {}) };
    }
  }

  async #files(ids: number[], signal: AbortSignal): Promise<Map<number, FileNode[]>> {
    const { magnets } = await this.#call<{ magnets: Array<{ id: number | string; files?: FileNode[]; error?: { code: string } }> }>('/v4/magnet/files', 'Read magnet files', {
      signal,
      method: 'POST',
      body: form({ 'id[]': ids }),
    });
    return new Map((magnets ?? []).filter((m) => m.files).map((m) => [Number(m.id), m.files!]));
  }

  async resolveLink(fileId: string, { signal }: ResolveOptions): Promise<DebridResolvedLink> {
    let accountLink: string | undefined;
    if (fileId.startsWith('m:')) {
      const [, id, ...rest] = fileId.split(':');
      const path = rest.join(':');
      const tree = (await this.#files([Number(id)], signal)).get(Number(id));
      accountLink = tree && flatten(tree).find((f) => f.path === path)?.link;
    } else if (fileId.startsWith('l:')) {
      const { links } = await this.#call<{ links?: Array<{ link: string }> }>('/v4/user/links', 'List saved links', { signal });
      for (const l of links ?? []) if (`l:${await hash(l.link)}` === fileId) accountLink ??= l.link;
    }
    if (!accountLink) throw new ProviderError('not_found', 'File is no longer in your AllDebrid account');
    return this.#unlock(accountLink, signal);
  }

  async checkCached(ref: DebridTorrentRef, { signal }: CallOptions): Promise<DebridCachedResult> {
    const magnet = refToMagnet(ref);
    if (!magnet) return { cached: false, unknown: true };
    const data = await this.#call<{ magnets?: Array<{ magnet?: string; hash?: string; instant?: boolean }> }>('/v4/magnet/instant', 'Check cache', {
      signal,
      method: 'POST',
      body: form({ magnets: JSON.stringify([magnet]) }),
    });
    const m = data.magnets?.[0];
    if (!m) return { cached: false, unknown: true };
    return { cached: m.instant === true };
  }

  async checkCachedBatch(infoHashes: string[], { signal }: CallOptions): Promise<Map<string, DebridCachedResult>> {
    const out = new Map<string, DebridCachedResult>();
    const magnets = infoHashes.map(infoHashToMagnet);
    const data = await this.#call<{ magnets?: Array<{ magnet?: string; hash?: string; instant?: boolean }> }>('/v4/magnet/instant', 'Check cache', {
      signal,
      method: 'POST',
      body: form({ magnets: JSON.stringify(magnets) }),
    });
    for (const m of data.magnets ?? []) {
      const hash = (m.hash ?? (m.magnet ? magnetInfoHash(m.magnet) : undefined))?.toLowerCase();
      if (hash) out.set(hash, { cached: m.instant === true });
    }
    // Hashes the provider didn't report are unknown, not definitively uncached.
    for (const h of infoHashes) if (!out.has(h.toLowerCase())) out.set(h.toLowerCase(), { cached: false, unknown: true });
    return out;
  }

  async addMagnet(magnet: string, { signal }: CallOptions): Promise<DebridAddResult> {
    const data = await this.#call<{ magnets?: Array<{ id?: number; hash?: string; error?: { code: string; message?: string } }> }>('/v4/magnet/upload', 'Add magnet', {
      signal,
      method: 'POST',
      body: form({ magnets: JSON.stringify([magnet]) }),
      idempotent: false,
    });
    const m = data.magnets?.[0];
    if (m?.error) throw new ProviderError('unavailable', `AllDebrid could not add the magnet (${m.error.code})`);
    if (!m?.id) throw new ProviderError('unavailable', 'AllDebrid did not return a magnet id');
    return { id: String(m.id), status: 'queued' };
  }

  async getStatus(id: string, { signal }: CallOptions): Promise<DebridTorrentStatus> {
    const data = await this.#call<{ magnets?: Array<{ id?: number | string; status?: number; statusCode?: string }> }>('/v4.1/magnet/status', 'Check magnet', {
      signal,
      method: 'POST',
      body: form({ id }),
    });
    const m = data.magnets?.find((x) => String(x.id) === String(id)) ?? data.magnets?.[0];
    return mapAllDebridStatus(m?.status);
  }

  async listTorrentFiles(remoteId: string, { signal }: CallOptions): Promise<DebridFile[]> {
    const tree = (await this.#files([Number(remoteId)], signal)).get(Number(remoteId));
    if (!tree) return [];
    return flatten(tree).map((f) => ({ id: f.path, name: f.name, path: f.path, size: f.size }));
  }

  async resolveFileLink(remoteId: string, fileId: string, { signal }: ResolveOptions): Promise<DebridResolvedLink> {
    const tree = (await this.#files([Number(remoteId)], signal)).get(Number(remoteId));
    const link = tree && flatten(tree).find((f) => f.path === fileId)?.link;
    if (!link) throw new ProviderError('not_found', 'File is no longer in your AllDebrid account');
    return this.#unlock(link, signal);
  }

  /** Only called with links taken from the user's own magnets / saved links. */
  async #unlock(link: string, signal: AbortSignal): Promise<DebridResolvedLink> {
    const data = await this.#call<{ link?: string; filesize?: number; delayed?: number }>('/v4/link/unlock', 'Get stream link', {
      signal,
      method: 'POST',
      body: form({ link }),
    });
    if (data.link) return { url: data.link, ...(data.filesize ? { size: data.filesize } : {}) };
    if (data.delayed) {
      for (let i = 0; i < 10; i++) {
        await this.#o.sleep(2000);
        const d = await this.#call<{ status: number; link?: string }>('/v4/link/delayed', 'Get stream link', { signal, method: 'POST', body: form({ id: data.delayed }) });
        if (d.status === 2 && d.link) return { url: d.link };
        if (d.status === 3) break;
      }
    }
    throw new ProviderError('unavailable', 'AllDebrid could not generate a stream link right now');
  }
}

/** Flatten the v4.1 file tree ({n, s, l} files, {n, e} folders). */
export function flatten(nodes: FileNode[], prefix = ''): Array<{ path: string; name: string; size: number; link: string }> {
  const out: Array<{ path: string; name: string; size: number; link: string }> = [];
  for (const n of nodes) {
    const path = prefix ? `${prefix}/${n.n}` : n.n;
    if (n.e) out.push(...flatten(n.e, path));
    else if (n.l) out.push({ path, name: n.n, size: n.s ?? 0, link: n.l });
  }
  return out;
}

const hash = async (s: string) => (await sha256Hex(s)).slice(0, 24);

/** AllDebrid magnet status → normalized status (0 processing, 1 downloading, 2 error, 3 uploading, 4 ready). */
export function mapAllDebridStatus(status: number | undefined): DebridTorrentStatus {
  if (status === 4) return { status: 'finished' };
  if (status === 2) return { status: 'error', message: 'AllDebrid could not process the magnet' };
  return { status: 'processing', progress: null };
}

// ── PIN login ───────────────────────────────────────────────────────────────

function allDebridPinFlow(o: Required<AllDebridOptions>): DeviceFlowHandler {
  return {
    async start(ctx: DeviceFlowContext) {
      const d = await call<{ pin: string; check: string; expires_in: number; user_url: string; base_url: string }>(ctx, o, '/v4.1/pin/get', 'AllDebrid login', {
        signal: ctx.signal,
      });
      return {
        handle: JSON.stringify({ pin: d.pin, check: d.check }),
        userCode: d.pin,
        verificationUrl: d.base_url,
        verificationUrlComplete: d.user_url,
        expiresAt: new Date(o.now() + d.expires_in * 1000),
        intervalSeconds: 5,
      };
    },
    async poll(handle: string, ctx: DeviceFlowContext) {
      const { pin, check } = JSON.parse(handle) as { pin: string; check: string };
      try {
        const d = await call<{ activated: boolean; apikey?: string }>(ctx, o, '/v4/pin/check', 'AllDebrid login', {
          signal: ctx.signal,
          method: 'POST',
          body: form({ check, pin }),
        });
        return d.activated && d.apikey ? { status: 'complete', secrets: { apiKey: d.apikey } } : { status: 'pending' };
      } catch (err) {
        if (err instanceof ProviderError && /PIN_(EXPIRED|INVALID)/.test(err.message)) return { status: 'expired' };
        throw err;
      }
    },
  };
}
