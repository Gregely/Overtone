/**
 * Bridge: DebridAdapterDefinition → ProviderPlugin.
 *
 * Every debrid service shows up as its own source type in Settings > Sources,
 * with the same config shape: an API key field, hidden adapter-managed OAuth
 * secrets where a device flow exists, and a tag-probing toggle.
 *
 * Streams are never redirect-safe: resolved links act as bearer credentials
 * and are often tied to the requesting IP, so the server always proxies them.
 */

import { audioMimeType, type ConfigField, type ConfigValues } from '@overtone/shared';
import { probeRemoteTags } from '../../metadata/probe.js';
import { ProviderError } from '../errors.js';
import type {
  CallOptions,
  ConnectionTestResult,
  FileTags,
  ProviderContext,
  ProviderPlugin,
  ResolvedStream,
  ResolveOptions,
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
        ? `Use "Log in with ${def.name}" above, or paste your API key from ${def.apiKeyUrl}.`
        : `Find your API key at ${def.apiKeyUrl}.`,
    },
    ...managed.map((key): ConfigField => ({ key, type: 'secret', label: key, hidden: true })),
    {
      key: 'probeTags',
      type: 'boolean',
      label: 'Read tags from files',
      default: true,
      help: 'Fetches the first 256 KB of each new file to read its tags for better matching. Turn off to rely on folder and file names.',
    },
  ];

  return {
    manifest: {
      id: def.id,
      name: def.name,
      description: `Stream audio files already in your ${def.name} account.`,
      category: 'debrid',
      configSchema: {
        fields,
        ...(def.deviceFlow
          ? {
              deviceLogin: {
                label: `Log in with ${def.name}`,
                help: def.deviceLoginHelp ?? `Approve Overtone on ${def.name}'s website; no need to copy an API key.`,
                replaces: ['apiKey', ...managed],
              },
            }
          : {}),
      },
      capabilities: { testConnection: true, redirectable: false, ...(def.retrieval ? { retrieval: true } : {}) },
      ...(def.deviceFlow ? { deviceFlow: def.deviceFlow } : {}),
    },
    create(config, ctx) {
      return new DebridSourceProvider(def, extractCredentials(config, ['apiKey', ...managed]), ctx, config.probeTags !== false);
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
  readonly #probe: boolean;
  #adapter: DebridAdapter | undefined;

  constructor(def: DebridAdapterDefinition, credentials: DebridCredentials, ctx: ProviderContext, probe = true) {
    this.#def = def;
    this.#credentials = credentials;
    this.#ctx = ctx;
    this.#probe = probe;
  }

  /** Lazily build the adapter so a source with no credentials yet can still exist. */
  get adapter(): DebridAdapter {
    if (!this.#adapter) {
      if (Object.keys(this.#credentials).length === 0) {
        throw new ProviderError('auth', `${this.#def.name}: not signed in. Log in or add an API key in Settings › Sources.`);
      }
      this.#adapter = this.#def.create(this.#credentials, this.#ctx);
    }
    return this.#adapter;
  }

  /**
   * Debrid is a playback service, not a catalogue: the account is NOT
   * enumerated into the library. Debrid-acquired files enter the library only
   * through Overtone-created retrieval jobs (the synthetic "retrieval" source).
   * `resolveStream` below still resolves legacy whole-account file ids so any
   * rows from before this change keep playing.
   */
  async *listLibrary(_opts: CallOptions): AsyncIterable<SourceFile> {
    // Intentionally empty — no whole-account enumeration.
  }

  async resolveStream(fileId: string, opts: ResolveOptions): Promise<ResolvedStream> {
    const link = await this.adapter.resolveLink(fileId, opts);
    const ttl = this.#def.defaultLinkTtlMs ?? DEFAULT_LINK_TTL_MS;
    return {
      url: link.url,
      expiresAt: link.expiresAt ?? new Date(Date.now() + ttl),
      redirectSafe: false,
      ...(link.headers ? { headers: link.headers } : {}),
      ...(link.mimeType ? { mimeType: link.mimeType } : {}),
      ...(link.size !== undefined ? { size: link.size } : {}),
    };
  }

  /** Probe embedded tags over a Range request, if enabled for this source. */
  async readTags(fileId: string, opts: CallOptions): Promise<FileTags | null> {
    if (!this.#probe) return null;
    const stream = await this.resolveStream(fileId, opts);
    return probeRemoteTags((url: string, init: RequestInit) => this.#ctx.fetch(url, init), stream, { mimeType: audioMimeType(fileId) ?? null }, opts.signal);
  }

  async testConnection(opts: CallOptions): Promise<ConnectionTestResult> {
    try {
      const info = await this.adapter.testConnection(opts);
      const details: Record<string, string> = {};
      if (info.username) details.account = info.username;
      if (info.plan) details.plan = info.plan;
      if (info.premiumUntil) details.premiumUntil = info.premiumUntil.toISOString().slice(0, 10);
      const who = info.username ? ` as ${info.username}` : '';
      if (!info.premium) {
        return { ok: false, message: `Connected${who}, but this ${this.#def.name} account has no active premium subscription.`, details };
      }
      const until = info.premiumUntil ? `, premium until ${info.premiumUntil.toISOString().slice(0, 10)}` : '';
      return { ok: true, message: `Connected to ${this.#def.name}${who}${until}.`, details };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, message: err.message };
      throw err;
    }
  }
}
