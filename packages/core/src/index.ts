/**
 * @overtone/core — Overtone's domain logic without a web framework or Node-only
 * APIs. Runs on the server (behind Fastify) and inside the app (standalone mode).
 */
export * from './core.js';
export * from './api/core-api.js';
export * from './db/database.js';
export * from './db/migrate.js';
export { migrations } from './db/migrations.js';
export * from './db/sqljs.js';
export * from './platform/types.js';
export * from './errors.js';
export * from './logging.js';
export * from './crypto.js';

export * from './providers/index.js';
export * from './providers/http.js';
export * from './providers/fetch.js';
export { subsonicPlugin } from './providers/subsonic/index.js';
export { createInternetArchivePlugin } from './providers/internet-archive/index.js';

export * from './metadata/tags.js';
export * from './metadata/probe.js';
export * from './metadata/matcher/normalize.js';
export * from './metadata/matcher/filename.js';
export * from './metadata/matcher/matcher.js';
export * from './metadata/musicbrainz/client.js';
export type * from './metadata/musicbrainz/types.js';
export * from './metadata/coverart/service.js';

export * from './library/repo.js';
export * from './library/scanner.js';
export * from './sources/manager.js';
export * from './sources/device-login.js';
export { createRealDebridAdapter } from './providers/debrid/adapters/real-debrid/index.js';
export { createAllDebridAdapter } from './providers/debrid/adapters/alldebrid/index.js';
export { createTorBoxAdapter } from './providers/debrid/adapters/torbox/index.js';
export { createPremiumizeAdapter } from './providers/debrid/adapters/premiumize/index.js';
export * from './api/router.js';
export * from './library/backup.js';
export * from './metadata/ranged.js';
export * from './discovery/index.js';
