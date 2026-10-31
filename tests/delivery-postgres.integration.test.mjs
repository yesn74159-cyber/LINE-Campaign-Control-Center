import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../dist/api/migrate.js';
import { createPostgresRepository } from '../dist/api/repository.js';
import { sealOaSecret, resolveOaAccessToken } from '../dist/api/lineOaConnect.js';
import { buildDeliveryPayload } from '../dist/api/livePushPayload.js';
import { LiveLineMessagingAdapter, ProviderTransportError } from '../dist/api/lineAdapter.js';
import { runWorkerOnce } from '../dist/api/worker.js';

const vaultKey = randomBytes(32);
const tokenValue = 'qa-live-access-token-value';
const optedInUserIds = [1, 2, 3].map((index) => `U${String(index).padStart(32, 'a')}`);
const blockedUserId = `U${'b'.repeat(32)}`;
const optedOutUserId = `U${'c'.repeat(32)}`;
const flex = (altText) => ({
  type: 'flex',
  altText,
  contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } }
});

let pool;
let repository;
let skipReason;

function requireDisposableLocalDatabaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'delivery integration tests may only connect to loopback');
  assert.match(decodeURIComponent(url.pathname.slice(1)), /^line_ccc_delivery_qa_[a-z0-9_]+$/, 'database name must use the dedicated line_ccc_delivery_qa_ prefix');
  return value;
}

async function seedTenant(targetPool, suffix) {
  const workspaceId = (await targetPool.query("insert into workspaces(name,mode) values ($1,'DRY_RUN') returning id", [`Delivery QA ${suffix}`])).rows[0].id;
  const secondWorkspaceId = (await targetPool.query("insert into workspaces(name,mode) values ($1,'DRY_RUN') returning id", [`Delivery QA other ${suffix}`])).rows[0].id;
  const campaignId = (await targetPool.query(
    "insert into campaigns(workspace_id,slug,name,title,description,image,cta,flex_file,active) values ($1,'welcome','Welcome','Welcome','QA','','','flex/welcome.json',true) returning id",
    [workspaceId]
  )).rows[0].id;
  const revisionOneId = (await targetPool.query(
    "insert into campaign_revisions(campaign_id,revision,flex_json,state,created_by) values ($1,1,$2::jsonb,'PUBLISHED','qa') returning id",
    [campaignId, JSON.stringify(flex('revision one'))]
  )).rows[0].id;
  await targetPool.query(
    "insert into campaign_controls(workspace_id,campaign_id,approval_status,validated_at,validated_by,approved_at,approved_by) values ($1,$2,'APPROVED',now(),'qa',now(),'qa')",
    [workspaceId, campaignId]
  );
  const oaId = (await targetPool.query(
    "insert into oa_integrations(workspace_id,provider_id,basic_id,display_name,environment,enabled,quota_per_minute,monthly_quota,connection_status) values ($1,'qa-provider','@deliveryqa','Delivery QA OA','STAGING',true,5,10,'DRY_RUN_READY') returning id",
    [workspaceId]
  )).rows[0].id;
  const quotaOaId = (await targetPool.query(
    "insert into oa_integrations(workspace_id,provider_id,basic_id,display_name,environment,enabled,quota_per_minute,monthly_quota,connection_status) values ($1,'qa-quota-provider','@deliveryquota','Delivery QA quota','STAGING',true,2,10,'DRY_RUN_READY') returning id",
    [workspaceId]
  )).rows[0].id;
  const monthlyOaId = (await targetPool.query(
    "insert into oa_integrations(workspace_id,provider_id,basic_id,display_name,environment,enabled,quota_per_minute,monthly_quota,monthly_used,connection_status) values ($1,'qa-monthly-provider','@deliverymonthly','Delivery QA monthly','STAGING',true,5,1,1,'DRY_RUN_READY') returning id",
    [workspaceId]
  )).rows[0].id;
  await targetPool.query(
    'insert into oa_credential_vault(workspace_id,oa_integration_id,token_sealed,secret_sealed,bot_basic_id,access_token_checked_at) values ($1,$2,$3,$4,$5,now())',
    [workspaceId, oaId, sealOaSecret(tokenValue, workspaceId, oaId, 'token', vaultKey), sealOaSecret('s'.repeat(32), workspaceId, oaId, 'secret', vaultKey), '@deliveryqa']
  );
  for (const userId of optedInUserIds) await targetPool.query("insert into customers(workspace_id,provider_id,line_user_key,opt_in) values ($1,'qa-provider',$2,true)", [workspaceId, userId]);
  await targetPool.query("insert into customers(workspace_id,provider_id,line_user_key,opt_in,blocked_at) values ($1,'qa-provider',$2,false,now())", [workspaceId, blockedUserId]);
  await targetPool.query("insert into customers(workspace_id,provider_id,line_user_key,opt_in) values ($1,'qa-provider',$2,false)", [workspaceId, optedOutUserId]);
  return { workspaceId, secondWorkspaceId, campaignId, revisionOneId, oaId, quotaOaId, monthlyOaId };
}

