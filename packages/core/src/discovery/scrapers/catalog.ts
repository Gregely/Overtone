import type { ScraperCatalog, ScraperCatalogEntry } from './types.js';

/**
 * Validate an untrusted catalogue payload into a {@link ScraperCatalog}.
 * The catalogue only *enables/disables/versions* scraper ids that already have
 * built-in definitions — it never carries executable code, so a remote update
 * cannot inject arbitrary logic. Returns null for anything malformed.
 */
export function validateCatalog(input: unknown): ScraperCatalog | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  if (c.format !== 'overtone-scrapers' || typeof c.version !== 'number' || !Array.isArray(c.scrapers)) return null;

  const scrapers: ScraperCatalogEntry[] = [];
  for (const e of c.scrapers) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id || typeof o.version !== 'string') continue;
    scrapers.push({
      id: o.id,
      version: o.version,
      enabled: o.enabled !== false,
      ...(typeof o.minVersion === 'string' && o.minVersion ? { minVersion: o.minVersion } : {}),
    });
  }
  return { format: 'overtone-scrapers', version: c.version, scrapers };
}

/**
 * Merge a remote catalogue over the built-in defaults: unknown ids are dropped,
 * known ids get their enabled/version from the catalogue. Returns the effective
 * enabled set (built-ins default to enabled).
 */
export function effectiveCatalog(remote: unknown): ScraperCatalog {
  return validateCatalog(remote) ?? { format: 'overtone-scrapers', version: 0, scrapers: [] };
}
