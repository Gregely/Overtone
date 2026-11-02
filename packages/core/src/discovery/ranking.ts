/**
 * Matching and ranking of torrent hits against a discovery target.
 *
 * The score is dominated by metadata agreement (artist + title/album), so a
 * cached or heavily-seeded release can never out-rank a wrong recording.
 * Format, quality, year, completeness and seeder count only refine an already
 * plausible match, and every factor is reported as a human-readable reason.
 */
import type { DiscoverReleaseType } from '@overtone/shared';
import { artistSimilarity, titleSimilarity } from '../metadata/matcher/normalize.js';
import type { DiscoveryTarget } from './query-builder.js';
import type { IndexerHit } from './types.js';

export interface ParsedRelease {
  /** Release/track name with format, quality, year and bracketed noise removed. */
  title: string;
  artist: string | null;
  year: number | null;
  /** Normalized format id, e.g. "flac", "mp3", "ogg". */
  format: string | null;
  /** Human quality label, e.g. "lossless", "320", "V0", "24-bit". */
  quality: string | null;
  type: DiscoverReleaseType;
  complete: boolean;
}

export interface RankPreferences {
  /** Preferred format id ("flac", "mp3", …); adds a bonus when matched. */
  preferredFormat?: string | null;
  /** Preferred minimum bitrate in kbps; penalizes lower-bitrate lossy hits. */
  minBitrateKbps?: number;
}

export interface RankedHit {
  score: number;
  reasons: string[];
  parsed: ParsedRelease;
}

const FORMAT_TOKENS: Readonly<Record<string, string>> = {
  flac: 'flac',
  mp3: 'mp3',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'opus',
  m4a: 'm4a',
  aac: 'aac',
  alac: 'alac',
  ape: 'ape',
  wv: 'wavpack',
  wav: 'wav',
  dsf: 'dsf',
  dff: 'dsf',
  wma: 'wma',
  webm: 'webm',
};

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'ape', 'wavpack', 'dsf']);

const TYPE_RE = [
  [/discograph/i, 'discography'],
  [/compilation|\bcomp\b/i, 'compilation'],
  [/antholog/i, 'compilation'],
  [/\bep\b/i, 'ep'],
  [/\bsingle\b/i, 'single'],
  [/\balbum\b/i, 'album'],
] as const;

/** Parse a raw indexer title into structured release info. */
export function parseReleaseTitle(raw: string): ParsedRelease {
  const s = (raw ?? '').trim();
  if (!s) return { title: '', artist: null, year: null, format: null, quality: null, type: 'unknown', complete: false };

  const type = detectType(s);
  const complete = /\bcomplete\b/i.test(s) || /\bfull\b/i.test(s);
  const format = detectFormat(s);
  const quality = detectQuality(s);

  const yearMatch = s.match(/\b((?:19|20)\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  let title = s
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ') // bracketed groups (formats, sources, tags)
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:flac|mp3|ogg|oga|opus|m4a|aac|alac|ape|wav|wv|dsf|dff|wma|webm)\b/gi, ' ')
    .replace(/\b(?:320|256|192|128|v0|v1|v2|vbr|cbr|24\s?bit|hi\s?res|lossless)\b/gi, ' ')
    .replace(/\b(?:itunes|web|cd|vinyl|vinil|digital|dmd|deluxe|edition|remastered|reissue)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\-]+$/, '')
    .trim();

  const parts = title.split(' - ').map((p) => p.trim()).filter(Boolean);
  let artist: string | null = null;
  let release: string | null = null;
  if (parts.length >= 2) {
    artist = parts[0]!;
    release = parts.slice(1).join(' - ');
  } else {
    release = title || null;
  }

  return { title: release ?? '', artist, year, format, quality, type, complete };
}

export function detectType(s: string): DiscoverReleaseType {
  for (const [re, type] of TYPE_RE) if (re.test(s)) return type;
  return 'unknown';
}

export function detectFormat(s: string): string | null {
  // Explicit "24bit FLAC" / ".flac" / "FLAC" tokens.
  for (const token of Object.keys(FORMAT_TOKENS)) {
    if (new RegExp(`(?:^|[^a-z])${token}(?:$|[^a-z])`, 'i').test(s)) return FORMAT_TOKENS[token]!;
  }
  return null;
}

