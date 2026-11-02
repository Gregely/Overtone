/**
 * Transport parity: the web app's two ApiClient transports must give the
 * same answers for the same library.
 *
 *   HttpTransport ──HTTP──▶ Fastify server ─┐
 *                                           ├─▶ CoreApi (same code)
 *   EmbeddedTransport ──in-process router ──┘
 *
 * Both sides get identical fixtures (a fake remote provider, the same
 * FakeMusicBrainz), go through the same steps (create the source via the
 * API, scan, match), and then every read call is compared. The embedded
 * side runs on each database driver. What differs by design is normalized:
 * random ids, cover URLs (server: tokenized artwork URL; standalone: a
 * Cover Art Archive reference) and stream links (server: signed proxy URL;
 * standalone: the provider's own link).
 */
import { createCore, createEmbeddedRouter, MemoryBlobStore, MemorySecretStore, ProviderRegistry, systemClock, type OvertoneCore, type ProviderPlugin } from '@overtone/core';
import { TEST_DATABASES } from '@overtone/core/testing';
import type { StreamUrlsResponseDto } from '@overtone/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, HttpTransport, type ApiClient } from '../../web/src/api/client.js';
import { EmbeddedTransport, embeddedCoverUrl } from '../../web/src/api/embedded.js';
import { builtinPlugins } from './providers/index.js';
import { createHarness } from './testing/app-harness.js';
import { credit, FakeMusicBrainz, release } from './testing/fake-musicbrainz.js';

const homework = release('11111111-1111-4111-8111-111111111111', 'Homework', credit('Daft Punk'), [
  ['Daftendirekt', 164000],
  ['Revolution 909', 335000],
  ['Da Funk', 329000],
]);
const discovery = release('22222222-2222-4222-8222-222222222222', 'Discovery', credit('Daft Punk'), [
  ['One More Time', 320000],
  ['Aerodynamic', 212000],
]);

const FILES = [
  ['Homework/01 Daftendirekt.mp3', 'Daftendirekt', 'Homework', 1, 164000],
  ['Homework/02 Revolution 909.mp3', 'Revolution 909', 'Homework', 2, 335000],
  ['Homework/03 Da Funk.mp3', 'Da Funk', 'Homework', 3, 329000],
  ['Discovery/01 One More Time.mp3', 'One More Time', 'Discovery', 1, 320000],
  ['Discovery/02 Aerodynamic.mp3', 'Aerodynamic', 'Discovery', 2, 212000],
  ['Unsorted/mystery.mp3', 'Mystery Jam', 'Garage Tapes', 1, 100000],
] as const;

/** Same plugin on both sides. */
const remotePlugin: ProviderPlugin = {
  manifest: {
    id: 'fake-remote',
    name: 'Fake remote',
    description: 'Parity fixture',
    category: 'server',
    capabilities: { testConnection: true },
    configSchema: { fields: [{ key: 'token', type: 'secret', label: 'Token', required: true }] },
  },
  create(config) {
    return {
      async *listLibrary() {
        for (const [path, title, album, track, durationMs] of FILES) {
          yield {
            id: path,
            name: path.split('/').at(-1)!,
            path,
            size: 1000 + track,
            mimeType: 'audio/mpeg',
            tags: { title, artist: album === 'Garage Tapes' ? 'Nobody' : 'Daft Punk', album, trackNumber: track, durationMs },
          };
        }
      },
      async resolveStream(id) {
        return { url: `https://cdn.example/${encodeURIComponent(id)}?k=${String(config.token)}`, expiresAt: new Date(Date.now() + 3600_000) };
      },
      async readTags() {
        return null;
      },
      async testConnection() {
        return { ok: true, message: `Connected with ${String(config.token).length}-character token` };
      },
    };
  },
};

/** A fixed clock on both sides, so "recently added" ordering doesn't depend on timing. */
const NOW = Date.parse('2026-11-01T12:00:00Z');

/** HttpTransport over Fastify's in-memory request injection. */
function injectFetch(app: Awaited<ReturnType<typeof createHarness>>['app']): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const res = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(init.body ? { payload: String(init.body) } : {}),
    });
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: res.headers as Record<string, string> });
  }) as typeof fetch;
}

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), remove: async (k: string) => void m.delete(k) };
};

/** Replace what legitimately differs between the two modes. */
function normalize(value: unknown, sourceId: string): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll(sourceId, '<source>')
      // Cover URLs differ by design: the server returns a tokenized artwork URL for
      // every release (it fetches/extracts on request); standalone references the
      // Cover Art Archive, or null until an embedded picture has been extracted.
      .replace(/"coverUrl":("[^"]*"|null)/g, '"coverUrl":"<cover>"')
      .replace(/"(lastScanAt|startedAt|finishedAt)":"[^"]*"/g, '"$1":"<time>"'),
  );
}

