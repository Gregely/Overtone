import type { FastifyInstance } from 'fastify';
import type { SourceWriteDto, TorrentSourceWriteDto } from '@overtone/shared';
import { requireAdmin, userOf } from '../http/auth-hooks.js';
import type { Services } from '../services.js';

const sourceIdParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const writeBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    providerId: { type: 'string', maxLength: 64 },
    name: { type: 'string', maxLength: 100 },
    enabled: { type: 'boolean' },
    priority: { type: 'integer' },
    streamMode: { type: 'string', enum: ['proxy', 'redirect'] },
    config: { type: 'object' },
    deviceLogin: { type: 'string', maxLength: 100 },
  },
} as const;

const testBody = {
  type: 'object',
  additionalProperties: false,
  properties: { config: { type: 'object' }, deviceLogin: { type: 'string', maxLength: 100 } },
} as const;

/** HTTP adapter over CoreApi's source, device-login and scan operations. */
export async function sourceRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const api = s.api;
  app.get('/api/providers', async () => api.providers());

  // Everything below changes or reveals server configuration → admin only.
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/api/sources', async () => api.listSources());

    admin.get<{ Params: { id: string } }>('/api/sources/:id', { schema: { params: sourceIdParam } }, async (req) => api.source(req.params.id));

    admin.post<{ Body: SourceWriteDto }>('/api/sources', { schema: { body: { ...writeBody, required: ['providerId'] } } }, async (req, reply) =>
      reply.code(201).send(await api.createSource(req.body, userOf(req).id)),
    );

    admin.patch<{ Params: { id: string }; Body: SourceWriteDto }>(
      '/api/sources/:id',
      { schema: { params: sourceIdParam, body: writeBody } },
      async (req) => api.updateSource(req.params.id, req.body, userOf(req).id),
    );

    admin.delete<{ Params: { id: string } }>('/api/sources/:id', { schema: { params: sourceIdParam } }, async (req, reply) => {
      await api.deleteSource(req.params.id);
      return reply.code(204).send();
    });

    /** Test an unsaved config ("Test connection" in the add-source form). */
    admin.post<{ Params: { providerId: string }; Body: { config?: Record<string, unknown>; deviceLogin?: string } }>(
      '/api/providers/:providerId/test',
      { schema: { body: testBody } },
      async (req) => api.testProvider(req.params.providerId, req.body ?? {}, userOf(req).id),
    );

    /** Start a "Log in with …" flow. Returns the code + link to show; credentials stay on the server. */
    admin.post<{ Params: { providerId: string } }>(
      '/api/providers/:providerId/device-login',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => api.startDeviceLogin(req.params.providerId, userOf(req).id),
    );

    admin.get<{ Params: { flowId: string } }>(
      '/api/device-login/:flowId',
      { schema: { params: { type: 'object', required: ['flowId'], properties: { flowId: { type: 'string', maxLength: 100 } } } } },
      async (req) => api.pollDeviceLogin(req.params.flowId, userOf(req).id),
    );

    /** Test a saved source, optionally with edited (unsaved) fields; stored secrets fill the gaps. */
    admin.post<{ Params: { id: string }; Body: { config?: Record<string, unknown>; deviceLogin?: string } }>(
      '/api/sources/:id/test',
      { schema: { params: sourceIdParam, body: testBody } },
      async (req) => api.testSource(req.params.id, req.body ?? {}, userOf(req).id),
    );

    admin.post<{ Params: { id: string } }>('/api/sources/:id/scan', { schema: { params: sourceIdParam } }, async (req, reply) =>
      reply.code(202).send(await api.scanSource(req.params.id)),
    );

    admin.post('/api/scan', async (_req, reply) => reply.code(202).send(await api.scanAll()));

    admin.get('/api/scan/status', async () => api.scanStatus());
  });
}

const torrentSourceIdParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const torrentWriteBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['torznab', 'prowlarr', 'jackett'] },
    name: { type: 'string', maxLength: 100 },
    enabled: { type: 'boolean' },
    url: { type: 'string', maxLength: 1000 },
    apiKey: { type: ['string', 'null'], maxLength: 2000 },
    indexers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', maxLength: 200 },
          name: { type: 'string', maxLength: 200 },
          enabled: { type: 'boolean' },
          categories: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/** HTTP adapter over CoreApi's torrent source ("Find sources") operations. Admin only. */
export async function torrentSourceRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const api = s.api;
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/api/torrent-sources', async () => api.listTorrentSources());

    admin.get<{ Params: { id: string } }>('/api/torrent-sources/:id', { schema: { params: torrentSourceIdParam } }, async (req) =>
      api.torrentSource(req.params.id),
    );

    admin.post<{ Body: TorrentSourceWriteDto }>(
      '/api/torrent-sources',
      { schema: { body: { ...torrentWriteBody, required: ['kind'] } } },
      async (req, reply) => reply.code(201).send(await api.createTorrentSource(req.body)),
    );

    admin.patch<{ Params: { id: string }; Body: TorrentSourceWriteDto }>(
      '/api/torrent-sources/:id',
      { schema: { params: torrentSourceIdParam, body: torrentWriteBody } },
      async (req) => api.updateTorrentSource(req.params.id, req.body),
    );

    admin.delete<{ Params: { id: string } }>('/api/torrent-sources/:id', { schema: { params: torrentSourceIdParam } }, async (req, reply) => {
      await api.deleteTorrentSource(req.params.id);
      return reply.code(204).send();
    });

    admin.post<{ Body: TorrentSourceWriteDto }>(
      '/api/torrent-sources/test',
      { schema: { body: { ...torrentWriteBody, required: ['kind'] } } },
      async (req) => api.testTorrentSource(undefined, req.body),
    );

    admin.post<{ Params: { id: string }; Body: TorrentSourceWriteDto }>(
      '/api/torrent-sources/:id/test',
      { schema: { params: torrentSourceIdParam, body: torrentWriteBody } },
      async (req) => api.testTorrentSource(req.params.id, req.body),
    );
  });
}
