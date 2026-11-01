export type ByteRange = { start: number; end: number };

/**
 * Parse a single-range `Range` header against a known size.
 *  - undefined → no/unsupported header (serve the whole file, 200)
 *  - null      → unsatisfiable (416)
 * Multi-range requests are answered with the full body, which RFC 9110 allows.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, s, e] = m as unknown as [string, string, string];
  if (s === '' && e === '') return undefined;
  if (size === 0) return null;
  if (s === '') {
    const suffix = Number(e);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(s);
  const end = e === '' ? size - 1 : Math.min(Number(e), size - 1);
  if (start >= size || start > end) return null;
  return { start, end };
}
