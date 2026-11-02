/**
 * Premiumize.me adapter: lists audio files already in the user's cloud and
 * returns their direct links on demand. Read-only: no transfers, no folder
 * changes, no cache lookups for new content.
 *
 * API docs: https://www.premiumize.me/api. Checked 2026-11-01.
 *  - Base https://www.premiumize.me/api, `Authorization: Bearer <api key or OAuth token>`
 *    (legacy `apikey` param still accepted; the docs recommend the header)
 *  - Errors use HTTP 200 with { status: 'error', message, code }; codes include
 *    authentication_failed, permission_denied, not_found, rate_limit_reached,
 *    service_limit_reached, account_limit_reached, transient_error; HTTP 500 = unknown_error
 *  - GET /account/info → { customer_id, premium_until (unix s, null = free), limit_used }
 *  - GET /item/listall → { files: [{ id, name, path, size, created_at, mime_type }] }
 *  - GET /item/details?id → { id, name, size, mime_type, link } (stream_link deprecated)
 *  - OAuth device flow at https://www.premiumize.me/token needs a *registered*
 *    client_id (POST response_type=device_code → { device_code, user_code,
 *    verification_uri, expires_in, interval }; poll grant_type=device_code →
 *    { access_token, expires_in } or 400 authorization_pending / slow_down /
 *    access_denied / invalid_grant). No refresh token is documented for this
 *    flow. There's no public client id, so "Log in with Premiumize" is only
 *    offered when the server admin sets OVERTONE_PREMIUMIZE_CLIENT_ID.
 */
import { ProviderError } from '../../../errors.js';
import { form, readJson, send } from '../../../http.js';
import type { CallOptions, DeviceFlowContext, DeviceFlowHandler, ProviderContext, ResolveOptions } from '../../../types.js';
import type { DebridAccountInfo, DebridAdapter, DebridAdapterDefinition, DebridCredentials, DebridFile, DebridResolvedLink } from '../../types.js';

export interface PremiumizeOptions {
  apiBase?: string;
  tokenUrl?: string;
  /** Registered OAuth client id; enables "Log in with Premiumize". */
  clientId?: string | null;
  now?: () => number;
}

type Envelope<T> = ({ status: 'success' } & T) | { status: 'error'; message?: string; code?: string };

export function createPremiumizeAdapter(opts: PremiumizeOptions = {}): DebridAdapterDefinition {
  const apiBase = opts.apiBase ?? 'https://www.premiumize.me/api';
  const tokenUrl = opts.tokenUrl ?? 'https://www.premiumize.me/token';
  const now = opts.now ?? Date.now;
  return {
    id: 'premiumize',
    name: 'Premiumize.me',
    apiKeyUrl: 'https://www.premiumize.me/account',
    ...(opts.clientId
      ? {
          deviceFlow: premiumizeDeviceFlow(tokenUrl, opts.clientId, now),
          deviceLoginHelp: 'Shows a code to enter on premiumize.me/device. Access lasts until Premiumize expires it; then log in again.',
        }
      : {}),
    create: (credentials, ctx) => new PremiumizeAdapter(credentials, ctx, apiBase),
  };
}

export const premiumizeAdapter = createPremiumizeAdapter();

export function mapError(code: string | undefined, message: string | undefined, what: string): ProviderError {
  switch (code) {
    case 'authentication_failed':
      return new ProviderError('auth', `${what}: Premiumize rejected the API key or login (expired or invalid). Log in again or paste a new key.`);
    case 'permission_denied':
      return new ProviderError('auth', `${what}: Premiumize denied access (account restricted or unconfirmed)`);
    case 'not_found':
      return new ProviderError('not_found', `${what}: file is no longer in your Premiumize cloud`);
    case 'rate_limit_reached':
      return new ProviderError('rate_limited', `${what}: Premiumize rate limit reached`);
    case 'service_limit_reached':
    case 'account_limit_reached':
      return new ProviderError('subscription', `${what}: Premiumize usage limit reached`);
    default:
      return new ProviderError('unavailable', `${what}: Premiumize error ${code ?? message ?? 'unknown'}`);
  }
}

class PremiumizeAdapter implements DebridAdapter {
  readonly #key: string;
  readonly #ctx: ProviderContext;
  readonly #base: string;

