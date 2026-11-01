import type { FileTags } from '../../providers/types.js';
import { luceneEscape } from '../musicbrainz/client.js';
import type { MbCredit, MbRelease, MbReleaseRef, MusicBrainzApi } from '../musicbrainz/types.js';
import { artistSimilarity, durationScore, normalize, normalizeLoose, titleSimilarity } from './normalize.js';

/**
 * Resolves files to MusicBrainz recordings + releases.
 *
 * Strategy, cheapest first (MusicBrainz allows ~1 request/second):
 *  1. MBIDs in tags (Picard etc.) → direct lookup, trusted.
 *  2. Album strategy: files in one folder sharing an album tag → search the
 *     release once, fetch its tracklist, assign files by disc/track number or
 *     title. ~2–4 requests per album instead of one per track.
 *  3. Per-recording search for whatever is left, biased towards releases the
 *     rest of the folder matched (album coherence).
 *
 * Scores are in [0, 1]: ≥ autoThreshold → matched, ≥ reviewThreshold →
 * needs_review (best guess applied, user can fix), else unmatched.
 */

export interface MatchInput {
  key: number;
  path: string;
  tags: FileTags;
}

export interface MatchedRelease {
  mbid: string;
  title: string;
  credit: MbCredit | null;
  date: string | null;
  releaseGroupMbid: string | null;
  primaryType: string | null;
  secondaryTypes: string[];
  status: string | null;
  trackCount: number | null;
}

export interface MatchCandidate {
  recordingMbid: string;
  title: string;
  credit: MbCredit;
  lengthMs: number | null;
  release: MatchedRelease | null;
  discNo: number | null;
  trackNo: number | null;
  score: number;
}

export type MatchStatusResult = 'matched' | 'needs_review' | 'unmatched';

export interface MatchResult {
  status: MatchStatusResult;
  score: number;
  best: MatchCandidate | null;
  /** Top alternatives (best first), for the "fix match" UI. */
  candidates: MatchCandidate[];
}

export interface MatcherOptions {
  autoThreshold?: number;
  reviewThreshold?: number;
  maxCandidates?: number;
}

interface Query {
  title: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  discNumber?: number;
  trackTotal?: number;
  durationMs?: number;
}

export class Matcher {
  readonly auto: number;
  readonly review: number;
  readonly #max: number;

  constructor(
    private readonly mb: MusicBrainzApi,
    opts: MatcherOptions = {},
  ) {
    this.auto = opts.autoThreshold ?? 0.85;
    this.review = opts.reviewThreshold ?? 0.6;
    this.#max = opts.maxCandidates ?? 5;
  }

  /** Match files that belong together (typically one folder). */
  async matchGroup(inputs: readonly MatchInput[]): Promise<Map<number, MatchResult>> {
    const results = new Map<number, MatchResult>();
    let remaining: MatchInput[] = [];

    // 1. Tagged MBIDs.
    for (const input of inputs) {
      const r = await this.#fromMbids(input);
      if (r) results.set(input.key, r);
      else remaining.push(input);
    }

    // 2. Album strategy.
    const preferred = new Set<string>();
    for (const r of results.values()) if (r.best?.release) preferred.add(r.best.release.mbid);
    if (remaining.length >= 2) {
      const album = await this.#matchAsAlbum(remaining);
      if (album) {
        preferred.add(album.release.id);
        const left: MatchInput[] = [];
        for (const input of remaining) {
          const r = album.results.get(input.key);
          if (r && r.score >= this.review) results.set(input.key, r);
          else left.push(input);
        }
        remaining = left;
      }
    }

    // 3. Per-recording search.
    for (const input of remaining) {
      results.set(input.key, await this.matchOne(input, preferred));
    }
    return results;
  }

  async matchOne(input: MatchInput, preferred: ReadonlySet<string> = new Set(), maxCandidates = this.#max): Promise<MatchResult> {
    const q = toQuery(input.tags);
    if (!q.title) return unmatched();

    let all: MatchCandidate[] = [];
    for (const query of recordingQueries(q)) {
      const recordings = await this.mb.searchRecordings(query, 25);
      for (const rec of recordings) {
        const releases = rec.releases.length ? rec.releases : [null];
        let bestForRec: MatchCandidate | null = null;
        for (const rel of releases.slice(0, 40)) {
          const c = candidate(rec.id, rec.title, rec.credit, rec.lengthMs, rel, rel?.discNo ?? null, rel?.trackNo ?? null);
          c.score = scoreCandidate(q, c, preferred);
          if (!bestForRec || better(c, bestForRec)) bestForRec = c;
        }
        if (bestForRec) all.push(bestForRec);
      }
      all = dedupe(all).sort(compareCandidates);
      if ((all[0]?.score ?? 0) >= this.auto) break;
    }
    return this.#result(all, maxCandidates);
  }

