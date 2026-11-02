import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HttpTransport } from '../api/client';
import { ApiProvider } from '../app/context';
import { memoryStore } from '../platform/storage';
import { TorrentSourceEditView, TorrentSourcesView } from './TorrentSources';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function renderIn(ui: ReactNode, api: HttpTransport) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ApiProvider client={api}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </ApiProvider>,
  );
}

async function setup(overrides: Record<string, () => Response>) {
  const bodies: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (init?.body) bodies.push(String(init.body));
    if (u.pathname === '/api/auth/login') return json({ accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshToken: 'r', refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(), user: { id: 1, username: 'admin', isAdmin: true } });
    const handler = overrides[u.pathname];
    if (handler) return handler();
    return json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  const api = new HttpTransport({ storage: memoryStore(), serverUrl: 'http://srv', fetch: fetch as unknown as typeof fetch });
  await api.login({ username: 'admin', password: 'password1' });
  return { api, bodies };
}

describe('TorrentSourcesView', () => {
  it('lists connections with indexer counts', async () => {
    const { api } = await setup({
      '/api/torrent-sources': () =>
        json([
          { id: 'p1', kind: 'prowlarr', name: 'Prowlarr', enabled: true, url: 'http://prowlarr', apiKeySet: true, lastError: null, indexers: [{ id: '1', name: 'A', categories: [], enabled: true }, { id: '2', name: 'B', categories: [], enabled: false }] },
          { id: 't1', kind: 'torznab', name: 'Direct', enabled: true, url: 'https://idx/api', apiKeySet: false, lastError: null, indexers: [] },
        ]),
    });
    renderIn(<TorrentSourcesView />, api);
    expect(await screen.findByRole('heading', { name: 'Prowlarr' })).toBeInTheDocument();
    expect(screen.getByText('2 indexers · 1 enabled')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Direct' })).toBeInTheDocument();
    expect(screen.getByText('1 indexer · 1 enabled')).toBeInTheDocument();
  });
});

describe('TorrentSourceEditView', () => {
  it('test connection imports indexers and saving preserves the enabled state', async () => {
    const { api, bodies } = await setup({
      '/api/torrent-sources/test': () => json({ ok: true, message: 'Connected', indexers: [{ id: '1', name: 'Indexer A', categories: [], enabled: true }, { id: '2', name: 'Indexer B', categories: [], enabled: true }] }),
      '/api/torrent-sources': () => json({ id: 'new', kind: 'prowlarr', name: 'Prowlarr', enabled: true, url: 'http://prowlarr', apiKeySet: true, lastError: null, indexers: [] }),
    });
    renderIn(<TorrentSourceEditView />, api);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Name'), 'My Prowlarr');
    await user.clear(screen.getByLabelText('Server URL'));
    await user.type(screen.getByLabelText('Server URL'), 'http://prowlarr:9696');
    await user.type(screen.getByLabelText('API key'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Indexer A')).toBeInTheDocument();
    expect(screen.getByText('Indexer B')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Indexer B' }));
    await user.click(screen.getByRole('button', { name: 'Add source' }));

    await waitFor(() => expect(bodies.some((b) => b.includes('Indexer A'))).toBe(true));
    const body = JSON.parse(bodies.find((b) => b.includes('Indexer A'))!);
    expect(body).toMatchObject({ kind: 'prowlarr', name: 'My Prowlarr', url: 'http://prowlarr:9696' });
    expect(body.indexers).toEqual([
      { id: '1', name: 'Indexer A', categories: [], enabled: true },
      { id: '2', name: 'Indexer B', categories: [], enabled: false },
    ]);
  });
});
