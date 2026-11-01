import { describe, expect, it } from 'vitest';
import { json, mockHttp, type RecordedRequest } from '../../testing/mock-http.js';
import { collect, createTestContext } from '../../testing/provider-context.js';
import { buildQuery, chooseFiles, createInternetArchivePlugin, isOpenLicense, parseLength } from './index.js';

// Fixtures modelled on real scrape + metadata API responses (shapes per archive.org docs).
const IA = 'https://archive.org';
const signal = new AbortController().signal;

const md = (id: string, license: string | undefined, files: object[]) => ({
  created: 1767225600,
  dir: `/1/items/${id}`,
  metadata: { identifier: id, title: `Album ${id}`, creator: 'Netlabel Artist', date: '2018-07-10', mediatype: 'audio', collection: ['netlabels'], ...(license ? { licenseurl: license } : {}) },
  files,
});
const audioFiles = [
  { name: '01 Opening.flac', source: 'original', format: 'Flac', size: '9000', length: '540.03', title: 'Opening', creator: 'Netlabel Artist', album: 'Album cc1', track: '1/2', mtime: '1642768391' },
  { name: '01 Opening.mp3', source: 'derivative', format: 'VBR MP3', size: '3000', length: '540.03', original: '01 Opening.flac' },
  { name: '01 Opening.ogg', source: 'derivative', format: 'Ogg Vorbis', size: '2500', original: '01 Opening.flac' },
  { name: '02 Closing.mp3', source: 'original', format: 'VBR MP3', size: '4000', length: '9:05', title: 'Closing', track: '2/2' },
  { name: 'cover.jpg', source: 'original', format: 'JPEG', size: '100' },
  { name: 'cc1_files.xml', source: 'metadata', format: 'Metadata' },
];

