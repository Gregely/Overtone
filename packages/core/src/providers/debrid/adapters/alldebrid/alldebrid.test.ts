import { describe, expect, it } from 'vitest';
import { json, mockHttp } from '../../../../testing/mock-http.js';
import { collect, createTestContext } from '../../../../testing/provider-context.js';
import { createDebridPlugin, type DebridSourceProvider } from '../../index.js';
import { createAllDebridAdapter } from './index.js';

// Fixtures follow https://docs.alldebrid.com/ (v4/v4.1); ids and keys are fake.
const API = 'https://api.alldebrid.com';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const signal = new AbortController().signal;
const ok = (data: unknown) => json({ status: 'success', data });
const err = (code: string, status = 200) => json({ status: 'error', error: { code, message: code } }, status);

const tree = [
  {
    n: 'CD1',
    e: [
      { n: '01 - Opening.flac', s: 1000, l: 'https://alldebrid.com/f/AAA' },
      { n: 'scan.jpg', s: 5, l: 'https://alldebrid.com/f/IMG' },
    ],
  },
  { n: '02 - Second.flac', s: 2000, l: 'https://alldebrid.com/f/BBB' },
];

function setup(opts: { retries?: boolean } = {}) {
  const http = mockHttp()
    .on('GET', `${API}/v4/user`, ok({ user: { username: 'mel', isPremium: true, isTrial: false, premiumUntil: 1803945600 } }))
    .on('POST', `${API}/v4.1/magnet/status`, ok({ magnets: [{ id: 101, filename: 'Artist - Album', status: 'Ready', statusCode: 4, completionDate: 1767225600 }] }))
    .on('POST', `${API}/v4/magnet/files`, ok({ magnets: [{ id: '101', files: tree }] }))
    .on('GET', `${API}/v4/user/links`, ok({ links: [{ link: 'https://hoster.example/abc', filename: 'saved.mp3', size: 300, date: 1767225600, host: 'hoster' }] }))
    .on('POST', `${API}/v4/link/unlock`, (req) => {
      const link = new URLSearchParams(req.body ?? '').get('link')!;
      return ok({ link: `https://cdn.alldebrid.com/dl/${link.split('/').pop()}`, filename: 'x', filesize: 1000, host: 'alldebrid' });
    });
  const ctx = createTestContext({ fetch: http.fetch, ...(opts.retries ? { retries: true } : {}) });
  const provider = createDebridPlugin(createAllDebridAdapter({ now: () => NOW, sleep: async () => undefined })).create({ apiKey: 'ad-key', probeTags: false }, ctx) as unknown as DebridSourceProvider;
  return { http, ctx, provider };
}

