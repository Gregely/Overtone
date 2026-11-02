import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeMp3, makeWav } from '../../testing/audio-fixtures.js';
import { collect, createTestContext } from '../../testing/provider-context.js';
import { localFolderPlugin } from './index.js';

const signal = new AbortController().signal;
let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'overtone-lf-'));
  outside = await mkdtemp(path.join(tmpdir(), 'overtone-outside-'));
  await mkdir(path.join(root, 'Artist/Album'), { recursive: true });
  await mkdir(path.join(root, '.hidden'), { recursive: true });
  await writeFile(path.join(root, 'Artist/Album/01 - One.mp3'), makeMp3({ title: 'One', artist: 'Artist', album: 'Album', track: '1' }));
  await writeFile(path.join(root, 'Artist/Album/02 - Two.wav'), makeWav({ title: 'Two' }));
  await writeFile(path.join(root, 'Artist/Album/cover.jpg'), 'jpg');
  await writeFile(path.join(root, '.hidden/secret.mp3'), makeMp3());
  await writeFile(path.join(root, 'loose.flac'), 'not really flac');
  await writeFile(path.join(outside, 'private.mp3'), makeMp3());
  await symlink(path.join(outside, 'private.mp3'), path.join(root, 'link.mp3'));
  await symlink(outside, path.join(root, 'linkdir'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const make = (cfg: Partial<{ path: string; watch: boolean; followSymlinks: boolean }> = {}) =>
  localFolderPlugin.create({ path: root, watch: false, followSymlinks: false, ...cfg }, createTestContext());

describe('LocalFolder', () => {
  it('lists audio files with stable relative ids, skipping hidden, non-audio and symlinks', async () => {
    const files = await collect(make().listLibrary({ signal }));
    expect(files.map((f) => f.id).sort()).toEqual(['Artist/Album/01 - One.mp3', 'Artist/Album/02 - Two.wav', 'loose.flac']);
    const one = files.find((f) => f.name === '01 - One.mp3')!;
    expect(one).toMatchObject({ path: 'Artist/Album/01 - One.mp3', mimeType: 'audio/mpeg' });
    expect(one.size).toBeGreaterThan(0);
    expect(one.modifiedAt).toBeInstanceOf(Date);
  });

  it('follows symlinks only when enabled', async () => {
    const files = await collect(make({ followSymlinks: true }).listLibrary({ signal }));
    expect(files.map((f) => f.id)).toEqual(expect.arrayContaining(['link.mp3', 'linkdir/private.mp3']));
  });

  it('resolves to a file:// URL inside the root', async () => {
    const s = await make().resolveStream('Artist/Album/01 - One.mp3', { signal });
    expect(fileURLToPath(s.url).replaceAll(path.sep, '/')).toMatch(/Artist\/Album\/01 - One\.mp3$/);
    expect(s).toMatchObject({ mimeType: 'audio/mpeg', redirectSafe: false });
  });

  it.each(['../outside.mp3', 'Artist/../../etc/passwd', '/etc/passwd', '', 'missing.mp3', 'a\0b.mp3'])(
    'refuses %j',
    async (id) => {
      await expect(make().resolveStream(id, { signal })).rejects.toMatchObject({ code: 'not_found' });
    },
  );

  it('refuses symlinks that escape the root unless following is enabled', async () => {
    await expect(make().resolveStream('link.mp3', { signal })).rejects.toMatchObject({ code: 'not_found' });
    await expect(make({ followSymlinks: true }).resolveStream('link.mp3', { signal })).resolves.toBeTruthy();
  });

  it('reads embedded tags', async () => {
    expect(await make().readTags!('Artist/Album/01 - One.mp3', { signal })).toMatchObject({ title: 'One', artist: 'Artist', trackNumber: 1 });
    expect(await make().readTags!('loose.flac', { signal })).toBeNull();
  });

  it('reports folder status in testConnection', async () => {
    expect(await make().testConnection!({ signal })).toMatchObject({ ok: true, message: 'Found 3 audio files' });
    expect(await make({ path: path.join(root, 'nope') }).testConnection!({ signal })).toMatchObject({ ok: false });
  });

  it('fails listing a missing folder with a config error', async () => {
    await expect(collect(make({ path: path.join(root, 'nope') }).listLibrary({ signal }))).rejects.toMatchObject({ code: 'config' });
  });

  it('rejects relative roots', () => {
    expect(() => make({ path: 'relative/music' })).toThrow(/absolute/);
  });
});
