import type { EngineEvent, PlayerEngine } from './engine';

/** 0.1 s of silent 8 kHz WAV, used to unlock audio inside a user gesture (iOS). */
const SILENCE =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

/**
 * Two <audio> elements: one plays, the other buffers the next track. When the
 * controller loads a URL that's already preloaded, the elements swap roles,
 * so track changes don't wait on a fresh network request ("gapless-ish").
 */
export class HtmlAudioEngine implements PlayerEngine {
  readonly #els: [HTMLAudioElement, HTMLAudioElement];
  #active = 0;
  #pendingSeek: number | null = null;
  #primed = false;
  #volume = 1;
  readonly #listeners = new Set<(e: EngineEvent) => void>();
  readonly #cleanup: Array<() => void> = [];

  constructor(doc: Document = document) {
    this.#els = [doc.createElement('audio'), doc.createElement('audio')];
    for (const el of this.#els) {
      el.preload = 'auto';
      // Not added to the DOM: no visible controls, but still plays in the background tab.
      const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: () => void) => {
        const handler = () => {
          if (el === this.#el) fn();
        };
        el.addEventListener(type, handler);
        this.#cleanup.push(() => el.removeEventListener(type, handler));
      };
      on('playing', () => this.#emit({ type: 'playing' }));
      on('pause', () => {
        if (!el.ended) this.#emit({ type: 'paused' });
      });
      on('waiting', () => this.#emit({ type: 'waiting' }));
      on('timeupdate', () => this.#emit({ type: 'time', position: el.currentTime, duration: el.duration || 0 }));
      on('durationchange', () => this.#emit({ type: 'time', position: el.currentTime, duration: el.duration || 0 }));
      on('ended', () => this.#emit({ type: 'ended' }));
      on('loadedmetadata', () => {
        if (this.#pendingSeek !== null) {
          el.currentTime = this.#pendingSeek;
          this.#pendingSeek = null;
        }
      });
      on('error', () => {
        if (!el.getAttribute('src') || el.src.startsWith('data:')) return;
        this.#emit({ type: 'error', message: mediaErrorMessage(el.error) });
      });
    }
  }

  get #el(): HTMLAudioElement {
    return this.#els[this.#active]!;
  }
  get #other(): HTMLAudioElement {
    return this.#els[1 - this.#active]!;
  }

  #emit(e: EngineEvent): void {
    for (const fn of this.#listeners) fn(e);
  }

  subscribe(fn: (e: EngineEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  prime(): void {
    if (this.#primed) return;
    this.#primed = true;
    for (const el of this.#els) {
      if (el.getAttribute('src')) continue;
      el.src = SILENCE;
      el.play().then(
        () => el.pause(),
        () => undefined,
      );
    }
  }

  load(src: string, { startAt, autoplay }: { startAt: number; autoplay: boolean }): void {
    const current = this.#el;
    if (this.#other.getAttribute('src') === src) {
      current.pause();
      current.removeAttribute('src');
      current.load();
      this.#active = 1 - this.#active;
    } else if (current.getAttribute('src') !== src) {
      current.src = src;
    }
    const el = this.#el;
    el.volume = this.#volume;
    this.#pendingSeek = null;
    if (startAt > 0) {
      if (el.readyState >= HTMLMediaElement.HAVE_METADATA) el.currentTime = startAt;
      else this.#pendingSeek = startAt;
    } else if (el.currentTime !== 0) {
      el.currentTime = 0;
    }
    if (autoplay) {
      el.play().catch((err: DOMException) => {
        // Autoplay blocked: report paused so the UI shows a play button.
        if (err.name === 'NotAllowedError') this.#emit({ type: 'paused' });
      });
    }
  }

  unload(): void {
    for (const el of this.#els) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }

  play(): Promise<void> {
    return this.#el.play();
  }

  pause(): void {
    this.#el.pause();
  }

  seek(seconds: number): void {
    const el = this.#el;
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) el.currentTime = seconds;
    else this.#pendingSeek = seconds;
  }

  preload(src: string | null): void {
    const other = this.#other;
    if (!src) return;
    if (other.getAttribute('src') !== src) {
      other.src = src;
      other.load();
    }
  }

  setVolume(volume: number): void {
    this.#volume = volume;
    this.#el.volume = volume;
  }

  position(): number {
    return this.#el.currentTime || 0;
  }

  destroy(): void {
    this.unload();
    for (const fn of this.#cleanup) fn();
    this.#listeners.clear();
  }
}

function mediaErrorMessage(e: MediaError | null): string {
  switch (e?.code) {
    case 1:
      return 'aborted';
    case 2:
      return 'network';
    case 3:
      return 'decode';
    case 4:
      return 'unsupported or unauthorized source';
    default:
      return 'unknown';
  }
}
