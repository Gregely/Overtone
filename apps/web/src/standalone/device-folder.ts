/**
 * "This device": music in folders the user picked with Android's folder
 * picker (Storage Access Framework). No storage permission is needed: the
 * app gets persisted read access to exactly the chosen folders.
 *
 * - Listing walks the folder tree natively, a page at a time.
 * - Tags are parsed with music-metadata from small ranged reads (64 KB
 *   blocks, capped per file); files are never loaded whole.
 * - Playback uses the file's content:// URI directly in the native player.
 * - If the user revokes access (or the folder is deleted/unmounted), listing
 *   fails with a clear message and the scanner keeps the existing library
 *   instead of wiping it; the source shows the error until the folder is
 *   picked again.
 */
import { isAudioFile, audioMimeType } from '@overtone/shared';
import { fromBase64, fromMusicMetadata, parseRanged, ProviderError, type ProviderPlugin, type SourceFile } from '@overtone/core';
import type { DeviceFolderPlugin } from './plugins';

export type DeviceFolderConfig = { folder: string; folderName: string };

/** content:// URI of a document inside a picked tree (DocumentsContract.buildDocumentUriUsingTree). */
export function documentUri(treeUri: string, documentId: string): string {
  // Uri.encode() and encodeURIComponent() leave the same characters unescaped.
  return `${treeUri.replace(/\/+$/, '')}/document/${encodeURIComponent(documentId)}`;
}

function revoked(err: unknown, name: string): ProviderError | null {
  const code = (err as { code?: string })?.code;
  if (code === 'PERMISSION_REVOKED' || code === 'NOT_FOUND') {
    return new ProviderError(
      'auth',
      code === 'NOT_FOUND'
        ? `The folder “${name}” is gone (moved, deleted, or its storage was removed). Choose it again in Settings › Sources.`
        : `Overtone can no longer read “${name}” (access was removed). Choose the folder again in Settings › Sources.`,
    );
  }
  return null;
}

export function createDeviceFolderPlugin(native: DeviceFolderPlugin): ProviderPlugin<DeviceFolderConfig> {
  return {
    manifest: {
      id: 'device-folder',
      name: 'This device',
      description: 'Music files in a folder on this phone (internal storage or SD card).',
      category: 'local',
      capabilities: { testConnection: true, redirectable: false },
      configSchema: {
        fields: [
          {
            key: 'folder',
            type: 'string',
            label: 'Folder',
            required: true,
            widget: 'device-folder',
            labelKey: 'folderName',
            help: 'Overtone gets read-only access to this folder and its subfolders, nothing else.',
          },
          { key: 'folderName', type: 'string', label: 'Folder name' },
        ],
      },
    },
    create(config) {
      const tree = config.folder;
      const name = config.folderName || 'the folder';
      const sizes = new Map<string, number>();
      const uri = (id: string) => documentUri(tree, id);
      const call = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (err) {
          throw revoked(err, name) ?? new ProviderError('unavailable', `Couldn't read “${name}”: ${(err as Error).message}`);
        }
      };
      const sizeOf = async (id: string) => sizes.get(id) ?? (await call(() => native.stat({ uri: uri(id) }))).size;

      return {
        async *listLibrary({ signal }) {
          let cursor: string | null = null;
          do {
            signal.throwIfAborted();
            const page: { files: Array<{ id: string; name: string; path: string; size: number; modified: number; mime: string | null }>; cursor: string | null } =
              await call(() => native.list({ uri: tree, cursor, limit: 500 }));
            for (const f of page.files) {
              if (!isAudioFile(f.name)) continue;
              sizes.set(f.id, f.size);
              const file: SourceFile = { id: f.id, name: f.name, path: f.path, size: f.size };
              if (f.modified > 0) file.modifiedAt = new Date(f.modified);
              const mime = f.mime && f.mime.startsWith('audio/') ? f.mime : audioMimeType(f.name);
              if (mime) file.mimeType = mime;
              yield file;
            }
            cursor = page.cursor;
          } while (cursor);
        },

        async resolveStream(fileId) {
          // Local files don't expire and carry no credentials.
          return { url: uri(fileId), mimeType: audioMimeType(fileId) ?? undefined, redirectSafe: false };
        },

        async readTags(fileId, { signal }) {
          const size = await sizeOf(fileId);
          const meta = await parseRanged(
            async (offset, length) => {
              signal.throwIfAborted();
              return fromBase64((await call(() => native.read({ uri: uri(fileId), offset, length }))).data);
            },
            { size, mimeType: audioMimeType(fileId) ?? null, path: fileId },
            { skipCovers: true, duration: false },
          );
          return fromMusicMetadata(meta);
        },

        async readArtwork(fileId) {
          const pic = await call(() => native.picture({ uri: uri(fileId) }));
          if (pic.data && pic.mimeType) return { data: fromBase64(pic.data), mimeType: pic.mimeType };
          return null;
        },

        async testConnection() {
          try {
            await native.list({ uri: tree, cursor: null, limit: 20 });
            return { ok: true, message: `“${name}” is readable.` };
          } catch (err) {
            return { ok: false, message: (revoked(err, name) ?? (err as Error)).message };
          }
        },
      };
    },
  };
}
