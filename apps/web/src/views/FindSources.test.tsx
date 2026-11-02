import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { DEFAULT_DISCOVERY_PREFERENCES, type DiscoverResultDto, type DiscoverResponseDto } from '@overtone/shared';
import { HttpTransport } from '../api/client';
import { ApiProvider } from '../app/context';
import { memoryStore } from '../platform/storage';
import { FindSourcesDialog } from './FindSources';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const result: DiscoverResultDto = {
  key: 'hash:aaa',
  title: 'Album (1971)',
  artist: 'Artist',
  album: 'Album',
  year: 1971,
  format: 'flac',
  quality: 'lossless',
  type: 'album',
  size: 300_000_000,
  seeders: 42,
  leechers: 3,
  files: 8,
  sources: [{ id: 's1', name: 'Indexer A' }],
  magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  downloadUrl: null,
  score: 0.95,
  reasons: ['Artist 100%', 'Album 100%', 'Year 1971', 'FLAC lossless'],
  cached: [
    { providerId: 'ad', providerName: 'AllDebrid', status: 'cached' },
    { providerId: 'rd', providerName: 'RealDebrid', status: 'unavailable' },
  ],
};

function renderDialog(ui: ReactNode, api: HttpTransport) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ApiProvider client={api}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </ApiProvider>,
  );
}

async function setup(discover: DiscoverResponseDto, status = 200) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname === '/api/auth/login') return json({ accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshToken: 'r', refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(), user: { id: 1, username: 'admin', isAdmin: true } });
    if (u.pathname === '/api/discover') return json(discover, status);
    if (u.pathname === '/api/debrid/providers')
      return json([
        { sourceId: 'ad', name: 'AllDebrid', providerId: 'alldebrid', retrieval: true },
        { sourceId: 'rd', name: 'RealDebrid', providerId: 'real-debrid', retrieval: false },
      ]);
    if (u.pathname === '/api/debrid/ad/add-magnet') return json({ id: '33', status: 'queued' });
    if (u.pathname.startsWith('/api/debrid/ad/status/')) return json({ status: 'finished' });
    if (u.pathname === '/api/sources/ad/scan') return json({}, 202);
    return json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  const api = new HttpTransport({ storage: memoryStore(), serverUrl: 'http://srv', fetch: fetch as unknown as typeof fetch });
  await api.login({ username: 'admin', password: 'password1' });
  renderDialog(<FindSourcesDialog target={{ kind: 'album', id: 1, title: 'Album' }} onClose={() => {}} />, api);
  return { api, calls };
}

describe('FindSourcesDialog', () => {
  it('renders discovered results with cached and coming-soon indicators', async () => {
    await setup({ query: { scope: 'album', title: 'Album', artist: 'Artist' }, results: [result], errors: [] });
    expect(await screen.findByText('Album (1971)')).toBeInTheDocument();
    expect(screen.getByText(/FLAC/)).toBeInTheDocument();
    expect(screen.getByText('AllDebrid')).toBeInTheDocument();
    expect(screen.getByText('RealDebrid · Coming soon')).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    await setup({ query: { scope: 'album', title: 'Album' }, results: [], errors: [] });
    expect(await screen.findByText('No sources found')).toBeInTheDocument();
  });

  it('shows an error state when the search fails', async () => {
    await setup({ query: { scope: 'album', title: 'Album' }, results: [], errors: [] }, 500);
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
  });

  it('requires confirmation before submitting a magnet', async () => {
    const { calls } = await setup({ query: { scope: 'album', title: 'Album' }, results: [result], errors: [] });
    const user = userEvent.setup();

    await user.click(await screen.findByText('Album (1971)'));
    expect(await screen.findByText('Retrieve with a connected provider')).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(calls.some((c) => c.includes('add-magnet'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Retrieve with AllDebrid' }));
    expect(await screen.findByText('Add to AllDebrid?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add to AllDebrid' }));
    await waitFor(() => expect(calls.some((c) => c === 'POST /api/debrid/ad/add-magnet')).toBe(true));
  });

  it('uses the search-scope preference to search an album from a track', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (u.pathname === '/api/auth/login') return json({ accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshToken: 'r', refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(), user: { id: 1, username: 'admin', isAdmin: true } });
      if (u.pathname === '/api/preferences') return json({ ...DEFAULT_DISCOVERY_PREFERENCES, searchScope: 'album' });
      if (u.pathname === '/api/discover') return json({ query: { scope: 'album', title: 'Album' }, results: [], errors: [] });
      return json({ error: { code: 'not_found', message: 'no route' } }, 404);
    });
    const api = new HttpTransport({ storage: memoryStore(), serverUrl: 'http://srv', fetch: fetch as unknown as typeof fetch });
    await api.login({ username: 'admin', password: 'password1' });
    renderDialog(<FindSourcesDialog target={{ kind: 'track', id: 5, albumId: 9, title: 'Track' }} onClose={() => {}} />, api);

    await screen.findByText('No sources found');
    const discoverBody = bodies.find((b) => b.albumId !== undefined || b.trackId !== undefined);
    expect(discoverBody).toEqual({ albumId: 9 });
  });
});
