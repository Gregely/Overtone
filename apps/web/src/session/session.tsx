import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LoginRequestDto, UserDto } from '@overtone/shared';
import { ApiError, HttpTransport, NetworkError, type ApiClient } from '../api/client';
import { useApi } from '../app/context';
import { cleartextProblem, defaultServerUrl, isNativeApp, normalizeServerUrl } from '../platform/server-url';

export type SessionPhase =
  | { phase: 'booting' }
  | { phase: 'unreachable'; serverUrl: string }
  | { phase: 'setup'; serverUrl: string; version: string }
  | { phase: 'login'; serverUrl: string | null; version: string | null; notice?: string }
  /** serverUrl is null in standalone mode (no server, no sign-in). */
  | { phase: 'ready'; serverUrl: string | null; version: string; user: UserDto };

interface SessionApi {
  state: SessionPhase;
  retry(): Promise<void>;
  /** Validate and switch server. Throws a user-facing Error if it can't be reached. */
  changeServer(input: string): Promise<void>;
  login(body: LoginRequestDto): Promise<void>;
  setup(body: LoginRequestDto): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/**
 * Standalone mode has a single local user and no login: the session is
 * ready as soon as the on-device library is open.
 */
function StandaloneSession({ api, children }: { api: ApiClient; children: ReactNode }) {
  const [state, setState] = useState<SessionPhase>({ phase: 'booting' });
  useEffect(() => {
    void Promise.all([api.get<{ version: string }>('/api/health'), api.get<UserDto>('/api/me')]).then(([h, user]) =>
      setState({ phase: 'ready', serverUrl: null, version: h.version, user }),
    );
  }, [api]);
  const value = useMemo<SessionApi>(() => {
    const unsupported = async () => {
      throw new Error('Not available when using Overtone on this device');
    };
    return { state, retry: async () => undefined, changeServer: unsupported, login: unsupported, setup: unsupported, logout: async () => undefined };
  }, [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  if (api instanceof HttpTransport) return <ServerSession api={api}>{children}</ServerSession>;
  return <StandaloneSession api={api}>{children}</StandaloneSession>;
}

/** Server mode: server URL, first-run setup, sign-in, token refresh. */
function ServerSession({ api, children }: { api: HttpTransport; children: ReactNode }) {
  const [state, setState] = useState<SessionPhase>({ phase: 'booting' });

  const evaluate = useCallback(async () => {
    const serverUrl = api.serverUrl;
    if (!serverUrl) return setState({ phase: 'login', serverUrl: null, version: null });
    let status;
    try {
      status = await api.status(serverUrl);
    } catch (err) {
      if (err instanceof NetworkError) return setState({ phase: 'unreachable', serverUrl });
      throw err;
    }
    if (status.setupRequired) return setState({ phase: 'setup', serverUrl, version: status.version });
    if (api.hasSession()) {
      try {
        const user = await api.get<UserDto>('/api/me');
        return setState({ phase: 'ready', serverUrl, version: status.version, user });
      } catch (err) {
        if (err instanceof NetworkError) return setState({ phase: 'unreachable', serverUrl });
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
      }
    }
    setState({ phase: 'login', serverUrl, version: status.version });
  }, [api]);

  useEffect(() => {
    api.onSessionExpired = () =>
      setState((s) => ({ phase: 'login', serverUrl: api.serverUrl, version: 'version' in s ? s.version : null, notice: 'Your session ended. Please sign in again.' }));
    void api.restore(defaultServerUrl()).then(evaluate);
    return () => {
      api.onSessionExpired = null;
    };
  }, [api, evaluate]);

  const value = useMemo<SessionApi>(
    () => ({
      state,
      retry: async () => {
        setState({ phase: 'booting' });
        await evaluate();
      },
      changeServer: async (input) => {
        const url = normalizeServerUrl(input);
        if (!url) throw new Error('Enter a server address like http://192.168.1.10:4800');
        if (isNativeApp()) {
          const problem = cleartextProblem(url);
          if (problem) throw new Error(problem);
        }
        try {
          // Health check first (any Overtone server answers it), then the auth status.
          await api.health(url);
          await api.status(url);
        } catch (err) {
          if (!(err instanceof NetworkError)) throw new Error((err as Error).message);
          const host = new URL(url).hostname;
          const ipOverHttp = isNativeApp() && url.startsWith('http:') && /^\d+\.\d+\.\d+\.\d+$/.test(host);
          throw new Error(
            ipOverHttp
              ? `Can't reach ${url}. Android only allows plain http:// to IP addresses listed in the app's cleartextHosts setting; use https://, a .local / .ts.net name, or add ${host} and rebuild (see docs/android.md).`
              : `Can't reach an Overtone server at ${url}`,
          );
        }
        await api.setServerUrl(url);
        await evaluate();
      },
      login: async (body) => {
        await api.login(body);
        await evaluate();
      },
      setup: async (body) => {
        await api.setup(body);
        await evaluate();
      },
      logout: async () => {
        await api.logout();
        setState({ phase: 'login', serverUrl: api.serverUrl, version: 'version' in state ? state.version : null });
      },
    }),
    [api, evaluate, state],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
