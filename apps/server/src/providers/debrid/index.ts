/**
 * Bridge: DebridAdapterDefinition → ProviderPlugin.
 *
 * Every debrid service shows up as its own source type in Settings > Sources,
 * with the same config shape: one API key field (plus hidden, adapter-managed
 * OAuth secrets where a device flow exists).
 */

import { audioMimeType, isAudioFile, type ConfigField, type ConfigValues } from '@overtone/shared';
import { ProviderError } from '../errors.js';
import type {
  ConnectionTestResult,
  ProviderContext,
  ProviderPlugin,
  ResolvedStream,
  SourceFile,
  SourceProvider,
} from '../types.js';
import type { DebridAdapter, DebridAdapterDefinition, DebridCredentials } from './types.js';

export const DEFAULT_LINK_TTL_MS = 60 * 60 * 1000;

export function createDebridPlugin(def: DebridAdapterDefinition): ProviderPlugin {
  const managed = def.managedSecrets ?? [];
  const fields: ConfigField[] = [
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API key',
      // With a device flow the key can be obtained by logging in instead of pasting.
      required: !def.deviceFlow,
      help: def.deviceFlow
        ? `Paste your API key from ${def.apiKeyUrl}, or use "Log in with ${def.name}".`
        : `Find your API key at ${def.apiKeyUrl}.`,
    },
    ...managed.map((key): ConfigField => ({ key, type: 'secret', label: key, hidden: true })),
  ];

  return {
    manifest: {
      id: def.id,
      name: def.name,
      description: `Stream audio files already in your ${def.name} account.`,
      category: 'debrid',
      configSchema: { fields },
      capabilities: { testConnection: true, redirectable: true },
      ...(def.deviceFlow ? { deviceFlow: def.deviceFlow } : {}),
    },
    create(config, ctx) {
      return new DebridSourceProvider(def, extractCredentials(config, ['apiKey', ...managed]), ctx);
    },
  };
}

function extractCredentials(config: ConfigValues, keys: readonly string[]): DebridCredentials {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = config[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

export class DebridSourceProvider implements SourceProvider {
  readonly #def: DebridAdapterDefinition;
  readonly #credentials: DebridCredentials;
  readonly #ctx: ProviderContext;
  #adapter: DebridAdapter | undefined;

  constructor(def: DebridAdapterDefinition, credentials: DebridCredentials, ctx: ProviderContext) {
    this.#def = def;
    this.#credentials = credentials;
    this.#ctx = ctx;
  }

  /** Lazily build the adapter so a source with no credentials yet can still exist. */
  get adapter(): DebridAdapter {
    if (!this.#adapter) {
      if (Object.keys(this.#credentials).length === 0) {
        throw new ProviderError('auth', `${this.#def.name}: no API key configured`);
      }
      this.#adapter = this.#def.create(this.#credentials, this.#ctx);
    }
    return this.#adapter;
  }

  async *listLibrary(opts: { signal: AbortSignal }): AsyncIterable<SourceFile> {
    for await (const f of this.adapter.listFiles(opts)) {
      opts.signal.throwIfAborted();
      if (!isAudioFile(f.name)) continue;
      const mimeType = audioMimeType(f.name);
      yield {
        id: f.id,
        name: f.name,
        path: f.path,
        size: f.size,
        ...(mimeType ? { mimeType } : {}),
        ...(f.modifiedAt ? { modifiedAt: f.modifiedAt } : {}),
      };
    }
  }

  async resolveStream(fileId: string, opts: { signal: AbortSignal; forceRefresh?: boolean }): Promise<ResolvedStream> {
    const link = await this.adapter.resolveLink(fileId, opts);
    const ttl = this.#def.defaultLinkTtlMs ?? DEFAULT_LINK_TTL_MS;
    return {
      url: link.url,
      expiresAt: link.expiresAt ?? new Date(Date.now() + ttl),
      redirectSafe: link.redirectSafe ?? false,
      ...(link.headers ? { headers: link.headers } : {}),
      ...(link.mimeType ? { mimeType: link.mimeType } : {}),
      ...(link.size !== undefined ? { size: link.size } : {}),
    };
  }

  async testConnection(opts: { signal: AbortSignal }): Promise<ConnectionTestResult> {
    try {
      const info = await this.adapter.testConnection(opts);
      const details: Record<string, string> = {};
      if (info.username) details.username = info.username;
      if (info.premiumUntil) details.premiumUntil = info.premiumUntil.toISOString();
      if (!info.premium) {
        return { ok: false, message: `Connected, but this ${this.#def.name} account has no active premium subscription.`, details };
      }
      return { ok: true, message: `Connected to ${this.#def.name}.`, details };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, message: err.message };
      throw err;
    }
  }
}
