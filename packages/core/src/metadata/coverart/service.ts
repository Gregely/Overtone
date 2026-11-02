import type { BaseLogger } from '../../logging.js';
import type { LibraryRepo } from '../../library/repo.js';
import type { BlobStore, HttpFetch } from '../../platform/types.js';
import type { SourceManager } from '../../sources/manager.js';

export type CoverSize = 250 | 500 | 1200;
export const COVER_SIZES: readonly CoverSize[] = [250, 500, 1200];

export const COVER_ART_ARCHIVE = 'https://coverartarchive.org';

const RETRY_NONE_AFTER_MS = 7 * 24 * 3600 * 1000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface CoverImage {
  data: Uint8Array;
  mimeType: string;
}

export interface CoverArtDeps {
  blobs: BlobStore;
  library: LibraryRepo;
  sources: SourceManager;
  logger: BaseLogger;
  userAgent: string;
  fetch?: HttpFetch;
  baseUrl?: string;
  now?: () => number;
}

/** Blob key for a release's cover at one size, or its embedded picture. */
export const coverKey = (releaseId: number, size: CoverSize | 'embedded') => `artwork/${releaseId}-${size}`;

/**
 * Album artwork: Cover Art Archive first (release, then release group), then
 * embedded pictures from the files. Images are cached in the BlobStore
 * (server: <dataDir>/artwork; Android: app storage) so each is fetched once.
 */
export class CoverArtService {
  readonly #inflight = new Map<string, Promise<CoverImage | null>>();

  constructor(private readonly d: CoverArtDeps) {}

  async get(releaseId: number, size: CoverSize): Promise<CoverImage | null> {
    const key = `${releaseId}-${size}`;
    let p = this.#inflight.get(key);
    if (!p) {
      p = this.#get(releaseId, size).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, p);
    }
    return p;
  }

  async #get(releaseId: number, size: CoverSize): Promise<CoverImage | null> {
    const cached = (await this.d.blobs.get(coverKey(releaseId, size))) ?? (await this.d.blobs.get(coverKey(releaseId, 'embedded')));
    if (cached) return cached;

    const release = await this.d.library.getReleaseForArtwork(releaseId);
    if (!release) return null;
    const now = this.d.now?.() ?? Date.now();
    if (release.cover_status === 'none' && release.cover_checked_at && now - release.cover_checked_at < RETRY_NONE_AFTER_MS) return null;

    const base = this.d.baseUrl ?? COVER_ART_ARCHIVE;
    const urls = [
      release.mbid && `${base}/release/${release.mbid}/front-${size}`,
      release.release_group_mbid && `${base}/release-group/${release.release_group_mbid}/front-${size}`,
    ].filter((u): u is string => Boolean(u));
    for (const url of urls) {
      const img = await this.#download(url);
      if (img) {
        await this.d.library.setCoverStatus(releaseId, 'caa');
        await this.d.blobs.put(coverKey(releaseId, size), img.data, img.mimeType);
        return img;
      }
    }

    const embedded = await this.embedded(releaseId);
    if (embedded) return embedded;
    await this.d.library.setCoverStatus(releaseId, 'none');
    return null;
  }

  /** Read and cache a release's embedded picture from its files (local sources first). */
  async embedded(releaseId: number): Promise<CoverImage | null> {
    for (const f of await this.d.library.releaseFiles(releaseId)) {
      try {
        const provider = await this.d.sources.instance(f.source_id);
        const art = await provider.readArtwork?.(f.file_id, { signal: AbortSignal.timeout(15_000) });
        const mimeType = art?.mimeType.toLowerCase().replace('image/jpg', 'image/jpeg') ?? '';
        if (art && IMAGE_TYPES.has(mimeType)) {
          await this.d.library.setCoverStatus(releaseId, 'embedded');
          await this.d.blobs.put(coverKey(releaseId, 'embedded'), art.data, mimeType);
          return { data: art.data, mimeType };
        }
      } catch {
        // try the next file
      }
    }
    return null;
  }

  async #download(url: string): Promise<CoverImage | null> {
    try {
      const res = await (this.d.fetch ?? ((u, i) => globalThis.fetch(u, i)))(url, {
        headers: { 'User-Agent': this.d.userAgent },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!res.ok || !IMAGE_TYPES.has(mimeType)) {
        await res.body?.cancel();
        return null;
      }
      return { data: new Uint8Array(await res.arrayBuffer()), mimeType };
    } catch (err) {
      this.d.logger.debug({ error: (err as Error).message }, 'cover art download failed');
      return null;
    }
  }

  /**
   * Standalone mode shows Cover Art Archive images straight from their URLs,
   * but albums MusicBrainz doesn't know only have the picture inside their
   * files. Extract and cache those in the background (a few at a time).
   * Returns how many releases were looked at.
   */
  async prefetchEmbedded(limit = 25): Promise<number> {
    const releases = await this.d.library.localReleasesWithUnknownCover(limit);
    for (const r of releases) {
      if (!(await this.embedded(r.id))) await this.d.library.setCoverStatus(r.id, 'none');
    }
    return releases.length;
  }

  /** Drop every cached image (library reset / import). */
  async forgetAll(): Promise<void> {
    await this.d.blobs.deletePrefix('artwork/');
  }

  /** Drop cached images for a release (after a re-match changes its identity). */
  async forget(releaseId: number): Promise<void> {
    await this.d.blobs.deletePrefix(`artwork/${releaseId}-`);
  }
}
