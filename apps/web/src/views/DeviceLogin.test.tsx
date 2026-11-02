import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderManifestDto } from '@overtone/shared';
import { HttpTransport } from '../api/client';
import { ApiProvider } from '../app/context';
import { memoryStore } from '../platform/storage';
import { SourceEditView } from './Sources';

const provider: ProviderManifestDto = {
  id: 'real-debrid',
  name: 'Real-Debrid',
  description: 'Stream audio files already in your Real-Debrid account.',
  category: 'debrid',
  capabilities: { watch: false, testConnection: true, deviceFlow: true, redirectable: false },
  configSchema: {
    fields: [
      { key: 'apiKey', type: 'secret', label: 'API key', required: false },
      { key: 'probeTags', type: 'boolean', label: 'Read tags from files', default: true },
    ],
    deviceLogin: { label: 'Log in with Real-Debrid', help: 'Approve on the website.', replaces: ['apiKey'] },
  },
};

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

async function setup() {
  let polls = 0;
  const bodies: Record<string, unknown> = {};
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    if (init?.body) bodies[`${method} ${u.pathname}`] = JSON.parse(String(init.body));
    if (u.pathname === '/api/providers') return json([provider]);
    if (u.pathname === '/api/providers/real-debrid/device-login')
      return json({ flowId: 'FLOW1', userCode: 'ABCD1234', verificationUrl: 'https://real-debrid.com/device', expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 1 });
    if (u.pathname === '/api/device-login/FLOW1') return json({ status: ++polls < 2 ? 'pending' : 'complete' });
    if (u.pathname === '/api/providers/real-debrid/test') return json({ ok: true, message: 'Connected to Real-Debrid as mel, premium until 2027-03-01.' });
    if (u.pathname === '/api/sources' && method === 'POST') return json({ id: 'src1' }, 201);
    return json({ error: { code: 'not_found', message: u.pathname } }, 404);
  });
  const storage = memoryStore();
  const tokens = {
    accessToken: 'a',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshToken: 'r',
    refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    user: { id: 1, username: 'admin', isAdmin: true },
  };
  await storage.set('overtone.serverUrl', 'http://srv');
  await storage.set('overtone.session', JSON.stringify({ serverUrl: 'http://srv', tokens }));
  const api = new HttpTransport({ storage, serverUrl: null, fetch: fetch as unknown as typeof globalThis.fetch, withLock: (_n, fn) => fn() });
  await api.restore(null);
  render(
    <ApiProvider client={api}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/settings/sources/new?provider=real-debrid']}>
          <Routes>
            <Route path="/settings/sources/new" element={<SourceEditView />} />
            <Route path="/settings/sources" element={<p>Sources list</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { fetch, bodies };
}

describe('"Log in with…" in the source form', () => {
  it('shows the code + link, polls until approved, and saves with the login (not a key)', async () => {
    const user = userEvent.setup();
    const { bodies } = await setup();
    await user.click(await screen.findByRole('button', { name: 'Log in with Real-Debrid' }));

    expect(await screen.findByLabelText('Code: A B C D 1 2 3 4')).toHaveTextContent('ABCD1234');
    const link = screen.getByRole('link', { name: 'real-debrid.com/device' });
    expect(link).toHaveAttribute('href', 'https://real-debrid.com/device');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/Waiting for you to approve/)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Signed in. Save the source to finish.')).toBeInTheDocument(), { timeout: 5000 });
    // The key field is no longer needed, and its value stays write-only/empty.
    const key = screen.getByLabelText('API key');
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', 'Not needed: signed in with the login above');

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected to Real-Debrid as mel/)).toBeInTheDocument();
    expect(bodies['POST /api/providers/real-debrid/test']).toMatchObject({ deviceLogin: 'FLOW1' });

    await user.click(screen.getByRole('button', { name: 'Add source' }));
    expect(await screen.findByText('Sources list')).toBeInTheDocument();
    expect(bodies['POST /api/sources']).toEqual({
      name: 'Real-Debrid',
      enabled: true,
      streamMode: 'proxy',
      config: { probeTags: true },
      providerId: 'real-debrid',
      deviceLogin: 'FLOW1',
    });
  }, 10_000);
});
