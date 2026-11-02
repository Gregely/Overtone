import type { AuthTokensDto } from '@overtone/shared';
import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../platform/storage';
import { ApiError, HttpTransport, NetworkError } from './client';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const tokens = (n: number, accessExpiresInMs = 15 * 60_000): AuthTokensDto => ({
  accessToken: `access-${n}`,
  accessTokenExpiresAt: new Date(NOW + accessExpiresInMs).toISOString(),
  refreshToken: `refresh-${n}`,
  refreshTokenExpiresAt: new Date(NOW + 30 * 86400_000).toISOString(),
  user: { id: 1, username: 'me', isAdmin: true },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiErr = (status: number, code: string) => json({ error: { code, message: code } }, status);

async function make(stored: AuthTokensDto | null, handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const storage = memoryStore({ 'overtone.serverUrl': 'http://srv' });
  if (stored) await storage.set('overtone.session', JSON.stringify({ serverUrl: 'http://srv', tokens: stored }));
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  const client = new HttpTransport({ storage, serverUrl: null, fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW, withLock: (_n, fn) => fn() });
  await client.restore(null);
  return { client, fetch, storage };
}

const authHeader = (init: RequestInit) => (init.headers as Record<string, string>).authorization;

describe('HttpTransport', () => {
  it('sends the access token', async () => {
    const { client, fetch } = await make(tokens(1), () => json({ ok: 1 }));
    await client.get('/api/library/home');
    expect(fetch.mock.calls[0]![0]).toBe('http://srv/api/library/home');
    expect(authHeader(fetch.mock.calls[0]![1]!)).toBe('Bearer access-1');
  });

  it('refreshes an access token that is about to expire, once for concurrent requests', async () => {
    const { client, fetch, storage } = await make(tokens(1, 30_000), (url) => (url.endsWith('/auth/refresh') ? json(tokens(2)) : json({})));
    await Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
    expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([u]) => !String(u).endsWith('/refresh')).map(([, i]) => authHeader(i!))).toEqual([
      'Bearer access-2',
      'Bearer access-2',
      'Bearer access-2',
    ]);
    expect(JSON.parse((await storage.get('overtone.session'))!).tokens.refreshToken).toBe('refresh-2');
  });

  it("adopts tokens another tab already rotated instead of replaying the old refresh token", async () => {
    const { client, fetch, storage } = await make(tokens(1, 30_000), () => json({}));
    await storage.set('overtone.session', JSON.stringify({ serverUrl: 'http://srv', tokens: tokens(7) }));
    await client.get('/a');
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/auth/refresh'))).toBe(false);
    expect(authHeader(fetch.mock.calls[0]![1]!)).toBe('Bearer access-7');
  });

  it('retries once after refreshing when the server rejects the access token', async () => {
    let first = true;
    const { client, fetch } = await make(tokens(1), (url) => {
      if (url.endsWith('/auth/refresh')) return json(tokens(2));
      if (first) {
        first = false;
        return apiErr(401, 'invalid_access_token');
      }
      return json({ ok: true });
    });
    expect(await client.get('/a')).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('ends the session when the refresh token is rejected', async () => {
    const { client, storage } = await make(tokens(1, 0), () => apiErr(401, 'refresh_token_reused'));
    const expired = vi.fn();
    client.onSessionExpired = expired;
    await expect(client.get('/a')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalled();
    expect(client.hasSession()).toBe(false);
    expect(await storage.get('overtone.session')).toBeNull();
  });

  it('keeps the session when refresh fails because the network is down', async () => {
    const { client } = await make(tokens(1, 0), () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.get('/a')).rejects.toBeInstanceOf(NetworkError);
    expect(client.hasSession()).toBe(true);
    expect(client.reachability).toBe('unreachable');
  });

  it('treats a non-JSON response (proxy / captive portal) as unreachable', async () => {
    const { client } = await make(tokens(1), () => new Response('<html>login to wifi</html>', { status: 200 }));
    await expect(client.get('/a')).rejects.toBeInstanceOf(NetworkError);
  });

  it('maps error envelopes with field errors', async () => {
    const { client } = await make(tokens(1), () => json({ error: { code: 'validation_failed', message: 'bad', fields: { name: 'Required' } } }, 422));
    await expect(client.post('/api/sources', {})).rejects.toMatchObject({ status: 422, code: 'validation_failed', fields: { name: 'Required' } });
  });

  it('forgets tokens when switching servers', async () => {
    const { client, storage } = await make(tokens(1), () => json({}));
    await client.setServerUrl('https://other.example');
    expect(client.hasSession()).toBe(false);
    expect(await storage.get('overtone.serverUrl')).toBe('https://other.example');
    expect(client.url('/api/stream/1?st=x')).toBe('https://other.example/api/stream/1?st=x');
  });
});
