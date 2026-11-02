/**
 * 1337x scraper tests.
 *
 * These are FIXTURE tests: the HTML below is captured from 1337x's actual
 * markup (cross-checked against the py1337x reference client, which parses the
 * same `a[href*="/torrent/"]` / `td.coll-2..5` / `td.coll-date` structure).
 *
 * They are NOT live tests. The build environment cannot reach 1337x
 * (Cloudflare-fronted), so live verification is out of scope here — see the
 * final report. Do not treat a green run of this file as proof the site is
 * currently scrapeable; that requires a manual check against a reachable
 * mirror.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../providers/errors.js';
import type { IndexerContext, IndexerHit } from '../types.js';
import { mockHttp } from '../../testing/mock-http.js';
import {
  buildSearchUrl,
  createX1337Scraper,
  looksBlocked,
  parseDetailPage,
  parsePageCount,
  parseSearchResults,
  type X1337ScraperOptions,
} from './x1337.js';

const signal = new AbortController().signal;

const SEARCH_PAGE = `<!DOCTYPE html>
<html><head><title>Search</title></head><body>
<table class="table-list table table-responsive table-striped">
<thead><tr><th class="coll-1 name">Name</th><th class="coll-2">SE</th><th class="coll-3">LE</th><th class="coll-4">Time</th><th class="coll-date">Size</th><th class="coll-5">Uploader</th></tr></thead>
<tbody>
<tr>
  <td class="coll-1 name">
    <a href="/torrent/3922417/Pink-Floyd-The-Dark-Side-Of-The-Moon-1973-FLAC/" class="icon"><i class="flaticon-music"></i></a>
    <a href="/torrent/3922417/Pink-Floyd-The-Dark-Side-Of-The-Moon-1973-FLAC/">Pink Floyd - The Dark Side Of The Moon (1973) FLAC</a>
    <span class="seeds">42</span><span class="leeches">3</span>
  </td>
  <td class="coll-2 seeds">42</td>
  <td class="coll-3 leeches">3</td>
  <td class="coll-4 size">1.2 GB</td>
  <td class="coll-date">May. 1st '20</td>
  <td class="coll-5 vip"><a href="/user/SomeUploader/">SomeUploader</a></td>
</tr>
<tr>
  <td class="coll-1 name">
    <a href="/torrent/1111111/Pink-Floyd-Wish-You-Were-Here-1975-FLAC/" class="icon"><i class="flaticon-music"></i></a>
    <a href="/torrent/1111111/Pink-Floyd-Wish-You-Were-Here-1975-FLAC/">Pink Floyd - Wish You Were Here (1975) FLAC</a>
  </td>
  <td class="coll-2 seeds">7</td>
  <td class="coll-3 leeches">0</td>
  <td class="coll-4 size">950.5 MB</td>
  <td class="coll-date">Jan. 2nd '21</td>
  <td class="coll-5"><a href="/user/Other/">Other</a></td>
</tr>
</tbody>
</table>
<div class="pagination"><ul><li class="active"><a href="/search/dark+side/1/">1</a></li><li><a href="/search/dark+side/2/">2</a></li><li class="last"><a href="/search/dark+side/3/">&gt;&gt;</a></li></ul></div>
</body></html>`;

const DETAIL_PAGE = (hash: string, slug: string) => `<!DOCTYPE html>
<html><head><title>${slug}</title></head><body>
<div class="torrent-detail-page">
  <div class="box-info-heading clearfix"><h1>${slug}</h1></div>
  <div class="torrent-detail-info"><h3>${slug}</h3></div>
  <ul class="list">
    <li><a href="magnet:?xt=urn:btih:${hash}&amp;dn=${slug}&amp;tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337">Magnet Download</a></li>
    <li><a href="/torrent/3922417/download/">Torrent Download (WebSeeding)</a></li>
  </ul>
  <div class="infohash-box"><p>Information Hash</p><span>${hash.toLowerCase()}</span></div>
</div>
</body></html>`;

const HASH_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const HASH_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html' } });
}

function makeScraper(opts?: X1337ScraperOptions) {
  const mock = mockHttp();
  const def = createX1337Scraper(opts);
  const ctx: IndexerContext = {
    fetch: mock.fetch as unknown as IndexerContext['fetch'],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  return { scraper: def.create(ctx), mock };
}

async function collect(it: AsyncIterable<IndexerHit>): Promise<IndexerHit[]> {
  const out: IndexerHit[] = [];
  for await (const h of it) out.push(h);
  return out;
}

describe('1337x search results parsing', () => {
  it('extracts title, detail URL, size and seeders/leechers', () => {
    const rows = parseSearchResults(SEARCH_PAGE);
    expect(rows).toEqual([
      {
        title: 'Pink Floyd - The Dark Side Of The Moon (1973) FLAC',
        detailUrl: '/torrent/3922417/Pink-Floyd-The-Dark-Side-Of-The-Moon-1973-FLAC/',
        size: Math.round(1.2 * 1024 ** 3),
        seeders: 42,
        leechers: 3,
      },
      {
        title: 'Pink Floyd - Wish You Were Here (1975) FLAC',
        detailUrl: '/torrent/1111111/Pink-Floyd-Wish-You-Were-Here-1975-FLAC/',
        size: Math.round(950.5 * 1024 ** 2),
        seeders: 7,
        leechers: 0,
      },
    ]);
  });

  it('returns no rows when there is no results table', () => {
    expect(parseSearchResults('<html><body>no torrents here</body></html>')).toEqual([]);
  });
});

describe('1337x detail page parsing', () => {
  it('extracts magnet URI and infohash', () => {
    const d = parseDetailPage(DETAIL_PAGE(HASH_A, 'Pink Floyd - The Dark Side Of The Moon (1973) FLAC'));
    expect(d.infoHash).toBe(HASH_A.toLowerCase());
    expect(d.magnet).toContain(`xt=urn:btih:${HASH_A}`);
    expect(d.magnet).toContain('&dn='); // entities decoded
  });

  it('falls back to the infohash box when there is no magnet link', () => {
    const noMagnet = `<div class="infohash-box"><span>${HASH_B.toLowerCase()}</span></div>`;
    expect(parseDetailPage(noMagnet).infoHash).toBe(HASH_B.toLowerCase());
  });

  it('returns an empty object for a non-detail page', () => {
    expect(parseDetailPage('<html><body>nope</body></html>')).toEqual({});
  });
});

describe('1337x URL and pagination helpers', () => {
  it('builds a search URL with + separators and the page number', () => {
    expect(buildSearchUrl('https://www.1337x.to', '/search/{query}/{page}/', 'dark side of the moon', 2)).toBe(
      'https://www.1337x.to/search/dark+side+of+the+moon/2/',
    );
  });

  it('reads the last page from the pagination block', () => {
    expect(parsePageCount(SEARCH_PAGE, 1)).toBe(3);
    expect(parsePageCount('<html>no pagination</html>', 1)).toBe(1);
  });

  it('detects Cloudflare challenge pages', () => {
    expect(looksBlocked('<html><body>Just a moment... cf-browser-verification</body></html>')).toBe(true);
    expect(looksBlocked(SEARCH_PAGE)).toBe(false);
  });
});

describe('1337x scraper search (fixture)', () => {
  it('searches, hydrates detail pages and yields infohash + magnet', async () => {
    const { scraper, mock } = makeScraper({ maxPages: 1 });
    mock
      .on('GET', /\/search\/.*\/1\/$/, html(SEARCH_PAGE))
      .on('GET', /\/torrent\/3922417\//, html(DETAIL_PAGE(HASH_A, 'Pink Floyd - The Dark Side Of The Moon (1973) FLAC')))
      .on('GET', /\/torrent\/1111111\//, html(DETAIL_PAGE(HASH_B, 'Pink Floyd - Wish You Were Here (1975) FLAC')));

    const hits = await collect(scraper.search({ query: 'dark side of the moon', signal }));

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      infoHash: HASH_A.toLowerCase(),
      magnet: expect.stringContaining(`xt=urn:btih:${HASH_A}`),
      seeders: 42,
      leechers: 3,
      size: Math.round(1.2 * 1024 ** 3),
    });
    expect(hits[1]!.infoHash).toBe(HASH_B.toLowerCase());
    // Every search result detail page was fetched exactly once.
    expect(mock.to(/\/torrent\//)).toHaveLength(2);
  });

  it('follows pagination up to maxPages', async () => {
    const page2 = `<table class="table-list"><tbody><tr>
      <td class="coll-1 name"><a href="/torrent/9999999/Third-Album-FLAC/">Third Album FLAC</a></td>
      <td class="coll-2">5</td><td class="coll-3">1</td><td class="coll-4">700 MB</td><td class="coll-date">2020</td>
    </tr></tbody></table>`;
    const { scraper, mock } = makeScraper({ maxPages: 2 });
    mock
      .on('GET', /\/search\/.*\/1\/$/, html(SEARCH_PAGE))
      .on('GET', /\/search\/.*\/2\/$/, html(page2))
      .on('GET', /\/torrent\/3922417\//, html(DETAIL_PAGE(HASH_A, 'A')))
      .on('GET', /\/torrent\/1111111\//, html(DETAIL_PAGE(HASH_B, 'B')))
      .on('GET', /\/torrent\/9999999\//, html(DETAIL_PAGE('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'Third Album FLAC')));

    const hits = await collect(scraper.search({ query: 'dark side of the moon', signal }));

    expect(hits).toHaveLength(3);
    expect(hits[2]!.infoHash).toBe('cccccccccccccccccccccccccccccccccccccccc');
    expect(mock.to(/\/search\/.*\/2\/$/)).toHaveLength(1);
  });

  it('degrades gracefully when a detail page fails', async () => {
    const { scraper, mock } = makeScraper({ maxPages: 1 });
    mock
      .on('GET', /\/search\/.*\/1\/$/, html(SEARCH_PAGE))
      .on('GET', /\/torrent\/3922417\//, html(DETAIL_PAGE(HASH_A, 'A')))
      .fail('GET', /\/torrent\/1111111\//);

    const hits = await collect(scraper.search({ query: 'dark side of the moon', signal }));

    expect(hits).toHaveLength(2);
    expect(hits[0]!.infoHash).toBe(HASH_A.toLowerCase());
    // The failed detail page still yields a searchable hit, just without a hash.
    expect(hits[1]!.infoHash).toBeUndefined();
    expect(hits[1]!.magnet).toBeUndefined();
    expect(hits[1]!.title).toContain('Wish You Were Here');
  });

  it('throws a clear error when the site is blocked', async () => {
    const { scraper, mock } = makeScraper({ maxPages: 1 });
    mock.on('GET', /\/search\//, html('<html><body>Just a moment... cf-challenge</body></html>'));

    await expect(collect(scraper.search({ query: 'x', signal }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('throws a clear error on an HTTP failure', async () => {
    const { scraper, mock } = makeScraper({ maxPages: 1 });
    mock.on('GET', /\/search\//, new Response('Not Found', { status: 404 }));

    await expect(collect(scraper.search({ query: 'x', signal }))).rejects.toBeInstanceOf(ProviderError);
  });

  it('reports reachability from testConnection', async () => {
    const { scraper, mock } = makeScraper();
    mock.on('GET', 'https://www.1337x.to/', html('<html><body>1337x</body></html>'));
    await expect(scraper.testConnection!()).resolves.toEqual({ ok: true, message: 'Reachable' });

    const bad = makeScraper();
    bad.mock.on('GET', 'https://www.1337x.to/', html('<html><body>Just a moment... cf-challenge</body></html>'));
    await expect(bad.scraper.testConnection!()).resolves.toMatchObject({ ok: false });
  });
});
