/**
 * Source matcher — a first-version MusicBrainz-to-torrent confidence
 * classifier. It reuses DiscoveryService's ranking score (which already weighs
 * artist/title/year agreement over seeders) and adds explicit confidence tiers
 * plus cached-candidate selection for automatic playback.
 *
 * More sophisticated matching (tracklist/disc-count/format reconciliation)
 * can be layered on later; this version reliably identifies straightforward
 * album matches and never auto-plays an ambiguous one.
 */
import type { DiscoverResultDto } from '@overtone/shared';

export type Confidence = 'high' | 'probable' | 'ambiguous' | 'rejected';

const RANK: Record<Confidence, number> = { high: 3, probable: 2, ambiguous: 1, rejected: 0 };

export interface MatchedCandidate {
  result: DiscoverResultDto;
  confidence: Confidence;
}

/** Classify a discovery result by its metadata-agreement score. */
export function classify(result: DiscoverResultDto): Confidence {
  const s = result.score;
  if (s >= 0.7) return 'high';
  if (s >= 0.5) return 'probable';
  if (s >= 0.35) return 'ambiguous';
  return 'rejected';
}

/** True when a connected provider reports this release as cached. */
export function isCached(result: DiscoverResultDto): boolean {
  return result.cached.some((c) => c.status === 'cached');
}

/** The cached provider (source id + name) for a result, if any. */
export function cachedProvider(result: DiscoverResultDto): { sourceId: string; name: string } | null {
  const c = result.cached.find((x) => x.status === 'cached');
  return c ? { sourceId: c.providerId, name: c.providerName } : null;
}

/**
 * Pick the best cached candidate at or above `min` confidence, preferring
 * higher confidence, then score, then seeders. Returns null when no cached
 * result meets the bar — so a low-confidence or ambiguous release is never
 * auto-played.
 */
export function bestCachedCandidate(results: DiscoverResultDto[], min: Confidence = 'probable'): MatchedCandidate | null {
  const minRank = RANK[min];
  let best: MatchedCandidate | null = null;
  for (const r of results) {
    if (!isCached(r)) continue;
    const confidence = classify(r);
    if (RANK[confidence] < minRank) continue;
    const beats =
      best === null ||
      RANK[confidence] > RANK[best.confidence] ||
      (RANK[confidence] === RANK[best.confidence] &&
        (r.score > best.result.score || (r.score === best.result.score && (r.seeders ?? -1) > (best.result.seeders ?? -1))));
    if (beats) best = { result: r, confidence };
  }
  return best;
}

/** A magnet URI for a result (explicit magnet, or derived from its infohash). */
export function magnetOf(result: DiscoverResultDto): string | null {
  if (result.magnet) return result.magnet;
  if (result.infoHash) return `magnet:?xt=urn:btih:${result.infoHash}`;
  return null;
}
