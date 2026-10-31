import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerTenantAdminRoutes } from '../dist/api/tenantAdmin.js';
import { createPostgresRepository } from '../dist/api/repository.js';

const user = (role = 'owner', id = 'owner-a') => ({
  id, workspaceId: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.test', displayName: 'Owner', role
});
const otherOa = '33333333-3333-4333-8333-333333333333';

function harness(role = 'owner', membership = true) {
  const queries = [];
  const pool = {
    async query(sql, args = []) {
      queries.push({ sql, args });
      if (sql.includes('from workspace_memberships')) return { rowCount: membership ? 1 : 0, rows: membership ? [{ '?column?': 1 }] : [] };
      if (sql.includes('from workspaces where id=')) return { rowCount: 1, rows: [{ id: user().workspaceId, slug: 'ws-test', name: 'Test Tenant', mode: 'DRY_RUN' }] };
      if (sql.includes('from workspace_memberships m join')) return { rowCount: 1, rows: [{ id: user().id, email: user().email, role, status: 'ACTIVE' }] };
      if (sql.includes('from oa_integrations oa left join')) return { rowCount: 0, rows: [] };
      if (sql.includes('update workspaces set name=')) return { rowCount: 1, rows: [{ id: user().workspaceId, slug: 'ws-test', name: args[0], mode: 'DRY_RUN' }] };
      if (sql.includes('insert into audit_log')) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    async connect() {
      const client = {
        query: async (sql, args = []) => {
          queries.push({ sql, args });
          if (sql.includes('select id from oa_integrations')) return { rowCount: 0, rows: [] };
          return { rowCount: 0, rows: [] };
        },
        release() { }
      };
      return client;
    }
  };
  const app = Fastify();
  const requireUser = async request => {
    request.user = user(role);
  };
  const csrf = (request, reply) => {
    if (request.headers['x-csrf-token'] !== 'valid-csrf') return reply.code(403).send({ error: 'csrf required' });
  };
  registerTenantAdminRoutes(app, pool, requireUser, csrf);
  return { app, queries };
}

test('owner can read only their own workspace and members', async () => {
  const { app, queries } = harness();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/workspace/settings' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().workspace.slug, 'ws-test');
    assert.equal(queries.at(-1).args[0], user().workspaceId);
    const members = await app.inject({ method: 'GET', url: '/api/workspace/members' });
    assert.equal(members.statusCode, 200, members.body);
    assert.equal(members.json().members.length, 1);
  } finally { await app.close(); }
});

test('viewer cannot list members or mutate tenant settings', async () => {
  const { app } = harness('viewer');
  try {
    const list = await app.inject({ method: 'GET', url: '/api/workspace/members' });
    assert.equal(list.statusCode, 403);
    const edit = await app.inject({ method: 'PATCH', url: '/api/workspace/settings', payload: { name: 'Changed tenant' }, headers: { 'x-csrf-token': 'valid-csrf' } });
    assert.equal(edit.statusCode, 403);
  } finally { await app.close(); }
});

test('suspended or missing membership gets no tenant information', async () => {
  const { app } = harness('owner', false);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/workspace/settings' });
    assert.equal(response.statusCode, 403);
  } finally { await app.close(); }
});

test('owner mutations enforce CSRF and block cross-workspace OA', async () => {
  const { app, queries } = harness();
  try {
    const noCsrf = await app.inject({ method: 'PATCH', url: '/api/workspace/settings', payload: { name: 'New Name' } });
    assert.equal(noCsrf.statusCode, 403);
    const rename = await app.inject({ method: 'PATCH', url: '/api/workspace/settings', headers: { 'x-csrf-token': 'valid-csrf' }, payload: { name: 'Changed Workspace' } });
    assert.equal(rename.statusCode, 200, rename.body);
    assert.equal(rename.json().workspace.name, 'Changed Workspace');
    const bad = await app.inject({ method: 'PUT', url: '/api/workspace/oa-channels/' + otherOa,
      headers: { 'x-csrf-token': 'valid-csrf' },
      payload: { messagingChannelId: '1234567890', lineProviderId: 'providerABC' } });
    assert.equal(bad.statusCode, 404, bad.body);
    assert.ok(queries.some(x => x.sql.includes('where id=$1 and workspace_id=$2 for update') && x.args[1] === user().workspaceId));
    assert.equal(queries.filter(x => x.sql.includes('insert into workspace_oa_channels')).length, 0);
  } finally { await app.close(); }
});

