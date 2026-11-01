import { describe, expect, it } from 'vitest';
import { seeded, tracks } from '../test/fixtures';
import { currentItem, emptyQueue, hasNext, hasPrev, peekNext, queueReducer, upcoming, type QueueAction, type QueueState } from './queue';

const run = (actions: QueueAction[], from: QueueState = emptyQueue, random = seeded()) =>
  actions.reduce((s, a) => queueReducer(s, a, random), from);
const ids = (s: QueueState) => upcoming({ ...s, cursor: 0 }).map((i) => i.track.id);
const cur = (s: QueueState) => currentItem(s)?.track.id ?? null;

describe('queue state machine', () => {
  it('replaces the queue and starts at the chosen index', () => {
    const s = run([{ type: 'replace', tracks: tracks(1, 2, 3), startIndex: 1 }]);
    expect(cur(s)).toBe(2);
    expect(ids(s)).toEqual([1, 2, 3]);
    expect(s.playToken).toBe(1);
  });

  it('advances on next/ended and finishes at the end with repeat off', () => {
    let s = run([{ type: 'replace', tracks: tracks(1, 2) }]);
    s = queueReducer(s, { type: 'ended' });
    expect(cur(s)).toBe(2);
    const before = s.playToken;
    s = queueReducer(s, { type: 'ended' });
    expect(s.finished).toBe(true);
    expect(cur(s)).toBe(2); // stays on the last track, ready to replay
    expect(s.playToken).toBe(before);
    expect(hasNext(s)).toBe(false);
  });

  it('repeat all wraps in both directions', () => {
    let s = run([{ type: 'replace', tracks: tracks(1, 2, 3), startIndex: 2 }, { type: 'setRepeat', mode: 'all' }]);
    s = queueReducer(s, { type: 'next' });
    expect(cur(s)).toBe(1);
    s = queueReducer(s, { type: 'prev' });
    expect(cur(s)).toBe(3);
    expect(hasPrev(s)).toBe(true);
    expect(peekNext(s)?.track.id).toBe(1);
  });

  it('repeat one loops on ended but next still advances', () => {
    let s = run([{ type: 'replace', tracks: tracks(1, 2) }, { type: 'setRepeat', mode: 'one' }]);
    const token = s.playToken;
    s = queueReducer(s, { type: 'ended' });
    expect(cur(s)).toBe(1);
    expect(s.playToken).toBe(token + 1); // restart signal
    expect(peekNext(s)?.track.id).toBe(1);
    s = queueReducer(s, { type: 'next' });
    expect(cur(s)).toBe(2);
  });

  it('cycles repeat off → all → one → off', () => {
    const modes = [];
    let s = emptyQueue;
    for (let i = 0; i < 3; i++) {
      s = queueReducer(s, { type: 'cycleRepeat' });
      modes.push(s.repeat);
    }
    expect(modes).toEqual(['all', 'one', 'off']);
  });

  it('prev at the first track restarts it', () => {
    const s0 = run([{ type: 'replace', tracks: tracks(1, 2) }]);
    const s1 = queueReducer(s0, { type: 'prev' });
    expect(cur(s1)).toBe(1);
    expect(s1.playToken).toBe(s0.playToken + 1);
  });

  describe('shuffle', () => {
    it('plays the chosen track first, then a permutation of the rest', () => {
      const s = run([{ type: 'replace', tracks: tracks(1, 2, 3, 4, 5, 6), startIndex: 3, shuffle: true }]);
      expect(cur(s)).toBe(4);
      expect(s.cursor).toBe(0);
      const order = ids(s);
      expect(order[0]).toBe(4);
      expect([...order].sort()).toEqual([1, 2, 3, 4, 5, 6]);
      expect(order).not.toEqual([4, 1, 2, 3, 5, 6]); // actually shuffled (seeded)
    });

    it('toggling keeps the current track and history, shuffles only what is ahead', () => {
      let s = run([{ type: 'replace', tracks: tracks(1, 2, 3, 4, 5, 6) }, { type: 'next' }, { type: 'next' }]);
      expect(cur(s)).toBe(3);
      s = queueReducer(s, { type: 'toggleShuffle' }, seeded(7));
      expect(cur(s)).toBe(3);
      const order = ids(s);
      expect(order.slice(0, 3)).toEqual([1, 2, 3]);
      expect([...order.slice(3)].sort()).toEqual([4, 5, 6]);

      s = queueReducer(s, { type: 'toggleShuffle' });
      expect(ids(s)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(cur(s)).toBe(3);
    });

    it('is deterministic for a given random source', () => {
      const a = run([{ type: 'replace', tracks: tracks(1, 2, 3, 4, 5), shuffle: true }], emptyQueue, seeded(1));
      const b = run([{ type: 'replace', tracks: tracks(1, 2, 3, 4, 5), shuffle: true }], emptyQueue, seeded(1));
      expect(ids(a)).toEqual(ids(b));
    });
  });

  it('play next inserts after the current track; append adds to the end', () => {
    let s = run([{ type: 'replace', tracks: tracks(1, 2, 3) }]);
    s = queueReducer(s, { type: 'append', tracks: tracks(9) });
    s = queueReducer(s, { type: 'playNext', tracks: tracks(7, 8) });
    expect(ids(s)).toEqual([1, 7, 8, 2, 3, 9]);
    expect(cur(s)).toBe(1);
  });

  it('allows the same track twice with distinct uids', () => {
    const s = run([{ type: 'replace', tracks: tracks(1) }, { type: 'append', tracks: tracks(1) }]);
    const [a, b] = upcoming(s);
    expect(a!.uid).not.toBe(b!.uid);
  });

  it('append to an empty queue makes the first appended track current', () => {
    const s = run([{ type: 'append', tracks: tracks(5, 6) }]);
    expect(cur(s)).toBe(5);
    expect(s.playToken).toBe(1);
  });

  it('jump moves the cursor and restarts', () => {
    const s = run([{ type: 'replace', tracks: tracks(1, 2, 3) }, { type: 'jump', position: 2 }]);
    expect(cur(s)).toBe(3);
    expect(run([{ type: 'jump', position: 9 }], s)).toBe(s);
  });

  describe('remove', () => {
    const base = () => run([{ type: 'replace', tracks: tracks(1, 2, 3, 4), startIndex: 1 }]);
    it('before the cursor keeps the current track', () => {
      const s = queueReducer(base(), { type: 'remove', position: 0 });
      expect(cur(s)).toBe(2);
      expect(ids(s)).toEqual([2, 3, 4]);
      expect(s.items).toHaveLength(3);
    });
    it('the current track plays the next one', () => {
      const b = base();
      const s = queueReducer(b, { type: 'remove', position: 1 });
      expect(cur(s)).toBe(3);
      expect(s.playToken).toBe(b.playToken + 1);
    });
    it('the last remaining track empties the queue', () => {
      const s = run([{ type: 'replace', tracks: tracks(1) }, { type: 'remove', position: 0 }]);
      expect(cur(s)).toBeNull();
    });
    it('the current last track finishes', () => {
      const s = run([{ type: 'replace', tracks: tracks(1, 2), startIndex: 1 }, { type: 'remove', position: 1 }]);
      expect(cur(s)).toBe(1);
      expect(s.finished).toBe(true);
    });
  });

  it('move reorders and tracks the cursor', () => {
    let s = run([{ type: 'replace', tracks: tracks(1, 2, 3, 4), startIndex: 1 }]);
    s = queueReducer(s, { type: 'move', from: 3, to: 0 });
    expect(ids(s)).toEqual([4, 1, 2, 3]);
    expect(cur(s)).toBe(2);
    s = queueReducer(s, { type: 'move', from: 2, to: 3 });
    expect(cur(s)).toBe(2);
    expect(ids(s)).toEqual([4, 1, 3, 2]);
  });

  it('clear keeps shuffle/repeat preferences', () => {
    const s = run([{ type: 'replace', tracks: tracks(1, 2), shuffle: true }, { type: 'setRepeat', mode: 'all' }, { type: 'clear' }]);
    expect(s).toMatchObject({ items: [], cursor: -1, shuffle: true, repeat: 'all' });
  });
});
