import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ApiErrorDto } from '@overtone/shared';
import type { Config } from './config.js';
import { requireAuth } from './http/auth-hooks.js';
import { ApiError } from './http/errors.js';
import { redactUrl } from './http/redact.js';
import { registerWebApp } from './http/web-app.js';
import { PROVIDER_ERROR_HTTP_STATUS, ProviderError } from '@overtone/core';
import { accountRoutes, publicAuthRoutes } from './routes/auth.js';
import { libraryRoutes } from './routes/library.js';
import { discoverRoutes } from './routes/discover.js';
import { debridRoutes } from './routes/debrid.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { mediaRoutes } from './routes/media.js';
import { sourceRoutes, torrentSourceRoutes } from './routes/sources.js';
import { createServices, type ServiceOverrides, type Services } from './services.js';
import type { Logger } from '@overtone/core';

export interface BuildAppOptions extends ServiceOverrides {
  config: Config;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(opts: BuildAppOptions): Promise<{ app: FastifyInstance; services: Services }> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        // Never log query strings verbatim: stream/artwork URLs carry tokens.
        req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, useDefaults: true } },
  });

  const services = createServices(config, app.log as unknown as Logger, opts);
  app.decorateRequest('user', null);
  app.addHook('onClose', () => services.close());

  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header: same-origin, curl, or native clients.
      if (!origin) return cb(null, true);
      cb(null, config.corsOrigins.includes('*') || config.corsOrigins.includes(origin));
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Range', 'If-Range'],
    exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'Content-Type'],
    maxAge: 86400,
  });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, req, reply) => {
    const send = (status: number, body: ApiErrorDto) => reply.code(status).send(body);
    if (err instanceof ApiError) {
      return send(err.statusCode, { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
    }
    if (err instanceof ProviderError) {
      req.log.warn({ code: err.code, message: err.message }, 'provider error');
      if (err.options.retryAfterMs) reply.header('retry-after', Math.ceil(err.options.retryAfterMs / 1000));
      return send(PROVIDER_ERROR_HTTP_STATUS[err.code], { error: { code: `provider_${err.code}`, message: err.message } });
    }
    const e = err as Error & { validation?: unknown; statusCode?: number; code?: string };
    if (e.validation) return send(400, { error: { code: 'bad_request', message: e.message } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return send(e.statusCode, { error: { code: e.code?.toLowerCase() ?? 'bad_request', message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return send(500, { error: { code: 'internal', message: 'Internal server error' } });
  });

  // Baseline hardening. no-referrer matters: stream/artwork URLs carry tokens.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
  });

  const spaFallback = await registerWebApp(app, config.webDir);
  app.setNotFoundHandler((req, reply) => {
    if (spaFallback?.(req, reply)) return;
    return reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${redactUrl(req.url.split('?')[0]!)}` } });
  });

  app.get('/api/health', async () => ({ ok: true, version: config.version }));
  await app.register(async (pub) => {
    await publicAuthRoutes(pub, services);
    await mediaRoutes(pub, services);
  });
  await app.register(async (authed) => {
    authed.addHook('preHandler', requireAuth(services.auth));
    await accountRoutes(authed, services);
    await sourceRoutes(authed, services);
    await torrentSourceRoutes(authed, services);
    await libraryRoutes(authed, services);
    await discoverRoutes(authed, services);
    await debridRoutes(authed, services);
    await catalogueRoutes(authed, services);
  });

  return { app, services };
}