test('channel metadata API rejects attempted token or secret injection', async () => {
  const { app } = harness();
  try {
    const leaked = await app.inject({ method: 'PUT', url: '/api/workspace/oa-channels/' + otherOa,
      headers: { 'x-csrf-token': 'valid-csrf' },
      payload: { messagingChannelId: '1234567890', lineProviderId: 'providerABC', accessToken: 'do-not-accept' } });
    assert.equal(leaked.statusCode, 400);
  } finally { await app.close(); }
});

test('inactive memberships cannot use existing login sessions', async () => {
  const captured = [];
  const repo = createPostgresRepository({
    query: async (sql) => {
      captured.push(sql);
      return { rows: [], rowCount: 0 };
    }
  });
  assert.equal(await repo.getUserByEmail('one@example.test'), null);
  assert.equal(await repo.getSessionUser('not-a-real-token'), null);
  assert.ok(captured.every(sql => sql.includes('workspace_memberships') && sql.includes('ACTIVE')));
});
const inviteTargetId = '55555555-5555-4555-8555-555555555555';
const setupUrlPattern = /^http:\/\/127\.0\.0\.1:5173\/account-setup\?token=[A-Za-z0-9_-]{43}$/;

function accountHarness(status) {
  const queries = [];
  const pool = {
    async query(sql, args = []) {
      queries.push({ sql, args });
      if (sql.includes('from workspace_memberships')) return { rowCount: 1, rows: [{ '?column?': 1 }] };
      return { rowCount: 0, rows: [] };
    },
    async connect() {
      return {
        async query(sql, args = []) {
          queries.push({ sql, args });
          if (sql.includes('insert into admin_users')) return { rowCount: 1, rows: [{ id: inviteTargetId, email: args[1], displayName: args[2], role: args[3] }] };
          if (sql.includes('select u.id,u.email,u.role,m.status from workspace_memberships')) return { rowCount: 1, rows: [{ id: inviteTargetId, email: 'member@example.test', role: 'viewer', status }] };
          if (sql.includes('insert into admin_account_tokens')) return { rowCount: 1, rows: [] };
          return { rowCount: 0, rows: [] };
        },
        release() { }
      };
    }
  };
  const app = Fastify();
  const requireUser = async request => { request.user = user('owner'); };
  const csrf = (request, reply) => {
    if (request.headers['x-csrf-token'] !== 'valid-csrf') return reply.code(403).send({ error: 'csrf required' });
  };
  registerTenantAdminRoutes(app, pool, requireUser, csrf);
  return { app, queries };
}

test('invitation returns a one-time setup URL without any password material', async () => {
  const { app, queries } = accountHarness('INVITED');
  try {
    const response = await app.inject({ method: 'POST', url: '/api/workspace/members', headers: { 'x-csrf-token': 'valid-csrf' }, payload: { email: 'new.person@example.test', displayName: 'New Person', role: 'editor' } });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();
    assert.equal(body.status, 'INVITED');
    assert.match(body.setupUrl, setupUrlPattern);
    assert.equal('password' in body, false);
    assert.equal('passwordHash' in body, false);
    const tokenInsert = queries.find(query => query.sql.includes('insert into admin_account_tokens'));
    assert.ok(tokenInsert);
    assert.equal(tokenInsert.args[2], 'INVITE');
    assert.match(tokenInsert.args[3], /^[a-f0-9]{64}$/);
  } finally { await app.close(); }
});

test('account link issuance matches the membership status', async () => {
  const invited = accountHarness('INVITED');
  try {
    const issued = await invited.app.inject({ method: 'POST', url: `/api/workspace/members/${inviteTargetId}/account-link`, headers: { 'x-csrf-token': 'valid-csrf' }, payload: { purpose: 'INVITE' } });
    assert.equal(issued.statusCode, 200, issued.body);
    assert.match(issued.json().setupUrl, setupUrlPattern);
    const reset = await invited.app.inject({ method: 'POST', url: `/api/workspace/members/${inviteTargetId}/account-link`, headers: { 'x-csrf-token': 'valid-csrf' }, payload: { purpose: 'RESET' } });
    assert.equal(reset.statusCode, 400);
    const tokenInsert = invited.queries.find(query => query.sql.includes('insert into admin_account_tokens'));
    assert.equal(tokenInsert.args[2], 'INVITE');
  } finally { await invited.app.close(); }

  const active = accountHarness('ACTIVE');
  try {
    const issued = await active.app.inject({ method: 'POST', url: `/api/workspace/members/${inviteTargetId}/account-link`, headers: { 'x-csrf-token': 'valid-csrf' }, payload: { purpose: 'RESET' } });
    assert.equal(issued.statusCode, 200, issued.body);
    const tokenInsert = active.queries.find(query => query.sql.includes('insert into admin_account_tokens'));
    assert.equal(tokenInsert.args[2], 'RESET');
  } finally { await active.app.close(); }
});
