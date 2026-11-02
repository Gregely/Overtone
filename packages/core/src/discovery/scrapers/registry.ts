import type { IndexerContext } from '../types.js';
import type { Scraper, ScraperCatalog, ScraperDefinition } from './types.js';

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Holds the available native scrapers. New scrapers register here. */
export class ScraperRegistry {
  readonly #defs = new Map<string, ScraperDefinition>();

  register(def: ScraperDefinition): this {
    if (!ID_RE.test(def.id)) throw new Error(`Scraper id "${def.id}" must be kebab-case`);
    if (this.#defs.has(def.id)) throw new Error(`Scraper "${def.id}" is already registered`);
    this.#defs.set(def.id, def);
    return this;
  }

  get(id: string): ScraperDefinition | undefined {
    return this.#defs.get(id);
  }

  list(): ScraperDefinition[] {
    return [...this.#defs.values()];
  }

  /** Build the enabled scraper instances, honouring a (validated) catalogue. */
  enabled(catalog: ScraperCatalog | null, ctx: IndexerContext): Scraper[] {
    const entries = catalog?.scrapers ?? this.list().map((d) => ({ id: d.id, version: d.version, enabled: true }));
    const enabledById = new Map(entries.map((e) => [e.id, e.enabled !== false]));
    return this.list()
      .filter((d) => enabledById.get(d.id) !== false)
      .map((d) => d.create(ctx));
  }
}
