import { describe, expect, it } from 'vitest';
import { json, mockHttp } from '../../../../testing/mock-http.js';
import { collect, createTestContext } from '../../../../testing/provider-context.js';
import { createDebridPlugin, type DebridSourceProvider } from '../../index.js';
import { createTorBoxAdapter } from './index.js';

// Fixtures follow the TorBox Postman collection examples (api-docs.torbox.app); values are fake.
const API = 'https://api.torbox.app/v1/api';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const signal = new AbortController().signal;
const ok = (data: unknown, detail = 'ok') => json({ success: true, error: null, detail, data });
const fail = (error: string, status: number) => json({ success: false, error, detail: error, data: null }, status);

const torrent = {
  id: 11,
  name: 'Artist - Album (2003)',
  download_finished: true,
  download_present: true,
  updated_at: '2026-01-01T00:00:00Z',
  files: [
    { id: 0, name: 'Artist - Album (2003)/01 - One.flac', short_name: '01 - One.flac', size: 100, mimetype: 'audio/flac' },
    { id: 1, name: 'Artist - Album (2003)/folder.jpg', short_name: 'folder.jpg', size: 5, mimetype: 'image/jpeg' },
  ],
};
const unfinished = { ...torrent, id: 12, download_finished: false };

function setup(opts: { retries?: boolean } = {}) {
  const http = mockHttp()
    .on('GET', `${API}/user/me`, ok({ email: 'mel@example.com', plan: 2, premium_expires_at: '2027-05-01T00:00:00Z', is_subscribed: true }))
    .on('GET', `${API}/torrents/mylist`, ok([torrent, unfinished]))
    .on('GET', `${API}/usenet/mylist`, ok([{ id: 21, name: 'Usenet Album', download_finished: true, download_present: true, files: [{ id: 3, name: 'Usenet Album/track.mp3', short_name: 'track.mp3', size: 50 }] }]))
    .on('GET', `${API}/webdl/mylist`, ok([]))
    .on('GET', `${API}/torrents/requestdl`, (req) => ok(`https://tb-cdn.example/dld/${req.url.searchParams.get('torrent_id')}-${req.url.searchParams.get('file_id')}?token=cdn`))
    .on('GET', `${API}/usenet/requestdl`, ok('https://tb-cdn.example/dld/u'));
  const ctx = createTestContext({ fetch: http.fetch, ...(opts.retries ? { retries: true } : {}) });
  const provider = createDebridPlugin(createTorBoxAdapter({ now: () => NOW })).create({ apiKey: 'tb-key', probeTags: false }, ctx) as unknown as DebridSourceProvider;
  return { http, ctx, provider };
}

