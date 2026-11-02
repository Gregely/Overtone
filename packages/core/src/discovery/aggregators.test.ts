import { describe, expect, it } from 'vitest';
import { json, mockHttp } from '../testing/mock-http.js';
import { listJackettIndexers, listProwlarrIndexers } from './aggregators.js';
import type { IndexerContext } from './types.js';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ctx = (fetch: typeof globalThis.fetch): IndexerContext => ({ fetch: fetch as never, logger: noopLogger });

describe('listProwlarrIndexers', () => {
  it('maps indexers and categories and sends the API key header', async () => {
    const http = mockHttp().on('GET', 'http://prowlarr:9696/api/v1/indexer', json([
      { id: 1, name: 'Indexer A', categories: [{ id: 3000, name: 'Audio' }] },
      { id: 2, name: 'Indexer B', categories: [] },
    ]));
    const idx = await listProwlarrIndexers('http://prowlarr:9696', 'key', ctx(http.fetch));
    expect(idx).toEqual([
      { id: '1', name: 'Indexer A', categories: ['3000'] },
      { id: '2', name: 'Indexer B', categories: [] },
    ]);
    expect(http.calls[0]!.headers.get('x-api-key')).toBe('key');
  });

  it('maps a rejected key to an auth error', async () => {
    const http = mockHttp().on('GET', /indexer/, () => new Response('no', { status: 401 }));
    await expect(listProwlarrIndexers('http://prowlarr:9696', 'bad', ctx(http.fetch))).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('listJackettIndexers', () => {
  it('fetches the Torznab t=indexers endpoint and parses the XML', async () => {
    const http = mockHttp().on('GET', /torznab\/api/, () =>
      new Response('<?xml version="1.0"?><indexers><indexer id="idx1" title="One"/><indexer id="idx2" title="Two"/></indexers>', {
        headers: { 'content-type': 'application/xml' },
      }),
    );
    const idx = await listJackettIndexers('http://jackett:9117', 'key', ctx(http.fetch));
    expect(idx).toEqual([
      { id: 'idx1', name: 'One', categories: [] },
      { id: 'idx2', name: 'Two', categories: [] },
    ]);
    expect(http.calls[0]!.url.pathname).toBe('/api/v2.0/indexers/all/results/torznab/api');
    expect(http.calls[0]!.url.searchParams.get('apikey')).toBe('key');
    expect(http.calls[0]!.url.searchParams.get('t')).toBe('indexers');
  });

  it('maps a rejected key to an auth error', async () => {
    const http = mockHttp().on('GET', /torznab\/api/, () => new Response('no', { status: 403 }));
    await expect(listJackettIndexers('http://jackett:9117', 'bad', ctx(http.fetch))).rejects.toMatchObject({ code: 'auth' });
  });

  it('maps a non-XML response to unavailable', async () => {
    const http = mockHttp().on('GET', /torznab\/api/, () => new Response('this is not xml', { headers: { 'content-type': 'text/plain' } }));
    await expect(listJackettIndexers('http://jackett:9117', 'key', ctx(http.fetch))).rejects.toMatchObject({ code: 'unavailable' });
  });
});
