/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Overtone source provider plugin interface
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A *plugin* is code that knows how to talk to one kind of source (a local
 * folder, a Subsonic server, a debrid service). A *source* is a configured
 * instance of a plugin; users may add the same plugin several times.
 *
 *   ProviderPlugin ──create(config, ctx)──▶ SourceProvider (one per source)
 *
 * A provider does exactly two things:
 *   1. listLibrary()   — enumerate audio files that ALREADY EXIST in the source
 *   2. resolveStream() — turn one of those files into something playable
 *
 * Deliberately absent: any way to search for, request, or add content to a
 * source. Overtone plays what the user already has. Do not extend this
 * interface with "add"/"search"/"download" capabilities.
 *
 * Providers run on the server only. They never talk to clients; the streaming
 * layer decides whether to proxy or redirect (see ResolvedStream.redirectSafe).
 * Providers must not read process.env or the database directly — everything
 * they need comes from their validated config and the ProviderContext.
 */

import type { ConfigSchema, ConfigValues } from '@overtone/shared';

// ── Manifest ────────────────────────────────────────────────────────────────

export type ProviderCategory = 'local' | 'server' | 'public' | 'debrid';

export interface ProviderManifest {
  /** Stable, kebab-case, globally unique. Persisted in the DB; never rename. */
  id: string;
  /** Human-readable name for Settings > Sources. */
  name: string;
  /** One sentence shown in the "Add source" picker. */
  description: string;
  category: ProviderCategory;
  /** Declarative settings form; validated before create() is called. */
  configSchema: ConfigSchema;
  capabilities?: ProviderCapabilities;
  /** Supports an OAuth device / PIN flow (see DeviceFlowHandler). */
  deviceFlow?: DeviceFlowHandler;
}

/** Static capability flags, advertised to clients so the UI can adapt. */
export interface ProviderCapabilities {
  /** Instances implement `watch()`. */
  watch?: boolean;
  /** Instances implement `testConnection()`. */
  testConnection?: boolean;
  /**
   * resolveStream() can produce URLs/headers that contain no credentials, so the
   * per-source "redirect" stream mode is meaningful. Individual resolutions
   * still opt in via ResolvedStream.redirectSafe.
   */
  redirectable?: boolean;
}

// ── Plugin & instance ───────────────────────────────────────────────────────

export interface ProviderPlugin<C extends ConfigValues = ConfigValues> {
  manifest: ProviderManifest;
  /**
   * Build a provider instance for one source. `config` has already passed
   * validateConfig(manifest.configSchema) and has secrets decrypted and merged
   * in. Must be cheap and must not perform network I/O — do that lazily.
   */
  create(config: C, ctx: ProviderContext): SourceProvider;
}

export interface SourceProvider {
  /**
   * Enumerate every audio file currently in the source. Called by the scanner
   * on a schedule and on demand; the scanner diffs results by `SourceFile.id`.
   * Implementations should stream results (paginate lazily) rather than build
   * one large array, and must honour `opts.signal`.
   *
   * Only yield audio files (use `isAudioFile` from @overtone/shared).
   */
  listLibrary(opts: ListOptions): AsyncIterable<SourceFile>;

  /**
   * Resolve a file to a playable location. Called at play time (results may be
   * cached by the streaming layer until `expiresAt`). Throw
   * ProviderError('not_found') if the file no longer exists.
   */
  resolveStream(fileId: string, opts: ResolveOptions): Promise<ResolvedStream>;

  /** Optional: cheap check used by Settings > Sources "Test connection". */
  testConnection?(opts: CallOptions): Promise<ConnectionTestResult>;

  /**
   * Optional: read embedded tags for a file. Implement when the provider can
   * do so more efficiently than the scanner's generic fallback (which probes
   * the head of the resolved stream with HTTP range requests).
   */
  readTags?(fileId: string, opts: CallOptions): Promise<FileTags | null>;

  /**
   * Optional: push change notifications (e.g. a filesystem watcher). The
   * scanner reacts by re-listing (debounced), so `onChange` may be coarse.
   */
  watch?(onChange: (change: LibraryChange) => void): Disposable;

  /** Optional: release resources (watchers, sockets) when a source is removed/reconfigured. */
  dispose?(): Promise<void>;
}

// ── Data shapes ─────────────────────────────────────────────────────────────

export interface SourceFile {
  /**
   * Provider-chosen, opaque, STABLE identifier for this file within the source.
   * e.g. a relative path (LocalFolder), song id (Subsonic), `torrentId:fileIdx` (debrid).
   * Max 1024 chars. Must survive rescans or the file is treated as removed+added.
   */
  id: string;
  /** File name including extension, e.g. "01 - Song.flac". */
  name: string;
  /** Size in bytes (0 if unknown). */
  size: number;
  /**
   * Logical path within the source, '/'-separated, including the file name,
   * e.g. "Artist/Album (2001)/01 - Song.flac". Used for filename-based matching
   * and folder coherence, so preserve the original hierarchy when possible.
   */
  path: string;
  mimeType?: string;
  /** Last modification time; lets the scanner skip unchanged files. */
  modifiedAt?: Date;
  durationMs?: number;
  /** Tags the provider already knows (Subsonic, Internet Archive). Partial is fine. */
  tags?: FileTags;
}

