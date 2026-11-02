/**
 * The server's provider set: core's built-ins plus "Local folder", which
 * needs Node's filesystem and so lives here rather than in @overtone/core.
 */
import { createBuiltinPlugins as coreBuiltins, ProviderRegistry, type BuiltinOptions, type ProviderPlugin } from '@overtone/core';
import { localFolderPlugin } from './local-folder/index.js';

export { localFolderPlugin };

export function createBuiltinPlugins(opts: Omit<BuiltinOptions, 'local'> = {}): ProviderPlugin[] {
  return coreBuiltins({ ...opts, local: [localFolderPlugin as unknown as ProviderPlugin] });
}

export const builtinPlugins: readonly ProviderPlugin[] = createBuiltinPlugins();

export function createDefaultRegistry(opts: Omit<BuiltinOptions, 'local'> = {}): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const plugin of createBuiltinPlugins(opts)) registry.register(plugin);
  return registry;
}
