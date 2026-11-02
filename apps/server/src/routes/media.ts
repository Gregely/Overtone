import type { FastifyInstance } from 'fastify';
import { bearerToken } from '../http/auth-hooks.js';
import { ApiError } from '../http/errors.js';
import { COVER_SIZES, type CoverSize } from '@overtone/core';
import type { Services } from '../services.js';
import { idParam } from './auth.js';

/**
 * Media endpoints authenticate with URL tokens because <audio>, <img> and the
 * Android native player can't attach Authorization headers. A Bearer token is
 * accepted too, for clients that can.
 */
export async function mediaRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.get<{ Params: { id: number }; Querystring: { st?: string } }>(
    '/api/stream/:id',
    {
      schema: { params: idParam, querystring: { type: 'object', properties: { st: { type: 'string', maxLength: 200 } } } },
      // Seeking fires many range requests; keep the access log quiet.
      logLevel: 'warn',
    },
    async (req, reply) => {
      const id = req.params.id;
      const viaToken = req.query.st ? s.auth.verifyStreamToken(req.query.st, id) : null;
      const bearer = bearerToken(req);
      const viaBearer = !viaToken && bearer ? s.auth.verifyAccessToken(bearer) : null;
      if (!viaToken && !viaBearer) throw ApiError.unauthorized('invalid_stream_token', 'Stream link expired; request a new one');
      const target = await s.library.streamTarget(id);
      if (!target || !target.enabled) throw ApiError.notFound('Track file');
      return s.streams.serve(target.file, req, reply);
    },
  );

  app.get<{ Params: { id: number }; Querystring: { at?: string; size?: number } }>(
    '/api/artwork/release/:id',
    {
      schema: {
        params: idParam,
        querystring: {
          type: 'object',
          properties: { at: { type: 'string', maxLength: 200 }, size: { type: 'integer', enum: [...COVER_SIZES] } },
        },
      },
      logLevel: 'warn',
    },
    async (req, reply) => {
      const ok = (req.query.at && s.auth.verifyArtworkToken(req.query.at)) || (bearerToken(req) && s.auth.verifyAccessToken(bearerToken(req)!));
      if (!ok) throw ApiError.unauthorized('invalid_artwork_token');
      const img = await s.covers.get(req.params.id, (req.query.size ?? 500) as CoverSize);
      if (!img) throw ApiError.notFound('Artwork');
      return reply
        .header('cache-control', 'private, max-age=604800')
        .type(img.mimeType)
        .send(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
    },
  );
}
