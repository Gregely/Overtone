/**
 * Core end to end, without HTTP: a fake provider, in-memory secret/blob
 * stores, a fake clock and FakeMusicBrainz, against every database driver.
 */
import { describe, expect, it } from 'vitest';
import { createCore, type OvertoneCore } from './core.js';
import type { Database } from './db/database.js';
import { serverCoverUrl, type ViewContext } from './library/repo.js';
import { MemoryBlobStore, MemorySecretStore } from './platform/types.js';
import { ProviderError } from './providers/errors.js';
import { ProviderRegistry } from './providers/registry.js';
import type { ProviderPlugin, SourceFile } from './providers/types.js';
import { TEST_DATABASES } from './testing/databases.js';
import { fakeClock } from './testing/fake-clock.js';
import { credit, FakeMusicBrainz, release } from './testing/fake-musicbrainz.js';

const homework = release('11111111-1111-4111-8111-111111111111', 'Homework', credit('Daft Punk'), [
  ['Daftendirekt', 164000],
  ['Revolution 909', 335000],
  ['Da Funk', 329000],
]);

const file = (n: number, title: string): SourceFile => ({
  id: `f${n}`,
  name: `${n} ${title}.mp3`,
  path: `Daft Punk/Homework/0${n} ${title}.mp3`,
  size: 1000 + n,
  tags: { title, artist: 'Daft Punk', album: 'Homework', trackNumber: n, durationMs: homework.tracks[n - 1]!.lengthMs ?? undefined },
});

/** A controllable remote source: list what `files` holds; optionally fail or block. */
function fakeSource() {
  const state = {
    files: [file(1, 'Daftendirekt'), file(2, 'Revolution 909'), file(3, 'Da Funk')],
    failWith: null as Error | null,
    block: null as Promise<void> | null,
    listed: 0,
    configs: [] as Array<Record<string, unknown>>,
  };
  const plugin: ProviderPlugin = {
    manifest: {
      id: 'fake',
      name: 'Fake',
      description: '',
      category: 'debrid',
      capabilities: { testConnection: true },
      configSchema: { fields: [{ key: 'apiKey', type: 'secret', label: 'Key', required: true }] },
    },
    create(config, ctx) {
      state.configs.push({ ...config });
      return {
        async *listLibrary() {
          state.listed++;
          if (state.failWith) throw state.failWith;
          for (const [i, f] of state.files.entries()) {
            if (i === 1 && state.block) await state.block;
            yield f;
          }
          ctx.state.set('cursor', { n: state.listed });
        },
        async resolveStream(id) {
          return { url: `https://cdn.example/${id}?token=${String(config.apiKey)}`, expiresAt: new Date(Date.now() + 3600_000) };
        },
        async readTags() {
          return null;
        },
      };
    },
  };
  return { state, plugin };
}

function build(db: Database, plugin: ProviderPlugin, secrets = new MemorySecretStore()) {
  const registry = new ProviderRegistry();
  registry.register(plugin);
  const clock = fakeClock();
  const core = createCore({
    db,
    registry,
    secrets,
    torrentSecrets: new MemorySecretStore(),
    blobs: new MemoryBlobStore(),
    mb: new FakeMusicBrainz([homework]),
    clock,
    version: 'test',
    contact: 'test@example.com',
    allowRedirect: false,
  });
  return { core, secrets, clock };
}

const view: ViewContext = { coverUrl: serverCoverUrl('tok'), categoryOf: () => 'debrid' };

async function scanAndMatch(core: OvertoneCore, id: string) {
  const report = await core.scanner.scanSource(id);
  await core.matchWorker.drain();
  return report;
}

