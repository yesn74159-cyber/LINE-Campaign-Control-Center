import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { runMigrations } from '../dist/api/migrate.js';
import { PostgresLineLoginStore } from '../dist/api/lineLoginPostgresStore.js';
import { registerLineLoginRoutes, sealLineLoginValue } from '../dist/api/lineLogin.js';

const migrationSql = readFileSync(new URL('../db/migrations/011_line_customer_login_persistence.sql', import.meta.url), 'utf8');
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const sealKey = Buffer.alloc(32, 21);

function requireDisposableLocalDatabaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'LINE login integration tests may only connect to loopback');
  assert.match(decodeURIComponent(url.pathname.slice(1)), /^line_ccc_line_login_qa_[a-z0-9_]+$/, 'database name must use the dedicated line_ccc_line_login_qa_ prefix');
  return value;
}

function storedFlow(context, state, browserBinding) {
  const nonce = `nonce-${state}`;
  return {
    stateHash: sha256(state),
    browserBindingHash: sha256(browserBinding),
    workspaceId: context.workspaceId,
    oaId: context.oaId,
    referralId: context.referralId,
    nonceHash: sha256(nonce),
    nonceSealed: sealLineLoginValue(nonce, sealKey),
    codeVerifierSealed: sealLineLoginValue(`verifier-${state}`, sealKey),
    referralTokenSealed: sealLineLoginValue(context.referralToken, sealKey),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000)
  };
}

async function createWorkspace(pool, suffix) {
  const workspaceId = (await pool.query("insert into workspaces(name,mode) values ($1,'DRY_RUN') returning id", [`LINE Login QA ${suffix}`])).rows[0].id;
  const adminId = (await pool.query("insert into admin_users(workspace_id,email,display_name,role,password_hash) values ($1,$2,'QA Owner','owner','not-a-real-password-hash') returning id", [workspaceId, `${suffix}@line-login-qa.invalid`])).rows[0].id;
  await pool.query("insert into workspace_memberships(workspace_id,admin_user_id,status) values ($1,$2,'ACTIVE')", [workspaceId, adminId]);
  const oaId = (await pool.query("insert into oa_integrations(workspace_id,provider_id,basic_id,display_name,environment,enabled) values ($1,$2,'@loginqa','Login QA OA','STAGING',true) returning id", [workspaceId, `provider-${suffix}`])).rows[0].id;
  const referralToken = `opaque-referral-token-${suffix}-not-a-secret`;
  const inviteLinkId = (await pool.query("insert into staff_invite_links(workspace_id,admin_user_id,oa_integration_id,token_hash) values ($1,$2,$3,$4) returning id", [workspaceId, adminId, oaId, sha256(referralToken)])).rows[0].id;
  return { workspaceId, adminId, oaId, inviteLinkId, referralToken };
}

test('migration 011 has scoped identity/session keys, encrypted one-time flows, RLS, and no provider token/raw-sub columns', () => {
  assert.match(migrationSql, /create table line_customers/i);
  assert.match(migrationSql, /unique \(workspace_id, oa_integration_id, line_subject_hmac\)/i);
  assert.match(migrationSql, /create table line_customer_login_states/i);
  assert.match(migrationSql, /nonce_sealed/i);
  assert.match(migrationSql, /code_verifier_sealed/i);
  assert.match(migrationSql, /referral_token_sealed/i);
  assert.match(migrationSql, /create table line_customer_sessions/i);
  assert.match(migrationSql, /token_hash/i);
  assert.match(migrationSql, /referral_events_customer_scope_fk/i);
  assert.match(migrationSql, /enable row level security/i);
  assert.doesNotMatch(migrationSql, /\b(?:access_token|refresh_token|id_token|raw_line_sub|line_user_id)\b/i);
});

