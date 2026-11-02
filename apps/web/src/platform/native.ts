/**
 * Capacitor plugins implemented in apps/web/android (Java):
 *  - NativePlayer: Media3 foreground playback service (playback/NativePlayerPlugin.java)
 *  - SecureStorage: Android Keystore-encrypted key/value store (storage/SecureStoragePlugin.java)
 * On the web these are never called (see isNativeApp()).
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { TrackMetadata } from '../player/engine';

export interface NativeStateEvent {
  playing: boolean;
  playWhenReady: boolean;
  buffering: boolean;
}

export interface NativePlayerPlugin {
  loadTrack(options: { url: string; startAt: number; autoplay: boolean; metadata?: TrackMetadata; headers?: Record<string, string> }): Promise<void>;
  preload(options: { url: string | null; metadata?: TrackMetadata; headers?: Record<string, string> }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  unload(): Promise<void>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  addListener(event: 'state', fn: (e: NativeStateEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'time', fn: (e: { position: number; duration: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'advanced', fn: (e: { url: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'ended', fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'error', fn: (e: { message: string; code: string; position: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'remote', fn: (e: { command: 'next' | 'previous' }) => void): Promise<PluginListenerHandle>;
}

export interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

export const NativePlayer = registerPlugin<NativePlayerPlugin>('NativePlayer');
export const SecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage');
