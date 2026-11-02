import { createDebridPlugin } from './debrid/index.js';
import { createAllDebridAdapter } from './debrid/adapters/alldebrid/index.js';
import { createPremiumizeAdapter } from './debrid/adapters/premiumize/index.js';
import { createRealDebridAdapter } from './debrid/adapters/real-debrid/index.js';
import { createTorBoxAdapter } from './debrid/adapters/torbox/index.js';
import { createInternetArchivePlugin } from './internet-archive/index.js';
import { ProviderRegistry } from './registry.js';
import { subsonicPlugin } from './subsonic/index.js';
import type { ProviderPlugin } from './types.js';

export * from './types.js';
export * from './errors.js';
export { ProviderRegistry } from './registry.js';
export { ResolveCache } from './resolve-cache.js';
export { createDebridPlugin } from './debrid/index.js';
export type * from './debrid/types.js';

export interface BuiltinOptions {
  /** Registered Premiumize OAuth client id; enables "Log in with Premiumize". */
  premiumizeClientId?: string | null;
  /**
   * The platform's own local-files plugin(s), listed first: "Local folder"
   * (server, Node fs) or "This device" (Android, Storage Access Framework).
   * They live outside core because file access is platform-specific.
   */
  local?: readonly ProviderPlugin[];
}

/** Built-in plugins, in the order they appear in "Add source". */
export function createBuiltinPlugins(opts: BuiltinOptions = {}): ProviderPlugin[] {
  return [
    ...(opts.local ?? []),
    subsonicPlugin,
    createInternetArchivePlugin(),
    createDebridPlugin(createRealDebridAdapter()),
    createDebridPlugin(createAllDebridAdapter()),
    createDebridPlugin(createTorBoxAdapter()),
    createDebridPlugin(createPremiumizeAdapter({ clientId: opts.premiumizeClientId ?? null })),
  ] as ProviderPlugin[];
}

export const builtinPlugins: readonly ProviderPlugin[] = createBuiltinPlugins();

export function createDefaultRegistry(opts: BuiltinOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const plugin of createBuiltinPlugins(opts)) registry.register(plugin);
  return registry;
}
