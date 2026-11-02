/**
 * Portable crypto helpers: WebCrypto (available as globalThis.crypto in
 * Node 20+, browsers and the Android WebView) plus a pure-JS MD5, which
 * WebCrypto deliberately lacks but the Subsonic API requires for its salted
 * token (t = md5(password + salt)).
 */

const enc = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64Url(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe random id (`bytes` of entropy). */
export function randomId(bytes = 16): string {
  return toBase64Url(randomBytes(bytes));
}

export async function sha256Hex(s: string | Uint8Array): Promise<string> {
  const data = typeof s === 'string' ? enc.encode(s) : s;
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource)));
}

// ── MD5 (RFC 1321) ──────────────────────────────────────────────────────────
// Only for protocol compatibility (Subsonic). Never use it for security.

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5Hex(input: string | Uint8Array): string {
  const msg = typeof input === 'string' ? enc.encode(input) : input;
  const len = msg.length;
  const padded = new Uint8Array((((len + 8) >>> 6) + 1) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) (F = (B & C) | (~B & D)), (g = i);
      else if (i < 32) (F = (D & B) | (~D & C)), (g = (5 * i + 1) % 16);
      else if (i < 48) (F = B ^ C ^ D), (g = (3 * i + 5) % 16);
      else (F = C ^ (B | ~D)), (g = (7 * i) % 16);
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]!) | (F >>> (32 - S[i]!)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((w, i) => ov.setUint32(i * 4, w, true));
  return toHex(out);
}
