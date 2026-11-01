import type { EngineEvent, PlayerEngine } from '../player/engine';

/** Scriptable engine double: records calls, lets tests emit events. */
export class FakeEngine implements PlayerEngine {
  calls: string[] = [];
  src: string | null = null;
  preloaded: string | null = null;
  pos = 0;
  playing = false;
  volume = 1;
  primed = 0;
  readonly #listeners = new Set<(e: EngineEvent) => void>();

  load(src: string, opts: { startAt: number; autoplay: boolean }) {
    this.calls.push(`load ${src} @${opts.startAt}${opts.autoplay ? ' autoplay' : ''}`);
    this.src = src;
    this.pos = opts.startAt;
    this.playing = opts.autoplay;
  }
  unload() {
    this.calls.push('unload');
    this.src = null;
    this.playing = false;
  }
  async play() {
    this.calls.push('play');
    this.playing = true;
  }
  pause() {
    this.calls.push('pause');
    this.playing = false;
  }
  seek(s: number) {
    this.calls.push(`seek ${s}`);
    this.pos = s;
  }
  preload(src: string | null) {
    this.calls.push(`preload ${src}`);
    this.preloaded = src;
  }
  setVolume(v: number) {
    this.volume = v;
  }
  position() {
    return this.pos;
  }
  prime() {
    this.primed++;
  }
  subscribe(fn: (e: EngineEvent) => void) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  destroy() {}

  emit(e: EngineEvent) {
    if (e.type === 'time') this.pos = e.position;
    for (const fn of this.#listeners) fn(e);
  }
  /** Simulate playback reaching `position` seconds. */
  tick(position: number, duration = 180) {
    this.emit({ type: 'time', position, duration });
  }
  lastLoad() {
    return [...this.calls].reverse().find((c) => c.startsWith('load '));
  }
}
