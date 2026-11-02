import { describe, expect, it, vi } from 'vitest';
import { collect, createTestContext } from '../../testing/provider-context.js';
import { ProviderError } from '../errors.js';
import { createDebridPlugin, DEFAULT_LINK_TTL_MS } from './index.js';
import type { DebridAdapter, DebridAdapterDefinition, DebridCredentials } from './types.js';

const signal = new AbortController().signal;

function definition(adapter: Partial<DebridAdapter>, extra: Partial<DebridAdapterDefinition> = {}) {
  const create = vi.fn(
    (_credentials: DebridCredentials): DebridAdapter => ({
      testConnection: async () => ({ premium: true }),
      listFiles: async function* () {},
      resolveLink: async () => ({ url: 'https://dl.test/x' }),
      ...adapter,
    }),
  );
  const def: DebridAdapterDefinition = { id: 'fake-debrid', name: 'FakeDebrid', apiKeyUrl: 'https://fake.test/key', create, ...extra };
  return { def, create };
}

describe('createDebridPlugin', () => {
  it('builds a manifest with a required API key when there is no device flow', () => {
    const { manifest } = createDebridPlugin(definition({}).def);
    expect(manifest).toMatchObject({ id: 'fake-debrid', category: 'debrid', capabilities: { testConnection: true, redirectable: false } });
    expect(manifest.configSchema.fields).toEqual([
      expect.objectContaining({ key: 'apiKey', type: 'secret', required: true }),
      expect.objectContaining({ key: 'probeTags', type: 'boolean', default: true }),
    ]);
    expect(manifest.configSchema.deviceLogin).toBeUndefined();
  });

  it('makes the API key optional and adds hidden managed secrets when a device flow exists', () => {
    const { manifest } = createDebridPlugin(
      definition({}, {
        managedSecrets: ['refreshToken'],
        deviceFlow: { start: vi.fn(), poll: vi.fn() },
      }).def,
    );
    expect(manifest.deviceFlow).toBeDefined();
    expect(manifest.configSchema.fields).toEqual([
      expect.objectContaining({ key: 'apiKey', required: false }),
      expect.objectContaining({ key: 'refreshToken', type: 'secret', hidden: true }),
      expect.objectContaining({ key: 'probeTags' }),
    ]);
    expect(manifest.configSchema.deviceLogin).toEqual({ label: 'Log in with FakeDebrid', help: expect.any(String), replaces: ['apiKey', 'refreshToken'] });
  });

  it('lists only audio files and fills in MIME types', async () => {
    const { def } = definition({
      listFiles: async function* () {
        yield { id: 't1:1', name: '01 Intro.flac', path: 'Album/01 Intro.flac', size: 10 };
        yield { id: 't1:2', name: 'cover.jpg', path: 'Album/cover.jpg', size: 1 };
        yield { id: 't1:3', name: 'Album.cue', path: 'Album/Album.cue', size: 1 };
        yield { id: 't2:1', name: 'movie.mkv', path: 'Movie/movie.mkv', size: 1 };
        yield { id: 't3:1', name: 'song.mp3', path: 'song.mp3', size: 5 };
      },
    });
    const provider = createDebridPlugin(def).create({ apiKey: 'k' }, createTestContext());
    const files = await collect(provider.listLibrary({ signal }));
    expect(files.map((f) => f.id)).toEqual(['t1:1', 't3:1']);
    expect(files[0]).toMatchObject({ mimeType: 'audio/flac', path: 'Album/01 Intro.flac' });
  });

  it('passes only credential keys to the adapter', () => {
    const { def, create } = definition({}, { managedSecrets: ['refreshToken'] });
    const provider = createDebridPlugin(def).create({ apiKey: 'k', refreshToken: 'r', unrelated: 'x' }, createTestContext());
    void provider.listLibrary({ signal })[Symbol.asyncIterator]().next();
    expect(create.mock.calls[0]?.[0]).toEqual({ apiKey: 'k', refreshToken: 'r' });
  });

  it('fails with an auth error, not a crash, when no credentials are configured', async () => {
    const { def, create } = definition({});
    const provider = createDebridPlugin(def).create({}, createTestContext());
    await expect(provider.resolveStream('x', { signal })).rejects.toMatchObject({ code: 'auth' });
    expect(await provider.testConnection!({ signal })).toMatchObject({ ok: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('defaults expiry and redirectSafe=false on resolved links', async () => {
    const before = Date.now();
    const provider = createDebridPlugin(definition({}).def).create({ apiKey: 'k' }, createTestContext());
    const stream = await provider.resolveStream('x', { signal });
    expect(stream.redirectSafe).toBe(false);
    expect(stream.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_LINK_TTL_MS);
  });

  it('keeps adapter-provided expiry but never allows redirects (debrid links are bearer/IP-bound)', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    const { def } = definition({ resolveLink: async () => ({ url: 'https://dl', expiresAt, size: 42 }) });
    const stream = await createDebridPlugin(def).create({ apiKey: 'k' }, createTestContext()).resolveStream('x', { signal });
    expect(stream).toEqual({ url: 'https://dl', expiresAt, redirectSafe: false, size: 42 });
  });

  it('maps account status to a test-connection result', async () => {
    const make = (adapter: Partial<DebridAdapter>) =>
      createDebridPlugin(definition(adapter).def).create({ apiKey: 'k' }, createTestContext());

    const premium = await make({ testConnection: async () => ({ premium: true, username: 'me', plan: 'Pro', premiumUntil: new Date('2030-01-01Z') }) })
      .testConnection!({ signal });
    expect(premium).toEqual({
      ok: true,
      message: 'Connected to FakeDebrid as me, premium until 2030-01-01.',
      details: { account: 'me', plan: 'Pro', premiumUntil: '2030-01-01' },
    });

    const free = await make({ testConnection: async () => ({ premium: false }) }).testConnection!({ signal });
    expect(free.ok).toBe(false);

    const bad = await make({ testConnection: async () => { throw new ProviderError('auth', 'FakeDebrid: authentication failed'); } })
      .testConnection!({ signal });
    expect(bad).toEqual({ ok: false, message: 'FakeDebrid: authentication failed' });
  });
});
