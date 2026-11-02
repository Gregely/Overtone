/**
 * TorrentSourceManager — owns configured torrent indexer connections.
 *
 * This is the torrent analogue of {@link SourceManager}: persistence, secret
 * storage (API keys), validation, connection testing, and building live
 * {@link TorrentIndexer} instances. Indexer configuration is kept entirely
 * separate from music sources and debrid providers.
 */

import type { TorrentIndexerInfoDto, TorrentSourceDto, TorrentSourceKind, TorrentSourceTestResultDto, TorrentSourceWriteDto } from '@overtone/shared';
import { randomId } from '../crypto.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { createRedactingLogger, type Logger } from '../logging.js';
import type { Clock, HttpFetch, SecretStore } from '../platform/types.js';
import { createProviderFetch } from '../providers/fetch.js';
import { ProviderError } from '../providers/errors.js';
import { listJackettIndexers, listProwlarrIndexers } from './aggregators.js';
import type { IndexerContext, TorrentIndexer, TorrentIndexerDescriptor, TorrentIndexerTestResult } from './types.js';
import type { TorrentIndexerRegistry } from './registry.js';

export interface TorrentSourceRow {
  id: string;
  kind: TorrentSourceKind;
  name: string;
  enabled: number;
  url: string;
  config_json: string;
  secrets_enc: string | null;
  created_at: number;
  last_error: string | null;
}

interface StoredConfig {
  indexers?: TorrentIndexerInfoDto[];
}

export interface TorrentSourceDeps {
  db: Database;
  registry: TorrentIndexerRegistry;
  /** Where API keys are kept: encrypted column (server) or Keystore storage (standalone). */
  secrets: SecretStore;
  logger: Logger;
  userAgent: string;
  fetch?: HttpFetch;
  clock?: Pick<Clock, 'now' | 'sleep'>;
}

export type TorrentSourceEvent = { type: 'created' | 'updated' | 'deleted'; sourceId: string };

const KINDS: readonly TorrentSourceKind[] = ['torznab', 'prowlarr', 'jackett'];

export class TorrentSourceManager {
  readonly #d: TorrentSourceDeps;
  readonly #listeners = new Set<(e: TorrentSourceEvent) => void>();

  constructor(deps: TorrentSourceDeps) {
    this.#d = deps;
  }

