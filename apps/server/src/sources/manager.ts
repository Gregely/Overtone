import { randomBytes } from 'node:crypto';
import {
  toPublicConfig,
  validateConfig,
  type ConfigValues,
  type ConnectionTestResultDto,
  type SourceDto,
  type SourceWriteDto,
  type StreamMode,
} from '@overtone/shared';
import type { SecretBox } from '../crypto/secret-box.js';
import type { Db } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { createProviderFetch } from '../http/provider-fetch.js';
import { createRedactingLogger, type BaseLogger } from '../http/redact.js';
import { ProviderError } from '../providers/errors.js';
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
  secrets_enc: string | null;
  created_at: number;
  last_scan_at: number | null;
  last_error: string | null;
}

export interface SourceManagerDeps {
  db: Db;
  registry: ProviderRegistry;
  secretBox: SecretBox;
  logger: BaseLogger & { child(bindings: object): BaseLogger };
  userAgent: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export type SourceEvent = { type: 'created' | 'updated' | 'deleted'; sourceId: string };

/**
 * Owns configured sources: persistence, secret encryption, validation and
 * live provider instances. The only place decrypted secrets exist (in memory,
 * inside provider instances).
 */
export class SourceManager {
  readonly #d: SourceManagerDeps;
  readonly #instances = new Map<string, { provider: SourceProvider; secrets: string[] }>();
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
    return this.#d.now?.() ?? Date.now();
  }

  list(): SourceRow[] {
    return this.#d.db.prepare('SELECT * FROM sources ORDER BY priority, created_at').all() as SourceRow[];
  }

  get(id: string): SourceRow | undefined {
    return this.#d.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
  }

  require(id: string): SourceRow {
    const row = this.get(id);
    if (!row) throw ApiError.notFound('Source');
    return row;
  }

  plugin(row: SourceRow): ProviderPlugin {
    const p = this.#d.registry.get(row.provider_id);
    if (!p) throw new ProviderError('config', `Provider "${row.provider_id}" is not available in this build`);
    return p;
  }

