import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  FileMatchRequestDto,
  MatchCandidateDto,
  MatchStatus,
  ReleaseCandidateDto,
  StreamUrlsRequestDto,
  StreamUrlsResponseDto,
} from '@overtone/shared';
import { requireAdmin, userOf } from '../http/auth-hooks.js';
import { ApiError } from '../http/errors.js';
import { toCandidateDto, type AlbumSort, type ViewContext } from '../library/repo.js';
import { luceneEscape } from '../metadata/musicbrainz/client.js';
import type { FileTags } from '../providers/types.js';
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

export async function libraryRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const view = (req: FastifyRequest): ViewContext => ({
    artworkToken: s.auth.signArtworkToken(userOf(req).id),
    categoryOf: (providerId) => s.registry.get(providerId)?.manifest.category ?? 'server',
  });

  app.get('/api/library/home', async (req) => s.library.home(view(req)));

  app.get<{ Querystring: PageQuery }>('/api/library/artists', { schema: { querystring: pageQuery } }, async (req) =>
    s.library.listArtists(req.query),
  );

  app.get<{ Params: { id: number } }>('/api/library/artists/:id', { schema: { params: idParam } }, async (req) => {
    const a = s.library.getArtist(req.params.id, view(req));
    if (!a) throw ApiError.notFound('Artist');
    return a;
  });

  app.get<{ Querystring: PageQuery }>('/api/library/albums', { schema: { querystring: pageQuery } }, async (req) => {
    const { sort: rawSort, ...rest } = req.query;
    const sort = (['name', 'recent', 'year', 'artist', 'random'] as const).find((x) => x === rawSort) as AlbumSort | undefined;
    return s.library.listAlbums({ ...rest, ...(sort ? { sort } : {}) }, view(req));
  });

  app.get<{ Params: { id: number } }>('/api/library/albums/:id', { schema: { params: idParam } }, async (req) => {
    const a = s.library.getAlbum(req.params.id, view(req));
    if (!a) throw ApiError.notFound('Album');
    return a;
  });

  app.get<{ Querystring: PageQuery }>('/api/library/tracks', { schema: { querystring: pageQuery } }, async (req) => {
    const { sort: rawSort, artistId: _artistId, ...rest } = req.query;
    const sort = (['name', 'recent', 'artist'] as const).find((x) => x === rawSort);
    return s.library.listTracks({ ...rest, ...(sort ? { sort } : {}) }, view(req));
  });

  app.get<{ Params: { id: number } }>('/api/library/tracks/:id', { schema: { params: idParam } }, async (req) => {
    const [t] = s.library.getTracks([req.params.id], view(req));
    if (!t) throw ApiError.notFound('Track');
    return t;
  });

  app.get<{ Querystring: { q?: string } }>(
    '/api/search',
    { schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 } } } } },
    async (req) => s.library.search(req.query.q ?? '', view(req)),
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
          },
        },
      },
    },
    async (req): Promise<StreamUrlsResponseDto> => {
      const user = userOf(req);
      const out: StreamUrlsResponseDto = { items: [], unavailable: [] };
      for (const trackId of req.body.trackIds) {
        const options = s.library.playableSources(trackId);
        const pick = options.find((o) => o.sourceId === req.body.preferSourceId) ?? options[0];
        if (!pick) {
          out.unavailable.push(trackId);
          continue;
        }
        const { token, expiresAt } = s.auth.signStreamToken(user.id, pick.sourceFileId);
        out.items.push({
          trackId,
          url: `/api/stream/${pick.sourceFileId}?st=${token}`,
          expiresAt: expiresAt.toISOString(),
          mimeType: pick.mime,
          source: {
            sourceId: pick.sourceId,
            sourceName: pick.sourceName,
            providerId: pick.providerId,
            category: s.registry.get(pick.providerId)?.manifest.category ?? 'server',
          },
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
      async (req) => s.library.listFiles(req.query),
    );

    admin.get<{ Params: { id: number } }>('/api/library/files/:id', { schema: { params: idParam } }, async (req) => {
      const f = s.library.fileDto(req.params.id);
      if (!f) throw ApiError.notFound('File');
      return f;
    });

    /** Search MusicBrainz for a file; results are scored against the file's tags. */
    admin.get<{ Params: { id: number }; Querystring: { title?: string; artist?: string } }>(
      '/api/library/files/:id/candidates',
      {
        schema: {
          params: idParam,
          querystring: { type: 'object', properties: { title: { type: 'string', maxLength: 300 }, artist: { type: 'string', maxLength: 300 } } },
        },
      },
      async (req): Promise<MatchCandidateDto[]> => {
        const file = s.library.getFile(req.params.id);
        if (!file) throw ApiError.notFound('File');
        const tags: FileTags = file.tags_json ? JSON.parse(file.tags_json) : {};
        const search: FileTags = { ...tags };
        if (req.query.title) search.title = req.query.title;
        if (req.query.artist) search.artist = req.query.artist;
        const result = await s.matcher.matchOne({ key: file.id, path: file.path, tags: search }, new Set(), 25);
        return result.candidates.map(toCandidateDto);
      },
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
      async (req) => {
        const file = s.library.getFile(req.params.id);
        if (!file) throw ApiError.notFound('File');
        const tags: FileTags = file.tags_json ? JSON.parse(file.tags_json) : {};
        const pinned: FileTags = {
          ...tags,
          musicbrainz: { recordingId: req.body.recordingMbid, ...(req.body.releaseMbid ? { releaseId: req.body.releaseMbid } : {}) },
        };
        const r = await s.matcher.matchGroup([{ key: file.id, path: file.path, tags: pinned }]);
        const result = r.get(file.id);
        if (!result?.best) throw ApiError.badRequest('Recording not found on MusicBrainz');
        if (req.body.releaseMbid && result.best.release?.mbid !== req.body.releaseMbid) {
          throw ApiError.badRequest('That recording is not on the selected release');
        }
        s.library.applyMatch(file.id, 'manual', 1, result.best, result.candidates);
        s.library.cleanupOrphans();
        return s.library.fileDto(file.id);
      },
    );

    admin.post<{ Params: { id: number } }>('/api/library/files/:id/rematch', { schema: { params: idParam } }, async (req) => {
      if (!s.library.getFile(req.params.id)) throw ApiError.notFound('File');
      s.library.resetMatch(req.params.id);
      s.matchWorker.kick();
      return s.library.fileDto(req.params.id);
    });

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
      async (req): Promise<ReleaseCandidateDto[]> => {
        const parts = [`release:(${luceneEscape(req.query.q)})`];
        if (req.query.artist) parts.push(`artist:(${luceneEscape(req.query.artist)})`);
        const refs = await s.mb.searchReleases(parts.join(' AND '), 25);
        return refs.map((r) => ({
          mbid: r.id,
          title: r.title,
          artistCredit: r.credit?.text ?? '',
          date: r.date,
          country: r.country,
          trackCount: r.trackCount,
          primaryType: r.releaseGroup?.primaryType ?? null,
          status: r.status,
        }));
      },
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
      async (req) => {
        const files = s.library.releaseFileRows(req.params.id);
        if (!files.length) throw ApiError.notFound('Album');
        const release = await s.mb.getRelease(req.body.releaseMbid);
        if (!release?.tracks.length) throw ApiError.badRequest('Release not found on MusicBrainz');
        const inputs = files.map((f) => ({ key: f.id, path: f.path, tags: (f.tags_json ? JSON.parse(f.tags_json) : {}) as FileTags }));
        const results = s.matcher.assignToRelease(inputs, release);
        let firstTrackId: number | null = null;
        for (const input of inputs) {
          const r = results.get(input.key);
          if (!r?.candidates[0]) continue;
          s.library.applyMatch(input.key, 'manual', r.candidates[0].score, r.candidates[0], r.candidates);
          firstTrackId ??= s.library.getFile(input.key)?.track_id ?? null;
        }
        s.library.cleanupOrphans();
        await s.covers.forget(req.params.id);
        const albumId = firstTrackId ? s.library.getTracks([firstTrackId], view(req))[0]?.album?.id : undefined;
        const detail = albumId ? s.library.getAlbum(albumId, view(req)) : null;
        if (!detail) throw ApiError.notFound('Album');
        return detail;
      },
    );
  });
}
