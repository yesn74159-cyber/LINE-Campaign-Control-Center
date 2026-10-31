import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AdminUser } from './types.js';
import { createFixedWindowLimiter } from './security.js';
import {
  ReferralError,
  createReferral,
  getReferralStaff,
  listReferralEvents,
  listReferrals,
  recordClick,
  referralDashboard,
  setReferralStatus,
  type ReferralStatus
} from './referralStore.js';

type AdminRequest = FastifyRequest & { user?: AdminUser };

export function registerReferralRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => unknown
) {
  const clickLimiter = createFixedWindowLimiter(120, 60 * 1000);
  const createLimiter = createFixedWindowLimiter(60, 60 * 60 * 1000);

  async function allowed(request: FastifyRequest, reply: FastifyReply, manage = false) {
    const auth = await requireUser(request, reply);
    if (auth) return auth;
    const user = (request as AdminRequest).user;
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (manage && !['owner', 'admin'].includes(user.role)) {
      return reply.code(403).send({ error: 'referral link management requires owner or admin' });
    }
    const member = await pool.query(
      "select 1 from workspace_memberships where workspace_id=$1 and admin_user_id=$2 and status='ACTIVE'",
      [user.workspaceId, user.id]
    );
    if (!member.rowCount) return reply.code(403).send({ error: 'workspace membership is not active' });
    if (request.method !== 'GET') return requireCsrf(request, reply);
    return undefined;
  }

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ReferralError) return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  };

  app.get('/api/referrals/staff', { preHandler: (request, reply) => allowed(request, reply) }, async (request) => {
    const user = (request as AdminRequest).user!;
    return { staff: await getReferralStaff(pool, user.workspaceId) };
  });

  app.get<{ Querystring: { staffId?: string; oaId?: string } }>(
    '/api/referrals',
    { preHandler: (request, reply) => allowed(request, reply), schema: { querystring: { type: 'object', additionalProperties: false, properties: { staffId: { type: 'string', maxLength: 64 }, oaId: { type: 'string', maxLength: 64 } } } } },
    async (request, reply) => {
      const user = (request as AdminRequest).user!;
      try {
        return { referrals: await listReferrals(pool, user.workspaceId, request.query) };
      } catch (error) { return fail(reply, error); }
    }
  );

  app.post<{ Body: { staffId: string; oaId: string; expiresAt?: string } }>(
    '/api/referrals',
    {
      preHandler: (request, reply) => allowed(request, reply, true),
      schema: {
        body: {
          type: 'object',
          required: ['staffId', 'oaId'],
          additionalProperties: false,
          properties: {
            staffId: { type: 'string', format: 'uuid' },
            oaId: { type: 'string', format: 'uuid' },
            expiresAt: { type: 'string', format: 'date-time' }
          }
        }
      }
    },
    async (request, reply) => {
      const user = (request as AdminRequest).user!;
      if (!createLimiter.take(`${user.workspaceId}:${user.id}`)) {
        return reply.code(429).send({ error: 'too many referral links created; try again later' });
      }
      try {
        return reply.code(201).send(await createReferral(pool, { ...request.body, workspaceId: user.workspaceId, actor: user.email }));
      } catch (error) { return fail(reply, error); }
    }
  );

  app.post<{ Params: { id: string }; Body: { status: ReferralStatus } }>(
    '/api/referrals/:id/status',
    {
      preHandler: (request, reply) => allowed(request, reply, true),
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'REVOKED'] } } }
      }
    },
    async (request, reply) => {
      const user = (request as AdminRequest).user!;
      try {
        return await setReferralStatus(pool, user.workspaceId, request.params.id, request.body.status, user.email);
      } catch (error) { return fail(reply, error); }
    }
  );

  app.get<{ Querystring: { staffId?: string; oaId?: string; from?: string; to?: string } }>(
    '/api/referral-dashboard',
    {
      preHandler: (request, reply) => allowed(request, reply),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            staffId: { type: 'string', maxLength: 64 },
            oaId: { type: 'string', maxLength: 64 },
            from: { type: 'string', maxLength: 64 },
            to: { type: 'string', maxLength: 64 }
          }
        }
      }
    },
    async (request, reply) => {
      const user = (request as AdminRequest).user!;
      try {
        return { mode: 'DRY_RUN' as const, rows: await referralDashboard(pool, user.workspaceId, request.query) };
      } catch (error) { return fail(reply, error); }
    }
  );

  app.get('/api/referral-events', { preHandler: (request, reply) => allowed(request, reply) }, async (request, reply) => {
    const user = (request as AdminRequest).user!;
    try {
      return { events: await listReferralEvents(pool, user.workspaceId) };
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: { token: string } }>(
    '/api/referrals/:token/click',
    { schema: { params: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 20, maxLength: 200 } } } } },
    async (request, reply) => {
      if (!clickLimiter.take(request.ip)) return reply.code(429).send({ error: 'too many referral clicks; try again later' });
      try {
        return await recordClick(pool, request.params.token);
      } catch (error) { return fail(reply, error); }
    }
  );
}