export function detectQuality(s: string): string | null {
  if (/24\s?bit|hi\s?res/i.test(s)) return '24-bit';
  if (/lossless/i.test(s)) return 'lossless';
  if (/v0\b/i.test(s)) return 'V0';
  if (/v2\b/i.test(s)) return 'V2';
  if (/320\b/i.test(s)) return '320';
  if (/256\b/i.test(s)) return '256';
  if (/vbr\b/i.test(s)) return 'VBR';
  if (/cbr\b/i.test(s)) return 'CBR';
  if (/192\b/i.test(s)) return '192';
  if (/128\b/i.test(s)) return '128';
  return null;
}

/** Score + explain a hit against a target. */
export function rankHit(target: DiscoveryTarget, hit: IndexerHit, prefs: RankPreferences = {}): RankedHit {
  const parsed = parseReleaseTitle(hit.title);
  const isAlbum = target.scope === 'album';
  const targetName = isAlbum ? (target.album ?? target.title) : target.title;

  const artistSim = target.artist ? (parsed.artist ? artistSimilarity(target.artist, parsed.artist) : 0) : 1;
  const titleSim = targetName ? titleSimilarity(targetName, parsed.title) : 0;
  const meta = artistSim * 0.45 + titleSim * 0.55;

  const yearSim = yearSimilarity(target.year, parsed.year);
  const qualityScore = qualityScoreOf(parsed, prefs);
  const completeness = isAlbum && parsed.complete ? 1 : 0;
  const seederScore = seedersScore(hit.seeders);

  let score: number;
  if (meta < 0.35) {
    // Wrong artist/title: metadata dominates, everything else is ignored.
    score = meta * 0.5;
  } else {
    score = meta * 0.7 + yearSim * 0.1 + qualityScore * 0.1 + completeness * 0.05 + seederScore * 0.05;
  }
  score = clamp(round3(score));

  return { score, parsed, reasons: buildReasons(target, parsed, hit, artistSim, titleSim, meta) };
}

function yearSimilarity(targetYear: number | undefined, hitYear: number | null): number {
  if (!targetYear) return 0.5;
  if (hitYear === null) return 0;
  if (hitYear === targetYear) return 1;
  return Math.abs(hitYear - targetYear) <= 1 ? 0.6 : 0;
}

function qualityScoreOf(parsed: ParsedRelease, prefs: RankPreferences): number {
  const fmt = parsed.format;
  let s = 0.5; // unknown format: neutral
  if (fmt) {
    if (LOSSLESS.has(fmt)) s = 0.8;
    else if (fmt === 'mp3' || fmt === 'aac' || fmt === 'ogg' || fmt === 'opus') s = parsed.quality === '320' || parsed.quality === 'V0' ? 0.7 : 0.4;
    else s = 0.5;
  }
  if (prefs.preferredFormat && fmt === prefs.preferredFormat) s = Math.min(1, s + 0.15);
  if (prefs.minBitrateKbps && parsed.quality && /^\d+$/.test(parsed.quality) && Number(parsed.quality) < prefs.minBitrateKbps) {
    s = Math.max(0, s - 0.2);
  }
  return s;
}

function seedersScore(seeders: number | null): number {
  if (seeders === null || seeders === undefined) return 0.3;
  return Math.min(1, Math.log2(seeders + 1) / 6);
}

function buildReasons(target: DiscoveryTarget, parsed: ParsedRelease, hit: IndexerHit, artistSim: number, titleSim: number, meta: number): string[] {
  const reasons: string[] = [];
  if (target.artist) reasons.push(parsed.artist ? `Artist ${pct(artistSim)}` : 'No artist in result');
  reasons.push(`${target.scope === 'album' ? 'Album' : 'Title'} ${pct(titleSim)}`);
  if (target.year) reasons.push(parsed.year === target.year ? `Year ${target.year}` : parsed.year ? `Year ${parsed.year}` : 'Year unknown');
  if (parsed.format) reasons.push(`${parsed.format.toUpperCase()}${parsed.quality ? ` ${parsed.quality}` : ''}`);
  if (hit.seeders !== null && hit.seeders !== undefined) reasons.push(`${hit.seeders} seeders`);
  if (meta < 0.35) reasons.push('Unlikely match');
  return reasons;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
