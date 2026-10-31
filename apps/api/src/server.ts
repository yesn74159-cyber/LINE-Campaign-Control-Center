import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { createSessionToken, DUMMY_PASSWORD_HASH, verifyPassword } from './auth.js';
import { createDatabase } from './db.js';
import { createPostgresRepository, createMemoryRepository, type Repository } from './repository.js';
import { assertControlReason, assertEmail, assertFlexJson, assertOaMetadata, assertPassword, assertScheduledAt, assertSchedulerStatus, assertTimeZone, can } from './validation.js';
import type { AdminUser } from './types.js';
import { registerTenantAdminRoutes } from './tenantAdmin.js';
import { registerOaConnectRoutes } from './lineOaConnect.js';
import { CampaignMockStore } from './campaignMock.js';
import { registerCampaignMockRoutes } from './campaignRoutes.js';
import { createLineLoginConfig, registerLineLoginRoutes } from './lineLogin.js';
import { PostgresLineLoginStore } from './lineLoginPostgresStore.js';
import { registerReferralRoutes } from './referralRoutes.js';
import { registerLineWebhookRoutes } from './lineWebhook.js';
import { runWorkerOnce } from './worker.js';
import { MockLineMessagingAdapter } from './lineAdapter.js';
import { ACCOUNT_TOKEN_PATTERN } from './accountTokens.js';
import { registerBaselineSecurity, createFixedWindowLimiter } from './security.js';
import { readDeliveryHealth } from './opsHealth.js';

type RequestWithUser = FastifyRequest & { user?: AdminUser; raw: FastifyRequest['raw'] & { rawBody?: string } };

function defaultRepository() {
  const persistence = process.env.PERSISTENCE || 'postgres';
  if (persistence === 'memory') return { repository: createMemoryRepository(), database: null };
  const database = createDatabase();
  if (!database.pool) throw new Error('PERSISTENCE=postgres requires DATABASE_URL');
  return { repository: createPostgresRepository(database.pool), database };
}

function sessionCookieOptions() { return { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 8 * 60 * 60 }; }
function csrfCookieOptions() { return { httpOnly: false, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 8 * 60 * 60 }; }