  constructor(credentials: DebridCredentials, ctx: ProviderContext, base: string) {
    if (!credentials.apiKey) throw new ProviderError('auth', 'Premiumize: no API key configured');
    this.#key = credentials.apiKey;
    this.#ctx = ctx;
    this.#base = base;
  }

  async #get<T>(path: string, what: string, signal: AbortSignal): Promise<T> {
    const res = await send(this.#ctx, `${this.#base}${path}`, { headers: { authorization: `Bearer ${this.#key}` }, signal }, what);
    if (res.status === 429) {
      await res.body?.cancel();
      throw new ProviderError('rate_limited', `${what}: Premiumize rate limit reached`);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw mapError('authentication_failed', undefined, what);
    }
    const body = await readJson<Envelope<T>>(res, what);
    if (body.status === 'success') return body as T;
    throw mapError((body as { code?: string }).code, (body as { message?: string }).message, what);
  }

  async testConnection({ signal }: CallOptions): Promise<DebridAccountInfo> {
    const a = await this.#get<{ customer_id: string | number; premium_until: number | null }>('/account/info', 'Check account', signal);
    const until = a.premium_until ? new Date(a.premium_until * 1000) : undefined;
    const premium = Boolean(until && until.getTime() > Date.now());
    return { username: String(a.customer_id), premium, plan: premium ? 'Premium' : 'Free', ...(premium && until ? { premiumUntil: until } : {}) };
  }

  async *listFiles({ signal }: CallOptions): AsyncIterable<DebridFile> {
    const { files } = await this.#get<{ files?: Array<{ id: string; name: string; path?: string; size: number; created_at?: number }> }>('/item/listall', 'List cloud files', signal);
    for (const f of files ?? []) {
      yield {
        id: f.id,
        name: f.name,
        path: (f.path ?? f.name).replace(/^\/+/, ''),
        size: f.size,
        ...(f.created_at ? { modifiedAt: new Date(f.created_at * 1000) } : {}),
      };
    }
  }

  async resolveLink(fileId: string, { signal }: ResolveOptions): Promise<DebridResolvedLink> {
    if (!/^[\w-]+$/.test(fileId)) throw new ProviderError('not_found', 'Unknown Premiumize file');
    const d = await this.#get<{ link?: string; size?: number; mime_type?: string }>(`/item/details?id=${encodeURIComponent(fileId)}`, 'Get stream link', signal);
    if (!d.link) throw new ProviderError('unavailable', 'Premiumize did not return a link for this file');
    return { url: d.link, ...(d.size ? { size: d.size } : {}), ...(d.mime_type?.startsWith('audio/') ? { mimeType: d.mime_type } : {}) };
  }
}

function premiumizeDeviceFlow(tokenUrl: string, clientId: string, now: () => number): DeviceFlowHandler {
  return {
    async start(ctx: DeviceFlowContext) {
      const res = await send(ctx, tokenUrl, { method: 'POST', body: form({ response_type: 'device_code', client_id: clientId }), signal: ctx.signal }, 'Premiumize login');
      if (!res.ok) throw new ProviderError('unavailable', `Premiumize login: HTTP ${res.status}`);
      const d = await readJson<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(res, 'Premiumize login');
      return {
        handle: d.device_code,
        userCode: d.user_code,
        verificationUrl: d.verification_uri,
        expiresAt: new Date(now() + d.expires_in * 1000),
        intervalSeconds: Math.max(1, d.interval || 5),
      };
    },
    async poll(deviceCode: string, ctx: DeviceFlowContext) {
      const res = await send(
        ctx,
        tokenUrl,
        { method: 'POST', body: form({ grant_type: 'device_code', code: deviceCode, client_id: clientId }), signal: ctx.signal, idempotent: true },
        'Premiumize login',
      );
      const body = await readJson<{ access_token?: string; error?: string }>(res, 'Premiumize login');
      if (res.ok && body.access_token) return { status: 'complete', secrets: { apiKey: body.access_token } };
      if (body.error === 'authorization_pending' || body.error === 'slow_down') return { status: 'pending' };
      if (body.error === 'access_denied') return { status: 'denied' };
      return { status: 'expired' };
    },
  };
}
