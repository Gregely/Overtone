/**
 * Internet Archive: openly licensed audio from archive.org.
 *
 * The library is exactly what the configured collection or saved query
 * matches. No free-text "search and add" exists anywhere. Every item must
 * carry a Creative Commons or public-domain `licenseurl`; anything else is
 * skipped, checked both in the search results and in the item metadata.
 *
 * Docs (checked 2026-11-01):
 *  - Search / scrape API: https://archive.org/help/aboutsearch.htm
 *    GET https://archive.org/services/search/v1/scrape?q&fields&count(≥100)&cursor
 *    → { items: [...], count, total, cursor? } (repeat with `cursor` until absent);
 *    errors → { error, errorType }
 *  - Metadata read API: https://archive.org/developers/md-read.html
 *    GET https://archive.org/metadata/{identifier} → { metadata, files: [{ name, source,
 *    format, size, length, title, creator, album, track, original, mtime }] }
 *  - Items / downloads: https://archive.org/developers/items.html
 *    https://archive.org/download/{identifier}/{file} (redirects to a data node; public)
 *  - Bots & automated access: https://archive.org/developers/bots.html
 *    descriptive User-Agent, delays between requests, honour 429 + Retry-After,
 *    retry with backoff, cache responses
 *  - Metadata schema (licenseurl, mediatype): https://archive.org/developers/metadata-schema/
 */
import { audioMimeType, fileExtension, isAudioFile } from '@overtone/shared';
import { ProviderError } from '../errors.js';
import { readJson, send } from '../http.js';
import type { CallOptions, FileTags, ProviderContext, ProviderPlugin, SourceFile, SourceProvider } from '../types.js';

export type ArchiveConfig = { query: string; format: 'best' | 'flac' | 'ogg' | 'mp3'; maxItems: number };

export interface ArchiveOptions {
  base?: string;
  /** Pause between metadata requests (politeness). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const SCRAPE_COUNT = 500;
const METADATA_TTL_MS = 7 * 24 * 3600_000;

export function createInternetArchivePlugin(opts: ArchiveOptions = {}): ProviderPlugin<ArchiveConfig> {
  const o: Required<ArchiveOptions> = {
    base: opts.base ?? 'https://archive.org',
    delayMs: opts.delayMs ?? 300,
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: opts.now ?? Date.now,
  };
  return {
    manifest: {
      id: 'internet-archive',
      name: 'Internet Archive',
      description: 'Public-domain and Creative Commons audio from an archive.org collection or saved query.',
      category: 'public',
      capabilities: { testConnection: true, redirectable: true },
      configSchema: {
        fields: [
          {
            key: 'query',
            type: 'string',
            label: 'Collection or query',
            required: true,
            placeholder: 'netlabels',
            help: 'An archive.org collection identifier (e.g. "netlabels") or an advanced-search query. Only items licensed Creative Commons or public domain are included.',
          },
          {
            key: 'format',
            type: 'select',
            label: 'Preferred format',
            default: 'best',
            options: [
              { value: 'best', label: 'Best available (FLAC → Ogg → MP3)' },
              { value: 'flac', label: 'FLAC only' },
              { value: 'ogg', label: 'Ogg Vorbis only' },
              { value: 'mp3', label: 'MP3 only' },
            ],
          },
          { key: 'maxItems', type: 'number', label: 'Max items', default: 200, min: 1, max: 5000, integer: true, help: 'Albums/recordings to include from the collection.' },
        ],
      },
    },
    create(config, ctx) {
      return new InternetArchiveProvider(config, ctx, o);
    },
  };
}

export const internetArchivePlugin = createInternetArchivePlugin();

/** Creative Commons licences and public-domain dedications/marks only. */
export function isOpenLicense(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  return /^https?:\/\/(www\.)?creativecommons\.org\/(licenses|publicdomain)\/[a-z0-9.+-]+/i.test(url.trim());
}

/** A bare identifier means "this collection"; anything else is used as an advanced-search query. */
export function buildQuery(input: string): string {
  const q = input.trim();
  const base = /^[A-Za-z0-9._-]+$/.test(q) ? `collection:${q}` : `(${q})`;
  return `${base} AND mediatype:(audio OR etree)`;
}

interface ScrapeItem {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  date?: string;
  licenseurl?: string;
}

interface IaFile {
  name: string;
  source?: string;
  format?: string;
  size?: string;
  length?: string;
  title?: string;
  creator?: string;
  album?: string;
  track?: string;
  original?: string;
  mtime?: string;
}

interface CachedItem {
  fetchedAt: number;
  license: string | null;
  title: string | null;
  creator: string | null;
  date: string | null;
  files: IaFile[];
}

export class InternetArchiveProvider implements SourceProvider {
  readonly #c: ArchiveConfig;
  readonly #ctx: ProviderContext;
  readonly #o: Required<ArchiveOptions>;

