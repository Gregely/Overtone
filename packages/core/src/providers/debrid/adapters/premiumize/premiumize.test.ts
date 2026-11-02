import { describe, expect, it } from 'vitest';
import { json, mockHttp } from '../../../../testing/mock-http.js';
import { collect, createTestContext } from '../../../../testing/provider-context.js';
import { createDebridPlugin } from '../../index.js';
import { createPremiumizeAdapter } from './index.js';

// Fixtures follow https://www.premiumize.me/api; ids and keys are fake.
const API = 'https://www.premiumize.me/api';
const TOKEN = 'https://www.premiumize.me/token';
const signal = new AbortController().signal;
const ok = (data: object) => json({ status: 'success', ...data });
const err = (code: string) => json({ status: 'error', code, message: code }); // HTTP 200, as documented

function setup(opts: { retries?: boolean } = {}) {
  const http = mockHttp()
    .on('GET', `${API}/account/info`, ok({ customer_id: 4242, premium_until: 1830297600, limit_used: 0.1 }))
    .on('GET', `${API}/item/listall`, ok({
      files: [
        { id: 'f1', name: '01 Track.flac', path: '/Music/Artist/Album/01 Track.flac', size: 900, created_at: 1767225600, mime_type: 'audio/flac' },
        { id: 'f2', name: 'movie.mkv', path: '/Video/movie.mkv', size: 9999, mime_type: 'video/x-matroska' },
      ],
    }))
    .on('GET', `${API}/item/details`, (req) => ok({ id: req.url.searchParams.get('id'), name: '01 Track.flac', size: 900, mime_type: 'audio/flac', link: 'https://cdn.premiumize.me/dl/f1' }));
  const ctx = createTestContext({ fetch: http.fetch, ...(opts.retries ? { retries: true } : {}) });
  const provider = createDebridPlugin(createPremiumizeAdapter()).create({ apiKey: 'pm-key', probeTags: false }, ctx);
  return { http, ctx, provider };
}

describe('Premiumize adapter', () => {
  it('lists audio in the cloud', async () => {
    const { provider, http } = setup();
    const files = await collect(provider.listLibrary({ signal }));
    expect(files.map((f) => [f.id, f.path])).toEqual([['f1', 'Music/Artist/Album/01 Track.flac']]);
    expect(http.calls[0]!.headers.get('authorization')).toBe('Bearer pm-key');
  });

  it('resolves a file to its direct link (proxied)', async () => {
    const { provider, http } = setup();
    expect(await provider.resolveStream('f1', { signal })).toMatchObject({ url: 'https://cdn.premiumize.me/dl/f1', redirectSafe: false, mimeType: 'audio/flac' });
    expect(http.to(`${API}/item/details`)[0]!.url.searchParams.get('id')).toBe('f1');
    await expect(provider.resolveStream('../account', { signal })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports account id, plan and expiry', async () => {
    const { provider } = setup();
    expect(await provider.testConnection!({ signal })).toEqual({
      ok: true,
      message: 'Connected to Premiumize.me as 4242, premium until 2028-01-01.',
      details: { account: '4242', plan: 'Premium', premiumUntil: '2028-01-01' },
    });
  });

  it('flags free accounts (premium_until null)', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/account/info`, ok({ customer_id: 1, premium_until: null }));
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: false, details: { plan: 'Free' } });
  });

  it('maps a bad / expired key (HTTP 200 error envelope) to auth', async () => {
    const { provider, http } = setup();
    http.on('GET', (u) => u.href.startsWith(API), err('authentication_failed'));
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: false, message: expect.stringContaining('rejected the API key') });
    await expect(collect(provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'auth' });
  });

  it('maps rate_limit_reached and HTTP 429 (with backoff) correctly', async () => {
    const a = setup();
    a.http.on('GET', `${API}/item/listall`, err('rate_limit_reached'));
    await expect(collect(a.provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'rate_limited' });
    const b = setup({ retries: true });
    b.http.on('GET', `${API}/item/listall`, json({}, 429, { 'retry-after': '1' }), 1);
    expect(await collect(b.provider.listLibrary({ signal }))).toHaveLength(1);
    expect(b.ctx.delays).toEqual([1000]);
  });

  it('maps a removed file and network failures', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/item/details`, err('not_found'));
    await expect(provider.resolveStream('f1', { signal })).rejects.toMatchObject({ code: 'not_found' });
    http.fail('GET', (u) => u.href.startsWith(API));
    await expect(collect(provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('handles an empty cloud', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/item/listall`, ok({ files: [] }));
    expect(await collect(provider.listLibrary({ signal }))).toEqual([]);
  });

  it('offers "Log in with Premiumize" only with a registered client id', async () => {
    expect(createDebridPlugin(createPremiumizeAdapter()).manifest.configSchema.deviceLogin).toBeUndefined();
    let polls = 0;
    const http = mockHttp().on('POST', TOKEN, (req) => {
      const p = new URLSearchParams(req.body!);
      if (p.get('response_type') === 'device_code') {
        return json({ device_code: 'D', user_code: 'U-CODE', verification_uri: 'https://www.premiumize.me/device', expires_in: 600, interval: 5 });
      }
      // First poll: not yet approved (documented 400 authorization_pending); then the token.
      return ++polls === 1 ? json({ error: 'authorization_pending' }, 400) : json({ access_token: 'PM-TOKEN', token_type: 'Bearer', expires_in: 3600, scope: 'full' });
    });
    const { manifest } = createDebridPlugin(createPremiumizeAdapter({ clientId: 'registered-client', now: () => 0 }));
    expect(manifest.configSchema.deviceLogin?.label).toBe('Log in with Premiumize.me');
    const ctx = { fetch: http.fetch, logger: createTestContext().logger, signal };
    const start = await manifest.deviceFlow!.start(ctx);
    expect(start).toMatchObject({ handle: 'D', userCode: 'U-CODE', verificationUrl: 'https://www.premiumize.me/device', intervalSeconds: 5 });
    expect(await manifest.deviceFlow!.poll('D', ctx)).toEqual({ status: 'pending' });
    expect(await manifest.deviceFlow!.poll('D', ctx)).toEqual({ status: 'complete', secrets: { apiKey: 'PM-TOKEN' } });
    expect(Object.fromEntries(new URLSearchParams(http.calls[0]!.body!))).toEqual({ response_type: 'device_code', client_id: 'registered-client' });
  });
});
