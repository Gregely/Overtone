/**
 * Torrent indexer interface — the pluggable protocol layer behind "Find
 * sources".
 *
 * A *torrent indexer* turns a search query into torrent hits. The only
 * protocol implemented today is Torznab (the de-facto standard that Prowlarr,
 * Jackett and most indexers expose); additional protocols plug in as new
 * {@link TorrentIndexerDefinition}s without touching the discovery pipeline.
 */

import type { ProviderFetch, ProviderLogger } from '../providers/types.js';

export interface IndexerContext {
  /** fetch with timeouts, retries and log redaction (see providers/fetch.ts). */
  fetch: ProviderFetch;
  logger: ProviderLogger;
}

export interface IndexerCapabilities {
  search: boolean;
  /** The indexer supports category filtering. */
  categories: boolean;
}

/** One torrent hit from an indexer, before any metadata matching. */
export interface IndexerHit {
  /** Stable id for dedup (guid or info hash or download URL). */
  id: string;
  title: string;
  /** magnet: URI, when the indexer provides one. */
  magnet?: string;
  /** Uppercase hex info hash, when known. */
  infoHash?: string;
  /** .torrent download URL, when the indexer provides one. */
  downloadUrl?: string;
  /** Bytes, or null when unknown. */
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  /** Torznab category id (e.g. "3040"), or null. */
  category: string | null;
  publishDate: Date | null;
  /** Number of files in the torrent, when reported. */
  files: number | null;
}

export interface IndexerSearchQuery {
  query: string;
  /** Torznab category ids to restrict to (audio), when the indexer supports them. */
  categories?: string[];
  signal: AbortSignal;
}

/** A child indexer exposed by an aggregator (Prowlarr/Jackett). */
export interface TorrentIndexerDescriptor {
  id: string;
  name: string;
  categories: string[];
}

export interface TorrentIndexerTestResult {
  ok: boolean;
  message: string;
  indexers?: TorrentIndexerDescriptor[];
}

/** Config for one configured torrent source (indexer connection). */
export interface TorrentIndexerConfig {
  /** Normalized Torznab search endpoint (no trailing slash). */
  url: string;
  apiKey?: string;
  /** Child indexer ids to search (Prowlarr/Jackett); empty/undefined = all. */
  indexerIds?: string[];
}

export interface TorrentIndexer {
  readonly id: string;
  readonly name: string;
  capabilities(): IndexerCapabilities;
  search(query: IndexerSearchQuery): AsyncIterable<IndexerHit>;
  /** Discover child indexers (Prowlarr/Jackett). Optional. */
  listIndexers?(): Promise<TorrentIndexerDescriptor[]>;
  /** Verify the URL + key work. Optional; the manager falls back to a search. */
  testConnection?(): Promise<TorrentIndexerTestResult>;
}

export interface TorrentIndexerDefinition {
  /** Protocol id, e.g. "torznab". */
  readonly id: string;
  readonly name: string;
  /** Build an indexer for one configured source. Cheap; no network I/O. */
  create(config: TorrentIndexerConfig, ctx: IndexerContext): TorrentIndexer;
}
