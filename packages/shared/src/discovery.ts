/**
 * Torrent source (indexer) configuration and discovery DTOs, shared by the
 * server and clients.
 *
 * A *torrent source* is a connection to a torrent indexer or an aggregator of
 * indexers (Prowlarr / Jackett). It is separate from a music *source* (see
 * api.ts) and from debrid providers: indexer credentials and configuration are
 * stored and managed on their own.
 */

export type TorrentSourceKind = 'torznab' | 'prowlarr' | 'jackett';

/** An indexer reachable through a Prowlarr/Jackett connection, or the single "default" indexer of a direct source. */
export interface TorrentIndexerInfoDto {
  /** Stable id within the connection; 'default' for a direct Torznab source. */
  id: string;
  name: string;
  enabled: boolean;
  /** Torznab category ids this indexer reports, e.g. "3000" (Audio). */
  categories: string[];
}

/** GET /api/torrent-sources — configured indexer connections. The API key is never included. */
export interface TorrentSourceDto {
  id: string;
  kind: TorrentSourceKind;
  name: string;
  enabled: boolean;
  /** The normalized search endpoint (see discovery/manager.ts). */
  url: string;
  /** Whether an API key is stored (its value is never returned). */
  apiKeySet: boolean;
  /** Indexers discovered from a Prowlarr/Jackett connection (enabled state included). */
  indexers: TorrentIndexerInfoDto[];
  lastError: string | null;
}

/** POST /api/torrent-sources and PATCH /api/torrent-sources/:id. */
export interface TorrentSourceWriteDto {
  kind?: TorrentSourceKind;
  name?: string;
  enabled?: boolean;
  url?: string;
  /** Set a new API key; omit to keep the stored value; `null` to clear it. */
  apiKey?: string | null;
  /** Enable/disable discovered indexers (Prowlarr/Jackett). */
  indexers?: TorrentIndexerInfoDto[];
}

/** Result of a "Test connection" call (also carries discovered indexers when applicable). */
export interface TorrentSourceTestResultDto {
  ok: boolean;
  message: string;
  /** Indexers the connection exposes (Prowlarr/Jackett), ready to import. */
  indexers?: TorrentIndexerInfoDto[];
}

// ── Discovery search ("Find sources") ───────────────────────────────────────

export type DiscoverScope = 'track' | 'album';

export type DiscoverReleaseType = 'track' | 'album' | 'ep' | 'single' | 'compilation' | 'discography' | 'unknown';

/** The metadata a discovery search targets (echoed back in responses). */
export interface DiscoverQueryDto {
  scope: DiscoverScope;
  title: string;
  artist?: string;
  album?: string;
  year?: number;
}

/** Explicit metadata override in a discovery request (scope comes from `type`). */
export interface DiscoverQueryOverrideDto {
  title: string;
  artist?: string;
  album?: string;
  year?: number;
}

/** POST /api/discover. Exactly one of trackId / albumId / query identifies the target. */
export interface DiscoverRequestDto {
  trackId?: number;
  albumId?: number;
  /** Explicit metadata (used by tests and manual search). */
  query?: DiscoverQueryOverrideDto;
  type?: DiscoverScope;
  limit?: number;
}

/** One indexer a result was found on (dedup keeps every origin). */
export interface DiscoverSourceDto {
  /** Torrent source id. */
  id: string;
  /** Indexer display name. */
  name: string;
}

/** A debrid provider this release is already cached on. */
export type DiscoverCachedStatus = 'cached' | 'uncached' | 'unavailable' | 'unknown';

export interface DiscoverCachedDto {
  providerId: string;
  providerName: string;
  status: DiscoverCachedStatus;
}

/** One ranked release candidate. */
export interface DiscoverResultDto {
  key: string;
  title: string;
  artist: string | null;
  album: string | null;
  year: number | null;
  format: string | null;
  quality: string | null;
  type: DiscoverReleaseType;
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  files: number | null;
  sources: DiscoverSourceDto[];
  magnet: string | null;
  infoHash: string | null;
  downloadUrl: string | null;
  /** 0..1 confidence; higher ranks first. */
  score: number;
  /** Human-readable explanation of the ranking. */
  reasons: string[];
  /** Connected debrid providers and their cached-availability status. */
  cached: DiscoverCachedDto[];
}