function setup(config: Record<string, unknown> = { query: 'netlabels', format: 'best', maxItems: 10 }, opts: { retries?: boolean } = {}) {
  const sleeps: number[] = [];
  const http = mockHttp()
    .on('GET', `${IA}/services/search/v1/scrape`, (r: RecordedRequest) =>
      r.url.searchParams.get('cursor')
        ? json({ items: [{ identifier: 'cc2', licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/' }], count: 1, total: 4 })
        : json({
            items: [
              { identifier: 'cc1', title: 'Album cc1', creator: 'Netlabel Artist', licenseurl: 'https://creativecommons.org/licenses/by-sa/4.0/' },
              { identifier: 'allrights', title: 'Not open' },
              { identifier: 'liar', licenseurl: 'https://creativecommons.org/licenses/by/3.0/' },
            ],
            count: 3,
            total: 4,
            cursor: 'NEXT',
          }),
    )
    .on('GET', `${IA}/metadata/cc1`, md('cc1', 'https://creativecommons.org/licenses/by-sa/4.0/', audioFiles))
    // The search index said CC, but the item itself has no licence: excluded.
    .on('GET', `${IA}/metadata/liar`, md('liar', undefined, audioFiles))
    .on('GET', `${IA}/metadata/cc2`, md('cc2', 'http://creativecommons.org/publicdomain/zero/1.0/', [{ name: 'track.ogg', source: 'original', format: 'Ogg Vorbis', size: '10' }]));
  const ctx = createTestContext({ fetch: http.fetch, ...(opts.retries ? { retries: true } : {}) });
  const plugin = createInternetArchivePlugin({ delayMs: 250, sleep: async (ms) => void sleeps.push(ms), now: () => 1_000_000 });
  return { http, ctx, sleeps, provider: plugin.create(config as never, ctx) };
}

describe('Internet Archive provider', () => {
  it('lists only CC / public-domain audio from the configured collection', async () => {
    const { provider, http } = setup();
    const files = await collect(provider.listLibrary({ signal }));
    expect(files.map((f) => [f.id, f.path])).toEqual([
      ['cc1/01 Opening.flac', 'Netlabel Artist/Album cc1/01 Opening.flac'],
      ['cc1/02 Closing.mp3', 'Netlabel Artist/Album cc1/02 Closing.mp3'],
      ['cc2/track.ogg', 'Netlabel Artist/Album cc2/track.ogg'],
    ]);
    expect(http.to(`${IA}/metadata/allrights`)).toHaveLength(0); // filtered before fetching
    const q = http.to(`${IA}/services/search/v1/scrape`)[0]!.url.searchParams;
    expect(q.get('q')).toBe('collection:netlabels AND mediatype:(audio OR etree)');
    expect(Number(q.get('count'))).toBeGreaterThanOrEqual(100);
    expect(http.to(`${IA}/services/search/v1/scrape`)[1]!.url.searchParams.get('cursor')).toBe('NEXT');
  });

  it('maps file metadata to tags', async () => {
    const { provider } = setup();
    const [opening, closing] = await collect(provider.listLibrary({ signal }));
    expect(opening!.tags).toEqual({
      title: 'Opening',
      artist: 'Netlabel Artist',
      albumArtist: 'Netlabel Artist',
      album: 'Album cc1',
      trackNumber: 1,
      trackTotal: 2,
      year: 2018,
      durationMs: 540_030,
    });
    expect(closing!.tags?.durationMs).toBe(545_000);
  });

  it('is polite: pauses between metadata requests and caches items', async () => {
    const { provider, http, sleeps } = setup();
    await collect(provider.listLibrary({ signal }));
    expect(sleeps).toEqual([250, 250]);
    await collect(provider.listLibrary({ signal }));
    expect(http.to(`${IA}/metadata/cc1`)).toHaveLength(1);
  });

  it('respects maxItems', async () => {
    const { provider } = setup({ query: 'netlabels', format: 'best', maxItems: 1 });
    expect((await collect(provider.listLibrary({ signal }))).map((f) => f.id)).toEqual(['cc1/01 Opening.flac', 'cc1/02 Closing.mp3']);
  });

  it('honours the format preference per track', () => {
    expect(chooseFiles(audioFiles, 'best').map((f) => f.name)).toEqual(['01 Opening.flac', '02 Closing.mp3']);
    expect(chooseFiles(audioFiles, 'mp3').map((f) => f.name)).toEqual(['01 Opening.mp3', '02 Closing.mp3']);
    expect(chooseFiles(audioFiles, 'ogg').map((f) => f.name)).toEqual(['01 Opening.ogg']);
    expect(chooseFiles(audioFiles, 'flac').map((f) => f.name)).toEqual(['01 Opening.flac']);
  });

  it('resolves to the public, credential-free download URL', async () => {
    const { provider } = setup();
    expect(await provider.resolveStream('cc1/01 Opening.flac', { signal })).toEqual({
      url: 'https://archive.org/download/cc1/01%20Opening.flac',
      redirectSafe: true,
      mimeType: 'audio/flac',
    });
    await expect(provider.resolveStream('cc1/../../etc', { signal })).rejects.toMatchObject({ code: 'not_found' });
    await expect(provider.resolveStream('bad id/x.mp3', { signal })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('uses advanced queries as given', () => {
    expect(buildQuery('creator:"Kevin MacLeod"')).toBe('(creator:"Kevin MacLeod") AND mediatype:(audio OR etree)');
  });

  it.each([
    ['https://creativecommons.org/licenses/by-nc-sa/4.0/', true],
    ['http://creativecommons.org/publicdomain/mark/1.0/', true],
    ['https://creativecommons.org/publicdomain/zero/1.0/', true],
    ['http://www.gnu.org/licenses/gpl.html', false],
    ['https://example.com/creativecommons.org/licenses/by/4.0', false],
    [undefined, false],
  ])('licence %s → %s', (url, expected) => expect(isOpenLicense(url)).toBe(expected));

  it('parses lengths', () => {
    expect(parseLength('212.5')).toBe(212_500);
    expect(parseLength('03:32')).toBe(212_000);
    expect(parseLength('1:00:00')).toBe(3_600_000);
    expect(parseLength('n/a')).toBeNull();
  });

  it('reports matches in test connection', async () => {
    const { provider } = setup();
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: true, message: 'Found 4 audio items; 2 of the first 3 are openly licensed.' });
  });

  it('surfaces a rejected query', async () => {
    const { provider, http } = setup();
    http.on('GET', `${IA}/services/search/v1/scrape`, json({ error: "count '10' is too small (min count=100)", errorType: 'RangeException' }));
    expect((await provider.testConnection!({ signal })).message).toContain('rejected the query');
  });

  it('honours 429 Retry-After with backoff; persistent 429 → rate_limited', async () => {
    const a = setup(undefined, { retries: true });
    a.http.on('GET', `${IA}/metadata/cc1`, json({}, 429, { 'retry-after': '5' }), 1);
    expect(await collect(a.provider.listLibrary({ signal }))).toHaveLength(3);
    expect(a.ctx.delays).toEqual([5000]);
    const b = setup(undefined, { retries: true });
    b.http.on('GET', `${IA}/services/search/v1/scrape`, json({}, 429));
    await expect(collect(b.provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('maps network failures to unavailable', async () => {
    const { provider, http } = setup();
    http.fail('GET', (u) => u.href.startsWith(IA));
    await expect(collect(provider.listLibrary({ signal }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('handles an empty collection', async () => {
    const { provider, http } = setup();
    http.on('GET', `${IA}/services/search/v1/scrape`, json({ items: [], count: 0, total: 0 }));
    expect(await collect(provider.listLibrary({ signal }))).toEqual([]);
    expect((await provider.testConnection!({ signal })).ok).toBe(false);
  });
});
