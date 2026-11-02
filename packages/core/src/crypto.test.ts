import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromBase64, md5Hex, randomId, sha256Hex, toBase64, toBase64Url } from './crypto.js';

describe('portable crypto', () => {
  it('md5 matches RFC 1321 vectors and Node for UTF-8 and long input', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    for (const s of ['sesamec19b2d', 'pässwörd✓🎵', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)]) {
      expect(md5Hex(s)).toBe(createHash('md5').update(s, 'utf8').digest('hex'));
    }
  });

  it('sha256 matches Node', async () => {
    expect(await sha256Hex('https://example.com/a')).toBe(createHash('sha256').update('https://example.com/a').digest('hex'));
  });

  it('base64 round-trips and ids are URL-safe', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 128]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
    expect(randomId(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
