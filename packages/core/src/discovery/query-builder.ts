/**
 * Builds Torznab search queries from a discovery target.
 *
 * Music torrents are titled in a handful of conventional ways, so we generate
 * several query variations (most specific first) rather than betting on one
 * exact string. The aggregator stops early once a query yields good matches.
 */
import type { DiscoverScope } from '@overtone/shared';
import { normalize } from '../metadata/matcher/normalize.js';

export interface DiscoveryTarget {
  scope: DiscoverScope;
  title: string;
  artist?: string;
  album?: string;
  year?: number;
  durationMs?: number;
}

/** Ordered, de-duplicated search strings for a target (most specific first). */
export function buildQueries(target: DiscoveryTarget): string[] {
  const artist = clean(target.artist);
  const title = clean(target.title);
  const album = clean(target.album);
  const year = target.year;

  const raw: string[] = [];
  if (target.scope === 'track') {
    if (artist && title) raw.push(`${artist} ${title}`);
    if (artist && album && title) raw.push(`${artist} ${album} ${title}`);
    if (artist && title && year) raw.push(`${artist} ${title} ${year}`);
    if (title) raw.push(title);
  } else {
    if (artist && album) raw.push(`${artist} ${album}`);
    if (artist && album && year) raw.push(`${artist} ${album} ${year}`);
    if (album) raw.push(album);
    if (artist && title && title !== album) raw.push(`${artist} ${title}`);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of raw) {
    const key = normalize(q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q.trim());
  }
  return out.slice(0, 4);
}

/** Trim, strip a trailing year and collapse whitespace (avoids "2020 2020"). */
function clean(s: string | undefined): string {
  return (s ?? '')
    .replace(/\s*[([{]\s*(?:19|20)\d{2}\s*[)\]}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
