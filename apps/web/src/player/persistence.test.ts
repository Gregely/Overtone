import { describe, expect, it } from 'vitest';
import { memoryStore } from '../platform/storage';
import { FakeEngine } from '../test/fake-engine';
import { seeded, tracks } from '../test/fixtures';
import { PlayerController, type LinkFetcher } from './controller';
import { persistQueue, restoreQueue } from './persistence';

const flush = () => new Promise((r) => setTimeout(r, 0));
const fetchLinks: LinkFetcher = async (ids) => ({
  links: new Map(ids.map((id) => [id, { url: `http://srv/s/${id}`, expiresAt: Date.now() + 3600_000, source: null }])),
  unavailable: [],
});

describe('queue persistence (resume after the app was killed)', () => {
  it('saves the queue + position and restores it paused; play resumes there on a fresh link', async () => {
    const store = memoryStore();
    const a = new PlayerController({ engine: new FakeEngine(), fetchLinks, random: seeded() });
    const stop = persistQueue(a, store);
    a.playTracks(tracks(1, 2, 3), 1);
    a.toggleShuffle();
    await flush();
    a.seek(95);
    a.pause();
    stop();
    expect(JSON.parse(store.data.get('overtone.queue')!)).toMatchObject({ version: 1, position: 95, shuffle: true });

    // "Process death": a brand-new controller + engine.
    const engine = new FakeEngine();
    const b = new PlayerController({ engine, fetchLinks, random: seeded() });
    await restoreQueue(b, store);
    expect(b.getSnapshot()).toMatchObject({ status: 'paused', position: 95, current: { track: { id: 2 } }, queue: { shuffle: true } });
    expect(engine.calls).toEqual([]); // nothing loads until the user presses play
    b.play();
    await flush();
    expect(engine.lastLoad()).toBe('load http://srv/s/2 @95 autoplay');
  });

  it('ignores corrupt snapshots', async () => {
    const store = memoryStore({ 'overtone.queue': '{"version":1,"tracks":[],"order":[5],"cursor":9}' });
    const p = new PlayerController({ engine: new FakeEngine(), fetchLinks });
    await restoreQueue(p, store);
    expect(p.getSnapshot().current).toBeNull();
    await restoreQueue(p, memoryStore({ 'overtone.queue': 'not json' }));
    expect(p.getSnapshot().current).toBeNull();
  });
});