/** Normalized subset of embedded tags the matcher uses. All optional. */
export interface FileTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  discTotal?: number;
  year?: number;
  genre?: string[];
  durationMs?: number;
  /** MusicBrainz IDs, if the file was tagged with Picard or similar. */
  musicbrainz?: {
    recordingId?: string;
    trackId?: string;
    releaseId?: string;
    releaseGroupId?: string;
    artistId?: string;
    albumArtistId?: string;
  };
}

export interface ResolvedStream {
  /**
   * Where to read the bytes from:
   *  - `file:///abs/path`  — served from disk by the streaming layer (with Range support)
   *  - `http(s)://…`       — proxied, or redirected to when allowed
   */
  url: string;
  /** Headers the server must send upstream (e.g. Authorization). Never forwarded to clients. */
  headers?: Record<string, string>;
  /** When `url` stops working. The streaming layer re-resolves shortly before this. */
  expiresAt?: Date;
  /**
   * True only if `url` + `headers` contain NO credentials or account-identifying
   * tokens, so handing the URL to a client is acceptable. Defaults to false.
   * Even when true, redirect only happens if the source's streamMode is 'redirect'.
   */
  redirectSafe?: boolean;
  mimeType?: string;
  size?: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Human-readable, must not contain secrets. */
  message: string;
  /** Non-sensitive account details, e.g. { username, premiumUntil }. */
  details?: Record<string, string>;
}

export type LibraryChange =
  | { kind: 'added' | 'changed'; fileId: string }
  | { kind: 'removed'; fileId: string }
  /** Something changed but the provider can't say what — rescan everything. */
  | { kind: 'unknown' };

export interface Disposable {
  dispose(): void;
}

export interface CallOptions {
  signal: AbortSignal;
}

export interface ListOptions extends CallOptions {
  /**
   * Hint: the time of the last successful scan. Providers that support
   * incremental listing may use it; others ignore it and list everything.
   * When used, the provider must still yield every file it knows about, or the
   * scanner would treat omitted files as removed — so incremental providers
   * should only use this to skip *expensive* per-file work (e.g. tag lookups).
   */
  lastScanAt?: Date;
}

export interface ResolveOptions extends CallOptions {
  /**
   * Set when a previously resolved URL failed upstream (401/403/404/410).
   * Providers with their own caches must bypass them.
   */
  forceRefresh?: boolean;
}

// ── Device / PIN flow ───────────────────────────────────────────────────────

/**
 * OAuth device-code or PIN style login, for services that offer it as an
 * alternative to pasting an API key. Credentials produced by `poll` are stored
 * as encrypted secrets on the source (via the caller), never sent to clients.
 */
export interface DeviceFlowHandler {
  start(ctx: DeviceFlowContext): Promise<DeviceFlowStart>;
  /** Called repeatedly (no faster than `intervalSeconds`) until not pending. */
  poll(handle: string, ctx: DeviceFlowContext): Promise<DeviceFlowPoll>;
}

export interface DeviceFlowContext extends CallOptions {
  fetch: ProviderFetch;
  logger: ProviderLogger;
}

export interface DeviceFlowStart {
  /** Opaque server-side state for poll(); never sent to clients. */
  handle: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: Date;
  intervalSeconds: number;
}

export type DeviceFlowPoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'denied' }
  /** `secrets` are merged into the source's secret config fields. */
  | { status: 'complete'; secrets: Record<string, string> };

// ── Context given to providers ──────────────────────────────────────────────

export interface ProviderContext {
  /** The source's id (for logging/namespacing only). */
  sourceId: string;
  logger: ProviderLogger;
  /**
   * fetch with sane defaults: timeout, retries on 429/503 with backoff, the
   * Overtone User-Agent, and logging that never includes headers or query
   * strings. Providers should use this rather than the global fetch so tests
   * can inject mocks.
   */
  fetch: ProviderFetch;
  /** Small persistent key/value store scoped to this source (cursors, ETags…). */
  state: ProviderStateStore;
  /**
   * Persist updated secrets, e.g. rotated OAuth access/refresh tokens. Only
   * keys declared as `secret` fields in the manifest are accepted.
   */
  updateSecrets(patch: Record<string, string>): Promise<void>;
}

export type ProviderFetch = (input: string | URL, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

export interface ProviderLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ProviderStateStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
