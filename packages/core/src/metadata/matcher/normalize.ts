/**
 * String normalization and similarity for matching tags to MusicBrainz.
 * Pure functions; no I/O.
 */

const QUOTES = /[‘’‚‛′`´]/g;
const DQUOTES = /[“”„‟″]/g;
const DASHES = /[‐-―−]/g;

/** Letters NFKD doesn't decompose. */
const LIGATURES: Record<string, string> = { œ: 'oe', Œ: 'oe', æ: 'ae', Æ: 'ae', ß: 'ss', ø: 'o', Ø: 'o', ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', þ: 'th', Þ: 'th' };
const LIGATURE_RE = new RegExp(`[${Object.keys(LIGATURES).join('')}]`, 'g');

/** Lower-case, strip diacritics, unify punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .replace(LIGATURE_RE, (c) => LIGATURES[c]!)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(QUOTES, "'")
    .replace(DQUOTES, '"')
    .replace(DASHES, '-')
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/'/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Bracketed/featuring suffixes that tags and MB often disagree on. */
const STRIP_SUFFIX = [
  /\s*[([{][^)\]}]*[)\]}]\s*/g, // (Remastered 2011), [Explicit], {Bonus}
  /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|mono|stereo|single|radio edit|album version|bonus track)\b.*$/i,
  /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i,
];

/** normalize() after removing "(Remastered)", " - 2011 Remaster", "feat. X" etc. */
export function normalizeLoose(s: string): string {
  let out = s;
  for (const re of STRIP_SUFFIX) out = out.replace(re, ' ');
  const n = normalize(out);
  return n || normalize(s);
}

/** Levenshtein distance (two-row DP). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** 1 − distance / max length, on already-normalized strings. */
export function ratio(a: string, b: string): number {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** Ratio after sorting words — robust to "Beatles, The" vs "The Beatles". */
export function tokenSortRatio(a: string, b: string): number {
  const sort = (s: string) => s.split(' ').filter(Boolean).sort().join(' ');
  return ratio(sort(a), sort(b));
}

/**
 * Similarity in [0, 1] for titles: exact/near-exact strings score highest; a
 * match only after stripping suffixes ("(Live)", "feat. X") scores slightly less
 * so the version-exact candidate wins ties.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const strict = Math.max(ratio(na, nb), tokenSortRatio(na, nb));
  if (strict === 1) return 1;
  const loose = Math.max(ratio(normalizeLoose(a), normalizeLoose(b)), tokenSortRatio(normalizeLoose(a), normalizeLoose(b)));
  return Math.max(strict, loose * 0.95);
}

/**
 * Similarity for artist names. Also accepts the tag naming only the primary
 * artist of a multi-artist credit ("Daft Punk" vs "Daft Punk feat. Pharrell").
 */
export function artistSimilarity(tagArtist: string, credit: string, primaryArtists: readonly string[] = []): number {
  const variants = [credit, ...primaryArtists];
  let best = 0;
  for (const v of variants) {
    best = Math.max(best, titleSimilarity(tagArtist, v));
    // "The Beatles" vs "Beatles"
    const strip = (s: string) => normalize(s).replace(/^the /, '');
    best = Math.max(best, ratio(strip(tagArtist), strip(v)));
  }
  return best;
}

/** Similarity of two durations, 1 when within 2 s, falling to 0 at 30 s. */
export function durationScore(aMs: number, bMs: number): number {
  const diff = Math.abs(aMs - bMs) / 1000;
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.85;
  if (diff <= 10) return 0.55;
  if (diff <= 30) return 0.2;
  return 0;
}

/** Text for LIKE-based search columns. */
export function searchText(...parts: Array<string | null | undefined>): string {
  return normalize(parts.filter(Boolean).join(' '));
}