  onChange(fn: (e: TorrentSourceEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(e: TorrentSourceEvent): void {
    for (const fn of this.#listeners) fn(e);
  }

  list(): Promise<TorrentSourceRow[]> {
    return this.#d.db.all<TorrentSourceRow>('SELECT * FROM torrent_sources ORDER BY name COLLATE NOCASE');
  }

  get(id: string): Promise<TorrentSourceRow | undefined> {
    return this.#d.db.get<TorrentSourceRow>('SELECT * FROM torrent_sources WHERE id = ?', [id]);
  }

  async require(id: string): Promise<TorrentSourceRow> {
    const row = await this.get(id);
    if (!row) throw ApiError.notFound('Torrent source');
    return row;
  }

  async toDto(row: TorrentSourceRow): Promise<TorrentSourceDto> {
    const secrets = await this.#d.secrets.get(row.id);
    const config = parseConfig(row.config_json);
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      enabled: row.enabled === 1,
      url: row.url,
      apiKeySet: Boolean(secrets.apiKey),
      indexers: config.indexers ?? [],
      lastError: row.last_error,
    };
  }

  async listDtos(): Promise<TorrentSourceDto[]> {
    return Promise.all((await this.list()).map((r) => this.toDto(r)));
  }

  async create(input: TorrentSourceWriteDto): Promise<TorrentSourceRow> {
    const kind = requireKind(input.kind);
    const url = normalizeUrl(input.url);
    const name = cleanName(input.name ?? defaultName(kind));
    const id = randomId(6);
    const config = JSON.stringify({ indexers: normalizeIndexers(input.indexers ?? []) });
    await this.#d.db.run(
      `INSERT INTO torrent_sources (id, kind, name, enabled, url, config_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, name, input.enabled === false ? 0 : 1, url, config, this.#now()],
    );
    try {
      if (input.apiKey) await this.#d.secrets.set(id, { apiKey: input.apiKey.trim() });
    } catch (err) {
      await this.#d.db.run('DELETE FROM torrent_sources WHERE id = ?', [id]);
      throw err;
    }
    this.#emit({ type: 'created', sourceId: id });
    return (await this.get(id))!;
  }

  async update(id: string, input: TorrentSourceWriteDto): Promise<TorrentSourceRow> {
    const row = await this.require(id);
    const kind = row.kind;
    const url = input.url !== undefined ? normalizeUrl(input.url) : row.url;
    const name = input.name !== undefined ? cleanName(input.name) : row.name;
    const enabled = input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0;
    let configJson = row.config_json;
    if (input.indexers) configJson = JSON.stringify({ indexers: normalizeIndexers(input.indexers) });

    await this.#d.db.run(
      `UPDATE torrent_sources SET name = ?, enabled = ?, url = ?, config_json = ? WHERE id = ?`,
      [name, enabled, url, configJson, id],
    );
    if (input.apiKey === null) await this.#d.secrets.set(id, {});
    else if (input.apiKey) await this.#d.secrets.set(id, { apiKey: input.apiKey.trim() });
    this.#emit({ type: 'updated', sourceId: id });
    return (await this.get(id))!;
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    await this.#d.db.run('DELETE FROM torrent_sources WHERE id = ?', [id]);
    await this.#d.secrets.delete(id);
    this.#emit({ type: 'deleted', sourceId: id });
  }

  async setError(id: string, error: string | null): Promise<void> {
    await this.#d.db.run('UPDATE torrent_sources SET last_error = ? WHERE id = ?', [error, id]);
  }

  /** Build a live indexer for a saved source (used by discovery search). */
  async instance(id: string): Promise<TorrentIndexer> {
    const row = await this.require(id);
    const config = parseConfig(row.config_json);
    const secrets = await this.#d.secrets.get(row.id);
    const apiKey = secrets.apiKey ?? '';
    return this.#registry(row.kind).create(
      {
        url: searchEndpoint(row.kind, row.url),
        ...(apiKey ? { apiKey } : {}),
        ...(enabledIndexerIds(config).length ? { indexerIds: enabledIndexerIds(config) } : {}),
      },
      this.#ctx(row.id, () => [apiKey]),
    );
  }

  /** Discover child indexers (Prowlarr/Jackett). Empty for a direct Torznab source. */
  async listIndexers(id: string): Promise<TorrentIndexerInfoDto[]> {
    const row = await this.require(id);
    if (row.kind === 'torznab') return [];
    const apiKey = (await this.#d.secrets.get(row.id)).apiKey ?? '';
    const descriptors = await this.#discoverIndexers(row.kind, row.url, apiKey, row.id);
    return mergeIndexers(row, descriptors);
  }

  /** Test a saved source, or an unsaved config (when `id` is omitted). */
  async test(id: string | undefined, input: TorrentSourceWriteDto): Promise<TorrentSourceTestResultDto> {
    const row = id ? await this.require(id) : undefined;
    const kind = input.kind ?? row?.kind ?? 'torznab';
    const url = normalizeUrl(input.url ?? row?.url ?? '');
    const apiKey = input.apiKey === null ? '' : input.apiKey ?? (row ? (await this.#d.secrets.get(row.id)).apiKey : '') ?? '';

    // For Prowlarr/Jackett the indexer-list call is itself the connection test:
    // it proves the server is reachable and the key is valid, and returns the
    // importable indexers — without running a (possibly slow) search across
    // every configured indexer. A bare Torznab source falls through to a probe.
    if (kind !== 'torznab' && apiKey) {
      try {
        const indexers = mergeIndexers(row, await this.#discoverIndexers(kind, url, apiKey, row?.id ?? 'test'));
        this.#d.logger.info({ kind, url, indexers: indexers.length }, 'torrent source connection test succeeded');
        return { ok: true, message: `Connected · ${indexers.length} indexer${indexers.length === 1 ? '' : 's'}`, indexers };
      } catch (err) {
        if (err instanceof ProviderError) {
          this.#d.logger.info({ kind, url, error: err.message }, 'torrent source connection test failed');
          return { ok: false, message: err.message };
        }
        if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') {
          return { ok: false, message: 'Timed out reaching the indexer' };
        }
        throw err;
      }
    }

    const indexerIds = id ? enabledIndexerIds(parseConfig(row!.config_json)) : [];
    const indexer = this.#registry(kind).create({ url: searchEndpoint(kind, url), apiKey, ...(indexerIds.length ? { indexerIds } : {}) }, this.#ctx(row?.id ?? 'test', () => [apiKey]));
    let result: TorrentIndexerTestResult;
    try {
      result = indexer.testConnection ? await indexer.testConnection() : { ok: true, message: 'Connected' };
    } catch (err) {
      if (err instanceof ProviderError) result = { ok: false, message: err.message };
      else if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') result = { ok: false, message: 'Timed out reaching the indexer' };
      else result = { ok: false, message: `Couldn't test the connection (${(err as Error)?.message ?? 'unknown error'})` };
    }
    this.#d.logger.info({ kind, url, ok: result.ok, message: result.message }, 'torrent source connection test');
    return { ok: result.ok, message: result.message };
  }

  async #discoverIndexers(kind: TorrentSourceKind, base: string, apiKey: string, sourceId: string): Promise<TorrentIndexerDescriptor[]> {
    const ctx = this.#ctx(sourceId, () => [apiKey]);
    return kind === 'prowlarr' ? listProwlarrIndexers(base, apiKey, ctx) : listJackettIndexers(base, apiKey, ctx);
  }

