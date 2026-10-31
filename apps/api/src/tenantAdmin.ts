import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { hashPasswordSync } from './auth.js';
import { accountSetupUrl, issueAccountToken } from './accountTokens.js';
import type { AdminUser } from './types.js';

type AdminRequest = FastifyRequest & { user?: AdminUser };
type WorkspaceView = { id: string; slug: string; name: string; mode: string };

export function registerTenantAdminRoutes(
  app: FastifyInstance,
  pool: Pool | null,
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => unknown
) {
  async function allowed(request: FastifyRequest, reply: FastifyReply, manage = false) {
    if (!pool) return reply.code(503).send({ error: 'Workspace management requires PostgreSQL' });
    const authResult = await requireUser(request, reply);
    if (authResult) return authResult;
    const user = (request as AdminRequest).user;
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (manage && user.role !== 'owner' && user.role !== 'admin') {
      return reply.code(403).send({ error: 'workspace management requires owner or admin' });
    }
    const member = await pool.query(
      "select 1 from workspace_memberships where workspace_id=$1 and admin_user_id=$2 and status='ACTIVE'",
      [user.workspaceId, user.id]
    );
    if (!member.rowCount) return reply.code(403).send({ error: 'workspace membership is not active' });
    if (request.method !== 'GET') return requireCsrf(request, reply);
    return undefined;
  }
  const respondError = (error: unknown, reply: FastifyReply) => {
    const code = (error as { code?: string } | null)?.code;
    if (code === '23505') return reply.code(409).send({ error: 'workspace or channel identifier already exists' });
    if (code === '23503') return reply.code(400).send({ error: 'selected OA is not in your workspace' });
    return reply.code(400).send({ error: 'workspace request could not be completed' });
  };

  app.get('/api/workspace/settings', { preHandler: (request, reply) => allowed(request, reply) }, async (request, reply) => {
    const user = (request as AdminRequest).user!;
    const result = await pool!.query(
      'select id, slug, name, mode from workspaces where id=$1',
      [user.workspaceId]
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'workspace not found' });
    return { workspace: result.rows[0] as WorkspaceView };
  });

  app.patch<{ Body: { name: string } }>(
    '/api/workspace/settings',
    { preHandler: (request, reply) => allowed(request, reply, true),
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 3, maxLength: 100 } } } } },
    async (request, reply) => {
      const user = (request as AdminRequest).user!;
      if (user.role !== 'owner') return reply.code(403).send({ error: 'only owner may rename workspace' });
      const name = request.body.name.trim();
      if (name.length < 3) return reply.code(400).send({ error: 'workspace name is too short' });
      try {
        const updated = await pool!.query(
          'update workspaces set name=$1 where id=$2 returning id,slug,name,mode',
          [name, user.workspaceId]
        );
        if (!updated.rows[0]) return reply.code(404).send({ error: 'workspace not found' });
        await pool!.query(
          "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,'WORKSPACE_RENAMED','workspace',$3,$4::jsonb)",
          [user.workspaceId, user.email, user.workspaceId, JSON.stringify({ detail: 'Workspace display name changed' })]
        );
        return { workspace: updated.rows[0] as WorkspaceView };
      } catch (error) { return respondError(error, reply); }
    }
  );

  app.get('/api/workspace/members', { preHandler: (request, reply) => allowed(request, reply, true) }, async (request) => {
    const user = (request as AdminRequest).user!;
    const result = await pool!.query(
      "select u.id,u.email,u.display_name as \"displayName\",u.role,m.status from workspace_memberships m join admin_users u on u.id=m.admin_user_id and u.workspace_id=m.workspace_id where m.workspace_id=$1 order by u.created_at",
      [user.workspaceId]
    );
    return { members: result.rows };
  });

  app.post<{ Body: { email: string; displayName: string; role: 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer' } }>(
    '/api/workspace/members',
    { preHandler: (request, reply) => allowed(request, reply, true), schema: { body: { type: 'object', required: ['email', 'displayName', 'role'], additionalProperties: false, properties: { email: { type: 'string', minLength: 3, maxLength: 320, format: 'email' }, displayName: { type: 'string', minLength: 1, maxLength: 120 }, role: { type: 'string', enum: ['owner', 'admin', 'editor', 'reviewer', 'viewer'] } } } } },
    async (request, reply) => {
      const user = (request as AdminRequest).user!;
      if (user.role === 'admin' && request.body.role === 'owner') return reply.code(403).send({ error: 'admin cannot grant owner role' });
      const email = request.body.email.trim().toLowerCase();
      const displayName = request.body.displayName.trim();
      if (!displayName) return reply.code(400).send({ error: 'display name is required' });
      const client = await pool!.connect();
      try {
        await client.query('begin');
        const inserted = await client.query(
          "insert into admin_users(workspace_id,email,display_name,role,password_hash,active) values ($1,$2,$3,$4,$5,true) returning id,email,display_name as \"displayName\",role",
          [user.workspaceId, email, displayName, request.body.role, hashPasswordSync(randomBytes(32).toString('base64url'))]
        );
        const member = inserted.rows[0];
        await client.query('insert into workspace_memberships(workspace_id,admin_user_id,status) values ($1,$2,\'INVITED\')', [user.workspaceId, member.id]);
        const issued = await issueAccountToken(client, { workspaceId: user.workspaceId, adminUserId: String(member.id), purpose: 'INVITE', createdBy: user.email });
        await client.query("insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,'MEMBER_INVITED','member',$3,$4::jsonb)", [user.workspaceId, user.email, member.id, JSON.stringify({ email, role: request.body.role })]);
        await client.query("insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,'ACCOUNT_INVITE_ISSUED','member',$3,$4::jsonb)", [user.workspaceId, user.email, member.id, JSON.stringify({ detail: `One-time invitation link issued; expires ${issued.expiresAt}` })]);
        await client.query('commit');
        return reply.code(201).send({ ...member, status: 'INVITED', setupUrl: accountSetupUrl(issued.token), expiresAt: issued.expiresAt });
      } catch (error) { await client.query('rollback').catch(() => undefined); return respondError(error, reply); }
      finally { client.release(); }
    }
  );

  app.post<{ Params: { id: string }; Body: { purpose: 'INVITE' | 'RESET' } }>(
    '/api/workspace/members/:id/account-link',
    {
      preHandler: (request, reply) => allowed(request, reply, true),
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', required: ['purpose'], additionalProperties: false, properties: { purpose: { type: 'string', enum: ['INVITE', 'RESET'] } } }
      }
    },
    async (request, reply) => {
      const actor = (request as AdminRequest).user!;
      const client = await pool!.connect();
      try {
        await client.query('begin');
        const selected = await client.query("select u.id,u.email,u.role,m.status from workspace_memberships m join admin_users u on u.id=m.admin_user_id and u.workspace_id=m.workspace_id where m.workspace_id=$1 and u.id=$2 for update", [actor.workspaceId, request.params.id]);
        if (!selected.rows[0]) { await client.query('rollback'); return reply.code(404).send({ error: 'member is not in this workspace' }); }
        const target = selected.rows[0] as { id: string; email: string; role: string; status: string };
        if (actor.role === 'admin' && target.role === 'owner') { await client.query('rollback'); return reply.code(403).send({ error: 'admin cannot issue links for the owner' }); }
        if (request.body.purpose === 'INVITE' && target.status !== 'INVITED') { await client.query('rollback'); return reply.code(400).send({ error: 'invitation links are only for invited members' }); }
        if (request.body.purpose === 'RESET' && target.status !== 'ACTIVE') { await client.query('rollback'); return reply.code(400).send({ error: 'password reset links are only for active members' }); }
        const issued = await issueAccountToken(client, { workspaceId: actor.workspaceId, adminUserId: target.id, purpose: request.body.purpose, createdBy: actor.email });
        await client.query(
          "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,$3,'member',$4,$5::jsonb)",
          [actor.workspaceId, actor.email, request.body.purpose === 'INVITE' ? 'ACCOUNT_INVITE_ISSUED' : 'ACCOUNT_RESET_ISSUED', target.id, JSON.stringify({ detail: `One-time ${request.body.purpose === 'INVITE' ? 'invitation' : 'password reset'} link issued; expires ${issued.expiresAt}` })]
        );
        await client.query('commit');
        return { memberId: target.id, purpose: request.body.purpose, setupUrl: accountSetupUrl(issued.token), expiresAt: issued.expiresAt };
      } catch (error) { await client.query('rollback').catch(() => undefined); return respondError(error, reply); }
      finally { client.release(); }
    }
  );

  app.patch<{ Params: { id: string }; Body: { role?: 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer'; status?: 'INVITED' | 'ACTIVE' | 'SUSPENDED' } }>(
    '/api/workspace/members/:id',
    { preHandler: (request, reply) => allowed(request, reply, true), schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { role: { type: 'string', enum: ['owner', 'admin', 'editor', 'reviewer', 'viewer'] }, status: { type: 'string', enum: ['INVITED', 'ACTIVE', 'SUSPENDED'] } } } } },
    async (request, reply) => {
      const actor = (request as AdminRequest).user!;
      const client = await pool!.connect();
      try {
        await client.query('begin');
        const selected = await client.query("select u.id,u.role,m.status from workspace_memberships m join admin_users u on u.id=m.admin_user_id and u.workspace_id=m.workspace_id where m.workspace_id=$1 and u.id=$2 for update", [actor.workspaceId, request.params.id]);
        if (!selected.rows[0]) { await client.query('rollback'); return reply.code(404).send({ error: 'member is not in this workspace' }); }
        const current = selected.rows[0] as { id: string; role: string; status: string };
        if (actor.role === 'admin' && current.role === 'owner') { await client.query('rollback'); return reply.code(403).send({ error: 'admin cannot manage the owner' }); }
        if (actor.role === 'admin' && request.body.role === 'owner') { await client.query('rollback'); return reply.code(403).send({ error: 'admin cannot grant owner role' }); }
        if (current.id === actor.id && (request.body.status === 'SUSPENDED' || (request.body.role && request.body.role !== 'owner'))) { await client.query('rollback'); return reply.code(400).send({ error: 'you cannot suspend or lower your own access' }); }
        if (request.body.status === 'ACTIVE' && current.status === 'INVITED') { await client.query('rollback'); return reply.code(400).send({ error: 'an invitation must be accepted through its one-time setup link' }); }
        const nextRole = request.body.role || current.role;
        const nextStatus = request.body.status || current.status;
        if (current.role === 'owner' && current.status === 'ACTIVE' && (nextRole !== 'owner' || nextStatus !== 'ACTIVE')) {
          const owners = await client.query("select count(*)::int as count from workspace_memberships m join admin_users u on u.id=m.admin_user_id and u.workspace_id=m.workspace_id where m.workspace_id=$1 and u.role='owner' and m.status='ACTIVE'", [actor.workspaceId]);
          if (Number(owners.rows[0]?.count || 0) <= 1) { await client.query('rollback'); return reply.code(400).send({ error: 'the last active owner cannot be suspended or demoted' }); }
        }
        await client.query('update admin_users set role=$1 where id=$2 and workspace_id=$3', [nextRole, current.id, actor.workspaceId]);
        const updated = await client.query("update workspace_memberships set status=$1 where admin_user_id=$2 and workspace_id=$3 returning admin_user_id as id,status", [nextStatus, current.id, actor.workspaceId]);
        if (nextStatus === 'SUSPENDED') await client.query('update auth_sessions set revoked_at=now() where user_id=$1 and revoked_at is null', [current.id]);
        await client.query("insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,'MEMBER_UPDATED','member',$3,$4::jsonb)", [actor.workspaceId, actor.email, current.id, JSON.stringify({ role: nextRole, status: nextStatus })]);
        await client.query('commit');
        return { id: current.id, role: nextRole, status: updated.rows[0]?.status || nextStatus };
      } catch (error) { await client.query('rollback').catch(() => undefined); return respondError(error, reply); }
      finally { client.release(); }
    }
  );

  app.get('/api/workspace/oa-channels', { preHandler: (request, reply) => allowed(request, reply, true) }, async (request) => {
    const user = (request as AdminRequest).user!;
    const result = await pool!.query(
      "select oa.id as \"oaId\", oa.display_name as \"displayName\", c.messaging_channel_id as \"messagingChannelId\", c.login_channel_id as \"loginChannelId\", c.line_provider_id as \"lineProviderId\", coalesce(c.status,'NOT_CONFIGURED') as status from oa_integrations oa left join workspace_oa_channels c on c.workspace_id=oa.workspace_id and c.oa_integration_id=oa.id where oa.workspace_id=$1 order by oa.created_at",
      [user.workspaceId]
    );
    return { channels: result.rows };
  });

  app.put<{ Params: { oaId: string }; Body: { messagingChannelId?: string | null; loginChannelId?: string | null; lineProviderId?: string | null } }>(
    '/api/workspace/oa-channels/:oaId',
    { preValidation: async (request, reply) => {
        const body = request.body as Record<string, unknown> | null;
        const allowedKeys = new Set(['messagingChannelId', 'loginChannelId', 'lineProviderId']);
        if (body && Object.keys(body).some(key => !allowedKeys.has(key)))
          return reply.code(400).send({ error: 'unexpected or sensitive field is not allowed' });
      },
      preHandler: (request, reply) => allowed(request, reply, true),
      schema: { params: { type: 'object', required: ['oaId'], additionalProperties: false,
          properties: { oaId: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', additionalProperties: false,
          properties: {
            messagingChannelId: { anyOf: [{ type: 'string', pattern: '^[0-9]{5,30}$' }, { type: 'null' }] },
            loginChannelId: { anyOf: [{ type: 'string', pattern: '^[0-9]{5,30}$' }, { type: 'null' }] },
            lineProviderId: { anyOf: [{ type: 'string', minLength: 2, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$' }, { type: 'null' }] }
          } } } },
    async (request, reply) => {
      const user = (request as AdminRequest).user!;
      if (user.role !== 'owner') return reply.code(403).send({ error: 'only owner may configure LINE channels' });
      const channelId = request.body.messagingChannelId ?? null;
      const loginId = request.body.loginChannelId ?? null;
      const providerId = request.body.lineProviderId ?? null;
      if (!channelId || !providerId) return reply.code(400).send({ error: 'messagingChannelId and lineProviderId are required' });
      const client = await pool!.connect();
      try {
        await client.query('begin');
        const matches = await client.query(
          'select id from oa_integrations where id=$1 and workspace_id=$2 for update',
          [request.params.oaId, user.workspaceId]
        );
        if (!matches.rowCount) {
          await client.query('rollback');
          return reply.code(404).send({ error: 'OA not found in this workspace' });
        }
        const result = await client.query(
          "insert into workspace_oa_channels(workspace_id,oa_integration_id,messaging_channel_id,login_channel_id,line_provider_id,status,verified_at) values ($1,$2,$3,$4,$5,'VERIFY_PENDING',null) on conflict (workspace_id,oa_integration_id) do update set messaging_channel_id=excluded.messaging_channel_id,login_channel_id=excluded.login_channel_id,line_provider_id=excluded.line_provider_id,status='VERIFY_PENDING',verified_at=null returning id,status",
          [user.workspaceId, request.params.oaId, channelId, loginId, providerId]
        );
        await client.query(
          "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,'OA_CHANNEL_METADATA_UPDATED','oa',$3,$4::jsonb)",
          [user.workspaceId, user.email, request.params.oaId, JSON.stringify({ detail: 'LINE channel metadata saved; credentials are not configured and LINE API has not been called' })]
        );
        await client.query('commit');
        return { oaId: request.params.oaId, status: result.rows[0].status, verified: false, secretConfigured: false };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        return respondError(error, reply);
      } finally { client.release(); }
    }
  );
}
