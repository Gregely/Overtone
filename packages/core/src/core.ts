/**
 * Composition root: wires Overtone's domain services from injected platform
 * pieces. The server calls this with better-sqlite3, an encrypted-column
 * secret store and a filesystem artwork cache; the Android app with
 * Capacitor SQLite, Keystore-backed secrets and native HTTP.
 */
import { CoreApi } from './api/core-api.js';
import type { Database } from './db/database.js';
import { TorrentSourceManager } from './discovery/manager.js';
import { createDefaultTorrentRegistry, type TorrentIndexerRegistry } from './discovery/registry.js';
import { DiscoveryService } from './discovery/service.js';
import { LibraryRepo } from './library/repo.js';
import { LibraryScanner, MatchWorker } from './library/scanner.js';
import { silentLogger, type Logger } from './logging.js';
import { CoverArtService } from './metadata/coverart/service.js';
import { Matcher } from './metadata/matcher/matcher.js';
import { MusicBrainzClient, mbUserAgent } from './metadata/musicbrainz/client.js';
import type { MusicBrainzApi } from './metadata/musicbrainz/types.js';
import { systemClock, type BlobStore, type Clock, type HttpFetch, type SecretStore } from './platform/types.js';
import { createDefaultRegistry, type BuiltinOptions } from './providers/index.js';
import type { ProviderRegistry } from './providers/registry.js';
import { DebridService } from './providers/debrid/service.js';
import { PreferencesService } from './preferences.js';
import { ResolveCache } from './providers/resolve-cache.js';
import { DeviceLoginService } from './sources/device-login.js';
import { SourceManager } from './sources/manager.js';

export interface CoreOptions {
  db: Database;
  secrets: SecretStore;
  /** Where torrent indexer API keys live — a separate store from music sources. */
  torrentSecrets: SecretStore;
  blobs: BlobStore;
  /** Defaults to the built-in providers. */
  registry?: ProviderRegistry;
  /** Defaults to the built-in torrent indexer protocols (Torznab). */
  torrentRegistry?: TorrentIndexerRegistry;
  builtins?: BuiltinOptions;
  /** Outbound HTTP for providers, MusicBrainz, artwork and tag probing. */
  fetch?: HttpFetch;
  clock?: Clock;
  logger?: Logger;
  /** App version and contact, for the MusicBrainz User-Agent. */
  version: string;
  contact: string;
  /** Replace the MusicBrainz client (tests). */
  mb?: MusicBrainzApi;
  /** MusicBrainz WS/2 base URL (tests point this at a fake). */
  musicbrainzUrl?: string;
  /** Cover Art Archive base URL (tests). */
  coverArtUrl?: string;
  /** Server mode only: sources may use redirect streaming. */
  allowRedirect?: boolean;
  /** Notified when background work (scan/match) starts, progresses or stops. */
  onActivity?: () => void;
  /** Standalone: extract embedded cover art for unmatched albums after scans/matching. */
  prefetchEmbeddedArtwork?: boolean;
}

export interface OvertoneCore {
  db: Database;
  registry: ProviderRegistry;
  torrentSources: TorrentSourceManager;
  discovery: DiscoveryService;
  debrid: DebridService;
  preferences: PreferencesService;
  sources: SourceManager;
  deviceLogins: DeviceLoginService;
  library: LibraryRepo;
  resolver: ResolveCache;
  mb: MusicBrainzApi;
  matcher: Matcher;
  scanner: LibraryScanner;
  matchWorker: MatchWorker;
  covers: CoverArtService;
  api: CoreApi;
  secrets: SecretStore;
  blobs: BlobStore;
  clock: Clock;
  userAgent: string;
  /** True while scanning or matching. */
  readonly busy: boolean;
  /**
   * Start background work: resume interrupted scans and pending matches,
   * then (optionally) scan everything and rescan every `intervalMinutes`.
   */
  start(opts?: { intervalMinutes?: number; scanAll?: boolean }): Promise<void>;
  /** Stop background work (keeps the persisted queue for next time). */
  pause(): Promise<void>;
  close(): Promise<void>;
}

