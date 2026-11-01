import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ScanStatusDto } from '@overtone/shared';
import { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import { deriveKey } from './crypto/keys.js';
import { SecretBox } from './crypto/secret-box.js';
import { openDatabase, type Db } from './db/index.js';
import type { BaseLogger } from './http/redact.js';
import { LibraryRepo } from './library/repo.js';
import { LibraryScanner, MatchWorker } from './library/scanner.js';
import { CoverArtService } from './metadata/coverart/service.js';
import { Matcher } from './metadata/matcher/matcher.js';
import { MusicBrainzClient, mbUserAgent } from './metadata/musicbrainz/client.js';
import type { MusicBrainzApi } from './metadata/musicbrainz/types.js';
import { createDefaultRegistry } from './providers/index.js';
import type { ProviderRegistry } from './providers/registry.js';
import { ResolveCache } from './providers/resolve-cache.js';
import { DeviceLoginService } from './sources/device-login.js';
import { SourceManager } from './sources/manager.js';
import { StreamService } from './streaming/service.js';

export interface ServiceOverrides {
  db?: Db;
  registry?: ProviderRegistry;
  mb?: MusicBrainzApi;
  /** Outbound fetch for providers, proxying, probing and artwork. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Services {
  config: Config;
  db: Db;
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
  matchStatus(): ScanStatusDto['matching'];
  /** Start scans, watchers and matching. Not called in route tests. */
  startBackground(): void;
  close(): Promise<void>;
}

export function createServices(
  config: Config,
  logger: BaseLogger & { child(b: object): BaseLogger },
  o: ServiceOverrides = {},
): Services {
  const db = o.db ?? openDatabase(path.join(config.dataDir, 'overtone.db'));
  const now = o.now ?? Date.now;
  const userAgent = mbUserAgent(config.version, config.mbContact);
  const registry = o.registry ?? createDefaultRegistry({ premiumizeClientId: config.premiumizeClientId });
  const auth = new AuthService(db, { masterKey: config.secretKey, multiUser: config.multiUser, now });
  const sources = new SourceManager({
    db,
    registry,
    secretBox: new SecretBox(deriveKey(config.secretKey, 'secrets')),
    logger,
    userAgent,
    now,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const deviceLogins = new DeviceLoginService({ registry, logger, userAgent, now, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const library = new LibraryRepo(db, now);
  const resolver = new ResolveCache({ now });
  const mb = o.mb ?? new MusicBrainzClient({ db, userAgent, now, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const matcher = new Matcher(mb);
  const matchWorker = new MatchWorker(library, matcher, logger.child({ component: 'matcher' }));
  const scanner = new LibraryScanner({
    sources,
    library,
    resolver,
    logger: logger.child({ component: 'scanner' }),
    now,
    onTagged: () => matchWorker.kick(),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const streams = new StreamService({ sources, resolver, logger, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const covers = new CoverArtService({
    dataDir: config.dataDir,
    library,
    sources,
    logger,
    userAgent,
    now,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });

  // Config changes invalidate cached stream links for that source.
  sources.onChange((e) => resolver.invalidate(e.sourceId));

  return {
    config,
    db,
    auth,
    registry,
    sources,
    deviceLogins,
    library,
    resolver,
    mb,
    matcher,
    scanner,
    matchWorker,
    streams,
    covers,
    matchStatus: () => ({ pending: library.pendingMatchCount(), active: matchWorker.active, ...library.reviewCounts() }),
    startBackground() {
      ensureDefaultMusicSource(config, sources, logger);
      scanner.start(config.scanIntervalMinutes);
      matchWorker.kick();
    },
    async close() {
      matchWorker.stop();
      await scanner.stop();
      await sources.disposeAll();
      db.close();
    },
  };
}

/** First boot convenience: a "Music" LocalFolder source for the Docker /music mount. */
function ensureDefaultMusicSource(config: Config, sources: SourceManager, logger: BaseLogger): void {
  if (!config.musicDir || sources.list().length > 0) return;
  if (!existsSync(config.musicDir) || !statSync(config.musicDir).isDirectory()) return;
  sources.create({ providerId: 'local-folder', name: 'Music', config: { path: config.musicDir } });
  logger.info({ path: config.musicDir }, 'created default music folder source');
}
