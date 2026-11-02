/**
 * Prowlarr / Jackett indexer auto-discovery.
 *
 * These two aggregators expose their configured indexers over their own JSON
 * APIs (not Torznab). Both are optional conveniences: a direct Torznab source
 * has no children to discover, and other protocols can be added separately.
 */
import { ProviderError } from '../providers/errors.js';
import { readJson, send } from '../providers/http.js';
import type { IndexerContext, TorrentIndexerDescriptor } from './types.js';
import { attr, children, parseXml } from './xml.js';

/** Prowlarr: `GET {base}/api/v1/indexer` (X-Api-Key header) → JSON array. */
export async function listProwlarrIndexers(base: string, apiKey: string, ctx: IndexerContext): Promise<TorrentIndexerDescriptor[]> {
  const res = await send(
    ctx,
    `${base}/api/v1/indexer`,
    { headers: { 'x-api-key': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
    'List Prowlarr indexers',
  );
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'Prowlarr rejected the API key');
    throw new ProviderError('unavailable', `Prowlarr returned HTTP ${res.status}`);
  }
  const data = await readJson<Array<{ id?: number; name?: string; categories?: Array<{ id?: number; name?: string }> }>>(res, 'List Prowlarr indexers');
  return data
    .filter((i) => i.id !== undefined)
    .map((i) => ({
      id: String(i.id),
      name: i.name ?? String(i.id),
      categories: (i.categories ?? []).map((c) => String(c.id ?? c.name ?? '')).filter(Boolean),
    }));
}

/** Jackett: `GET {base}/api/v2.0/indexers/all/results/torznab/api?apikey=&t=indexers` → `<indexers><indexer id title>…`. */
export async function listJackettIndexers(base: string, apiKey: string, ctx: IndexerContext): Promise<TorrentIndexerDescriptor[]> {
  const res = await send(
    ctx,
    `${base}/api/v2.0/indexers/all/results/torznab/api?apikey=${encodeURIComponent(apiKey)}&t=indexers`,
    { headers: { accept: 'application/xml, text/xml, */*' }, signal: AbortSignal.timeout(20_000) },
    'List Jackett indexers',
  );
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'Jackett rejected the API key');
    throw new ProviderError('unavailable', `Jackett returned HTTP ${res.status}`);
  }
  const text = await res.text();
  let root;
  try {
    root = parseXml(text);
  } catch {
    throw new ProviderError('unavailable', 'Jackett returned an unexpected response (not Torznab XML)');
  }
  return children(root, 'indexer')
    .map((i) => {
      const id = attr(i, 'id') ?? '';
      return { id, name: attr(i, 'title') ?? id, categories: [] };
    })
    .filter((i) => i.id);
}
