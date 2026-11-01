import { describe, expect, it } from 'vitest';
import { json, mockHttp, type RecordedRequest } from '../../testing/mock-http.js';
import { collect, createTestContext } from '../../testing/provider-context.js';
import { subsonicPlugin, subsonicToken } from './index.js';

// Fixtures follow the Subsonic / OpenSubsonic docs (subsonic-response envelope, Child fields).
const BASE = 'https://music.example.com';
const signal = new AbortController().signal;

const okEnv = (extra: object = {}, os = true) =>
  json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...(os ? { type: 'navidrome', serverVersion: '0.60.0', openSubsonic: true } : {}), ...extra } });
const failEnv = (code: number, message = 'nope') => json({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } });

const song = (i: number, extra: object = {}) => ({
  id: `s${i}`,
  isDir: false,
  title: `Song ${i}`,
  album: 'Album',
  artist: 'Artist',
  displayAlbumArtist: 'Artist',
  track: i,
  discNumber: 1,
  year: 2004,
  genre: 'Rock',
  size: 1000 + i,
  suffix: 'flac',
  contentType: 'audio/flac',
  duration: 200,
  path: `Artist/Album/0${i} - Song ${i}.flac`,
  created: '2026-01-01T00:00:00Z',
  mediaType: 'song',
  musicBrainzId: '0E1B6C43-2F0F-4C5A-9D2A-7A3C1F0E0001',
  ...extra,
});

function setup(config: Record<string, unknown> = { url: `${BASE}/`, username: 'mel', password: 'sesame' }, opts: { retries?: boolean; openSubsonic?: boolean } = {}) {
  const os = opts.openSubsonic ?? true;
  const http = mockHttp()
    .on('GET', `${BASE}/rest/ping.view`, () => okEnv({}, os))
    .on('GET', `${BASE}/rest/search3.view`, (r: RecordedRequest) =>
      okEnv({ searchResult3: r.url.searchParams.get('songOffset') === '0' ? { song: [song(1), song(2), { ...song(3), isVideo: true, mediaType: 'video', suffix: 'mp4', path: 'v.mp4' }] } : {} }, os),
    )
    .on('GET', `${BASE}/rest/getAlbumList2.view`, (r: RecordedRequest) =>
      okEnv({ albumList2: r.url.searchParams.get('offset') === '0' ? { album: [{ id: 'al1', name: 'Album', songCount: 2 }] } : { album: [] } }, os),
    )
    .on('GET', `${BASE}/rest/getAlbum.view`, () => okEnv({ album: { id: 'al1', name: 'Album', song: [song(1), song(2)] } }, os));
  const ctx = createTestContext({ fetch: http.fetch, ...(opts.retries ? { retries: true } : {}) });
  const provider = subsonicPlugin.create(config as never, ctx);
  return { http, ctx, provider };
}