  constructor(config: ArchiveConfig, ctx: ProviderContext, o: Required<ArchiveOptions>) {
    if (!String(config.query ?? '').trim()) throw new ProviderError('config', 'Internet Archive: a collection or query is required');
    this.#c = config;
    this.#ctx = ctx;
    this.#o = o;
  }

  async #json<T>(url: string, what: string, signal: AbortSignal): Promise<T> {
    const res = await send(this.#ctx, url, { signal, headers: { accept: 'application/json' } }, what);
    if (res.status === 429) {
      await res.body?.cancel();
      const retry = Number(res.headers.get('retry-after'));
      throw new ProviderError('rate_limited', `${what}: archive.org asked us to slow down`, retry > 0 ? { retryAfterMs: retry * 1000 } : {});
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProviderError(res.status === 404 ? 'not_found' : 'unavailable', `${what}: archive.org returned HTTP ${res.status}`);
    }
    return readJson<T>(res, what);
  }

  async *#scrape(signal: AbortSignal, limit: number): AsyncIterable<ScrapeItem> {
    let cursor: string | undefined;
    let n = 0;
    do {
      const q = new URLSearchParams({ q: buildQuery(this.#c.query), fields: 'identifier,title,creator,date,licenseurl', count: String(SCRAPE_COUNT) });
      if (cursor) q.set('cursor', cursor);
      const page = await this.#json<{ items?: ScrapeItem[]; cursor?: string; error?: string }>(`${this.#o.base}/services/search/v1/scrape?${q}`, 'Search collection', signal);
      if (page.error) throw new ProviderError('config', `Internet Archive rejected the query: ${page.error}`);
      for (const item of page.items ?? []) {
        yield item;
        if (++n >= limit) return;
      }
      cursor = page.cursor;
    } while (cursor);
  }

  async *listLibrary({ signal }: CallOptions): AsyncIterable<SourceFile> {
    const maxItems = Number(this.#c.maxItems) || 200;
    let accepted = 0;
    let first = true;
    // Scrape a bit beyond maxItems: some results will fail the licence check.
    for await (const hit of this.#scrape(signal, maxItems * 3)) {
      if (accepted >= maxItems) return;
      if (!isOpenLicense(hit.licenseurl)) continue;
      if (!first) await this.#o.sleep(this.#o.delayMs);
      first = false;
      const item = await this.#item(hit.identifier, signal);
      if (!item || !isOpenLicense(item.license)) continue;
      accepted++;
      yield* this.#files(hit.identifier, item);
    }
  }

  /** Item metadata, cached for a week (archive.org asks clients to cache). */
  async #item(identifier: string, signal: AbortSignal): Promise<CachedItem | null> {
    const key = `ia:item:${identifier}`;
    const cached = this.#ctx.state.get<CachedItem>(key);
    if (cached && this.#o.now() - cached.fetchedAt < METADATA_TTL_MS) return cached;
    let md: { metadata?: Record<string, unknown>; files?: IaFile[] };
    try {
      md = await this.#json(`${this.#o.base}/metadata/${encodeURIComponent(identifier)}`, 'Read item', signal);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'not_found') return null;
      throw err;
    }
    if (!md.metadata) return null; // dark or removed item: {}
    const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : v === undefined || v === null ? null : String(v)) || null;
    const item: CachedItem = {
      fetchedAt: this.#o.now(),
      license: first(md.metadata.licenseurl),
      title: first(md.metadata.title),
      creator: first(md.metadata.creator),
      date: first(md.metadata.date),
      files: (md.files ?? [])
        .filter((f) => isAudioFile(f.name))
        .map((f) => pick(f, ['name', 'source', 'format', 'size', 'length', 'title', 'creator', 'album', 'track', 'original', 'mtime'])),
    };
    this.#ctx.state.set(key, item);
    return item;
  }

  *#files(identifier: string, item: CachedItem): Iterable<SourceFile> {
    const chosen = chooseFiles(item.files, this.#c.format ?? 'best');
    const safe = (s: string) => s.replace(/\//g, '∕').trim();
    const artistDir = safe(item.creator ?? 'Unknown Artist');
    const albumDir = safe(item.title ?? identifier);
    const year = item.date?.match(/^(\d{4})/)?.[1];
    for (const f of chosen) {
      const name = f.name.split('/').pop()!;
      const tags: FileTags = {};
      if (f.title) tags.title = f.title;
      const artist = f.creator ?? item.creator;
      if (artist) tags.artist = artist;
      if (item.creator) tags.albumArtist = item.creator;
      tags.album = f.album ?? item.title ?? identifier;
      const tn = f.track?.match(/^(\d+)(?:\/(\d+))?/);
      if (tn) {
        tags.trackNumber = Number(tn[1]);
        if (tn[2]) tags.trackTotal = Number(tn[2]);
      }
      if (year) tags.year = Number(year);
      const ms = parseLength(f.length);
      if (ms) tags.durationMs = ms;
      const mimeType = audioMimeType(name);
      yield {
        id: `${identifier}/${f.name}`,
        name,
        path: `${artistDir}/${albumDir}/${name}`,
        size: Number(f.size) || 0,
        ...(mimeType ? { mimeType } : {}),
        ...(f.mtime ? { modifiedAt: new Date(Number(f.mtime) * 1000) } : {}),
        ...(ms ? { durationMs: ms } : {}),
        tags,
      };
    }
  }

  async resolveStream(fileId: string) {
    const slash = fileId.indexOf('/');
    if (slash <= 0) throw new ProviderError('not_found', 'Unknown Internet Archive file');
    const identifier = fileId.slice(0, slash);
    const file = fileId.slice(slash + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(identifier) || file.split('/').some((p) => p === '..' || p === '')) {
      throw new ProviderError('not_found', 'Unknown Internet Archive file');
    }
    const mimeType = audioMimeType(file);
    return {
      // Public, credential-free URL: redirect-safe when the source opts into redirect mode.
      url: `${this.#o.base}/download/${encodeURIComponent(identifier)}/${file.split('/').map(encodeURIComponent).join('/')}`,
      redirectSafe: true,
      ...(mimeType ? { mimeType } : {}),
    };
  }

  async testConnection({ signal }: CallOptions) {
    try {
      const q = new URLSearchParams({ q: buildQuery(this.#c.query), fields: 'identifier,licenseurl', count: '100' });
      const page = await this.#json<{ items?: ScrapeItem[]; total?: number; error?: string }>(`${this.#o.base}/services/search/v1/scrape?${q}`, 'Search collection', signal);
      if (page.error) return { ok: false, message: `Internet Archive rejected the query: ${page.error}` };
      const total = page.total ?? page.items?.length ?? 0;
      const open = (page.items ?? []).filter((i) => isOpenLicense(i.licenseurl)).length;
      if (total === 0) return { ok: false, message: 'No audio items match this collection or query.' };
      if (open === 0) return { ok: false, message: `Found ${total.toLocaleString()} items, but none of the first 100 are Creative Commons or public domain.` };
      return {
        ok: true,
        message: `Found ${total.toLocaleString()} audio items; ${open} of the first ${Math.min(100, page.items?.length ?? 0)} are openly licensed.`,
        details: { matches: String(total) },
      };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, message: err.message };
      throw err;
    }
  }
}

const RANK: Record<string, number> = { flac: 0, ogg: 1, oga: 1, mp3: 2 };

/**
 * One file per track: originals and their derivatives (`original` points at
 * the source file) form a group; pick the preferred format within it.
 */
export function chooseFiles(files: IaFile[], format: ArchiveConfig['format']): IaFile[] {
  const groups = new Map<string, IaFile[]>();
  for (const f of files) {
    if (!isAudioFile(f.name)) continue;
    const key = f.source === 'derivative' && f.original ? f.original : f.name;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: IaFile[] = [];
  for (const group of groups.values()) {
    const allowed = group.filter((f) => {
      const ext = fileExtension(f.name);
      return format === 'best' ? true : format === 'ogg' ? ext === 'ogg' || ext === 'oga' : ext === format;
    });
    if (!allowed.length) continue;
    allowed.sort((a, b) => score(a) - score(b));
    out.push(allowed[0]!);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function score(f: IaFile): number {
  const ext = fileExtension(f.name);
  const base = RANK[ext] ?? 3;
  // Among MP3s prefer VBR / higher bitrate derivatives.
  const vbr = /vbr/i.test(f.format ?? '') ? 0 : /(\d+)\s*kbps/i.test(f.format ?? '') ? 0.5 - Number(/(\d+)/.exec(f.format!)![1]) / 1000 : 0.4;
  return base + vbr / 10;
}

export function parseLength(v: string | undefined): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const parts = v.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return Math.round(parts.reduce((acc, p) => acc * 60 + p, 0) * 1000);
}

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
