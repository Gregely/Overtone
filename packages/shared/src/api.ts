/**
 * REST API data transfer objects shared by server and clients.
 * Grows with each stage; stage 1 only covers provider/source discovery.
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