export function buildApp(injectedRepository?: Repository) {
  const selected = injectedRepository ? { repository: injectedRepository, database: null } : defaultRepository();
  const repo = selected.repository;
  const app = Fastify({ logger: false, bodyLimit: 100 * 1024, trustProxy: process.env.TRUST_PROXY === 'true' });
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || process.env.PUBLIC_APP_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
  app.register(cors, { origin: allowedOrigins, credentials: true });
  app.register(cookie);
  registerBaselineSecurity(app, allowedOrigins);
  const loginLimiter = createFixedWindowLimiter(10, 15 * 60 * 1000);
  const loginIpLimiter = createFixedWindowLimiter(50, 15 * 60 * 1000);
  const accountSetupLimiter = createFixedWindowLimiter(10, 15 * 60 * 1000);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as RequestWithUser).raw.rawBody = String(body);
    try { done(null, JSON.parse(String(body))); } catch { done(new Error('invalid JSON body')); }
  });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies?.ccc_session;
    if (!token) return reply.code(401).send({ error: 'authentication required' });
    const user = await repo.getSessionUser(token);
    if (!user) return reply.code(401).send({ error: 'session expired or revoked' });
    (request as RequestWithUser).user = user;
  };
  const requireCsrf = (request: FastifyRequest, reply: FastifyReply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const cookies = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies || {};
    const header = request.headers['x-csrf-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!cookies.ccc_csrf || !token || cookies.ccc_csrf !== token) return reply.code(403).send({ error: 'CSRF token required' });
  };
  const authorize = (action: 'read' | 'write' | 'approve' | 'manage_oa' | 'manage_users') => async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await authenticate(request, reply);
    if (result) return result;
    const user = (request as RequestWithUser).user!;
    if (!can(user.role, action)) return reply.code(403).send({ error: 'insufficient role for this action' });
    return requireCsrf(request, reply);
  };

  if (repo.kind === 'memory') {
    const mockStore = new CampaignMockStore({
      id: 'memory-admin',
      workspaceId: 'memory-workspace',
      email: process.env.MEMORY_ADMIN_EMAIL || 'admin@memory.local',
      displayName: 'Memory Admin',
      role: 'owner'
    });
    registerCampaignMockRoutes(app, mockStore, authenticate, requireCsrf, workspaceId => repo.listOas(workspaceId));
    app.get('/api/audit', { preHandler: authorize('read') }, async () => ({ events: [...(await repo.listAudit('memory-workspace')), ...mockStore.listAudit()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) }));
    registerLineLoginRoutes(app, mockStore, createLineLoginConfig());
  } else {
    const pool = selected.database?.pool;
    if (!pool) throw new Error('PostgreSQL persistence is required for LINE Login routes');
    registerTenantAdminRoutes(app, pool, authenticate, requireCsrf);
    registerOaConnectRoutes(app, pool, authenticate, requireCsrf);
    registerReferralRoutes(app, pool, authenticate, requireCsrf);
    registerLineLoginRoutes(app, new PostgresLineLoginStore(pool), createLineLoginConfig());
  }
  app.get('/health', async () => ({ ok: true, mode: process.env.APP_MODE || 'DRY_RUN', persistence: repo.kind }));
  const opsPool = selected.database?.pool;
  if (repo.kind === 'postgres' && opsPool) {
    app.get('/api/ops/delivery-health', { preHandler: authorize('read') }, async (request) => readDeliveryHealth(opsPool, { workspaceId: (request as RequestWithUser).user!.workspaceId }));
  }
  app.post<{ Body: { email: string; password: string } }>('/api/auth/login', { schema: { body: { type: 'object', required: ['email', 'password'], additionalProperties: false, properties: { email: { type: 'string', minLength: 3, maxLength: 320 }, password: { type: 'string', minLength: 12, maxLength: 200 } } } } }, async (request, reply) => {
    try { const email = assertEmail(request.body.email); const password = assertPassword(request.body.password); const attemptKey = `${request.ip}:${email}`; if (!loginIpLimiter.take(request.ip) || !loginLimiter.take(attemptKey)) return reply.code(429).send({ error: 'too many login attempts; try again later' }); const user = await repo.getUserByEmail(email); const passwordMatches = await verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH); if (!user || !passwordMatches) return reply.code(401).send({ error: 'invalid credentials' }); loginLimiter.reset(attemptKey); const session = await repo.createSession(user.id); reply.setCookie('ccc_session', session.token, sessionCookieOptions()); reply.setCookie('ccc_csrf', createSessionToken(), csrfCookieOptions()); return { user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role }, expiresAt: session.expiresAt.toISOString() }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid login request' }); }
  });
  app.post('/api/auth/logout', { preHandler: async (request, reply) => { const result = await authenticate(request, reply); if (result) return result; return requireCsrf(request, reply); } }, async (request, reply) => { const token = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies?.ccc_session; if (token) await repo.revokeSession(token); reply.clearCookie('ccc_session', { path: '/' }); reply.clearCookie('ccc_csrf', { path: '/' }); return { ok: true }; });
  app.get('/api/auth/me', { preHandler: authenticate }, async (request) => ({ user: (request as RequestWithUser).user }));

  app.post<{ Body: { token: string; password: string } }>('/api/account/setup', { schema: { body: { type: 'object', required: ['token', 'password'], additionalProperties: false, properties: { token: { type: 'string', minLength: 43, maxLength: 43 }, password: { type: 'string', minLength: 12, maxLength: 200 } } } } }, async (request, reply) => {
    if (!accountSetupLimiter.take(request.ip)) return reply.code(429).send({ error: 'too many account setup attempts; try again later' });
    if (!ACCOUNT_TOKEN_PATTERN.test(request.body.token)) return reply.code(400).send({ error: 'account link is invalid or expired' });
    try {
      const user = await repo.consumeAccountToken(request.body.token, assertPassword(request.body.password));
      reply.clearCookie('ccc_session', { path: '/' });
      reply.clearCookie('ccc_csrf', { path: '/' });
      return { user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'account link is invalid or expired' });
    }
  });

  app.get('/api/dashboard', { preHandler: authorize('read') }, async (request) => ({ ...(await repo.dashboard((request as RequestWithUser).user!.workspaceId)), persistence: repo.kind, generatedAt: new Date().toISOString() }));
  app.get('/api/campaigns', { preHandler: authorize('read') }, async (request) => ({ campaigns: await repo.listCampaigns((request as RequestWithUser).user!.workspaceId) }));
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/revisions', { preHandler: authorize('read'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+$' } } } } }, async (request) => ({ revisions: await repo.listRevisions(request.params.id, (request as RequestWithUser).user!.workspaceId) }));
  app.post<{ Params: { id: string }; Body: { flexJson: Record<string, unknown> } }>('/api/campaigns/:id/revisions', { preHandler: authorize('write'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+$' } } }, body: { type: 'object', required: ['flexJson'], additionalProperties: false, properties: { flexJson: { type: 'object' } } } } }, async (request, reply) => { try { const revision = await repo.createRevision(request.params.id, assertFlexJson(request.body.flexJson), (request as RequestWithUser).user!.email, (request as RequestWithUser).user!.workspaceId); return reply.code(201).send(revision); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid revision' }); } });
  app.get('/api/oas', { preHandler: authorize('read') }, async (request) => ({ oas: await repo.listOas((request as RequestWithUser).user!.workspaceId) }));
  app.post<{ Body: { providerId: string; basicId: string; displayName: string } }>('/api/oas', { preHandler: authorize('manage_oa'), schema: { body: { type: 'object', required: ['providerId', 'basicId', 'displayName'], additionalProperties: false, properties: { providerId: { type: 'string', minLength: 2, maxLength: 120 }, basicId: { type: 'string', minLength: 2, maxLength: 120 }, displayName: { type: 'string', minLength: 2, maxLength: 160 } } } } }, async (request, reply) => { try { const oa = await repo.createOa({ workspaceId: (request as RequestWithUser).user!.workspaceId, providerId: assertOaMetadata(request.body.providerId, 'providerId'), basicId: assertOaMetadata(request.body.basicId, 'basicId'), displayName: assertOaMetadata(request.body.displayName, 'displayName'), actor: (request as RequestWithUser).user!.email }); return reply.code(201).send(oa); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid OA metadata' }); } });
  app.post<{ Params: { id: string } }>('/api/oas/:id/validate', { preHandler: authorize('manage_oa'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } } } }, async (request, reply) => { try { return await repo.validateOa(request.params.id, (request as RequestWithUser).user!.workspaceId, (request as RequestWithUser).user!.email); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'OA validation failed' }); } });
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/oas/:id/enabled', { preHandler: authorize('manage_oa'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } }, body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } } }, async (request, reply) => { try { return await repo.setOaEnabled(request.params.id, (request as RequestWithUser).user!.workspaceId, request.body.enabled, (request as RequestWithUser).user!.email); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'OA enabled state failed' }); } });
  app.post<{ Params: { id: string }; Body: { enabled: boolean; reason: string } }>('/api/oas/:id/kill-switch', { preHandler: authorize('manage_oa'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } }, body: { type: 'object', required: ['enabled', 'reason'], additionalProperties: false, properties: { enabled: { type: 'boolean' }, reason: { type: 'string', minLength: 3, maxLength: 240 } } } } }, async (request, reply) => { try { return await repo.setOaKillSwitch(request.params.id, (request as RequestWithUser).user!.workspaceId, request.body.enabled, assertControlReason(request.body.reason), (request as RequestWithUser).user!.email); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'OA kill switch failed' }); } });
  app.get<{ Params: { id: string }; Querystring: { oaId?: string } }>('/api/campaigns/:id/readiness', { preHandler: authorize('read'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 80 } } }, querystring: { type: 'object', additionalProperties: false, properties: { oaId: { type: 'string', maxLength: 100 } } } } }, async (request, reply) => { try { return await repo.getCampaignReadiness(request.params.id, (request as RequestWithUser).user!.workspaceId, request.query.oaId); } catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : 'campaign readiness not found' }); } });
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/validate', { preHandler: authorize('write'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 80 } } } } }, async (request, reply) => { try { return await repo.validateCampaign(request.params.id, (request as RequestWithUser).user!.workspaceId, (request as RequestWithUser).user!.email); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'campaign validation failed' }); } });
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/approve', { preHandler: authorize('approve'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 80 } } } } }, async (request, reply) => { try { return await repo.approveCampaign(request.params.id, (request as RequestWithUser).user!.workspaceId, (request as RequestWithUser).user!.email); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'campaign approval failed' }); } });
  app.post<{ Params: { id: string }; Body: { enabled: boolean; reason: string } }>('/api/campaigns/:id/kill-switch', { preHandler: authorize('manage_oa'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 80 } } }, body: { type: 'object', required: ['enabled', 'reason'], additionalProperties: false, properties: { enabled: { type: 'boolean' }, reason: { type: 'string', minLength: 3, maxLength: 240 } } } } }, async (request, reply) => { try { return await repo.setCampaignKillSwitch(request.params.id, (request as RequestWithUser).user!.workspaceId, request.body.enabled, assertControlReason(request.body.reason), (request as RequestWithUser).user!.email); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'campaign kill switch failed' }); } });
  app.post<{ Body: { enabled: boolean; reason: string } }>('/api/workspace/kill-switch', { preHandler: authorize('manage_oa'), schema: { body: { type: 'object', required: ['enabled', 'reason'], additionalProperties: false, properties: { enabled: { type: 'boolean' }, reason: { type: 'string', minLength: 3, maxLength: 240 } } } } }, async (request, reply) => { try { return await repo.setSystemKillSwitch((request as RequestWithUser).user!.workspaceId, request.body.enabled, assertControlReason(request.body.reason), (request as RequestWithUser).user!.email); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'system kill switch failed' }); } });
  app.get('/api/customers', { preHandler: authorize('read') }, async (request) => ({ customers: await repo.listCustomers((request as RequestWithUser).user!.workspaceId) }));
  app.get('/api/scheduler/jobs', { preHandler: authorize('read') }, async (request) => ({ jobs: await repo.listJobs((request as RequestWithUser).user!.workspaceId) }));
  app.get<{ Params: { id: string } }>('/api/scheduler/jobs/:id/outbox', { preHandler: authorize('read'), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } } } }, async (request) => ({ deliveries: await repo.listOutbox((request as RequestWithUser).user!.workspaceId, request.params.id) }));
  app.get('/api/automation', { preHandler: authorize('read') }, async (request) => { const jobs = await repo.listJobs((request as RequestWithUser).user!.workspaceId); const summary: Record<string, number> = {}; for (const job of jobs) summary[job.status] = (summary[job.status] || 0) + 1; return { jobs, summary }; });
  if (repo.kind !== 'memory') app.get('/api/audit', { preHandler: authorize('read') }, async (request) => ({ events: await repo.listAudit((request as RequestWithUser).user!.workspaceId) }));
  app.post<{ Body: { campaignId: string; oaId: string; scheduledAt: string; timeZone?: string; status?: 'DRAFT' | 'SCHEDULED' } }>('/api/scheduler/jobs', { preHandler: authorize('write'), schema: { body: { type: 'object', required: ['campaignId', 'oaId', 'scheduledAt'], additionalProperties: false, properties: { campaignId: { type: 'string', minLength: 1, maxLength: 80 }, oaId: { type: 'string', minLength: 1, maxLength: 100 }, scheduledAt: { type: 'string', format: 'date-time' }, timeZone: { type: 'string', maxLength: 64 }, status: { type: 'string', enum: ['DRAFT', 'SCHEDULED'] } } } } }, async (request, reply) => { try { const status = assertSchedulerStatus(request.body.status); const idempotencyHeader = request.headers['idempotency-key']; const rawKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader; const clientRequestKey = rawKey === undefined ? undefined : String(rawKey); if (clientRequestKey !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(clientRequestKey)) return reply.code(400).send({ error: 'idempotency key must be 8-100 URL-safe characters' }); return reply.code(201).send(await repo.addJob({ campaignId: request.body.campaignId, oaId: request.body.oaId, scheduledAt: assertScheduledAt(request.body.scheduledAt, status), timeZone: assertTimeZone(request.body.timeZone || 'Asia/Bangkok'), status, workspaceId: (request as RequestWithUser).user!.workspaceId, actor: (request as RequestWithUser).user!.email, clientRequestKey })); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid scheduler request' }); } });
  const jobParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' } } };
  app.post<{ Params: { id: string } }>('/api/scheduler/jobs/:id/pause', { preHandler: authorize('write'), schema: { params: jobParams } }, async (request, reply) => { try { return await repo.pauseJob(request.params.id, (request as RequestWithUser).user!.email, (request as RequestWithUser).user!.workspaceId); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid scheduler request' }); } });
  app.post<{ Params: { id: string } }>('/api/scheduler/jobs/:id/schedule', { preHandler: authorize('write'), schema: { params: jobParams } }, async (request, reply) => { try { return await repo.scheduleJob(request.params.id, (request as RequestWithUser).user!.email, (request as RequestWithUser).user!.workspaceId); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid scheduler request' }); } });
  app.post<{ Params: { id: string } }>('/api/scheduler/jobs/:id/resume', { preHandler: authorize('write'), schema: { params: jobParams } }, async (request, reply) => { try { return await repo.resumeJob(request.params.id, (request as RequestWithUser).user!.email, (request as RequestWithUser).user!.workspaceId); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid scheduler request' }); } });
  app.post<{ Params: { id: string } }>('/api/scheduler/jobs/:id/cancel', { preHandler: authorize('write'), schema: { params: jobParams } }, async (request, reply) => { try { return await repo.cancelJob(request.params.id, (request as RequestWithUser).user!.email, (request as RequestWithUser).user!.workspaceId); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid scheduler request' }); } });
  app.post<{ Params: { id: string } }>('/api/scheduler/jobs/:id/retry', { preHandler: authorize('write'), schema: { params: jobParams } }, async (request, reply) => { try { return await repo.retryJob(request.params.id, (request as RequestWithUser).user!.email, (request as RequestWithUser).user!.workspaceId); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid scheduler request' }); } });
  app.post<{ Params: { id: string } }>('/api/scheduler/jobs/:id/dry-run', { preHandler: authorize('write'), schema: { params: jobParams } }, async (request, reply) => { try { const queued = await repo.runDryRun(request.params.id, (request as RequestWithUser).user!.email, (request as RequestWithUser).user!.workspaceId); const outcome = await runWorkerOnce(repo, new MockLineMessagingAdapter(), { jobId: queued.id, workerId: `api-dry-run-${randomUUID()}`, maxAttempts: 1 }); if (outcome.status !== 'completed') return reply.code(409).send({ error: `dry-run pipeline ${outcome.status}` }); return outcome.job; } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid scheduler request' }); } });
  app.post<{ Params: { id: string; deliveryId: string }; Body: { status: 'SENT' | 'FAILED' } }>('/api/scheduler/jobs/:id/outbox/:deliveryId/reconcile', { preHandler: authorize('write'), schema: { params: { type: 'object', required: ['id', 'deliveryId'], properties: { id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' }, deliveryId: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' } } }, body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['SENT', 'FAILED'] } } } } }, async (request, reply) => { try { return await repo.reconcileOutboxDelivery({ jobId: request.params.id, deliveryId: request.params.deliveryId, workspaceId: (request as RequestWithUser).user!.workspaceId, status: request.body.status, actor: (request as RequestWithUser).user!.email }); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'could not reconcile delivery' }); } });

  if (repo.kind === 'postgres' && !selected.database?.pool) throw new Error('PostgreSQL LINE webhook requires a database pool');
  registerLineWebhookRoutes(app, {
    repo,
    pool: selected.database?.pool ?? null,
    enabled: process.env.LINE_WEBHOOK_ENABLED === 'true',
    fallbackChannelSecret: selected.database?.pool ? undefined : process.env.LINE_CHANNEL_SECRET,
    identityHashKey: process.env.LINE_IDENTITY_HASH_KEY || ''
  });

  app.addHook('onReady', async () => {
    if (!selected.database) return;
    const status = await selected.database.status();
    if (!status.connected) throw new Error(status.message);
  });
  app.addHook('onClose', async () => { await selected.database?.close(); });
  return app;
}

async function start() { const app = buildApp(); const port = Number(process.env.PORT || 8787); const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'); await app.listen({ port, host }); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start().catch((error) => { console.error(error); process.exit(1); });
