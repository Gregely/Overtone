/**
 * Native torrent scrapers — Overtone's own discovery sources, independent of
 * Jackett/Prowlarr. Each scraper wraps one website (or structured API) and
 * turns a search query into normalized {@link IndexerHit}s, which flow through
 * the existing discovery/aggregation/ranking pipeline.
 */
import type { IndexerContext, IndexerHit } from '../types.js';

export interface ScraperSearchQuery {
  query: string;
  signal: AbortSignal;
}

export interface ScraperHealth {
  ok: boolean;
  message: string;
}

export interface Scraper {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  search(query: ScraperSearchQuery): AsyncIterable<IndexerHit>;
  /** Cheap connectivity/health check. Optional. */
  testConnection?(): Promise<ScraperHealth>;
}

export interface ScraperCapabilities {
  search: boolean;
  /** The scraper reports seeders/leechers. */
  seeders: boolean;
  categories: boolean;
}

export interface ScraperDefinition {
  id: string;
  name: string;
  version: string;
  baseUrl: string;
  capabilities: ScraperCapabilities;
  /** Build a scraper instance. Cheap; no network I/O. */
  create(ctx: IndexerContext): Scraper;
}

/** One entry in the declarative, remotely updateable catalogue. */
export interface ScraperCatalogEntry {
  id: string;
  version: string;
  enabled: boolean;
  /** Minimum Overtone version required by this scraper definition. */
  minVersion?: string;
}

export interface ScraperCatalog {
  format: 'overtone-scrapers';
  version: number;
  scrapers: ScraperCatalogEntry[];
}
