/**
 * Standalone implementations of core's SecretStore and BlobStore.
 *
 * Secrets never go into the library database:
 *  - Android: the Keystore-backed SecureStorage plugin (AES-256-GCM with a
 *    hardware-backed key), one entry per source;
 *  - browser (development/testing only): AES-GCM with a non-extractable
 *    WebCrypto key held in IndexedDB.
 */
import { Capacitor } from '@capacitor/core';
import { fromBase64, toBase64, type BlobStore, type SecretStore } from '@overtone/core';
import type { SecureStoragePlugin } from '../platform/native';
import type { AppStoragePlugin } from './plugins';

const SECRET_PREFIX = 'overtone.source-secrets.';

export class KeystoreSecretStore implements SecretStore {
  constructor(private readonly plugin: SecureStoragePlugin) {}

  async get(sourceId: string): Promise<Record<string, string>> {
    const { value } = await this.plugin.get({ key: SECRET_PREFIX + sourceId });
    return value ? (JSON.parse(value) as Record<string, string>) : {};
  }
  async set(sourceId: string, secrets: Record<string, string>): Promise<void> {
    if (!Object.keys(secrets).length) return this.delete(sourceId);
    await this.plugin.set({ key: SECRET_PREFIX + sourceId, value: JSON.stringify(secrets) });
  }
  async delete(sourceId: string): Promise<void> {
    await this.plugin.remove({ key: SECRET_PREFIX + sourceId });
  }
}

// ── IndexedDB helpers (browser) ────────────────────────────────────────────

function idb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbStore(name: string) {
  const db = await idb(name);
  const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction('kv', mode).objectStore('kv'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  return {
    get: <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
    set: (key: string, value: unknown) => tx('readwrite', (s) => s.put(value, key)).then(() => undefined),
    delete: (key: string) => tx('readwrite', (s) => s.delete(key)).then(() => undefined),
  };
}

/** Browser standalone (dev/testing): secrets encrypted with a non-extractable key. */
export class WebCryptoSecretStore implements SecretStore {
  #store: ReturnType<typeof idbStore> | undefined;
  #key: Promise<CryptoKey> | undefined;

  #kv() {
    return (this.#store ??= idbStore('overtone-secrets'));
  }

  #cryptoKey(): Promise<CryptoKey> {
    return (this.#key ??= (async () => {
      const kv = await this.#kv();
      const existing = await kv.get<CryptoKey>('key');
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await kv.set('key', key);
      return key;
    })());
  }

  async get(sourceId: string): Promise<Record<string, string>> {
    const box = await (await this.#kv()).get<{ iv: string; data: string }>(`s:${sourceId}`);
    if (!box) return {};
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(box.iv) as BufferSource }, await this.#cryptoKey(), fromBase64(box.data) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
  }

  async set(sourceId: string, secrets: Record<string, string>): Promise<void> {
    if (!Object.keys(secrets).length) return this.delete(sourceId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.#cryptoKey(), new TextEncoder().encode(JSON.stringify(secrets)));
    await (await this.#kv()).set(`s:${sourceId}`, { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) });
  }

  async delete(sourceId: string): Promise<void> {
    await (await this.#kv()).delete(`s:${sourceId}`);
  }
}

// ── Artwork cache ──────────────────────────────────────────────────────────

/** A BlobStore whose entries can be shown in an <img> synchronously. */
export interface DisplayableBlobStore extends BlobStore {
  urlFor(key: string): string | null;
}

const fileName = (key: string) => `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.bin`;

/**
 * Android: files under the app's private files dir, shown through the
 * WebView's local file route (Capacitor.convertFileSrc). Images are stored
 * without an extension-based type; the WebView sniffs JPEG/PNG/GIF.
 */
export class AppFilesBlobStore implements DisplayableBlobStore {
  readonly #known = new Set<string>();
  constructor(
    private readonly plugin: AppStoragePlugin,
    private readonly dir: string,
  ) {}

  #path(key: string) {
    return `${this.dir}/${fileName(key)}`;
  }
  async get(key: string) {
    const { data } = await this.plugin.readFile({ path: this.#path(key) });
    if (data === null) return null;
    this.#known.add(key);
    return { data: fromBase64(data), mimeType: 'application/octet-stream' };
  }
  async put(key: string, data: Uint8Array) {
    await this.plugin.writeFile({ path: this.#path(key), data: toBase64(data) });
    this.#known.add(key);
  }
  async deletePrefix(prefix: string) {
    await this.plugin.deletePrefix({ dir: this.dir, prefix: fileName(prefix).replace(/\.bin$/, '') });
    for (const k of [...this.#known]) if (k.startsWith(prefix)) this.#known.delete(k);
  }
  async size() {
    return (await this.plugin.dirSize({ dir: this.dir })).bytes;
  }
  urlFor(key: string): string | null {
    // The DB says the picture is cached ('embedded'); point at the file even if
    // this session hasn't touched it yet. A missing file shows the placeholder.
    return Capacitor.convertFileSrc(`file://${this.#path(key)}`);
  }
}

/** Browser: in memory, shown through object URLs. */
export class ObjectUrlBlobStore implements DisplayableBlobStore {
  readonly #m = new Map<string, { data: Uint8Array; mimeType: string; url: string }>();
  async get(key: string) {
    const e = this.#m.get(key);
    return e ? { data: e.data, mimeType: e.mimeType } : null;
  }
  async put(key: string, data: Uint8Array, mimeType: string) {
    const old = this.#m.get(key);
    if (old) URL.revokeObjectURL(old.url);
    this.#m.set(key, { data, mimeType, url: URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType })) });
  }
  async deletePrefix(prefix: string) {
    for (const [k, v] of this.#m) {
      if (k.startsWith(prefix)) {
        URL.revokeObjectURL(v.url);
        this.#m.delete(k);
      }
    }
  }
  async size() {
    let n = 0;
    for (const v of this.#m.values()) n += v.data.byteLength;
    return n;
  }
  urlFor(key: string) {
    return this.#m.get(key)?.url ?? null;
  }
}