/** Home's "Rediscover" row is ORDER BY random() by design: compare it as a set. */
function sortRandom(v: unknown): unknown {
  const h = v as { random?: Array<{ title: string }> };
  return h && Array.isArray(h.random) ? { ...h, random: [...h.random].sort((x, y) => x.title.localeCompare(y.title)) } : v;
}

/** Calls compared verbatim (after normalization). */
const READS: Array<[string, string]> = [
  ['home (stats + recently added)', '/api/library/home'],
  ['artists', '/api/library/artists'],
  ['artists, filtered', '/api/library/artists?q=daft'],
  ['albums by name', '/api/library/albums'],
  ['albums by year, paged', '/api/library/albums?sort=year&limit=1&offset=1'],
  ['albums by artist', '/api/library/albums?sort=artist'],
  ['tracks by name', '/api/library/tracks'],
  ['tracks by artist', '/api/library/tracks?sort=artist&limit=4'],
  ['tracks, filtered', '/api/library/tracks?q=funk'],
  ['search', '/api/search?q=one'],
  ['search, empty', '/api/search?q=%20'],
  ['files needing review', '/api/library/files?status=unmatched'],
  ['all files', '/api/library/files?limit=500'],
  ['providers', '/api/providers'],
  ['sources', '/api/sources'],
  ['scan status', '/api/scan/status'],
];

