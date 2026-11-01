import { describe, expect, it, vi } from 'vitest';
import { HtmlAudioEngine } from './html-audio-engine';

/** jsdom has no media playback; stub play/pause/load so we can drive event ordering. */
function stubMedia() {
  const resolvers: Array<() => void> = [];
  const pausedSrcs: string[] = [];
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    return new Promise<void>((r) => resolvers.push(r));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    pausedSrcs.push(this.src);
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
    this.dispatchEvent(new Event('pause'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  return { pausedSrcs, resolveAllPlays: () => resolvers.splice(0).forEach((r) => r()) };
}

describe('HtmlAudioEngine', () => {
  it('does not pause a real track that loaded before the priming clip finished starting', async () => {
    const media = stubMedia();
    const engine = new HtmlAudioEngine();
    const events: string[] = [];
    engine.subscribe((e) => events.push(e.type));

    engine.prime(); // inside the click: silent clip starts (promise pending)
    engine.load('http://srv/api/stream/1?st=x', { startAt: 0, autoplay: true }); // link was cached: loads immediately
    media.resolveAllPlays(); // now the priming play() promises settle
    await Promise.resolve();
    await Promise.resolve();

    expect(events).not.toContain('paused');
    // Only the idle element's silent clip may be stopped, never the real track.
    expect(media.pausedSrcs.every((src) => src.startsWith('data:audio/wav'))).toBe(true);
    expect(media.pausedSrcs.some((src) => src.includes('/api/stream/'))).toBe(false);
    vi.restoreAllMocks();
  });
});
