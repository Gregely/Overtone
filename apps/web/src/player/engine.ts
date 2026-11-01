/**
 * Audio output abstraction. The web build uses HtmlAudioEngine; the Android
 * build uses NativeEngine (Media3 foreground service) behind the same interface.
 */

/** What the OS shows in the media notification / lock screen (native engines). */
export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  /** Absolute URL. */
  artworkUrl: string | null;
}
export type EngineEvent =
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'waiting' }
  | { type: 'time'; position: number; duration: number }
  | { type: 'ended' }
  /** Load or playback failure (network, expired link, decode). */
  | { type: 'error'; message: string }
  /** Next / previous pressed outside the app UI (notification, lock screen, headset). */
  | { type: 'remote'; command: 'next' | 'previous' };

export interface PlayerEngine {
  /** Start loading `src`; seek to `startAt` seconds once possible; play if `autoplay`. */
  load(src: string, opts: { startAt: number; autoplay: boolean; metadata?: TrackMetadata }): void;
  /** Stop and release the current source. */
  unload(): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  /** Hint: start buffering the likely next source for a near-gapless switch. */
  preload(src: string | null, metadata?: TrackMetadata): void;
  setVolume(volume: number): void;
  position(): number;
  /**
   * Must be called synchronously inside a user gesture before the first
   * playback (iOS/Safari autoplay rules). Safe to call repeatedly.
   */
  prime(): void;
  subscribe(listener: (e: EngineEvent) => void): () => void;
  destroy(): void;
}
