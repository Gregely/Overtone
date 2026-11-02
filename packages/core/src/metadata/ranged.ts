/**
 * Tag parsing from random-access reads, without loading whole files.
 *
 * `parseRanged()` gives music-metadata a tokenizer whose reads become small
 * ranged reads (`readAt(offset, length)`), cached in 64 KB blocks. Used for
 * files on the device (Storage Access Framework reads through a native
 * plugin) and usable for anything else that supports byte ranges.
 */
import { parseFromTokenizer, selectCover, type IAudioMetadata, type IOptions } from 'music-metadata';
import { AbstractTokenizer, EndOfStreamError, type IFileInfo, type IReadChunkOptions } from 'strtok3';

export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

const BLOCK = 64 * 1024;
/** Hard cap on bytes read per file (a corrupt header must not stream a whole FLAC). */
const DEFAULT_MAX_READ = 16 * 1024 * 1024;

class RangedTokenizer extends AbstractTokenizer {
  fileInfo: IFileInfo;
  readonly #read: RangeReader;
  readonly #blocks = new Map<number, Promise<Uint8Array>>();
  readonly #maxRead: number;
  #bytesRead = 0;

  constructor(read: RangeReader, fileInfo: IFileInfo & { size: number }, maxRead: number) {
    super({ fileInfo });
    this.fileInfo = fileInfo;
    this.#read = read;
    this.#maxRead = maxRead;
  }

  supportsRandomAccess(): boolean {
    return true;
  }

  setPosition(position: number): void {
    this.position = position;
  }

  async readBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const o = this.normalizeOptions(buffer, options);
    const n = await this.peekBuffer(buffer, o);
    this.position = o.position + n;
    return n;
  }

  async peekBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const o = this.normalizeOptions(buffer, options);
    const size = this.fileInfo.size ?? 0;
    const want = Math.max(0, Math.min(size - o.position, o.length));
    if (!o.mayBeLess && want < o.length) throw new EndOfStreamError();
    let done = 0;
    while (done < want) {
      const pos = o.position + done;
      const blockStart = Math.floor(pos / BLOCK) * BLOCK;
      const block = await this.#block(blockStart);
      const from = pos - blockStart;
      const n = Math.min(block.length - from, want - done);
      if (n <= 0) break;
      buffer.set(block.subarray(from, from + n), done);
      done += n;
    }
    if (!o.mayBeLess && done < o.length) throw new EndOfStreamError();
    return done;
  }

  #block(start: number): Promise<Uint8Array> {
    let p = this.#blocks.get(start);
    if (!p) {
      const len = Math.min(BLOCK, (this.fileInfo.size ?? 0) - start);
      this.#bytesRead += len;
      if (this.#bytesRead > this.#maxRead) return Promise.reject(new EndOfStreamError());
      p = this.#read(start, len);
      this.#blocks.set(start, p);
      // Keep memory flat on long files: drop the oldest blocks.
      if (this.#blocks.size > 32) this.#blocks.delete(this.#blocks.keys().next().value!);
    }
    return p;
  }
}

export async function parseRanged(
  read: RangeReader,
  file: { size: number; mimeType?: string | null; path?: string },
  options: IOptions & { maxReadBytes?: number } = {},
): Promise<IAudioMetadata> {
  const { maxReadBytes, ...mm } = options;
  const tokenizer = new RangedTokenizer(
    read,
    { size: file.size, ...(file.mimeType ? { mimeType: file.mimeType } : {}), ...(file.path ? { path: file.path } : {}) },
    maxReadBytes ?? DEFAULT_MAX_READ,
  );
  try {
    return await parseFromTokenizer(tokenizer, mm);
  } finally {
    await tokenizer.close();
  }
}

export { selectCover };