async function createScheduledJob(tenant, now) {
  return repository.addJob({
    campaignId: 'welcome', oaId: tenant.oaId,
    scheduledAt: new Date(now.getTime() - 5_000).toISOString(),
    timeZone: 'Asia/Bangkok', status: 'SCHEDULED',
    workspaceId: tenant.workspaceId, actor: 'qa@delivery.invalid'
  });
}

function skipWithoutDatabase(t) {
  if (pool) return false;
  if (process.env.CI === 'true') throw new Error('DELIVERY_TEST_DATABASE_URL is required in CI; refusing to skip PostgreSQL integration');
  t.skip(skipReason || 'DELIVERY_TEST_DATABASE_URL is not set; no database is touched');
  return true;
}

before(async () => {
  const connectionString = requireDisposableLocalDatabaseUrl(process.env.DELIVERY_TEST_DATABASE_URL);
  if (!connectionString) {
    skipReason = 'DELIVERY_TEST_DATABASE_URL is not set; no database is touched';
    return;
  }
  pool = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 4000 });
  const identity = await pool.query('select current_database() as database_name, inet_server_addr()::text as address');
  assert.match(identity.rows[0].database_name, /^line_ccc_delivery_qa_[a-z0-9_]+$/);
  const serverAddress = identity.rows[0].address?.replace(/\/\d+$/, '');
  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(serverAddress), `unexpected PostgreSQL server address: ${identity.rows[0].address}`);
  assert.equal((await pool.query("select to_regclass('public.schema_migrations') as ledger")).rows[0].ledger, null, 'integration target must be a fresh disposable database');
  await runMigrations(pool);
  repository = createPostgresRepository(pool);
});

after(async () => { await pool?.end(); });

