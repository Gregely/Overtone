import type { FastifyInstance } from 'fastify';
import type { AuthStatusDto, LoginRequestDto } from '@overtone/shared';
import { requireAdmin, userOf } from '../http/auth-hooks.js';
import { ApiError } from '../http/errors.js';
import type { Services } from '../services.js';

const credentials = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 64 },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
    deviceName: { type: 'string', maxLength: 100 },
  },
} as const;

const refreshBody = {
  type: 'object',
  required: ['refreshToken'],
  additionalProperties: false,
  properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** Public auth endpoints (no access token required). */
export async function publicAuthRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.get('/api/auth/status', async (): Promise<AuthStatusDto> => ({
    setupRequired: s.auth.userCount() === 0,
    multiUser: s.config.multiUser,
    version: s.config.version,
  }));

  app.post<{ Body: LoginRequestDto }>('/api/auth/setup', { schema: { body: credentials }, config: authRateLimit }, async (req) =>
    s.auth.setup(req.body.username, req.body.password, req.body.deviceName),
  );

  app.post<{ Body: LoginRequestDto }>('/api/auth/login', { schema: { body: credentials }, config: authRateLimit }, async (req) =>
    s.auth.login(req.body.username, req.body.password, req.body.deviceName),
  );

  app.post<{ Body: { refreshToken: string } }>(
    '/api/auth/refresh',
    { schema: { body: refreshBody }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => s.auth.refresh(req.body.refreshToken),
  );

  app.post<{ Body: { refreshToken: string } }>('/api/auth/logout', { schema: { body: refreshBody } }, async (req, reply) => {
    s.auth.logout(req.body.refreshToken);
    return reply.code(204).send();
  });
}

/** Authenticated account + user management. */
export async function accountRoutes(app: FastifyInstance, s: Services): Promise<void> {
  app.get('/api/me', async (req) => {
    const user = s.auth.getUser(userOf(req).id);
    if (!user) throw ApiError.unauthorized();
    return user;
  });

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/me/password',
    {
      config: authRateLimit,
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: { currentPassword: { type: 'string', maxLength: 1024 }, newPassword: { type: 'string', maxLength: 1024 } },
        },
      },
    },
    async (req, reply) => {
      await s.auth.changePassword(userOf(req).id, req.body.currentPassword, req.body.newPassword);
      return reply.code(204).send();
    },
  );

  app.get('/api/users', { preHandler: requireAdmin }, async () => s.auth.listUsers());

  app.post<{ Body: { username: string; password: string; isAdmin?: boolean } }>(
    '/api/users',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: { username: { type: 'string' }, password: { type: 'string' }, isAdmin: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => reply.code(201).send(await s.auth.createUser(req.body.username, req.body.password, Boolean(req.body.isAdmin))),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/users/:id',
    { preHandler: requireAdmin, schema: { params: idParam } },
    async (req, reply) => {
      s.auth.deleteUser(req.params.id, userOf(req).id);
      return reply.code(204).send();
    },
  );
}

export const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;
