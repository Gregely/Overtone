import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveKey } from './keys.js';
import { hashPassword, verifyPassword } from './password.js';
import { SecretBox } from './secret-box.js';
import { signJwt, signUrlToken, verifyJwt, verifyUrlToken } from './tokens.js';

const master = randomBytes(32);

describe('SecretBox', () => {
  const box = new SecretBox(deriveKey(master, 'secrets'));

  it('round-trips and produces different ciphertexts each time', () => {
    const a = box.sealJson({ apiKey: 'sk-123' }, 'src1');
    const b = box.sealJson({ apiKey: 'sk-123' }, 'src1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-123');
    expect(box.openJson(a, 'src1')).toEqual({ apiKey: 'sk-123' });
  });

  it('refuses ciphertext bound to another row, tampered data, or another key', () => {
    const sealed = box.seal('secret', 'src1');
    expect(() => box.open(sealed, 'src2')).toThrow();
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[raw.length - 1]! ^= 1;
    expect(() => box.open(`v1:${raw.toString('base64')}`, 'src1')).toThrow();
    expect(() => new SecretBox(randomBytes(32)).open(sealed, 'src1')).toThrow();
  });
});

describe('keys', () => {
  it('derives independent keys per purpose', () => {
    expect(deriveKey(master, 'secrets').equals(deriveKey(master, 'access-token'))).toBe(false);
    expect(deriveKey(master, 'secrets').equals(deriveKey(master, 'secrets'))).toBe(true);
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong horse', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('JWT', () => {
  const key = deriveKey(master, 'access-token');
  const claims = { sub: 7, adm: true, iat: 100, exp: 200 };

  it('verifies valid tokens and rejects expired ones', () => {
    const t = signJwt(claims, key);
    expect(verifyJwt(t, key, 150)).toEqual(claims);
    expect(verifyJwt(t, key, 200)).toBeNull();
  });

  it('rejects tampering, other keys, and alg=none', () => {
    const t = signJwt(claims, key);
    const [h, , s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 1, typ: 'access' })).toString('base64url');
    expect(verifyJwt(`${h}.${forged}.${s}`, key, 150)).toBeNull();
    expect(verifyJwt(t, deriveKey(randomBytes(32), 'access-token'), 150)).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifyJwt(`${none}.${t.split('.')[1]}.`, key, 150)).toBeNull();
  });
});

describe('URL tokens', () => {
  const key = deriveKey(master, 'stream-token');
  it('verifies fields and rejects modification', () => {
    const t = signUrlToken([1, 42, 999], key);
    expect(verifyUrlToken(t, key, 3)).toEqual(['1', '42', '999']);
    expect(verifyUrlToken(t.replace('.42.', '.43.'), key, 3)).toBeNull();
    expect(verifyUrlToken(t, key, 2)).toBeNull();
    expect(verifyUrlToken(t, deriveKey(master, 'artwork-token'), 3)).toBeNull();
  });
});
