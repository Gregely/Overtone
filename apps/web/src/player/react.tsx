import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StreamUrlsResponseDto } from '@overtone/shared';
import { useApi } from '../app/context';
import { installBackButton } from '../platform/back-button';
import { NativePlayer } from '../platform/native';
import { isNativeApp } from '../platform/server-url';
import { localStore } from '../platform/storage';
import { PlayerController, type LinkFetcher, type PlayerSnapshot } from './controller';
import type { PlayerEngine } from './engine';
import { HtmlAudioEngine } from './html-audio-engine';
import { bindMediaSession } from './media-session';
import { NativeEngine } from './native-engine';
import { persistQueue, restoreQueue } from './persistence';

const Ctx = createContext<PlayerController | null>(null);

/** Android: Media3 foreground service. Web: two <audio> elements. Same interface. */
export function createEngine(): PlayerEngine {
  return isNativeApp() ? new NativeEngine(NativePlayer) : new HtmlAudioEngine();
}

export function PlayerProvider({ children, controller }: { children: ReactNode; controller?: PlayerController }) {
  const api = useApi();
  const [player] = useState(() => {
    if (controller) return controller;
    const fetchLinks: LinkFetcher = async (trackIds) => {
      const res = await api.post<StreamUrlsResponseDto>('/api/stream-urls', { trackIds });
      return {
        links: new Map(res.items.map((i) => [i.trackId, { url: api.url(i.url), expiresAt: Date.parse(i.expiresAt), source: i.source }])),
        unavailable: res.unavailable,
      };
    };
    return new PlayerController({
      engine: createEngine(),
      fetchLinks,
      artworkUrl: (t) => (t.coverUrl ? api.url(`${t.coverUrl}&size=500`) : null),
    });
  });

  useEffect(() => {
    // The native service owns the OS media session on Android; the web Media Session API is for browsers.
    if (controller || isNativeApp()) return;
    return bindMediaSession(player, (p) => api.url(p));
  }, [player, api, controller]);

  useEffect(() => {
    if (controller) return;
    let stop = () => {};
    let cancelled = false;
    // Restore the last queue (paused at its position), then keep saving it.
    void restoreQueue(player, localStore).then(() => {
      if (!cancelled) stop = persistQueue(player, localStore);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [player, controller]);

  useEffect(() => installBackButton(() => player.getSnapshot().status === 'playing'), [player]);
  useEffect(() => () => player.destroy(), [player]);

  return <Ctx.Provider value={player}>{children}</Ctx.Provider>;
}

export function usePlayer(): PlayerController {
  const p = useContext(Ctx);
  if (!p) throw new Error('usePlayer outside PlayerProvider');
  return p;
}

/** Subscribe to a slice of player state. Keep selectors cheap; return primitives where possible. */
export function usePlayerState<T>(select: (s: PlayerSnapshot) => T): T {
  const p = usePlayer();
  const selectRef = useRef(select);
  selectRef.current = select;
  return useSyncExternalStore(
    p.subscribe,
    () => selectRef.current(p.getSnapshot()),
    () => selectRef.current(p.getSnapshot()),
  );
}
