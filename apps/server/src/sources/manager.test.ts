import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderPlugin } from '../providers/types.js';
import { createHarness } from '../testing/app-harness.js';

const SECRET = 'sk_live_supersecret_123';
const testConnection = vi.fn(async () => ({ ok: true, message: 'ok' }));
const seenConfigs: Array<Record<string, unknown>> = [];

const keyed: ProviderPlugin = {
  manifest: {
    id: 'keyed',
    name: 'Keyed',
    description: '',
    category: 'server',
    capabilities: { testConnection: true },
    configSchema: {
      fields: [
        { key: 'url', type: 'url', label: 'URL', required: true },
        { key: 'apiKey', type: 'secret', label: 'API key', required: true },
        { key: 'refreshToken', type: 'secret', label: 'Refresh', hidden: true },
      ],
    },
  },
  create(config, ctx) {
    seenConfigs.push({ ...config });
    return {
      async *listLibrary() {},
      async resolveStream() {
        await ctx.updateSecrets({ refreshToken: 'rotated' });
        ctx.logger.info(`using key ${String(config.apiKey)}`);
        return { url: 'https://x.test' };
      },
      testConnection,
    };
  },
};

let h: Awaited<ReturnType<typeof createHarness>>;
afterEach(async () => {
  await h?.close();
  seenConfigs.length = 0;
  testConnection.mockClear();
});

describe('SourceManager via /api/sources', () => {
  it('encrypts secrets at rest and never returns them', async () => {
    h = await createHarness({ plugins: [keyed] });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: h.auth,
      payload: { providerId: 'keyed', name: 'Mine', config: { url: 'https://api.test', apiKey: SECRET } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(SECRET);
    const dto = res.json();
    expect(dto.config).toEqual({ values: { url: 'https://api.test' }, secretsSet: ['apiKey'] });

    const row = h.services.db.prepare('SELECT * FROM sources WHERE id = ?').get(dto.id) as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row.secrets_enc).toMatch(/^v1:/);

    const list = await h.app.inject({ url: '/api/sources', headers: h.auth });
    expect(list.body).not.toContain(SECRET);
  });

  it('keeps secrets on PATCH unless replaced or cleared, and validates', async () => {
    h = await createHarness({ plugins: [keyed] });
    const { id } = (
      await h.app.inject({ method: 'POST', url: '/api/sources', headers: h.auth, payload: { providerId: 'keyed', config: { url: 'https://a.test', apiKey: SECRET } } })
    ).json();

    const patched = await h.app.inject({ method: 'PATCH', url: `/api/sources/${id}`, headers: h.auth, payload: { config: { url: 'https://b.test' } } });
    expect(patched.json().config).toEqual({ values: { url: 'https://b.test' }, secretsSet: ['apiKey'] });
    await h.services.sources.instance(id);
    expect(seenConfigs.at(-1)).toMatchObject({ url: 'https://b.test', apiKey: SECRET });

    const cleared = await h.app.inject({ method: 'PATCH', url: `/api/sources/${id}`, headers: h.auth, payload: { config: { apiKey: null } } });
    expect(cleared.statusCode).toBe(422);
    expect(cleared.json().error.fields).toEqual({ 'config.apiKey': 'Required' });

    const hidden = await h.app.inject({ method: 'PATCH', url: `/api/sources/${id}`, headers: h.auth, payload: { config: { refreshToken: 'x' } } });
    expect(hidden.statusCode).toBe(422);
  });

  it('rejects redirect mode for providers whose links carry credentials', async () => {
    h = await createHarness({ plugins: [keyed] });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: h.auth,
      payload: { providerId: 'keyed', streamMode: 'redirect', config: { url: 'https://a.test', apiKey: 'k' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields.streamMode).toMatch(/proxied/);
  });

  it('tests saved sources using stored secrets and unsaved configs', async () => {
    h = await createHarness({ plugins: [keyed] });
    const { id } = (
      await h.app.inject({ method: 'POST', url: '/api/sources', headers: h.auth, payload: { providerId: 'keyed', config: { url: 'https://a.test', apiKey: SECRET } } })
    ).json();
    const saved = await h.app.inject({ method: 'POST', url: `/api/sources/${id}/test`, headers: h.auth, payload: {} });
    expect(saved.json()).toEqual({ ok: true, message: 'ok' });
    expect(seenConfigs.at(-1)).toMatchObject({ apiKey: SECRET });

    const unsaved = await h.app.inject({ method: 'POST', url: '/api/providers/keyed/test', headers: h.auth, payload: { config: { url: 'https://a.test' } } });
    expect(unsaved.statusCode).toBe(422);
  });

  it('persists rotated secrets and redacts secret values from provider logs', async () => {
    h = await createHarness({ plugins: [keyed] });
    const { id } = (
      await h.app.inject({ method: 'POST', url: '/api/sources', headers: h.auth, payload: { providerId: 'keyed', config: { url: 'https://a.test', apiKey: SECRET } } })
    ).json();
    await (await h.services.sources.instance(id)).resolveStream('f', { signal: new AbortController().signal });
    const dto = await h.services.sources.toDto(await h.services.sources.require(id));
    expect(dto.config.secretsSet).toEqual(['apiKey']); // hidden secret stored but not advertised
    await h.services.sources.update(id, {}); // drop cached instance
    await h.services.sources.instance(id);
    expect(seenConfigs.at(-1)).toMatchObject({ refreshToken: 'rotated', apiKey: SECRET });
    expect(h.logs()).toContain('using key [redacted]');
    expect(h.logs()).not.toContain(SECRET);
  });

  it('is admin-only', async () => {
    h = await createHarness({ plugins: [keyed], config: { multiUser: true } });
    await h.services.auth.createUser('guest', 'password1', false);
    const login = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'guest', password: 'password1' } });
    const guest = { authorization: `Bearer ${login.json().accessToken}` };
    expect((await h.app.inject({ url: '/api/sources', headers: guest })).statusCode).toBe(403);
    expect((await h.app.inject({ url: '/api/providers', headers: guest })).statusCode).toBe(200);
  });
});
