import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { ApiError } from './errors.js';

export interface RequestUser {
  id: number;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: RequestUser | null;
  }
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

export function requireAuth(auth: AuthService) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = bearerToken(req);
    const claims = token ? auth.verifyAccessToken(token) : null;
    if (!claims) throw ApiError.unauthorized(token ? 'invalid_access_token' : 'unauthorized');
    req.user = { id: claims.sub, isAdmin: claims.adm };
  };
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (!req.user?.isAdmin) throw ApiError.forbidden('Admin only');
}

export function userOf(req: FastifyRequest): RequestUser {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}
