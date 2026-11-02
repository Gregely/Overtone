import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/database.js';
import { TEST_DATABASES } from '../../testing/databases.js';
import { luceneEscape, MusicBrainzClient, RateLimiter } from './client.js';

const recordingSearch = {
  recordings: [
    {
      id: 'rec-1',
      score: 100,
      title: 'Da Funk',
      length: 329560,
      'artist-credit': [{ name: 'Daft Punk', joinphrase: '', artist: { id: 'art-1', name: 'Daft Punk', 'sort-name': 'Daft Punk' } }],
      releases: [
        {
          id: 'rel-1',
          title: 'Homework',
          status: 'Official',
          date: '1997-01-20',
          'track-count': 16,
          'release-group': { id: 'rg-1', 'primary-type': 'Album' },
          media: [{ position: 1, format: 'CD', track: [{ id: 't', number: '4', title: 'Da Funk', length: 329560 }], 'track-count': 16 }],
        },
      ],
    },
  ],
};

let db: Database;

function setup(responses: Array<() => Response>) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => responses.shift()!());
  const client = new MusicBrainzClient({
    db,
    userAgent: 'Overtone/9.9 ( test@example.com )',
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { client, fetch, sleeps, advance: (ms: number) => (now += ms) };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

describe.each(TEST_DATABASES)('MusicBrainzClient ($name)', (factory) => {
  beforeEach(async () => {
    db = await factory.open();
  });

  it('sends a proper User-Agent and requests JSON', async () => {
    const { client, fetch } = setup([json(recordingSearch)]);
    await client.searchRecordings('recording:"da funk"');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://musicbrainz.org/ws/2/recording?query=recording%3A%22da%20funk%22&limit=15&fmt=json');
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe('Overtone/9.9 ( test@example.com )');
  });

  it('maps recordings with release position and release group', async () => {
    const { client } = setup([json(recordingSearch)]);
    const [rec] = await client.searchRecordings('x');
    expect(rec).toEqual({
      id: 'rec-1',
      title: 'Da Funk',
      lengthMs: 329560,
      credit: { text: 'Daft Punk', artists: [{ id: 'art-1', name: 'Daft Punk', sortName: 'Daft Punk' }] },
      releases: [
        {
          id: 'rel-1',
          title: 'Homework',
          status: 'Official',
          date: '1997-01-20',
          country: null,
          credit: null,
          releaseGroup: { id: 'rg-1', primaryType: 'Album', secondaryTypes: [] },
          trackCount: 16,
          discNo: 1,
          trackNo: 4,
        },
      ],
    });
  });

  it('caches responses (including misses) in SQLite', async () => {
    const { client, fetch } = setup([json(recordingSearch), json({ error: 'not found' }, 404)]);
    await client.searchRecordings('same');
    await client.searchRecordings('same');
    expect(await client.getRelease('missing')).toBeNull();
    expect(await client.getRelease('missing')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent identical requests', async () => {
    const { client, fetch } = setup([json(recordingSearch)]);
    await Promise.all([client.searchRecordings('q'), client.searchRecordings('q')]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('spaces requests at least the minimum interval apart', async () => {
    const { client, sleeps } = setup([json({}), json({}), json({})]);
    await client.searchRecordings('a');
    await client.searchRecordings('b');
    await client.searchRecordings('c');
    expect(sleeps).toEqual([1100, 1100]);
  });

  it('retries 503 with backoff, then gives up with an error', async () => {
    const { client, fetch } = setup([json({}, 503), json(recordingSearch)]);
    expect(await client.searchRecordings('x')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    const failing = setup(Array.from({ length: 4 }, () => json({}, 503)));
    await expect(failing.client.searchRecordings('y')).rejects.toThrow(/503/);
    expect(failing.fetch).toHaveBeenCalledTimes(4);
  });

  it('maps a release lookup with media and per-track credits', async () => {
    const { client } = setup([
      json({
        id: 'rel-1',
        title: 'Homework',
        status: 'Official',
        date: '1997',
        'artist-credit': [{ name: 'Daft Punk', artist: { id: 'a', name: 'Daft Punk' } }],
        'release-group': { id: 'rg', 'primary-type': 'Album', 'secondary-types': [] },
        media: [
          { position: 1, tracks: [{ number: '1', title: 'One', length: 1000, recording: { id: 'r1', title: 'One', length: 1000 } }] },
          { position: 2, tracks: [{ number: '1', title: 'Two', recording: { id: 'r2', title: 'Two', length: 2000 } }] },
        ],
      }),
    ]);
    const rel = await client.getRelease('rel-1');
    expect(rel?.trackCount).toBe(2);
    expect(rel?.tracks.map((t) => [t.discNo, t.trackNo, t.title, t.lengthMs, t.recording.credit.text])).toEqual([
      [1, 1, 'One', 1000, 'Daft Punk'],
      [2, 1, 'Two', 2000, 'Daft Punk'],
    ]);
  });
});

describe('RateLimiter', () => {
  it('keeps going after a task fails', async () => {
    let now = 0;
    const rl = new RateLimiter(100, () => now, async (ms) => void (now += ms));
    await expect(rl.schedule(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(rl.schedule(async () => 'ok')).resolves.toBe('ok');
    expect(now).toBe(100);
  });
});

describe('luceneEscape', () => {
  it('escapes special characters', () => {
    expect(luceneEscape('AC/DC: "Live" (1992)!')).toBe('AC\\/DC\\: \\"Live\\" \\(1992\\)\\!');
  });
});
