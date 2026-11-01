/**
 * Debrid adapter interface.
 *
 * A DebridAdapter is a thin, read-only HTTP mapper for one debrid service.
 * It exposes what is ALREADY in the user's account (finished torrents /
 * downloads / cloud storage) and turns an item into a direct link on demand.
 *
 * Out of scope, by design — do not add:
 *   - adding torrents/magnets/links to the account
 *   - searching indexers or any third-party catalog
 *   - any other "find content" functionality
 *
 * Shared behaviour (audio filtering, credential checks, tag probing, mapping
 * to the generic SourceProvider interface) lives in the bridge, ./index.ts.
 * Link caching and re-resolution on expiry live in ../resolve-cache.ts and
 * apply to every provider.
 *
 * Debrid links are always proxied by the server: they act as bearer
 * credentials and are frequently bound to the requesting IP.
 */

import type { CallOptions, DeviceFlowHandler, ProviderContext, ResolveOptions } from '../types.js';

export interface DebridAdapterDefinition {
  /** Provider id, kebab-case, e.g. "real-debrid". Persisted; never rename. */
  id: string;
  /** Display name, e.g. "Real-Debrid". */
  name: string;
  /** Page where users find their API key. Shown as help text in Settings. */
  apiKeyUrl: string;
  /**
   * Extra secret config keys the adapter manages itself (OAuth access/refresh
   * tokens, client credentials from a device flow). They are hidden from the
   * UI and written via ctx.updateSecrets() or a completed device flow.
   */
  managedSecrets?: readonly string[];
  /** OAuth device / PIN flow, where the service officially supports one ("Log in with …"). */
  deviceFlow?: DeviceFlowHandler;
  /** Shown under the "Log in with …" button. */
  deviceLoginHelp?: string;
  /**
   * Fallback link lifetime when the service doesn't report one. Links are
   * re-resolved shortly before this elapses. Default: 1 hour.
   */
  defaultLinkTtlMs?: number;
  /**
   * Build the adapter. `credentials` holds `apiKey` and any managedSecrets that
   * are set; at least one credential is guaranteed to be present.
   * Must not do network I/O.
   */
  create(credentials: DebridCredentials, ctx: ProviderContext): DebridAdapter;
}

export type DebridCredentials = Readonly<Record<string, string>> & { readonly apiKey?: string };

export interface DebridAdapter {
  /** Validate credentials and report account status. Throw ProviderError('auth') on bad keys. */
  testConnection(opts: CallOptions): Promise<DebridAccountInfo>;

  /**
   * Enumerate files in the user's account. May yield non-audio files; the
   * bridge filters them out. Only completed/available items should be yielded.
   */
  listFiles(opts: CallOptions): AsyncIterable<DebridFile>;

  /**
   * Turn a file into a direct, streamable link (e.g. Real-Debrid "unrestrict",
   * TorBox "requestdl"). Throw ProviderError('not_found') if the item was
   * removed from the account.
   */
  resolveLink(fileId: string, opts: ResolveOptions): Promise<DebridResolvedLink>;
}

export interface DebridFile {
  /** Stable id within the account, e.g. `${torrentId}:${fileId}`. */
  id: string;
  name: string;
  /** '/'-separated path; usually `<torrent or folder name>/<path inside it>`. */
  path: string;
  size: number;
  modifiedAt?: Date;
}

export interface DebridResolvedLink {
  url: string;
  expiresAt?: Date;
  headers?: Record<string, string>;
  mimeType?: string;
  size?: number;
}

export interface DebridAccountInfo {
  username?: string;
  premium: boolean;
  premiumUntil?: Date;
  /** Human-readable plan name, e.g. "Premium", "Pro". */
  plan?: string;
}
