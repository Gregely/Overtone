/**
 * Audio output abstraction. The web build uses HtmlAudioEngine; the Android
 * build (stage 5) adds a native Media3 engine behind the same interface.
 */
export type EngineEvent =
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'waiting' }
  | { type: 'time'; position: number; duration: number }
  | { type: 'ended' }
  /** Load or playback failure (network, expired link, decode). */
  | { type: 'error'; message: string };

export interface PlayerEngine {
  /** Start loading `src`; seek to `startAt` seconds once possible; play if `autoplay`. */
  load(src: string, opts: { startAt: number; autoplay: boolean }): void;
  /** Stop and release the current source. */
  unload(): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  /** Hint: start buffering the likely next source for a near-gapless switch. */
  preload(src: string | null): void;
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
