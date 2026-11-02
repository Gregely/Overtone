/**
 * Library export / import (standalone Settings › Library) and the "storage
 * used" summary.
 *
 * An export holds the source list with its non-secret settings and the
 * library tables (files, tracks, releases, artists). Secrets (API keys,
 * tokens, passwords) are left out, unless the user picks a passphrase: then
 * they're added encrypted with AES-256-GCM, the key derived from the
 * passphrase with PBKDF2-SHA256. The MusicBrainz cache and artwork are
 * not exported; they're re-fetched as needed.
 */
import type { LibraryExportDto, LibraryImportResultDto, LibraryInfoDto } from '@overtone/shared';
import type { OvertoneCore } from '../core.js';
import { fromBase64, randomBytes, toBase64 } from '../crypto.js';
import { SCHEMA_VERSION } from '../db/migrate.js';
import { ApiError } from '../errors.js';

/** Tables in dependency order (parents first). */
const TABLES = ['artists', 'releases', 'tracks', 'source_files'] as const;
const PBKDF2_ITERATIONS = 310_000;
const MAX_ROWS = 2_000_000;

export async function libraryInfo(core: OvertoneCore, databaseBytes?: () => Promise<number | null>): Promise<LibraryInfoDto> {
  const last = await core.db.get<{ at: number | null }>('SELECT MAX(last_scan_at) AS at FROM sources');
  const sources = await core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sources');
  return {
    databaseBytes: (await databaseBytes?.()) ?? null,
    artworkBytes: (await core.blobs.size?.()) ?? null,
    lastScanAt: last?.at ? new Date(last.at).toISOString() : null,
    sourceCount: sources?.n ?? 0,
    stats: await core.library.stats(),
    matching: await core.api.matchStatus(),
    scanning: core.scanner.busy,
  };
}

export async function exportLibrary(core: OvertoneCore, opts: { passphrase?: string } = {}): Promise<LibraryExportDto> {
  const rows = await core.sources.list();
  const tables: LibraryExportDto['tables'] = {};
  for (const t of TABLES) tables[t] = await core.db.all<Record<string, unknown>>(`SELECT * FROM ${t} ORDER BY id`);
  const out: LibraryExportDto = {
    format: 'overtone-library',
    version: 1,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(core.clock.now()).toISOString(),
    sources: rows.map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      name: r.name,
      enabled: r.enabled === 1,
      priority: r.priority,
      config: JSON.parse(r.config_json) as Record<string, unknown>,
    })),
    tables,
  };
  if (opts.passphrase) {
    if (opts.passphrase.length < 8) throw ApiError.validation({ passphrase: 'Use at least 8 characters' });
    const secrets: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      const s = await core.secrets.get(r.id);
      if (Object.keys(s).length) secrets[r.id] = s;
    }
    out.secrets = await encrypt(JSON.stringify(secrets), opts.passphrase);
  }
  return out;
}

export async function importLibrary(core: OvertoneCore, file: LibraryExportDto, opts: { passphrase?: string } = {}): Promise<LibraryImportResultDto> {
  if (!file || file.format !== 'overtone-library' || file.version !== 1 || !Array.isArray(file.sources) || typeof file.tables !== 'object') {
    throw ApiError.validation({ file: "This isn't an Overtone library export" });
  }
  if (file.schemaVersion > SCHEMA_VERSION) throw ApiError.validation({ file: 'This export comes from a newer Overtone. Update the app first.' });

  // Decrypt first, so a wrong passphrase changes nothing.
  let secrets: Record<string, Record<string, string>> | null = null;
  if (file.secrets && opts.passphrase) {
    try {
      secrets = JSON.parse(await decrypt(file.secrets, opts.passphrase)) as Record<string, Record<string, string>>;
    } catch {
      throw ApiError.validation({ passphrase: 'Wrong passphrase' });
    }
  }
  for (const s of file.sources) {
    if (typeof s.id !== 'string' || !core.registry.get(s.providerId)) {
      throw ApiError.validation({ file: `Unknown source type "${String(s.providerId)}" in this export` });
    }
  }

  // Only known columns: column names come from the file, so never trust them in SQL.
  const columns: Record<string, Set<string>> = {};
  for (const t of TABLES) {
    columns[t] = new Set((await core.db.all<{ name: string }>(`PRAGMA table_info(${t})`)).map((c) => c.name));
  }
  let fileCount = 0;
  const previous = await core.sources.list();
  await core.pause();
  await core.sources.disposeAll();
  await core.db.transaction(async (tx) => {
    for (const t of [...TABLES].reverse()) await tx.run(`DELETE FROM ${t}`);
    await tx.run('DELETE FROM provider_state');
    await tx.run('DELETE FROM jobs');
    await tx.run('DELETE FROM sources');
    for (const s of file.sources) {
      await tx.run(
        `INSERT INTO sources (id, provider_id, name, enabled, priority, stream_mode, config_json, secrets_enc, created_at)
         VALUES (?, ?, ?, ?, ?, 'proxy', ?, NULL, ?)`,
        [s.id, s.providerId, String(s.name).slice(0, 100), s.enabled ? 1 : 0, Number(s.priority) || 0, JSON.stringify(s.config ?? {}), core.clock.now()],
      );
    }
    let total = 0;
    for (const t of TABLES) {
      for (const row of file.tables[t] ?? []) {
        if (++total > MAX_ROWS) throw ApiError.validation({ file: 'This export is too large' });
        const keys = Object.keys(row).filter((k) => columns[t]!.has(k));
        if (!keys.length) continue;
        await tx.run(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
        if (t === 'source_files') fileCount++;
      }
    }
  });
  for (const p of previous) await core.secrets.delete(p.id);
  if (secrets) for (const s of file.sources) if (secrets[s.id]) await core.secrets.set(s.id, secrets[s.id]!);
  await core.covers.forgetAll();
  return { sources: file.sources.length, files: fileCount, secretsRestored: Boolean(secrets) };
}

// ── passphrase encryption (WebCrypto) ───────────────────────────────────────

async function key(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encrypt(plain: string, passphrase: string): Promise<NonNullable<LibraryExportDto['secrets']>> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const k = await key(passphrase, salt, PBKDF2_ITERATIONS);
  const data = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, k, new TextEncoder().encode(plain)));
  return { kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) };
}

async function decrypt(box: NonNullable<LibraryExportDto['secrets']>, passphrase: string): Promise<string> {
  if (box.kdf !== 'PBKDF2-SHA256' || !(box.iterations >= 100_000 && box.iterations <= 5_000_000)) throw new Error('unsupported');
  const k = await key(passphrase, fromBase64(box.salt), box.iterations);
  const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(box.iv) as BufferSource }, k, fromBase64(box.data) as BufferSource);
  return new TextDecoder().decode(plain);
}
