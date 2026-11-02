import { describe, expect, it } from 'vitest';
import { parseReleaseTitle, rankHit } from './ranking.js';
import type { IndexerHit } from './types.js';
import type { DiscoveryTarget } from './query-builder.js';

function hit(overrides: Partial<IndexerHit>): IndexerHit {
  return { id: 'x', title: 'X', size: null, seeders: null, leechers: null, category: null, publishDate: null, files: null, ...overrides };
}

describe('parseReleaseTitle', () => {
  it('parses Artist - Album (Year) FLAC', () => {
    const p = parseReleaseTitle('Led Zeppelin - Led Zeppelin IV (1971) [FLAC] [24bit]');
    expect(p.artist).toBe('Led Zeppelin');
    expect(p.title).toBe('Led Zeppelin IV');
    expect(p.year).toBe(1971);
    expect(p.format).toBe('flac');
    expect(p.quality).toBe('24-bit');
  });

  it('detects discography and compilation', () => {
    expect(parseReleaseTitle('The Beatles - Complete Discography FLAC').type).toBe('discography');
    expect(parseReleaseTitle('Various Artists - Now 50 (Compilation) MP3 320').type).toBe('compilation');
  });

  it('detects mp3 bitrate quality', () => {
    const p = parseReleaseTitle('Artist - Album (2010) [MP3] [320]');
    expect(p.format).toBe('mp3');
    expect(p.quality).toBe('320');
  });

  it('returns unknown type for a bare track title', () => {
    const p = parseReleaseTitle('Artist - Some Song.mp3');
    expect(p.artist).toBe('Artist');
    expect(p.title).toBe('Some Song');
    expect(p.format).toBe('mp3');
  });
});

describe('rankHit', () => {
  const albumTarget: DiscoveryTarget = { scope: 'album', title: 'Led Zeppelin IV', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', year: 1971 };

  it('scores an exact album match highest', () => {
    const r = rankHit(albumTarget, hit({ title: 'Led Zeppelin - Led Zeppelin IV (1971) FLAC', seeders: 50, files: 8 }));
    expect(r.score).toBeGreaterThan(0.85);
    expect(r.reasons.join(' ')).toContain('1971');
  });

  it('does not let seeders override a wrong artist', () => {
    const good = rankHit(albumTarget, hit({ title: 'Led Zeppelin - Led Zeppelin IV (1971) FLAC', seeders: 1 }));
    const wrong = rankHit(albumTarget, hit({ title: 'Someone Else - Totally Different (1971) FLAC', seeders: 1000 }));
    expect(wrong.score).toBeLessThan(good.score);
    expect(wrong.reasons).toContain('Unlikely match');
  });

  it('gives a format bonus for the preferred format', () => {
    const flac = rankHit(albumTarget, hit({ title: 'Led Zeppelin - Led Zeppelin IV FLAC' }), { preferredFormat: 'flac' });
    const mp3 = rankHit(albumTarget, hit({ title: 'Led Zeppelin - Led Zeppelin IV MP3 320' }), { preferredFormat: 'flac' });
    expect(flac.score).toBeGreaterThan(mp3.score);
  });

  it('matches a track scope against the track title', () => {
    const trackTarget: DiscoveryTarget = { scope: 'track', title: 'Stairway to Heaven', artist: 'Led Zeppelin' };
    const good = rankHit(trackTarget, hit({ title: 'Led Zeppelin - Stairway to Heaven (Live) FLAC' }));
    const bad = rankHit(trackTarget, hit({ title: 'Led Zeppelin - Black Dog FLAC' }));
    expect(good.score).toBeGreaterThan(bad.score);
  });
});
