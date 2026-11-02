import { assertValidSchema, type ProviderManifestDto } from '@overtone/shared';
import type { ProviderPlugin } from './types.js';

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Holds every available provider plugin. Built-ins are registered at boot
 * (see ./index.ts); the registry validates manifests eagerly so a broken
 * plugin fails at startup rather than when a user opens Settings.
 */
export class ProviderRegistry {
  readonly #plugins = new Map<string, ProviderPlugin>();

  register(plugin: ProviderPlugin): this {
    const { id } = plugin.manifest;
    if (!ID_RE.test(id)) throw new Error(`Provider id "${id}" must be kebab-case`);
    if (this.#plugins.has(id)) throw new Error(`Provider "${id}" is already registered`);
    assertValidSchema(plugin.manifest.configSchema, `provider "${id}"`);
    if (Boolean(plugin.manifest.deviceFlow) !== Boolean(plugin.manifest.configSchema.deviceLogin)) {
      throw new Error(`Provider "${id}": deviceFlow and configSchema.deviceLogin must be declared together`);
    }
    this.#plugins.set(id, plugin);
    return this;
  }

  get(id: string): ProviderPlugin | undefined {
    return this.#plugins.get(id);
  }

  require(id: string): ProviderPlugin {
    const p = this.#plugins.get(id);
    if (!p) throw new Error(`Unknown provider "${id}"`);
    return p;
  }

  list(): ProviderPlugin[] {
    return [...this.#plugins.values()];
  }

  /** Client-facing catalog (GET /api/providers). Strips hidden fields. */
  toDtos(): ProviderManifestDto[] {
    return this.list().map(({ manifest: m }) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      category: m.category,
      configSchema: {
        fields: m.configSchema.fields.filter((f) => !f.hidden),
        ...(m.configSchema.deviceLogin ? { deviceLogin: m.configSchema.deviceLogin } : {}),
      },
      capabilities: {
        watch: Boolean(m.capabilities?.watch),
        testConnection: Boolean(m.capabilities?.testConnection),
        deviceFlow: Boolean(m.deviceFlow),
        redirectable: Boolean(m.capabilities?.redirectable),
        retrieval: Boolean(m.capabilities?.retrieval),
      },
    }));
  }
}
