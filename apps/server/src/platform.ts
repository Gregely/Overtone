/** Server implementations of core's platform interfaces. */
import { mkdir, readdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore, Database, SecretStore } from '@overtone/core';
import type { SecretBox } from './crypto/secret-box.js';

/**
 * Source secrets, AES-256-GCM encrypted (key derived from OVERTONE_SECRET_KEY,
 * source id as associated data) into the `sources.secrets_enc` column.
 */
export class EncryptedColumnSecretStore implements SecretStore {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  async get(sourceId: string): Promise<Record<string, string>> {
    const row = await this.db.get<{ secrets_enc: string | null }>('SELECT secrets_enc FROM sources WHERE id = ?', [sourceId]);
    return this.box.openJson(row?.secrets_enc ?? null, sourceId);
  }

  async set(sourceId: string, secrets: Record<string, string>): Promise<void> {
    const sealed = Object.keys(secrets).length ? this.box.sealJson(secrets, sourceId) : null;
    await this.db.run('UPDATE sources SET secrets_enc = ? WHERE id = ?', [sealed, sourceId]);
  }

  async delete(): Promise<void> {
    // The column goes with the row.
  }
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Blobs as files under a directory: key "artwork/12-500" → <dir>/artwork/12-500.jpg. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  #file(key: string, ext: string): string {
    const safe = key.split('/').filter((p) => p && p !== '..' && p !== '.').join(path.sep);
    return path.join(this.dir, `${safe}.${ext}`);
  }

  async get(key: string): Promise<{ data: Uint8Array; mimeType: string } | null> {
    for (const [mimeType, ext] of Object.entries(EXT)) {
      const data = await readFile(this.#file(key, ext)).catch(() => null);
      if (data) return { data, mimeType };
    }
    return null;
  }

  async put(key: string, data: Uint8Array, mimeType: string): Promise<void> {
    const file = this.#file(key, EXT[mimeType] ?? 'img');
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  async deletePrefix(prefix: string): Promise<void> {
    const dir = path.dirname(this.#file(`${prefix}x`, 'x'));
    const base = path.basename(prefix);
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(entries.filter((e) => e.startsWith(base)).map((e) => rm(path.join(dir, e), { force: true })));
  }

  async size(): Promise<number> {
    let total = 0;
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else total += (await stat(p).catch(() => ({ size: 0 }))).size;
      }
    };
    await walk(this.dir);
    return total;
  }
}
