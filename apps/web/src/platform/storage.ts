/**
 * Async key/value storage. The web build uses localStorage; the Android
 * build (stage 5) swaps in a Keystore-backed secure storage plugin behind the
 * same interface, which is why it's async.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const localStore: KeyValueStore = {
  async get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode / quota: session just won't persist */
    }
  },
  async remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(k) {
      return data.get(k) ?? null;
    },
    async set(k, v) {
      data.set(k, v);
    },
    async remove(k) {
      data.delete(k);
    },
  };
}

/** Minimal shape of the SecureStorage Capacitor plugin (see platform/native.ts). */
export interface SecureStorageBackend {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

/**
 * Android: values are AES-256-GCM encrypted under a non-exportable Android
 * Keystore key (storage/SecureStoragePlugin.java). Used for the session
 * tokens and server URL; nothing secret goes to WebView localStorage.
 */
export function secureStore(backend: SecureStorageBackend): KeyValueStore {
  return {
    async get(key) {
      try {
        return (await backend.get({ key })).value ?? null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await backend.set({ key, value });
    },
    async remove(key) {
      try {
        await backend.remove({ key });
      } catch {
        /* already gone */
      }
    },
  };
}

