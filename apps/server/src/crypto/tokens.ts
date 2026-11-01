import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer, data: string, bytes?: number): Buffer {
  const mac = createHmac('sha256', key).update(data).digest();
  return bytes ? mac.subarray(0, bytes) : mac;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Minimal HS256 JWT (access tokens) ──────────────────────────────────────

export interface AccessClaims {
  sub: number;
  adm: boolean;
  iat: number;
  exp: number;
}

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export function signJwt(claims: AccessClaims, key: Buffer): string {
  const body = Buffer.from(JSON.stringify({ ...claims, typ: 'access' })).toString('base64url');
  const signingInput = `${JWT_HEADER}.${body}`;
  return `${signingInput}.${hmac(key, signingInput).toString('base64url')}`;
}

export function verifyJwt(token: string, key: Buffer, nowSec: number): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  if (header !== JWT_HEADER) return null; // pins alg=HS256; rejects "none" and alg confusion
  if (!safeEqual(Buffer.from(sig, 'base64url'), hmac(key, `${header}.${body}`))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<AccessClaims> & { typ?: string };
    if (c.typ !== 'access' || typeof c.sub !== 'number' || typeof c.exp !== 'number' || c.exp <= nowSec) return null;
    return { sub: c.sub, adm: Boolean(c.adm), iat: c.iat ?? 0, exp: c.exp };
  } catch {
    return null;
  }
}

// ── Compact signed URL tokens (stream + artwork) ───────────────────────────
// <audio>, <img> and the Android native player can't send Authorization
// headers, so these URLs carry a short-lived, narrowly scoped HMAC token.

/** Sign `fields` (no dots allowed) → "f1.f2.….sig". */
export function signUrlToken(fields: Array<string | number>, key: Buffer): string {
  const payload = fields.join('.');
  return `${payload}.${hmac(key, payload, 18).toString('base64url')}`;
}

/** Returns the fields if the signature is valid, else null. Caller checks expiry/scope. */
export function verifyUrlToken(token: string, key: Buffer, fieldCount: number): string[] | null {
  const parts = token.split('.');
  if (parts.length !== fieldCount + 1) return null;
  const sig = parts.pop()!;
  const expected = hmac(key, parts.join('.'), 18);
  return safeEqual(Buffer.from(sig, 'base64url'), expected) ? parts : null;
}
