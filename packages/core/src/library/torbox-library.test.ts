/**
 * TorBox account → Overtone library, end to end without a network: the
 * built-in registry and TorBox adapter, SourceManager, LibraryScanner and
 * LibraryRepo against every database driver, with TorBox's HTTP API mocked
 * (response shapes from TorBox's OpenAPI spec / official SDK; fake values).
 */
import { describe, expect, it } from 'vitest';
import { createCore } from '../core.js';
import { serverCoverUrl, type ViewContext } from './repo.js';
import { MemoryBlobStore, MemorySecretStore } from '../platform/types.js';
import { TEST_DATABASES, type TestDatabaseFactory } from '../testing/databases.js';
import { fakeClock } from '../testing/fake-clock.js';
import { FakeMusicBrainz } from '../testing/fake-musicbrainz.js';
import { json, mockHttp } from '../testing/mock-http.js';

const API = 'https://api.torbox.app/v1/api';
const view: ViewContext = { coverUrl: serverCoverUrl('tok'), categoryOf: () => 'debrid' };
const ok = (data: unknown) => json({ success: true, error: null, detail: 'ok', data });
const fail = (error: string, status: number) => json({ success: false, error, detail: error, data: null }, status);

const file = (id: number, name: string, size: number, mimetype?: string) => ({ id, md5: null, name, short_name: name.split('/').pop(), size, s3_path: 'x', ...(mimetype ? { mimetype } : {}) });
const item = <F,>(id: number, name: string, files: F[], extra: Record<string, unknown> = {}) => ({
  id,
  hash: 'h',
  name,
  size: 1,
  active: false,
  download_state: 'cached',
  download_finished: true,
  download_present: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  files,
  ...extra,
});

const album = item(1, 'Daft Punk - Homework (1997) [FLAC]', [
  file(0, 'Daft Punk - Homework (1997) [FLAC]/01 - Daftendirekt.flac', 1000, 'audio/flac'),
  file(1, 'Daft Punk - Homework (1997) [FLAC]/02 - Revolution 909.flac', 2000, 'audio/flac'),
  file(2, 'Daft Punk - Homework (1997) [FLAC]/cover.jpg', 10, 'image/jpeg'),
]);
const boxSet = item(2, 'Air - Moon Safari', [file(0, 'Air - Moon Safari/CD1/01 - La Femme d’Argent.mp3', 3000, 'audio/mpeg')]);
const movie = item(3, 'Some.Movie.2020.1080p', [file(0, 'Some.Movie.2020.1080p/Some.Movie.2020.1080p.mkv', 9_000_000, 'video/x-matroska')]);
const usenetAlbum = item(20, 'Portishead - Dummy', [file(0, 'Portishead - Dummy/03 - Sour Times.m4a', 4000, 'audio/mp4')]);

async function setup(factory: TestDatabaseFactory, lists: { torrents?: unknown[]; usenet?: unknown[]; webdl?: unknown[] } = {}) {
  const db = await factory.open();
  const http = mockHttp()
    .on('GET', `${API}/user/me`, ok({ email: 'me@example.com', plan: 2, premium_expires_at: '2030-01-01T00:00:00Z' }))
    .on('GET', `${API}/torrents/mylist`, ok(lists.torrents ?? [album, boxSet, movie]))
    .on('GET', `${API}/usenet/mylist`, ok(lists.usenet ?? [usenetAlbum]))
    .on('GET', `${API}/webdl/mylist`, ok(lists.webdl ?? []))
    .on('GET', `${API}/torrents/requestdl`, ok('https://store.torbox.example/dl/t'))
    .on('GET', `${API}/usenet/requestdl`, ok('https://store.torbox.example/dl/u'));
  const core = createCore({
    db,
    secrets: new MemorySecretStore(),
    blobs: new MemoryBlobStore(),
    mb: new FakeMusicBrainz([]),
    clock: fakeClock(),
    version: 'test',
    contact: 'test@example.com',
    fetch: http.fetch,
  });
  const config = { apiKey: 'tb-key', probeTags: false };
  const test = await core.api.testProvider('torbox', { config }, 1);
  const source = await core.api.createSource({ providerId: 'torbox', config }, 1);
  const scan = async () => {
    const report = await core.scanner.scanSource(source.id);
    await core.matchWorker.drain();
    return report;
  };
  const titles = async (q?: string) => (await core.api.tracks({ ...(q ? { q } : {}), sort: 'name' }, view)).items.map((t) => t.title);
  return { db, http, core, test, source, scan, titles };
}

