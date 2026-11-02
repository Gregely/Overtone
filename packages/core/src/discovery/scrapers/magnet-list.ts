/**
 * Reference native scraper (magnet-list pattern).
 *
 * Demonstrates the scraper interface against a typical magnet-listing torrent
 * site: a search URL, an HTML result page, and magnet/title/size/seeders
 * extraction. This is a TEMPLATE — the URL and HTML structure must be verified
 * against a real site before it counts as a working source.
 *
 * NOT live-verified in this environment: the parser is covered by mocked tests
 * only, per the project's "don't claim a scraper works from mock tests alone"
 * rule.
 */
import { ProviderError } from '../../providers/errors.js';
import { send } from '../../providers/http.js';
import { magnetInfoHash } from '../../providers/debrid/magnet.js';
import type { IndexerContext, IndexerHit } from '../types.js';
import { anchors, parseNumber, parseSize, stripTags } from './html.js';
import type { Scraper, ScraperDefinition } from './types.js';

export interface MagnetListScraperOptions {
  id: string;
  name: string;
  baseUrl: string;
  /** Path appended to baseUrl, e.g. "/search". */
  searchPath: string;
}

export function createMagnetListScraper(opts: MagnetListScraperOptions): ScraperDefinition {
  return {
    id: opts.id,
    name: opts.name,
    version: '1.0.0',
    baseUrl: opts.baseUrl,
    capabilities: { search: true, seeders: true, categories: false },
    create(ctx: IndexerContext): Scraper {
      return {
        id: opts.id,
        name: opts.name,
        baseUrl: opts.baseUrl,
        async *search({ query, signal }): AsyncIterable<IndexerHit> {
          const url = `${opts.baseUrl}${opts.searchPath}?q=${encodeURIComponent(query)}`;
          const res = await send(ctx, url, { headers: { accept: 'text/html' }, signal }, opts.name);
          if (!res.ok) {
            await res.body?.cancel();
            throw new ProviderError('unavailable', `${opts.name} returned HTTP ${res.status}`);
          }
          const html = await res.text();
          yield* parseMagnetList(html);
        },
        async testConnection() {
          try {
            const res = await send(ctx, opts.baseUrl, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(15_000) }, opts.name);
            await res.body?.cancel();
            return res.ok ? { ok: true, message: `Reachable (HTTP ${res.status})` } : { ok: false, message: `HTTP ${res.status}` };
          } catch {
            return { ok: false, message: "Couldn't reach the site" };
          }
        },
      };
    },
  };
}

/** Parse a magnet-list result page into hits. Illustrative; adapt per site. */
export function parseMagnetList(html: string): IndexerHit[] {
  const rows = html.split(/<tr[\s>]/i).slice(1);
  const hits: IndexerHit[] = [];
  for (const row of rows) {
    const a = anchors(row).find((x) => x.href.startsWith('magnet:'));
    if (!a) continue;
    const infoHash = magnetInfoHash(a.href);
    const size = parseSize(extractSize(row));
    const seeders = parseNumber(extractCell(row, 'seed'));
    const leechers = parseNumber(extractCell(row, 'leech'));
    const hit: IndexerHit = {
      id: infoHash ?? a.href,
      title: a.text || stripTags(row).slice(0, 120),
      magnet: a.href,
      ...(infoHash ? { infoHash } : {}),
      size,
      seeders,
      leechers,
      category: null,
      publishDate: null,
      files: null,
    };
    if (hit.title) hits.push(hit);
  }
  return hits;
}

function extractSize(row: string): string | undefined {
  const m = /([\d.,]+\s*(?:B|KB|MB|GB|TB))/i.exec(row);
  return m?.[1];
}

function extractCell(row: string, label: string): string | undefined {
  const m = new RegExp(`${label}[^\\d]*([\\d,]+)`, 'i').exec(row);
  return m?.[1];
}
