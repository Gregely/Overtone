import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from './testing/app-harness.js';
import { makeMp3 } from './testing/audio-fixtures.js';

/**
 * Requests as the Android app makes them: the WebView UI runs at
 * http://localhost (Capacitor androidScheme "http"), and the Media3 player
 * fetches the signed stream URL directly (no Authorization header, Range for
 * seeking, its own User-Agent, no Origin).
 */
let h: Awaited<ReturnType<typeof createHarness>>;
let music: string;
afterEach(async () => {
  await h?.close();
  if (music) await rm(music, { recursive: true, force: true });
});

describe('Android app (Capacitor WebView + Media3) against the server', () => {
  it('allows the app origin via CORS (preflight with Authorization)', async () => {
    h = await createHarness();
    for (const origin of ['http://localhost', 'https://localhost']) {
      const pre = await h.app.inject({
        method: 'OPTIONS',
        url: '/api/stream-urls',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
      });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe(origin);
      expect(String(pre.headers['access-control-allow-headers'])).toMatch(/Authorization/);
    }
  });

  it('streams a signed URL to the native player with Range seeking and no auth header', async () => {
    music = await mkdtemp(path.join(tmpdir(), 'overtone-android-'));
    await mkdir(path.join(music, 'A/B'), { recursive: true });
    await writeFile(path.join(music, 'A/B/01 - Song.mp3'), makeMp3({ title: 'Song', artist: 'A', album: 'B' }, 200));
    h = await createHarness();
    const src = h.services.sources.create({ providerId: 'local-folder', config: { path: music, watch: false } });
    await h.services.scanner.scanSource(src.id);
    const track = (await h.app.inject({ url: '/api/library/tracks', headers: h.auth })).json().items[0];
    const { items } = (await h.app.inject({ method: 'POST', url: '/api/stream-urls', headers: { ...h.auth, origin: 'http://localhost' }, payload: { trackIds: [track.id] } })).json();
    const exo = { 'user-agent': 'Overtone-Android/1 (Media3)' };

    const first = await h.app.inject({ url: items[0].url, headers: { ...exo, range: 'bytes=0-' } });
    expect(first.statusCode).toBe(206);
    const size = Number(first.headers['content-range']!.toString().split('/')[1]);
    const seek = await h.app.inject({ url: items[0].url, headers: { ...exo, range: `bytes=${size - 1000}-` } });
    expect(seek.statusCode).toBe(206);
    expect(seek.headers['content-range']).toBe(`bytes ${size - 1000}-${size - 1}/${size}`);
    expect(seek.rawPayload).toHaveLength(1000);

    // An expired/forged token is refused (the app then fetches a fresh link and resumes).
    const forged = items[0].url.replace(/st=[^&]+/, 'st=1.1.1.AAAA');
    expect((await h.app.inject({ url: forged, headers: exo })).statusCode).toBe(401);
  });
});
