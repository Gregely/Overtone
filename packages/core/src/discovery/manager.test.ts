import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { createDatabase, syncHandleDriver, type Database } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { silentLogger } from '../logging.js';
import { MemorySecretStore } from '../platform/types.js';
import { mockHttp } from '../testing/mock-http.js';
import { TorrentSourceManager, searchEndpoint } from './manager.js';
import { createDefaultTorrentRegistry } from './registry.js';

function openDb(): Database {
  const db = createDatabase(syncHandleDriver(new Sqlite(':memory:')));
  return db;
}

async function makeManager(overrides: { fetch?: typeof fetch; secrets?: MemorySecretStore } = {}) {
  const db = openDb();
  await migrate(db);
  const secrets = overrides.secrets ?? new MemorySecretStore();
  const manager = new TorrentSourceManager({
    db,
    registry: createDefaultTorrentRegistry(),
    secrets,
    logger: silentLogger,
    userAgent: 'Overtone/test',
    ...(overrides.fetch ? { fetch: overrides.fetch as never } : {}),
  });
  return { db, secrets, manager };
}

describe('searchEndpoint', () => {
  it('maps each kind to its Torznab endpoint', () => {
    expect(searchEndpoint('torznab', 'https://indexer/api')).toBe('https://indexer/api');
    expect(searchEndpoint('prowlarr', 'http://localhost:9696')).toBe('http://localhost:9696/api/v1/search');
    expect(searchEndpoint('jackett', 'http://localhost:9117')).toBe('http://localhost:9117/api/v2.0/indexers/all/results/torznab');
  });
});

describe('TorrentSourceManager', () => {
  it('creates, lists, updates and deletes a source; stores the API key separately', async () => {
    const { secrets, manager } = await makeManager();

    const created = await manager.create({ kind: 'torznab', name: 'My indexer', url: 'https://indexer/api', apiKey: 'sekrit' });
    expect(created.kind).toBe('torznab');
    expect(created.url).toBe('https://indexer/api');

    const dto = await manager.toDto(created);
    expect(dto.apiKeySet).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('sekrit');
    expect(secrets.dump()[created.id]).toEqual({ apiKey: 'sekrit' });

    const updated = await manager.update(created.id, { name: 'Renamed', enabled: false });
    expect(updated.name).toBe('Renamed');
    expect(updated.enabled).toBe(0);

    // Clearing the key via null.
    await manager.update(created.id, { apiKey: null });
    expect((await manager.toDto(await manager.require(created.id))).apiKeySet).toBe(false);

    await manager.delete(created.id);
    expect(await manager.get(created.id)).toBeUndefined();
  });

  it('normalizes Prowlarr/Jackett URLs to their base and stores discovered indexers', async () => {
    const { manager } = await makeManager();
    const created = await manager.create({
      kind: 'prowlarr',
      name: 'Prowlarr',
      url: 'http://localhost:9696/',
      apiKey: 'k',
      indexers: [
        { id: '1', name: 'Indexer A', categories: ['3000'], enabled: true },
        { id: '2', name: 'Indexer B', categories: ['3000'], enabled: false },
      ],
    });
    expect(created.url).toBe('http://localhost:9696');
    const dto = await manager.toDto(created);
    expect(dto.indexers).toHaveLength(2);
    expect(dto.indexers.find((i) => i.id === '2')?.enabled).toBe(false);
  });

  it('builds an instance that targets the kind-specific search endpoint', async () => {
    const { manager } = await makeManager();
    const created = await manager.create({ kind: 'prowlarr', name: 'Prowlarr', url: 'http://localhost:9696', apiKey: 'k' });
    const indexer = await manager.instance(created.id);
    expect(indexer.id).toBe('torznab');
  });

  it('rejects a bad URL', async () => {
    const { manager } = await makeManager();
    await expect(manager.create({ kind: 'torznab', name: 'x', url: 'not-a-url' })).rejects.toMatchObject({ statusCode: 422 });
  });

  it('tests an unsaved config against the correct endpoint', async () => {
    const mock = mockHttp();
    mock.on('GET', /\/api\?/, () =>
      new Response('<?xml version="1.0"?><rss version="2.0"><channel><title>X</title></channel></rss>', {
        headers: { 'content-type': 'application/xml' },
      }),
    );
    const { manager } = await makeManager({ fetch: mock.fetch });

    const result = await manager.test(undefined, { kind: 'torznab', url: 'https://indexer/api', apiKey: 'k' });
    expect(result.ok).toBe(true);
    expect(mock.calls[0]!.url.pathname).toBe('/api');
    expect(mock.calls[0]!.url.searchParams.get('apikey')).toBe('k');
  });

  it('reports a failed test without throwing', async () => {
    const mock = mockHttp();
    mock.on('GET', /\/api\?/, () => new Response('nope', { status: 401 }));
    const { manager } = await makeManager({ fetch: mock.fetch });
    const result = await manager.test(undefined, { kind: 'torznab', url: 'https://indexer/api', apiKey: 'bad' });
    expect(result.ok).toBe(false);
  });
});
