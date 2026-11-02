import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  createCore,
  type CoreApi,
  type CoverArtService,
  type Database,
  type DeviceLoginService,
  type LibraryRepo,
  type LibraryScanner,
  type Logger,
  type Matcher,
  type MatchWorker,
  type MusicBrainzApi,
  type ProviderRegistry,
  type ResolveCache,
  type SourceManager,
} from '@overtone/core';
import type { ScanStatusDto } from '@overtone/shared';
import { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import { deriveKey } from './crypto/keys.js';
import { SecretBox } from './crypto/secret-box.js';
import { coreDatabase, openDatabase, type Db } from './db/index.js';
import { EncryptedColumnSecretStore, FsBlobStore } from './platform.js';
import { createDefaultRegistry } from './providers/index.js';
import { StreamService } from './streaming/service.js';

export interface ServiceOverrides {
  db?: Db;
  registry?: ProviderRegistry;
  mb?: MusicBrainzApi;
  /** Outbound fetch for providers, proxying, probing and artwork. */
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The server = @overtone/core (library, sources, matching, scanning) plus the
 * parts only a multi-device server needs: accounts/tokens and the stream
 * proxy. Routes are thin HTTP adapters over `api` (CoreApi).
 */
export interface Services {
  config: Config;
  /** Raw better-sqlite3 handle (auth uses it synchronously). */
  db: Db;
  /** Core's async view of the same connection. */
  database: Database;
  auth: AuthService;
  registry: ProviderRegistry;
  sources: SourceManager;
  deviceLogins: DeviceLoginService;
  library: LibraryRepo;
  resolver: ResolveCache;
  mb: MusicBrainzApi;
  matcher: Matcher;
  scanner: LibraryScanner;
  matchWorker: MatchWorker;
  streams: StreamService;
  covers: CoverArtService;
  api: CoreApi;
  matchStatus(): Promise<ScanStatusDto['matching']>;
  /** Start scans, watchers and matching. Not called in route tests. */
  startBackground(): Promise<void>;
  close(): Promise<void>;
}

export function createServices(config: Config, logger: Logger, o: ServiceOverrides = {}): Services {
  const db = o.db ?? openDatabase(path.join(config.dataDir, 'overtone.db'));
  const database = coreDatabase(db);
  const now = o.now ?? Date.now;
  const registry = o.registry ?? createDefaultRegistry({ premiumizeClientId: config.premiumizeClientId });
  const auth = new AuthService(db, { masterKey: config.secretKey, multiUser: config.multiUser, now });
  const core = createCore({
    db: database,
    registry,
    secrets: new EncryptedColumnSecretStore(database, new SecretBox(deriveKey(config.secretKey, 'secrets'))),
    blobs: new FsBlobStore(config.dataDir),
    logger,
    version: config.version,
    contact: config.mbContact,
    clock: { now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), schedule: (ms, fn) => {
      const t = setTimeout(fn, ms).unref();
      return () => clearTimeout(t);
    } },
    ...(o.mb ? { mb: o.mb } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const streams = new StreamService({ sources: core.sources, resolver: core.resolver, logger, ...(o.fetch ? { fetch: o.fetch } : {}) });

  return {
    config,
    db,
    database,
    auth,
    registry,
    sources: core.sources,
    deviceLogins: core.deviceLogins,
    library: core.library,
    resolver: core.resolver,
    mb: core.mb,
    matcher: core.matcher,
    scanner: core.scanner,
    matchWorker: core.matchWorker,
    streams,
    covers: core.covers,
    api: core.api,
    matchStatus: () => core.api.matchStatus(),
    async startBackground() {
      await ensureDefaultMusicSource(config, core.sources, logger);
      await core.start({ intervalMinutes: config.scanIntervalMinutes, scanAll: true });
    },
    async close() {
      // core.close() closes the async wrapper, which closes the shared handle.
      await core.close();
    },
  };
}

/** First boot convenience: a "Music" LocalFolder source for the Docker /music mount. */
async function ensureDefaultMusicSource(config: Config, sources: SourceManager, logger: Logger): Promise<void> {
  if (!config.musicDir || (await sources.list()).length > 0) return;
  if (!existsSync(config.musicDir) || !statSync(config.musicDir).isDirectory()) return;
  await sources.create({ providerId: 'local-folder', name: 'Music', config: { path: config.musicDir } });
  logger.info({ path: config.musicDir }, 'created default music folder source');
}