test('PostgreSQL delivery pipeline keeps the frozen revision, filters consent, and reconciles UNKNOWN deliveries', async (t) => {
  if (skipWithoutDatabase(t)) return;
  const tenant = await seedTenant(pool, `p_${Date.now()}`);
  const now = new Date();
  const job = await createScheduledJob(tenant, now);
  assert.equal(job.campaignRevisionId, tenant.revisionOneId);
  await pool.query(
    "insert into campaign_revisions(campaign_id,revision,flex_json,state,created_by) values ($1,2,$2::jsonb,'PUBLISHED','qa')",
    [tenant.campaignId, JSON.stringify(flex('revision two'))]
  );

  const captured = [];
  const outcome = await runWorkerOnce(repository, {
    kind: 'mock',
    async send(input) {
      captured.push(input);
      return { dryRun: true, outbound: false, idempotencyKey: input.delivery.lineRetryKey, providerStatus: 200, providerRequestId: 'qa-mock' };
    }
  }, { jobId: job.id, workerId: 'qa-worker', now });
  assert.equal(outcome.status, 'completed');
  assert.equal(captured.length, 3, 'only opted-in customers are delivered');
  assert.deepEqual(captured.map((item) => item.payload.to).sort(), [...optedInUserIds].sort());
  assert.ok(captured.every((item) => item.payload.messages[0].altText === 'revision one'), 'the job must use the frozen revision');
  assert.ok(captured.every((item) => item.delivery.lineRetryKey === item.delivery.idempotencyKey));
  assert.equal(new Set(captured.map((item) => item.delivery.idempotencyKey)).size, 3);

  const outbox = await repository.listOutbox(tenant.workspaceId, job.id);
  assert.equal(outbox.length, 3);
  assert.ok(outbox.every((item) => item.status === 'SENT' && item.providerStatus === 200));
  assert.ok(outbox.every((item) => item.recipientKey !== blockedUserId && item.recipientKey !== optedOutUserId));

  const untouched = await pool.query('select monthly_used from oa_integrations where id=$1', [tenant.oaId]);
  assert.equal(untouched.rows[0].monthly_used, 0, 'DRY_RUN reservations must not consume the live monthly quota');
  assert.equal((await pool.query('select count(*)::int as count from oa_rate_limit_windows where oa_integration_id=$1', [tenant.oaId])).rows[0].count, 0);
  assert.equal((await pool.query("select count(*)::int as count from audit_log where workspace_id=$1 and action='WORKER_COMPLETED'", [tenant.workspaceId])).rows[0].count, 1);

  const uncertainJob = await createScheduledJob(tenant, now);
  const uncertain = await runWorkerOnce(repository, {
    kind: 'mock',
    async send() { throw new ProviderTransportError(503, true, true, 'PROVIDER_SERVER_ERROR', 'qa-uncertain'); }
  }, { jobId: uncertainJob.id, workerId: 'qa-worker-uncertain', now });
  assert.equal(uncertain.status, 'failed');
  const afterUncertain = await repository.listOutbox(tenant.workspaceId, uncertainJob.id);
  assert.equal(afterUncertain.filter((item) => item.status === 'UNKNOWN').length, 1);
  assert.equal(afterUncertain.filter((item) => item.status === 'PENDING').length, 2);
  assert.equal((await pool.query('select status from scheduler_jobs where id=$1', [uncertainJob.id])).rows[0].status, 'FAILED');
  const unknownDelivery = afterUncertain.find((item) => item.status === 'UNKNOWN');
  const pendingDeliveries = afterUncertain.filter((item) => item.status === 'PENDING');

  await assert.rejects(() => repository.reconcileOutboxDelivery({ jobId: uncertainJob.id, deliveryId: unknownDelivery.id, workspaceId: tenant.secondWorkspaceId, status: 'SENT', actor: 'qa@delivery.invalid' }), /only UNKNOWN deliveries/);
  const reconciled = await repository.reconcileOutboxDelivery({ jobId: uncertainJob.id, deliveryId: unknownDelivery.id, workspaceId: tenant.workspaceId, status: 'SENT', actor: 'qa@delivery.invalid' });
  assert.equal(reconciled.status, 'SENT');
  await assert.rejects(() => repository.reconcileOutboxDelivery({ jobId: uncertainJob.id, deliveryId: unknownDelivery.id, workspaceId: tenant.workspaceId, status: 'FAILED', actor: 'qa@delivery.invalid' }), /only UNKNOWN deliveries/);
  assert.equal((await pool.query("select count(*)::int as count from audit_log where workspace_id=$1 and action='OUTBOX_RECONCILED'", [tenant.workspaceId])).rows[0].count, 1);

  await repository.retryJob(uncertainJob.id, 'qa@delivery.invalid', tenant.workspaceId);
  const recovered = [];
  const secondOutcome = await runWorkerOnce(repository, {
    kind: 'mock',
    async send(input) { recovered.push(input.delivery.recipientKey); return { dryRun: true, outbound: false, idempotencyKey: input.delivery.lineRetryKey, providerStatus: 200 }; }
  }, { jobId: uncertainJob.id, workerId: 'qa-worker-recovered', now: new Date() });
  assert.equal(secondOutcome.status, 'completed');
  assert.deepEqual(recovered.sort(), pendingDeliveries.map((item) => item.recipientKey).sort());
  const finalOutbox = await repository.listOutbox(tenant.workspaceId, uncertainJob.id);
  assert.equal(finalOutbox.filter((item) => item.status === 'SENT').length, 3);
});

