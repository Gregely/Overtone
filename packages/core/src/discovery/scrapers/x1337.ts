/**
 * 1337x native scraper — Overtone's first built-in, self-contained discovery
 * source (no Jackett/Prowlarr required).
 *
 * 1337x exposes no structured API, so this scraper parses the site's HTML:
 *   - search   GET {base}/search/{query}/{page}/
 *     → a <table class="table-list"> whose rows carry the title/detail link,
 *       seeders (td.coll-2), leechers (td.coll-3), size (td.coll-4), upload
 *       date (td.coll-date) and uploader (td.coll-5).
 *   - detail   GET {base}/torrent/{id}/{slug}/
 *     → the magnet link (<a href="magnet:…">) and an explicit infohash box
 *       (div.infohash-box > span).
 *
 * Structure verified against the py1337x client (the de-facto reference for
 * 1337x's current markup) and cross-checked against the site's HTML as of
 * 2026-11-02. The parser is covered by captured-response fixture tests; live
 * verification is documented in the test file (the site is Cloudflare-fronted
 * and unreachable from the build environment).
 *
 * Search results do not contain the magnet/infohash, so the scraper fetches
 * each result's detail page (bounded, concurrency-limited) to fill them in —
 * that infohash is what feeds the batch debrid cache checker.
 */
import { decodeEntities } from '../xml.js';
import { magnetInfoHash } from '../../providers/debrid/magnet.js';
import { ProviderError } from '../../providers/errors.js';
import { send } from '../../providers/http.js';
import type { IndexerContext, IndexerHit } from '../types.js';
import { anchors, parseNumber, parseSize, stripTags } from './html.js';
import type { Scraper, ScraperDefinition } from './types.js';

export const DEFAULT_X1337_BASE_URL = 'https://www.1337x.to';

/** A browser User-Agent, which 1337x's Cloudflare layer is more likely to pass. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface X1337ScraperOptions {
  /** Site origin (a mirror when the default is unreachable). */
  baseUrl?: string;
  /** Search path template with `{query}` and `{page}` placeholders. */
  searchPath?: string;
  /** Maximum search pages to fetch per query (each page ≈ 20 results). */
  maxPages?: number;
  /** Concurrent detail-page fetches when hydrating magnet/infohash. */
  detailConcurrency?: number;
}

interface ResolvedOptions {
  baseUrl: string;
  searchPath: string;
  maxPages: number;
  detailConcurrency: number;
}

/** One parsed row from a 1337x search results page. */
export interface X1337SearchRow {
  title: string;
  /** Site-relative detail URL, e.g. "/torrent/3922417/slug/". */
  detailUrl: string;
  size: number | null;
  seeders: number | null;
  leechers: number | null;
}

/** The bits of a detail page we care about. */
export interface X1337Detail {
  magnet?: string;
  infoHash?: string;
  title?: string;
}

