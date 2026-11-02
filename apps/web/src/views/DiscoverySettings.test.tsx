import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { DEFAULT_DISCOVERY_PREFERENCES, type DiscoveryPreferencesDto } from '@overtone/shared';
import { HttpTransport } from '../api/client';
import { ApiProvider } from '../app/context';
import { memoryStore } from '../platform/storage';
import { DiscoverySettings } from './DiscoverySettings';

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

async function setup(initial: DiscoveryPreferencesDto = DEFAULT_DISCOVERY_PREFERENCES) {
  const puts: DiscoveryPreferencesDto[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.pathname === '/api/auth/login') return json({ accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshToken: 'r', refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(), user: { id: 1, username: 'admin', isAdmin: true } });
    if (u.pathname === '/api/preferences') {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return json(JSON.parse(String(init.body)));
      }
      return json(initial);
    }
    if (u.pathname === '/api/debrid/providers')
      return json([
        { sourceId: 'ad', name: 'AllDebrid', providerId: 'alldebrid', retrieval: true },
        { sourceId: 'rd', name: 'RealDebrid', providerId: 'real-debrid', retrieval: false },
      ]);
    return json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  const api = new HttpTransport({ storage: memoryStore(), serverUrl: 'http://srv', fetch: fetch as unknown as typeof fetch });
  await api.login({ username: 'admin', password: 'password1' });
  renderIn(<DiscoverySettings />, api);
  return { puts };
}

describe('DiscoverySettings', () => {
  it('offers only supported providers and marks others "Coming soon"', async () => {
    await setup();
    expect(await screen.findByText('Find sources')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'AllDebrid' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'RealDebrid' })).not.toBeInTheDocument();
    expect(await screen.findByText('RealDebrid · Coming soon')).toBeInTheDocument();
    expect(screen.getAllByText('Automatic').length).toBeGreaterThan(0);
  });

  it('saves preferences and restores defaults', async () => {
    const { puts } = await setup({ ...DEFAULT_DISCOVERY_PREFERENCES, preferredFormat: 'flac' });
    const user = userEvent.setup();

    await screen.findByText('Find sources');
    await user.selectOptions(screen.getByLabelText('Preferred format'), 'mp3');
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));
    await waitFor(() => expect(puts.some((p) => p.preferredFormat === 'mp3')).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    await waitFor(() => expect(puts.some((p) => p.preferredFormat === 'any')).toBe(true));
  });
});
