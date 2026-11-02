import type { FastifyInstance } from 'fastify';
import type { DebridAddMagnetRequestDto } from '@overtone/shared';
import { requireAdmin } from '../http/auth-hooks.js';
import type { Services } from '../services.js';

const sourceIdParam = {
  type: 'object',
  required: ['sourceId'],
  properties: { sourceId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const addMagnetBody = {
  type: 'object',
  additionalProperties: false,
  required: ['magnet'],
  properties: { magnet: { type: 'string', minLength: 1, maxLength: 2000 } },
} as const;

/**
 * Debrid retrieval ("add to debrid"). Admin-only: submitting a magnet changes
 * the shared debrid account, and only ever happens on explicit user action.
 */
export async function debridRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/api/debrid/providers', async () => s.api.listDebridProviders());

    admin.post<{ Params: { sourceId: string }; Body: DebridAddMagnetRequestDto }>(
      '/api/debrid/:sourceId/add-magnet',
      { schema: { params: sourceIdParam, body: addMagnetBody } },
      async (req) => s.api.addMagnet(req.params.sourceId, req.body.magnet),
    );

    admin.get<{ Params: { sourceId: string; id: string } }>(
      '/api/debrid/:sourceId/status/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['sourceId', 'id'],
            properties: { sourceId: { type: 'string', maxLength: 64 }, id: { type: 'string', maxLength: 200 } },
          },
        },
      },
      async (req) => s.api.torrentStatus(req.params.sourceId, req.params.id),
    );
  });
}
