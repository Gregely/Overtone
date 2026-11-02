import { describe, expect, it } from 'vitest';
import { artistSimilarity, durationScore, levenshtein, normalize, normalizeLoose, titleSimilarity } from './normalize.js';

describe('normalize', () => {
  it.each([
    ['Beyoncé', 'beyonce'],
    ['Phœnix', 'phoenix'],
    ['Sigur Rós', 'sigur ros'],
    ['Motörhead', 'motorhead'],
    ['Straße', 'strasse'],
    ['Simon & Garfunkel', 'simon and garfunkel'],
    ["Don’t Stop Me Now", 'dont stop me now'],
    ['  AC/DC  ', 'ac dc'],
    ['Hello—World', 'hello world'],
  ])('%s → %s', (input, expected) => expect(normalize(input)).toBe(expected));

  it('loosely strips version suffixes and featuring credits', () => {
    expect(normalizeLoose('Come Together (Remastered 2009)')).toBe('come together');
    expect(normalizeLoose('Get Lucky - Radio Edit')).toBe('get lucky');
    expect(normalizeLoose('Song feat. Somebody')).toBe('song');
    expect(normalizeLoose('(Untitled)')).toBe('untitled'); // never strip to nothing
  });
});

describe('similarity', () => {
  it('computes Levenshtein distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('scores exact titles 1 and version-stripped matches slightly lower', () => {
    expect(titleSimilarity('Da Funk', 'da funk')).toBe(1);
    const remaster = titleSimilarity('Come Together (Remastered 2009)', 'Come Together');
    expect(remaster).toBeGreaterThan(0.9);
    expect(remaster).toBeLessThan(1);
    expect(titleSimilarity('Love', 'Love Song')).toBeLessThan(0.7);
  });

  it('handles word order and leading "The" for artists', () => {
    expect(artistSimilarity('Beatles, The', 'The Beatles')).toBeGreaterThan(0.9);
    expect(artistSimilarity('Beatles', 'The Beatles')).toBe(1);
    expect(artistSimilarity('Daft Punk', 'Daft Punk feat. Pharrell Williams', ['Daft Punk', 'Pharrell Williams'])).toBe(1);
    expect(artistSimilarity('Metallica', 'Megadeth')).toBeLessThan(0.6);
  });

  it('scores durations by difference', () => {
    expect(durationScore(200_000, 201_500)).toBe(1);
    expect(durationScore(200_000, 208_000)).toBeCloseTo(0.55);
    expect(durationScore(200_000, 260_000)).toBe(0);
  });
});
