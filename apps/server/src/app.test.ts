import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderPlugin, ResolvedStream, SourceFile } from './providers/types.js';
import { createHarness } from './testing/app-harness.js';
import { makeMp3 } from './testing/audio-fixtures.js';
import { credit, FakeMusicBrainz, release } from './testing/fake-musicbrainz.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
afterEach(async () => h?.close());

const UPSTREAM_KEY = 'upstream-api-key-9f8e7d';

// ── A fake remote provider whose behaviour each test controls ──────────────
const remote = {
  files: [] as SourceFile[],
  resolve: vi.fn(async (_fileId: string, _opts: { forceRefresh?: boolean }): Promise<ResolvedStream> => ({ url: 'https://cdn.test/a' })),
};
const remotePlugin: ProviderPlugin = {
  manifest: {
    id: 'fake-remote',
    name: 'Fake remote',
    description: '',
    category: 'debrid',
    capabilities: { redirectable: true },
    configSchema: { fields: [{ key: 'token', type: 'secret', label: 'Token', required: true }] },
  },
  create: () => ({
    async *listLibrary() {
      yield* remote.files;
    },
    resolveStream: (id, opts) => remote.resolve(id, opts),
  }),
};

const AUDIO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

/** Upstream CDN double: honours Range, records requests. */
function cdn(status = (_url: string) => 200) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers });
    const code = status(url);
    if (code !== 200) return new Response('nope', { status: code });
    const range = /bytes=(\d+)-(\d*)/.exec(headers.get('range') ?? '');
    const common = { 'content-type': 'audio/mpeg', 'set-cookie': 'session=leak', 'x-upstream-secret': UPSTREAM_KEY, 'accept-ranges': 'bytes' };
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : AUDIO.length - 1;
      return new Response(AUDIO.subarray(start, end + 1), {
        status: 206,
        headers: { ...common, 'content-range': `bytes ${start}-${end}/${AUDIO.length}`, 'content-length': String(end - start + 1) },
      });
    }
    return new Response(AUDIO, { status: 200, headers: { ...common, 'content-length': String(AUDIO.length) } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests, mock: fetch };
}

