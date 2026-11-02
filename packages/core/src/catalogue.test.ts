import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOVERY_PREFERENCES, type DiscoverResultDto, type RetrievalJobDto } from '@overtone/shared';
import { CoreApi, type CoreApiDeps } from './api/core-api.js';
import { createCore } from './core.js';
import { MemoryBlobStore, MemorySecretStore } from './platform/types.js';
import { credit, FakeMusicBrainz, release } from './testing/fake-musicbrainz.js';
import { openTestDatabase } from './testing/databases.js';
import { fakeClock } from './testing/fake-clock.js';

const album = release('rel-1', 'Dark Side of the Moon', credit('Pink Floyd'), [
  ['Speak to Me', 60000, 'rec-1'],
  ['Breathe', 160000, 'rec-2'],
]);

async function makeCore() {
  const db = await openTestDatabase();
  const core = createCore({
    db,
    secrets: new MemorySecretStore(),
    torrentSecrets: new MemorySecretStore(),
    blobs: new MemoryBlobStore(),
    mb: new FakeMusicBrainz([album]),
    clock: fakeClock(),
    version: 'test',
    contact: 'test@example.com',
  });
  return core;
}

function cachedResult(score: number, status: 'cached' | 'uncached' = 'cached'): DiscoverResultDto {
  return {
    key: 'hash:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    title: 'Dark Side of the Moon',
    artist: 'Pink Floyd',
    album: 'Dark Side of the Moon',
    year: 1973,
    format: 'flac',
    quality: 'lossless',
    type: 'album',
    size: 500_000_000,
    seeders: 10,
    leechers: 1,
    files: 10,
    sources: [{ id: 'x1337', name: '1337x' }],
    magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    downloadUrl: null,
    score,
    reasons: [],
    cached: [{ providerId: 'ad', providerName: 'AllDebrid', status }],
  };
}

const job = (id = 'job-1'): RetrievalJobDto => ({
  id,
  providerId: 'ad',
  providerName: 'AllDebrid',
  status: 'processing',
  infohash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  title: 'Dark Side of the Moon',
  artist: 'Pink Floyd',
  album: 'Dark Side of the Moon',
  year: 1973,
  size: 500_000_000,
  progress: null,
  error: null,
  filesProcessed: false,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  completedAt: null,
});

function playApi(discoverResults: DiscoverResultDto[], onCreateMagnet?: (magnet: string) => void) {
  const created: string[] = [];
  const api = new CoreApi({
    mb: {
      getReleaseGroup: async () => ({
        releaseGroup: { id: 'rg-1', title: 'Dark Side of the Moon', credit: { text: 'Pink Floyd', artists: [] }, primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1973-03-01' },
        release: album,
      }),
    },
    preferences: { get: async () => DEFAULT_DISCOVERY_PREFERENCES },
    discovery: { discover: async () => ({ query: { scope: 'album', title: 'Dark Side of the Moon' }, results: discoverResults, errors: [] }) },
    retrieval: {
      create: async (_userId: number, input: { magnet: string }) => {
        created.push(input.magnet);
        onCreateMagnet?.(input.magnet);
        return { job: job(), duplicate: false };
      },
    },
  } as unknown as CoreApiDeps);
  return { api, created };
}

describe('MusicBrainz catalogue', () => {
  it('searches artists, releases and recordings independent of any debrid or torrent', async () => {
    const core = await makeCore();
    const res = await core.api.catalogueSearch('Pink Floyd');
    expect(res.artists.map((a) => a.name)).toEqual(['Pink Floyd']);
    expect(res.releases.map((r) => r.title)).toEqual(['Dark Side of the Moon']);
    expect(res.recordings.map((r) => r.title)).toEqual(['Speak to Me', 'Breathe']);
    await core.close();
  });

  it('returns artist discography and album tracklists', async () => {
    const core = await makeCore();
    const artist = await core.api.catalogueArtist('artist-pink-floyd');
    expect(artist.releaseGroups.map((r) => r.title)).toEqual(['Dark Side of the Moon']);

    const rel = await core.api.catalogueRelease('rg-rel-1');
    expect(rel.title).toBe('Dark Side of the Moon');
    expect(rel.tracks.map((t) => [t.trackNo, t.title])).toEqual([[1, 'Speak to Me'], [2, 'Breathe']]);
    await core.close();
  });

  it('play: selects a cached high-confidence release and creates a retrieval job', async () => {
    let magnet: string | undefined;
    const { api } = playApi([cachedResult(0.9)], (m) => (magnet = m));
    const res = await api.playCatalogue('rg-1', 1);
    expect(res.status).toBe('retrieving');
    expect(magnet).toBe('magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('play: no cached source when candidates are all uncached', async () => {
    const { api } = playApi([cachedResult(0.9, 'uncached')]);
    const res = await api.playCatalogue('rg-1', 1);
    expect(res.status).toBe('no_cached_source');
    if (res.status === 'no_cached_source') expect(res.candidates).toHaveLength(1);
  });

  it('play: no source when discovery finds nothing', async () => {
    const { api } = playApi([]);
    const res = await api.playCatalogue('rg-1', 1);
    expect(res.status).toBe('no_source');
  });

  it('play: never auto-plays an ambiguous match', async () => {
    const { api, created } = playApi([cachedResult(0.4)]);
    const res = await api.playCatalogue('rg-1', 1);
    expect(res.status).toBe('no_cached_source');
    expect(created).toHaveLength(0);
  });
});
