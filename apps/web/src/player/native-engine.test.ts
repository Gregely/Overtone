import { describe, expect, it, vi } from 'vitest';
import { FakeNativePlayer } from '../test/fake-native-player';
import { seeded, track, tracks } from '../test/fixtures';
import { PlayerController, type LinkFetcher, type StreamLink } from './controller';
import type { EngineEvent } from './engine';
import { NativeEngine } from './native-engine';

const flush = () => new Promise((r) => setTimeout(r, 0));

function engineOnly() {
  const native = new FakeNativePlayer();
  const engine = new NativeEngine(native.plugin);
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { native, engine, events };
}

function withController() {
  const native = new FakeNativePlayer();
  let issued = 0;
  const fetchLinks = vi.fn<LinkFetcher>(async (ids) => {
    issued++;
    return {
      links: new Map(ids.map((id): [number, StreamLink] => [id, { url: `http://srv/api/stream/${id}?st=v${issued}`, expiresAt: Date.now() + 6 * 3600_000, source: null }])),
      unavailable: [],
    };
  });
  const player = new PlayerController({
    engine: new NativeEngine(native.plugin),
    fetchLinks,
    random: seeded(),
    artworkUrl: (t) => `http://srv/api/artwork/release/${t.album?.id}?at=x&size=500`,
  });
  return { native, player, fetchLinks };
}

describe('NativeEngine (event translation)', () => {
  it('maps native state to engine events', async () => {
    const { native, events } = engineOnly();
    await flush();
    native.fire('state', { playing: true, playWhenReady: true, buffering: false });
    native.fire('state', { playing: false, playWhenReady: true, buffering: true }); // preparing / buffering
    native.fire('state', { playing: false, playWhenReady: false, buffering: false }); // paused (incl. notification / headset)
    native.fire('time', { position: 12.5, duration: 200 });
    native.fire('ended');
    native.fire('remote', { command: 'previous' });
    expect(events).toEqual([
      { type: 'playing' },
      { type: 'waiting' },
      { type: 'paused' },
      { type: 'time', position: 12.5, duration: 200 },
      { type: 'ended' },
      { type: 'remote', command: 'previous' },
    ]);
  });

  it('passes URL, start position, autoplay and notification metadata to the native player', async () => {
    const { native, engine } = engineOnly();
    const metadata = { title: 'T', artist: 'A', album: 'Al', artworkUrl: 'http://srv/art' };
    engine.load('http://srv/api/stream/1?st=x', { startAt: 42, autoplay: true, metadata });
    engine.preload('http://srv/api/stream/2?st=x', metadata);
    engine.preload(null);
    engine.seek(10);
    engine.setVolume(0.5);
    await flush();
    expect(native.calls).toEqual([
      ['loadTrack', { url: 'http://srv/api/stream/1?st=x', startAt: 42, autoplay: true, metadata }],
      ['preload', { url: 'http://srv/api/stream/2?st=x', metadata }],
      ['preload', { url: null }],
      ['seek', { position: 10 }],
      ['setVolume', { volume: 0.5 }],
    ]);
    expect(engine.position()).toBe(10);
  });

  it('keeps the position reported with a native error (for resume)', async () => {
    const { native, engine, events } = engineOnly();
    await flush();
    native.fire('error', { message: 'Response code: 403', code: 'ERROR_CODE_IO_BAD_HTTP_STATUS', position: 77.3 });
    expect(engine.position()).toBe(77.3);
    expect(events).toEqual([{ type: 'error', message: 'ERROR_CODE_IO_BAD_HTTP_STATUS: Response code: 403' }]);
  });

  it('asks for notification permission once, on the first user-initiated play', async () => {
    const { native, engine } = engineOnly();
    engine.prime();
    engine.prime();
    await flush();
    expect(native.named('requestNotificationPermission')).toHaveLength(1);
  });

  it('reports a failed native call as an engine error', async () => {
    const { native, engine, events } = engineOnly();
    native.plugin.loadTrack = async () => {
      throw new Error('service unavailable');
    };
    engine.load('http://x', { startAt: 0, autoplay: true });
    await flush();
    expect(events).toEqual([{ type: 'error', message: 'service unavailable' }]);
  });

  it('removes its native listeners on destroy', async () => {
    const { native, engine } = engineOnly();
    await flush();
    engine.destroy();
    await flush();
    expect([...native.listeners.values()].every((s) => s.size === 0)).toBe(true);
  });
});

