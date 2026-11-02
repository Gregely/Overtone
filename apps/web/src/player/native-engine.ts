import type { PluginListenerHandle } from '@capacitor/core';
import type { NativePlayerPlugin } from '../platform/native';
import type { EngineEvent, PlayerEngine, TrackMetadata } from './engine';

/**
 * PlayerEngine backed by the Android Media3 foreground service. Same contract
 * as HtmlAudioEngine, so PlayerController (queue, shuffle/repeat, link
 * refresh) is unchanged:
 *
 *  native event                         → engine event
 *  state {playing}                      → playing
 *  state {!playing, playWhenReady}      → waiting   (preparing / buffering)
 *  state {!playing, !playWhenReady}     → paused    (incl. notification / headset / focus loss)
 *  time                                 → time
 *  advanced {url} (gapless into preload)→ ended     (controller advances; the following load(url) is a no-op)
 *  ended                                → ended
 *  error {position}                     → error     (controller fetches a fresh link, load(url, startAt=position))
 *  remote {next|previous}               → remote
 */
export class NativeEngine implements PlayerEngine {
  readonly #plugin: NativePlayerPlugin;
  readonly #listeners = new Set<(e: EngineEvent) => void>();
  readonly #handles: Array<Promise<PluginListenerHandle>> = [];
  #position = 0;
  /** URL the native player advanced into on its own; the controller's next load() of it is a no-op. */
  #advancedTo: string | null = null;
  #askedNotifications = false;

  constructor(plugin: NativePlayerPlugin) {
    this.#plugin = plugin;
    this.#handles.push(
      plugin.addListener('state', (s) => this.#emit(s.playing ? { type: 'playing' } : s.playWhenReady ? { type: 'waiting' } : { type: 'paused' })),
      plugin.addListener('time', (t) => {
        this.#position = t.position;
        this.#emit({ type: 'time', position: t.position, duration: t.duration });
      }),
      plugin.addListener('advanced', (a) => {
        this.#advancedTo = a.url;
        this.#position = 0;
        this.#emit({ type: 'ended' });
      }),
      plugin.addListener('ended', () => this.#emit({ type: 'ended' })),
      plugin.addListener('error', (e) => {
        if (e.position > 0) this.#position = e.position;
        this.#emit({ type: 'error', message: e.code ? `${e.code}: ${e.message}` : e.message });
      }),
      plugin.addListener('remote', (r) => this.#emit({ type: 'remote', command: r.command === 'previous' ? 'previous' : 'next' })),
    );
  }

  #emit(e: EngineEvent): void {
    for (const fn of this.#listeners) fn(e);
  }

  #fail(err: unknown): void {
    this.#emit({ type: 'error', message: (err as Error)?.message ?? 'Native player error' });
  }

  subscribe(fn: (e: EngineEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  load(src: string, opts: { startAt: number; autoplay: boolean; metadata?: TrackMetadata; headers?: Record<string, string> }): void {
    if (src === this.#advancedTo) {
      // Already playing it (gapless hand-off). Only honour an explicit position / pause.
      this.#advancedTo = null;
      if (opts.startAt > 0) void this.#plugin.seek({ position: opts.startAt }).catch((e) => this.#fail(e));
      if (!opts.autoplay) void this.#plugin.pause().catch((e) => this.#fail(e));
      return;
    }
    this.#advancedTo = null;
    this.#position = opts.startAt;
    void this.#plugin
      .loadTrack({
        url: src,
        startAt: opts.startAt,
        autoplay: opts.autoplay,
        ...(opts.metadata ? { metadata: nativeMetadata(opts.metadata) } : {}),
        ...(opts.headers ? { headers: opts.headers } : {}),
      })
      .catch((e) => this.#fail(e));
  }

  unload(): void {
    this.#advancedTo = null;
    void this.#plugin.unload().catch(() => undefined);
  }

  play(): Promise<void> {
    return this.#plugin.play();
  }

  pause(): void {
    void this.#plugin.pause().catch(() => undefined);
  }

  seek(seconds: number): void {
    this.#position = seconds;
    void this.#plugin.seek({ position: seconds }).catch(() => undefined);
  }

  preload(src: string | null, metadata?: TrackMetadata, headers?: Record<string, string>): void {
    void this.#plugin
      .preload({ url: src, ...(metadata ? { metadata: nativeMetadata(metadata) } : {}), ...(headers ? { headers } : {}) })
      .catch(() => undefined);
  }

  setVolume(volume: number): void {
    void this.#plugin.setVolume({ volume }).catch(() => undefined);
  }

  position(): number {
    return this.#position;
  }

  /**
   * Called inside the user gesture that starts playback: the sensible moment to
   * ask for the Android 13+ notification permission (needed to show the media
   * notification; playback works either way).
   */
  prime(): void {
    if (this.#askedNotifications) return;
    this.#askedNotifications = true;
    void this.#plugin.requestNotificationPermission().catch(() => undefined);
  }

  destroy(): void {
    this.#listeners.clear();
    for (const h of this.#handles) void h.then((x) => x.remove()).catch(() => undefined);
  }
}

/**
 * Artwork for the media notification is loaded by Media3, natively. A cover
 * cached in app storage is shown to the WebView as
 * http://localhost/_capacitor_file_/<path>, which only the WebView can open:
 * hand Media3 the file:// path instead.
 */
export function nativeMetadata(m: TrackMetadata): TrackMetadata {
  const art = m.artworkUrl?.match(/^https?:\/\/localhost\/_capacitor_file_(\/.*)$/);
  return art ? { ...m, artworkUrl: `file://${art[1]}` } : m;
}
