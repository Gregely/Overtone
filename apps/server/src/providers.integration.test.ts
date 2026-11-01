import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderPlugin } from './providers/types.js';
import { createHarness } from './testing/app-harness.js';
import { makeMp3 } from './testing/audio-fixtures.js';
import { json } from './testing/mock-http.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
afterEach(async () => h?.close());

const signal = new AbortController().signal;

// ── A provider with a device login, to exercise the generic flow ────────────

const loginState = { approved: false, starts: 0, polls: 0 };
const seen: Array<Record<string, unknown>> = [];
const devicePlugin: ProviderPlugin = {
  manifest: {
    id: 'device-demo',
    name: 'DeviceDemo',
    description: '',
    category: 'debrid',
    capabilities: { testConnection: true },
    configSchema: {
      fields: [
        { key: 'apiKey', type: 'secret', label: 'API key' },
        { key: 'refreshToken', type: 'secret', label: 'refresh', hidden: true },
      ],
      deviceLogin: { label: 'Log in with DeviceDemo', replaces: ['apiKey', 'refreshToken'] },
    },
    deviceFlow: {
      async start() {
        loginState.starts++;
        return { handle: 'secret-handle', userCode: 'WXYZ', verificationUrl: 'https://demo.test/device', expiresAt: new Date(Date.now() + 600_000), intervalSeconds: 1 };
      },
      async poll(handle) {
        loginState.polls++;
        expect(handle).toBe('secret-handle');
        return loginState.approved ? { status: 'complete', secrets: { refreshToken: 'RT-from-login', apiKey: 'AK-from-login' } } : { status: 'pending' };
      },
    },
  },
  create(config) {
    seen.push({ ...config });
    return {
      async *listLibrary() {},
      async resolveStream() {
        return { url: 'https://x' };
      },
      async testConnection() {
        return { ok: config.apiKey === 'AK-from-login', message: config.apiKey === 'AK-from-login' ? 'Signed in' : 'Not signed in' };
      },
    };
  },
};

describe('"Log in with…" (device login) over the API', () => {
  it('starts, polls (throttled), saves credentials server-side, and is single-use', async () => {
    Object.assign(loginState, { approved: false, starts: 0, polls: 0 });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    h = await createHarness({ plugins: [devicePlugin] });

    const providers = (await h.app.inject({ url: '/api/providers', headers: h.auth })).json();
    expect(providers.find((p: { id: string }) => p.id === 'device-demo').configSchema.deviceLogin).toEqual({
      label: 'Log in with DeviceDemo',
      replaces: ['apiKey', 'refreshToken'],
    });

    const start = (await h.app.inject({ method: 'POST', url: '/api/providers/device-demo/device-login', headers: h.auth })).json();
    expect(start).toEqual({ flowId: expect.any(String), userCode: 'WXYZ', verificationUrl: 'https://demo.test/device', expiresAt: expect.any(String), intervalSeconds: 1 });
    expect(JSON.stringify(start)).not.toContain('secret-handle');

    const poll = () => h.app.inject({ url: `/api/device-login/${start.flowId}`, headers: h.auth }).then((r) => r.json());
    expect(await poll()).toEqual({ status: 'pending' });
    expect(loginState.polls).toBe(0); // too soon: no upstream call
    now += 1100;
    expect(await poll()).toEqual({ status: 'pending' });
    expect(loginState.polls).toBe(1);
    loginState.approved = true;
    now += 1100;
    expect(await poll()).toEqual({ status: 'complete' });

    // Test before saving works with the login's credentials.
    const tested = await h.app.inject({ method: 'POST', url: '/api/providers/device-demo/test', headers: h.auth, payload: { config: {}, deviceLogin: start.flowId } });
    expect(tested.json()).toEqual({ ok: true, message: 'Signed in' });

    const created = await h.app.inject({ method: 'POST', url: '/api/sources', headers: h.auth, payload: { providerId: 'device-demo', config: {}, deviceLogin: start.flowId } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('RT-from-login');
    expect(created.body).not.toContain('AK-from-login');
    expect(created.json().config).toEqual({ values: {}, secretsSet: ['apiKey'], signedInWithDeviceLogin: true });
    h.services.sources.instance(created.json().id);
    expect(seen.at(-1)).toMatchObject({ apiKey: 'AK-from-login', refreshToken: 'RT-from-login' });

    // Single use.
    const again = await h.app.inject({ method: 'POST', url: '/api/sources', headers: h.auth, payload: { providerId: 'device-demo', config: {}, deviceLogin: start.flowId } });
    expect(again.statusCode).toBe(404);
    vi.restoreAllMocks();
  });

  it('pasting a new key clears credentials from an earlier login', async () => {
    h = await createHarness({ plugins: [devicePlugin] });
    const src = h.services.sources.create({ providerId: 'device-demo', config: {} }, { apiKey: 'AK-from-login', refreshToken: 'RT-from-login' });
    await h.app.inject({ method: 'PATCH', url: `/api/sources/${src.id}`, headers: h.auth, payload: { config: { apiKey: 'typed-key' } } });
    h.services.sources.instance(src.id);
    expect(seen.at(-1)).toMatchObject({ apiKey: 'typed-key' });
    expect(seen.at(-1)).not.toHaveProperty('refreshToken');
  });

  it("rejects other users' and unknown flows, and providers without a login", async () => {
    h = await createHarness({ plugins: [devicePlugin], config: { multiUser: true } });
    const start = (await h.app.inject({ method: 'POST', url: '/api/providers/device-demo/device-login', headers: h.auth })).json();
    await h.services.auth.createUser('other', 'password1', true);
    const login = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'other', password: 'password1' } });
    const other = { authorization: `Bearer ${login.json().accessToken}` };
    expect((await h.app.inject({ url: `/api/device-login/${start.flowId}`, headers: other })).statusCode).toBe(404);
    expect((await h.app.inject({ url: '/api/device-login/nope', headers: h.auth })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: '/api/providers/local-folder/device-login', headers: h.auth })).statusCode).toBe(400);
  });
});

