import { randomBytes } from 'node:crypto';
import { createCore, MemoryBlobStore } from '@overtone/core';
import { describe, expect, it } from 'vitest';
import { deriveKey } from '../crypto/keys.js';
import { SecretBox } from '../crypto/secret-box.js';
import { coreDatabase, openDatabase } from '../db/index.js';
import { EncryptedColumnSecretStore } from '../platform.js';
import { json, mockHttp } from '../testing/mock-http.js';
import { diagnoseTorBox } from './diagnose-torbox.js';

const API = 'https://api.torbox.app/v1/api';
const KEY = 'tb-secret-key-1234';
const ok = (data: unknown, detail = 'ok') => json({ success: true, error: null, detail, data });
// TorBox documents an empty list as HTTP 404 + ITEM_NOT_FOUND.
const none = () => json({ success: true, error: 'ITEM_NOT_FOUND', detail: 'No usenet downloads found for this user.', data: null }, 404);
const album = {
  id: 7,
  name: 'Pink Floyd - Wish You Were Here (1975) [FLAC]',
  download_state: 'cached',
  download_finished: true,
  download_present: true,
  files: [
    { id: 0, name: 'Pink Floyd - Wish You Were Here (1975) [FLAC]/02 - Welcome to the Machine.flac', short_name: '02 - Welcome to the Machine.flac', size: 3e7, mimetype: 'audio/flac' },
    { id: 1, name: 'Pink Floyd - Wish You Were Here (1975) [FLAC]/folder.jpg', short_name: 'folder.jpg', size: 5, mimetype: 'image/jpeg' },
  ],
};

async function setup() {
  const http = mockHttp()
    .on('GET', `${API}/user/me`, ok({ email: 'me@example.com', plan: 2, premium_expires_at: '2030-01-01T00:00:00Z' }))
    .on('GET', `${API}/torrents/mylist`, ok([album], 'Torrent list retrieved successfully.'))
    .on('GET', `${API}/usenet/mylist`, none())
    .on('GET', `${API}/webdl/mylist`, none());
  // A real (server-style) database with a TorBox source whose key is stored encrypted.
  const database = coreDatabase(openDatabase(':memory:'));
  const secrets = new EncryptedColumnSecretStore(database, new SecretBox(deriveKey(randomBytes(32), 'secrets')));
  const core = createCore({ db: database, secrets, blobs: new MemoryBlobStore(), version: 't', contact: 't', fetch: http.fetch });
  const source = await core.api.createSource({ providerId: 'torbox', name: 'My TorBox', config: { apiKey: KEY } }, 1);
  const lines: string[] = [];
  const run = () => diagnoseTorBox({ database, secrets, fetch: http.fetch, print: (l) => lines.push(l) }).then(() => lines.join('\n'));
  return { http, database, source, run };
}

describe('TorBox diagnostics', () => {
  it('walks every stage with the stored key and never prints it', async () => {
    const { run, http } = await setup();
    const out = await run();
    expect(out).toContain('"My TorBox"');
    expect(out).toContain('stored files: 0');
    expect(out).toContain('account: me@example.com, plan 2');
    expect(out).toMatch(/torrents page 1: HTTP 200, .*data=list of 1/);
    expect(out).toContain('1 torrents, 2 files, 1 audio by extension');
    expect(out).toContain('1 × state=cached finished=true present=true');
    expect(out).toContain('extensions: flac 1, jpg 1');
    expect(out).toMatch(/usenet page 1: HTTP 404, .*error=ITEM_NOT_FOUND/);
    expect(out).toContain('scan: listed 1 audio files, error: none');
    expect(out).toMatch(/\[info\] debrid listing finished .*"listed":2,"audio":1/);
    expect(out).toContain('library would show 1 tracks');
    expect(out).toContain('Welcome to the Machine');
    expect(out).toContain('1 track(s) found');
    expect(out).not.toContain(KEY);
    expect(http.calls.every((c) => c.headers.get('authorization') === `Bearer ${KEY}`)).toBe(true);
  });

  it('does not change the real database', async () => {
    const { run, database, source } = await setup();
    const before = JSON.stringify(await database.all('SELECT * FROM source_files'));
    await run();
    expect(JSON.stringify(await database.all('SELECT * FROM source_files'))).toBe(before);
    expect((await database.get<{ last_scan_at: number | null }>('SELECT last_scan_at FROM sources WHERE id = ?', [source.id]))!.last_scan_at).toBeNull();
  });

  it('shows why nothing imports: rejected key, non-audio account, broken response', async () => {
    const a = await setup();
    a.http.on('*', (u) => u.href.startsWith(API), json({ success: false, error: 'BAD_TOKEN', detail: 'bad', data: null }, 403));
    const outA = await a.run();
    expect(outA).toMatch(/HTTP 403, .*error=BAD_TOKEN/);
    expect(outA).toContain('rejected the API key');
    expect(outA).toContain('TorBox rejected or failed the account check');

    const b = await setup();
    b.http.on('GET', `${API}/torrents/mylist`, ok([{ ...album, files: [{ id: 0, name: 'Film/film.mkv', size: 1 }] }]));
    const outB = await b.run();
    expect(outB).toContain('TorBox returned no audio files');
    expect(outB).toMatch(/debrid listing found no audio files .*"mkv":1/);

    const c = await setup();
    c.http.on('GET', `${API}/torrents/mylist`, new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    expect(await c.run()).toMatch(/torrents page 1: HTTP 502, .*not JSON: "<html>502 Bad Gateway<\/html>"/);
  });

  it('explains a missing key', async () => {
    const lines: string[] = [];
    await diagnoseTorBox({ database: null, secrets: null, print: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('No TorBox key available');
  });
});
