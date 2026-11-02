import type { FastifyInstance } from 'fastify';
import type { DiscoverRequestDto } from '@overtone/shared';
import type { Services } from '../services.js';

const discoverBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    trackId: { type: 'integer', minimum: 1 },
    albumId: { type: 'integer', minimum: 1 },
    type: { type: 'string', enum: ['track', 'album'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    query: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        artist: { type: 'string', maxLength: 200 },
        album: { type: 'string', maxLength: 200 },
        year: { type: 'integer', minimum: 1900, maximum: 2100 },
      },
    },
  },
} as const;

/**
 * "Find sources": search configured torrent indexers for a track or album.
 * Available to any signed-in user (it only searches; it changes nothing).
 */
export async function discoverRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.post<{ Body: DiscoverRequestDto }>('/api/discover', { schema: { body: discoverBody } }, async (req) => s.api.discover(req.body));
}