async function addRemoteSource(streamMode: 'proxy' | 'redirect' = 'proxy') {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: h.auth,
    payload: { providerId: 'fake-remote', name: 'Remote', streamMode, config: { token: 't' } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function scanAndMatch(sourceId: string) {
  const report = await h.services.scanner.scanSource(sourceId);
  await h.services.matchWorker.drain();
  return report;
}

async function streamUrlFor(trackId: number) {
  const res = await h.app.inject({ method: 'POST', url: '/api/stream-urls', headers: h.auth, payload: { trackIds: [trackId] } });
  return res.json().items[0].url as string;
}

async function firstTrackId() {
  return (await h.app.inject({ url: '/api/library/tracks', headers: h.auth })).json().items[0].id as number;
}

beforeEach(() => {
  remote.files = [{ id: 'f1', name: '01 - Song.mp3', path: 'Artist/Album/01 - Song.mp3', size: AUDIO.length, tags: { title: 'Song', artist: 'Artist', album: 'Album' } }];
  remote.resolve.mockReset();
  remote.resolve.mockImplementation(async () => ({
    url: `https://cdn.test/file?apikey=${UPSTREAM_KEY}`,
    headers: { authorization: `Bearer ${UPSTREAM_KEY}` },
  }));
});

// ── Auth ────────────────────────────────────────────────────────────────────

describe('auth API', () => {
  it('runs first-run setup, protects routes, refreshes and logs out', async () => {
    h = await createHarness({ skipSetup: true });
    expect((await h.app.inject({ url: '/api/auth/status' })).json()).toMatchObject({ setupRequired: true, multiUser: false });
    expect((await h.app.inject({ url: '/api/library/home' })).statusCode).toBe(401);

    const setup = (await h.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'me', password: 'password1' } })).json();
    expect((await h.app.inject({ url: '/api/auth/status' })).json().setupRequired).toBe(false);
    const me = await h.app.inject({ url: '/api/me', headers: { authorization: `Bearer ${setup.accessToken}` } });
    expect(me.json()).toEqual({ id: 1, username: 'me', isAdmin: true });

    const refreshed = await h.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: setup.refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    await h.app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refreshToken: refreshed.json().refreshToken } });
    const after = await h.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: refreshed.json().refreshToken } });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('invalid_refresh_token');
  });

  it('rate-limits login attempts', async () => {
    h = await createHarness();
    const codes = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong-pass' } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('allows Capacitor origins via CORS and ignores unknown ones', async () => {
    h = await createHarness();
    const pre = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/library/home',
      headers: { origin: 'https://localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(pre.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(String(pre.headers['access-control-allow-headers'])).toMatch(/Authorization/);
    const evil = await h.app.inject({ url: '/api/health', headers: { origin: 'https://evil.test' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ── Local library end to end ───────────────────────────────────────────────

describe('local folder library', () => {
  let music: string;
  beforeEach(async () => {
    music = await mkdtemp(path.join(tmpdir(), 'overtone-music-'));
    await mkdir(path.join(music, 'Daft Punk/Homework'), { recursive: true });
    for (const [i, t] of ['Revolution 909', 'Da Funk'].entries()) {
      await writeFile(
        path.join(music, `Daft Punk/Homework/0${i + 1} - ${t}.mp3`),
        makeMp3({ title: t, artist: 'Daft Punk', albumArtist: 'Daft Punk', album: 'Homework', track: String(i + 3) }),
      );
    }
  });
  afterEach(async () => rm(music, { recursive: true, force: true }));

  const DAFTENDIREKT = 'aaaaaaaa-0000-4000-8000-000000000001';
  const tracks: Array<[string, number, string]> = [
    ['Daftendirekt', 164_000, DAFTENDIREKT],
    ['WDPK 83.7 FM', 28_000, 'aaaaaaaa-0000-4000-8000-000000000002'],
    ['Revolution 909', 326_000, 'aaaaaaaa-0000-4000-8000-000000000003'],
    ['Da Funk', 329_000, 'aaaaaaaa-0000-4000-8000-000000000004'],
  ];
  const homework = release('11111111-1111-4111-8111-111111111111', 'Homework', credit('Daft Punk'), tracks);
  const reissue = release('33333333-3333-4333-8333-333333333333', 'Homework (25th Anniversary)', credit('Daft Punk'), tracks, {
    date: '2022-01-20',
  });

  it('scans, matches, browses, searches and streams with Range support', async () => {
    h = await createHarness({ mb: new FakeMusicBrainz([homework]) });
    const src = await h.services.sources.create({ providerId: 'local-folder', name: 'Music', config: { path: music, watch: false } });
    const report = await scanAndMatch(src.id);
    expect(report).toMatchObject({ added: 2, removed: 0, error: null });

    const home = (await h.app.inject({ url: '/api/library/home', headers: h.auth })).json();
    expect(home.stats).toEqual({ artists: 1, albums: 1, tracks: 2, pendingMatches: 0, needsReview: 0, unmatched: 0 });
    const album = home.recentlyAdded[0];
    expect(album).toMatchObject({ title: 'Homework', mbid: homework.id, artistCredit: 'Daft Punk', trackCount: 2, attention: 0 });
    expect(album.coverUrl).toMatch(/^\/api\/artwork\/release\/\d+\?at=/);

    const detail = (await h.app.inject({ url: `/api/library/albums/${album.id}`, headers: h.auth })).json();
    expect(detail.tracks.map((t: { trackNo: number; title: string }) => [t.trackNo, t.title])).toEqual([
      [3, 'Revolution 909'],
      [4, 'Da Funk'],
    ]);
    expect(detail.tracks[0].sources).toEqual([{ sourceId: src.id, sourceName: 'Music', providerId: 'local-folder', category: 'local' }]);
    expect(detail.tracks.map((t: { matchStatus: string }) => t.matchStatus)).toEqual(['matched', 'matched']);

    const search = (await h.app.inject({ url: '/api/search?q=funk', headers: h.auth })).json();
    expect(search.tracks.map((t: { title: string }) => t.title)).toEqual(['Da Funk']);

    const url = await streamUrlFor(detail.tracks[1].id);
    const full = await h.app.inject({ url });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/mpeg');
    const size = Number(full.headers['content-length']);
    const part = await h.app.inject({ url, headers: { range: 'bytes=10-19' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${size}`);
    expect(part.rawPayload).toEqual(full.rawPayload.subarray(10, 20));
    expect((await h.app.inject({ url, headers: { range: `bytes=${size}-` } })).statusCode).toBe(416);

    // Tokens are per-file: reusing one for another file fails.
    const other = url.replace(/\/api\/stream\/(\d+)/, (_m, id) => `/api/stream/${Number(id) + 1}`);
    expect((await h.app.inject({ url: other })).statusCode).toBe(401);
    // ...and the token never shows up in logs.
    expect(h.logs()).not.toContain(url.split('st=')[1]!);
  });

  it('keeps unmatched files browsable from tags, and supports manual fixes', async () => {
    h = await createHarness({ mb: new FakeMusicBrainz([homework, reissue]) });
    const src = await h.services.sources.create({ providerId: 'local-folder', config: { path: music, watch: false } });
    await h.services.scanner.scanSource(src.id); // tagged, not matched yet
    const before = (await h.app.inject({ url: '/api/library/albums', headers: h.auth })).json();
    expect(before.items).toMatchObject([{ title: 'Homework', mbid: null }]);

    await h.services.matchWorker.drain();
    const files = (await h.app.inject({ url: '/api/library/files', headers: h.auth })).json().items;
    const daFunk = files.find((f: { name: string }) => f.name.includes('Da Funk'));
    expect(daFunk.matchStatus).toBe('matched');

    expect(
      (await h.app.inject({ method: 'POST', url: `/api/library/files/${daFunk.id}/match`, headers: h.auth, payload: { recordingMbid: 'nope' } }))
        .statusCode,
    ).toBe(400);

    // Pin it to a different recording on the release.
    const pinned = await h.app.inject({
      method: 'POST',
      url: `/api/library/files/${daFunk.id}/match`,
      headers: h.auth,
      payload: { recordingMbid: DAFTENDIREKT, releaseMbid: homework.id },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ matchStatus: 'manual', matchScore: 1 });
    const track = (await h.app.inject({ url: `/api/library/tracks/${pinned.json().trackId}`, headers: h.auth })).json();
    expect(track).toMatchObject({ title: 'Daftendirekt', trackNo: 1, mbid: DAFTENDIREKT });

    // Manual matches survive rescans and match passes.
    await scanAndMatch(src.id);
    expect((await h.services.library.fileDto(daFunk.id))?.matchStatus).toBe('manual');

    // Rematch puts it back in the automatic queue.
    await h.app.inject({ method: 'POST', url: `/api/library/files/${daFunk.id}/rematch`, headers: h.auth });
    await h.services.matchWorker.drain();
    expect(await h.services.library.fileDto(daFunk.id)).toMatchObject({ matchStatus: 'matched' });

    // Album-level fix: move the whole album to the reissue.
    const albumId = track.album.id;
    const moved = await h.app.inject({
      method: 'POST',
      url: `/api/library/albums/${albumId}/match`,
      headers: h.auth,
      payload: { releaseMbid: reissue.id },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().album).toMatchObject({ title: 'Homework (25th Anniversary)', mbid: reissue.id, trackCount: 2 });
    expect((await h.app.inject({ url: '/api/library/albums', headers: h.auth })).json().total).toBe(1);
  });

  it('shows unmatched files from their tags with a match status and review counts', async () => {
    h = await createHarness({ mb: new FakeMusicBrainz([]) }); // MusicBrainz knows nothing
    const src = await h.services.sources.create({ providerId: 'local-folder', config: { path: music, watch: false } });
    await scanAndMatch(src.id);
    const albums = (await h.app.inject({ url: '/api/library/albums', headers: h.auth })).json().items;
    expect(albums).toMatchObject([{ title: 'Homework', mbid: null, attention: 2 }]);
    const tracks = (await h.app.inject({ url: '/api/library/tracks', headers: h.auth })).json().items;
    expect(tracks.map((t: { matchStatus: string; title: string }) => [t.title, t.matchStatus])).toEqual([
      ['Da Funk', 'unmatched'],
      ['Revolution 909', 'unmatched'],
    ]);
    const status = (await h.app.inject({ url: '/api/scan/status', headers: h.auth })).json();
    expect(status.matching).toMatchObject({ pending: 0, unmatched: 2, needsReview: 0 });
  });

  it('removes deleted files and keeps everything when a listing comes back empty', async () => {
    h = await createHarness();
    const src = await h.services.sources.create({ providerId: 'local-folder', config: { path: music, watch: false } });
    await scanAndMatch(src.id);
    await rm(path.join(music, 'Daft Punk/Homework/01 - Revolution 909.mp3'));
    expect(await scanAndMatch(src.id)).toMatchObject({ removed: 1, unchanged: 1 });

    await rm(path.join(music, 'Daft Punk'), { recursive: true }); // e.g. a drive that failed to mount
    const r = await scanAndMatch(src.id);
    expect(r.removed).toBe(0);
    expect(r.error).toMatch(/no files/);
    expect((await h.services.library.stats()).tracks).toBe(1);
  });

  it('hides tracks from disabled sources', async () => {
    h = await createHarness();
    const src = await h.services.sources.create({ providerId: 'local-folder', config: { path: music, watch: false } });
    await scanAndMatch(src.id);
    expect((await h.services.library.stats()).tracks).toBe(2);
    await h.services.sources.update(src.id, { enabled: false });
    expect((await h.services.library.stats()).tracks).toBe(0);
  });
});

// ── Remote streaming ───────────────────────────────────────────────────────

describe('remote streaming', () => {
  it('proxies with Range, sends provider headers upstream, and never leaks them back', async () => {
    const up = cdn();
    h = await createHarness({ plugins: [remotePlugin], fetch: up.fetch });
    await scanAndMatch(await addRemoteSource());
    const url = await streamUrlFor(await firstTrackId());

    const res = await h.app.inject({ url, headers: { range: 'bytes=100-199' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 100-199/1000');
    expect(res.rawPayload).toEqual(AUDIO.subarray(100, 200));
    const sent = up.requests.at(-1)!;
    expect(sent.headers.get('authorization')).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(sent.headers.get('range')).toBe('bytes=100-199');

    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-upstream-secret']).toBeUndefined();
    expect(JSON.stringify(res.headers)).not.toContain(UPSTREAM_KEY);
    expect(h.logs()).not.toContain(UPSTREAM_KEY);
  });

  it('redirects only when the source opts in AND the link is credential-free', async () => {
    const up = cdn();
    h = await createHarness({ plugins: [remotePlugin], fetch: up.fetch });
    const id = await addRemoteSource('redirect');
    await scanAndMatch(id);
    const url = await streamUrlFor(await firstTrackId());

    // Link has credentials (headers) → proxied despite redirect mode.
    expect((await h.app.inject({ url })).statusCode).toBe(200);

    remote.resolve.mockImplementation(async () => ({ url: 'https://public.test/song.mp3', redirectSafe: true }));
    h.services.resolver.invalidate(id);
    const redirected = await h.app.inject({ url });
    expect(redirected.statusCode).toBe(302);
    expect(redirected.headers.location).toBe('https://public.test/song.mp3');

    // Same safe link, proxy mode → proxied.
    await h.services.sources.update(id, { streamMode: 'proxy' });
    expect((await h.app.inject({ url })).statusCode).toBe(200);
  });

  it('re-resolves once when an upstream link has expired', async () => {
    let n = 0;
    const up = cdn((u) => (u.includes('old') ? 403 : 200));
    remote.resolve.mockImplementation(async () => ({ url: n++ === 0 ? 'https://cdn.test/old' : 'https://cdn.test/new' }));
    h = await createHarness({ plugins: [remotePlugin], fetch: up.fetch });
    await scanAndMatch(await addRemoteSource());
    remote.resolve.mockClear();
    n = 0;
    const url = await streamUrlFor(await firstTrackId());

    const res = await h.app.inject({ url });
    expect(res.statusCode).toBe(200);
    expect(remote.resolve).toHaveBeenCalledTimes(2);
    expect(remote.resolve.mock.calls[1]![1]).toMatchObject({ forceRefresh: true });
    expect(up.requests.map((r) => r.url).slice(-2)).toEqual(['https://cdn.test/old', 'https://cdn.test/new']);

    // The fresh link is cached for the next request.
    await h.app.inject({ url });
    expect(remote.resolve).toHaveBeenCalledTimes(2);
  });

  it('reports dead files as 404 after the retry also fails', async () => {
    const up = cdn(() => 404);
    h = await createHarness({ plugins: [remotePlugin], fetch: up.fetch });
    await scanAndMatch(await addRemoteSource());
    const res = await h.app.inject({ url: await streamUrlFor(await firstTrackId()) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('provider_not_found');
  });

  it('probes remote files for tags when the listing has none', async () => {
    const tagged = makeMp3({ title: 'Probed Title', artist: 'Probed Artist', album: 'Probed Album' });
    const fetch = vi.fn(async () => new Response(new Uint8Array(tagged), { status: 206, headers: { 'content-type': 'audio/mpeg' } }));
    remote.files = [{ id: 'x', name: 'track.mp3', path: 'track.mp3', size: tagged.length, mimeType: 'audio/mpeg' }];
    h = await createHarness({ plugins: [remotePlugin], fetch: fetch as unknown as typeof globalThis.fetch });
    await scanAndMatch(await addRemoteSource());
    const t = (await h.app.inject({ url: '/api/library/tracks', headers: h.auth })).json().items[0];
    expect(t).toMatchObject({ title: 'Probed Title', artistCredit: 'Probed Artist', album: { title: 'Probed Album' } });
    expect(new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('range')).toBe('bytes=0-262143');
  });
});

// ── Artwork ────────────────────────────────────────────────────────────────

describe('artwork', () => {
  it('fetches from the Cover Art Archive once, then serves from disk', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const fetch = vi.fn(async (u: string | URL | Request) =>
      String(u).startsWith('https://coverartarchive.org/release/')
        ? new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
        : new Response('x', { status: 404 }),
    );
    const rel = release('22222222-2222-4222-8222-222222222222', 'Album', credit('Artist'), [['Song', 1000]]);
    h = await createHarness({ plugins: [remotePlugin], fetch: fetch as unknown as typeof globalThis.fetch, mb: new FakeMusicBrainz([rel]) });
    await scanAndMatch(await addRemoteSource());
    const album = (await h.app.inject({ url: '/api/library/albums', headers: h.auth })).json().items[0];
    expect(album.mbid).toBe(rel.id);

    const a = await h.app.inject({ url: `${album.coverUrl}&size=250` });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toBe('image/jpeg');
    expect(a.rawPayload).toEqual(jpeg);
    await h.app.inject({ url: `${album.coverUrl}&size=250` });
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('front-250'))).toHaveLength(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(`https://coverartarchive.org/release/${rel.id}/front-250`);

    expect((await h.app.inject({ url: `/api/artwork/release/${album.id}` })).statusCode).toBe(401);
  });
});

// ── Web app hosting ────────────────────────────────────────────────────────

describe('web app hosting', () => {
  it('serves the SPA with a fallback for deep links, and never for /api', async () => {
    const web = await mkdtemp(path.join(tmpdir(), 'overtone-web-'));
    await mkdir(path.join(web, 'assets'));
    await writeFile(path.join(web, 'index.html'), '<!doctype html><title>Overtone</title>');
    await writeFile(path.join(web, 'assets', 'app-abc123.js'), 'console.log(1)');
    await writeFile(path.join(web, 'sw.js'), 'self.x=1');
    h = await createHarness({ config: { webDir: web } });

    const root = await h.app.inject({ url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Overtone</title>');
    const deep = await h.app.inject({ url: '/albums/12?x=1' });
    expect(deep.body).toContain('<title>Overtone</title>');
    expect(deep.headers['cache-control']).toBe('no-cache');

    const asset = await h.app.inject({ url: '/assets/app-abc123.js' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await h.app.inject({ url: '/sw.js' })).headers['cache-control']).toBe('no-cache');
    expect((await h.app.inject({ url: '/assets/missing.js' })).statusCode).toBe(404);

    const api = await h.app.inject({ url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
    expect(root.headers['referrer-policy']).toBe('no-referrer');
    await rm(web, { recursive: true, force: true });
  });
});
