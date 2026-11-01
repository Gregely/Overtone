/**
 * REST API data transfer objects shared by server and clients.
 * Grows with each stage.
 */
import type { ConfigSchema, PublicSourceConfig } from './config-schema.js';

export type StreamMode = 'proxy' | 'redirect';

export interface ProviderCapabilitiesDto {
  /** Provider can push change notifications (e.g. filesystem watcher). */
  watch: boolean;
  /** Provider supports a "Test connection" check. */
  testConnection: boolean;
  /** Provider supports an OAuth device/PIN flow in addition to API keys. */
  deviceFlow: boolean;
  /** Provider can return redirect-safe URLs, so `redirect` stream mode is meaningful. */
  redirectable: boolean;
}

/** GET /api/providers — the plugin catalog shown in "Add source". */
export interface ProviderManifestDto {
  id: string;
  name: string;
  description: string;
  category: 'local' | 'server' | 'public' | 'debrid';
  configSchema: ConfigSchema;
  capabilities: ProviderCapabilitiesDto;
}

/** GET /api/sources — configured instances. Secrets are never included. */
export interface SourceDto {
  id: string;
  providerId: string;
  name: string;
  enabled: boolean;
  /** Lower plays first when a track exists in several sources. */
  priority: number;
  streamMode: StreamMode;
  config: PublicSourceConfig;
  lastScanAt: string | null;
  lastError: string | null;
  fileCount: number;
}

export interface ConnectionTestResultDto {
  ok: boolean;
  message: string;
  /** Non-sensitive account details, e.g. username / premium expiry. */
  details?: Record<string, string>;
}

/** Device/PIN flow handshake returned to the client to display. */
export interface DeviceFlowStartDto {
  flowId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export type DeviceFlowPollDto =
  | { status: 'pending' }
  | { status: 'complete' }
  | { status: 'expired' }
  | { status: 'denied' };

/** Error envelope for every non-2xx response. */
export interface ApiErrorDto {
  error: {
    code: string;
    message: string;
    /** Per-field validation messages, for config forms. */
    fields?: Record<string, string>;
  };
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface UserDto {
  id: number;
  username: string;
  isAdmin: boolean;
}

/** GET /api/auth/status — public; tells a fresh client whether to show first-run setup. */
export interface AuthStatusDto {
  setupRequired: boolean;
  multiUser: boolean;
  version: string;
}

/** Returned by setup, login and refresh. Store both tokens securely on the client. */
export interface AuthTokensDto {
  accessToken: string;
  /** ISO timestamp. Refresh shortly before this. */
  accessTokenExpiresAt: string;
  /** Single-use: every refresh returns a new one; reusing an old one revokes the session. */
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: UserDto;
}

export interface LoginRequestDto {
  username: string;
  password: string;
  /** Shown in a future "active sessions" list. */
  deviceName?: string;
}

// ── Library ─────────────────────────────────────────────────────────────────

export interface PageDto<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export type MatchStatus = 'pending' | 'matched' | 'needs_review' | 'unmatched' | 'manual';

/** Which configured source a track can be played from (the "source badge"). */
export interface SourceBadgeDto {
  sourceId: string;
  sourceName: string;
  providerId: string;
  category: ProviderManifestDto['category'];
}

export interface ArtistRefDto {
  id: number;
  name: string;
}

export interface ArtistDto extends ArtistRefDto {
  mbid: string | null;
  albumCount: number;
  trackCount: number;
}

export interface AlbumDto {
  id: number;
  title: string;
  mbid: string | null;
  artist: ArtistRefDto | null;
  artistCredit: string;
  year: number | null;
  /** Relative URL (prefix with the server URL). Carries its own short-lived token; usable in <img>. */
  coverUrl: string | null;
  trackCount: number;
}

export interface TrackDto {
  id: number;
  title: string;
  artistCredit: string;
  artist: ArtistRefDto | null;
  album: { id: number; title: string } | null;
  discNo: number | null;
  trackNo: number | null;
  durationMs: number | null;
  mbid: string | null;
  coverUrl: string | null;
  sources: SourceBadgeDto[];
}

export interface AlbumDetailDto {
  album: AlbumDto;
  tracks: TrackDto[];
}

export interface ArtistDetailDto {
  artist: ArtistDto;
  albums: AlbumDto[];
}

export interface HomeDto {
  recentlyAdded: AlbumDto[];
  random: AlbumDto[];
  stats: { artists: number; albums: number; tracks: number; pendingMatches: number };
}

export interface SearchResultDto {
  artists: ArtistDto[];
  albums: AlbumDto[];
  tracks: TrackDto[];
}

// ── Playback ────────────────────────────────────────────────────────────────

/** POST /api/stream-urls */
export interface StreamUrlsRequestDto {
  trackIds: number[];
  /** Prefer this source when a track is available from several. */
  preferSourceId?: string;
}

export interface StreamUrlDto {
  trackId: number;
  /** Relative URL with an embedded short-lived token; set it directly as <audio src>. */
  url: string;
  expiresAt: string;
  source: SourceBadgeDto;
  mimeType: string | null;
}

export interface StreamUrlsResponseDto {
  items: StreamUrlDto[];
  /** Track ids with no playable source right now. */
  unavailable: number[];
}

// ── Matching ────────────────────────────────────────────────────────────────

/** A library file and its current MusicBrainz match state ("fix match" UI). */
export interface LibraryFileDto {
  id: number;
  sourceId: string;
  path: string;
  name: string;
  size: number;
  durationMs: number | null;
  tags: Record<string, unknown> | null;
  matchStatus: MatchStatus;
  matchScore: number | null;
  trackId: number | null;
  candidates: MatchCandidateDto[];
}

export interface MatchCandidateDto {
  recordingMbid: string;
  releaseMbid: string | null;
  title: string;
  artistCredit: string;
  releaseTitle: string | null;
  releaseDate: string | null;
  discNo: number | null;
  trackNo: number | null;
  durationMs: number | null;
  score: number;
}

export interface ScanStatusDto {
  running: { sourceId: string; startedAt: string; filesSeen: number } | null;
  queued: string[];
  matching: { pending: number; active: boolean };
  lastReports: ScanReportDto[];
}

export interface ScanReportDto {
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  error: string | null;
}

/** POST /api/sources and PATCH /api/sources/:id. Secrets: omit/"" = keep, null = clear. */
export interface SourceWriteDto {
  providerId?: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  streamMode?: StreamMode;
  config?: Record<string, unknown>;
}

/** GET /api/match/releases — for album-level "fix match". */
export interface ReleaseCandidateDto {
  mbid: string;
  title: string;
  artistCredit: string;
  date: string | null;
  country: string | null;
  trackCount: number | null;
  primaryType: string | null;
  status: string | null;
}

/** POST /api/library/files/:id/match */
export interface FileMatchRequestDto {
  recordingMbid: string;
  /** Pin a specific release; otherwise the best-fitting release of the recording is chosen. */
  releaseMbid?: string;
}
