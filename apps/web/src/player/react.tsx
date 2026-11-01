import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StreamUrlsResponseDto } from '@overtone/shared';
import { useApi } from '../app/context';
import { PlayerController, type LinkFetcher, type PlayerSnapshot } from './controller';
import { HtmlAudioEngine } from './html-audio-engine';
import { bindMediaSession } from './media-session';

const Ctx = createContext<PlayerController | null>(null);

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
    return new PlayerController({ engine: new HtmlAudioEngine(), fetchLinks });
  });

  useEffect(() => bindMediaSession(player, (p) => api.url(p)), [player, api]);
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