describe('Subsonic provider', () => {
  it('computes tokens exactly as documented (md5(password + salt))', () => {
    expect(subsonicToken('sesame', 'c19b2d')).toBe('26719a1196d2a940705a59634eb18eab');
  });

  it('uses salted-token auth with a fresh salt per request, never the password', async () => {
    const { provider, http } = setup();
    await collect(provider.listLibrary({ signal }));
    const salts = new Set<string>();
    for (const c of http.calls) {
      const q = c.url.searchParams;
      expect(q.get('u')).toBe('mel');
      expect(q.get('t')).toBe(subsonicToken('sesame', q.get('s')!));
      expect(q.has('p')).toBe(false);
      expect(c.url.href).not.toContain('sesame');
      expect(q.get('v')).toBe('1.16.1');
      expect(q.get('c')).toBe('Overtone');
      salts.add(q.get('s')!);
    }
    expect(salts.size).toBe(http.calls.length);
  });

  it('lists all songs on OpenSubsonic via empty-query search3, with tags, skipping videos', async () => {
    const { provider, http } = setup();
    const files = await collect(provider.listLibrary({ signal }));
    expect(files.map((f) => [f.id, f.path, f.mimeType])).toEqual([
      ['s1', 'Artist/Album/01 - Song 1.flac', 'audio/flac'],
      ['s2', 'Artist/Album/02 - Song 2.flac', 'audio/flac'],
    ]);
    expect(files[0]!.tags).toEqual({
      title: 'Song 1',
      artist: 'Artist',
      albumArtist: 'Artist',
      album: 'Album',
      trackNumber: 1,
      discNumber: 1,
      year: 2004,
      genre: ['Rock'],
      durationMs: 200_000,
      musicbrainz: { recordingId: '0e1b6c43-2f0f-4c5a-9d2a-7a3c1f0e0001' },
    });
    const search = http.to(`${BASE}/rest/search3.view`)[0]!.url.searchParams;
    expect(Object.fromEntries([...search].filter(([k]) => ['query', 'songCount', 'songOffset', 'albumCount', 'artistCount'].includes(k)))).toEqual({
      query: '',
      songCount: '500',
      songOffset: '0',
      artistCount: '0',
      albumCount: '0',
    });
    expect(http.to(`${BASE}/rest/getAlbumList2.view`)).toHaveLength(0);
  });

  it('pages through large libraries', async () => {
    const { provider, http } = setup();
    http.on('GET', `${BASE}/rest/search3.view`, (r: RecordedRequest) => {
      const offset = Number(r.url.searchParams.get('songOffset'));
      const n = offset === 0 ? 500 : offset === 500 ? 7 : 0;
      return okEnv({ searchResult3: { song: Array.from({ length: n }, (_, i) => song(offset + i + 1)) } });
    });
    expect(await collect(provider.listLibrary({ signal }))).toHaveLength(507);
    expect(http.to(`${BASE}/rest/search3.view`).map((c) => c.url.searchParams.get('songOffset'))).toEqual(['0', '500']);
  });

  it('falls back to getAlbumList2 + getAlbum on classic Subsonic servers', async () => {
    const { provider, http } = setup(undefined, { openSubsonic: false });
    const files = await collect(provider.listLibrary({ signal }));
    expect(files.map((f) => f.id)).toEqual(['s1', 's2']);
    expect(http.to(`${BASE}/rest/search3.view`)).toHaveLength(0);
    expect(http.to(`${BASE}/rest/getAlbumList2.view`)[0]!.url.searchParams.get('type')).toBe('alphabeticalByName');
  });

  it('streams the original file through the server only (credentials are in the URL)', async () => {
    const { provider } = setup();
    const s = await provider.resolveStream('s1', { signal });
    const u = new URL(s.url);
    expect(u.pathname).toBe('/rest/stream.view');
    expect(u.searchParams.get('id')).toBe('s1');
    expect(u.searchParams.get('format')).toBe('raw');
    expect(s.redirectSafe).toBe(false);
    expect(subsonicPlugin.manifest.capabilities?.redirectable).toBe(false);
  });

  it('supports OpenSubsonic API keys without u/t/s', async () => {
    const { provider, http } = setup({ url: BASE, apiKey: 'os-key' });
    await provider.testConnection!({ signal });
    const q = http.calls[0]!.url.searchParams;
    expect(q.get('apiKey')).toBe('os-key');
    expect(['u', 't', 's', 'p'].some((k) => q.has(k))).toBe(false);
  });

  it('reports the server in test connection', async () => {
    const { provider } = setup();
    expect(await provider.testConnection!({ signal })).toEqual({
      ok: true,
      message: 'Connected to navidrome 0.60.0 (API 1.16.1, OpenSubsonic).',
      details: { server: 'navidrome', apiVersion: '1.16.1', openSubsonic: 'true' },
    });
  });

  it.each([
    [40, 'auth', 'wrong username or password'],
    [44, 'auth', 'invalid API key'],
    [41, 'config', 'Use an API key instead'],
    [50, 'auth', "isn't allowed"],
  ])('maps Subsonic error %i', async (code, kind, text) => {
    const { provider, http } = setup();
    http.on('GET', (u) => u.href.startsWith(`${BASE}/rest/`), failEnv(code));
    expect((await provider.testConnection!({ signal })).message).toContain(text);
    await expect(collect(provider.listLibrary({ signal }))).rejects.toMatchObject({ code: kind });
  });

  it('requires credentials', async () => {
    const { provider } = setup({ url: BASE, username: 'mel' });
    expect((await provider.testConnection!({ signal })).message).toMatch(/username and password, or an API key/);
  });

  it('explains a URL that is not a Subsonic server', async () => {
    const { provider, http } = setup();
    http.on('GET', `${BASE}/rest/ping.view`, new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
    expect((await provider.testConnection!({ signal })).message).toContain("doesn't look like a Subsonic server");
  });

  it('backs off on 429 then succeeds; persistent 429 → rate_limited', async () => {
    const a = setup(undefined, { retries: true });
    a.http.on('GET', `${BASE}/rest/ping.view`, json({}, 429, { 'retry-after': '2' }), 1);
    expect((await a.provider.testConnection!({ signal })).ok).toBe(true);
    expect(a.ctx.delays).toEqual([2000]);
    const b = setup(undefined, { retries: true });
    b.http.on('GET', `${BASE}/rest/ping.view`, json({}, 429));
    await expect(collect(b.provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('maps network failures to unavailable', async () => {
    const { provider, http } = setup();
    http.fail('GET', (u) => u.href.startsWith(BASE));
    await expect(collect(provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('handles an empty library (search3 without a song array)', async () => {
    const { provider, http } = setup();
    http.on('GET', `${BASE}/rest/search3.view`, okEnv({ searchResult3: {} }));
    http.on('GET', `${BASE}/rest/getAlbumList2.view`, okEnv({ albumList2: {} }));
    expect(await collect(provider.listLibrary({ signal }))).toEqual([]);
  });
});
