import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { HttpTransport, type ApiClient, type AppMode } from '../api/client';
import { retryPolicy } from '../api/hooks';
import { AppShell } from '../layout/AppShell';
import { Page } from '../layout/Page';
import { SecureStorage } from '../platform/native';
import { initialMode, saveMode, standaloneAvailable } from '../platform/mode';
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
import { TorrentSourceEditView, TorrentSourcesView } from '../views/TorrentSources';
import { FirstSourceGuide, ModeChooser } from '../views/Welcome';
import { ApiProvider, useApiState } from './context';
import { ModeProvider } from './mode';

/** Tokens + server URL: Android Keystore-encrypted storage in the app, localStorage on the web. */
export function sessionStore(): KeyValueStore {
  return isNativeApp() ? secureStore(SecureStorage) : localStore;
}

/**
 * Top level: pick the mode (asking on first launch of the Android app), then
 * run the same UI over the matching ApiClient transport.
 */
export function App({ client }: { client?: ApiClient }) {
  if (client) return <AppWithClient client={client} mode={client.mode} />;
  return <ModeRoot />;
}

function ModeRoot() {
  const [mode, setMode] = useState<AppMode | null>(() => initialMode());
  if (mode === null) {
    return (
      <ModeChooser
        onChoose={(m) => {
          saveMode(m);
          // Standalone starts with the guided "Add your first source" screen.
          if (m === 'standalone') window.history.replaceState(null, '', '/welcome');
          setMode(m);
        }}
      />
    );
  }
  if (mode === 'standalone') return <StandaloneRoot />;
  return <ServerRoot />;
}

const switchTo = async (mode: AppMode, close?: () => Promise<void>) => {
  await close?.().catch(() => undefined);
  saveMode(mode);
  window.location.replace('/');
};

function ServerRoot() {
  const [api] = useState(() => new HttpTransport({ storage: sessionStore(), serverUrl: null }));
  return <AppWithClient client={api} mode="server" />;
}

function StandaloneRoot() {
  const [opened, setOpened] = useState<{ client: ApiClient; close: () => Promise<void> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(() => {
    setError(null);
    import('../standalone/bootstrap')
      .then((m) => m.openStandalone())
      .then((s) => setOpened({ client: s.client, close: s.close }))
      .catch((err: Error) => {
        console.error('[overtone] could not open the on-device library', err);
        setError(err.message || String(err));
      });
  }, []);
  useEffect(open, [open]);

  if (error) {
    return (
      <main className="auth" id="main">
        <div className="card stack">
          <h1>Couldn't open your library</h1>
          <p className="banner error" role="alert">
            {error}
          </p>
          <div className="row wrap">
            <button type="button" className="btn primary" onClick={open}>
              Try again
            </button>
            <button type="button" className="btn ghost" onClick={() => void switchTo('server')}>
              Connect to a server instead
            </button>
          </div>
        </div>
      </main>
    );
  }
  if (!opened) return <BootScreen label="Opening your library…" />;
  return <AppWithClient client={opened.client} mode="standalone" close={opened.close} />;
}

function AppWithClient({ client: api, mode, close }: { client: ApiClient; mode: AppMode; close?: () => Promise<void> }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: retryPolicy, staleTime: 30_000, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  );
  const switchMode = useCallback((m: AppMode) => switchTo(m, close), [close]);
  return (
    <ModeProvider value={{ mode, canSwitch: standaloneAvailable(), switchMode }}>
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
    </ModeProvider>
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
        <Route path="settings/torrent-sources" element={<TorrentSourcesView />} />
        <Route path="settings/torrent-sources/new" element={<TorrentSourceEditView />} />
        <Route path="settings/torrent-sources/:id" element={<TorrentSourceEditView />} />
        <Route path="welcome" element={<FirstSourceGuide />} />
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
