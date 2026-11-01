/// <reference lib="webworker" />
/**
 * Service worker:
 *  - precaches the app shell, so the UI loads offline (and then shows a clear
 *    "can't reach the server" state instead of a blank page);
 *  - serves index.html for client-side routes;
 *  - caches album artwork, keyed without its daily-rotating token;
 *  - never touches /api data or audio streams.
 */
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//] }));

registerRoute(
  ({ url, request }) => request.destination === 'image' && url.pathname.startsWith('/api/artwork/'),
  new CacheFirst({
    cacheName: 'artwork',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 800, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true }),
      {
        // The ?at= token rotates daily; the image doesn't.
        cacheKeyWillBeUsed: async ({ request }) => {
          const u = new URL(request.url);
          u.searchParams.delete('at');
          return u.href;
        },
      },
    ],
  }),
);
