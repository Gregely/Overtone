/**
 * Standalone mode: open the on-device library and wire @overtone/core to
 * this platform.
 *
 *            Android app                          plain browser (dev/tests)
 *  DB        Capacitor SQLite (app storage)       sql.js, saved to IndexedDB
 *  secrets   Keystore-backed SecureStorage        AES-GCM, non-extractable key
 *  HTTP      CapacitorHttp (native, no CORS)      fetch (CORS applies)
 *  timers    native (BackgroundWork.sleep)        setTimeout
 *  local     "This device" (Storage Access Fw.)   none
 *  artwork   app files dir                        memory (object URLs)
 */
import {
  consoleLogger,
  createCore,
  createDatabase,
  createDefaultRegistry,
  createEmbeddedRouter,
  migrate,
  prefixedSecretStore,
  sqlJsDriver,
  systemClock,
  type Clock,
  type Database,
  type HttpFetch,
  type OvertoneCore,
  type ProviderPlugin,
  type SecretStore,
} from '@overtone/core';
import app from '../../app.config.json';
import { EmbeddedTransport, embeddedCoverUrl } from '../api/embedded';
import { SecureStorage } from '../platform/native';
import { isNativeApp } from '../platform/server-url';
import { createActivityNotifier, nativeClock } from './background';
import { capacitorSqliteDriver } from './capacitor-sqlite';
import { createDeviceFolderPlugin } from './device-folder';
import { createNativeFetch } from './native-fetch';
import { AppStorage, BackgroundWork, DeviceFolder } from './plugins';
import { AppFilesBlobStore, idbStore, KeystoreSecretStore, ObjectUrlBlobStore, WebCryptoSecretStore, type DisplayableBlobStore } from './stores';

export const STANDALONE_DATABASE = 'overtone-library';
/** Sources not scanned for this long are rescanned when the app starts. */
const RESCAN_AFTER_MS = 12 * 3600_000;

export interface Standalone {
  client: EmbeddedTransport;
  core: OvertoneCore;
  close(): Promise<void>;
}

interface Platform {
  db: Database;
  secrets: SecretStore;
  torrentSecrets: SecretStore;
  blobs: DisplayableBlobStore;
  fetch?: HttpFetch;
  clock: Clock;
  local: ProviderPlugin[];
  databaseBytes: () => Promise<number | null>;
  onActivity?: (core: () => OvertoneCore | null) => () => void;
  afterStart?: (core: OvertoneCore) => void;
}

/** Test/dev hooks for the browser build (set by the e2e test before the app loads). */
interface DevOverrides {
  musicbrainzUrl?: string;
  coverArtUrl?: string;
}

function devOverrides(): DevOverrides {
  try {
    return JSON.parse(localStorage.getItem('overtone.dev.standalone') ?? '{}') as DevOverrides;
  } catch {
    return {};
  }
}

async function androidPlatform(): Promise<Platform> {
  const db = createDatabase(await capacitorSqliteDriver(STANDALONE_DATABASE));
  await migrate(db);
  const { filesDir } = await AppStorage.info({ database: STANDALONE_DATABASE });
  const clock = nativeClock(BackgroundWork);
  return {
    db,
    secrets: new KeystoreSecretStore(SecureStorage),
    torrentSecrets: prefixedSecretStore(new KeystoreSecretStore(SecureStorage), 'torrent.'),
    blobs: new AppFilesBlobStore(AppStorage, `${filesDir}/artwork`),
    fetch: createNativeFetch(),
    clock,
    local: [createDeviceFolderPlugin(DeviceFolder) as unknown as ProviderPlugin],
    databaseBytes: async () => (await AppStorage.info({ database: STANDALONE_DATABASE })).databaseBytes,
    onActivity: (core) => createActivityNotifier(core, BackgroundWork, clock),
    afterStart(core) {
      // Folder permissions belong to sources: give up the ones no source uses any more.
      const prune = async () => {
        const keep = (await core.sources.list())
          .filter((s) => s.provider_id === 'device-folder')
          .map((s) => String((JSON.parse(s.config_json) as { folder?: string }).folder ?? ''));
        await DeviceFolder.prune({ keep }).catch(() => undefined);
      };
      core.sources.onChange((e) => {
        if (e.type !== 'created') void prune();
      });
      void prune();
    },
  };
}

async function browserPlatform(): Promise<Platform> {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm.wasm?url')]);
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const kv = await idbStore('overtone-library');
  const saved = await kv.get<Uint8Array>('db');
  const driver = sqlJsDriver(SQL, { data: saved ?? null, persist: (bytes) => kv.set('db', bytes) });
  const db = createDatabase(driver);
  await migrate(db);
  // Save the snapshot when the page goes away (reload, tab closed, app switched).
  addEventListener('pagehide', () => void driver.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void driver.flush();
  });
  return {
    db,
    secrets: new WebCryptoSecretStore(),
    torrentSecrets: prefixedSecretStore(new WebCryptoSecretStore(), 'torrent.'),
    blobs: new ObjectUrlBlobStore(),
    clock: systemClock,
    local: [],
    databaseBytes: async () => driver.export().byteLength,
  };
}

export async function openStandalone(): Promise<Standalone> {
  const p = isNativeApp() ? await androidPlatform() : await browserPlatform();
  const dev = isNativeApp() ? {} : devOverrides();
  let core: OvertoneCore | null = null;
  const notify = p.onActivity?.(() => core);
  core = createCore({
    db: p.db,
    secrets: p.secrets,
    torrentSecrets: p.torrentSecrets,
    blobs: p.blobs,
    registry: createDefaultRegistry({ local: p.local, premiumizeClientId: import.meta.env.VITE_PREMIUMIZE_CLIENT_ID ?? null }),
    clock: p.clock,
    logger: consoleLogger({ debug: import.meta.env.DEV }),
    version: app.versionName,
    contact: app.musicbrainzContact,
    allowRedirect: false,
    prefetchEmbeddedArtwork: true,
    ...(p.fetch ? { fetch: p.fetch } : {}),
    ...(notify ? { onActivity: notify } : {}),
    ...(dev.musicbrainzUrl ? { musicbrainzUrl: dev.musicbrainzUrl } : {}),
    ...(dev.coverArtUrl ? { coverArtUrl: dev.coverArtUrl } : {}),
  });
  const c = core;
  const startBackground = async () => {
    // Resume whatever a previous run left (queued/interrupted scans, untagged
    // and unmatched files), then refresh sources that haven't been scanned lately.
    await c.start({ scanAll: false });
    for (const s of await c.sources.list()) {
      if (s.enabled && (!s.last_scan_at || c.clock.now() - s.last_scan_at > RESCAN_AFTER_MS)) c.scanner.enqueue(s.id);
    }
  };
  const handle = createEmbeddedRouter(c, {
    version: app.versionName,
    coverUrl: embeddedCoverUrl,
    databaseBytes: p.databaseBytes,
    onLibraryReplaced: startBackground,
  });
  const client = new EmbeddedTransport({
    handle,
    blobUrl: (key) => p.blobs.urlFor(key),
    ...(dev.coverArtUrl ? { coverArtArchive: dev.coverArtUrl } : {}),
  });
  p.afterStart?.(c);
  await startBackground();
  return {
    client,
    core: c,
    close: () => c.close(),
  };
}
