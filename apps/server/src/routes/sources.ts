import type { FastifyInstance } from 'fastify';
import type { SourceWriteDto } from '@overtone/shared';
import { requireAdmin } from '../http/auth-hooks.js';
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
  },
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

    admin.post<{ Body: SourceWriteDto }>('/api/sources', { schema: { body: { ...writeBody, required: ['providerId'] } } }, async (req, reply) =>
      reply.code(201).send(s.sources.toDto(s.sources.create(req.body))),
    );

    admin.patch<{ Params: { id: string }; Body: SourceWriteDto }>(
      '/api/sources/:id',
      { schema: { params: sourceIdParam, body: writeBody } },
      async (req) => s.sources.toDto(s.sources.update(req.params.id, req.body)),
    );

    admin.delete<{ Params: { id: string } }>('/api/sources/:id', { schema: { params: sourceIdParam } }, async (req, reply) => {
      await s.sources.delete(req.params.id);
      return reply.code(204).send();
    });

    /** Test an unsaved config ("Test connection" in the add-source form). */
    admin.post<{ Params: { providerId: string }; Body: { config?: Record<string, unknown> } }>(
      '/api/providers/:providerId/test',
      { schema: { body: { type: 'object', properties: { config: { type: 'object' } } } } },
      async (req) => s.sources.test(req.params.providerId, req.body?.config ?? {}),
    );

    /** Test a saved source, optionally with edited (unsaved) fields; stored secrets fill the gaps. */
    admin.post<{ Params: { id: string }; Body: { config?: Record<string, unknown> } }>(
      '/api/sources/:id/test',
      { schema: { params: sourceIdParam } },
      async (req) => {
        const row = s.sources.require(req.params.id);
        const stored = JSON.parse(row.config_json) as Record<string, unknown>;
        return s.sources.test(row.provider_id, { ...stored, ...(req.body?.config ?? {}) }, row.id);
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
