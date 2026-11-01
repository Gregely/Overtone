import { hkdfSync } from 'node:crypto';

export type KeyPurpose = 'secrets' | 'access-token' | 'stream-token' | 'artwork-token';

/** Derive an independent 32-byte subkey per purpose from the master key (HKDF-SHA256). */
export function deriveKey(master: Buffer, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', master, 'overtone/v1', purpose, 32));
}
