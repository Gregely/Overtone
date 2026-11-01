import { access, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BaseLogger } from '../../http/redact.js';
import type { LibraryRepo } from '../../library/repo.js';
import type { SourceManager } from '../../sources/manager.js';

export type CoverSize = 250 | 500 | 1200;
export const COVER_SIZES: readonly CoverSize[] = [250, 500, 1200];

const RETRY_NONE_AFTER_MS = 7 * 24 * 3600 * 1000;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

export interface CoverArtDeps {
  dataDir: string;
  library: LibraryRepo;
  sources: SourceManager;
  logger: BaseLogger;
  userAgent: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

/**
 * Album artwork: Cover Art Archive first (release, then release group), then
 * embedded pictures from the files. Images are cached on disk under
 * <dataDir>/artwork so each is fetched once.
 */
export class CoverArtService {
  readonly #dir: string;
  readonly #inflight = new Map<string, Promise<{ file: string; mimeType: string } | null>>();

  constructor(private readonly d: CoverArtDeps) {
    this.#dir = path.join(d.dataDir, 'artwork');
  }

  async get(releaseId: number, size: CoverSize): Promise<{ file: string; mimeType: string } | null> {
    const key = `${releaseId}-${size}`;
    let p = this.#inflight.get(key);
    if (!p) {
      p = this.#get(releaseId, size).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, p);
    }
    return p;
  }

  async #get(releaseId: number, size: CoverSize): Promise<{ file: string; mimeType: string } | null> {
    await mkdir(this.#dir, { recursive: true });
    const cached = (await this.#cached(`${releaseId}-${size}.`)) ?? (await this.#cached(`${releaseId}-embedded.`));
    if (cached) return cached;

    const release = this.d.library.getReleaseForArtwork(releaseId);
    if (!release) return null;
    const now = this.d.now?.() ?? Date.now();
    if (release.cover_status === 'none' && release.cover_checked_at && now - release.cover_checked_at < RETRY_NONE_AFTER_MS) return null;

    const base = this.d.baseUrl ?? 'https://coverartarchive.org';
    const urls = [
      release.mbid && `${base}/release/${release.mbid}/front-${size}`,
      release.release_group_mbid && `${base}/release-group/${release.release_group_mbid}/front-${size}`,
    ].filter((u): u is string => Boolean(u));
    for (const url of urls) {
      const img = await this.#download(url);
      if (img) {
        this.d.library.setCoverStatus(releaseId, 'caa');
        return this.#store(`${releaseId}-${size}`, img);
      }
    }

    for (const f of this.d.library.releaseFiles(releaseId)) {
      try {
        const provider = this.d.sources.instance(f.source_id);
        const art = await provider.readArtwork?.(f.file_id, { signal: AbortSignal.timeout(15_000) });
        if (art) {
          this.d.library.setCoverStatus(releaseId, 'embedded');
          return this.#store(`${releaseId}-embedded`, { data: Buffer.from(art.data), mimeType: art.mimeType });
        }
      } catch {
        // try the next file
      }
    }
    this.d.library.setCoverStatus(releaseId, 'none');
    return null;
  }

  async #download(url: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
      const res = await (this.d.fetch ?? fetch)(url, {
        headers: { 'User-Agent': this.d.userAgent },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!res.ok || !EXT[mimeType]) {
        await res.body?.cancel();
        return null;
      }
      return { data: Buffer.from(await res.arrayBuffer()), mimeType };
    } catch (err) {
      this.d.logger.debug({ error: (err as Error).message }, 'cover art download failed');
      return null;
    }
  }

  async #store(name: string, img: { data: Buffer; mimeType: string }): Promise<{ file: string; mimeType: string }> {
    const file = path.join(this.#dir, `${name}.${EXT[img.mimeType] ?? 'img'}`);
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, img.data);
    await rename(tmp, file);
    return { file, mimeType: img.mimeType };
  }

  async #cached(prefix: string): Promise<{ file: string; mimeType: string } | null> {
    for (const [mimeType, ext] of Object.entries(EXT)) {
      const file = path.join(this.#dir, `${prefix}${ext}`);
      if (await access(file).then(() => true, () => false)) return { file, mimeType };
    }
    return null;
  }

  /** Drop cached images for a release (after a re-match changes its identity). */
  async forget(releaseId: number): Promise<void> {
    const entries = await readdir(this.#dir).catch(() => [] as string[]);
    await Promise.all(entries.filter((e) => e.startsWith(`${releaseId}-`)).map((e) => unlink(path.join(this.#dir, e)).catch(() => undefined)));
  }

}
