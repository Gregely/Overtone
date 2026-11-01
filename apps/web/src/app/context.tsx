import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { ApiClient } from '../api/client';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const c = useContext(ApiContext);
  if (!c) throw new Error('useApi outside ApiProvider');
  return c;
}

/** Re-render when the client's user / server / reachability change. */
export function useApiState<T>(select: (c: ApiClient) => T): T {
  const c = useApi();
  return useSyncExternalStore(
    (fn) => c.subscribe(fn),
    () => select(c),
    () => select(c),
  );
}

export function useIsAdmin(): boolean {
  return useApiState((c) => c.user?.isAdmin ?? false);
}
