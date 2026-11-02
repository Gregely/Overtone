import type { TorrentIndexerDefinition } from './types.js';
import { torznabIndexer } from './torznab.js';

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Holds the available torrent indexer protocols. `torznab` ships built-in;
 * additional protocols register their own {@link TorrentIndexerDefinition}
 * here without touching the discovery pipeline.
 */
export class TorrentIndexerRegistry {
  readonly #defs = new Map<string, TorrentIndexerDefinition>();

  register(def: TorrentIndexerDefinition): this {
    if (!ID_RE.test(def.id)) throw new Error(`Torrent indexer id "${def.id}" must be kebab-case`);
    if (this.#defs.has(def.id)) throw new Error(`Torrent indexer protocol "${def.id}" is already registered`);
    this.#defs.set(def.id, def);
    return this;
  }

  get(id: string): TorrentIndexerDefinition | undefined {
    return this.#defs.get(id);
  }

  require(id: string): TorrentIndexerDefinition {
    const def = this.#defs.get(id);
    if (!def) throw new Error(`Unknown torrent indexer protocol "${id}"`);
    return def;
  }

  list(): TorrentIndexerDefinition[] {
    return [...this.#defs.values()];
  }
}

export function createDefaultTorrentRegistry(): TorrentIndexerRegistry {
  return new TorrentIndexerRegistry().register(torznabIndexer);
}
