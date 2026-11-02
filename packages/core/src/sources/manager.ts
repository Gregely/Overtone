import {
  toPublicConfig,
  validateConfig,
  type ConfigValues,
  type ConnectionTestResultDto,
  type SourceDto,
  type SourceWriteDto,
  type StreamMode,
} from '@overtone/shared';
import { randomId } from '../crypto.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { createRedactingLogger, type Logger } from '../logging.js';
import type { Clock, HttpFetch, SecretStore } from '../platform/types.js';
import { ProviderError } from '../providers/errors.js';
import { createProviderFetch } from '../providers/fetch.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderContext, ProviderPlugin, SourceProvider } from '../providers/types.js';

export interface SourceRow {
  id: string;
  provider_id: string;
  name: string;
  enabled: number;
  priority: number;
  stream_mode: StreamMode;
  config_json: string;
  /** Server only: encrypted secrets column (see SecretStore). Always null in standalone mode. */
  secrets_enc: string | null;
  created_at: number;
  last_scan_at: number | null;
  last_error: string | null;
}

export interface SourceManagerDeps {
  db: Database;
  registry: ProviderRegistry;
  /** Where secrets are kept: encrypted DB column (server) or Android Keystore storage. */
  secrets: SecretStore;
  logger: Logger;
  userAgent: string;
  fetch?: HttpFetch;
  clock?: Pick<Clock, 'now' | 'sleep'>;
  /** @deprecated use clock */
  now?: () => number;
  /**
   * Whether streams can be redirected (server mode). Standalone mode has no
   * proxy, so stream mode is fixed to "proxy" (meaning: play directly) and
   * redirect settings are ignored.
   */
  allowRedirect?: boolean;
}

export type SourceEvent = { type: 'created' | 'updated' | 'deleted'; sourceId: string };

interface Instance {
  provider: SourceProvider;
  /** Pending provider_state writes (write-behind). */
  flush: () => Promise<void>;
}

/**
 * Owns configured sources: persistence, secret storage, validation and
 * live provider instances. The only place decrypted secrets exist (in memory,
 * inside provider instances).
 */
export class SourceManager {
  readonly #d: SourceManagerDeps;
  readonly #instances = new Map<string, Promise<Instance>>();
  readonly #listeners = new Set<(e: SourceEvent) => void>();

  constructor(deps: SourceManagerDeps) {
    this.#d = deps;
  }