  #now(): number {
    return this.#d.clock?.now() ?? Date.now();
  }

  #registry(kind: TorrentSourceKind) {
    // Every kind speaks Torznab today; the kind only affects URL shape and
    // (later) indexer discovery. A future protocol registers under its own id.
    return this.#d.registry.require('torznab');
  }

  #ctx(sourceId: string, secretValues: () => string[]): IndexerContext {
    const base = this.#d.logger.child({ torrentSource: sourceId });
    const logger = createRedactingLogger(base, secretValues);
    return {
      logger,
      fetch: createProviderFetch({
        userAgent: this.#d.userAgent,
        logger,
        ...(this.#d.fetch ? { fetch: this.#d.fetch } : {}),
        ...(this.#d.clock ? { sleep: (ms: number) => this.#d.clock!.sleep(ms) } : {}),
      }),
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function requireKind(kind: TorrentSourceKind | undefined): TorrentSourceKind {
  if (!kind || !KINDS.includes(kind)) throw ApiError.validation({ kind: 'Must be torznab, prowlarr or jackett' });
  return kind;
}

function normalizeUrl(url: string | undefined): string {
  if (!url || !url.trim()) throw ApiError.validation({ url: 'Required' });
  const u = url.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw ApiError.validation({ url: 'Must be an http(s) URL' });
  }
  return u;
}

/** The Torznab search endpoint for a stored URL (which is the base for Prowlarr/Jackett). */
export function searchEndpoint(kind: TorrentSourceKind, url: string): string {
  switch (kind) {
    case 'prowlarr':
      return `${url}/api/v1/search`;
    case 'jackett':
      // Jackett's Torznab endpoint ends in "/api"; query params (t=search, apikey, …) follow it.
      return `${url}/api/v2.0/indexers/all/results/torznab/api`;
    default:
      return url;
  }
}

function cleanName(name: string): string {
  const n = String(name).trim().slice(0, 100);
  if (!n) throw ApiError.validation({ name: 'Required' });
  return n;
}

function defaultName(kind: TorrentSourceKind): string {
  return kind === 'prowlarr' ? 'Prowlarr' : kind === 'jackett' ? 'Jackett' : 'Torznab indexer';
}

function parseConfig(json: string): StoredConfig {
  try {
    const v = JSON.parse(json) as StoredConfig;
    return { indexers: Array.isArray(v.indexers) ? v.indexers : [] };
  } catch {
    return { indexers: [] };
  }
}

function normalizeIndexers(indexers: TorrentIndexerInfoDto[]): TorrentIndexerInfoDto[] {
  const seen = new Set<string>();
  const out: TorrentIndexerInfoDto[] = [];
  for (const i of indexers) {
    const id = String(i.id ?? '').slice(0, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(i.name ?? id).slice(0, 200), enabled: i.enabled !== false, categories: (i.categories ?? []).map(String).slice(0, 50) });
  }
  return out;
}

function enabledIndexerIds(config: StoredConfig): string[] {
  return (config.indexers ?? []).filter((i) => i.enabled).map((i) => i.id);
}

/** Preserve a user's existing enable/disable choices while importing (re-)discovered indexers. */
function mergeIndexers(row: TorrentSourceRow | undefined, descriptors: TorrentIndexerDescriptor[]): TorrentIndexerInfoDto[] {
  const stored = new Map((parseConfig(row?.config_json ?? '{}').indexers ?? []).map((i) => [i.id, i.enabled]));
  return descriptors.map((d) => ({ id: d.id, name: d.name, categories: d.categories, enabled: stored.get(d.id) ?? true }));
}