  /** Score a file against a specific release (used by manual album matching). */
  assignToRelease(inputs: readonly MatchInput[], release: MbRelease): Map<number, MatchResult> {
    const out = new Map<number, MatchResult>();
    for (const input of inputs) {
      const q = toQuery(input.tags);
      const scored = release.tracks
        .map((t) => {
          const c = candidate(t.recording.id, t.title, t.recording.credit, t.lengthMs ?? t.recording.lengthMs, release, t.discNo, t.trackNo);
          c.score = scoreCandidate(q, c, new Set([release.id]));
          // Position agreement is the strongest signal within a known release.
          if (q.trackNumber && q.trackNumber === t.trackNo && (!q.discNumber || q.discNumber === t.discNo)) {
            c.score = Math.min(1, c.score + 0.1);
          }
          return c;
        })
        .sort(compareCandidates);
      out.set(input.key, this.#result(scored));
    }
    return out;
  }

  async #fromMbids(input: MatchInput): Promise<MatchResult | null> {
    const mb = input.tags.musicbrainz;
    if (!mb?.recordingId) return null;
    if (mb.releaseId) {
      const release = await this.mb.getRelease(mb.releaseId);
      const track =
        release?.tracks.find((t) => t.recording.id === mb.recordingId) ??
        null;
      if (release && track) {
        const c = candidate(track.recording.id, track.title, track.recording.credit, track.lengthMs, release, track.discNo, track.trackNo);
        c.score = 1;
        return { status: 'matched', score: 1, best: c, candidates: [c] };
      }
    }
    const rec = await this.mb.getRecording(mb.recordingId);
    if (!rec) return null;
    const q = toQuery(input.tags);
    const options = (rec.releases.length ? rec.releases : [null]).map((rel) => {
      const c = candidate(rec.id, rec.title, rec.credit, rec.lengthMs, rel, rel?.discNo ?? null, rel?.trackNo ?? null);
      c.score = scoreCandidate(q, c);
      return c;
    });
    options.sort(compareCandidates);
    const best = { ...options[0]!, score: 1 }; // recording identity is certain
    return { status: 'matched', score: 1, best, candidates: [best, ...options.slice(1, this.#max)] };
  }

  async #matchAsAlbum(inputs: readonly MatchInput[]): Promise<{ release: MbRelease; results: Map<number, MatchResult> } | null> {
    const album = dominant(inputs.map((i) => i.tags.album));
    if (!album || album.share < 0.6) return null;
    const artist = dominant(inputs.map((i) => i.tags.albumArtist ?? i.tags.artist))?.value;

    const parts = [`release:"${luceneEscape(normalizeLoose(album.value) || album.value)}"`];
    if (artist) parts.push(`artist:"${luceneEscape(normalizeLoose(artist) || artist)}"`);
    const refs = await this.mb.searchReleases(parts.join(' AND '), 10);

    const groupSize = inputs.length;
    const ranked = refs
      .map((r) => ({
        ref: r,
        s:
          titleSimilarity(album.value, r.title) * 0.6 +
          (artist && r.credit ? artistSimilarity(artist, r.credit.text, r.credit.artists.map((a) => a.name)) : 0.5) * 0.3 +
          trackCountCloseness(groupSize, r.trackCount) * 0.1 +
          releasePreference(r) * 0.05,
      }))
      .filter((x) => titleSimilarity(album.value, x.ref.title) >= 0.7)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);

    let best: { release: MbRelease; results: Map<number, MatchResult>; mean: number } | null = null;
    for (const { ref } of ranked) {
      const release = await this.mb.getRelease(ref.id);
      if (!release?.tracks.length) continue;
      const results = this.assignToRelease(inputs, release);
      const scores = [...results.values()].map((r) => r.best?.score ?? 0);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (!best || mean > best.mean) best = { release, results, mean };
      if (mean >= 0.95) break;
    }
    return best && best.mean >= this.review ? best : null;
  }

  #result(sorted: MatchCandidate[], max = this.#max): MatchResult {
    const top = sorted.slice(0, max).map((c) => ({ ...c, score: round(c.score) }));
    const best = top[0] ?? null;
    if (!best) return unmatched();
    const status: MatchStatusResult = best.score >= this.auto ? 'matched' : best.score >= this.review ? 'needs_review' : 'unmatched';
    return { status, score: best.score, best: status === 'unmatched' ? null : best, candidates: top };
  }
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export function scoreCandidate(q: Query, c: MatchCandidate, preferred: ReadonlySet<string> = new Set()): number {
  const rec: Array<[number, number]> = [[titleSimilarity(q.title, c.title), 0.5]];
  if (q.artist) rec.push([artistSimilarity(q.artist, c.credit.text, c.credit.artists.map((a) => a.name)), 0.3]);
  if (q.durationMs && c.lengthMs) rec.push([durationScore(q.durationMs, c.lengthMs), 0.2]);
  let recScore = weighted(rec);
  // A title alone is weak evidence ("Intro"); never auto-match without an artist.
  if (!q.artist) recScore *= 0.7;
  // No release: fine for loose singles, but weak when the file says which album it's from.
  if (!c.release) return recScore * (q.album ? 0.75 : 0.9);

  const rel: Array<[number, number]> = [];
  if (q.album) rel.push([titleSimilarity(q.album, c.release.title), 0.6]);
  if (q.trackNumber && c.trackNo) {
    const same = q.trackNumber === c.trackNo && (!q.discNumber || !c.discNo || q.discNumber === c.discNo);
    rel.push([same ? 1 : 0, 0.25]);
  }
  rel.push([releasePreference(c.release), 0.15]);
  let total = 0.7 * recScore + 0.3 * weighted(rel);
  if (preferred.has(c.release.mbid)) total += 0.1;
  return Math.min(1, total);
}

/** Prefer official, plain studio albums when tags don't say otherwise. */
export function releasePreference(r: { status?: string | null; primaryType?: string | null; releaseGroup?: MbReleaseRef['releaseGroup']; secondaryTypes?: string[] }): number {
  const primary = r.primaryType ?? r.releaseGroup?.primaryType ?? null;
  const secondary = r.secondaryTypes ?? r.releaseGroup?.secondaryTypes ?? [];
  return (r.status === 'Official' ? 0.5 : 0) + (primary === 'Album' ? 0.3 : primary ? 0.1 : 0) + (secondary.length === 0 ? 0.2 : 0);
}

function weighted(parts: Array<[number, number]>): number {
  const w = parts.reduce((a, [, wt]) => a + wt, 0);
  return w === 0 ? 0 : parts.reduce((a, [s, wt]) => a + s * wt, 0) / w;
}

function trackCountCloseness(files: number, tracks: number | null): number {
  if (!tracks) return 0.5;
  if (files === tracks) return 1;
  return files < tracks ? Math.max(0, 1 - (tracks - files) / tracks) * 0.8 : 0.2;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toQuery(tags: FileTags): Query {
  const q: Query = { title: tags.title ?? '' };
  const artist = tags.artist ?? tags.albumArtist;
  if (artist) q.artist = artist;
  if (tags.album) q.album = tags.album;
  if (tags.trackNumber) q.trackNumber = tags.trackNumber;
  if (tags.discNumber) q.discNumber = tags.discNumber;
  if (tags.trackTotal) q.trackTotal = tags.trackTotal;
  if (tags.durationMs) q.durationMs = tags.durationMs;
  return q;
}

/** Search queries to try, in order. Tag suffixes like "(Remastered)" break phrase queries, so strip them. */
export function recordingQueries(q: Query): string[] {
  const title = normalizeLoose(q.title) || normalize(q.title);
  if (!title) return [];
  const artist = q.artist ? normalizeLoose(q.artist) || normalize(q.artist) : undefined;
  const phrase = [`recording:"${luceneEscape(title)}"`];
  if (artist) phrase.push(`artist:"${luceneEscape(artist)}"`);
  const loose = [`recording:(${luceneEscape(title)})`];
  if (artist) loose.push(`artist:(${luceneEscape(artist)})`);
  return [phrase.join(' AND '), loose.join(' AND ')];
}

function candidate(
  recordingMbid: string,
  title: string,
  credit: MbCredit,
  lengthMs: number | null,
  rel: MbReleaseRef | null,
  discNo: number | null,
  trackNo: number | null,
): MatchCandidate {
  return {
    recordingMbid,
    title,
    credit,
    lengthMs,
    release: rel
      ? {
          mbid: rel.id,
          title: rel.title,
          credit: rel.credit,
          date: rel.date,
          releaseGroupMbid: rel.releaseGroup?.id ?? null,
          primaryType: rel.releaseGroup?.primaryType ?? null,
          secondaryTypes: rel.releaseGroup?.secondaryTypes ?? [],
          status: rel.status,
          trackCount: rel.trackCount,
        }
      : null,
    discNo,
    trackNo,
    score: 0,
  };
}

function better(a: MatchCandidate, b: MatchCandidate): boolean {
  return compareCandidates(a, b) < 0;
}

/** Higher score first; ties → earlier release date (original over reissues). */
function compareCandidates(a: MatchCandidate, b: MatchCandidate): number {
  if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
  const da = a.release?.date || '9999';
  const db = b.release?.date || '9999';
  return da < db ? -1 : da > db ? 1 : 0;
}

function dedupe(cs: MatchCandidate[]): MatchCandidate[] {
  const seen = new Map<string, MatchCandidate>();
  for (const c of cs) {
    const k = `${c.recordingMbid}:${c.release?.mbid ?? ''}`;
    const prev = seen.get(k);
    if (!prev || c.score > prev.score) seen.set(k, c);
  }
  return [...seen.values()];
}

function dominant(values: Array<string | undefined>): { value: string; share: number } | null {
  const counts = new Map<string, { value: string; n: number }>();
  for (const v of values) {
    if (!v) continue;
    const k = normalize(v);
    const e = counts.get(k) ?? { value: v, n: 0 };
    e.n++;
    counts.set(k, e);
  }
  let best: { value: string; n: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best ? { value: best.value, share: best.n / values.length } : null;
}

function unmatched(): MatchResult {
  return { status: 'unmatched', score: 0, best: null, candidates: [] };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
