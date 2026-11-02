import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine } from '../test/fake-engine';
import { seeded, tracks } from '../test/fixtures';
import { PlayerController, type LinkFetcher, type StreamLink } from './controller';

const flush = () => new Promise((r) => setTimeout(r, 0));

let now = 1_000_000;
let engine: FakeEngine;
let issued: number;
let fetchLinks: ReturnType<typeof vi.fn<LinkFetcher>>;
let unavailable: Set<number>;
let player: PlayerController;

/** Server double: each fetch issues new URLs (…/v<n>) valid for 6 h. */
function makeFetcher() {
  return vi.fn<LinkFetcher>(async (ids) => {
    const links = new Map<number, StreamLink>();
    issued++;
    for (const id of ids) {
      if (unavailable.has(id)) continue;
      links.set(id, { url: `https://srv/api/stream/${id}?v=${issued}`, expiresAt: now + 6 * 3600_000, source: null });
    }
    return { links, unavailable: ids.filter((id) => unavailable.has(id)) };
  });
}

beforeEach(() => {
  now = 1_000_000;
  issued = 0;
  unavailable = new Set();
  engine = new FakeEngine();
  fetchLinks = makeFetcher();
  player = new PlayerController({ engine, fetchLinks, now: () => now, random: seeded() });
});