describe('PlayerController on the native engine', () => {
  it('plays with notification metadata (title, artist, artwork)', async () => {
    const { native, player } = withController();
    player.playTracks([track(1, { album: { id: 9, title: 'Album Nine' } })], 0);
    await flush();
    expect(native.named('loadTrack')).toEqual([
      {
        url: 'http://srv/api/stream/1?st=v1',
        startAt: 0,
        autoplay: true,
        metadata: { title: 'Track 1', artist: 'Artist', album: 'Album Nine', artworkUrl: 'http://srv/api/artwork/release/9?at=x&size=500' },
      },
    ]);
    expect(native.named('requestNotificationPermission')).toHaveLength(1);
  });

  it('preloads the next track natively and follows a gapless hand-off without reloading', async () => {
    const { native, player } = withController();
    player.playTracks(tracks(1, 2, 3), 0);
    await flush();
    native.fire('state', { playing: true, playWhenReady: true, buffering: false });
    native.fire('time', { position: 170, duration: 180 });
    await flush();
    expect(native.named('preload')).toEqual([{ url: 'http://srv/api/stream/2?st=v1', metadata: expect.objectContaining({ title: 'Track 2' }) }]);

    native.fire('advanced', { url: 'http://srv/api/stream/2?st=v1' }); // ExoPlayer moved into the preloaded item
    await flush();
    expect(player.getSnapshot().current?.track.id).toBe(2);
    expect(native.named('loadTrack')).toHaveLength(1); // no reload, no gap
  });

  it('recovers from an expired link mid-track: fresh link, same position', async () => {
    const { native, player, fetchLinks } = withController();
    player.playTracks(tracks(1, 2), 0);
    await flush();
    native.fire('state', { playing: true, playWhenReady: true, buffering: false });
    native.fire('time', { position: 61, duration: 180 });
    native.fire('error', { message: 'Response code: 401', code: 'ERROR_CODE_IO_BAD_HTTP_STATUS', position: 61.5 });
    await flush();
    expect(fetchLinks).toHaveBeenCalledTimes(2);
    expect(native.named('loadTrack').at(-1)).toMatchObject({ url: 'http://srv/api/stream/1?st=v2', startAt: 61.5, autoplay: true });
  });

  it('acts on notification / headset next and previous', async () => {
    const { native, player } = withController();
    player.playTracks(tracks(1, 2, 3), 0);
    await flush();
    native.fire('remote', { command: 'next' });
    await flush();
    expect(player.getSnapshot().current?.track.id).toBe(2);
    native.fire('remote', { command: 'previous' });
    await flush();
    expect(player.getSnapshot().current?.track.id).toBe(1);
  });

  it('reflects pauses from outside the app (notification, call, headphones unplugged)', async () => {
    const { native, player } = withController();
    player.playTracks(tracks(1), 0);
    await flush();
    native.fire('state', { playing: true, playWhenReady: true, buffering: false });
    expect(player.getSnapshot().status).toBe('playing');
    native.fire('state', { playing: false, playWhenReady: false, buffering: false });
    expect(player.getSnapshot().status).toBe('paused');
    player.togglePlay();
    expect(native.calls.at(-1)).toEqual(['play', undefined]);
  });

  it('does not treat "preparing the next track" as a pause', async () => {
    const { native, player } = withController();
    player.playTracks(tracks(1, 2), 0);
    await flush();
    native.fire('state', { playing: false, playWhenReady: true, buffering: false });
    expect(player.getSnapshot().status).toBe('loading');
  });
});
