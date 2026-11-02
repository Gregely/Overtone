import { describe, expect, it } from 'vitest';
import type { DiscoverResultDto } from '@overtone/shared';
import { bestCachedCandidate, classify, isCached, magnetOf } from './source-matcher.js';

function result(score: number, cached: Array<'cached' | 'uncached'> = [], seeders: number | null = null, extra: Partial<DiscoverResultDto> = {}): DiscoverResultDto {
  return {
    key: 'k',
    title: 'Album',
    artist: 'Artist',
    album: 'Album',
    year: 2000,
    format: 'flac',
    quality: null,
    type: 'album',
    size: 100,
    seeders,
    leechers: null,
    files: null,
    sources: [{ id: 'x1337', name: '1337x' }],
    magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    downloadUrl: null,
    score,
    reasons: [],
    cached: cached.map((s) => ({ providerId: 'ad', providerName: 'AllDebrid', status: s })),
    ...extra,
  };
}

describe('classify', () => {
  it('classifies by metadata-agreement score', () => {
    expect(classify(result(0.9))).toBe('high');
    expect(classify(result(0.6))).toBe('probable');
    expect(classify(result(0.4))).toBe('ambiguous');
    expect(classify(result(0.2))).toBe('rejected');
  });
});

describe('isCached', () => {
  it('detects a cached provider annotation', () => {
    expect(isCached(result(0.9, ['cached']))).toBe(true);
    expect(isCached(result(0.9, ['uncached']))).toBe(false);
  });
});

describe('bestCachedCandidate', () => {
  it('selects the highest-confidence cached result', () => {
    const best = bestCachedCandidate([result(0.9, ['cached'], 5), result(0.95, ['cached'], 1), result(0.8, ['uncached'], 100)]);
    expect(best?.result.score).toBe(0.95);
  });

  it('breaks ties by seeders', () => {
    const best = bestCachedCandidate([result(0.9, ['cached'], 5), result(0.9, ['cached'], 50)]);
    expect(best?.result.seeders).toBe(50);
  });

  it('never auto-plays an ambiguous cached result', () => {
    expect(bestCachedCandidate([result(0.4, ['cached'], 10)])).toBeNull();
  });

  it('returns null when nothing is cached', () => {
    expect(bestCachedCandidate([result(0.9, ['uncached'], 10)])).toBeNull();
  });
});

describe('magnetOf', () => {
  it('prefers the explicit magnet and derives one from the infohash', () => {
    expect(magnetOf(result(0.9))).toBe('magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(magnetOf(result(0.9, [], null, { magnet: null, infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))).toBe('magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
});
