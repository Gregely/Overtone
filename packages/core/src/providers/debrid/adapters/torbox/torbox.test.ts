import { describe, expect, it } from 'vitest';
import { json, mockHttp } from '../../../../testing/mock-http.js';
import { collect, createTestContext } from '../../../../testing/provider-context.js';
import { createDebridPlugin } from '../../index.js';
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
  const provider = createDebridPlugin(createTorBoxAdapter({ now: () => NOW })).create({ apiKey: 'tb-key', probeTags: false }, ctx);
  return { http, ctx, provider };
}

describe('TorBox adapter', () => {
  it('lists audio from finished torrents, usenet and web downloads', async () => {
    const { provider, http } = setup();
    const files = await collect(provider.listLibrary({ signal }));
    expect(files.map((f) => [f.id, f.name, f.path])).toEqual([
      ['t:11:0', '01 - One.flac', 'Artist - Album (2003)/01 - One.flac'],
      ['u:21:3', 'track.mp3', 'Usenet Album/track.mp3'],
    ]);
    expect(http.to(`${API}/torrents/mylist`)[0]!.url.searchParams.get('bypass_cache')).toBe('true');
    expect(http.calls.every((c) => c.method === 'GET')).toBe(true);
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
    await expect(collect(provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'auth' });
  });

  it('maps a removed item to not_found', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/torrents/requestdl`, fail('ITEM_NOT_FOUND', 400));
    await expect(provider.resolveStream('t:11:0', { signal })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('backs off on 429 then succeeds; persistent 429 → rate_limited', async () => {
    const a = setup({ retries: true });
    a.http.on('GET', `${API}/torrents/mylist`, json({}, 429, { 'retry-after': '4' }), 1);
    expect(await collect(a.provider.listLibrary({ signal }))).toHaveLength(2);
    expect(a.ctx.delays).toEqual([4000]);
    const b = setup({ retries: true });
    b.http.on('GET', `${API}/user/me`, json({}, 429));
    expect(await b.provider.testConnection!({ signal })).toMatchObject({ ok: false, message: expect.stringContaining('rate limit') });
  });

  it('maps network failures to unavailable', async () => {
    const { provider, http } = setup();
    http.fail('GET', (u) => u.href.startsWith(API));
    await expect(collect(provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('handles an empty account', async () => {
    const { provider, http } = setup();
    for (const k of ['torrents', 'usenet', 'webdl']) http.on('GET', `${API}/${k}/mylist`, ok([]));
    expect(await collect(provider.listLibrary({ signal }))).toEqual([]);
  });

  it('follows offset pagination across pages and keeps nested folder paths', async () => {
    const { provider, http } = setup();
    // A full first page (1000 items) forces a second request; only the last item has audio.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: 1000 + i, name: `Item ${i}`, download_finished: true, download_present: true, files: [] as object[] }));
    page1[999] = {
      id: 1999,
      name: 'Box Set',
      download_finished: true,
      download_present: true,
      files: [{ id: 7, name: 'Box Set/CD1/Disc Art/01 - Deep.flac', short_name: '01 - Deep.flac', size: 70 }],
    };
    const page2 = [{ id: 3000, name: 'Single', download_finished: true, download_present: true, files: [{ id: 0, name: 'single.mp3', size: 30 }] }];
    http.on('GET', `${API}/torrents/mylist`, (req) => ok(req.url.searchParams.get('offset') === '0' ? page1 : page2));
    const files = await collect(provider.listLibrary({ signal }));
    expect(files.filter((f) => f.id.startsWith('t:')).map((f) => [f.id, f.name, f.path, f.size])).toEqual([
      ['t:1999:7', '01 - Deep.flac', 'Box Set/CD1/Disc Art/01 - Deep.flac', 70],
      // No folder in the file name: the item name becomes the folder.
      ['t:3000:0', 'single.mp3', 'Single/single.mp3', 30],
    ]);
    expect(http.to(`${API}/torrents/mylist`).map((c) => [c.url.searchParams.get('offset'), c.url.searchParams.get('limit')])).toEqual([
      ['0', '1000'],
      ['1000', '1000'],
    ]);
  });

  it('stops paging when TorBox repeats a page instead of honouring offset', async () => {
    const { provider, http } = setup();
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `T${i}`, download_finished: true, download_present: true, files: [] }));
    http.on('GET', `${API}/torrents/mylist`, ok(page));
    await collect(provider.listLibrary({ signal }));
    expect(http.to(`${API}/torrents/mylist`)).toHaveLength(2);
  });

  it('imports music and skips movies, logging what was skipped and why', async () => {
    const { provider, http, ctx } = setup();
    http.on('GET', `${API}/torrents/mylist`, ok([
      torrent,
      {
        id: 13,
        name: 'Some.Movie.2020.1080p',
        download_finished: true,
        download_present: true,
        files: [
          { id: 0, name: 'Some.Movie.2020.1080p/Some.Movie.2020.1080p.mkv', short_name: 'Some.Movie.2020.1080p.mkv', size: 9_000_000, mimetype: 'video/x-matroska' },
          { id: 1, name: 'Some.Movie.2020.1080p/Subs/English.srt', short_name: 'English.srt', size: 10 },
        ],
      },
    ]));
    const files = await collect(provider.listLibrary({ signal }));
    expect(files.map((f) => f.id)).toEqual(['t:11:0', 'u:21:3']);
    const done = ctx.logs.find((l) => l.msg === 'debrid listing finished')!;
    expect(done.data).toMatchObject({ provider: 'torbox', listed: 5, audio: 2, skippedNotAudio: 3, skippedByExtension: { jpg: 1, mkv: 1, srt: 1 } });
    expect(ctx.logs.find((l) => l.msg === 'torbox listing' && l.data?.kind === 'torrents')?.data).toMatchObject({ items: 2, available: 2, files: 4 });
  });

  it('warns when the account has files but none of them are audio', async () => {
    const { provider, http, ctx } = setup();
    http.on('GET', `${API}/torrents/mylist`, ok([{ id: 1, name: 'Film', download_finished: true, download_present: true, files: [{ id: 0, name: 'Film/film.mkv', size: 5 }] }]));
    http.on('GET', `${API}/usenet/mylist`, ok([]));
    expect(await collect(provider.listLibrary({ signal }))).toEqual([]);
    expect(ctx.logs.find((l) => l.msg === 'debrid listing found no audio files')?.data).toMatchObject({ listed: 1, audio: 0, skippedByExtension: { mkv: 1 } });
  });

  it('includes items that are stored on TorBox, skips ones that are not', async () => {
    const { provider, http } = setup();
    const item = (id: number, state: Record<string, unknown>) => ({ id, name: `I${id}`, ...state, files: [{ id: 0, name: `I${id}/a.flac`, size: 1 }] });
    http.on('GET', `${API}/torrents/mylist`, ok([
      item(1, { download_finished: true, download_present: true }),
      item(2, { download_present: true }), // download_finished omitted (optional in TorBox's schema)
      item(3, { download_finished: true }), // download_present omitted
      item(4, { download_finished: true, download_present: false }), // removed from storage
      item(5, { download_finished: false, download_present: false }), // still downloading
      item(6, {}),
    ]));
    const ids = (await collect(provider.listLibrary({ signal }))).filter((f) => f.id.startsWith('t:')).map((f) => f.id);
    expect(ids).toEqual(['t:1:0', 't:2:0', 't:3:0']);
  });

  it('keeps listing the other lists when one fails, then reports the failure', async () => {
    const { provider, http, ctx } = setup();
    http.on('GET', `${API}/usenet/mylist`, fail('DATABASE_ERROR', 500));
    http.on('GET', `${API}/webdl/mylist`, ok([{ id: 31, name: 'Web', download_finished: true, download_present: true, files: [{ id: 0, name: 'Web/web.opus', size: 9 }] }]));
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const f of provider.listLibrary({ signal })) seen.push(f.id);
      })(),
    ).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('List usenet') });
    expect(seen).toEqual(['t:11:0', 'w:31:0']);
    expect(ctx.logs.find((l) => l.msg === 'torbox listing failed')?.data).toMatchObject({ kind: 'usenet', error: expect.stringContaining('DATABASE_ERROR') });
    expect(ctx.logs.find((l) => l.msg === 'debrid listing incomplete')?.data).toMatchObject({ listed: 3, audio: 2 });
  });

  it('stops at once on an auth error part-way through', async () => {
    const { provider, http } = setup();
    http.on('GET', `${API}/usenet/mylist`, fail('BAD_TOKEN', 403));
    await expect(collect(provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'auth' });
    expect(http.to(`${API}/webdl/mylist`)).toHaveLength(0);
  });

  it('turns malformed responses into clear errors', async () => {
    const a = setup();
    a.http.on('GET', `${API}/torrents/mylist`, ok({ unexpected: 'object' }));
    await expect(collect(a.provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'unavailable', message: 'List torrents: unexpected response from TorBox' });

    const b = setup();
    b.http.on('GET', `${API}/torrents/mylist`, new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(collect(b.provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('unexpected response') });

    // Broken entries inside an otherwise fine list are skipped, not fatal.
    const c = setup();
    c.http.on('GET', `${API}/torrents/mylist`, ok([null, { name: 'no id' }, { id: 5, name: 'X', download_present: true, files: [{ name: 'X/no-id.flac' }, { id: 1 }, { id: 2, name: 'X/ok.flac', size: 3 }] }]));
    expect((await collect(c.provider.listLibrary({ signal }))).map((f) => f.id)).toEqual(['t:5:2', 'u:21:3']);
  });

  it('gives slow mylist calls a longer timeout and never logs the key', async () => {
    const { http } = setup();
    const timeouts: Array<[string, unknown]> = [];
    const ctx = createTestContext({
      fetch: (async (input: string | URL, init?: RequestInit & { timeoutMs?: number }) => {
        timeouts.push([new URL(String(input)).pathname, init?.timeoutMs]);
        return http.fetch(input, init);
      }) as typeof fetch,
    });
    const provider = createDebridPlugin(createTorBoxAdapter({ now: () => NOW })).create({ apiKey: 'tb-secret-key', probeTags: false }, ctx);
    await collect(provider.listLibrary({ signal }));
    expect(timeouts).toEqual([
      ['/v1/api/torrents/mylist', 90_000],
      ['/v1/api/usenet/mylist', 90_000],
      ['/v1/api/webdl/mylist', 90_000],
    ]);
    expect(JSON.stringify(ctx.logs)).not.toContain('tb-secret-key');
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
});