test('quota reservations are atomic, per-minute, and released without underflow', async (t) => {
  if (skipWithoutDatabase(t)) return;
  const tenant = await seedTenant(pool, `q_${Date.now()}`);
  const now = new Date('2026-11-01T10:00:00.000Z');

  const results = await Promise.allSettled(Array.from({ length: 5 }, () => repository.reserveDeliverySlot({ workspaceId: tenant.workspaceId, oaId: tenant.quotaOaId, count: true, now })));
  const fulfilled = results.filter((item) => item.status === 'fulfilled');
  const rejected = results.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, 2, 'quota_per_minute=2 must allow exactly two reservations');
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((item) => item.reason?.code === 'RATE_LIMITED'));
  assert.ok(fulfilled.every((item) => item.value.counted === true && item.value.windowStartedAt === '2026-11-01T10:00:00.000Z'));

  assert.equal((await pool.query('select monthly_used from oa_integrations where id=$1', [tenant.quotaOaId])).rows[0].monthly_used, 2);
  assert.equal((await pool.query('select used_count from oa_rate_limit_windows where oa_integration_id=$1 and window_started_at=$2', [tenant.quotaOaId, '2026-11-01T10:00:00.000Z'])).rows[0].used_count, 2);

  await repository.releaseDeliverySlot({ workspaceId: tenant.workspaceId, oaId: tenant.quotaOaId, windowStartedAt: fulfilled[0].value.windowStartedAt });
  assert.equal((await pool.query('select monthly_used from oa_integrations where id=$1', [tenant.quotaOaId])).rows[0].monthly_used, 1);
  assert.equal((await pool.query('select used_count from oa_rate_limit_windows where oa_integration_id=$1 and window_started_at=$2', [tenant.quotaOaId, '2026-11-01T10:00:00.000Z'])).rows[0].used_count, 1);
  await repository.releaseDeliverySlot({ workspaceId: tenant.workspaceId, oaId: tenant.quotaOaId, windowStartedAt: fulfilled[0].value.windowStartedAt });
  await repository.releaseDeliverySlot({ workspaceId: tenant.workspaceId, oaId: tenant.quotaOaId, windowStartedAt: fulfilled[0].value.windowStartedAt });
  assert.equal((await pool.query('select monthly_used from oa_integrations where id=$1', [tenant.quotaOaId])).rows[0].monthly_used, 0);
  assert.equal((await pool.query('select used_count from oa_rate_limit_windows where oa_integration_id=$1 and window_started_at=$2', [tenant.quotaOaId, '2026-11-01T10:00:00.000Z'])).rows[0].used_count, 0);

  await assert.rejects(
    () => repository.reserveDeliverySlot({ workspaceId: tenant.workspaceId, oaId: tenant.monthlyOaId, count: false, now }),
    (error) => error.code === 'QUOTA_EXCEEDED'
  );
});

test('live adapter contract resolves the vault token and sends once through a fake HTTP transport', async (t) => {
  if (skipWithoutDatabase(t)) return;
  const tenant = await seedTenant(pool, `l_${Date.now()}`);
  const sentBuffer = await resolveOaAccessToken(pool, { workspaceId: tenant.workspaceId, oaId: tenant.oaId, key: vaultKey });
  assert.equal(sentBuffer.toString('utf8'), tokenValue);

  const requests = [];
  const transport = { kind: 'http', async send(input) { requests.push(structuredClone(input)); return { status: 200, requestId: 'qa-http' }; } };
  const adapter = new LiveLineMessagingAdapter(transport, async () => sentBuffer, undefined, { appMode: 'LIVE', liveEnabled: true });
  const now = new Date();
  const delivery = { id: 'qa-delivery', workspaceId: tenant.workspaceId, jobId: 'qa-live-job', oaId: tenant.oaId, recipientKey: optedInUserIds[0], idempotencyKey: 'qa-idem', lineRetryKey: 'qa-retry', status: 'PENDING', attempts: 0, createdAt: '', updatedAt: '' };
  const result = await adapter.send({
    job: { id: 'qa-live-job', workspaceId: tenant.workspaceId, campaignId: 'welcome', campaignRevisionId: tenant.revisionOneId, oaId: tenant.oaId, scheduledAt: now.toISOString(), timeZone: 'Asia/Bangkok', mode: 'LIVE', status: 'SCHEDULED', attempts: 0, idempotencyKey: 'qa-idem', createdAt: now.toISOString() },
    delivery,
    payload: buildDeliveryPayload({ recipientKey: optedInUserIds[0], flexMessage: flex('live revision') })
  });
  assert.deepEqual(result, { dryRun: false, outbound: true, idempotencyKey: 'qa-retry', providerStatus: 200, providerRequestId: 'qa-http' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].endpoint, 'https://api.line.me/v2/bot/message/push');
  assert.equal(requests[0].token, tokenValue);
  assert.equal(requests[0].retryKey, 'qa-retry');
  assert.deepEqual(requests[0].body, { to: optedInUserIds[0], messages: [flex('live revision')] });
  assert.ok(sentBuffer.every((byte) => byte === 0), 'the decrypted token buffer must be zeroized');
  assert.equal((await pool.query('select count(*)::int as count from outbox_deliveries where workspace_id=$1', [tenant.workspaceId])).rows[0].count, 0);
});
