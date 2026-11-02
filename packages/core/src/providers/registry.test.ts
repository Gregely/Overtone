import { describe, expect, it } from 'vitest';
import { builtinPlugins, createDefaultRegistry } from './index.js';
import { ProviderRegistry } from './registry.js';
import type { ProviderPlugin } from './types.js';

const fake = (id: string, extra: Partial<ProviderPlugin['manifest']> = {}): ProviderPlugin => ({
  manifest: { id, name: id, description: '', category: 'local', configSchema: { fields: [] }, ...extra },
  create: () => {
    throw new Error('unused');
  },
});

describe('ProviderRegistry', () => {
  it('registers every built-in plugin', () => {
    const ids = createDefaultRegistry({ local: [fake('local-folder')] }).list().map((p) => p.manifest.id);
    expect(ids).toEqual(['local-folder', 'subsonic', 'internet-archive', 'real-debrid', 'alldebrid', 'torbox', 'premiumize']);
    expect(ids).toHaveLength(builtinPlugins.length + 1);
  });

  it('rejects bad and duplicate ids', () => {
    const r = new ProviderRegistry().register(fake('ok-id'));
    expect(() => r.register(fake('ok-id'))).toThrow(/already/);
    expect(() => r.register(fake('Bad_Id'))).toThrow(/kebab/);
  });

  it('validates config schemas at registration', () => {
    const broken = fake('broken', {
      configSchema: { fields: [{ key: 'x', type: 'string', label: 'X' }, { key: 'x', type: 'string', label: 'X' }] },
    });
    expect(() => new ProviderRegistry().register(broken)).toThrow(/duplicate/);
  });

  it('requires deviceFlow and configSchema.deviceLogin together', () => {
    const half = fake('half', { deviceFlow: { start: async () => { throw new Error(); }, poll: async () => ({ status: 'pending' }) } });
    expect(() => new ProviderRegistry().register(half)).toThrow(/declared together/);
    const bad = fake('bad', { configSchema: { fields: [{ key: 'k', type: 'string', label: 'K' }], deviceLogin: { label: 'x', replaces: ['k'] } } });
    expect(() => new ProviderRegistry().register(bad)).toThrow(/must be a secret field/);
  });

  it('strips hidden fields and handlers from client DTOs', () => {
    const r = new ProviderRegistry().register(
      fake('with-hidden', {
        configSchema: {
          fields: [
            { key: 'apiKey', type: 'secret', label: 'Key' },
            { key: 'refreshToken', type: 'secret', label: 'R', hidden: true },
          ],
          deviceLogin: { label: 'Log in with X', replaces: ['apiKey', 'refreshToken'] },
        },
        capabilities: { testConnection: true },
        deviceFlow: { start: async () => { throw new Error(); }, poll: async () => ({ status: 'pending' }) },
      }),
    );
    const [dto] = r.toDtos();
    expect(dto?.configSchema.fields.map((f) => f.key)).toEqual(['apiKey']);
    expect(dto?.configSchema.deviceLogin).toEqual({ label: 'Log in with X', replaces: ['apiKey', 'refreshToken'] });
    expect(dto?.capabilities).toEqual({ watch: false, testConnection: true, deviceFlow: true, redirectable: false });
    // DTO must be plain JSON (no functions leaking through).
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });
});