  toDto(row: SourceRow): SourceDto {
    const plugin = this.#d.registry.get(row.provider_id);
    const fileCount = (
      this.#d.db.prepare('SELECT COUNT(*) AS n FROM source_files WHERE source_id = ?').get(row.id) as { n: number }
    ).n;
    const values = JSON.parse(row.config_json) as ConfigValues;
    const secretKeys = Object.keys(this.#secrets(row));
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

  create(input: SourceWriteDto, deviceSecrets?: Record<string, string>): SourceRow {
    const plugin = input.providerId ? this.#d.registry.get(input.providerId) : undefined;
    if (!plugin) throw ApiError.validation({ providerId: 'Unknown provider' });
    const id = randomBytes(6).toString('base64url');
    const result = validateConfig(plugin.manifest.configSchema, input.config ?? {});
    if (!result.ok) throw ApiError.validation(prefixFields(result.errors));
    const streamMode = this.#checkStreamMode(plugin, input.streamMode ?? 'proxy');
    const name = cleanName(input.name ?? plugin.manifest.name);
    const secrets = this.#mergeSecrets(plugin, {}, result.secrets, deviceSecrets);

    this.#d.db
      .prepare(
        `INSERT INTO sources (id, provider_id, name, enabled, priority, stream_mode, config_json, secrets_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        plugin.manifest.id,
        name,
        input.enabled === false ? 0 : 1,
        clampPriority(input.priority ?? defaultPriority(plugin)),
        streamMode,
        JSON.stringify(result.values),
        Object.keys(secrets).length ? this.#d.secretBox.sealJson(secrets, id) : null,
        this.#now(),
      );
    this.#emit({ type: 'created', sourceId: id });
    return this.get(id)!;
  }

  update(id: string, input: SourceWriteDto, deviceSecrets?: Record<string, string>): SourceRow {
    const row = this.require(id);
    if (input.providerId && input.providerId !== row.provider_id) throw ApiError.badRequest('providerId cannot be changed');
    const plugin = this.plugin(row);
    let configJson = row.config_json;
    let secretsEnc = row.secrets_enc;

    if (input.config || deviceSecrets) {
      const existing = this.#secrets(row);
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
      secretsEnc = Object.keys(secrets).length ? this.#d.secretBox.sealJson(secrets, id) : null;
    }
    const streamMode = input.streamMode ? this.#checkStreamMode(plugin, input.streamMode) : row.stream_mode;

    this.#d.db
      .prepare(
        `UPDATE sources SET name = ?, enabled = ?, priority = ?, stream_mode = ?, config_json = ?, secrets_enc = ? WHERE id = ?`,
      )
      .run(
        input.name !== undefined ? cleanName(input.name) : row.name,
        input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
        input.priority === undefined ? row.priority : clampPriority(input.priority),
        streamMode,
        configJson,
        secretsEnc,
        id,
      );
    void this.#disposeInstance(id);
    this.#emit({ type: 'updated', sourceId: id });
    return this.get(id)!;
  }

  async delete(id: string): Promise<void> {
    this.require(id);
    await this.#disposeInstance(id);
    this.#d.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    this.#emit({ type: 'deleted', sourceId: id });
  }

  setScanResult(id: string, at: number, error: string | null): void {
    this.#d.db.prepare('UPDATE sources SET last_scan_at = ?, last_error = ? WHERE id = ?').run(at, error, id);
  }

  /** Live provider instance for a source (created lazily, cached until config changes). */
  instance(id: string): SourceProvider {
    const cached = this.#instances.get(id);
    if (cached) return cached.provider;
    const row = this.require(id);
    const plugin = this.plugin(row);
    const secrets = this.#secrets(row);
    const config = { ...(JSON.parse(row.config_json) as ConfigValues), ...secrets };
    const provider = plugin.create(config, this.#context(row, () => Object.values(this.#secrets(this.get(id) ?? row))));
    this.#instances.set(id, { provider, secrets: Object.values(secrets) });
    return provider;
  }

  /**
   * Test a config before (or without) saving it. With `sourceId`, unspecified
   * secrets fall back to the stored ones, so users needn't re-enter keys.
   */
  async test(providerId: string, rawConfig: Record<string, unknown>, sourceId?: string, deviceSecrets?: Record<string, string>): Promise<ConnectionTestResultDto> {
    const plugin = this.#d.registry.get(providerId);
    if (!plugin) throw ApiError.validation({ providerId: 'Unknown provider' });
    const row = sourceId ? this.require(sourceId) : undefined;
    if (row && row.provider_id !== providerId) throw ApiError.badRequest('Provider mismatch');
    const existing = row ? this.#secrets(row) : {};
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
      provider = plugin.create({ ...result.values, ...secrets }, this.#context(tempRow, () => Object.values(secrets), true));
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
    const inst = this.#instances.get(id);
    this.#instances.delete(id);
    await inst?.provider.dispose?.();
  }

  #secrets(row: SourceRow): Record<string, string> {
    return this.#d.secretBox.openJson(row.secrets_enc, row.id);
  }

  #checkStreamMode(plugin: ProviderPlugin, mode: StreamMode): StreamMode {
    if (mode !== 'proxy' && mode !== 'redirect') throw ApiError.validation({ streamMode: 'Must be proxy or redirect' });
    if (mode === 'redirect' && !plugin.manifest.capabilities?.redirectable) {
      throw ApiError.validation({ streamMode: `${plugin.manifest.name} streams must be proxied (its links carry credentials)` });
    }
    return mode;
  }

  #context(row: SourceRow, secretValues: () => string[], ephemeral = false): ProviderContext {
    const base = this.#d.logger.child({ sourceId: row.id, provider: row.provider_id });
    const logger = createRedactingLogger(base, secretValues);
    const db = this.#d.db;
    const memState = new Map<string, unknown>();
    const plugin = this.#d.registry.get(row.provider_id);
    const secretKeys = new Set(plugin?.manifest.configSchema.fields.filter((f) => f.type === 'secret').map((f) => f.key));
    return {
      sourceId: row.id,
      logger,
      fetch: createProviderFetch({ userAgent: this.#d.userAgent, logger, ...(this.#d.fetch ? { fetch: this.#d.fetch } : {}) }),
      state: ephemeral
        ? {
            get: <T>(k: string) => memState.get(k) as T | undefined,
            set: (k, v) => void memState.set(k, v),
            delete: (k) => void memState.delete(k),
          }
        : {
            get: <T>(k: string) => {
              const r = db.prepare('SELECT value_json FROM provider_state WHERE source_id = ? AND key = ?').get(row.id, k) as
                | { value_json: string }
                | undefined;
              return r ? (JSON.parse(r.value_json) as T) : undefined;
            },
            set: (k, v) =>
              void db
                .prepare(
                  `INSERT INTO provider_state (source_id, key, value_json) VALUES (?, ?, ?)
                   ON CONFLICT (source_id, key) DO UPDATE SET value_json = excluded.value_json`,
                )
                .run(row.id, k, JSON.stringify(v)),
            delete: (k) => void db.prepare('DELETE FROM provider_state WHERE source_id = ? AND key = ?').run(row.id, k),
          },
      updateSecrets: async (patch) => {
        for (const k of Object.keys(patch)) {
          if (!secretKeys.has(k)) throw new Error(`updateSecrets: "${k}" is not a secret field`);
        }
        if (ephemeral) return;
        const current = this.get(row.id);
        if (!current) return;
        const merged = { ...this.#secrets(current), ...patch };
        db.prepare('UPDATE sources SET secrets_enc = ? WHERE id = ?').run(this.#d.secretBox.sealJson(merged, row.id), row.id);
      },
    };
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
