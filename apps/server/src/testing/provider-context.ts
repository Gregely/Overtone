/**
 * Test helper for provider authors: a ProviderContext with an in-memory state
 * store, a recording logger, and an injectable fetch (no network by default).
 */
import type { ProviderContext, ProviderFetch, ProviderLogger } from '../providers/types.js';

export interface TestProviderContext extends ProviderContext {
  logs: Array<{ level: keyof ProviderLogger; msg: string; data?: Record<string, unknown> }>;
  stateData: Map<string, unknown>;
  secretUpdates: Array<Record<string, string>>;
}

export function createTestContext(opts: { fetch?: ProviderFetch; sourceId?: string } = {}): TestProviderContext {
  const logs: TestProviderContext['logs'] = [];
  const stateData = new Map<string, unknown>();
  const secretUpdates: Array<Record<string, string>> = [];
  const log =
    (level: keyof ProviderLogger) =>
    (msg: string, data?: Record<string, unknown>): void => {
      logs.push(data ? { level, msg, data } : { level, msg });
    };

  return {
    sourceId: opts.sourceId ?? 'test-source',
    logs,
    stateData,
    secretUpdates,
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    fetch:
      opts.fetch ??
      (async (input) => {
        throw new Error(`Unexpected network request in test: ${String(input)}`);
      }),
    state: {
      get: <T>(key: string) => stateData.get(key) as T | undefined,
      set: (key, value) => void stateData.set(key, value),
      delete: (key) => void stateData.delete(key),
    },
    async updateSecrets(patch) {
      secretUpdates.push({ ...patch });
    },
  };
}

/** Collect an async iterable into an array. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