describe.each(TEST_DATABASES)('TorBox → library ($name)', (factory) => {
  it('connects, enumerates existing account files, imports the audio and makes it searchable and playable', async () => {
    const { test, scan, titles, core, source, http } = await setup(factory);
    expect(test).toMatchObject({ ok: true, details: { account: 'me@example.com', plan: 'Pro' } });

    expect(await scan()).toMatchObject({ added: 4, changed: 0, removed: 0, error: null });
    expect(await titles()).toEqual(['Daftendirekt', 'La Femme d’Argent', 'Revolution 909', 'Sour Times']);
    expect((await core.api.source(source.id)).fileCount).toBe(4);

    const search = await core.api.search('daft punk', view);
    expect(search.artists.map((a) => a.name)).toEqual(['Daft Punk']);
    expect(search.tracks.map((t) => t.title)).toContain('Daftendirekt');
    expect((await core.api.search('portishead', view)).tracks.map((t) => t.title)).toEqual(['Sour Times']);
    expect((await core.api.search('moon safari', view)).albums.map((a) => a.title)).toEqual(['Moon Safari']);
    // Video files are not part of a music library (by design, see docs/providers.md).
    expect((await core.api.search('movie', view)).tracks).toEqual([]);

    // Playable: picks the TorBox file and resolves it to a TorBox link for the right item/file.
    const track = (await core.api.search('sour times', view)).tracks[0]!;
    const { picks } = await core.api.pickSources([track.id]);
    expect(picks[0]!.pick).toMatchObject({ sourceId: source.id, providerId: 'torbox' });
    const target = await core.library.streamTarget(picks[0]!.pick.sourceFileId);
    const provider = await core.sources.instance(source.id);
    expect((await provider.resolveStream(target!.file.file_id, { signal: AbortSignal.timeout(1000) })).url).toBe('https://store.torbox.example/dl/u');
    expect(Object.fromEntries(http.to(`${API}/usenet/requestdl`)[0]!.url.searchParams)).toMatchObject({ usenet_id: '20', file_id: '0' });
  });

  it('updates changed files and removes deleted ones on rescan', async () => {
    const { scan, titles, http } = await setup(factory);
    await scan();
    const resized = item(1, album.name, [file(0, album.files[0]!.name, 1111), file(1, album.files[1]!.name, 2000)]);
    http.on('GET', `${API}/torrents/mylist`, ok([resized, movie]));
    expect(await scan()).toMatchObject({ added: 0, changed: 1, unchanged: 2, removed: 1, error: null });
    expect(await titles()).toEqual(['Daftendirekt', 'Revolution 909', 'Sour Times']);
  });

  it('still shows the music it could list when another TorBox list fails, and deletes nothing', async () => {
    const { scan, titles, http, core, source } = await setup(factory);
    await scan();
    expect(await titles()).toHaveLength(4);

    // New album arrives, but the usenet list now errors: torrents must still import,
    // and the usenet album already in the library must survive.
    const newAlbum = item(4, 'Massive Attack - Mezzanine', [file(0, 'Massive Attack - Mezzanine/01 - Angel.flac', 5000)]);
    http.on('GET', `${API}/torrents/mylist`, ok([album, boxSet, movie, newAlbum]));
    http.on('GET', `${API}/usenet/mylist`, fail('DATABASE_ERROR', 500));
    const report = await scan();
    expect(report).toMatchObject({ added: 1, removed: 0, error: expect.stringContaining('List usenet') });
    expect(await titles()).toEqual(['Angel', 'Daftendirekt', 'La Femme d’Argent', 'Revolution 909', 'Sour Times']);
    expect((await core.api.search('mezzanine', view)).tracks.map((t) => t.title)).toEqual(['Angel']);
    expect((await core.api.source(source.id)).lastError).toContain('List usenet');
  });

  it('first scan of an account whose usenet list errors still imports the torrents', async () => {
    const { scan, titles, http, db } = await setup(factory);
    http.on('GET', `${API}/usenet/mylist`, fail('DATABASE_ERROR', 500));
    expect(await scan()).toMatchObject({ added: 3, error: expect.stringContaining('DATABASE_ERROR') });
    expect(await titles()).toEqual(['Daftendirekt', 'La Femme d’Argent', 'Revolution 909']);
    expect(await db.all(`SELECT file_id FROM source_files WHERE tags_status = 'pending' OR track_id IS NULL`)).toEqual([]);
  });

  it('handles an empty account without errors', async () => {
    const { scan, titles, core, source } = await setup(factory, { torrents: [], usenet: [], webdl: [] });
    expect(await scan()).toMatchObject({ added: 0, removed: 0, error: null });
    expect(await titles()).toEqual([]);
    expect(await core.api.source(source.id)).toMatchObject({ fileCount: 0, lastError: null });
  });

  it('reports a revoked key during the scan as an error and keeps the library', async () => {
    const { scan, titles, http, core, source } = await setup(factory);
    await scan();
    http.on('*', (u) => u.href.startsWith(API), fail('BAD_TOKEN', 403));
    expect(await scan()).toMatchObject({ removed: 0, error: expect.stringContaining('rejected the API key') });
    expect(await titles()).toHaveLength(4);
    expect((await core.api.source(source.id)).lastError).toContain('rejected the API key');
  });

  it('reports a malformed TorBox response instead of silently importing nothing', async () => {
    const { scan, titles, http } = await setup(factory);
    http.on('GET', `${API}/torrents/mylist`, ok({ not: 'a list' }));
    expect(await scan()).toMatchObject({ error: 'List torrents: unexpected response from TorBox' });
    // The usenet list was still fine.
    expect(await titles()).toEqual(['Sour Times']);
  });
});
