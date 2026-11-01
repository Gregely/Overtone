import { registerSW } from 'virtual:pwa-register';

/** Register the service worker (production builds only). Updates apply on next load. */
export function setupPwa(): void {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  registerSW({ immediate: true });
}
