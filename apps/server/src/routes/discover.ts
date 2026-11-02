import type { FastifyInstance } from 'fastify';
import type { DiscoverRequestDto, DiscoveryPreferencesDto } from '@overtone/shared';
import { userOf } from '../http/auth-hooks.js';
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

const preferencesBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    preferredFormat: { type: 'string', enum: ['any', 'flac', 'mp3'] },
    minBitrateKbps: { type: ['integer', 'null'], minimum: 0, maximum: 1000 },
    preferredProvider: { type: 'string', maxLength: 64 },
    rememberLastProvider: { type: 'boolean' },
    prioritizeCached: { type: 'boolean' },
    hideUncached: { type: 'boolean' },
    searchScope: { type: 'string', enum: ['auto', 'track', 'album'] },
  },
} as const;

/**
 * "Find sources" and discovery preferences. Discovery is available to any
 * signed-in user (it only searches); preferences are stored per user.
 */
export async function discoverRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.post<{ Body: DiscoverRequestDto }>('/api/discover', { schema: { body: discoverBody } }, async (req) =>
    s.api.discover(req.body, userOf(req).id),
  );

  app.get('/api/preferences', async (req) => s.api.getPreferences(userOf(req).id));

  app.put<{ Body: DiscoveryPreferencesDto }>('/api/preferences', { schema: { body: preferencesBody } }, async (req) =>
    s.api.setPreferences(userOf(req).id, req.body),
  );
}
