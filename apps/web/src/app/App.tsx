import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { ApiClient } from '../api/client';
import { retryPolicy } from '../api/hooks';
import { AppShell } from '../layout/AppShell';
import { Page } from '../layout/Page';
import { SecureStorage } from '../platform/native';
import { isNativeApp } from '../platform/server-url';
import { localStore, secureStore, type KeyValueStore } from '../platform/storage';
import { PlayerProvider } from '../player/react';
import { SessionProvider, useSession } from '../session/session';
import { AlbumView, ArtistView } from '../views/Album';
import { BootScreen, LoginScreen, SetupScreen, UnreachableScreen } from '../views/Auth';
import { HomeView } from '../views/Home';
import { LibraryView } from '../views/Library';
import { NowPlayingView } from '../views/NowPlaying';
import { ReviewView } from '../views/Review';
import { SearchView } from '../views/Search';
import { SettingsView } from '../views/Settings';
import { SourceEditView, SourcesView } from '../views/Sources';
import { ApiProvider, useApiState } from './context';

/** Tokens + server URL: Android Keystore-encrypted storage in the app, localStorage on the web. */
export function sessionStore(): KeyValueStore {
  return isNativeApp() ? secureStore(SecureStorage) : localStore;
}

export function App({ client }: { client?: ApiClient }) {
  const [api] = useState(() => client ?? new ApiClient({ storage: sessionStore(), serverUrl: null }));
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: retryPolicy, staleTime: 30_000, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <ApiProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <ServerCacheReset client={queryClient} />
        <SessionProvider>
          <BrowserRouter>
            <Gate />
          </BrowserRouter>
        </SessionProvider>
      </QueryClientProvider>
    </ApiProvider>
  );
}

/** Data from one server must never show up after switching to another. */
function ServerCacheReset({ client }: { client: QueryClient }) {
  const serverUrl = useApiState((c) => c.serverUrl);
  const userId = useApiState((c) => c.user?.id ?? null);
  useEffect(() => {
    client.clear();
  }, [client, serverUrl, userId]);
  return null;
}

function Gate() {
  const { state } = useSession();
  switch (state.phase) {
    case 'booting':
      return <BootScreen />;
    case 'unreachable':
      return <UnreachableScreen serverUrl={state.serverUrl} />;
    case 'setup':
      return <SetupScreen serverUrl={state.serverUrl} />;
    case 'login':
      return <LoginScreen serverUrl={state.serverUrl} notice={state.notice} />;
    case 'ready':
      return (
        <PlayerProvider key={`${state.serverUrl}:${state.user.id}`}>
          <AppRoutes />
        </PlayerProvider>
      );
  }
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeView />} />
        <Route path="library" element={<Navigate to="/library/albums" replace />} />
        <Route path="library/:tab" element={<LibraryView />} />
        <Route path="artists/:id" element={<ArtistView />} />
        <Route path="albums/:id" element={<AlbumView />} />
        <Route path="search" element={<SearchView />} />
        <Route path="now-playing" element={<NowPlayingView />} />
        <Route path="review" element={<ReviewView />} />
        <Route path="settings" element={<SettingsView />} />
        <Route path="settings/sources" element={<SourcesView />} />
        <Route path="settings/sources/new" element={<SourceEditView />} />
        <Route path="settings/sources/:id" element={<SourceEditView />} />
        <Route
          path="*"
          element={
            <Page title="Not found">
              <p>
                That page doesn't exist. <Link to="/">Go home</Link>
              </p>
            </Page>
          }
        />
      </Route>
    </Routes>
  );
}
