/**
 * Fake Subsonic + Real-Debrid servers for the browser smoke test. They speak
 * just enough of each documented API for the real adapters to list, log in
 * and stream; audio is generated silence.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { makeMp3 } from './audio-fixtures.js';

export interface FakeServices {
  base: string;
  close(): Promise<void>;
}

const FRAMES = 400; // ~10 s

export async function startFakeServices(port: number): Promise<FakeServices> {
  const base = `http://127.0.0.1:${port}`;
  const songs = [
    { id: 'nv1', title: 'Server Song One', track: 1 },
    { id: 'nv2', title: 'Server Song Two', track: 2 },
  ];
  const audio = new Map<string, Buffer>();
  const mp3 = (key: string, title: string) => {
    if (!audio.has(key)) audio.set(key, makeMp3({ title }, FRAMES));
    return audio.get(key)!;
  };
  let credentialPolls = 0;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const sendAudio = (res: ServerResponse, buf: Buffer) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(buf.length), 'accept-ranges': 'none' });
    res.end(buf);
  };
  const subsonic = (extra: object) => ({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'fakesonic', serverVersion: '1.0', openSubsonic: true, ...extra } });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', base);
    const p = u.pathname;
    // Standalone mode in a plain browser calls these services directly (no server), so allow CORS.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    let body = '';
    for await (const chunk of req) body += chunk;

    // ── Subsonic (token auth: user "e2e" / password "e2e-pass") ──
    if (p.startsWith('/subsonic/rest/')) {
      const { createHash } = await import('node:crypto');
      const ok = u.searchParams.get('u') === 'e2e' && u.searchParams.get('t') === createHash('md5').update(`e2e-pass${u.searchParams.get('s')}`).digest('hex');
      if (!ok) return send(res, 200, { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: 40, message: 'Wrong username or password' } } });
      if (p.endsWith('/ping.view')) return send(res, 200, subsonic({}));
      if (p.endsWith('/search3.view')) {
        const first = u.searchParams.get('songOffset') === '0';
        return send(res, 200, subsonic({
          searchResult3: first
            ? { song: songs.map((s) => ({ id: s.id, isDir: false, title: s.title, artist: 'Server Artist', album: 'Server Album', track: s.track, suffix: 'mp3', contentType: 'audio/mpeg', duration: 10, path: `Server Artist/Server Album/0${s.track} - ${s.title}.mp3` })) }
            : {},
        }));
      }
      if (p.endsWith('/stream.view')) {
        const s = songs.find((x) => x.id === u.searchParams.get('id'));
        return s ? sendAudio(res, mp3(s.id, s.title)) : send(res, 200, { 'subsonic-response': { status: 'failed', error: { code: 70 } } });
      }
    }

    // ── Real-Debrid OAuth device flow ──
    if (p === '/rd/oauth/v2/device/code') {
      credentialPolls = 0;
      return send(res, 200, { device_code: 'DEVCODE', user_code: 'E2E-CODE', interval: 1, expires_in: 600, verification_url: `${base}/rd/device` });
    }
    if (p === '/rd/oauth/v2/device/credentials') {
      // Approved on the second poll.
      return ++credentialPolls < 2 ? send(res, 403, { error: 'authorization_pending' }) : send(res, 200, { client_id: 'E2ECID', client_secret: 'E2ESECRET' });
    }
    if (p === '/rd/oauth/v2/token') return send(res, 200, { access_token: 'E2E-ACCESS', expires_in: 3600, refresh_token: 'E2E-REFRESH', token_type: 'Bearer' });

    // ── Real-Debrid REST ──
    if (p.startsWith('/rd/rest/1.0/')) {
      if (req.headers.authorization !== 'Bearer E2E-ACCESS') return send(res, 401, { error: 'bad_token', error_code: 8 });
      const path = p.slice('/rd/rest/1.0'.length);
      if (path === '/user') return send(res, 200, { username: 'e2e-user', type: 'premium', premium: 999999, expiration: '2030-01-01T00:00:00.000Z' });
      if (path === '/torrents')
        return send(res, 200, [{ id: 'T1', filename: 'Debrid Artist - Debrid Album', status: 'downloaded', links: [`${base}/rd/d/L1`], added: '2026-01-01T00:00:00.000Z' }], { 'x-total-count': '1' });
      if (path === '/torrents/info/T1')
        return send(res, 200, { id: 'T1', filename: 'Debrid Artist - Debrid Album', status: 'downloaded', links: [`${base}/rd/d/L1`], files: [{ id: 1, path: '/01 - Debrid Song.mp3', bytes: 1, selected: 1 }] });
      if (path === '/downloads') return res.writeHead(204).end();
      if (path === '/unrestrict/link' && req.method === 'POST') {
        const link = new URLSearchParams(body).get('link');
        if (link !== `${base}/rd/d/L1`) return send(res, 404, { error: 'unknown_ressource', error_code: 7 });
        return send(res, 200, { filename: '01 - Debrid Song.mp3', filesize: 1, mimeType: 'audio/mpeg', download: `${base}/rd/cdn/debrid-song.mp3` });
      }
    }
    if (p === '/rd/cdn/debrid-song.mp3') return sendAudio(res, mp3('rd', 'Debrid Song'));

    // ── MusicBrainz WS/2 (standalone e2e): knows nothing, so files stay tag-matched ──
    if (p.startsWith('/ws/2/recording')) return send(res, 200, { recordings: [], count: 0 });
    if (p.startsWith('/ws/2/release')) return send(res, 200, { releases: [], count: 0 });

    send(res, 404, { error: `fake: no route ${req.method} ${p}` });
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { base, close: () => new Promise((r) => server.close(() => r())) };
}
