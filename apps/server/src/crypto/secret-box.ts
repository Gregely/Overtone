import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM for provider secrets at rest. `aad` binds a ciphertext to its
 * row (the source id), so a blob copied to another source fails to decrypt.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    this.#key = key;
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  open(sealed: string, aad: string): string {
    const [version, payload] = sealed.split(':', 2);
    if (version !== VERSION || !payload) throw new Error('Unsupported secret format');
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < 28) throw new Error('Corrupt secret');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  }

  sealJson(value: Record<string, string>, aad: string): string {
    return this.seal(JSON.stringify(value), aad);
  }

  openJson(sealed: string | null, aad: string): Record<string, string> {
    if (!sealed) return {};
    return JSON.parse(this.open(sealed, aad)) as Record<string, string>;
  }
}
