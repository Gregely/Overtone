import { describe, expect, it } from 'vitest';
import { mockHttp } from '../testing/mock-http.js';
import type { IndexerContext } from './types.js';
import { createTorznabIndexer, toHit } from './torznab.js';
import { parseXml } from './xml.js';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ctx(fetch: typeof globalThis.fetch): IndexerContext {
  return { fetch: fetch as never, logger: noopLogger };
}

const rss = (items: string): string =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Test Indexer</title>${items}</channel></rss>`;

const item = (body: string): string => `<item>${body}</item>`;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('Torznab client', () => {
  it('maps an item to a hit with magnet, size, seeders and category', async () => {
    const mock = mockHttp();
    mock.on('GET', /api\?/, () =>
      new Response(
        rss(
          item(`
            <title>Artist - Album (2020) FLAC</title>
            <guid>https://indexer/torrent/123</guid>
            <category>3040</category>
            <size>350000000</size>
            <pubDate>Sat, 01 Jan 2020 00:00:00 +0000</pubDate>
            <torznab:attr name="seeders" value="42"/>
            <torznab:attr name="peers" value="3"/>
            <torznab:attr name="infohash" value="abcdef0123456789abcdef0123456789abcdef01"/>
            <torznab:attr name="category" value="3040"/>
            <torznab:attr name="files" value="12"/>
          `),
        ),
        { headers: { 'content-type': 'application/xml' } },
      ),
    );

    const indexer = createTorznabIndexer({ url: 'https://indexer/api', apiKey: 'secret' }, ctx(mock.fetch));
    const hits = await collect(indexer.search({ query: 'Artist Album', signal: new AbortController().signal }));

    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.title).toBe('Artist - Album (2020) FLAC');
    expect(h.infoHash).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(h.magnet).toBe('magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01');
    expect(h.size).toBe(350000000);
    expect(h.seeders).toBe(42);
    expect(h.leechers).toBe(3);
    expect(h.category).toBe('3040');
    expect(h.files).toBe(12);
    expect(h.publishDate?.getUTCFullYear()).toBe(2020);
  });

  it('builds a magnet from the infohash when no magneturl is present', () => {
    const hit = toHit(parseXml(item(`<title>X</title><torznab:attr name="infohash" value="AAAA"/></item>`)));
    expect(hit?.magnet).toBe('magnet:?xt=urn:btih:aaaa');
  });

  it('sends the api key as a query param and header', async () => {
    const mock = mockHttp();
    mock.on('GET', /api\?/, () => new Response(rss(''), { headers: { 'content-type': 'application/xml' } }));
    const indexer = createTorznabIndexer({ url: 'https://indexer/api', apiKey: 'sekrit' }, ctx(mock.fetch));
    await collect(indexer.search({ query: 'q', categories: ['3000'], signal: new AbortController().signal }));

    expect(mock.calls).toHaveLength(1);
    const url = mock.calls[0]!.url;
    expect(url.searchParams.get('t')).toBe('search');
    expect(url.searchParams.get('q')).toBe('q');
    expect(url.searchParams.get('apikey')).toBe('sekrit');
    expect(url.searchParams.get('cat')).toBe('3000');
    expect(mock.calls[0]!.headers.get('x-api-key')).toBe('sekrit');
  });

  it('reports an auth error for HTTP 403', async () => {
    const mock = mockHttp();
    mock.on('GET', /api\?/, () => new Response('forbidden', { status: 403 }));
    const indexer = createTorznabIndexer({ url: 'https://indexer/api', apiKey: 'bad' }, ctx(mock.fetch));
    await expect(collect(indexer.search({ query: 'q', signal: new AbortController().signal }))).rejects.toMatchObject({
      code: 'auth',
    });
  });

  it('testConnection succeeds on a parseable (even empty) reply and fails on an XML error', async () => {
    const mock = mockHttp();
    mock.on('GET', /api\?/, () => new Response(rss(''), { headers: { 'content-type': 'application/xml' } }));
    const indexer = createTorznabIndexer({ url: 'https://indexer/api', apiKey: 'k' }, ctx(mock.fetch));
    const ok = await indexer.testConnection!();
    expect(ok.ok).toBe(true);

    const bad = mockHttp();
    bad.on('GET', /api\?/, () => new Response('{"status":"error"}', { headers: { 'content-type': 'application/json' } }));
    const idx2 = createTorznabIndexer({ url: 'https://indexer/api', apiKey: 'k' }, ctx(bad.fetch));
    const res = await idx2.testConnection!();
    expect(res.ok).toBe(false);
  });
});
