import type { PluginListenerHandle } from '@capacitor/core';
import type { NativePlayerPlugin } from '../platform/native';

type Listener = (data: never) => void;

/** Stand-in for the Java NativePlayer plugin: records calls, lets tests fire native events. */
export class FakeNativePlayer {
  calls: Array<[string, unknown]> = [];
  listeners = new Map<string, Set<Listener>>();
  notificationGranted = true;

  readonly plugin: NativePlayerPlugin = {
    loadTrack: async (o) => void this.calls.push(['loadTrack', o]),
    preload: async (o) => void this.calls.push(['preload', o]),
    play: async () => void this.calls.push(['play', undefined]),
    pause: async () => void this.calls.push(['pause', undefined]),
    seek: async (o) => void this.calls.push(['seek', o]),
    setVolume: async (o) => void this.calls.push(['setVolume', o]),
    unload: async () => void this.calls.push(['unload', undefined]),
    requestNotificationPermission: async () => {
      this.calls.push(['requestNotificationPermission', undefined]);
      return { granted: this.notificationGranted };
    },
    addListener: (async (event: string, fn: Listener): Promise<PluginListenerHandle> => {
      const set = this.listeners.get(event) ?? new Set();
      set.add(fn);
      this.listeners.set(event, set);
      return { remove: async () => void set.delete(fn) };
    }) as NativePlayerPlugin['addListener'],
  };

  fire(event: string, data: unknown = {}): void {
    for (const fn of this.listeners.get(event) ?? []) (fn as (d: unknown) => void)(data);
  }

  named(name: string): unknown[] {
    return this.calls.filter(([n]) => n === name).map(([, o]) => o);
  }
}
