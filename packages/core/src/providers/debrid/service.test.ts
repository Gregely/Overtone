import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { createDatabase, syncHandleDriver } from '../../db/database.js';
import { migrate } from '../../db/migrate.js';
import { silentLogger } from '../../logging.js';
import { MemorySecretStore } from '../../platform/types.js';
import { json, mockHttp } from '../../testing/mock-http.js';
import { ProviderRegistry } from '../registry.js';
import { SourceManager } from '../../sources/manager.js';
import { createDebridPlugin } from './index.js';
import { createAllDebridAdapter } from './adapters/alldebrid/index.js';
import { createRealDebridAdapter } from './adapters/real-debrid/index.js';
import { DebridService } from './service.js';

const API = 'https://api.alldebrid.com';

async function setup() {
  const db = createDatabase(syncHandleDriver(new Sqlite(':memory:')));
  await migrate(db);
  const registry = new ProviderRegistry();
  for (const def of [createAllDebridAdapter(), createRealDebridAdapter()]) registry.register(createDebridPlugin(def));
  const http = mockHttp().on('POST', `${API}/v4/magnet/instant`, json({ status: 'success', data: { magnets: [{ magnet: 'magnet:?xt=urn:btih:aaaa', hash: 'aaaa', instant: true }] } }));
  const sources = new SourceManager({ db, registry, secrets: new MemorySecretStore(), logger: silentLogger, userAgent: 'Overtone/test', fetch: http.fetch });
  const ad = await sources.create({ providerId: 'alldebrid', name: 'AllDebrid', config: { apiKey: 'ad-key' } });
  const rd = await sources.create({ providerId: 'real-debrid', name: 'RealDebrid', config: { apiKey: 'rd-key' } });
  const service = new DebridService({ sources, registry, logger: silentLogger });
  return { db, http, service, ad, rd };
}

describe('DebridService', () => {
  it('lists debrid providers with their retrieval capability', async () => {
    const { service, ad, rd } = await setup();
    expect(await service.listProviders()).toEqual([
      { sourceId: ad.id, name: 'AllDebrid', providerId: 'alldebrid', retrieval: true },
      { sourceId: rd.id, name: 'RealDebrid', providerId: 'real-debrid', retrieval: false },
    ]);
  });

  it('reports cached for supported providers and unavailable for unsupported ones', async () => {
    const { service, ad, rd } = await setup();
    expect(await service.checkCached({ infoHash: 'aaaa' })).toEqual([
      { providerId: ad.id, providerName: 'AllDebrid', status: 'cached' },
      { providerId: rd.id, providerName: 'RealDebrid', status: 'unavailable' },
    ]);
  });

  it('caches cache checks per (source, torrent)', async () => {
    const { service, http } = await setup();
    await service.checkCached({ infoHash: 'aaaa' });
    await service.checkCached({ infoHash: 'aaaa' });
    expect(http.to(`${API}/v4/magnet/instant`)).toHaveLength(1);
  });

  it('rejects a malformed magnet', async () => {
    const { service, ad } = await setup();
    await expect(service.addMagnet(ad.id, 'not-a-magnet')).rejects.toMatchObject({ code: 'config' });
  });
});
