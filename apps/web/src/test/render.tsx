import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { HttpTransport } from '../api/client';
import { ApiProvider } from '../app/context';
import { memoryStore } from '../platform/storage';
import { PlayerController, type LinkFetcher, type StreamLink } from '../player/controller';
import { PlayerProvider } from '../player/react';
import { FakeEngine } from './fake-engine';
import { seeded } from './fixtures';

export function setupPlayer() {
  const engine = new FakeEngine();
  let issued = 0;
  const fetchLinks = vi.fn<LinkFetcher>(async (ids) => {
    issued++;
    return {
      links: new Map(ids.map((id): [number, StreamLink] => [id, { url: `http://srv/api/stream/${id}?v=${issued}`, expiresAt: Date.now() + 3600_000, source: null }])),
      unavailable: [],
    };
  });
  const player = new PlayerController({ engine, fetchLinks, random: seeded() });
  const api = new HttpTransport({ storage: memoryStore(), serverUrl: 'http://srv', fetch: vi.fn() });
  return { engine, fetchLinks, player, api };
}

export function renderWithApp(ui: ReactNode, { api, player, route = '/' }: { api: HttpTransport; player: PlayerController; route?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ApiProvider client={api}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <PlayerProvider controller={player}>{ui}</PlayerProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ApiProvider>,
  );
}
