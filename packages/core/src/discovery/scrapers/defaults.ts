/**
 * The built-in native scraper set. These run alongside any configured
 * Torznab/Prowlarr/Jackett sources, so discovery works out of the box with no
 * extra indexer configuration.
 */
import type { IndexerContext } from '../types.js';
import { ScraperRegistry } from './registry.js';
import type { Scraper } from './types.js';
import { createX1337Scraper, type X1337ScraperOptions } from './x1337.js';

export interface DefaultScrapersOptions {
  /** 1337x base URL override (mirror), e.g. from OVERTONE_1337X_BASE_URL. */
  x1337BaseUrl?: string;
}

/**
 * Build the enabled scraper instances. `ctx` supplies the shared fetch/logger
 * (same outbound HTTP and redaction as the torrent sources).
 */
export function createDefaultScrapers(ctx: IndexerContext, opts: DefaultScrapersOptions = {}): Scraper[] {
  const registry = new ScraperRegistry();
  registry.register(createX1337Scraper({ ...(opts.x1337BaseUrl ? { baseUrl: opts.x1337BaseUrl } : {}) }));
  return registry.enabled(null, ctx);
}

export type { X1337ScraperOptions };
