import type { TrackDto } from '@overtone/shared';

export function track(id: number, extra: Partial<TrackDto> = {}): TrackDto {
  return {
    id,
    title: `Track ${id}`,
    artistCredit: 'Artist',
    artist: { id: 1, name: 'Artist' },
    album: { id: 1, title: 'Album' },
    discNo: 1,
    trackNo: id,
    durationMs: 180_000,
    mbid: null,
    coverUrl: `/api/artwork/release/1?at=tok`,
    sources: [{ sourceId: 's1', sourceName: 'Music', providerId: 'local-folder', category: 'local' }],
    matchStatus: 'matched',
    ...extra,
  };
}

export const tracks = (...ids: number[]) => ids.map((id) => track(id));

/** Deterministic PRNG (mulberry32). */
export function seeded(seed = 42): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