  onChange(fn: (e: SourceEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(e: SourceEvent): void {
    for (const fn of this.#listeners) fn(e);
  }

  #now(): number {
    return this.#d.clock?.now() ?? this.#d.now?.() ?? Date.now();
  }

  list(): Promise<SourceRow[]> {
    return this.#d.db.all<SourceRow>('SELECT * FROM sources ORDER BY priority, created_at');
  }

  get(id: string): Promise<SourceRow | undefined> {
    return this.#d.db.get<SourceRow>('SELECT * FROM sources WHERE id = ?', [id]);
  }

  async require(id: string): Promise<SourceRow> {
    const row = await this.get(id);
    if (!row) throw ApiError.notFound('Source');
    return row;
  }

  plugin(row: SourceRow): ProviderPlugin {
    const p = this.#d.registry.get(row.provider_id);
    if (!p) throw new ProviderError('config', `Provider "${row.provider_id}" is not available in this build`);
    return p;
  }

  async toDto(row: SourceRow): Promise<SourceDto> {
    const plugin = this.#d.registry.get(row.provider_id);
    const fileCount = (await this.#d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_files WHERE source_id = ?', [row.id]))!.n;
    const values = JSON.parse(row.config_json) as ConfigValues;
    const secretKeys = Object.keys(await this.#secrets(row));
    return {
      id: row.id,
      providerId: row.provider_id,
      name: row.name,
      enabled: row.enabled === 1,
      priority: row.priority,
      streamMode: row.stream_mode,
      config: plugin ? publicConfig(plugin, values, secretKeys) : { values: {}, secretsSet: [] },
      lastScanAt: row.last_scan_at ? new Date(row.last_scan_at).toISOString() : null,
      lastError: row.last_error,
      fileCount,
    };
  }

  /**
   * Apply credentials from a completed "Log in with…" flow: they replace every
   * secret listed in the schema's deviceLogin.replaces. Conversely, when the
   * user pastes one of those secrets, the other device-login secrets are
   * cleared so stale OAuth tokens never shadow the new key.
   */
  #mergeSecrets(plugin: ProviderPlugin, current: Record<string, string>, typed: Record<string, string>, device?: Record<string, string>): Record<string, string> {
    const replaces = new Set(plugin.manifest.configSchema.deviceLogin?.replaces ?? []);
    const out = { ...current };
    if (device) {
      for (const k of replaces) delete out[k];
      for (const [k, v] of Object.entries(device)) if (replaces.has(k)) out[k] = v;
      for (const [k, v] of Object.entries(typed)) if (!replaces.has(k)) out[k] = v;
      return out;
    }
    if (Object.keys(typed).some((k) => replaces.has(k))) for (const k of replaces) delete out[k];
    return { ...out, ...typed };
  }

  async create(input: SourceWriteDto, deviceSecrets?: Record<string, string>): Promise<SourceRow> {
    const plugin = input.providerId ? this.#d.registry.get(input.providerId) : undefined;
    if (!plugin) throw ApiError.validation({ providerId: 'Unknown provider' });
    const id = randomId(6);
    const result = validateConfig(plugin.manifest.configSchema, input.config ?? {});
    if (!result.ok) throw ApiError.validation(prefixFields(result.errors));
    const streamMode = this.#checkStreamMode(plugin, input.streamMode ?? 'proxy');
    const name = cleanName(input.name ?? plugin.manifest.name);
    const secrets = this.#mergeSecrets(plugin, {}, result.secrets, deviceSecrets);
    const priority = clampPriority(input.priority ?? defaultPriority(plugin));

    await this.#d.db.run(
      `INSERT INTO sources (id, provider_id, name, enabled, priority, stream_mode, config_json, secrets_enc, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [id, plugin.manifest.id, name, input.enabled === false ? 0 : 1, priority, streamMode, JSON.stringify(result.values), this.#now()],
    );
    try {
      await this.#d.secrets.set(id, secrets);
    } catch (err) {
      await this.#d.db.run('DELETE FROM sources WHERE id = ?', [id]);
      throw err;
    }
    this.#emit({ type: 'created', sourceId: id });
    return (await this.get(id))!;
  }

  async update(id: string, input: SourceWriteDto, deviceSecrets?: Record<string, string>): Promise<SourceRow> {
    const row = await this.require(id);
    if (input.providerId && input.providerId !== row.provider_id) throw ApiError.badRequest('providerId cannot be changed');
    const plugin = this.plugin(row);
    let configJson = row.config_json;
    let nextSecrets: Record<string, string> | null = null;

    if (input.config || deviceSecrets) {
      const existing = await this.#secrets(row);
      // PATCH semantics for non-secret fields: unspecified fields keep their value.
      // Hidden fields are stripped from what's stored, but NOT from user input,
      // so validation rejects attempts to set them.
      const stored = JSON.parse(row.config_json) as ConfigValues;
      for (const f of plugin.manifest.configSchema.fields) if (f.hidden || f.type === 'secret') delete stored[f.key];
      const merged = { ...stored, ...(input.config ?? {}) };
      const result = validateConfig(plugin.manifest.configSchema, merged, { existingSecrets: Object.keys(existing) });
      if (!result.ok) throw ApiError.validation(prefixFields(result.errors));
      const secrets = this.#mergeSecrets(plugin, existing, result.secrets, deviceSecrets);
      for (const k of result.clearedSecrets) delete secrets[k];
      configJson = JSON.stringify(result.values);
      nextSecrets = secrets;
    }
    const streamMode = input.streamMode ? this.#checkStreamMode(plugin, input.streamMode) : row.stream_mode;

    await this.#d.db.run(`UPDATE sources SET name = ?, enabled = ?, priority = ?, stream_mode = ?, config_json = ? WHERE id = ?`, [
      input.name !== undefined ? cleanName(input.name) : row.name,
      input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
      input.priority === undefined ? row.priority : clampPriority(input.priority),
      streamMode,
      configJson,
      id,
    ]);
    if (nextSecrets) await this.#d.secrets.set(id, nextSecrets);
    await this.#disposeInstance(id);
    this.#emit({ type: 'updated', sourceId: id });
    return (await this.get(id))!;
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    await this.#disposeInstance(id);
    await this.#d.db.run('DELETE FROM sources WHERE id = ?', [id]);
    await this.#d.secrets.delete(id);
    this.#emit({ type: 'deleted', sourceId: id });
  }

  async setScanResult(id: string, at: number, error: string | null): Promise<void> {
    await this.#d.db.run('UPDATE sources SET last_scan_at = ?, last_error = ? WHERE id = ?', [at, error, id]);
  }

  /** Live provider instance for a source (created lazily, cached until config changes). */
  async instance(id: string): Promise<SourceProvider> {
    let p = this.#instances.get(id);
    if (!p) {
      p = this.#createInstance(id);
      this.#instances.set(id, p);
      p.catch(() => {
        if (this.#instances.get(id) === p) this.#instances.delete(id);
      });
    }
    return (await p).provider;
  }

  async #createInstance(id: string): Promise<Instance> {
    const row = await this.require(id);
    const plugin = this.plugin(row);
    const secrets = await this.#secrets(row);
    const config = { ...(JSON.parse(row.config_json) as ConfigValues), ...secrets };
    let current = Object.values(secrets);
    const { ctx, flush } = await this.#context(row, () => current, false, (next) => {
      current = Object.values(next);
    });
    return { provider: plugin.create(config, ctx), flush };
  }

  /**
   * Test a config before (or without) saving it. With `sourceId`, unspecified
   * secrets fall back to the stored ones, so users needn't re-enter keys.
   */
  async test(providerId: string, rawConfig: Record<string, unknown>, sourceId?: string, deviceSecrets?: Record<string, string>): Promise<ConnectionTestResultDto> {
    const plugin = this.#d.registry.get(providerId);
    if (!plugin) throw ApiError.validation({ providerId: 'Unknown provider' });
    const row = sourceId ? await this.require(sourceId) : undefined;
    if (row && row.provider_id !== providerId) throw ApiError.badRequest('Provider mismatch');
    const existing = row ? await this.#secrets(row) : {};
    const visibleInput = Object.fromEntries(
      Object.entries(rawConfig).filter(([k]) => !plugin.manifest.configSchema.fields.find((f) => f.key === k)?.hidden),
    );
    const result = validateConfig(plugin.manifest.configSchema, visibleInput, { existingSecrets: Object.keys(existing) });
    if (!result.ok) throw ApiError.validation(prefixFields(result.errors));
    const secrets = this.#mergeSecrets(plugin, existing, result.secrets, deviceSecrets);
    for (const k of result.clearedSecrets) delete secrets[k];
    const tempRow: SourceRow = row ?? ({ id: 'test', provider_id: providerId } as SourceRow);
    let provider: SourceProvider | undefined;
    try {
      const { ctx } = await this.#context(tempRow, () => Object.values(secrets), true);
      provider = plugin.create({ ...result.values, ...secrets }, ctx);
      if (!provider.testConnection) return { ok: true, message: 'Configuration is valid.' };
      return await provider.testConnection({ signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, message: err.message };
      if ((err as Error).name === 'TimeoutError') return { ok: false, message: 'Timed out' };
      throw err;
    } finally {
      await provider?.dispose?.();
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.#instances.keys()].map((id) => this.#disposeInstance(id)));
  }

  async #disposeInstance(id: string): Promise<void> {
    const p = this.#instances.get(id);
    this.#instances.delete(id);
    const inst = await p?.catch(() => undefined);
    await inst?.flush().catch(() => undefined);
    await inst?.provider.dispose?.();
  }

  #secrets(row: SourceRow): Promise<Record<string, string>> {
    return this.#d.secrets.get(row.id);
  }

  #checkStreamMode(plugin: ProviderPlugin, mode: StreamMode): StreamMode {
    if (mode !== 'proxy' && mode !== 'redirect') throw ApiError.validation({ streamMode: 'Must be proxy or redirect' });
    if (mode === 'redirect' && this.#d.allowRedirect === false) {
      throw ApiError.validation({ streamMode: 'Redirect mode only applies when using an Overtone server' });
    }
    if (mode === 'redirect' && !plugin.manifest.capabilities?.redirectable) {
      throw ApiError.validation({ streamMode: `${plugin.manifest.name} streams must be proxied (its links carry credentials)` });
    }
    return mode;
  }

  /**
   * Provider context. State is loaded into memory up front so providers can
   * read it synchronously; writes go to the database in the background, in
   * order (`flush` waits for them).
   */
  async #context(
    row: SourceRow,
    secretValues: () => string[],
    ephemeral: boolean,
    onSecrets?: (next: Record<string, string>) => void,
  ): Promise<{ ctx: ProviderContext; flush: () => Promise<void> }> {
    const base = this.#d.logger.child({ sourceId: row.id, provider: row.provider_id });
    const logger = createRedactingLogger(base, secretValues);
    const db = this.#d.db;
    const plugin = this.#d.registry.get(row.provider_id);
    const secretKeys = new Set(plugin?.manifest.configSchema.fields.filter((f) => f.type === 'secret').map((f) => f.key));

    const mem = new Map<string, unknown>();
    if (!ephemeral) {
      for (const r of await db.all<{ key: string; value_json: string }>('SELECT key, value_json FROM provider_state WHERE source_id = ?', [row.id])) {
        mem.set(r.key, JSON.parse(r.value_json));
      }
    }
    let writes: Promise<unknown> = Promise.resolve();
    const persist = (fn: () => Promise<unknown>) => {
      if (ephemeral) return;
      writes = writes.then(fn).catch((err) => base.warn({ error: (err as Error).message }, 'could not save provider state'));
    };

    const ctx: ProviderContext = {
      sourceId: row.id,
      logger,
      fetch: createProviderFetch({
        userAgent: this.#d.userAgent,
        logger,
        ...(this.#d.fetch ? { fetch: this.#d.fetch } : {}),
        ...(this.#d.clock ? { sleep: (ms: number) => this.#d.clock!.sleep(ms) } : {}),
      }),
      state: {
        get: <T>(k: string) => mem.get(k) as T | undefined,
        set: (k, v) => {
          mem.set(k, v);
          const json = JSON.stringify(v);
          persist(() =>
            db.run(
              `INSERT INTO provider_state (source_id, key, value_json) VALUES (?, ?, ?)
               ON CONFLICT (source_id, key) DO UPDATE SET value_json = excluded.value_json`,
              [row.id, k, json],
            ),
          );
        },
        delete: (k) => {
          mem.delete(k);
          persist(() => db.run('DELETE FROM provider_state WHERE source_id = ? AND key = ?', [row.id, k]));
        },
      },
      updateSecrets: async (patch) => {
        for (const k of Object.keys(patch)) {
          if (!secretKeys.has(k)) throw new Error(`updateSecrets: "${k}" is not a secret field`);
        }
        if (ephemeral) return;
        if (!(await this.get(row.id))) return;
        const merged = { ...(await this.#d.secrets.get(row.id)), ...patch };
        await this.#d.secrets.set(row.id, merged);
        onSecrets?.(merged);
      },
    };
    return { ctx, flush: () => writes.then(() => undefined) };
  }
}

function publicConfig(plugin: ProviderPlugin, values: ConfigValues, secretKeys: string[]) {
  const pub = toPublicConfig(plugin.manifest.configSchema, values, secretKeys);
  const hiddenLogin = (plugin.manifest.configSchema.deviceLogin?.replaces ?? []).filter(
    (k) => plugin.manifest.configSchema.fields.find((f) => f.key === k)?.hidden,
  );
  const viaDevice = hiddenLogin.some((k) => secretKeys.includes(k));
  return viaDevice ? { ...pub, signedInWithDeviceLogin: true } : pub;
}

function prefixFields(errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).map(([k, v]) => [`config.${k}`, v]));
}

function cleanName(name: string): string {
  const n = String(name).trim().slice(0, 100);
  if (!n) throw ApiError.validation({ name: 'Required' });
  return n;
}

function clampPriority(p: number): number {
  if (!Number.isInteger(p) || p < 0 || p > 1000) throw ApiError.validation({ priority: 'Must be an integer 0–1000' });
  return p;
}

function defaultPriority(plugin: ProviderPlugin): number {
  return plugin.manifest.category === 'local' ? 0 : plugin.manifest.category === 'server' ? 5 : 10;
}