describe('PlayerController', () => {
  it('fetches links for the current and next two tracks in one request, then plays', async () => {
    player.playTracks(tracks(1, 2, 3, 4), 0);
    expect(engine.primed).toBe(1); // inside the user gesture
    expect(player.getSnapshot().status).toBe('loading');
    await flush();
    expect(fetchLinks).toHaveBeenCalledWith([1, 2, 3]);
    expect(engine.lastLoad()).toBe('load https://srv/api/stream/1?v=1 @0 autoplay');
    engine.emit({ type: 'playing' });
    expect(player.getSnapshot()).toMatchObject({ status: 'playing', current: { track: { id: 1 } } });

    player.next();
    await flush();
    expect(fetchLinks).toHaveBeenCalledTimes(1); // cached
    expect(engine.lastLoad()).toBe('load https://srv/api/stream/2?v=1 @0 autoplay');
  });

  it('preloads the next track near the end and advances on ended', async () => {
    player.playTracks(tracks(1, 2), 0);
    await flush();
    engine.emit({ type: 'playing' });
    engine.tick(100);
    expect(engine.preloaded).toBeNull();
    engine.tick(160);
    await flush();
    expect(engine.preloaded).toBe('https://srv/api/stream/2?v=1');
    engine.emit({ type: 'ended' });
    await flush();
    // Same URL as preloaded → the engine can switch instantly.
    expect(engine.lastLoad()).toBe('load https://srv/api/stream/2?v=1 @0 autoplay');
  });

  it('stops at the end of the queue with repeat off, and replays on play', async () => {
    player.playTracks(tracks(1), 0);
    await flush();
    engine.emit({ type: 'playing' });
    engine.emit({ type: 'ended' });
    expect(player.getSnapshot()).toMatchObject({ status: 'paused', queue: { finished: true } });
    player.play();
    await flush();
    expect(engine.lastLoad()).toBe('load https://srv/api/stream/1?v=1 @0 autoplay');
  });

  it('repeat one restarts the same track on ended', async () => {
    player.playTracks(tracks(1, 2), 0);
    player.cycleRepeat();
    player.cycleRepeat();
    expect(player.getSnapshot().queue.repeat).toBe('one');
    await flush();
    engine.emit({ type: 'ended' });
    await flush();
    expect(engine.calls.filter((c) => c.startsWith('load')).map((c) => c.split(' ')[1])).toEqual([
      'https://srv/api/stream/1?v=1',
      'https://srv/api/stream/1?v=1',
    ]);
  });

  it('shuffle keeps the current track playing without reloading', async () => {
    player.playTracks(tracks(1, 2, 3, 4, 5), 2);
    await flush();
    const loads = engine.calls.length;
    player.toggleShuffle();
    expect(player.getSnapshot().current?.track.id).toBe(3);
    expect(engine.calls.length).toBe(loads);
  });

  it('prev restarts after 3 s, otherwise goes back', async () => {
    player.playTracks(tracks(1, 2), 1);
    await flush();
    engine.tick(42);
    player.prev();
    await flush();
    expect(player.getSnapshot().current?.track.id).toBe(2);
    expect(engine.lastLoad()).toContain('/2?');
    engine.tick(1);
    player.prev();
    await flush();
    expect(player.getSnapshot().current?.track.id).toBe(1);
  });

  describe('link refresh', () => {
    it('re-fetches a fresh link and resumes at the same position when playback errors mid-track', async () => {
      player.playTracks(tracks(1, 2), 0);
      await flush();
      engine.emit({ type: 'playing' });
      engine.tick(73.5);
      engine.emit({ type: 'error', message: 'MEDIA_ERR_NETWORK' }); // e.g. token expired → 401
      expect(player.getSnapshot().status).toBe('loading');
      await flush();
      // The failed track's link is re-resolved, not reused (standalone mode relies on this).
      expect(fetchLinks).toHaveBeenLastCalledWith(expect.arrayContaining([1]), { refresh: [1] });
      expect(engine.lastLoad()).toBe('load https://srv/api/stream/1?v=2 @73.5 autoplay');
      engine.emit({ type: 'playing' });
      expect(player.getSnapshot()).toMatchObject({ status: 'playing', current: { track: { id: 1 } }, error: null });
    });

    it('keeps recovering from separate failures later in the same track', async () => {
      player.playTracks(tracks(1), 0);
      await flush();
      for (const [i, at] of [10, 40, 90, 150].entries()) {
        engine.tick(at);
        engine.emit({ type: 'error', message: 'x' });
        await flush();
        expect(engine.lastLoad()).toBe(`load https://srv/api/stream/1?v=${i + 2} @${at} autoplay`);
        engine.emit({ type: 'playing' });
      }
    });

    it('skips a track that keeps failing at the same spot', async () => {
      player.playTracks(tracks(1, 2), 0);
      await flush();
      for (let i = 0; i < 3; i++) {
        engine.tick(20);
        engine.emit({ type: 'error', message: 'decode' });
        await flush();
      }
      expect(player.getSnapshot().current?.track.id).toBe(2);
      expect(player.getSnapshot().notice?.text).toBe('Couldn\'t play "Track 1". Skipped.');
    });

    it('shows an error (no skip) when the last track fails', async () => {
      player.playTracks(tracks(1), 0);
      await flush();
      for (let i = 0; i < 3; i++) {
        engine.emit({ type: 'error', message: 'x' });
        await flush();
      }
      expect(player.getSnapshot()).toMatchObject({ status: 'error', error: "Couldn't play this track." });
    });

    it('refreshes a link that expired while paused before resuming', async () => {
      player.playTracks(tracks(1), 0);
      await flush();
      engine.emit({ type: 'playing' });
      engine.tick(30);
      player.pause();
      expect(player.getSnapshot().status).toBe('paused');
      now += 7 * 3600_000; // link (6 h) has expired
      player.play();
      await flush();
      expect(engine.lastLoad()).toBe('load https://srv/api/stream/1?v=2 @30 autoplay');
    });

    it('resumes without a new link when the cached one is still valid', async () => {
      player.playTracks(tracks(1), 0);
      await flush();
      engine.tick(30);
      player.pause();
      player.play();
      expect(engine.calls.at(-1)).toBe('play');
      expect(fetchLinks).toHaveBeenCalledTimes(1);
    });

    it('skips tracks that have no playable source', async () => {
      unavailable.add(1);
      player.playTracks(tracks(1, 2), 0);
      await flush();
      await flush();
      expect(player.getSnapshot().current?.track.id).toBe(2);
      expect(engine.lastLoad()).toContain('/stream/2?');
    });

    it('ignores a slow link response for a track the user already skipped', async () => {
      let release!: () => void;
      fetchLinks.mockImplementationOnce(
        (ids) =>
          new Promise((r) => {
            release = () => r({ links: new Map(ids.map((id) => [id, { url: `https://slow/${id}`, expiresAt: now + 1e7, source: null }])), unavailable: [] });
          }),
      );
      player.playTracks(tracks(1, 2, 3, 4), 0);
      player.jump(3);
      await flush();
      release();
      await flush();
      expect(engine.calls.filter((c) => c.startsWith('load'))).toEqual(['load https://srv/api/stream/4?v=1 @0 autoplay']);
    });
  });

  it('empties cleanly', async () => {
    player.playTracks(tracks(1), 0);
    await flush();
    player.clear();
    expect(engine.calls.at(-1)).toBe('unload');
    expect(player.getSnapshot()).toMatchObject({ status: 'idle', current: null });
  });
});
