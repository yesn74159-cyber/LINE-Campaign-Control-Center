import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import { runMigrations } from '../dist/api/migrate.js';
import { PostgresLineLoginStore } from '../dist/api/lineLoginPostgresStore.js';
import { sealLineLoginValue } from '../dist/api/lineLogin.js';
import { registerReferralRoutes } from '../dist/api/referralRoutes.js';
import {
  createReferral,
  getReferralStaff,
  listReferralEvents,
  listReferrals,
  recordClick,
  referralDashboard,
  setReferralStatus,
  verifyReferralFollow
} from '../dist/api/referralStore.js';

process.env.PUBLIC_APP_ORIGIN = 'http://127.0.0.1:5173';
const sealKey = Buffer.alloc(32, 33);
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

function requireDisposableLocalDatabaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'referral integration tests may only connect to loopback');
  assert.match(decodeURIComponent(url.pathname.slice(1)), /^line_ccc_referral_qa_[a-z0-9_]+$/, 'database name must use the dedicated line_ccc_referral_qa_ prefix');
  return value;
}

async function createTenant(pool, suffix) {
  const workspaceId = (await pool.query("insert into workspaces(name,mode) values ($1,'DRY_RUN') returning id", [`Referral QA ${suffix}`])).rows[0].id;
  const insertUser = async (role, label) => (await pool.query(
    "insert into admin_users(workspace_id,email,display_name,role,password_hash) values ($1,$2,$3,$4,'not-a-real-password-hash') returning id",
    [workspaceId, `${label}-${suffix}@referral-qa.invalid`, label, role]
  )).rows[0].id;
  const ownerId = await insertUser('owner', 'Owner');
  const editorId = await insertUser('editor', 'Editor');
  const insertOa = async (enabled, label, basicId) => (await pool.query(
    "insert into oa_integrations(workspace_id,provider_id,basic_id,display_name,environment,enabled) values ($1,$2,$3,$4,'STAGING',$5) returning id",
    [workspaceId, `provider-${label}-${suffix}`, basicId, `Referral QA OA ${label}`, enabled]
  )).rows[0].id;
  const oaId = await insertOa(true, 'enabled', '@refqa');
  const disabledOaId = await insertOa(false, 'disabled', '@refqad');
  await pool.query("insert into workspace_memberships(workspace_id,admin_user_id,status) values ($1,$2,'ACTIVE'),($1,$3,'ACTIVE')", [workspaceId, ownerId, editorId]);
  return { workspaceId, ownerId, editorId, oaId, disabledOaId };
}

