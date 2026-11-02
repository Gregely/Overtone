/**
 * Debrid adapter interface.
 *
 * A DebridAdapter is a thin HTTP mapper for one debrid service. It lists what
 * is ALREADY in the user's account (finished torrents / downloads / cloud
 * storage) and turns an item into a direct link on demand. It is read-mostly:
 * the optional `checkCached` / `addMagnet` / `getStatus` methods exist solely
 * to let a user retrieve content they are authorised to access (their own
 * account), and are only ever called after explicit user selection.
 *
 * Debrid links are always proxied by the server: they act as bearer
 * credentials and are frequently bound to the requesting IP.
 */

import type { CallOptions, DeviceFlowHandler, ProviderContext, ResolveOptions } from '../types.js';

/** A torrent identifier for cache checks: a magnet URI and/or an info hash. */
export interface DebridTorrentRef {
  magnet?: string;
  infoHash?: string;
}

export interface DebridCachedFile {
  name: string;
  size: number;
}

export interface DebridCachedResult {
  cached: boolean;
  /** True when the provider could not give a definitive answer. */
  unknown?: boolean;
  /** Files the provider reports as cached (may be partial). */
  files?: DebridCachedFile[];
}

export interface DebridAddResult {
  /** Provider id for {@link DebridAdapter.getStatus}. */
  id: string;
  /** Human status string, e.g. "downloading", "finished". */
  status: string;
  /** True when the magnet was already cached and finished instantly. */
  instant?: boolean;
}

export type DebridTorrentStatus =
  | { status: 'processing'; progress: number | null }
  | { status: 'finished' }
  | { status: 'error'; message: string };

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
   * Whether the adapter supports retrieval (check-cached / add-magnet /
   * get-status) for "Find sources". When false, the UI greys the provider out.
   */
  retrieval?: boolean;
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

  /** Whether this magnet/infohash is already cached. Optional (not all providers expose it). */
  checkCached?(ref: DebridTorrentRef, opts: CallOptions): Promise<DebridCachedResult>;

  /** Batch cache check for multiple info hashes. Optional — providers without it fall back to per-hash checks. */
  checkCachedBatch?(infoHashes: string[], opts: CallOptions): Promise<Map<string, DebridCachedResult>>;

  /** Submit a user-selected magnet; returns an id for {@link getStatus}. Optional. */
  addMagnet?(magnet: string, opts: CallOptions): Promise<DebridAddResult>;

  /** Poll a submitted torrent's processing status. Optional. */
  getStatus?(id: string, opts: CallOptions): Promise<DebridTorrentStatus>;

  /**
   * Job-scoped file listing: the files of ONE submitted torrent (by provider
   * id), without enumerating the whole account. Optional — the retrieval
   * streaming increment uses this instead of `listFiles`. File `id`s are
   * stable within the torrent and are passed to {@link resolveFileLink}.
   */
  listTorrentFiles?(remoteId: string, opts: CallOptions): Promise<DebridFile[]>;

  /**
   * Job-scoped stream resolution: turn one file (by its `id` from
   * {@link listTorrentFiles}) within a submitted torrent into a direct link.
   * Optional — the retrieval streaming increment uses this instead of
   * `resolveLink`.
   */
  resolveFileLink?(remoteId: string, fileId: string, opts: ResolveOptions): Promise<DebridResolvedLink>;
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
