import { describe, expect, it, vi } from 'vitest';
import { cleartextProblem, isPrivateHost } from './server-url';
import { secureStore, type SecureStorageBackend } from './storage';

describe('secureStore (Android Keystore adapter)', () => {
  function backend(): SecureStorageBackend & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get: vi.fn(async ({ key }) => ({ value: data.get(key) ?? null })),
      set: vi.fn(async ({ key, value }) => void data.set(key, value)),
      remove: vi.fn(async ({ key }) => void data.delete(key)),
    };
  }

  it('maps the KeyValueStore interface onto the plugin', async () => {
    const b = backend();
    const store = secureStore(b);
    expect(await store.get('overtone.session')).toBeNull();
    await store.set('overtone.session', '{"tokens":1}');
    expect(b.set).toHaveBeenCalledWith({ key: 'overtone.session', value: '{"tokens":1}' });
    expect(await store.get('overtone.session')).toBe('{"tokens":1}');
    await store.remove('overtone.session');
    expect(b.data.size).toBe(0);
  });

  it('treats unreadable values as missing (the user signs in again)', async () => {
    const b = backend();
    b.get = vi.fn(async () => {
      throw new Error('KeyPermanentlyInvalidated');
    });
    expect(await secureStore(b).get('overtone.session')).toBeNull();
  });

  it('surfaces write failures (so a session is never silently unsaved)', async () => {
    const b = backend();
    b.set = vi.fn(async () => {
      throw new Error('keystore unavailable');
    });
    await expect(secureStore(b).set('k', 'v')).rejects.toThrow('keystore unavailable');
  });
});

describe('cleartext policy (Android)', () => {
  it.each([
    ['192.168.1.20', true],
    ['10.0.0.5', true],
    ['172.20.1.1', true],
    ['172.32.0.1', false],
    ['100.101.102.103', true], // Tailscale (CGNAT range)
    ['127.0.0.1', true],
    ['raspberrypi.local', true],
    ['nas.lan', true],
    ['pi.tail1234.ts.net', true],
    ['pi', true],
    ['music.example.com', false],
    ['8.8.8.8', false],
  ])('%s private=%s', (host, expected) => expect(isPrivateHost(host)).toBe(expected));

  it('allows https anywhere and http only to local hosts', () => {
    expect(cleartextProblem('https://music.example.com')).toBeNull();
    expect(cleartextProblem('http://192.168.1.20:4800')).toBeNull();
    expect(cleartextProblem('http://music.example.com')).toMatch(/only allowed to local-network addresses/);
  });
});
