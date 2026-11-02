/**
 * Which mode the app runs in:
 *  - 'standalone': the library lives on this device (Android default);
 *  - 'server': connect to an Overtone server (always, for the web app the
 *    server itself serves).
 *
 * The choice is not a secret, so it lives in localStorage (read
 * synchronously at startup). Each mode keeps its own data: switching never
 * deletes the other mode's library, sources or sign-in.
 */
import type { AppMode } from '../api/client';
import { isNativeApp } from './server-url';

const MODE_KEY = 'overtone.mode';
/** Developer/test switch: offer standalone mode in a plain browser too. */
export const DEV_STANDALONE_KEY = 'overtone.dev.standalone';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Standalone mode needs the Android app (native HTTP, storage); browsers only for development. */
export function standaloneAvailable(): boolean {
  return isNativeApp() || read(DEV_STANDALONE_KEY) !== null;
}

export function storedMode(): AppMode | null {
  const m = read(MODE_KEY);
  if (m === 'standalone' && standaloneAvailable()) return 'standalone';
  if (m === 'server') return 'server';
  return null;
}

/** Mode to start in; null = ask (first launch of the app). */
export function initialMode(): AppMode | null {
  return storedMode() ?? (standaloneAvailable() ? null : 'server');
}

export function saveMode(mode: AppMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private mode: ask again next time */
  }
}
