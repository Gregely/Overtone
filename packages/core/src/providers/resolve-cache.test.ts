import { describe, expect, it, vi } from 'vitest';
import { ResolveCache } from './resolve-cache.js';
import type { ResolvedStream, SourceProvider } from './types.js';

function provider(make: (fileId: string, n: number) => ResolvedStream) {
  let n = 0;
  const resolveStream = vi.fn(async (fileId: string, _opts?: { forceRefresh?: boolean }) => make(fileId, ++n));
  const p: SourceProvider = { listLibrary: async function* () {}, resolveStream };
  return { p, resolveStream };
}

const signal = new AbortController().signal;

describe('ResolveCache', () => {
  it('reuses a resolution until shortly before it expires', async () => {
    let now = 0;
    const cache = new ResolveCache({ now: () => now, refreshMarginMs: 1000 });
    const { p, resolveStream } = provider((_, n) => ({ url: `https://x/${n}`, expiresAt: new Date(now + 10_000) }));

    expect((await cache.resolve('s', p, 'f', { signal })).url).toBe('https://x/1');
    now = 8_999;
    expect((await cache.resolve('s', p, 'f', { signal })).url).toBe('https://x/1');
    now = 9_000; // inside the refresh margin
    expect((await cache.resolve('s', p, 'f', { signal })).url).toBe('https://x/2');
    expect(resolveStream).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent resolves', async () => {
    const cache = new ResolveCache();
    const { p, resolveStream } = provider((_, n) => ({ url: `https://x/${n}` }));
    const results = await Promise.all([1, 2, 3].map(() => cache.resolve('s', p, 'f', { signal })));
    expect(new Set(results.map((r) => r.url))).toEqual(new Set(['https://x/1']));
    expect(resolveStream).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh bypasses the cache and is passed to the provider', async () => {
    const cache = new ResolveCache();
    const { p, resolveStream } = provider((_, n) => ({ url: `https://x/${n}` }));
    await cache.resolve('s', p, 'f', { signal });
    const r = await cache.resolve('s', p, 'f', { signal, forceRefresh: true });
    expect(r.url).toBe('https://x/2');
    expect(resolveStream.mock.calls[1]?.[1]).toMatchObject({ forceRefresh: true });
    // ...and the refreshed result is what's cached now.
    expect((await cache.resolve('s', p, 'f', { signal })).url).toBe('https://x/2');
  });

  it('does not cache links that are already inside the refresh margin', async () => {
    const cache = new ResolveCache({ refreshMarginMs: 60_000 });
    const { p, resolveStream } = provider(() => ({ url: 'https://x', expiresAt: new Date(Date.now() + 1000) }));
    await cache.resolve('s', p, 'f', { signal });
    await cache.resolve('s', p, 'f', { signal });
    expect(resolveStream).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const cache = new ResolveCache();
    const resolveStream = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ url: 'https://ok' });
    const p: SourceProvider = { listLibrary: async function* () {}, resolveStream };
    await expect(cache.resolve('s', p, 'f', { signal })).rejects.toThrow('boom');
    expect((await cache.resolve('s', p, 'f', { signal })).url).toBe('https://ok');
  });

  it('invalidates per file and per source, and evicts LRU beyond maxEntries', async () => {
    const cache = new ResolveCache({ maxEntries: 2 });
    const { p, resolveStream } = provider((id, n) => ({ url: `https://x/${id}/${n}` }));
    await cache.resolve('s1', p, 'a', { signal });
    await cache.resolve('s1', p, 'b', { signal });
    await cache.resolve('s1', p, 'a', { signal }); // touch a → b is now oldest
    await cache.resolve('s2', p, 'c', { signal }); // evicts b
    expect(cache.size).toBe(2);
    await cache.resolve('s1', p, 'b', { signal }); // re-resolved; evicts a
    expect(resolveStream).toHaveBeenCalledTimes(4);

    cache.invalidate('s1'); // drops b, keeps s2/c
    expect(cache.size).toBe(1);
    cache.invalidate('s2', 'c');
    expect(cache.size).toBe(0);
  });
});
