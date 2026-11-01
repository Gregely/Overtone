import type { FastifyInstance } from 'fastify';
import type { SourceWriteDto } from '@overtone/shared';
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

export async function sourceRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.get('/api/providers', async () => s.registry.toDtos());

  // Everything below changes or reveals server configuration → admin only.
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/api/sources', async () => s.sources.list().map((r) => s.sources.toDto(r)));

    admin.get<{ Params: { id: string } }>('/api/sources/:id', { schema: { params: sourceIdParam } }, async (req) =>
      s.sources.toDto(s.sources.require(req.params.id)),
    );

    const loginSecrets = (req: { body?: { deviceLogin?: string } }, user: number, providerId: string, consume: boolean) =>
      req.body?.deviceLogin ? s.deviceLogins.credentials(req.body.deviceLogin, providerId, user, consume) : undefined;

    admin.post<{ Body: SourceWriteDto }>('/api/sources', { schema: { body: { ...writeBody, required: ['providerId'] } } }, async (req, reply) => {
      const device = loginSecrets(req, userOf(req).id, req.body.providerId!, false);
      const row = s.sources.create(req.body, device);
      if (req.body.deviceLogin) loginSecrets(req, userOf(req).id, row.provider_id, true);
      return reply.code(201).send(s.sources.toDto(row));
    });

    admin.patch<{ Params: { id: string }; Body: SourceWriteDto }>(
      '/api/sources/:id',
      { schema: { params: sourceIdParam, body: writeBody } },
      async (req) => {
        const current = s.sources.require(req.params.id);
        const device = loginSecrets(req, userOf(req).id, current.provider_id, false);
        const row = s.sources.update(req.params.id, req.body, device);
        if (req.body.deviceLogin) loginSecrets(req, userOf(req).id, row.provider_id, true);
        return s.sources.toDto(row);
      },
    );

    admin.delete<{ Params: { id: string } }>('/api/sources/:id', { schema: { params: sourceIdParam } }, async (req, reply) => {
      await s.sources.delete(req.params.id);
      return reply.code(204).send();
    });

    /** Test an unsaved config ("Test connection" in the add-source form). */
    admin.post<{ Params: { providerId: string }; Body: { config?: Record<string, unknown>; deviceLogin?: string } }>(
      '/api/providers/:providerId/test',
      { schema: { body: testBody } },
      async (req) =>
        s.sources.test(req.params.providerId, req.body?.config ?? {}, undefined, loginSecrets(req, userOf(req).id, req.params.providerId, false)),
    );

    /** Start a "Log in with …" flow. Returns the code + link to show; credentials stay on the server. */
    admin.post<{ Params: { providerId: string } }>(
      '/api/providers/:providerId/device-login',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => s.deviceLogins.start(req.params.providerId, userOf(req).id),
    );

    admin.get<{ Params: { flowId: string } }>(
      '/api/device-login/:flowId',
      { schema: { params: { type: 'object', required: ['flowId'], properties: { flowId: { type: 'string', maxLength: 100 } } } } },
      async (req) => s.deviceLogins.poll(req.params.flowId, userOf(req).id),
    );

    /** Test a saved source, optionally with edited (unsaved) fields; stored secrets fill the gaps. */
    admin.post<{ Params: { id: string }; Body: { config?: Record<string, unknown>; deviceLogin?: string } }>(
      '/api/sources/:id/test',
      { schema: { params: sourceIdParam, body: testBody } },
      async (req) => {
        const row = s.sources.require(req.params.id);
        const stored = JSON.parse(row.config_json) as Record<string, unknown>;
        return s.sources.test(row.provider_id, { ...stored, ...(req.body?.config ?? {}) }, row.id, loginSecrets(req, userOf(req).id, row.provider_id, false));
      },
    );

    admin.post<{ Params: { id: string } }>('/api/sources/:id/scan', { schema: { params: sourceIdParam } }, async (req, reply) => {
      s.sources.require(req.params.id);
      s.scanner.enqueue(req.params.id);
      return reply.code(202).send(s.scanner.status(s.matchStatus()));
    });

    admin.post('/api/scan', async (_req, reply) => {
      s.scanner.enqueueAll();
      return reply.code(202).send(s.scanner.status(s.matchStatus()));
    });

    admin.get('/api/scan/status', async () => s.scanner.status(s.matchStatus()));
  });
}
