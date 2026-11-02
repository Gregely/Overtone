import { describe, expect, it } from 'vitest';
import { builtinPlugins, createDefaultRegistry } from './index.js';

describe('server provider registry', () => {
  it('lists Local folder first, then core built-ins', () => {
    const ids = createDefaultRegistry().list().map((p) => p.manifest.id);
    expect(ids).toEqual(['local-folder', 'subsonic', 'internet-archive', 'real-debrid', 'alldebrid', 'torbox', 'premiumize']);
    expect(ids).toHaveLength(builtinPlugins.length);
  });
});