describe('TorBox adapter', () => {
  it('lists files from finished torrents, usenet and web downloads (adapter)', async () => {
    const { provider, http } = setup();
    const files = await collect(provider.adapter.listFiles({ signal }));
    expect(files.map((f) => [f.id, f.name, f.path])).toEqual([
      ['t:11:0', '01 - One.flac', 'Artist - Album (2003)/01 - One.flac'],
      ['t:11:1', 'folder.jpg', 'Artist - Album (2003)/folder.jpg'],
      ['u:21:3', 'track.mp3', 'Usenet Album/track.mp3'],
    ]);
    expect(http.to(`${API}/torrents/mylist`)[0]!.url.searchParams.get('bypass_cache')).toBe('true');
    expect(http.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('does not enumerate the account into the library (retrieval-only)', async () => {
    const { provider, http } = setup();
    expect(await collect(provider.listLibrary({ signal }))).toEqual([]);
    expect(http.calls).toHaveLength(0);
  });

  it('requests a link for the exact item + file, valid for 3 hours, proxied', async () => {
    const { provider, http } = setup();
    const s = await provider.resolveStream('t:11:0', { signal });
    expect(s).toMatchObject({ url: 'https://tb-cdn.example/dld/11-0?token=cdn', redirectSafe: false, expiresAt: new Date(NOW + 3 * 3600_000) });
    const q = http.to(`${API}/torrents/requestdl`)[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({ token: 'tb-key', torrent_id: '11', file_id: '0' });
    expect((await provider.resolveStream('u:21:3', { signal })).url).toBe('https://tb-cdn.example/dld/u');
    await expect(provider.resolveStream('t:../x:1', { signal })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never logs the key that requestdl carries in its query string', async () => {
    const http = mockHttp().on('GET', `${API}/torrents/requestdl`, ok('https://x'));
    const ctx = createTestContext({ fetch: http.fetch, retries: true });
    await createDebridPlugin(createTorBoxAdapter()).create({ apiKey: 'tb-secret-key' }, ctx).resolveStream('t:1:2', { signal });
    expect(JSON.stringify(ctx.logs)).not.toContain('tb-secret-key');
  });

  it('reports account, plan and expiry', async () => {
    const { provider } = setup();
    expect(await provider.testConnection!({ signal })).toEqual({
      ok: true,
      message: 'Connected to TorBox as mel@example.com, premium until 2027-05-01.',
      details: { account: 'mel@example.com', plan: 'Pro', premiumUntil: '2027-05-01' },
    });
  });

  it('treats a lapsed plan as not premium', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/user/me`, ok({ email: 'mel@example.com', plan: 1, premium_expires_at: '2026-01-01T00:00:00Z' }));
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: false, details: { plan: 'Essential' } });
  });

  it('maps bad / expired keys to auth errors', async () => {
    const { provider, http } = setup();
    http.on('*', (u) => u.href.startsWith(API), fail('BAD_TOKEN', 403));
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: false, message: expect.stringContaining('rejected the API key') });
    await expect(collect(provider.adapter.listFiles({ signal }))).rejects.toMatchObject({ code: 'auth' });
  });

  it('maps a removed item to not_found', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/torrents/requestdl`, fail('ITEM_NOT_FOUND', 400));
    await expect(provider.resolveStream('t:11:0', { signal })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('backs off on 429 then succeeds; persistent 429 → rate_limited', async () => {
    const a = setup({ retries: true });
    a.http.on('GET', `${API}/torrents/mylist`, json({}, 429, { 'retry-after': '4' }), 1);
    expect(await collect(a.provider.adapter.listFiles({ signal }))).toHaveLength(3);
    expect(a.ctx.delays).toEqual([4000]);
    const b = setup({ retries: true });
    b.http.on('GET', `${API}/user/me`, json({}, 429));
    expect(await b.provider.testConnection!({ signal })).toMatchObject({ ok: false, message: expect.stringContaining('rate limit') });
  });

  it('maps network failures to unavailable', async () => {
    const { provider, http } = setup();
    http.fail('GET', (u) => u.href.startsWith(API));
    await expect(collect(provider.adapter.listFiles({ signal }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('handles an empty account', async () => {
    const { provider, http } = setup();
    for (const k of ['torrents', 'usenet', 'webdl']) http.on('GET', `${API}/${k}/mylist`, ok([]));
    expect(await collect(provider.adapter.listFiles({ signal }))).toEqual([]);
  });

  it('runs the device-code login', async () => {
    const http = mockHttp()
      .on('GET', `${API}/user/auth/device/start`, ok({ device_code: 'DC', code: '123456', verification_url: 'https://torbox.app/oauth/device?app=Overtone', friendly_verification_url: 'https://tor.box/link', interval: 5, expires_at: '2026-11-01T12:10:00Z' }))
      .on('POST', `${API}/user/auth/device/token`, ok({ access_token: 'TB-TOKEN', token_type: 'Bearer' }))
      .on('POST', `${API}/user/auth/device/token`, fail('DEVICE_CODE_NOT_USED', 400), 1);
    const { manifest } = createDebridPlugin(createTorBoxAdapter());
    const ctx = { fetch: http.fetch, logger: createTestContext().logger, signal };
    const start = await manifest.deviceFlow!.start(ctx);
    expect(start).toEqual({
      handle: 'DC',
      userCode: '123456',
      verificationUrl: 'https://tor.box/link',
      verificationUrlComplete: 'https://torbox.app/oauth/device?app=Overtone',
      expiresAt: new Date('2026-11-01T12:10:00Z'),
      intervalSeconds: 5,
    });
    expect(http.calls[0]!.url.searchParams.get('app')).toBe('Overtone');
    expect(await manifest.deviceFlow!.poll('DC', ctx)).toEqual({ status: 'pending' });
    expect(await manifest.deviceFlow!.poll('DC', ctx)).toEqual({ status: 'complete', secrets: { apiKey: 'TB-TOKEN' } });
    expect(JSON.parse(http.to(`${API}/user/auth/device/token`)[0]!.body!)).toEqual({ device_code: 'DC' });
    http.on('POST', `${API}/user/auth/device/token`, fail('ITEM_NOT_FOUND', 400));
    expect(await manifest.deviceFlow!.poll('DC', ctx)).toEqual({ status: 'expired' });
  });

  it('checks cache availability and reports uncached when empty', async () => {
    const http = mockHttp().on('GET', `${API}/torrents/checkcached`, ok([{ name: 'track.flac', size: 100 }]));
    const adapter = createTorBoxAdapter({ now: () => NOW }).create({ apiKey: 'tb-key' }, createTestContext({ fetch: http.fetch }));
    expect(await adapter.checkCached!({ infoHash: 'aaaa' }, { signal })).toEqual({ cached: true, files: [{ name: 'track.flac', size: 100 }] });
    expect(http.calls[0]!.url.searchParams.get('hash')).toBe('aaaa');

    http.on('GET', `${API}/torrents/checkcached`, ok(null));
    expect(await adapter.checkCached!({ infoHash: 'bbbb' }, { signal })).toEqual({ cached: false });
  });

  it('adds a magnet (JSON, non-idempotent) and reports finished status', async () => {
    const http = mockHttp()
      .on('POST', `${API}/torrents/createtorrent`, ok({ torrent_id: 33, hash: 'aaaa' }))
      .on('GET', `${API}/torrents/mylist`, ok([{ id: 33, name: 'Album', download_finished: true, download_present: true, files: [] }]));
    const adapter = createTorBoxAdapter({ now: () => NOW }).create({ apiKey: 'tb-key' }, createTestContext({ fetch: http.fetch }));
    expect(await adapter.addMagnet!('magnet:?xt=urn:btih:aaaa', { signal })).toEqual({ id: '33', status: 'queued' });
    expect(JSON.parse(http.to(`${API}/torrents/createtorrent`)[0]!.body!)).toEqual({ magnet: 'magnet:?xt=urn:btih:aaaa' });
    expect(await adapter.getStatus!('33', { signal })).toEqual({ status: 'finished' });
  });

  it('lists and resolves the files of one submitted torrent (job-scoped)', async () => {
    const http = mockHttp()
      .on('GET', `${API}/torrents/mylist`, ok([torrent]))
      .on('GET', `${API}/torrents/requestdl`, (req) => ok(`https://tb-cdn.example/dld/${req.url.searchParams.get('file_id')}`));
    const adapter = createTorBoxAdapter({ now: () => NOW }).create({ apiKey: 'tb-key' }, createTestContext({ fetch: http.fetch }));

    const files = await adapter.listTorrentFiles!('11', { signal });
    expect(files.map((f) => [f.id, f.path, f.size])).toEqual([
      ['0', 'Artist - Album (2003)/01 - One.flac', 100],
      ['1', 'Artist - Album (2003)/folder.jpg', 5],
    ]);

    const link = await adapter.resolveFileLink!('11', '0', { signal });
    expect(link.url).toBe('https://tb-cdn.example/dld/0');
    expect(Object.fromEntries(http.to(`${API}/torrents/requestdl`)[0]!.url.searchParams)).toEqual({ token: 'tb-key', torrent_id: '11', file_id: '0' });
    expect(await adapter.listTorrentFiles!('999', { signal })).toEqual([]); // unknown torrent → empty
  });
});