export interface DiscoverErrorDto {
  sourceId: string;
  name: string;
  message: string;
}

export interface DiscoverResponseDto {
  query: DiscoverQueryDto;
  results: DiscoverResultDto[];
  /** Indexers that were searched but failed or timed out. */
  errors: DiscoverErrorDto[];
}

// ── Debrid retrieval ("add to debrid") ──────────────────────────────────────

export interface DebridProviderDto {
  sourceId: string;
  name: string;
  providerId: string;
  /** Whether the provider supports retrieval (check-cached / add-magnet). */
  retrieval: boolean;
}

/** Lifecycle of a persistent, backend-managed retrieval job. */
export type RetrievalJobStatus = 'queued' | 'processing' | 'complete' | 'failed' | 'canceled';

/** One debrid retrieval job (persisted server-side and resumed after restart). */
export interface RetrievalJobDto {
  id: string;
  /** The debrid source id this was submitted to. */
  providerId: string;
  /** Provider display name, kept even if the source is later removed. */
  providerName: string;
  status: RetrievalJobStatus;
  /** Lowercase hex info hash, when known (always present for valid magnets). */
  infohash: string | null;
  /** Discovery metadata, for the activity view. */
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  size: number | null;
  /** 0..1 progress when the provider reports it; null otherwise. */
  progress: number | null;
  /** Last error message (failed jobs). */
  error: string | null;
  /** Whether the job's files have been processed into the library (next increment). */
  filesProcessed: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** POST /api/retrieval/jobs — create (or reuse) a retrieval job for a magnet. */
export interface CreateRetrievalJobRequestDto {
  /** Debrid source id. */
  providerId: string;
  magnet: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  size?: number;
}

export interface CreateRetrievalJobResultDto {
  job: RetrievalJobDto;
  /** True when this re-used an existing active job for the same provider + infohash. */
  duplicate: boolean;
}

// ── Retrieval job files (playback) ──────────────────────────────────────────

/** One file belonging to a completed retrieval job. */
export interface RetrievalJobFileDto {
  /** The file id within the job (used for resolution). */
  id: string;
  name: string;
  path: string;
  size: number;
  mime: string | null;
  /** Whether this is a playable audio file. */
  playable: boolean;
  /** The library track id, when the file has been imported and matched. */
  trackId: number | null;
}

/** GET /api/retrieval/jobs/:id/files — the files of one job, plus their library tracks. */
export interface RetrievalJobFilesDto {
  jobId: string;
  /** True once the job's audio files have been imported into the library. */
  imported: boolean;
  files: RetrievalJobFileDto[];
  /** The library tracks for the playable files, in album order (for the player). */
  tracks: import('./api.js').TrackDto[];
}

// ── Automatic playback (Play on a catalogue album) ──────────────────────────

/** Result of pressing Play on a catalogue album: automatic source selection + retrieval. */
export type PlayCatalogueResultDto =
  | { status: 'retrieving'; job: RetrievalJobDto; selected: DiscoverResultDto }
  | { status: 'no_cached_source'; candidates: DiscoverResultDto[] }
  | { status: 'no_source' };

// ── Discovery preferences ───────────────────────────────────────────────────

export interface DiscoveryPreferencesDto {
  /** Preferred audio format; 'any' leaves the choice to ranking. */
  preferredFormat: 'any' | 'flac' | 'mp3';
  /** Minimum acceptable bitrate (kbps) for lossy formats; null = no minimum. */
  minBitrateKbps: number | null;
  /** Preferred debrid source id for retrieval, or 'auto'. */
  preferredProvider: string;
  /** Remember the last provider used for retrieval. */
  rememberLastProvider: boolean;
  /** Give already-cached releases a small ranking advantage. */
  prioritizeCached: boolean;
  /** Hide releases that no connected provider has cached. */
  hideUncached: boolean;
  /** Default discovery scope when finding sources. */
  searchScope: 'auto' | 'track' | 'album';
}

export const DEFAULT_DISCOVERY_PREFERENCES: DiscoveryPreferencesDto = {
  preferredFormat: 'any',
  minBitrateKbps: null,
  preferredProvider: 'auto',
  rememberLastProvider: true,
  prioritizeCached: true,
  hideUncached: false,
  searchScope: 'auto',
};
