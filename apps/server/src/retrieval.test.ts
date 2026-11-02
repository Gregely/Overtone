import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from './testing/app-harness.js';
import { makeMp3 } from './testing/audio-fixtures.js';
import { json, mockHttp } from './testing/mock-http.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
afterEach(async () => h?.close());

const HASH = 'a'.repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}`;

/** AllDebrid endpoints the retrieval flow hits (fixture shapes from docs). */
function debridFetch(ready = true) {
  return mockHttp()
    .on('POST', '/v4/magnet/upload', json({ status: 'success', data: { magnets: [{ id: 202, hash: HASH }] } }))
    .on('POST', '/v4.1/magnet/status', json({ status: 'success', data: { magnets: [{ id: 202, status: ready ? 4 : 1 }] } }));
}

async function addAllDebridSource(fetch: typeof globalThis.fetch) {
  h = await createHarness({ fetch });
  const res = await h.app.inject({ method: 'POST', url: '/api/sources', headers: h.auth, payload: { providerId: 'alldebrid', name: 'AD', config: { apiKey: 'ad-key' } } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe('retrieval jobs over the API', () => {
  it('creates, lists, gets and completes a job', async () => {
    const mock = debridFetch();
    const sourceId = await addAllDebridSource(mock.fetch);

    const created = await h.app.inject({ method: 'POST', url: '/api/retrieval/jobs', headers: h.auth, payload: { providerId: sourceId, magnet: MAGNET, title: 'Test Album', artist: 'Test Artist' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ duplicate: false, job: { providerId: sourceId, providerName: 'AD', status: 'processing', infohash: HASH, title: 'Test Album' } });
    const jobId = created.json().job.id as string;

    const list = await h.app.inject({ url: '/api/retrieval/jobs', headers: h.auth });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe(jobId);

    const one = await h.app.inject({ url: `/api/retrieval/jobs/${jobId}`, headers: h.auth });
    expect(one.json()).toMatchObject({ id: jobId, status: 'processing' });

    // Backend poll marks it complete once the provider reports readiness.
    await h.services.retrieval.tick();
    const done = await h.app.inject({ url: `/api/retrieval/jobs/${jobId}`, headers: h.auth });
    expect(done.json()).toMatchObject({ status: 'complete', completedAt: expect.any(String) });
  });

  it('deduplicates by provider + infohash and never submits twice', async () => {
    const mock = debridFetch();
    const sourceId = await addAllDebridSource(mock.fetch);
    const payload = { providerId: sourceId, magnet: MAGNET };

    const first = await h.app.inject({ method: 'POST', url: '/api/retrieval/jobs', headers: h.auth, payload });
    const second = await h.app.inject({ method: 'POST', url: '/api/retrieval/jobs', headers: h.auth, payload });

    expect(second.json()).toMatchObject({ duplicate: true, job: { id: first.json().job.id } });
    expect(mock.to('/v4/magnet/upload')).toHaveLength(1);
  });

  it('cancels an active job and retries a failed one', async () => {
    const mock = debridFetch();
    const sourceId = await addAllDebridSource(mock.fetch);

    const created = await h.app.inject({ method: 'POST', url: '/api/retrieval/jobs', headers: h.auth, payload: { providerId: sourceId, magnet: MAGNET } });
    const jobId = created.json().job.id as string;

    const canceled = await h.app.inject({ method: 'POST', url: `/api/retrieval/jobs/${jobId}/cancel`, headers: h.auth });
    expect(canceled.json()).toMatchObject({ status: 'canceled' });

    const retried = await h.app.inject({ method: 'POST', url: `/api/retrieval/jobs/${jobId}/retry`, headers: h.auth });
    expect(retried.json()).toMatchObject({ status: 'processing' });
    expect(mock.to('/v4/magnet/upload')).toHaveLength(2); // original + retry
  });

  it('requires authentication', async () => {
    h = await createHarness();
    for (const url of ['/api/retrieval/jobs', '/api/retrieval/jobs/x', '/api/debrid/providers']) {
      const res = await h.app.inject({ url });
      expect(res.statusCode).toBe(401);
    }
    const post = await h.app.inject({ method: 'POST', url: '/api/retrieval/jobs', payload: { providerId: 'x', magnet: MAGNET } });
    expect(post.statusCode).toBe(401);
  });

  it('is admin-only', async () => {
    h = await createHarness({ config: { multiUser: true } });
    await h.services.auth.createUser('member', 'password1', false);
    const login = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'member', password: 'password1' } });
    const member = { authorization: `Bearer ${login.json().accessToken}` };

    const list = await h.app.inject({ url: '/api/retrieval/jobs', headers: member });
    expect(list.statusCode).toBe(403);
  });
});

describe('retrieval → playback', () => {
  it('imports a completed job and streams its audio through the player path', async () => {
    const mp3 = makeMp3({ title: 'One' }, 40);
    const fetch = mockHttp()
      .on('POST', '/v4/magnet/upload', json({ status: 'success', data: { magnets: [{ id: 202, hash: HASH }] } }))
      .on('POST', '/v4.1/magnet/status', json({ status: 'success', data: { magnets: [{ id: 202, status: 4 }] } }))
      .on('POST', '/v4/magnet/files', json({ status: 'success', data: { magnets: [{ id: '202', files: [
        { n: '01 - One.mp3', s: mp3.length, l: 'https://alldebrid.com/f/AAA' },
        { n: '02 - Two.mp3', s: mp3.length, l: 'https://alldebrid.com/f/BBB' },
      ] }] } }))
      .on('POST', '/v4/link/unlock', (req) => {
        const link = new URLSearchParams(req.body ?? '').get('link')!;
        return json({ status: 'success', data: { link: `https://cdn.example/${link.split('/').pop()}` } });
      })
      .on('GET', /cdn\.example/, () => new Response(new Uint8Array(mp3), { headers: { 'content-type': 'audio/mpeg', 'content-length': String(mp3.length), 'accept-ranges': 'bytes' } }));

    const sourceId = await addAllDebridSource(fetch.fetch);

    const created = await h.app.inject({ method: 'POST', url: '/api/retrieval/jobs', headers: h.auth, payload: { providerId: sourceId, magnet: MAGNET } });
    const jobId = created.json().job.id as string;

    // Complete the job (this also fires onComplete, which enqueues an import).
    await h.services.retrieval.tick();
    await h.services.scanner.idle();

    const filesRes = await h.app.inject({ url: `/api/retrieval/jobs/${jobId}/files`, headers: h.auth });
    expect(filesRes.statusCode).toBe(200);
    const files = filesRes.json();
    expect(files.imported).toBe(true);
    expect(files.files).toHaveLength(2);
    expect(files.tracks).toHaveLength(2);

    // Stream the first track through the existing stream-urls → stream path.
    const urls = await h.app.inject({ method: 'POST', url: '/api/stream-urls', headers: h.auth, payload: { trackIds: [files.tracks[0].id] } });
    expect(urls.json().unavailable).toEqual([]);
    const streamUrl = urls.json().items[0].url as string;
    const streamed = await h.app.inject({ url: streamUrl });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.rawPayload).toEqual(mp3);

    // Seeking (range requests) is forwarded upstream to the provider CDN.
    await h.app.inject({ url: streamUrl, headers: { range: 'bytes=0-99' } });
    expect(fetch.to(/cdn\.example/).some((c) => c.headers.get('range') === 'bytes=0-99')).toBe(true);
  });
});
