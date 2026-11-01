import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Serve the built web app (apps/web/dist) at /, with an SPA fallback so deep
 * links like /albums/12 load index.html. Hashed assets are cached forever;
 * index.html, the service worker and the manifest must always revalidate so
 * updates roll out.
 */
export async function registerWebApp(app: FastifyInstance, webDir: string | null): Promise<((req: FastifyRequest, reply: FastifyReply) => boolean) | null> {
  if (!webDir) return null;
  if (!existsSync(path.join(webDir, 'index.html'))) {
    app.log.warn({ webDir }, 'OVERTONE_WEB_DIR has no index.html; not serving the web app');
    return null;
  }
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    index: false,
    wildcard: true,
    setHeaders(res, filePath) {
      const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
      res.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (filePath.endsWith('.webmanifest')) res.header('content-type', 'application/manifest+json');
    },
  });

  app.get('/', (_req, reply) => reply.header('cache-control', 'no-cache').sendFile('index.html'));

  /** Returns true if it handled the request (SPA navigation), for use in the 404 handler. */
  return (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const pathname = req.url.split('?')[0]!;
    if (pathname === '/api' || pathname.startsWith('/api/')) return false;
    if (path.extname(pathname)) return false; // a missing asset, not a route
    void reply.header('cache-control', 'no-cache').sendFile('index.html');
    return true;
  };
}
