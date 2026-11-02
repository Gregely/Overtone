import { describe, expect, it } from 'vitest';
import { json, mockHttp } from '../../../../testing/mock-http.js';
import { collect, createTestContext } from '../../../../testing/provider-context.js';
import { createDebridPlugin, type DebridSourceProvider } from '../../index.js';
import { createRealDebridAdapter, RD_OPEN_SOURCE_CLIENT_ID } from './index.js';

// Fixtures follow the shapes documented at https://api.real-debrid.com/ (fake ids/tokens).
const API = 'https://api.real-debrid.com/rest/1.0';
const OAUTH = 'https://api.real-debrid.com/oauth/v2';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const signal = new AbortController().signal;

const torrents = [
  { id: 'TORR1', filename: 'Artist - Album (2001)', status: 'downloaded', links: ['https://real-debrid.com/d/AAA', 'https://real-debrid.com/d/BBB'], added: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z' },
  { id: 'TORR2', filename: 'Still downloading', status: 'downloading', links: [] },
];
const info1 = {
  ...torrents[0],
  files: [
    { id: 1, path: '/01 - Intro.flac', bytes: 1000, selected: 1 },
    { id: 2, path: '/cover.jpg', bytes: 10, selected: 0 },
    { id: 3, path: '/02 - Song.flac', bytes: 2000, selected: 1 },
  ],
};
const downloads = [
  { id: 'DL1', filename: 'single.mp3', filesize: 500, link: 'https://hoster.example/file/1', download: 'https://dl.real-debrid.com/x/single.mp3', generated: '2026-02-01T00:00:00.000Z' },
  { id: 'DL2', filename: '01 - Intro.flac', filesize: 1000, link: 'https://real-debrid.com/d/AAA', download: 'https://dl.real-debrid.com/y' },
];

function setup(creds: Record<string, string> = { apiKey: 'test-key' }, opts: { retries?: boolean } = {}) {
  const http = mockHttp()
    .on('GET', `${API}/user`, { username: 'mel', type: 'premium', premium: 86400, expiration: '2027-03-01T00:00:00.000Z' })
    .on('GET', `${API}/torrents`, json(torrents, 200, { 'x-total-count': '2' }))
    .on('GET', `${API}/torrents/info/TORR1`, info1)
    .on('GET', `${API}/downloads`, json(downloads, 200, { 'x-total-count': '2' }))
    .on('POST', `${API}/unrestrict/link`, (req) => {
      const link = new URLSearchParams(req.body ?? '').get('link');
      const map: Record<string, string> = {
        'https://real-debrid.com/d/AAA': '01 - Intro.flac',
        'https://real-debrid.com/d/BBB': '02 - Song.flac',
        'https://hoster.example/file/1': 'single.mp3',
      };
      return json({ filename: map[link!], filesize: 1000, mimeType: 'audio/flac', download: `https://cdn.real-debrid.com/dl/${map[link!]}` });
    });
  const ctx = createTestContext({ fetch: http.fetch, ...(opts.retries ? { retries: true } : {}) });
  const plugin = createDebridPlugin(createRealDebridAdapter({ now: () => NOW }));
  const provider = plugin.create({ ...creds, probeTags: false }, ctx) as unknown as DebridSourceProvider;
  return { http, ctx, provider, plugin };
}

describe('Real-Debrid adapter', () => {
  it('lists audio in finished torrents and existing downloads, without duplicates', async () => {
    const { provider, http } = setup();
    const files = await collect(provider.adapter.listFiles({ signal }));
    expect(files.map((f) => [f.id, f.path])).toEqual([
      ['t:TORR1:1', 'Artist - Album (2001)/01 - Intro.flac'],
      ['t:TORR1:3', 'Artist - Album (2001)/02 - Song.flac'],
      ['d:DL1', 'Downloads/single.mp3'],
    ]);
    expect(http.to(`${API}/torrents/info/TORR2`)).toHaveLength(0); // unfinished torrents are skipped
    expect(http.calls[0]!.headers.get('authorization')).toBe('Bearer test-key');
    // Read-only: nothing but GETs while listing.
    expect(http.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('caches torrent contents between scans', async () => {
    const { provider, http } = setup();
    await collect(provider.adapter.listFiles({ signal }));
    await collect(provider.adapter.listFiles({ signal }));
    expect(http.to(`${API}/torrents/info/TORR1`)).toHaveLength(1);
  });

  it('resolves a torrent file through its own link, proxy-only', async () => {
    const { provider, http } = setup();
    const s = await provider.resolveStream('t:TORR1:3', { signal });
    expect(s).toMatchObject({ url: 'https://cdn.real-debrid.com/dl/02 - Song.flac', redirectSafe: false, mimeType: 'audio/flac' });
    expect(s.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    const unrestrict = http.to(`${API}/unrestrict/link`);
    expect(new URLSearchParams(unrestrict[0]!.body!).get('link')).toBe('https://real-debrid.com/d/BBB');
  });

  it('resolves an existing download by re-unrestricting its original link', async () => {
    const { provider, http } = setup();
    expect((await provider.resolveStream('d:DL1', { signal })).url).toBe('https://cdn.real-debrid.com/dl/single.mp3');
    expect(new URLSearchParams(http.to(`${API}/unrestrict/link`)[0]!.body!).get('link')).toBe('https://hoster.example/file/1');
  });

  it('refuses to play a different file if the links↔files mapping drifted', async () => {
    const { provider, http } = setup();
    http.on('POST', `${API}/unrestrict/link`, json({ filename: 'something-else.flac', download: 'https://cdn/x' }));
    await expect(provider.resolveStream('t:TORR1:1', { signal })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects ids that are not account items (no arbitrary link unrestricting)', async () => {
    const { provider, http } = setup();
    await expect(provider.resolveStream('https://some-hoster/file', { signal })).rejects.toMatchObject({ code: 'not_found' });
    expect(http.to(`${API}/unrestrict/link`)).toHaveLength(0);
  });

  it('reports account name, plan and expiry in test connection (never the key)', async () => {
    const { provider } = setup();
    const r = await provider.testConnection!({ signal });
    expect(r).toEqual({
      ok: true,
      message: 'Connected to Real-Debrid as mel, premium until 2027-03-01.',
      details: { account: 'mel', plan: 'Premium', premiumUntil: '2027-03-01' },
    });
    expect(JSON.stringify(r)).not.toContain('test-key');
  });

  it('flags free accounts', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/user`, { username: 'mel', type: 'free', premium: 0 });
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: false, details: { plan: 'Free' } });
  });

  it('maps a bad API key to an auth error', async () => {
    const { provider, http } = setup();
    http.on('*', (u) => u.href.startsWith(API), json({ error: 'bad_token', error_code: 8 }, 401));
    expect(await provider.testConnection!({ signal })).toEqual({
      ok: false,
      message: 'Check account: Real-Debrid rejected the credentials (expired or invalid). Log in again or paste a new API key.',
    });
    await expect(collect(provider.adapter.listFiles({ signal }))).rejects.toMatchObject({ code: 'auth' });
  });

  it('refreshes an expired OAuth access token, persists it, and retries', async () => {
    const { provider, http, ctx } = setup({
      clientId: 'CID',
      clientSecret: 'CSECRET',
      accessToken: 'old-token',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(NOW + 3600_000).toISOString(),
    });
    http.on('GET', `${API}/user`, (req) =>
      req.headers.get('authorization') === 'Bearer new-token' ? json({ username: 'mel', type: 'premium' }) : json({ error: 'bad_token', error_code: 8 }, 401),
    );
    http.on('POST', `${OAUTH}/token`, json({ access_token: 'new-token', expires_in: 3600, refresh_token: 'refresh-2', token_type: 'Bearer' }));
    expect((await provider.testConnection!({ signal })).ok).toBe(true);
    const refresh = new URLSearchParams(http.to(`${OAUTH}/token`)[0]!.body!);
    expect(Object.fromEntries(refresh)).toEqual({ client_id: 'CID', client_secret: 'CSECRET', code: 'refresh-1', grant_type: 'http://oauth.net/grant_type/device/1.0' });
    expect(ctx.secretUpdates).toEqual([{ accessToken: 'new-token', accessTokenExpiresAt: new Date(NOW + 3600_000).toISOString(), refreshToken: 'refresh-2' }]);
  });

  it('asks to log in again when the refresh token is revoked', async () => {
    const { provider, http } = setup({ clientId: 'C', clientSecret: 'S', refreshToken: 'dead', accessToken: 'x', accessTokenExpiresAt: new Date(NOW - 1).toISOString() });
    http.on('POST', `${OAUTH}/token`, json({ error: 'invalid_grant' }, 400));
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: false, message: expect.stringContaining('Log in again') });
  });

  it('backs off on 429 (honouring Retry-After) and then succeeds', async () => {
    const { provider, http, ctx } = setup({ apiKey: 'k' }, { retries: true });
    http.on('GET', `${API}/user`, json({ error: 'too_many_requests', error_code: 34 }, 429, { 'retry-after': '3' }), 1);
    expect((await provider.testConnection!({ signal })).ok).toBe(true);
    expect(ctx.delays).toEqual([3000]);
  });

  it('reports rate limiting when 429s persist', async () => {
    const { provider, http, ctx } = setup({ apiKey: 'k' }, { retries: true });
    http.on('GET', `${API}/torrents`, json({ error: 'too_many_requests', error_code: 34 }, 429));
    await expect(collect(provider.adapter.listFiles({ signal }))).rejects.toMatchObject({ code: 'rate_limited' });
    expect(ctx.delays).toEqual([500, 1000]);
  });

  it('maps network failures to "unavailable"', async () => {
    const { provider, http } = setup();
    http.fail('GET', `${API}/user`);
    expect(await provider.testConnection!({ signal })).toEqual({ ok: false, message: "Check account: couldn't reach the service" });
  });

  it('handles an empty account (204 No Content)', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/torrents`, new Response(null, { status: 204 }));
    http.on('GET', `${API}/downloads`, new Response(null, { status: 204 }));
    expect(await collect(provider.adapter.listFiles({ signal }))).toEqual([]);
  });

  it('pages through large accounts', async () => {
    const { provider, http } = setup();
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: `T${i}`, filename: `t${i}`, status: 'downloading', links: [] }));
    http.on('GET', (u) => u.pathname.endsWith('/torrents') && u.searchParams.get('page') === '1', json(many, 200, { 'x-total-count': '1001' }));
    http.on('GET', (u) => u.pathname.endsWith('/torrents') && u.searchParams.get('page') === '2', json([torrents[0]], 200, { 'x-total-count': '1001' }));
    const files = await collect(provider.adapter.listFiles({ signal }));
    expect(files.filter((f) => f.id.startsWith('t:'))).toHaveLength(2);
    expect(http.to(`${API}/torrents`).map((c) => c.url.searchParams.get('limit'))).toEqual(['1000', '1000']);
  });

  describe('device login', () => {
    it('runs the documented open-source device flow and returns credentials', async () => {
      const http = mockHttp()
        .on('GET', `${OAUTH}/device/code`, { device_code: 'DEV', user_code: 'ABCD1234', interval: 5, expires_in: 1800, verification_url: 'https://real-debrid.com/device' })
        .on('GET', `${OAUTH}/device/credentials`, { client_id: 'USERCID', client_secret: 'USERSECRET' })
        .on('GET', `${OAUTH}/device/credentials`, json({ error: 'authorization_pending' }, 403), 1) // first poll: not yet approved
        .on('POST', `${OAUTH}/token`, { access_token: 'AT', expires_in: 3600, refresh_token: 'RT', token_type: 'Bearer' });
      const { manifest } = createDebridPlugin(createRealDebridAdapter({ now: () => NOW }));
      const ctx = { fetch: http.fetch, logger: createTestContext().logger, signal };
      const start = await manifest.deviceFlow!.start(ctx);
      expect(start).toEqual({ handle: 'DEV', userCode: 'ABCD1234', verificationUrl: 'https://real-debrid.com/device', expiresAt: new Date(NOW + 1800_000), intervalSeconds: 5 });
      expect(http.calls[0]!.url.searchParams.get('client_id')).toBe(RD_OPEN_SOURCE_CLIENT_ID);
      expect(http.calls[0]!.url.searchParams.get('new_credentials')).toBe('yes');
      expect(await manifest.deviceFlow!.poll('DEV', ctx)).toEqual({ status: 'pending' });
      expect(await manifest.deviceFlow!.poll('DEV', ctx)).toEqual({
        status: 'complete',
        secrets: { clientId: 'USERCID', clientSecret: 'USERSECRET', accessToken: 'AT', refreshToken: 'RT', accessTokenExpiresAt: new Date(NOW + 3600_000).toISOString() },
      });
      expect(Object.fromEntries(new URLSearchParams(http.to(`${OAUTH}/token`)[0]!.body!))).toMatchObject({ client_id: 'USERCID', code: 'DEV' });
    });

    it('declares the generic "Log in with" schema feature', () => {
      const { manifest } = createDebridPlugin(createRealDebridAdapter());
      expect(manifest.configSchema.deviceLogin).toMatchObject({ label: 'Log in with Real-Debrid', replaces: ['apiKey', 'clientId', 'clientSecret', 'accessToken', 'refreshToken', 'accessTokenExpiresAt'] });
      expect(manifest.capabilities?.redirectable).toBe(false);
    });
  });
});