export function createX1337Scraper(opts: X1337ScraperOptions = {}): ScraperDefinition {
  const o: ResolvedOptions = {
    baseUrl: (opts.baseUrl ?? DEFAULT_X1337_BASE_URL).replace(/\/+$/, ''),
    searchPath: opts.searchPath ?? '/search/{query}/{page}/',
    maxPages: opts.maxPages ?? 2,
    detailConcurrency: opts.detailConcurrency ?? 6,
  };
  if (!/^https?:\/\//i.test(o.baseUrl)) throw new ProviderError('config', '1337x: base URL must start with http:// or https://');

  return {
    id: 'x1337',
    name: '1337x',
    version: '1.0.0',
    baseUrl: o.baseUrl,
    capabilities: { search: true, seeders: true, categories: false },
    create: (ctx: IndexerContext): Scraper => new X1337Scraper(ctx, o),
  };
}

class X1337Scraper implements Scraper {
  readonly id = 'x1337';
  readonly name = '1337x';
  readonly baseUrl: string;
  readonly #ctx: IndexerContext;
  readonly #o: ResolvedOptions;

  constructor(ctx: IndexerContext, o: ResolvedOptions) {
    this.#ctx = ctx;
    this.#o = o;
    this.baseUrl = o.baseUrl;
  }

  async *search({ query, signal }: { query: string; signal: AbortSignal }): AsyncIterable<IndexerHit> {
    const first = await this.#get(buildSearchUrl(this.#o.baseUrl, this.#o.searchPath, query, 1), signal);
    const firstRows = parseSearchResults(first.html);
    const pageCount = parsePageCount(first.html, 1);
    const pages = Math.max(1, Math.min(this.#o.maxPages, pageCount));

    yield* this.#hydrate(firstRows, signal);

    for (let page = 2; page <= pages; page++) {
      signal.throwIfAborted();
      const { html } = await this.#get(buildSearchUrl(this.#o.baseUrl, this.#o.searchPath, query, page), signal);
      const rows = parseSearchResults(html);
      if (!rows.length) break; // ran past the last page
      yield* this.#hydrate(rows, signal);
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const { html } = await this.#get(this.#o.baseUrl, AbortSignal.timeout(15_000));
      void html;
      return { ok: true, message: 'Reachable' };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, message: err.message };
      return { ok: false, message: "Couldn't reach 1337x" };
    }
  }

  /** Fetch and check a page, returning its HTML. Throws ProviderError on failure. */
  async #get(url: string, signal: AbortSignal): Promise<{ html: string }> {
    const res = await send(this.#ctx, url, { headers: { accept: 'text/html', 'user-agent': BROWSER_UA }, signal }, '1337x');
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProviderError('unavailable', `1337x returned HTTP ${res.status}`);
    }
    const html = await res.text();
    if (looksBlocked(html)) throw new ProviderError('unavailable', '1337x: access blocked (Cloudflare challenge or captcha)');
    return { html };
  }

  /** Hydrate rows with detail-page magnet/infohash, concurrency-limited, in order. */
  async *#hydrate(rows: X1337SearchRow[], signal: AbortSignal): AsyncIterable<IndexerHit> {
    for (let i = 0; i < rows.length; i += this.#o.detailConcurrency) {
      const chunk = rows.slice(i, i + this.#o.detailConcurrency);
      const settled = await Promise.allSettled(chunk.map((row) => this.#detail(row, signal)));
      for (let j = 0; j < settled.length; j++) {
        signal.throwIfAborted();
        const result = settled[j]!;
        const detail = result.status === 'fulfilled' ? result.value : null;
        yield toHit(chunk[j]!, detail);
      }
    }
  }

  /** Fetch one detail page for its magnet + infohash. Throws on failure (caller degrades). */
  async #detail(row: X1337SearchRow, signal: AbortSignal): Promise<X1337Detail> {
    const url = new URL(row.detailUrl, this.#o.baseUrl).href;
    const res = await send(this.#ctx, url, { headers: { accept: 'text/html', 'user-agent': BROWSER_UA }, signal }, '1337x');
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProviderError('unavailable', `1337x detail HTTP ${res.status}`);
    }
    return parseDetailPage(await res.text());
  }
}

// ── URL building ─────────────────────────────────────────────────────────────

/** Build a search URL from the template, URL-encoding each whitespace token. */
export function buildSearchUrl(baseUrl: string, searchPath: string, query: string, page: number): string {
  const q = query.trim().split(/\s+/).map((w) => encodeURIComponent(w)).join('+');
  return `${baseUrl}${searchPath.replace('{query}', q).replace('{page}', String(page))}`;
}

// ── Search results parsing ───────────────────────────────────────────────────

/** Parse a 1337x search results page into rows. */
export function parseSearchResults(html: string): X1337SearchRow[] {
  const out: X1337SearchRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const row = m[1]!;
    const name = cellByClass(row, 'coll-1');
    if (!name) continue;
    const link = torrentLink(name);
    if (!link) continue;
    const seeders = parseNumber(stripTags(cellByClass(row, 'coll-2') ?? ''));
    const leechers = parseNumber(stripTags(cellByClass(row, 'coll-3') ?? ''));
    const size = parseSize(stripTags(cellByClass(row, 'coll-4') ?? ''));
    out.push({ title: link.title, detailUrl: link.href, size, seeders, leechers });
  }
  return out;
}

/** The first `/torrent/…` detail link in a name cell, and its visible title. */
function torrentLink(nameCell: string): { href: string; title: string } | null {
  let href: string | undefined;
  let title: string | undefined;
  for (const a of anchors(nameCell)) {
    if (!/\/torrent\//i.test(a.href)) continue;
    href ??= a.href;
    if (!title && a.text) title = a.text;
  }
  if (!href) return null;
  return { href, title: title ?? '' };
}

/** Extract a table cell by one of its classes (e.g. "coll-2", "coll-date"). */
function cellByClass(row: string, cls: string): string | undefined {
  const re = new RegExp(`<t[dh][^>]*\\bclass\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/t[dh]>`, 'i');
  return re.exec(row)?.[1];
}

/** Read the highest page number from the pagination block, defaulting to `page`. */
export function parsePageCount(html: string, page: number): number {
  const pag = /<div[^>]*class="[^"]*pagination[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  if (!pag) return page;
  const links = [...pag.matchAll(/<a[^>]*href="([^"]+)"[^>]*>/gi)].map((x) => x[1]!);
  const last = links.at(-1);
  if (!last) return page;
  const segments = last.split('/').filter(Boolean);
  const n = Number(segments.at(-1));
  return Number.isInteger(n) && n > 0 ? n : page;
}

/** True when the page is a Cloudflare challenge / captcha / access-denied page. */
export function looksBlocked(html: string): boolean {
  return /cf-challenge|cf-browser-verification|__cf_chl|challenge-platform|just a moment|access denied|captcha/i.test(html.slice(0, 8000));
}

// ── Detail page parsing ──────────────────────────────────────────────────────

/** Parse a 1337x torrent detail page for its magnet link and infohash. */
export function parseDetailPage(html: string): X1337Detail {
  const out: X1337Detail = {};

  // Magnet link: the first <a href="magnet:…">.
  const magnet = /<a[^>]*href\s*=\s*["'](magnet:[^"']+)["'][^>]*>/i.exec(html)?.[1];
  if (magnet) {
    out.magnet = decodeEntities(magnet);
    out.infoHash = magnetInfoHash(out.magnet) ?? undefined;
  }

  // Explicit infohash box, when present and the magnet didn't already provide one.
  const box = /<div[^>]*class="[^"]*infohash-box[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  const fromBox = box ? stripTags(box).toLowerCase() : '';
  if (!out.infoHash && /^[a-f0-9]{40}$/.test(fromBox)) out.infoHash = fromBox;

  // Full title from the heading, for diagnostics.
  const heading = /<div[^>]*class="[^"]*box-info-heading[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  if (heading) out.title = stripTags(heading);

  return out;
}

// ── Hit assembly ─────────────────────────────────────────────────────────────

function toHit(row: X1337SearchRow, detail: X1337Detail | null): IndexerHit {
  const infoHash = (detail?.infoHash ?? (detail?.magnet ? magnetInfoHash(detail.magnet) : null))?.toLowerCase() ?? null;
  const magnet = detail?.magnet ?? (infoHash ? `magnet:?xt=urn:btih:${infoHash}` : undefined);
  return {
    id: infoHash ?? row.detailUrl,
    title: row.title || detail?.title || stripTags(row.detailUrl),
    ...(magnet ? { magnet } : {}),
    ...(infoHash ? { infoHash } : {}),
    size: row.size,
    seeders: row.seeders,
    leechers: row.leechers,
    category: null,
    publishDate: null,
    files: null,
  };
}