export function createCore(o: CoreOptions): OvertoneCore {
  const clock = o.clock ?? systemClock;
  const now = () => clock.now();
  const logger = o.logger ?? silentLogger;
  const userAgent = mbUserAgent(o.version, o.contact);
  const registry = o.registry ?? createDefaultRegistry(o.builtins);
  const fetchOpt = o.fetch ? { fetch: o.fetch } : {};

  const sources = new SourceManager({
    db: o.db,
    registry,
    secrets: o.secrets,
    logger,
    userAgent,
    clock,
    ...(o.allowRedirect === false ? { allowRedirect: false } : {}),
    ...fetchOpt,
  });
  const torrentRegistry = o.torrentRegistry ?? createDefaultTorrentRegistry();
  const torrentSources = new TorrentSourceManager({
    db: o.db,
    registry: torrentRegistry,
    secrets: o.torrentSecrets,
    logger,
    userAgent,
    clock,
    ...fetchOpt,
  });
  const debrid = new DebridService({ sources, registry, logger, clock });
  const preferences = new PreferencesService(o.db);
  const discovery = new DiscoveryService({ sources: torrentSources, logger, clock, debrid });
  const deviceLogins = new DeviceLoginService({ registry, logger, userAgent, now, ...fetchOpt });
  const library = new LibraryRepo(o.db, now);
  const resolver = new ResolveCache({ now });
  const mb =
    o.mb ??
    new MusicBrainzClient({ db: o.db, userAgent, now, sleep: (ms) => clock.sleep(ms), ...(o.musicbrainzUrl ? { baseUrl: o.musicbrainzUrl } : {}), ...fetchOpt });
  const matcher = new Matcher(mb);
  const matchWorker = new MatchWorker(library, matcher, logger.child({ component: 'matcher' }), 5 * 60_000, clock);
  let covers: CoverArtService;
  let prefetching: Promise<void> | null = null;
  const prefetch = () => {
    if (!o.prefetchEmbeddedArtwork || prefetching) return;
    prefetching = (async () => {
      while ((await covers.prefetchEmbedded()) > 0) {
        /* keep going */
      }
    })()
      .catch((err) => logger.warn({ error: (err as Error).message }, 'artwork prefetch failed'))
      .finally(() => {
        prefetching = null;
      });
  };
  matchWorker.onActivity = () => {
    if (!matchWorker.active) prefetch();
    o.onActivity?.();
  };
  const scanner = new LibraryScanner({
    sources,
    library,
    resolver,
    db: o.db,
    logger: logger.child({ component: 'scanner' }),
    clock,
    onTagged: () => matchWorker.kick(),
    ...(o.onActivity ? { onActivity: o.onActivity } : {}),
    ...fetchOpt,
  });
  covers = new CoverArtService({ blobs: o.blobs, library, sources, logger, userAgent, now, ...(o.coverArtUrl ? { baseUrl: o.coverArtUrl } : {}), ...fetchOpt });
  const api = new CoreApi({ registry, sources, torrentSources, discovery, debrid, preferences, deviceLogins, library, mb, matcher, scanner, matchWorker, covers });

  // Config changes invalidate cached stream links for that source.
  sources.onChange((e) => resolver.invalidate(e.sourceId));

  let started = false;
  return {
    db: o.db,
    registry,
    torrentSources,
    discovery,
    debrid,
    preferences,
    sources,
    deviceLogins,
    library,
    resolver,
    mb,
    matcher,
    scanner,
    matchWorker,
    covers,
    api,
    secrets: o.secrets,
    blobs: o.blobs,
    clock,
    userAgent,
    get busy() {
      return scanner.busy || matchWorker.active;
    },
    async start(opts = {}) {
      if (started) return;
      started = true;
      matchWorker.resume();
      await scanner.start(opts.intervalMinutes ?? 0, { scanAll: opts.scanAll ?? false });
      matchWorker.kick();
    },
    async pause() {
      started = false;
      matchWorker.stop();
      await scanner.stop();
      await matchWorker.idle();
    },
    async close() {
      started = false;
      matchWorker.stop();
      await scanner.stop();
      await matchWorker.idle().catch(() => undefined);
      await sources.disposeAll();
      discovery.close();
      await o.db.close();
    },
  };
}
