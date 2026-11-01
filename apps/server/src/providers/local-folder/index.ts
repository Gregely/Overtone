/**
 * LocalFolder — plays files from a directory on the server (e.g. the /music
 * volume in Docker). Streams via file:// URLs, which the streaming layer
 * serves with HTTP Range support.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { audioMimeType, isAudioFile } from '@overtone/shared';
import { parseFile, selectCover } from 'music-metadata';
import { fromMusicMetadata } from '../../metadata/tags.js';
import { ProviderError } from '../errors.js';
import type { Disposable, FileTags, LibraryChange, ProviderContext, ProviderPlugin, SourceFile, SourceProvider } from '../types.js';

export type LocalFolderConfig = {
  path: string;
  watch: boolean;
  followSymlinks: boolean;
};

export const localFolderPlugin: ProviderPlugin<LocalFolderConfig> = {
  manifest: {
    id: 'local-folder',
    name: 'Local folder',
    description: 'Music files in a folder on the server.',
    category: 'local',
    capabilities: { watch: true, testConnection: true, redirectable: false },
    configSchema: {
      fields: [
        {
          key: 'path',
          type: 'path',
          label: 'Folder',
          required: true,
          default: '/music',
          help: 'Absolute path as seen by the server. In Docker this is the mounted /music volume.',
        },
        { key: 'watch', type: 'boolean', label: 'Watch for changes', default: true },
        { key: 'followSymlinks', type: 'boolean', label: 'Follow symbolic links', default: false },
      ],
    },
  },
  create(config, ctx) {
    return new LocalFolderProvider(config, ctx);
  },
};

export class LocalFolderProvider implements SourceProvider {
  readonly root: string;
  readonly #followSymlinks: boolean;
  readonly #watch: boolean;
  readonly #ctx: ProviderContext;
  #realRoot: Promise<string> | undefined;
  #watcher: FSWatcher | undefined;

  constructor(config: LocalFolderConfig, ctx: ProviderContext) {
    if (!path.isAbsolute(config.path)) throw new ProviderError('config', 'Folder must be an absolute path');
    this.root = path.resolve(config.path);
    this.#followSymlinks = Boolean(config.followSymlinks);
    this.#watch = config.watch !== false;
    this.#ctx = ctx;
  }

  #getRealRoot(): Promise<string> {
    this.#realRoot ??= realpath(this.root).catch((err: NodeJS.ErrnoException) => {
      this.#realRoot = undefined;
      throw err.code === 'ENOENT'
        ? new ProviderError('config', `Folder ${this.root} does not exist`)
        : new ProviderError('config', `Folder ${this.root} is not readable (${err.code})`);
    });
    return this.#realRoot;
  }

  async *listLibrary({ signal }: { signal: AbortSignal }): AsyncIterable<SourceFile> {
    const realRoot = await this.#getRealRoot();
    const visited = new Set<string>([realRoot]);
    const stack: string[] = [''];
    while (stack.length) {
      signal.throwIfAborted();
      const rel = stack.pop()!;
      let dir;
      try {
        dir = await opendir(path.join(this.root, rel));
      } catch (err) {
        if (rel === '') throw new ProviderError('config', `Cannot read ${this.root} (${(err as NodeJS.ErrnoException).code})`);
        this.#ctx.logger.warn('skipping unreadable directory', { dir: rel });
        continue;
      }
      const subdirs: string[] = [];
      for await (const entry of dir) {
        if (entry.name.startsWith('.')) continue; // hidden files, .AppleDouble, @eaDir-like dot dirs
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          if (!this.#followSymlinks) continue;
          try {
            const target = await realpath(path.join(this.root, childRel));
            const s = await stat(target);
            if (s.isDirectory()) {
              if (visited.has(target)) continue; // symlink loop
              visited.add(target);
            }
            isDir = s.isDirectory();
            isFile = s.isFile();
          } catch {
            continue; // dangling link
          }
        }
        if (isDir) subdirs.push(childRel);
        else if (isFile && isAudioFile(entry.name)) {
          try {
            const s = await stat(path.join(this.root, childRel));
            const mimeType = audioMimeType(entry.name);
            yield {
              id: childRel,
              name: entry.name,
              path: childRel,
              size: s.size,
              modifiedAt: s.mtime,
              ...(mimeType ? { mimeType } : {}),
            };
          } catch {
            // vanished between readdir and stat
          }
        }
      }
      // Sorted, reverse-pushed → depth-first in name order (stable scans, nicer logs).
      subdirs.sort((a, b) => b.localeCompare(a));
      stack.push(...subdirs);
    }
  }

  /** Resolve a file id to an absolute path, refusing anything outside the root. */
  async resolvePath(fileId: string): Promise<string> {
    if (!fileId || fileId.includes('\0') || path.isAbsolute(fileId)) throw new ProviderError('not_found', 'File not found');
    const full = path.resolve(this.root, ...fileId.split('/'));
    if (!isInside(this.root, full)) throw new ProviderError('not_found', 'File not found');
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      throw new ProviderError('not_found', 'File not found');
    }
    if (!this.#followSymlinks && !isInside(await this.#getRealRoot(), real)) throw new ProviderError('not_found', 'File not found');
    return real;
  }

  async resolveStream(fileId: string) {
    const full = await this.resolvePath(fileId);
    const s = await stat(full).catch(() => null);
    if (!s?.isFile()) throw new ProviderError('not_found', 'File not found');
    const mimeType = audioMimeType(fileId);
    return { url: pathToFileURL(full).href, size: s.size, redirectSafe: false, ...(mimeType ? { mimeType } : {}) };
  }

  async readTags(fileId: string): Promise<FileTags | null> {
    const full = await this.resolvePath(fileId);
    try {
      return fromMusicMetadata(await parseFile(full, { skipCovers: true }));
    } catch (err) {
      this.#ctx.logger.debug('could not parse tags', { fileId, error: (err as Error).message });
      return null;
    }
  }

  async readArtwork(fileId: string) {
    const full = await this.resolvePath(fileId);
    try {
      const meta = await parseFile(full, { skipPostHeaders: true });
      const pic = selectCover(meta.common.picture);
      return pic ? { data: pic.data, mimeType: pic.format.includes('/') ? pic.format : `image/${pic.format}` } : null;
    } catch {
      return null;
    }
  }

  async testConnection() {
    try {
      const real = await this.#getRealRoot();
      const s = await stat(real);
      if (!s.isDirectory()) return { ok: false, message: `${this.root} is not a folder` };
      let count = 0;
      const ac = new AbortController();
      for await (const _ of this.listLibrary({ signal: ac.signal })) {
        if (++count >= 1000) break;
      }
      return {
        ok: true,
        message: count === 0 ? `Folder is readable but contains no audio files` : `Found ${count >= 1000 ? '1000+' : count} audio files`,
      };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, message: err.message };
      throw err;
    }
  }

  watch(onChange: (change: LibraryChange) => void): Disposable {
    if (!this.#watch) return { dispose() {} };
    try {
      // Recursive fs.watch is supported on Linux since Node 20 (inotify). Network
      // mounts (NFS/SMB) often deliver no events; periodic scans cover those.
      this.#watcher = fsWatch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        const name = filename?.toString() ?? '';
        if (name && !name.split(path.sep).some((s) => s.startsWith('.'))) onChange({ kind: 'unknown' });
      });
      this.#watcher.on('error', (err) => this.#ctx.logger.warn('folder watcher stopped', { error: err.message }));
    } catch (err) {
      this.#ctx.logger.warn('could not watch folder; relying on periodic scans', { error: (err as Error).message });
    }
    return { dispose: () => this.#closeWatcher() };
  }

  #closeWatcher(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  async dispose(): Promise<void> {
    this.#closeWatcher();
  }
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
