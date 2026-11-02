/**
 * Native plugins used by standalone mode (implemented in apps/web/android):
 *  - DeviceFolder: Storage Access Framework folders ("This device" source)
 *  - BackgroundWork: foreground service + notification for long scans, native timers
 *  - AppStorage: app-private files (artwork cache) and storage figures
 * Plus @capacitor-community/sqlite (library database) and CapacitorHttp
 * (provider traffic without CORS). Never called on the web.
 */
import { registerPlugin } from '@capacitor/core';

export interface DeviceFolderInfo {
  /** content:// tree URI (persisted read permission). */
  uri: string;
  name: string;
  /** False when the permission was revoked or the folder is gone. */
  granted: boolean;
}

export interface DeviceFileEntry {
  /** Document id: stable for the file across scans. */
  id: string;
  name: string;
  /** Path inside the picked folder ("Artist/Album/01 Song.flac"). */
  path: string;
  size: number;
  /** Epoch ms, 0 if unknown. */
  modified: number;
  mime: string | null;
}

export interface DeviceFolderPlugin {
  /** Show the system folder picker; persists read permission for the chosen folder. */
  pick(): Promise<{ folder: DeviceFolderInfo | null }>;
  /** Folders this app holds a persisted permission for. */
  folders(): Promise<{ folders: DeviceFolderInfo[] }>;
  /** Give up the permission for folders not in `keep`. */
  prune(options: { keep: string[] }): Promise<void>;
  /** One page of a recursive listing. Pass the returned cursor until it's null. */
  list(options: { uri: string; cursor?: string | null; limit?: number }): Promise<{ files: DeviceFileEntry[]; cursor: string | null }>;
  /** Read `length` bytes at `offset` (base64). */
  read(options: { uri: string; offset: number; length: number }): Promise<{ data: string }>;
  stat(options: { uri: string }): Promise<{ size: number; exists: boolean }>;
  /** The file's embedded cover picture, if any (base64). */
  picture(options: { uri: string }): Promise<{ data: string | null; mimeType: string | null }>;
}

export interface BackgroundWorkPlugin {
  /** Start (or update) the foreground service with a visible notification. */
  start(options: { title: string; text: string; progress?: number | null }): Promise<void>;
  stop(): Promise<void>;
  /** Native timer: resolves after `ms` even while the WebView is in the background. */
  sleep(options: { ms: number }): Promise<void>;
  /** Ask for notification permission (Android 13+), so the progress notification can show. */
  requestNotificationPermission(): Promise<{ granted: boolean }>;
}

export interface AppStoragePlugin {
  /** Absolute paths of app-private directories and the library database size. */
  info(options: { database: string }): Promise<{ filesDir: string; databaseBytes: number }>;
  writeFile(options: { path: string; data: string }): Promise<void>;
  readFile(options: { path: string }): Promise<{ data: string | null }>;
  deletePrefix(options: { dir: string; prefix: string }): Promise<void>;
  dirSize(options: { dir: string }): Promise<{ bytes: number }>;
  /** System "save as" picker; writes `text` to the chosen document. */
  saveDocument(options: { name: string; mimeType: string; text: string }): Promise<{ saved: boolean }>;
  /** System "open" picker; returns the chosen document's text (max 64 MB). */
  openDocument(options: { mimeTypes: string[] }): Promise<{ name: string | null; text: string | null }>;
}

export const DeviceFolder = registerPlugin<DeviceFolderPlugin>('DeviceFolder');
export const BackgroundWork = registerPlugin<BackgroundWorkPlugin>('BackgroundWork');
export const AppStorage = registerPlugin<AppStoragePlugin>('AppStorage');