describe('AllDebrid adapter', () => {
  it('lists files from ready magnets (nested file tree) and saved links (adapter)', async () => {
    const { provider, http } = setup();
    const files = await collect(provider.adapter.listFiles({ signal }));
    expect(files.map((f) => [f.id, f.path, f.size])).toEqual([
      ['m:101:CD1/01 - Opening.flac', 'Artist - Album/CD1/01 - Opening.flac', 1000],
      ['m:101:CD1/scan.jpg', 'Artist - Album/CD1/scan.jpg', 5],
      ['m:101:02 - Second.flac', 'Artist - Album/02 - Second.flac', 2000],
      [expect.stringMatching(/^l:[0-9a-f]{24}$/), 'Saved links/saved.mp3', 300],
    ]);
    expect(new URLSearchParams(http.to(`${API}/v4.1/magnet/status`)[0]!.body!).get('status')).toBe('ready');
    expect(new URLSearchParams(http.to(`${API}/v4/magnet/files`)[0]!.body!).getAll('id[]')).toEqual(['101']);
    expect(http.calls[0]!.headers.get('authorization')).toBe('Bearer ad-key');
    // Read-only: no upload/save/delete endpoints are ever called.
    expect(http.calls.map((c) => c.url.pathname).every((p) => /\/(user|magnet\/status|magnet\/files|user\/links)$/.test(p))).toBe(true);
  });

  it('does not enumerate the account into the library (retrieval-only)', async () => {
    const { provider, http } = setup();
    expect(await collect(provider.listLibrary({ signal }))).toEqual([]);
    expect(http.calls).toHaveLength(0); // no account-listing HTTP calls at all
  });

  it('unlocks only the account link of the requested file', async () => {
    const { provider, http } = setup();
    const s = await provider.resolveStream('m:101:CD1/01 - Opening.flac', { signal });
    expect(s).toMatchObject({ url: 'https://cdn.alldebrid.com/dl/AAA', redirectSafe: false });
    expect(new URLSearchParams(http.to(`${API}/v4/link/unlock`)[0]!.body!).get('link')).toBe('https://alldebrid.com/f/AAA');
    const saved = (await collect(provider.adapter.listFiles({ signal }))).find((f) => f.id.startsWith('l:'))!;
    expect((await provider.resolveStream(saved.id, { signal })).url).toBe('https://cdn.alldebrid.com/dl/abc');
  });

  it('never unlocks something that is not in the account', async () => {
    const { provider, http } = setup();
    await expect(provider.resolveStream('m:101:not-there.flac', { signal })).rejects.toMatchObject({ code: 'not_found' });
    await expect(provider.resolveStream('https://elsewhere/file', { signal })).rejects.toMatchObject({ code: 'not_found' });
    expect(http.to(`${API}/v4/link/unlock`)).toHaveLength(0);
  });

  it('waits for delayed links', async () => {
    const { provider, http } = setup();
    http.on('POST', `${API}/v4/link/unlock`, ok({ delayed: 77 }));
    http.on('POST', `${API}/v4/link/delayed`, ok({ status: 2, link: 'https://cdn.alldebrid.com/late' }));
    http.on('POST', `${API}/v4/link/delayed`, ok({ status: 1 }), 1);
    expect((await provider.resolveStream('m:101:02 - Second.flac', { signal })).url).toBe('https://cdn.alldebrid.com/late');
  });

  it('reports account, plan and expiry', async () => {
    const { provider } = setup();
    expect(await provider.testConnection!({ signal })).toEqual({
      ok: true,
      message: 'Connected to AllDebrid as mel, premium until 2027-03-02.',
      details: { account: 'mel', plan: 'Premium', premiumUntil: '2027-03-02' },
    });
  });

  it('maps a bad or expired key to an auth error', async () => {
    const { provider, http } = setup();
    http.on('*', (u) => u.href.startsWith(API), err('AUTH_BAD_APIKEY', 401));
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: false, message: expect.stringContaining('rejected the API key') });
    await expect(collect(provider.adapter.listFiles({ signal }))).rejects.toMatchObject({ code: 'auth' });
  });

  it('explains blocked requests', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/v4/user`, err('AUTH_BLOCKED'));
    expect((await provider.testConnection!({ signal })).message).toContain('blocked this request');
  });

  it('backs off on 429 then succeeds; persistent 429 → rate_limited', async () => {
    const a = setup({ retries: true });
    a.http.on('POST', `${API}/v4.1/magnet/status`, json({}, 429, { 'retry-after': '2' }), 1);
    expect(await collect(a.provider.adapter.listFiles({ signal }))).toHaveLength(4);
    expect(a.ctx.delays).toEqual([2000]);

    const b = setup({ retries: true });
    b.http.on('GET', `${API}/v4/user`, json({}, 429));
    expect(await b.provider.testConnection!({ signal })).toMatchObject({ ok: false, message: expect.stringContaining('rate limit') });
    expect(b.ctx.delays).toEqual([500, 1000]);
  });

  it('maps network failures to unavailable', async () => {
    const { provider, http } = setup();
    http.fail('*', (u) => u.href.startsWith(API));
    await expect(collect(provider.adapter.listFiles({ signal }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('handles an empty account', async () => {
    const { provider, http } = setup();
    http.on('POST', `${API}/v4.1/magnet/status`, ok({ magnets: [] }));
    http.on('GET', `${API}/v4/user/links`, ok({ links: [] }));
    expect(await collect(provider.adapter.listFiles({ signal }))).toEqual([]);
    expect(http.to(`${API}/v4/magnet/files`)).toHaveLength(0);
  });

  it('runs the PIN login flow', async () => {
    const http = mockHttp()
      .on('GET', `${API}/v4.1/pin/get`, ok({ pin: 'X7Y2', check: 'chk', expires_in: 600, user_url: 'https://alldebrid.com/pin/?pin=X7Y2', base_url: 'https://alldebrid.com/pin/' }))
      .on('POST', `${API}/v4/pin/check`, ok({ activated: true, apikey: 'NEWKEY', expires_in: 590 }))
      .on('POST', `${API}/v4/pin/check`, ok({ activated: false, expires_in: 595 }), 1);
    const { manifest } = createDebridPlugin(createAllDebridAdapter({ now: () => NOW }));
    const ctx = { fetch: http.fetch, logger: createTestContext().logger, signal };
    const start = await manifest.deviceFlow!.start(ctx);
    expect(start).toMatchObject({ userCode: 'X7Y2', verificationUrl: 'https://alldebrid.com/pin/', verificationUrlComplete: 'https://alldebrid.com/pin/?pin=X7Y2', expiresAt: new Date(NOW + 600_000) });
    expect(await manifest.deviceFlow!.poll(start.handle, ctx)).toEqual({ status: 'pending' });
    expect(await manifest.deviceFlow!.poll(start.handle, ctx)).toEqual({ status: 'complete', secrets: { apiKey: 'NEWKEY' } });
    expect(Object.fromEntries(new URLSearchParams(http.to(`${API}/v4/pin/check`)[0]!.body!))).toEqual({ check: 'chk', pin: 'X7Y2' });

    http.on('POST', `${API}/v4/pin/check`, err('PIN_EXPIRED'));
    expect(await manifest.deviceFlow!.poll(start.handle, ctx)).toEqual({ status: 'expired' });
  });

  it('checks cache availability from an info hash', async () => {
    const http = mockHttp().on('POST', `${API}/v4/magnet/instant`, ok({ magnets: [{ magnet: 'magnet:?xt=urn:btih:aaa', hash: 'aaa', instant: true }] }));
    const adapter = createAllDebridAdapter({ now: () => NOW, sleep: async () => undefined }).create({ apiKey: 'ad-key' }, createTestContext({ fetch: http.fetch }));
    expect(await adapter.checkCached!({ infoHash: 'aaa' }, { signal })).toEqual({ cached: true });
    expect(new URLSearchParams(http.to(`${API}/v4/magnet/instant`)[0]!.body!).get('magnets')).toContain('urn:btih:aaa');
  });

  it('batch-checks many hashes in one request', async () => {
    const http = mockHttp().on('POST', `${API}/v4/magnet/instant`, ok({ magnets: [
      { hash: 'aaa', instant: true },
      { hash: 'bbb', instant: false },
    ] }));
    const adapter = createAllDebridAdapter({ now: () => NOW, sleep: async () => undefined }).create({ apiKey: 'ad-key' }, createTestContext({ fetch: http.fetch }));
    const out = await adapter.checkCachedBatch!(['aaa', 'bbb', 'ccc'], { signal });
    expect(out.get('aaa')).toEqual({ cached: true });
    expect(out.get('bbb')).toEqual({ cached: false });
    expect(out.get('ccc')).toEqual({ cached: false, unknown: true }); // not reported → unknown
    expect(http.to(`${API}/v4/magnet/instant`)).toHaveLength(1); // one request, not three
  });

  it('adds a magnet (non-idempotent) and reports status', async () => {
    const http = mockHttp()
      .on('POST', `${API}/v4/magnet/upload`, ok({ magnets: [{ id: 202, hash: 'aaa' }] }))
      .on('POST', `${API}/v4.1/magnet/status`, ok({ magnets: [{ id: 202, status: 4, statusCode: 'MAGNET_IS_READY' }] }));
    const adapter = createAllDebridAdapter({ now: () => NOW, sleep: async () => undefined }).create({ apiKey: 'ad-key' }, createTestContext({ fetch: http.fetch }));
    expect(await adapter.addMagnet!('magnet:?xt=urn:btih:aaa', { signal })).toEqual({ id: '202', status: 'queued' });
    expect(await adapter.getStatus!('202', { signal })).toEqual({ status: 'finished' });
  });

  it('lists and resolves the files of one submitted torrent (job-scoped)', async () => {
    const http = mockHttp()
      .on('POST', `${API}/v4/magnet/files`, ok({ magnets: [{ id: '101', files: tree }] }))
      .on('POST', `${API}/v4/link/unlock`, (req) =>
        ok({ link: `https://cdn.alldebrid.com/dl/${new URLSearchParams(req.body ?? '').get('link')!.split('/').pop()}`, filesize: 1000 }),
      );
    const adapter = createAllDebridAdapter({ now: () => NOW, sleep: async () => undefined }).create({ apiKey: 'ad-key' }, createTestContext({ fetch: http.fetch }));

    const files = await adapter.listTorrentFiles!('101', { signal });
    expect(files.map((f) => [f.id, f.path, f.size])).toEqual([
      ['CD1/01 - Opening.flac', 'CD1/01 - Opening.flac', 1000],
      ['CD1/scan.jpg', 'CD1/scan.jpg', 5],
      ['02 - Second.flac', '02 - Second.flac', 2000],
    ]);

    expect((await adapter.resolveFileLink!('101', 'CD1/01 - Opening.flac', { signal })).url).toBe('https://cdn.alldebrid.com/dl/AAA');
    expect(new URLSearchParams(http.to(`${API}/v4/link/unlock`)[0]!.body!).get('link')).toBe('https://alldebrid.com/f/AAA');
    await expect(adapter.resolveFileLink!('101', 'missing.flac', { signal })).rejects.toMatchObject({ code: 'not_found' });
  });
});