// ── Subsonic end to end (scan → library → proxied stream) ─────────────────

describe('Subsonic source end to end', () => {
  const BASE = 'https://navi.test';
  const mp3 = makeMp3({ title: 'Remote Song' }, 40);
  const env = (extra: object) => json({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.60', openSubsonic: true, ...extra } });

  function fetchMock(streamBody: () => Response = () => new Response(new Uint8Array(mp3), { headers: { 'content-type': 'audio/mpeg', 'content-length': String(mp3.length) } })) {
    return vi.fn(async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname === '/rest/ping.view') return env({});
      if (u.pathname === '/rest/search3.view')
        return env({
          searchResult3:
            u.searchParams.get('songOffset') === '0'
              ? { song: [{ id: 'nv1', isDir: false, title: 'Remote Song', artist: 'Remote Artist', album: 'Remote Album', track: 1, suffix: 'mp3', contentType: 'audio/mpeg', size: mp3.length, duration: 1, path: 'Remote Artist/Remote Album/01 - Remote Song.mp3' }] }
              : {},
        });
      if (u.pathname === '/rest/stream.view') return streamBody();
      throw new Error(`unexpected ${u.href}`);
    });
  }

  it('scans songs with tags and proxies streams (never redirects)', async () => {
    const fetch = fetchMock();
    h = await createHarness({ fetch: fetch as unknown as typeof globalThis.fetch });
    const bad = await h.app.inject({ method: 'POST', url: '/api/sources', headers: h.auth, payload: { providerId: 'subsonic', streamMode: 'redirect', config: { url: BASE, username: 'u', password: 'pw' } } });
    expect(bad.statusCode).toBe(422);
    const created = await h.app.inject({ method: 'POST', url: '/api/sources', headers: h.auth, payload: { providerId: 'subsonic', name: 'Navidrome', config: { url: BASE, username: 'u', password: 'pw' } } });
    expect(created.json().config).toEqual({ values: { url: BASE, username: 'u' }, secretsSet: ['password'] });
    await h.services.scanner.scanSource(created.json().id);
    await h.services.matchWorker.drain();

    const tracks = (await h.app.inject({ url: '/api/library/tracks', headers: h.auth })).json().items;
    expect(tracks).toMatchObject([{ title: 'Remote Song', artistCredit: 'Remote Artist', album: { title: 'Remote Album' }, sources: [{ sourceName: 'Navidrome', category: 'server' }] }]);

    const { items } = (await h.app.inject({ method: 'POST', url: '/api/stream-urls', headers: h.auth, payload: { trackIds: [tracks[0].id] } })).json();
    const res = await h.app.inject({ url: items[0].url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(mp3);
    expect(res.headers.location).toBeUndefined();
    // The password never leaves the server: not in responses, and only as a salted token upstream.
    const streamCall = fetch.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.pathname === '/rest/stream.view')!;
    expect(streamCall.searchParams.get('format')).toBe('raw');
    expect(streamCall.href).not.toContain('pw');
    expect(h.logs()).not.toContain('pw&');
  });

  it('treats an error document from the source as a failure: refreshes once, then a clear error', async () => {
    const xml = () => new Response('<subsonic-response status="failed"><error code="70"/></subsonic-response>', { headers: { 'content-type': 'text/xml' } });
    const fetch = fetchMock(xml);
    h = await createHarness({ fetch: fetch as unknown as typeof globalThis.fetch });
    const src = h.services.sources.create({ providerId: 'subsonic', name: 'Navidrome', config: { url: BASE, username: 'u', password: 'pw' } });
    await h.services.scanner.scanSource(src.id);
    const track = (await h.app.inject({ url: '/api/library/tracks', headers: h.auth })).json().items[0];
    const { items } = (await h.app.inject({ method: 'POST', url: '/api/stream-urls', headers: h.auth, payload: { trackIds: [track.id] } })).json();
    const res = await h.app.inject({ url: items[0].url });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toBe('"Navidrome" couldn\'t stream this file: it returned an error page instead of audio (text/xml), even after getting a fresh link.');
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('/rest/stream.view'))).toHaveLength(2);
  });
});

describe('built-in provider catalogue', () => {
  it('lists every provider with its schema, and debrid sources cannot redirect', async () => {
    h = await createHarness();
    const list = (await h.app.inject({ url: '/api/providers', headers: h.auth })).json() as Array<{ id: string; capabilities: { redirectable: boolean; deviceFlow: boolean }; configSchema: { deviceLogin?: unknown } }>;
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    expect(Object.keys(byId)).toEqual(['local-folder', 'subsonic', 'internet-archive', 'real-debrid', 'alldebrid', 'torbox', 'premiumize']);
    for (const id of ['real-debrid', 'alldebrid', 'torbox', 'premiumize']) expect(byId[id]!.capabilities.redirectable).toBe(false);
    for (const id of ['real-debrid', 'alldebrid', 'torbox']) expect(byId[id]!.configSchema.deviceLogin).toBeDefined();
    expect(byId.premiumize!.configSchema.deviceLogin).toBeUndefined(); // needs OVERTONE_PREMIUMIZE_CLIENT_ID
    expect(byId['internet-archive']!.capabilities.redirectable).toBe(true);
    void signal;
  });
});
