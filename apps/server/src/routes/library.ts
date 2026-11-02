import type { FastifyInstance, FastifyRequest } from 'fastify';
import { serverCoverUrl, type ViewContext } from '@overtone/core';
import type { FileMatchRequestDto, MatchStatus, StreamUrlsRequestDto, StreamUrlsResponseDto } from '@overtone/shared';
import { requireAdmin, userOf } from '../http/auth-hooks.js';
import type { Services } from '../services.js';
import { idParam } from './auth.js';

const pageQuery = {
  type: 'object',
  properties: {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    q: { type: 'string', maxLength: 200 },
    sort: { type: 'string' },
    artistId: { type: 'integer', minimum: 1 },
  },
} as const;

type PageQuery = { offset?: number; limit?: number; q?: string; sort?: string; artistId?: number };

const MATCH_STATUSES: readonly MatchStatus[] = ['pending', 'matched', 'needs_review', 'unmatched', 'manual'];

/** HTTP adapter over CoreApi's library + matching operations. */
export async function libraryRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const api = s.api;
  const view = (req: FastifyRequest): ViewContext => ({
    coverUrl: serverCoverUrl(s.auth.signArtworkToken(userOf(req).id)),
    categoryOf: api.categoryOf,
  });

  app.get('/api/library/home', async (req) => api.home(view(req)));

  app.get<{ Querystring: PageQuery }>('/api/library/artists', { schema: { querystring: pageQuery } }, async (req) => api.artists(req.query));

  app.get<{ Params: { id: number } }>('/api/library/artists/:id', { schema: { params: idParam } }, async (req) => api.artist(req.params.id, view(req)));

  app.get<{ Querystring: PageQuery }>('/api/library/albums', { schema: { querystring: pageQuery } }, async (req) => api.albums(req.query, view(req)));

  app.get<{ Params: { id: number } }>('/api/library/albums/:id', { schema: { params: idParam } }, async (req) => api.album(req.params.id, view(req)));

  app.get<{ Querystring: PageQuery }>('/api/library/tracks', { schema: { querystring: pageQuery } }, async (req) => api.tracks(req.query, view(req)));

  app.get<{ Params: { id: number } }>('/api/library/tracks/:id', { schema: { params: idParam } }, async (req) => api.track(req.params.id, view(req)));

  app.get<{ Querystring: { q?: string } }>(
    '/api/search',
    { schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 } } } } },
    async (req) => api.search(req.query.q ?? '', view(req)),
  );

  // ── Playback ──────────────────────────────────────────────────────────────

  app.post<{ Body: StreamUrlsRequestDto }>(
    '/api/stream-urls',
    {
      schema: {
        body: {
          type: 'object',
          required: ['trackIds'],
          additionalProperties: false,
          properties: {
            trackIds: { type: 'array', maxItems: 500, items: { type: 'integer', minimum: 1 } },
            preferSourceId: { type: 'string', maxLength: 64 },
            // Accepted for client compatibility; the proxy re-resolves failed links itself.
            refresh: { type: 'array', maxItems: 500, items: { type: 'integer', minimum: 1 } },
          },
        },
      },
    },
    async (req): Promise<StreamUrlsResponseDto> => {
      const user = userOf(req);
      const { picks, unavailable } = await api.pickSources(req.body.trackIds, req.body.preferSourceId);
      const out: StreamUrlsResponseDto = { items: [], unavailable };
      for (const { trackId, pick } of picks) {
        const { token, expiresAt } = s.auth.signStreamToken(user.id, pick.sourceFileId);
        out.items.push({
          trackId,
          url: `/api/stream/${pick.sourceFileId}?st=${token}`,
          expiresAt: expiresAt.toISOString(),
          mimeType: pick.mime,
          source: { sourceId: pick.sourceId, sourceName: pick.sourceName, providerId: pick.providerId, category: api.categoryOf(pick.providerId) },
        });
      }
      return out;
    },
  );

  // ── Matching ("fix match") — admin only ──────────────────────────────────

  app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get<{ Querystring: { status?: MatchStatus; sourceId?: string; trackId?: number; offset?: number; limit?: number } }>(
      '/api/library/files',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: MATCH_STATUSES },
              sourceId: { type: 'string' },
              trackId: { type: 'integer' },
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 500 },
            },
          },
        },
      },
      async (req) => api.listFiles(req.query),
    );

    admin.get<{ Params: { id: number } }>('/api/library/files/:id', { schema: { params: idParam } }, async (req) => api.file(req.params.id));

    /** Search MusicBrainz for a file; results are scored against the file's tags. */
    admin.get<{ Params: { id: number }; Querystring: { title?: string; artist?: string } }>(
      '/api/library/files/:id/candidates',
      {
        schema: {
          params: idParam,
          querystring: { type: 'object', properties: { title: { type: 'string', maxLength: 300 }, artist: { type: 'string', maxLength: 300 } } },
        },
      },
      async (req) => api.candidates(req.params.id, req.query),
    );

    admin.post<{ Params: { id: number }; Body: FileMatchRequestDto }>(
      '/api/library/files/:id/match',
      {
        schema: {
          params: idParam,
          body: {
            type: 'object',
            required: ['recordingMbid'],
            additionalProperties: false,
            properties: { recordingMbid: { type: 'string', format: 'uuid' }, releaseMbid: { type: 'string', format: 'uuid' } },
          },
        },
      },
      async (req) => api.matchFile(req.params.id, req.body),
    );

    admin.post<{ Params: { id: number } }>('/api/library/files/:id/rematch', { schema: { params: idParam } }, async (req) => api.rematch(req.params.id));

    admin.get<{ Querystring: { q: string; artist?: string } }>(
      '/api/match/releases',
      {
        schema: {
          querystring: {
            type: 'object',
            required: ['q'],
            properties: { q: { type: 'string', minLength: 1, maxLength: 300 }, artist: { type: 'string', maxLength: 300 } },
          },
        },
      },
      async (req) => api.releaseCandidates(req.query.q, req.query.artist),
    );

    /** Re-match every file of an album to a chosen MusicBrainz release. */
    admin.post<{ Params: { id: number }; Body: { releaseMbid: string } }>(
      '/api/library/albums/:id/match',
      {
        schema: {
          params: idParam,
          body: {
            type: 'object',
            required: ['releaseMbid'],
            additionalProperties: false,
            properties: { releaseMbid: { type: 'string', format: 'uuid' } },
          },
        },
      },
      async (req) => api.matchAlbum(req.params.id, req.body.releaseMbid, view(req)),
    );
  });
}
