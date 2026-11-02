import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CreateRetrievalJobRequestDto } from '@overtone/shared';
import { serverCoverUrl, type ViewContext } from '@overtone/core';
import { requireAdmin, userOf } from '../http/auth-hooks.js';
import type { Services } from '../services.js';

const jobIdParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

const createJobBody = {
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'magnet'],
  properties: {
    providerId: { type: 'string', minLength: 1, maxLength: 64 },
    magnet: { type: 'string', minLength: 1, maxLength: 2000 },
    title: { type: 'string', maxLength: 300 },
    artist: { type: 'string', maxLength: 300 },
    album: { type: 'string', maxLength: 300 },
    year: { type: 'integer', minimum: 1900, maximum: 2100 },
    size: { type: 'integer', minimum: 0 },
  },
} as const;

/**
 * Debrid retrieval. Admin-only: submitting a magnet changes the shared debrid
 * account, and only ever happens on explicit user action. Retrieval is now
 * backend-managed: jobs are created, polled and recovered here, not in the UI.
 */
export async function debridRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const view = (req: FastifyRequest): ViewContext => ({
    coverUrl: serverCoverUrl(s.auth.signArtworkToken(userOf(req).id)),
    categoryOf: s.api.categoryOf,
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/api/debrid/providers', async () => s.api.listDebridProviders());

    admin.get('/api/retrieval/jobs', async (req) => s.api.listRetrievalJobs(userOf(req).id));

    admin.get<{ Params: { id: string } }>('/api/retrieval/jobs/:id', { schema: { params: jobIdParam } }, async (req) =>
      s.api.getRetrievalJob(userOf(req).id, req.params.id),
    );

    admin.get<{ Params: { id: string } }>('/api/retrieval/jobs/:id/files', { schema: { params: jobIdParam } }, async (req) =>
      s.api.retrievalJobFiles(userOf(req).id, req.params.id, view(req)),
    );

    admin.post<{ Body: CreateRetrievalJobRequestDto }>('/api/retrieval/jobs', { schema: { body: createJobBody } }, async (req, reply) =>
      reply.code(201).send(await s.api.createRetrievalJob(userOf(req).id, req.body)),
    );

    admin.post<{ Params: { id: string } }>('/api/retrieval/jobs/:id/cancel', { schema: { params: jobIdParam } }, async (req) =>
      s.api.cancelRetrievalJob(userOf(req).id, req.params.id),
    );

    admin.post<{ Params: { id: string } }>('/api/retrieval/jobs/:id/retry', { schema: { params: jobIdParam } }, async (req) =>
      s.api.retryRetrievalJob(userOf(req).id, req.params.id),
    );
  });
}
