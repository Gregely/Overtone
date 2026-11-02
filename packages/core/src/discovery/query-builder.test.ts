import { describe, expect, it } from 'vitest';
import { buildQueries } from './query-builder.js';

describe('buildQueries', () => {
  it('builds track queries most-specific first', () => {
    const q = buildQueries({ scope: 'track', title: 'Stairway to Heaven', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', year: 1971 });
    expect(q[0]).toBe('Led Zeppelin Stairway to Heaven');
    expect(q[1]).toBe('Led Zeppelin Led Zeppelin IV Stairway to Heaven');
    expect(q[2]).toBe('Led Zeppelin Stairway to Heaven 1971');
    expect(q[3]).toBe('Stairway to Heaven');
  });

  it('builds album queries', () => {
    const q = buildQueries({ scope: 'album', title: 'Led Zeppelin IV', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', year: 1971 });
    expect(q[0]).toBe('Led Zeppelin Led Zeppelin IV');
    expect(q[1]).toBe('Led Zeppelin Led Zeppelin IV 1971');
    expect(q[2]).toBe('Led Zeppelin IV');
  });

  it('deduplicates and drops empty/near-identical variations', () => {
    const q = buildQueries({ scope: 'album', title: 'Album', artist: 'Artist', album: 'Album' });
    // "Artist Album" once, "Album" once — the "Artist Album" (title===album) dup is dropped.
    expect(q).toEqual(['Artist Album', 'Album']);
  });

  it('works with title-only targets (no artist)', () => {
    const q = buildQueries({ scope: 'track', title: 'Song', album: 'Album' });
    expect(q).toContain('Song');
  });

  it('strips a trailing year from artist/title to avoid doubling', () => {
    const q = buildQueries({ scope: 'track', title: 'Song', artist: 'Artist (2020)', year: 2020 });
    expect(q[0]).toBe('Artist Song');
  });
});
