import { createDebridPlugin } from './debrid/index.js';
import { allDebridAdapter } from './debrid/adapters/alldebrid/index.js';
import { premiumizeAdapter } from './debrid/adapters/premiumize/index.js';
import { realDebridAdapter } from './debrid/adapters/real-debrid/index.js';
import { torBoxAdapter } from './debrid/adapters/torbox/index.js';
import { internetArchivePlugin } from './internet-archive/index.js';
import { localFolderPlugin } from './local-folder/index.js';
import { ProviderRegistry } from './registry.js';
import { subsonicPlugin } from './subsonic/index.js';
import type { ProviderPlugin } from './types.js';

export * from './types.js';
export * from './errors.js';
export { ProviderRegistry } from './registry.js';
export { ResolveCache } from './resolve-cache.js';
export { createDebridPlugin } from './debrid/index.js';
export type * from './debrid/types.js';

/** Built-in plugins, in the order they appear in "Add source". */
export const builtinPlugins: readonly ProviderPlugin[] = [
  localFolderPlugin,
  subsonicPlugin,
  internetArchivePlugin,
  createDebridPlugin(realDebridAdapter),
  createDebridPlugin(allDebridAdapter),
  createDebridPlugin(torBoxAdapter),
  createDebridPlugin(premiumizeAdapter),
];

export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const plugin of builtinPlugins) registry.register(plugin);
  return registry;
}
