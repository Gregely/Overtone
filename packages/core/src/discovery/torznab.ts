/**
 * Torznab protocol client — the standard indexer search API that Prowlarr,
 * Jackett and most individual indexers expose.
 *
 * Reference: the Newznab/Torznab specification (Prowlarr's Torznab
 * implementation and Jackett's torznab output). Checked 2026-11-02.
 *  - Search:   GET {endpoint}?t=search&q=<query>[&cat=<ids>]&apikey=<key>
 *    → RSS 2.0: <rss><channel><item>… with <title>, <guid>, <link>,
 *      <enclosure url length type>, <category>, <size>, <pubDate>, and
 *      <torznab:attr name="seeders|peers|infohash|magneturl|category|size|files" value="…"/>
 *  - Caps:     GET {endpoint}?t=caps&apikey=<key> → <caps><server/>/<categories>…
 *
 * The API key is sent both as the `apikey` query parameter (Jackett/Torznab
 * convention) and as the `X-Api-Key` header (Prowlarr). The provider fetch
 * layer strips query strings from logs, so the key never reaches a log line.
 */
import { ProviderError } from '../providers/errors.js';
import { send } from '../providers/http.js';
import type { IndexerContext, IndexerHit, IndexerSearchQuery, TorrentIndexer, TorrentIndexerConfig, TorrentIndexerDefinition, TorrentIndexerTestResult } from './types.js';
import { attr, child, childText, children, parseXml, type XmlElement } from './xml.js';

/** Torznab parent category for audio. Children (MP3, FLAC, …) inherit when filtering. */
export const TORZNAB_AUDIO_CATEGORY = '3000';

export function createTorznabIndexer(config: TorrentIndexerConfig, ctx: IndexerContext): TorrentIndexer {
  const url = String(config.url ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new ProviderError('config', 'Torznab: the endpoint URL must start with http:// or https://');

  const searchUrl = (params: URLSearchParams): string => `${url}?${params}`;

  const withAuth = (params: URLSearchParams, headers: Record<string, string>): void => {
    if (config.apiKey) {
      params.set('apikey', config.apiKey);
      headers['x-api-key'] = config.apiKey;
    }
  };

  async function fetchXml(params: URLSearchParams, what: string, signal: AbortSignal): Promise<XmlElement> {
    const headers: Record<string, string> = { accept: 'application/rss+xml, application/xml, text/xml, */*' };
    withAuth(params, headers);
    const res = await send(ctx, searchUrl(params), { headers, signal }, what);
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `${what}: the indexer rejected the API key`);
      throw new ProviderError('unavailable', `${what}: the indexer returned HTTP ${res.status}`);
    }
    const text = await res.text();
    try {
      return parseXml(text);
    } catch {
      throw new ProviderError('unavailable', `${what}: the indexer returned something that isn't Torznab XML`);
    }
  }

  return {
    id: 'torznab',
    name: 'Torznab',
    capabilities: () => ({ search: true, categories: true }),
    async *search(query: IndexerSearchQuery): AsyncIterable<IndexerHit> {
      const params = new URLSearchParams({ t: 'search', q: query.query });
      if (query.categories?.length) params.set('cat', query.categories.join(','));
      const root = await fetchXml(params, 'Search indexer', query.signal);
      const channel = child(root, 'channel');
      for (const item of channel ? children(channel, 'item') : []) {
        const hit = toHit(item);
        if (hit) yield hit;
      }
    },
    async testConnection(): Promise<TorrentIndexerTestResult> {
      try {
        // A probe search proves the endpoint is reachable and the key is valid,
        // and works uniformly across Torznab, Prowlarr and Jackett (some don't
        // implement `t=caps`). An empty result set is still a successful reply.
        const root = await fetchXml(new URLSearchParams({ t: 'search', q: 'overtone-test-probe' }), 'Connect', AbortSignal.timeout(20_000));
        const channel = child(root, 'channel');
        const title = channel ? childText(channel, 'title') : undefined;
        return { ok: true, message: title ? `Connected to ${title}` : 'Connected' };
      } catch (err) {
        if (err instanceof ProviderError) return { ok: false, message: err.message };
        throw err;
      }
    },
  };
}

export const torznabIndexer: TorrentIndexerDefinition = {
  id: 'torznab',
  name: 'Torznab',
  create: createTorznabIndexer,
};

/** Map one RSS <item> to an IndexerHit, or null when it isn't a usable torrent. */
export function toHit(item: XmlElement): IndexerHit | null {
  const title = childText(item, 'title')?.trim() ?? '';
  if (!title) return null;

  const attrs = new Map<string, string>();
  for (const a of children(item, 'attr')) {
    const name = attr(a, 'name');
    const value = attr(a, 'value');
    if (name && value !== undefined) attrs.set(name.toLowerCase(), value);
  }

  const enclosure = child(item, 'enclosure');
  const enclosureUrl = enclosure ? attr(enclosure, 'url') : undefined;
  const enclosureLength = enclosure ? Number(attr(enclosure, 'length')) : NaN;

  const infoHash = (attrs.get('infohash') ?? '').toLowerCase();
  const magnet = attrs.get('magneturl') || (infoHash ? `magnet:?xt=urn:btih:${infoHash}` : undefined);
  const downloadUrl = enclosureUrl ?? childText(item, 'link')?.trim() ?? undefined;
  const guid = childText(item, 'guid')?.trim() ?? undefined;

  const size = Number(attrs.get('size') ?? (Number.isFinite(enclosureLength) ? enclosureLength : childText(item, 'size')));
  const seeders = num(attrs.get('seeders'));
  const leechers = num(attrs.get('peers'));
  const files = num(attrs.get('files'));
  const category = attrs.get('category') ?? childText(item, 'category')?.trim() ?? null;
  const pubRaw = childText(item, 'pubDate');
  const publishDate = pubRaw ? new Date(pubRaw) : null;

  const id = infoHash || magnet || guid || downloadUrl || title;

  return {
    id,
    title,
    ...(magnet ? { magnet } : {}),
    ...(infoHash ? { infoHash } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    size: Number.isFinite(size) ? size : null,
    seeders,
    leechers,
    category,
    publishDate: publishDate && !Number.isNaN(publishDate.getTime()) ? publishDate : null,
    files,
  };
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
