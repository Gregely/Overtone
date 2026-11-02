import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { createDatabase, syncHandleDriver } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { silentLogger } from '../logging.js';
import { MemorySecretStore } from '../platform/types.js';
import { TorrentSourceManager } from './manager.js';
import { TorrentIndexerRegistry } from './registry.js';
import { DiscoveryService } from './service.js';
import type { IndexerHit, TorrentIndexerDefinition } from './types.js';
import type { DiscoveryTarget } from './query-builder.js';
import type { DebridService } from '../providers/debrid/service.js';

const target: DiscoveryTarget = { scope: 'album', title: 'Led Zeppelin IV', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', year: 1971 };

function hit(o: Partial<IndexerHit> & { title: string }): IndexerHit {
  return { id: o.title, size: null, seeders: null, leechers: null, category: null, publishDate: null, files: null, ...o };
}

type Handler = (url: string, query: string) => IndexerHit[] | Promise<IndexerHit[]>;

function fakeRegistry(handler: Handler): TorrentIndexerRegistry {
  const registry = new TorrentIndexerRegistry();
  const def: TorrentIndexerDefinition = {
    id: 'torznab',
    name: 'Fake',
    create(config) {
      return {
        id: 'torznab',
        name: config.url,
        capabilities: () => ({ search: true, categories: true }),
        async *search({ query, signal }) {
          signal.throwIfAborted();
          for (const h of await handler(config.url, query)) yield h;
        },
      };
    },
  };
  registry.register(def);
  return registry;
}

async function setup(handler: Handler, cacheTtlMs = 60_000, debrid?: DebridService) {
  const db = createDatabase(syncHandleDriver(new Sqlite(':memory:')));
  await migrate(db);
  const secrets = new MemorySecretStore();
  const manager = new TorrentSourceManager({ db, registry: fakeRegistry(handler), secrets, logger: silentLogger, userAgent: 'Overtone/test' });
  const service = new DiscoveryService({ sources: manager, logger: silentLogger, cacheTtlMs, ...(debrid ? { debrid } : {}) });
  return { db, secrets, manager, service };
}

describe('DiscoveryService', () => {
  it('searches all enabled sources and de-duplicates by info hash, keeping attribution', async () => {
    const handler: Handler = () => [hit({ title: 'Led Zeppelin - Led Zeppelin IV (1971) FLAC', infoHash: 'aaaa', seeders: 10, files: 8 })];
    const { manager, service } = await setup(handler);
    await manager.create({ kind: 'torznab', name: 'A', url: 'http://a' });
    await manager.create({ kind: 'torznab', name: 'B', url: 'http://b' });

    const res = await service.discover(target);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.sources.map((s) => s.name).sort()).toEqual(['A', 'B']);
    expect(res.errors).toEqual([]);
  });

  it('skips disabled sources', async () => {
    const handler: Handler = () => [hit({ title: 'Led Zeppelin - Led Zeppelin IV FLAC', infoHash: 'bbbb' })];
    const { manager, service } = await setup(handler);
    await manager.create({ kind: 'torznab', name: 'A', url: 'http://a', enabled: false });
    const res = await service.discover(target);
    expect(res.results).toEqual([]);
  });

  it('keeps going when one indexer fails and reports the error', async () => {
    const handler: Handler = (url) => {
      if (url === 'http://bad') throw new Error('boom');
      return [hit({ title: 'Led Zeppelin - Led Zeppelin IV FLAC', infoHash: 'cccc', seeders: 5 })];
    };
    const { manager, service } = await setup(handler);
    await manager.create({ kind: 'torznab', name: 'Bad', url: 'http://bad' });
    await manager.create({ kind: 'torznab', name: 'Good', url: 'http://good' });

    const res = await service.discover(target);
    expect(res.results).toHaveLength(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.name).toBe('Bad');
  });

  it('reports a timeout as an error without failing the search', async () => {
    const handler: Handler = (url) => {
      if (url === 'http://slow') {
        const e = new Error('timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      return [hit({ title: 'Led Zeppelin - Led Zeppelin IV FLAC', infoHash: 'dddd' })];
    };
    const { manager, service } = await setup(handler);
    await manager.create({ kind: 'torznab', name: 'Slow', url: 'http://slow' });
    await manager.create({ kind: 'torznab', name: 'Fast', url: 'http://fast' });

    const res = await service.discover(target);
    expect(res.results).toHaveLength(1);
    expect(res.errors[0]!.message).toBe('Timed out');
  });

  it('caches results and invalidates on source config change', async () => {
    let calls = 0;
    const handler: Handler = () => {
      calls++;
      return [hit({ title: 'Song', infoHash: 'eeee' })];
    };
    const { manager, service } = await setup(handler);
    const src = await manager.create({ kind: 'torznab', name: 'A', url: 'http://a' });
    const t: DiscoveryTarget = { scope: 'track', title: 'Song' }; // exactly one query

    await service.discover(t);
    expect(calls).toBe(1);
    await service.discover(t);
    expect(calls).toBe(1); // cached

    await manager.update(src.id, { name: 'A renamed' }); // clears the cache
    await service.discover(t);
    expect(calls).toBe(2);
  });

  it('ranks a correct release above an incorrect one regardless of seeders', async () => {
    const handler: Handler = (url) =>
      url === 'http://good'
        ? [hit({ title: 'Led Zeppelin - Led Zeppelin IV (1971) FLAC', infoHash: '1111', seeders: 1 })]
        : [hit({ title: 'Some Other Band - Unrelated Album FLAC', infoHash: '2222', seeders: 999 })];
    const { manager, service } = await setup(handler);
    await manager.create({ kind: 'torznab', name: 'Good', url: 'http://good' });
    await manager.create({ kind: 'torznab', name: 'Noise', url: 'http://noise' });

    const res = await service.discover(target);
    expect(res.results[0]!.title).toBe('Led Zeppelin IV');
  });

  it('returns an empty result set when nothing matches and there are no sources', async () => {
    const { service } = await setup(() => []);
    const res = await service.discover(target);
    expect(res.results).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it('applies cached-release preferences (hide uncached, prioritise cached)', async () => {
    const cachedHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const stubDebrid = {
      async listProviders() {
        return [{ sourceId: 'ad', name: 'AllDebrid', providerId: 'alldebrid', retrieval: true }];
      },
      async checkCached(ref: { infoHash?: string }) {
        return [{ providerId: 'ad', providerName: 'AllDebrid', status: ref.infoHash === cachedHash ? ('cached' as const) : ('uncached' as const) }];
      },
    } as unknown as DebridService;

    const handler: Handler = () => [
      hit({ title: 'Led Zeppelin - Led Zeppelin IV FLAC', infoHash: cachedHash, seeders: 5 }),
      hit({ title: 'Led Zeppelin - Led Zeppelin IV FLAC', infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', seeders: 5 }),
    ];
    const { manager, service } = await setup(handler, 60_000, stubDebrid);
    await manager.create({ kind: 'torznab', name: 'A', url: 'http://a' });

    const all = await service.discover(target);
    expect(all.results).toHaveLength(2);

    const hidden = await service.discover(target, { hideUncached: true });
    expect(hidden.results).toHaveLength(1);
    expect(hidden.results[0]!.cached[0]!.status).toBe('cached');

    const prioritised = await service.discover(target, { prioritizeCached: true });
    expect(prioritised.results[0]!.infoHash).toBe(cachedHash);
  });
});
