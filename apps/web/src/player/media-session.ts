import type { PlayerController, PlayerSnapshot } from './controller';

/**
 * Lock-screen / notification / hardware-key integration via the Media Session
 * API, including artwork (absolute URLs at two sizes).
 */
export function bindMediaSession(player: PlayerController, absoluteUrl: (path: string) => string): () => void {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!ms) return () => undefined;

  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
    ['play', () => player.play()],
    ['pause', () => player.pause()],
    ['previoustrack', () => player.prev()],
    ['nexttrack', () => player.next()],
    ['seekto', (d) => d.seekTime !== undefined && player.seek(d.seekTime)],
    ['seekbackward', (d) => player.seek(player.getSnapshot().position - (d.seekOffset ?? 10))],
    ['seekforward', (d) => player.seek(player.getSnapshot().position + (d.seekOffset ?? 10))],
    ['stop', () => player.pause()],
  ];
  for (const [action, fn] of handlers) {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* unsupported action in this browser */
    }
  }

  let lastUid: string | null = null;
  let lastPositionUpdate = 0;
  const update = (s: PlayerSnapshot) => {
    const uid = s.current?.uid ?? null;
    if (uid !== lastUid) {
      lastUid = uid;
      ms.metadata = s.current ? new MediaMetadata(metadataFor(s, absoluteUrl)) : null;
    }
    ms.playbackState = s.status === 'playing' ? 'playing' : s.current ? 'paused' : 'none';
    const now = Date.now();
    if (s.duration > 0 && now - lastPositionUpdate > 1000 && 'setPositionState' in ms) {
      lastPositionUpdate = now;
      try {
        ms.setPositionState({ duration: s.duration, position: Math.min(s.position, s.duration), playbackRate: 1 });
      } catch {
        /* position briefly > duration while metadata settles */
      }
    }
  };
  update(player.getSnapshot());
  const unsubscribe = player.subscribe(() => update(player.getSnapshot()));
  return () => {
    unsubscribe();
    for (const [action] of handlers) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        /* ignore */
      }
    }
  };
}

export function metadataFor(s: PlayerSnapshot, absoluteUrl: (path: string) => string): MediaMetadataInit {
  const t = s.current!.track;
  const artwork: MediaImage[] = t.coverUrl
    ? [250, 500].map((size) => ({ src: absoluteUrl(`${t.coverUrl}&size=${size}`), sizes: `${size}x${size}`, type: 'image/jpeg' }))
    : [{ src: absoluteUrl('/icon-512.png'), sizes: '512x512', type: 'image/png' }];
  return { title: t.title, artist: t.artistCredit, album: t.album?.title ?? '', artwork };
}
