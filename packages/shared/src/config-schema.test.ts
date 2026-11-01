import { describe, expect, it } from 'vitest';
import { assertValidSchema, toPublicConfig, validateConfig, type ConfigSchema } from './config-schema.js';

const schema: ConfigSchema = {
  fields: [
    { key: 'url', type: 'url', label: 'URL', required: true },
    { key: 'username', type: 'string', label: 'User', default: 'admin' },
    { key: 'password', type: 'secret', label: 'Password', required: true },
    { key: 'token', type: 'secret', label: 'Token' },
    { key: 'limit', type: 'number', label: 'Limit', min: 1, max: 10, integer: true, default: 5 },
    { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
    { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' },
    { key: 'refresh', type: 'secret', label: 'Refresh', hidden: true },
  ],
};

describe('validateConfig', () => {
  it('applies defaults and separates secrets', () => {
    const r = validateConfig(schema, { url: 'https://x.test', password: ' hunter2 ' });
    expect(r).toEqual({
      ok: true,
      values: { url: 'https://x.test', username: 'admin', limit: 5, enabled: true, mode: 'a' },
      secrets: { password: 'hunter2' },
      clearedSecrets: [],
    });
  });

  it('reports required, type and range errors per field', () => {
    const r = validateConfig(schema, { url: 'ftp://nope', limit: '11', enabled: 'maybe', mode: 'c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toMatchObject({
      url: expect.any(String),
      password: 'Required',
      limit: expect.stringContaining('10'),
      enabled: expect.any(String),
      mode: 'Not a valid option',
    });
  });

  it('coerces form strings', () => {
    const r = validateConfig(schema, { url: 'http://x', password: 'p', limit: '3', enabled: 'false' });
    expect(r.ok && r.values).toMatchObject({ limit: 3, enabled: false });
  });

  it('rejects non-integers for integer fields', () => {
    const r = validateConfig(schema, { url: 'http://x', password: 'p', limit: 2.5 });
    expect(r.ok).toBe(false);
  });

  it('keeps an existing secret when omitted or empty', () => {
    for (const password of [undefined, '']) {
      const r = validateConfig(schema, { url: 'http://x', password }, { existingSecrets: ['password'] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.secrets).toEqual({});
    }
  });

  it('clears optional secrets with null but refuses to clear required ones', () => {
    const r = validateConfig(schema, { url: 'http://x', token: null }, { existingSecrets: ['password', 'token'] });
    expect(r.ok && r.clearedSecrets).toEqual(['token']);
    const r2 = validateConfig(schema, { url: 'http://x', password: null }, { existingSecrets: ['password'] });
    expect(r2.ok).toBe(false);
  });

  it('rejects unknown keys and hidden fields from users', () => {
    const r = validateConfig(schema, { url: 'http://x', password: 'p', evil: 1, refresh: 'r' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['evil', 'refresh']);
  });

  it('allows hidden fields for server-internal writes', () => {
    const r = validateConfig(schema, { url: 'http://x', password: 'p', refresh: 'r' }, { allowHidden: true });
    expect(r.ok && r.secrets).toEqual({ password: 'p', refresh: 'r' });
  });
});

describe('toPublicConfig', () => {
  it('never exposes secret or hidden values', () => {
    const pub = toPublicConfig(schema, { url: 'http://x', password: 'leak', refresh: 'leak' } as never, ['password', 'refresh']);
    expect(JSON.stringify(pub)).not.toContain('leak');
    expect(pub).toEqual({ values: { url: 'http://x' }, secretsSet: ['password'] });
  });
});

describe('assertValidSchema', () => {
  it('rejects duplicate and malformed keys', () => {
    expect(() => assertValidSchema({ fields: [{ key: 'a', type: 'string', label: 'A' }, { key: 'a', type: 'string', label: 'A' }] })).toThrow(/duplicate/);
    expect(() => assertValidSchema({ fields: [{ key: '1a', type: 'string', label: 'A' }] })).toThrow(/invalid/);
    expect(() => assertValidSchema({ fields: [{ key: 's', type: 'select', label: 'S', options: [{ value: 'x', label: 'X' }], default: 'y' }] })).toThrow(/default/);
  });
});
