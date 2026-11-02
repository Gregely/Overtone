import type { FastifyInstance } from 'fastify';
import { userOf } from '../http/auth-hooks.js';
import type { Services } from '../services.js';

const mbidParam = {
  type: 'object',
  required: ['mbid'],
  properties: { mbid: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const playBody = {
  type: 'object',
  additionalProperties: false,
  required: ['releaseGroupMbid'],
  properties: { releaseGroupMbid: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

/**
 * MusicBrainz catalogue: browse/search, independent of library or torrents.
 * Available to any signed-in user; no debrid provider is required.
 */
export async function catalogueRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.get<{ Querystring: { q?: string } }>(
    '/api/catalogue/search',
    { schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 } } } } },
    async (req) => s.api.catalogueSearch(req.query.q ?? ''),
  );

  app.get<{ Params: { mbid: string } }>('/api/catalogue/artists/:mbid', { schema: { params: mbidParam } }, async (req) =>
    s.api.catalogueArtist(req.params.mbid),
  );

  app.get<{ Params: { mbid: string } }>('/api/catalogue/releases/:mbid', { schema: { params: mbidParam } }, async (req) =>
    s.api.catalogueRelease(req.params.mbid),
  );

  app.post<{ Body: { releaseGroupMbid: string } }>('/api/catalogue/play', { schema: { body: playBody } }, async (req) =>
    s.api.playCatalogue(req.body.releaseGroupMbid, userOf(req).id),
  );
}