describe.each(TEST_DATABASES)('core ($name)', (factory) => {
  it('keeps secrets out of the database and never returns them', async () => {
    const db = await factory.open();
    const { plugin } = fakeSource();
    const { core, secrets } = build(db, plugin);
    const dto = await core.api.createSource({ providerId: 'fake', name: 'Mine', config: { apiKey: 'sk-very-secret' } }, 1);
    expect(dto.config).toEqual({ values: {}, secretsSet: ['apiKey'] });
    expect(JSON.stringify(await db.all('SELECT * FROM sources'))).not.toContain('sk-very-secret');
    expect(secrets.dump()[dto.id]).toEqual({ apiKey: 'sk-very-secret' });
    await core.api.deleteSource(dto.id);
    expect(secrets.dump()[dto.id]).toBeUndefined();
  });

  it('rejects redirect stream mode in standalone mode', async () => {
    const db = await factory.open();
    const { core } = build(db, fakeSource().plugin);
    await expect(core.api.createSource({ providerId: 'fake', streamMode: 'redirect', config: { apiKey: 'k' } }, 1)).rejects.toMatchObject({
      fields: { streamMode: expect.stringContaining('server') },
    });
  });

  it('scans, matches against MusicBrainz and picks a playable source', async () => {
    const db = await factory.open();
    const { core } = build(db, fakeSource().plugin);
    const src = await core.api.createSource({ providerId: 'fake', config: { apiKey: 'k' } }, 1);
    expect(await scanAndMatch(core, src.id)).toMatchObject({ added: 3, error: null });

    const albums = await core.api.albums({}, view);
    expect(albums.items).toMatchObject([{ title: 'Homework', mbid: homework.id, trackCount: 3, artist: { name: 'Daft Punk' } }]);
    const album = await core.api.album(albums.items[0]!.id, view);
    expect(album.tracks.map((t) => [t.trackNo, t.title, t.matchStatus])).toEqual([
      [1, 'Daftendirekt', 'matched'],
      [2, 'Revolution 909', 'matched'],
      [3, 'Da Funk', 'matched'],
    ]);
    const { picks, unavailable } = await core.api.pickSources([album.tracks[0]!.id, 999]);
    expect(unavailable).toEqual([999]);
    expect(picks[0]).toMatchObject({ pick: { sourceId: src.id, providerId: 'fake' } });
    expect(await core.api.search('funk', view)).toMatchObject({ tracks: [{ title: 'Da Funk' }] });
    expect((await core.library.stats()).tracks).toBe(3);
  });

  it('removes files that disappeared, and keeps the library when the source errors (e.g. access revoked)', async () => {
    const db = await factory.open();
    const { state, plugin } = fakeSource();
    const { core } = build(db, plugin);
    const src = await core.api.createSource({ providerId: 'fake', config: { apiKey: 'k' } }, 1);
    await scanAndMatch(core, src.id);

    state.files.pop();
    expect(await scanAndMatch(core, src.id)).toMatchObject({ removed: 1, unchanged: 2 });
    expect((await core.library.stats()).tracks).toBe(2);

    state.failWith = new ProviderError('auth', 'Overtone no longer has access to this folder. Pick it again in Sources.');
    const report = await scanAndMatch(core, src.id);
    expect(report.error).toMatch(/no longer has access/);
    expect((await core.library.stats()).tracks).toBe(2);
    expect((await core.api.source(src.id)).lastError).toMatch(/no longer has access/);
  });

  it('persists the scan queue: a scan interrupted by shutdown resumes on the next start', async () => {
    const db = await factory.open();
    const { state, plugin } = fakeSource();
    let unblock!: () => void;
    state.block = new Promise((r) => (unblock = r));

    const first = build(db, plugin);
    const src = await first.core.api.createSource({ providerId: 'fake', config: { apiKey: 'k' } }, 1);
    await first.core.start();
    await first.core.api.scanSource(src.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(first.core.scanner.progress).toMatchObject({ sourceId: src.id, filesSeen: 1 });
    expect(await db.all(`SELECT kind, source_id, state FROM jobs`)).toEqual([{ kind: 'scan', source_id: src.id, state: 'running' }]);

    // "App killed": stop background work mid-scan.
    const stopping = first.core.pause();
    unblock();
    await stopping;
    expect(await db.all(`SELECT source_id FROM jobs`)).toEqual([{ source_id: src.id }]);

    // Next launch: a fresh core over the same database picks the job up.
    state.block = null;
    const second = build(db, plugin, first.secrets);
    await second.core.start();
    await second.core.scanner.idle();
    await second.core.matchWorker.idle();
    expect(await db.all(`SELECT * FROM jobs`)).toEqual([]);
    expect((await second.core.library.stats()).tracks).toBe(3);
    expect((await second.core.api.matchStatus()).pending).toBe(0);
    await second.core.pause();
  });

  it('writes provider state behind and loads it for the next instance', async () => {
    const db = await factory.open();
    const { plugin } = fakeSource();
    const { core } = build(db, plugin);
    const src = await core.api.createSource({ providerId: 'fake', config: { apiKey: 'k' } }, 1);
    await core.scanner.scanSource(src.id);
    await core.api.updateSource(src.id, { name: 'Renamed' }, 1); // disposes (and flushes) the instance
    expect(await db.all('SELECT key, value_json FROM provider_state')).toEqual([{ key: 'cursor', value_json: '{"n":1}' }]);
  });

  it('resets the library but keeps sources', async () => {
    const db = await factory.open();
    const { core } = build(db, fakeSource().plugin);
    const src = await core.api.createSource({ providerId: 'fake', config: { apiKey: 'k' } }, 1);
    await scanAndMatch(core, src.id);
    await core.library.resetLibrary();
    expect((await core.library.stats()).tracks).toBe(0);
    expect((await core.api.listSources()).map((s) => s.id)).toEqual([src.id]);
    expect(await scanAndMatch(core, src.id)).toMatchObject({ added: 3 });
  });
});