describe.each(TEST_DATABASES)('HttpTransport vs EmbeddedTransport ($name)', (factory) => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  let http: HttpTransport;
  let httpSourceId: string;
  let core: OvertoneCore;
  let embedded: ApiClient;
  let embeddedSourceId: string;

  beforeAll(async () => {
    // Server side: the real Fastify app, reached through HttpTransport.
    harness = await createHarness({ plugins: [remotePlugin], mb: new FakeMusicBrainz([homework, discovery]), skipSetup: true, now: () => NOW });
    http = new HttpTransport({ storage: memoryStorage(), serverUrl: 'http://overtone.test', fetch: injectFetch(harness.app), withLock: (_n, fn) => fn() });
    await http.setup({ username: 'admin', password: 'password1' });
    httpSourceId = (await http.post<{ id: string }>('/api/sources', { providerId: 'fake-remote', name: 'Remote', config: { token: 'secret-token' } })).id;
    await harness.services.scanner.scanSource(httpSourceId);
    await harness.services.matchWorker.drain();

    // Standalone side: core in-process, reached through EmbeddedTransport.
    const registry = new ProviderRegistry();
    for (const p of [...builtinPlugins, remotePlugin]) registry.register(p);
    core = createCore({
      db: await factory.open(),
      registry,
      secrets: new MemorySecretStore(),
      torrentSecrets: new MemorySecretStore(),
      blobs: new MemoryBlobStore(),
      mb: new FakeMusicBrainz([homework, discovery]),
      version: 'test',
      contact: 'test@example.com',
      clock: { ...systemClock, now: () => NOW },
    });
    embedded = new EmbeddedTransport({ handle: createEmbeddedRouter(core, { version: 'test', coverUrl: embeddedCoverUrl }) });
    embeddedSourceId = (await embedded.post<{ id: string }>('/api/sources', { providerId: 'fake-remote', name: 'Remote', config: { token: 'secret-token' } })).id;
    await core.scanner.scanSource(embeddedSourceId);
    await core.matchWorker.drain();
  });

  afterAll(async () => {
    await core?.close();
    await harness?.close();
  });

  it.each(READS)('%s', async (_label, path) => {
    const [a, b] = await Promise.all([http.get(path), embedded.get(path)]).then((r) => r.map(sortRandom));
    expect(normalize(b, embeddedSourceId)).toEqual(normalize(a, httpSourceId));
  });

  it('album, artist and track detail', async () => {
    const albums = await http.get<{ items: Array<{ id: number }> }>('/api/library/albums');
    const albumsB = await embedded.get<{ items: Array<{ id: number }> }>('/api/library/albums');
    for (const [i, a] of albums.items.entries()) {
      const [x, y] = await Promise.all([http.get(`/api/library/albums/${a.id}`), embedded.get(`/api/library/albums/${albumsB.items[i]!.id}`)]);
      expect(normalize(y, embeddedSourceId)).toEqual(normalize(x, httpSourceId));
    }
    const artists = await http.get<{ items: Array<{ id: number }> }>('/api/library/artists');
    const artistsB = await embedded.get<{ items: Array<{ id: number }> }>('/api/library/artists');
    for (const [i, a] of artists.items.entries()) {
      expect(normalize(await embedded.get(`/api/library/artists/${artistsB.items[i]!.id}`), embeddedSourceId)).toEqual(
        normalize(await http.get(`/api/library/artists/${a.id}`), httpSourceId),
      );
    }
    const tracks = await http.get<{ items: Array<{ id: number }> }>('/api/library/tracks?sort=artist');
    const tracksB = await embedded.get<{ items: Array<{ id: number }> }>('/api/library/tracks?sort=artist');
    for (const [i, t] of tracks.items.entries()) {
      expect(normalize(await embedded.get(`/api/library/tracks/${tracksB.items[i]!.id}`), embeddedSourceId)).toEqual(
        normalize(await http.get(`/api/library/tracks/${t.id}`), httpSourceId),
      );
    }
  });

  it('source detail, connection test and device-login errors', async () => {
    expect(normalize(await embedded.get(`/api/sources/${embeddedSourceId}`), embeddedSourceId)).toEqual(
      normalize(await http.get(`/api/sources/${httpSourceId}`), httpSourceId),
    );
    expect(await embedded.post(`/api/sources/${embeddedSourceId}/test`, {})).toEqual(await http.post(`/api/sources/${httpSourceId}/test`, {}));
    expect(await embedded.post('/api/providers/fake-remote/test', { config: { token: 'abc' } })).toEqual(
      await http.post('/api/providers/fake-remote/test', { config: { token: 'abc' } }),
    );
  });

  /** Same status, code and fields for the same mistakes. */
  it.each<[string, (c: ApiClient) => Promise<unknown>]>([
    ['unknown album', (c) => c.get('/api/library/albums/9999')],
    ['unknown artist', (c) => c.get('/api/library/artists/9999')],
    ['unknown file', (c) => c.get('/api/library/files/9999')],
    ['unknown source', (c) => c.get('/api/sources/nope')],
    ['bad page size', (c) => c.get('/api/library/albums?limit=0')],
    ['bad status filter', (c) => c.get('/api/library/files?status=bogus')],
    ['unknown provider', (c) => c.post('/api/sources', { providerId: 'nope' })],
    ['missing required secret', (c) => c.post('/api/sources', { providerId: 'fake-remote', config: {} })],
    ['unknown body field', (c) => c.post('/api/stream-urls', { trackIds: [1], extra: true })],
    ['match to a non-uuid', (c) => c.post('/api/library/files/1/match', { recordingMbid: 'nope' })],
    ['provider without device login', (c) => c.post('/api/providers/fake-remote/device-login', {})],
  ])('error: %s', async (_label, call) => {
    const fail = async (c: ApiClient) => {
      try {
        await call(c);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const e = err as ApiError;
        return { status: e.status, code: e.code, fields: e.fields };
      }
      throw new Error('expected an error');
    };
    expect(await fail(embedded)).toEqual(await fail(http));
  });

  it('stream links: same choice of source and shape; the URL is the proxy (server) or the provider link (standalone)', async () => {
    const ids = async (c: ApiClient) => [...(await c.get<{ items: Array<{ id: number }> }>('/api/library/tracks?sort=artist&limit=2')).items.map((t) => t.id), 999];
    const [a, b] = await Promise.all([
      http.post<StreamUrlsResponseDto>('/api/stream-urls', { trackIds: await ids(http) }),
      embedded.post<StreamUrlsResponseDto>('/api/stream-urls', { trackIds: await ids(embedded) }),
    ]);
    expect(a.items).toHaveLength(2);
    const shape = (r: StreamUrlsResponseDto, id: string) =>
      normalize({ ...r, items: r.items.map(({ url: _u, expiresAt: _e, trackId: _t, ...rest }) => rest) }, id);
    expect(shape(b, embeddedSourceId)).toEqual(shape(a, httpSourceId));
    expect(a.items[0]!.url).toMatch(/^\/api\/stream\/\d+\?st=/);
    expect(b.items[0]!.url).toMatch(/^https:\/\/cdn\.example\//);
    expect(a.unavailable).toEqual([999]);
  });

  it('writes behave the same: rename, disable (library empties), re-enable', async () => {
    const steps: Array<(c: ApiClient, id: string) => Promise<unknown>> = [
      (c, id) => c.patch(`/api/sources/${id}`, { name: 'Renamed', priority: 3 }),
      (c, id) => c.patch(`/api/sources/${id}`, { enabled: false }),
      (c) => c.get('/api/library/home').then(sortRandom),
      (c, id) => c.patch(`/api/sources/${id}`, { enabled: true }),
      (c) => c.get('/api/library/albums'),
    ];
    for (const step of steps) {
      const [x, y] = [await step(http, httpSourceId), await step(embedded, embeddedSourceId)];
      expect(normalize(y, embeddedSourceId)).toEqual(normalize(x, httpSourceId));
    }
  });
});
