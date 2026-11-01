import { registerSW } from 'virtual:pwa-register';
import { isNativeApp } from './platform/server-url';

/** Register the service worker (production builds only). Updates apply on next load. */
export function setupPwa(): void {
  // The Android app ships its assets inside the APK: no service worker there.
  if (import.meta.env.DEV || isNativeApp() || !('serviceWorker' in navigator)) return;
  registerSW({ immediate: true });
}
