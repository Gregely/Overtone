/**
 * A real Overtone server for browser tests: temp data dir, a generated music
 * library, fake MusicBrainz + Cover Art Archive (no network), serving the
 * built web app.
 *
 *   OVERTONE_WEB_DIR=apps/web/dist E2E_PORT=4810 npx tsx apps/server/src/testing/e2e-server.ts
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../app.js';
import { DEFAULT_CORS_ORIGINS } from '../config.js';
import { createDebridPlugin, createRealDebridAdapter, ProviderRegistry } from '@overtone/core';
import { createBuiltinPlugins } from '../providers/index.js';
import { makeMp3 } from './audio-fixtures.js';
import { credit, FakeMusicBrainz, release } from './fake-musicbrainz.js';
import { startFakeServices } from './fake-services.js';

const port = Number(process.env.E2E_PORT ?? 4810);
const webDir = path.resolve(process.env.OVERTONE_WEB_DIR ?? 'apps/web/dist');
const root = mkdtempSync(path.join(tmpdir(), 'overtone-e2e-'));
const music = path.join(root, 'music');

// ~10 s of silent MP3 per track (40 frames ≈ 1 s).
const FRAMES = 400;
const albumDir = path.join(music, 'Test Artist', 'Album One (2001)');
mkdirSync(albumDir, { recursive: true });
const titles = ['Opening', 'Track Two', 'Third Light', 'Closing Time'];
titles.forEach((title, i) =>
  writeFileSync(
    path.join(albumDir, `0${i + 1} - ${title}.mp3`),
    makeMp3({ title, artist: 'Test Artist', albumArtist: 'Test Artist', album: 'Album One', track: `${i + 1}/4`, year: '2001' }, FRAMES),
  ),
);
// No tags and nothing on "MusicBrainz": stays unmatched, shown from its filename.
const odd = path.join(music, 'Unsorted');
mkdirSync(odd, { recursive: true });
writeFileSync(path.join(odd, 'Mystery Artist - Unknown Song.mp3'), makeMp3({}, FRAMES));

const albumOne = release(
  '0e1b6c43-2f0f-4c5a-9d2a-7a3c1f0e0001',
  'Album One',
  credit('Test Artist'),
  titles.map((t, i): [string, number, string] => [t, 10_000, `0e1b6c43-2f0f-4c5a-9d2a-7a3c1f0e01${String(i).padStart(2, '0')}`]),
  { date: '2001-03-04' },
);

// A 1×1 PNG stands in for Cover Art Archive images.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mOM2W/xHwAFgAJ/l1MqowAAAABJRU5ErkJggg==',
  'base64',
);
// Fake Subsonic + Real-Debrid on the next port; the real adapters talk to them.
const fakes = await startFakeServices(port + 1);
const registry = new ProviderRegistry();
for (const plugin of createBuiltinPlugins()) {
  registry.register(
    plugin.manifest.id === 'real-debrid'
      ? createDebridPlugin(createRealDebridAdapter({ apiBase: `${fakes.base}/rd/rest/1.0`, oauthBase: `${fakes.base}/rd/oauth/v2` }))
      : plugin,
  );
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('https://coverartarchive.org/')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  if (url.startsWith(fakes.base)) return fetch(input, init);
  throw new TypeError(`fetch failed (e2e server has no network): ${url}`);
};

const { app, services } = await buildApp({
  config: {
    host: '127.0.0.1',
    port,
    dataDir: path.join(root, 'data'),
    musicDir: music,
    secretKey: randomBytes(32),
    corsOrigins: DEFAULT_CORS_ORIGINS,
    mbContact: 'e2e@example.com',
    multiUser: false,
    scanIntervalMinutes: 0,
    webDir,
    logLevel: process.env.E2E_LOG_LEVEL ?? 'warn',
    trustProxy: false,
    version: 'e2e',
    premiumizeClientId: null,
    x1337BaseUrl: null,
  },
  mb: new FakeMusicBrainz([albumOne]),
  fetch: fakeFetch,
  registry,
});
await app.listen({ host: '127.0.0.1', port });
await services.startBackground();
console.log(`e2e server on http://127.0.0.1:${port} (web: ${webDir}, data: ${root}, fake services: ${fakes.base})`);

const stop = async () => {
  await app.close();
  await fakes.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