test('PostgreSQL migrations and LINE Login persistence are isolated to a disposable loopback database', async t => {
  const connectionString = requireDisposableLocalDatabaseUrl(process.env.LINE_LOGIN_TEST_DATABASE_URL);
  if (!connectionString) {
    if (process.env.CI === 'true') throw new Error('LINE_LOGIN_TEST_DATABASE_URL is required in CI; refusing to skip PostgreSQL integration');
    t.skip('LINE_LOGIN_TEST_DATABASE_URL is not set; no database is touched');
    return;
  }
  const pool = new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 4000 });
  t.after(() => pool.end());
  const identityResult = await pool.query('select current_database() as database_name, inet_server_addr()::text as address');
  assert.match(identityResult.rows[0].database_name, /^line_ccc_line_login_qa_[a-z0-9_]+$/);
  const serverAddress = identityResult.rows[0].address?.replace(/\/\d+$/, '');
  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(serverAddress), `unexpected PostgreSQL server address: ${identityResult.rows[0].address}`);
  assert.equal((await pool.query("select to_regclass('public.schema_migrations') as ledger")).rows[0].ledger, null, 'integration target must be a fresh disposable database');

  const migrations = await runMigrations(pool);
  assert.equal(migrations.length, 11);
  assert.ok(migrations.includes('011_line_customer_login_persistence.sql'));
  const store = new PostgresLineLoginStore(pool);
  const tenantA = await createWorkspace(pool, `a_${Date.now()}`);
  const tenantB = await createWorkspace(pool, `b_${Date.now()}`);
  const contextA = await store.resolveLineLoginMember(tenantA.referralToken);
  assert.equal(contextA.workspaceId, tenantA.workspaceId);
  assert.equal(contextA.oaId, tenantA.oaId);
  assert.equal(contextA.referralId, tenantA.inviteLinkId);

  const flowA = storedFlow(contextA, 'a'.repeat(64), 'browser-binding-a');
  await store.saveLineLoginFlow(flowA);
  assert.equal((await store.getLineLoginFlow(flowA.stateHash, flowA.browserBindingHash)).stateHash, flowA.stateHash);
  const rawSubject = 'U-this-is-never-persisted-as-raw-subject';
  const subjectHmac = 'c'.repeat(64);
  const rawSessionToken = 'raw-customer-session-token-never-stored';
  const completedA = await store.completeLineLogin({
    stateHash: flowA.stateHash, browserBindingHash: flowA.browserBindingHash,
    subjectHmac, displayName: 'Customer A', sessionToken: rawSessionToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  assert.equal(completedA.customer.role, 'customer');
  assert.equal((await store.getLineLoginFlow(flowA.stateHash, flowA.browserBindingHash)), null);
  assert.equal((await store.getLineMemberSession(rawSessionToken)).id, completedA.customer.id);
  assert.equal((await store.getLineMemberSession(sha256(rawSessionToken))), null);

  const identityRow = (await pool.query('select line_subject_hmac from line_customers where id=$1', [completedA.customer.id])).rows[0];
  assert.equal(identityRow.line_subject_hmac, subjectHmac);
  const sessionRow = (await pool.query('select token_hash from line_customer_sessions where customer_id=$1', [completedA.customer.id])).rows[0];
  assert.equal(sessionRow.token_hash, sha256(rawSessionToken));
  assert.doesNotMatch(JSON.stringify({ identityRow, sessionRow }), new RegExp(rawSubject));
  assert.doesNotMatch(JSON.stringify({ identityRow, sessionRow }), new RegExp(rawSessionToken));

  const duplicateFlow = storedFlow(contextA, 'b'.repeat(64), 'browser-binding-b');
  await store.saveLineLoginFlow(duplicateFlow);
  const duplicate = await store.completeLineLogin({
    stateHash: duplicateFlow.stateHash, browserBindingHash: duplicateFlow.browserBindingHash,
    subjectHmac, displayName: 'Updated Customer A', sessionToken: 'different-session-token',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  assert.equal(duplicate.customer.id, completedA.customer.id);
  assert.equal((await pool.query('select count(*)::int as count from line_customers where workspace_id=$1 and oa_integration_id=$2', [tenantA.workspaceId, tenantA.oaId])).rows[0].count, 1);

  const rollbackFlow = storedFlow(contextA, 'd'.repeat(64), 'browser-binding-d');
  await store.saveLineLoginFlow(rollbackFlow);
  await assert.rejects(() => store.completeLineLogin({
    stateHash: rollbackFlow.stateHash, browserBindingHash: rollbackFlow.browserBindingHash,
    subjectHmac: 'd'.repeat(64), displayName: 'Rollback Customer', sessionToken: rawSessionToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  }));
  assert.ok(await store.getLineLoginFlow(rollbackFlow.stateHash, rollbackFlow.browserBindingHash), 'failed session insert must roll back state consumption');
  assert.equal((await pool.query('select count(*)::int as count from line_customers where line_subject_hmac=$1', ['d'.repeat(64)])).rows[0].count, 0, 'failed completion must roll back customer creation');
  assert.equal((await pool.query("select count(*)::int as count from referral_attribution_events where event_type='LOGIN' and customer_id=$1", [completedA.customer.id])).rows[0].count, 2);

  const replayFlow = storedFlow(contextA, 'e'.repeat(64), 'browser-binding-e');
  await store.saveLineLoginFlow(replayFlow);
  const replayInput = {
    stateHash: replayFlow.stateHash, browserBindingHash: replayFlow.browserBindingHash,
    subjectHmac: 'e'.repeat(64), displayName: 'Replay Customer',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  };
  const concurrent = await Promise.all([
    store.completeLineLogin({ ...replayInput, sessionToken: 'replay-session-a' }),
    store.completeLineLogin({ ...replayInput, sessionToken: 'replay-session-b' })
  ]);
  assert.equal(concurrent.filter(Boolean).length, 1, 'only one concurrent callback may consume a state');
  assert.equal((await pool.query('select count(*)::int as count from line_customers where line_subject_hmac=$1', ['e'.repeat(64)])).rows[0].count, 1);

  const contextB = await store.resolveLineLoginMember(tenantB.referralToken);
  const flowB = storedFlow(contextB, 'f'.repeat(64), 'browser-binding-f');
  await store.saveLineLoginFlow(flowB);
  const completedB = await store.completeLineLogin({
    stateHash: flowB.stateHash, browserBindingHash: flowB.browserBindingHash,
    subjectHmac, displayName: 'Customer B', sessionToken: 'tenant-b-session',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  assert.notEqual(completedB.customer.id, completedA.customer.id);
  await assert.rejects(() => pool.query(
    `insert into line_customer_sessions(token_hash,customer_id,workspace_id,oa_integration_id,invite_link_id,expires_at)
     values ($1,$2,$3,$4,$5,now()+interval '1 hour')`,
    [sha256('cross-workspace-session'), completedA.customer.id, tenantB.workspaceId, tenantB.oaId, tenantB.inviteLinkId]
  ));

  await store.revokeLineMemberSession(rawSessionToken);
  assert.equal(await store.getLineMemberSession(rawSessionToken), null);
  const expiredSessionFlow = storedFlow(contextA, '1'.repeat(64), 'expired-session-browser');
  await store.saveLineLoginFlow(expiredSessionFlow);
  const expiredSession = await store.completeLineLogin({
    stateHash: expiredSessionFlow.stateHash, browserBindingHash: expiredSessionFlow.browserBindingHash,
    subjectHmac: '2'.repeat(64), displayName: 'Expired Session', sessionToken: 'expired-session-token',
    expiresAt: new Date(Date.now() - 1000)
  });
  assert.ok(expiredSession);
  assert.equal(await store.getLineMemberSession('expired-session-token'), null);
  const expiredFlow = storedFlow(contextA, '3'.repeat(64), 'expired-browser');
  expiredFlow.expiresAt = new Date(Date.now() - 1000);
  await store.saveLineLoginFlow(expiredFlow);
  await store.cleanupExpiredLineLoginData();
  assert.equal(await store.getLineLoginFlow(expiredFlow.stateHash, expiredFlow.browserBindingHash), null);
  assert.equal((await pool.query('select count(*)::int as count from line_customer_sessions where token_hash=$1', [sha256('expired-session-token')])).rows[0].count, 0);

  const routeTenant = await createWorkspace(pool, `route_${Date.now()}`);
  const providerCalls = [];
  const app = Fastify();
  app.register(cookie);
  registerLineLoginRoutes(app, store, {
    enabled: true, channelId: 'local-postgres-test-channel', channelSecret: 'not-a-real-channel-secret',
    redirectUri: 'http://127.0.0.1:8787/api/line-login/callback',
    publicAppOrigin: 'http://127.0.0.1:5173',
    identityHashKey: 'local-postgres-test-identity-hmac-key-long-enough',
    flowEncryptionKey: sealKey, secureCookies: false,
    fetcher: async (url, options) => {
      providerCalls.push(String(url));
      const form = new URLSearchParams(options.body);
      if (String(url) === 'https://api.line.me/oauth2/v2.1/token') {
        assert.equal(form.get('client_secret'), 'not-a-real-channel-secret');
        return Response.json({ id_token: 'local-id-token-not-persisted' });
      }
      assert.equal(String(url), 'https://api.line.me/oauth2/v2.1/verify');
      return Response.json({
        iss: 'https://access.line.me', sub: 'U-route-test-subject', aud: 'local-postgres-test-channel',
        exp: Math.floor(Date.now() / 1000) + 300, nonce: form.get('nonce'), name: 'Route Customer'
      });
    }
  });
  await app.ready();
  try {
    const start = await app.inject({ method: 'GET', url: `/api/line-login/start?referralToken=${encodeURIComponent(routeTenant.referralToken)}` });
    assert.equal(start.statusCode, 302);
    const flowCookie = [].concat(start.headers['set-cookie'] || []).find(value => value.startsWith('line_login_flow='))?.split(';', 1)[0];
    const state = new URL(start.headers.location).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET', url: `/api/line-login/callback?code=local-mock-code&state=${state}`,
      headers: { cookie: flowCookie }
    });
    assert.equal(callback.statusCode, 302);
    assert.match(callback.headers.location, /lineLogin=success$/);
    assert.deepEqual(providerCalls, ['https://api.line.me/oauth2/v2.1/token', 'https://api.line.me/oauth2/v2.1/verify']);
    const sessionCookie = [].concat(callback.headers['set-cookie'] || []).find(value => value.startsWith('line_member_session='))?.split(';', 1)[0];
    const session = await app.inject({ method: 'GET', url: '/api/line-login/session', headers: { cookie: sessionCookie } });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().member.role, 'customer');
    assert.equal((await pool.query('select count(*)::int as count from line_customers where workspace_id=$1 and oa_integration_id=$2', [routeTenant.workspaceId, routeTenant.oaId])).rows[0].count, 1);
    assert.equal((await pool.query('select count(*)::int as count from line_customer_sessions where customer_id=$1', [session.json().member.id])).rows[0].count, 1);
  } finally {
    await app.close();
  }
});
