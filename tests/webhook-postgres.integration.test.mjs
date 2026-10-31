import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../dist/api/migrate.js';
import { sealOaSecret } from '../dist/api/lineOaConnect.js';

const identityKey = 'i'.repeat(32);
const vaultKey = randomBytes(32);
const secretA = 'a'.repeat(32);
const secretB = 'b'.repeat(32);
const envFallbackSecret = 'environment-webhook-fallback';
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const subjectHmac = userId => createHmac('sha256', identityKey).update(userId, 'utf8').digest('hex');
const sign = (raw, secret) => createHmac('sha256', secret).update(raw).digest('base64');

function requireDisposableLocalDatabaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'webhook integration tests may only connect to loopback');
  assert.match(decodeURIComponent(url.pathname.slice(1)), /^line_ccc_webhook_qa_[a-z0-9_]+$/, 'database name must use the dedicated line_ccc_webhook_qa_ prefix');
  return value;
}

async function seedTenant(pool, suffix) {
  const workspaceId = (await pool.query("insert into workspaces(name,mode) values ($1,'DRY_RUN') returning id", [`Webhook QA ${suffix}`])).rows[0].id;
  const ownerId = (await pool.query(
    "insert into admin_users(workspace_id,email,display_name,role,password_hash) values ($1,$2,'Webhook Owner','owner','not-a-real-password-hash') returning id",
    [workspaceId, `owner-${suffix}@webhook-qa.invalid`]
  )).rows[0].id;
  await pool.query("insert into workspace_memberships(workspace_id,admin_user_id,status) values ($1,$2,'ACTIVE')", [workspaceId, ownerId]);
  const insertOa = async (label, basicId) => (await pool.query(
    "insert into oa_integrations(workspace_id,provider_id,basic_id,display_name,environment,enabled) values ($1,$2,$3,$4,'STAGING',true) returning id",
    [workspaceId, `provider-${label}-${suffix}`, basicId, `Webhook QA OA ${label}`]
  )).rows[0].id;
  const oaId = await insertOa('main', '@webhookqa');
  const otherOaId = await insertOa('other', '@webhookqb');
  const unconfiguredOaId = await insertOa('unconfigured', '@webhookqc');
  const inviteLinkId = (await pool.query(
    'insert into staff_invite_links(workspace_id,admin_user_id,oa_integration_id,token_hash) values ($1,$2,$3,$4) returning id',
    [workspaceId, ownerId, oaId, sha256(`referral-token-${suffix}`)]
  )).rows[0].id;
  const botBasicId = '@webhookqa';
  for (const [id, secret] of [[oaId, secretA], [otherOaId, secretB]]) {
    await pool.query(
      'insert into oa_credential_vault(workspace_id,oa_integration_id,token_sealed,secret_sealed,bot_basic_id,access_token_checked_at) values ($1,$2,$3,$4,$5,now())',
      [workspaceId, id, sealOaSecret('t'.repeat(40), workspaceId, id, 'token', vaultKey), sealOaSecret(secret, workspaceId, id, 'secret', vaultKey), botBasicId]
    );
    await pool.query(
      "insert into workspace_oa_channels(workspace_id,oa_integration_id,messaging_channel_id,line_provider_id,status) values ($1,$2,$3,$4,'VERIFY_PENDING')",
      [workspaceId, id, id === oaId ? '1234567890' : '1234567891', `provider-${id.slice(0, 8)}`]
    );
  }
  await pool.query(
    "insert into workspace_oa_channels(workspace_id,oa_integration_id,messaging_channel_id,line_provider_id,status) values ($1,$2,'1234567892','provider-unconfigured','VERIFY_PENDING')",
    [workspaceId, unconfiguredOaId]
  );
  return { workspaceId, ownerId, oaId, otherOaId, unconfiguredOaId, inviteLinkId };
}