async function loginFlow(pool, lineStore, tenant, referralToken, referralId, suffix, subjectHmac) {
  const state = sha256(`state-${suffix}`);
  const binding = `binding-${suffix}`;
  const nonce = `nonce-${suffix}`;
  await lineStore.saveLineLoginFlow({
    stateHash: state,
    browserBindingHash: sha256(binding),
    workspaceId: tenant.workspaceId,
    oaId: tenant.oaId,
    referralId,
    nonceHash: sha256(nonce),
    nonceSealed: sealLineLoginValue(nonce, sealKey),
    codeVerifierSealed: sealLineLoginValue(`verifier-${suffix}`, sealKey),
    referralTokenSealed: sealLineLoginValue(referralToken, sealKey),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000)
  });
  return lineStore.completeLineLogin({
    stateHash: state,
    browserBindingHash: sha256(binding),
    subjectHmac,
    displayName: `Customer ${suffix}`,
    sessionToken: `raw-session-${suffix}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
}

test('PostgreSQL referral journey is tenant-scoped, hashes tokens, and verifies signed follow evidence', async t => {
  const connectionString = requireDisposableLocalDatabaseUrl(process.env.REFERRAL_TEST_DATABASE_URL);
  if (!connectionString) {
    if (process.env.CI === 'true') throw new Error('REFERRAL_TEST_DATABASE_URL is required in CI; refusing to skip PostgreSQL integration');
    t.skip('REFERRAL_TEST_DATABASE_URL is not set; no database is touched');
    return;
  }
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 4000 });
  t.after(() => pool.end());
  const identity = await pool.query('select current_database() as database_name, inet_server_addr()::text as address');
  assert.match(identity.rows[0].database_name, /^line_ccc_referral_qa_[a-z0-9_]+$/);
  const serverAddress = identity.rows[0].address?.replace(/\/\d+$/, '');
  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(serverAddress), `unexpected PostgreSQL server address: ${identity.rows[0].address}`);
  assert.equal((await pool.query("select to_regclass('public.schema_migrations') as ledger")).rows[0].ledger, null, 'integration target must be a fresh disposable database');

  const migrations = await runMigrations(pool);
  assert.ok(migrations.length >= 12, `expected at least 12 migrations, got ${migrations.length}`);
  assert.ok(migrations.includes('011_line_customer_login_persistence.sql'));
  assert.ok(migrations.includes('012_account_invites.sql'));

  const tenantA = await createTenant(pool, `a_${Date.now()}`);
  const tenantB = await createTenant(pool, `b_${Date.now()}`);
  const created = await createReferral(pool, { workspaceId: tenantA.workspaceId, staffId: tenantA.editorId, oaId: tenantA.oaId, actor: 'owner@referral-qa.invalid' });
  assert.match(created.plainToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.url, `http://127.0.0.1:5173/r/${created.plainToken}`);
  const storedToken = (await pool.query('select token_hash from staff_invite_links where id=$1', [created.referral.id])).rows[0];
  assert.equal(storedToken.token_hash, sha256(created.plainToken));
  assert.notEqual(storedToken.token_hash, created.plainToken);
  await assert.rejects(
    () => createReferral(pool, { workspaceId: tenantA.workspaceId, staffId: tenantA.editorId, oaId: tenantA.disabledOaId, actor: 'owner@referral-qa.invalid' }),
    /enabled staging OA/
  );

  const staff = await getReferralStaff(pool, tenantA.workspaceId);
  assert.equal(staff.find(item => item.id === tenantA.editorId).active, true);
  const listed = await listReferrals(pool, tenantA.workspaceId, {});
  assert.ok(listed.some(item => item.id === created.referral.id));
  assert.equal(JSON.stringify(listed).includes(created.plainToken), false);

  let dashboard = await referralDashboard(pool, tenantA.workspaceId, {});
  let row = dashboard.find(item => item.staffId === tenantA.editorId);
  assert.deepEqual({ clicks: row.clicks, logins: row.logins, followVerified: row.followVerified }, { clicks: 0, logins: 0, followVerified: 0 });

  const click = await recordClick(pool, created.plainToken);
  assert.equal(click.staffName, 'Editor');
  assert.equal((await pool.query("select count(*)::int as count from referral_attribution_events where invite_link_id=$1 and event_type='CLICK'", [created.referral.id])).rows[0].count, 1);

  const lineStore = new PostgresLineLoginStore(pool);
  const context = await lineStore.resolveLineLoginMember(created.plainToken);
  assert.equal(context.referralId, created.referral.id);
  const completed = await loginFlow(pool, lineStore, tenantA, created.plainToken, created.referral.id, 'first', 'c'.repeat(64));
  assert.equal(completed.customer.role, 'customer');

  const secondLink = await createReferral(pool, { workspaceId: tenantA.workspaceId, staffId: tenantA.editorId, oaId: tenantA.oaId, actor: 'owner@referral-qa.invalid' });
  const secondLogin = await loginFlow(pool, lineStore, tenantA, secondLink.plainToken, secondLink.referral.id, 'second', 'c'.repeat(64));
  assert.equal(secondLogin.customer.id, completed.customer.id);
  const loginEvents = await pool.query("select invite_link_id from referral_attribution_events where customer_id=$1 and event_type='LOGIN' order by occurred_at", [completed.customer.id]);
  assert.equal(loginEvents.rows.length, 2);
  assert.ok(loginEvents.rows.every(item => String(item.invite_link_id) === created.referral.id), 'repeat login keeps first-touch attribution');

  const verified = await verifyReferralFollow(pool, { oaId: tenantA.oaId, eventId: 'follow-event-1', followerSubjectHmac: 'c'.repeat(64), evidenceRef: 'line-webhook:follow-event-1' });
  assert.deepEqual(verified, { accepted: true, duplicate: false, matched: true, referralId: created.referral.id });
  const duplicateEvent = await verifyReferralFollow(pool, { oaId: tenantA.oaId, eventId: 'follow-event-1', followerSubjectHmac: 'c'.repeat(64), evidenceRef: 'line-webhook:follow-event-1' });
  assert.equal(duplicateEvent.duplicate, true);
  const duplicateSubject = await verifyReferralFollow(pool, { oaId: tenantA.oaId, eventId: 'follow-event-2', followerSubjectHmac: 'c'.repeat(64), evidenceRef: 'line-webhook:follow-event-2' });
  assert.equal(duplicateSubject.duplicate, true);
  const unknownSubject = await verifyReferralFollow(pool, { oaId: tenantA.oaId, eventId: 'follow-event-3', followerSubjectHmac: 'd'.repeat(64), evidenceRef: 'line-webhook:follow-event-3' });
  assert.deepEqual(unknownSubject, { accepted: true, duplicate: false, matched: false });

  dashboard = await referralDashboard(pool, tenantA.workspaceId, {});
  row = dashboard.find(item => item.staffId === tenantA.editorId);
  assert.deepEqual({ clicks: row.clicks, logins: row.logins, followVerified: row.followVerified, conversionRate: row.conversionRate }, { clicks: 1, logins: 2, followVerified: 1, conversionRate: 100 });
  const filtered = await referralDashboard(pool, tenantA.workspaceId, {
    staffId: tenantA.editorId,
    oaId: tenantA.oaId,
    from: new Date(Date.now() - 60_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString()
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].followVerified, 1);
  await assert.rejects(() => referralDashboard(pool, tenantA.workspaceId, { from: 'not-a-date' }), /valid ISO date/);

  const events = await listReferralEvents(pool, tenantA.workspaceId);
  assert.equal(events.filter(item => item.type === 'FOLLOW_VERIFIED').length, 1);
  assert.equal(JSON.stringify(events).includes('c'.repeat(64)), false);
  assert.equal(JSON.stringify(events).includes('line_subject_hmac'), false);

  assert.equal((await listReferrals(pool, tenantB.workspaceId, {})).length, 0);
  assert.equal((await listReferrals(pool, tenantA.workspaceId, { staffId: tenantB.editorId })).length, 0);
  await assert.rejects(() => setReferralStatus(pool, tenantB.workspaceId, created.referral.id, 'REVOKED', 'owner-b@referral-qa.invalid'), /not in this workspace/);

  const app = Fastify();
  const ownerUser = { id: tenantA.ownerId, workspaceId: tenantA.workspaceId, email: 'owner-a@referral-qa.invalid', displayName: 'Owner A', role: 'owner' };
  const editorUser = { id: tenantA.editorId, workspaceId: tenantA.workspaceId, email: 'editor-a@referral-qa.invalid', displayName: 'Editor A', role: 'editor' };
  registerReferralRoutes(app, pool, async (request, reply) => {
    const role = request.headers['x-test-role'];
    if (role !== 'owner' && role !== 'editor') return reply.code(401).send({ error: 'authentication required' });
    request.user = role === 'owner' ? ownerUser : editorUser;
  }, () => undefined);
  await app.ready();
  let routeBody;
  try {
    const routeCreated = await app.inject({ method: 'POST', url: '/api/referrals', headers: { 'x-test-role': 'owner' }, payload: { staffId: tenantA.editorId, oaId: tenantA.oaId } });
    assert.equal(routeCreated.statusCode, 201, routeCreated.body);
    routeBody = routeCreated.json();
    assert.match(routeBody.plainToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Object.hasOwn(routeBody.referral, 'tokenHash'), false);
    assert.equal(Object.hasOwn(routeBody.referral, 'plainToken'), false);

    const deniedCreate = await app.inject({ method: 'POST', url: '/api/referrals', headers: { 'x-test-role': 'editor' }, payload: { staffId: tenantA.editorId, oaId: tenantA.oaId } });
    assert.equal(deniedCreate.statusCode, 403);
    const routeList = await app.inject({ method: 'GET', url: '/api/referrals', headers: { 'x-test-role': 'editor' } });
    assert.equal(routeList.statusCode, 200);
    assert.equal(routeList.body.includes(routeBody.plainToken), false);
    const routeStaff = await app.inject({ method: 'GET', url: '/api/referrals/staff', headers: { 'x-test-role': 'editor' } });
    assert.equal(routeStaff.statusCode, 200);
    const routeClick = await app.inject({ method: 'POST', url: `/api/referrals/${routeBody.plainToken}/click` });
    assert.equal(routeClick.statusCode, 200, routeClick.body);
    const routeDashboard = await app.inject({ method: 'GET', url: `/api/referral-dashboard?staffId=${tenantA.editorId}&oaId=${tenantA.oaId}`, headers: { 'x-test-role': 'editor' } });
    assert.equal(routeDashboard.statusCode, 200, routeDashboard.body);
    const routeEvents = await app.inject({ method: 'GET', url: '/api/referral-events', headers: { 'x-test-role': 'editor' } });
    assert.equal(routeEvents.statusCode, 200);
    assert.equal(routeEvents.body.includes('follower_subject_hmac'), false);
    const invalidClick = await app.inject({ method: 'POST', url: '/api/referrals/short/click' });
    assert.equal(invalidClick.statusCode, 400);
    const revoke = await app.inject({ method: 'POST', url: `/api/referrals/${routeBody.referral.id}/status`, headers: { 'x-test-role': 'owner' }, payload: { status: 'REVOKED' } });
    assert.equal(revoke.statusCode, 200, revoke.body);
    const resumeRevoked = await app.inject({ method: 'POST', url: `/api/referrals/${routeBody.referral.id}/status`, headers: { 'x-test-role': 'owner' }, payload: { status: 'ACTIVE' } });
    assert.equal(resumeRevoked.statusCode, 400);
  } finally {
    await app.close();
  }

  await setReferralStatus(pool, tenantA.workspaceId, created.referral.id, 'REVOKED', 'owner-a@referral-qa.invalid');
  await assert.rejects(() => recordClick(pool, created.plainToken), /invalid or inactive/);
  await assert.rejects(() => setReferralStatus(pool, tenantA.workspaceId, created.referral.id, 'ACTIVE', 'owner-a@referral-qa.invalid'), /cannot be reactivated/);

  const expiring = await createReferral(pool, { workspaceId: tenantA.workspaceId, staffId: tenantA.editorId, oaId: tenantA.oaId, actor: 'owner-a@referral-qa.invalid', expiresAt: new Date(Date.now() + 150).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 220));
  await assert.rejects(() => recordClick(pool, expiring.plainToken), /invalid or inactive/);

  const hashes = await pool.query('select token_hash from staff_invite_links');
  assert.equal(hashes.rows.some(item => item.token_hash === created.plainToken || item.token_hash === routeBody.plainToken || item.token_hash === expiring.plainToken), false);
});
