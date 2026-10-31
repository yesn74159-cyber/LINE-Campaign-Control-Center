import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminRole, AdminUser, OaIntegration } from './types.js';
import { CampaignMockStore, isValidMockWebhookSignature } from './campaignMock.js';

type RequestWithUser = FastifyRequest & { user?: AdminUser; raw: FastifyRequest['raw'] & { rawBody?: string } };
type OaLike = Pick<OaIntegration, 'id' | 'displayName' | 'providerId' | 'basicId' | 'enabled'>;

export function registerCampaignMockRoutes(
  app: FastifyInstance,
  store: CampaignMockStore,
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => unknown,
  listOas: (workspaceId: string) => Promise<OaLike[]>,
) {
  const user = (request: FastifyRequest) => (request as RequestWithUser).user!;
  const manager = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticate(request, reply);
    if (auth) return auth;
    if (!['owner', 'admin'].includes(user(request).role)) return reply.code(403).send({ error: 'owner or admin role required' });
    return requireCsrf(request, reply);
  };
  const reader = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticate(request, reply);
    if (auth) return auth;
    return requireCsrf(request, reply);
  };
  const safeOas = async () => listOas(store.workspaceId);
  const validOaIds = async () => new Set((await safeOas()).map(item => item.id));
  const origin = () => process.env.PUBLIC_APP_ORIGIN || 'http://127.0.0.1:5173';
  const fail = (reply: FastifyReply, error: unknown) => reply.code(400).send({ error: error instanceof Error ? error.message : 'local mock request failed' });

  app.get('/api/workspace/settings', { preHandler: reader }, async () => ({ workspace: store.workspace() }));
  app.patch<{ Body: { name: string } }>('/api/workspace/settings', { preHandler: manager }, async (request, reply) => {
    if (user(request).role !== 'owner') return reply.code(403).send({ error: 'only owner may rename workspace' });
    try { return { workspace: store.renameWorkspace(request.body.name, user(request).email) }; } catch (error) { return fail(reply, error); }
  });
  app.get('/api/workspace/members', { preHandler: manager }, async () => ({ members: store.listMembers() }));
  app.post<{ Body: { email: string; displayName: string; role: AdminRole } }>('/api/workspace/members', { preHandler: manager }, async (request, reply) => {
    try { return reply.code(201).send(store.inviteMember({ ...request.body, actorId: user(request).id, actorRole: user(request).role, actorEmail: user(request).email })); } catch (error) { return fail(reply, error); }
  });
  app.patch<{ Params: { id: string }; Body: { role?: AdminRole; status?: 'INVITED' | 'ACTIVE' | 'SUSPENDED' } }>('/api/workspace/members/:id', { preHandler: manager }, async (request, reply) => {
    try { return store.updateMember(request.params.id, { ...request.body, actorId: user(request).id, actorRole: user(request).role, actorEmail: user(request).email }); } catch (error) { return fail(reply, error); }
  });
  app.get('/api/workspace/oa-channels', { preHandler: manager }, async () => ({ channels: (await safeOas()).map(oa => ({ oaId: oa.id, displayName: oa.displayName, messagingChannelId: null, loginChannelId: null, lineProviderId: oa.providerId, enabled: oa.enabled, status: 'DRY_RUN_READY' })) }));
  app.get('/api/workspace/oa-connect/status', { preHandler: manager }, async () => ({ connections: (await safeOas()).map(oa => ({ oaId: oa.id, displayName: oa.displayName, basicId: oa.basicId, accessTokenCheckedAt: null, storedEncrypted: false, channelStatus: 'DRY_RUN_READY' })) }));

  app.get('/api/referrals/staff', { preHandler: reader }, async () => ({ staff: store.listMembers().map(item => ({ id: item.id, displayName: item.displayName, email: item.email, active: item.status === 'ACTIVE' })) }));
  app.get<{ Querystring: { staffId?: string; oaId?: string } }>('/api/referrals', { preHandler: reader }, async request => ({ referrals: store.listReferrals(origin(), request.query) }));
  app.post<{ Body: { staffId: string; oaId: string; expiresAt?: string } }>('/api/referrals', { preHandler: manager }, async (request, reply) => {
    try { return reply.code(201).send(store.createReferral({ ...request.body, actorEmail: user(request).email }, origin(), await validOaIds())); } catch (error) { return fail(reply, error); }
  });
  app.post<{ Params: { id: string }; Body: { status: 'ACTIVE' | 'PAUSED' | 'REVOKED' } }>('/api/referrals/:id/status', { preHandler: manager }, async (request, reply) => {
    try { return store.updateReferral(request.params.id, request.body.status, user(request).email); } catch (error) { return fail(reply, error); }
  });
  app.get<{ Querystring: { staffId?: string; oaId?: string; from?: string; to?: string } }>('/api/referral-dashboard', { preHandler: reader }, async request => ({ mode: 'DRY_RUN', rows: store.dashboard(request.query) }));
  app.get('/api/referral-events', { preHandler: reader }, async () => ({ events: store.listEvents() }));

  app.post<{ Params: { token: string } }>('/api/referrals/:token/click', async (request, reply) => {
    try { return store.recordClick(request.params.token); } catch (error) { return fail(reply, error); }
  });
  app.post<{ Body: { referralToken: string } }>('/api/line-login/mock/start', async (request, reply) => {
    try { return store.startLogin(request.body.referralToken); } catch (error) { return fail(reply, error); }
  });
  app.post<{ Body: { state: string; nonce: string; idToken: { iss: string; aud: string; exp: number; nonce: string; sub: string; signature?: string } } }>('/api/line-login/mock/callback', async (request, reply) => {
    try { return store.completeLogin(request.body); } catch (error) { return fail(reply, error); }
  });
  app.post('/api/mock/webhook/follow', async (request, reply) => {
    if (process.env.APP_MODE !== 'DRY_RUN') return reply.code(503).send({ error: 'mock webhook is only available in DRY_RUN' });
    const rawBody = (request as RequestWithUser).raw.rawBody || JSON.stringify(request.body || {});
    const signature = request.headers['x-mock-signature'];
    const value = Array.isArray(signature) ? signature[0] : signature;
    if (!isValidMockWebhookSignature(rawBody, value)) return reply.code(401).send({ error: 'invalid mock webhook signature' });
    try { return store.verifyFollow(request.body as { referralId: string; eventId: string; followerSubject: string; evidenceRef: string; eventType: string; occurredAt?: string }); } catch (error) { return fail(reply, error); }
  });
}
