import { parseBuffer } from 'music-metadata';
import type { FileTags, ResolvedStream } from '../providers/types.js';
import { fromMusicMetadata } from './tags.js';

export const PROBE_BYTES = 256 * 1024;

/**
 * Read the first 256 KB of a remote file with a Range request and parse
 * whatever tags live there (ID3v2, FLAC/Vorbis comments, most MP4s with
 * moov-first). Returns null when there's nothing usable.
 */
export async function probeRemoteTags(
  fetchFn: typeof fetch | ((url: string, init: RequestInit) => Promise<Response>),
  stream: ResolvedStream,
  hint: { mimeType?: string | null; size?: number | null },
  signal: AbortSignal,
): Promise<FileTags | null> {
  if (!/^https?:/.test(stream.url)) return null;
  const res = await fetchFn(stream.url, {
    headers: { ...(stream.headers ?? {}), Range: `bytes=0-${PROBE_BYTES - 1}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const type = res.headers.get('content-type') ?? '';
  if (/^(text\/|application\/(json|xml))/.test(type)) {
    await res.body?.cancel();
    return null;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  try {
    const meta = await parseBuffer(
      buf.subarray(0, PROBE_BYTES),
      { mimeType: hint.mimeType ?? stream.mimeType ?? '', ...(hint.size ? { size: hint.size } : {}) },
      { skipCovers: true, skipPostHeaders: true },
    );
    return fromMusicMetadata(meta);
  } catch {
    return null;
  }
}
