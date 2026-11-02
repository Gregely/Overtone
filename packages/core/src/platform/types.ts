/**
 * Everything core needs from its host, injected so the same code runs on the
 * server (Node), in the Android WebView (standalone) and in tests.
 */

/** Time and timers. Android standalone backs `sleep`/`schedule` with native timers. */
export interface Clock {
  now(): number;
  /** Resolve after `ms` (rejects with the signal's reason if aborted). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Run `fn` once after `ms`. Returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void;
}

/** The global fetch signature. Standalone Android passes a native-HTTP implementation. */
export type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Where source secrets (API keys, OAuth tokens, passwords) live. Never the
 * plain database: the server encrypts them into `sources.secrets_enc`; the
 * Android app keeps them in Keystore-backed storage.
 */
export interface SecretStore {
  get(sourceId: string): Promise<Record<string, string>>;
  set(sourceId: string, secrets: Record<string, string>): Promise<void>;
  delete(sourceId: string): Promise<void>;
}

/** Small binary cache (album artwork). */
export interface BlobStore {
  get(key: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
  put(key: string, data: Uint8Array, mimeType: string): Promise<void>;
  /** Delete every blob whose key starts with `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
  /** Total bytes stored (for "storage used"); optional. */
  size?(): Promise<number>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  schedule: (ms, fn) => {
    const t = setTimeout(fn, ms) as unknown as { unref?: () => void };
    // Node: don't keep the process alive for background timers.
    t.unref?.();
    return () => clearTimeout(t as never);
  },
};

/** In-memory secret store (tests, and the browser's standalone dev mode). */
export class MemorySecretStore implements SecretStore {
  readonly #m = new Map<string, Record<string, string>>();
  async get(id: string) {
    return { ...(this.#m.get(id) ?? {}) };
  }
  async set(id: string, s: Record<string, string>) {
    if (Object.keys(s).length) this.#m.set(id, { ...s });
    else this.#m.delete(id);
  }
  async delete(id: string) {
    this.#m.delete(id);
  }
  /** Test helper: everything stored. */
  dump(): Record<string, Record<string, string>> {
    return Object.fromEntries(this.#m);
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly #m = new Map<string, { data: Uint8Array; mimeType: string }>();
  async get(k: string) {
    return this.#m.get(k) ?? null;
  }
  async put(k: string, data: Uint8Array, mimeType: string) {
    this.#m.set(k, { data, mimeType });
  }
  async deletePrefix(p: string) {
    for (const k of [...this.#m.keys()]) if (k.startsWith(p)) this.#m.delete(k);
  }
  async size() {
    let n = 0;
    for (const v of this.#m.values()) n += v.data.byteLength;
    return n;
  }
  keys(): string[] {
    return [...this.#m.keys()];
  }
}
