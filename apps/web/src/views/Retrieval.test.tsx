import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { RetrievalJobDto } from '@overtone/shared';
import { HttpTransport } from '../api/client';
import { ApiProvider } from '../app/context';
import { memoryStore } from '../platform/storage';
import { RetrievalView } from './Retrieval';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const job = (id: string, status: RetrievalJobDto['status'], extra: Partial<RetrievalJobDto> = {}): RetrievalJobDto => ({
  id,
  providerId: 'ad',
  providerName: 'AllDebrid',
  status,
  infohash: 'a'.repeat(40),
  title: 'Album (1971)',
  artist: 'Artist',
  album: 'Album',
  year: 1971,
  size: 300_000_000,
  progress: null,
  error: null,
  filesProcessed: false,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  completedAt: null,
  ...extra,
});

async function renderWithJobs(jobs: RetrievalJobDto[]) {
  let fetchCount = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.pathname === '/api/auth/login') return json({ accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshToken: 'r', refreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString(), user: { id: 1, username: 'admin', isAdmin: true } });
    if (u.pathname === '/api/retrieval/jobs') {
      fetchCount++;
      return json(jobs);
    }
    return json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  const api = new HttpTransport({ storage: memoryStore(), serverUrl: 'http://srv', fetch: fetch as unknown as typeof fetch });
  await api.login({ username: 'admin', password: 'password1' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(
    <ApiProvider client={api}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <RetrievalView />
        </MemoryRouter>
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { fetchCount: () => fetchCount };
}

describe('RetrievalView', () => {
  it('lists active, completed and failed jobs with their provider and status', async () => {
    await renderWithJobs([
      job('a1', 'processing'),
      job('c1', 'complete', { completedAt: '2026-11-02T00:00:00Z' }),
      job('f1', 'failed', { error: 'TorBox could not download the torrent' }),
    ]);

    expect((await screen.findAllByText('Album (1971)'))).toHaveLength(3);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getAllByText('AllDebrid')).toHaveLength(3);
    expect(screen.getByText(/could not download/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows an empty state and refetches on mount (refresh recovery)', async () => {
    const { fetchCount } = await renderWithJobs([]);
    expect(await screen.findByText('No downloads yet')).toBeInTheDocument();
    expect(fetchCount()).toBe(1);
  });
});