test('signed LINE webhooks use the per-OA vault secret, verify consent, and never use the environment fallback in PostgreSQL', async t => {
  const connectionString = requireDisposableLocalDatabaseUrl(process.env.WEBHOOK_TEST_DATABASE_URL);
  if (!connectionString) {
    if (process.env.CI === 'true') throw new Error('WEBHOOK_TEST_DATABASE_URL is required in CI; refusing to skip PostgreSQL integration');
    t.skip('WEBHOOK_TEST_DATABASE_URL is not set; no database is touched');
    return;
  }

  const pool = new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 4000 });
  t.after(() => pool.end());
  const identity = await pool.query('select current_database() as database_name, inet_server_addr()::text as address');
  assert.match(identity.rows[0].database_name, /^line_ccc_webhook_qa_[a-z0-9_]+$/);
  const serverAddress = identity.rows[0].address?.replace(/\/\d+$/, '');
  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(serverAddress), `unexpected PostgreSQL server address: ${identity.rows[0].address}`);
  assert.equal((await pool.query("select to_regclass('public.schema_migrations') as ledger")).rows[0].ledger, null, 'integration target must be a fresh disposable database');

  const migrations = await runMigrations(pool);
  assert.ok(migrations.length >= 12, `expected at least 12 migrations, got ${migrations.length}`);
  const tenant = await seedTenant(pool, `t_${Date.now()}`);
  const userId = 'U-webhook-qa-user';

  const original = {
    persistence: process.env.PERSISTENCE,
    appMode: process.env.APP_MODE,
    databaseUrl: process.env.DATABASE_URL,
    localDatabaseUrl: process.env.LOCAL_DATABASE_URL,
    target: process.env.DB_TARGET,
    schema: process.env.DB_SCHEMA,
    sslMode: process.env.DB_SSL_MODE,
    webhookEnabled: process.env.LINE_WEBHOOK_ENABLED,
    encryptionKey: process.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
    identityHashKey: process.env.LINE_IDENTITY_HASH_KEY,
    fallbackSecret: process.env.LINE_CHANNEL_SECRET
  };
  process.env.PERSISTENCE = 'postgres';
  process.env.APP_MODE = 'DRY_RUN';
  process.env.DATABASE_URL = connectionString;
  process.env.LOCAL_DATABASE_URL = connectionString;
  process.env.DB_TARGET = 'LOCAL_DEV';
  process.env.DB_SCHEMA = 'public';
  process.env.DB_SSL_MODE = 'disable';
  process.env.LINE_WEBHOOK_ENABLED = 'true';
  process.env.LINE_CREDENTIAL_ENCRYPTION_KEY = vaultKey.toString('base64');
  process.env.LINE_IDENTITY_HASH_KEY = identityKey;
  process.env.LINE_CHANNEL_SECRET = envFallbackSecret;
  const { buildApp } = await import('../dist/api/server.js');
  const app = buildApp();
  t.after(async () => {
    await app.close();
    for (const [name, value] of [
      ['PERSISTENCE', original.persistence], ['APP_MODE', original.appMode], ['DATABASE_URL', original.databaseUrl],
      ['LOCAL_DATABASE_URL', original.localDatabaseUrl], ['DB_TARGET', original.target], ['DB_SCHEMA', original.schema],
      ['DB_SSL_MODE', original.sslMode], ['LINE_WEBHOOK_ENABLED', original.webhookEnabled],
      ['LINE_CREDENTIAL_ENCRYPTION_KEY', original.encryptionKey], ['LINE_IDENTITY_HASH_KEY', original.identityHashKey],
      ['LINE_CHANNEL_SECRET', original.fallbackSecret]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const responses = [];
  const send = async (oaId, payload, secret, headers = {}) => {
    const raw = JSON.stringify(payload);
    const response = await app.inject({
      method: 'POST',
      url: `/api/webhooks/line/${oaId}`,
      headers: { 'content-type': 'application/json', 'x-line-signature': sign(raw, secret), ...headers },
      payload: raw
    });
    responses.push(response.body);
    return { response, raw };
  };

  const followPayload = {
    events: [{
      webhookEventId: 'wh-follow-1', type: 'follow', timestamp: 1730000000000,
      source: { userId, type: 'user' },
      message: { text: 'must not be stored' }
    }]
  };
  await pool.query(
    "insert into line_customers(workspace_id,oa_integration_id,attributed_invite_link_id,line_subject_hmac,display_name) values ($1,$2,$3,$4,'Webhook QA Customer')",
    [tenant.workspaceId, tenant.oaId, tenant.inviteLinkId, subjectHmac(userId)]
  );
  const follow = await send(tenant.oaId, followPayload, secretA);
  assert.equal(follow.response.statusCode, 200, follow.response.body);
  assert.deepEqual(follow.response.json(), { accepted: true, eventCount: 1, duplicates: 0 });

  const channel = (await pool.query('select status, verified_at from workspace_oa_channels where workspace_id=$1 and oa_integration_id=$2', [tenant.workspaceId, tenant.oaId])).rows[0];
  assert.equal(channel.status, 'VERIFIED');
  assert.ok(channel.verified_at);
  const audit = await pool.query("select action from audit_log where workspace_id=$1 and target_id=$2 order by created_at", [tenant.workspaceId, tenant.oaId]);
  assert.ok(audit.rows.some(row => row.action === 'OA_CHANNEL_VERIFIED'));

  const receipt = (await pool.query('select webhook_event_id, payload_hash from webhook_events where oa_integration_id=$1', [tenant.oaId])).rows[0];
  assert.equal(receipt.webhook_event_id, 'wh-follow-1');
  assert.match(receipt.payload_hash, /^[a-f0-9]{64}$/);
  assert.equal(receipt.payload_hash.includes(userId), false);

  const consent = (await pool.query('select opt_in, blocked_at from customers where workspace_id=$1 and provider_id=(select provider_id from oa_integrations where id=$2) and line_user_key=$3',
    [tenant.workspaceId, tenant.oaId, userId])).rows[0];
  assert.equal(consent.opt_in, true);
  assert.equal(consent.blocked_at, null);

  const followEvent = (await pool.query("select event_type, evidence_event_id from referral_attribution_events where workspace_id=$1 and oa_integration_id=$2", [tenant.workspaceId, tenant.oaId])).rows[0];
  assert.equal(followEvent.event_type, 'FOLLOW_VERIFIED');
  assert.equal(followEvent.evidence_event_id, 'wh-follow-1');

  const replay = await send(tenant.oaId, followPayload, secretA);
  assert.equal(replay.response.statusCode, 200);
  assert.equal(replay.response.json().duplicates, 1);
  assert.equal((await pool.query('select count(*)::int as count from webhook_events where oa_integration_id=$1', [tenant.oaId])).rows[0].count, 1);
  assert.equal((await pool.query("select count(*)::int as count from referral_attribution_events where workspace_id=$1 and oa_integration_id=$2 and event_type='FOLLOW_VERIFIED'", [tenant.workspaceId, tenant.oaId])).rows[0].count, 1);

  const wrongSecret = await send(tenant.oaId, { events: [{ webhookEventId: 'wh-wrong-1', type: 'message' }] }, secretB);
  assert.equal(wrongSecret.response.statusCode, 401);
  assert.equal((await pool.query("select count(*)::int as count from webhook_events where oa_integration_id=$1 and webhook_event_id='wh-wrong-1'", [tenant.oaId])).rows[0].count, 0);

  const noSecret = await send(tenant.unconfiguredOaId, { events: [{ webhookEventId: 'wh-fallback-1', type: 'message' }] }, envFallbackSecret);
  assert.equal(noSecret.response.statusCode, 503);
  assert.equal((await pool.query("select count(*)::int as count from webhook_events where oa_integration_id=$1", [tenant.unconfiguredOaId])).rows[0].count, 0);
  assert.equal((await pool.query('select status from workspace_oa_channels where workspace_id=$1 and oa_integration_id=$2', [tenant.workspaceId, tenant.unconfiguredOaId])).rows[0].status, 'VERIFY_PENDING');

  const malformed = await send(tenant.oaId, { events: [{ type: 'follow' }] }, secretA);
  assert.equal(malformed.response.statusCode, 400);

  const otherUser = 'U-webhook-qa-other';
  const otherEvent = await send(tenant.oaId, { events: [{ webhookEventId: 'wh-message-1', type: 'message', source: { userId: otherUser } }] }, secretA);
  assert.equal(otherEvent.response.statusCode, 200);
  assert.equal((await pool.query('select count(*)::int as count from customers where workspace_id=$1 and line_user_key=$2', [tenant.workspaceId, otherUser])).rows[0].count, 0);
  assert.equal((await pool.query("select count(*)::int as count from webhook_events where oa_integration_id=$1 and webhook_event_id='wh-message-1'", [tenant.oaId])).rows[0].count, 1);

  await pool.query("insert into workspace_controls(workspace_id,system_kill_switch,reason) values ($1,true,'kill switch drill') on conflict (workspace_id) do update set system_kill_switch=true", [tenant.workspaceId]);
  await pool.query('update oa_integrations set kill_switch=true, kill_switch_reason=$2 where id=$1', [tenant.oaId, 'kill switch drill']);
  const unfollow = await send(tenant.oaId, { events: [{ webhookEventId: 'wh-unfollow-1', type: 'unfollow', source: { userId } }] }, secretA);
  assert.equal(unfollow.response.statusCode, 200, unfollow.response.body);
  const blocked = (await pool.query('select opt_in, blocked_at from customers where workspace_id=$1 and line_user_key=$2', [tenant.workspaceId, userId])).rows[0];
  assert.equal(blocked.opt_in, false);
  assert.ok(blocked.blocked_at);

  const oversized = await app.inject({
    method: 'POST',
    url: `/api/webhooks/line/${tenant.oaId}`,
    headers: { 'content-type': 'application/json', 'x-line-signature': 'ignored' },
    payload: JSON.stringify({ events: [{ webhookEventId: 'wh-large-1', type: 'message', source: { userId: 'x'.repeat(110 * 1024) } }] })
  });
  assert.equal(oversized.statusCode, 413);

  for (const body of responses) {
    assert.equal(body.includes(secretA), false);
    assert.equal(body.includes(secretB), false);
    assert.equal(body.includes(envFallbackSecret), false);
    assert.equal(body.includes(identityKey), false);
  }
  const sealed = (await pool.query('select secret_sealed from oa_credential_vault where oa_integration_id=$1', [tenant.oaId])).rows[0].secret_sealed;
  assert.notEqual(sealed, secretA);
  assert.match(sealed, /^v1\./);
});
