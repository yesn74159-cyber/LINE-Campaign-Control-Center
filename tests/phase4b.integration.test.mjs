import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import pg from 'pg';

const base = 'http://127.0.0.1:8793';
const adminPassword = process.env.STAGING_ADMIN_PASSWORD;
const viewerPassword = process.env.STAGING_VIEWER_PASSWORD;
if (!adminPassword || !viewerPassword) throw new Error('Staging admin and viewer passwords are required; fixed credentials are not allowed');

function client() {
  let cookie = '';
  let csrf = '';
  let sessionCookie = '';
  return {
    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (cookie) headers.cookie = cookie;
      if (csrf && (options.method || 'GET') !== 'GET') headers['x-csrf-token'] = csrf;
      const response = await fetch(`${base}${path}`, { ...options, headers });
      for (const value of response.headers.getSetCookie?.() || []) {
        const session = value.match(/^ccc_session=([^;]+)/)?.[1];
        const nextCsrf = value.match(/^ccc_csrf=([^;]+)/)?.[1];
        if (session) sessionCookie = `ccc_session=${session}`;
        if (nextCsrf) csrf = nextCsrf;
      }
      if (sessionCookie && csrf) cookie = `${sessionCookie}; ccc_csrf=${csrf}`;
      else if (sessionCookie) cookie = sessionCookie;
      const body = await response.json().catch(() => ({}));
      return { response, body };
    }
  };
}

let child;
let admin;
let viewer;
let enabledOa;

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Phase 4B API did not become healthy');
}

async function login(api, email, password) {
  const result = await api.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
}

async function createDueJob(api) {
  const created = await api.request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignId: 'welcome', oaId: enabledOa, scheduledAt: new Date(Date.now() - 5_000).toISOString(), timeZone: 'Asia/Bangkok', status: 'DRAFT' }) });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const scheduled = await api.request(`/api/scheduler/jobs/${created.body.id}/schedule`, { method: 'POST' });
  assert.equal(scheduled.response.status, 200, JSON.stringify(scheduled.body));
  return scheduled.body;
}

before(async () => {
  child = spawn(process.execPath, ['dist/api/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '8793', PERSISTENCE: 'postgres', APP_MODE: 'DRY_RUN', LINE_LIVE_ENABLED: 'false', LINE_WEBHOOK_ENABLED: 'false' }, stdio: 'ignore' });
  await waitForHealth();
  admin = client();
  viewer = client();
  await login(admin, process.env.STAGING_ADMIN_EMAIL || 'admin@staging.local', adminPassword);
  await login(viewer, process.env.STAGING_VIEWER_EMAIL || 'viewer@staging.local', viewerPassword);
  const oas = await admin.request('/api/oas');
  enabledOa = oas.body.oas.find((oa) => oa.enabled && oa.environment === 'STAGING')?.id;
  assert.ok(enabledOa);
});

after(async () => {
  await admin?.request('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4B test cleanup' }) }).catch(() => undefined);
  await admin?.request(`/api/oas/${enabledOa}/kill-switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4B test cleanup' }) }).catch(() => undefined);
  await admin?.request(`/api/oas/${enabledOa}/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }).catch(() => undefined);
  child?.kill();
});

test('outbox ledger is durable and idempotent across a second worker run', async () => {
  const job = await createDueJob(admin);
  const { createPostgresRepository } = await import('../dist/api/repository.js');
  const { MockLineMessagingAdapter } = await import('../dist/api/lineAdapter.js');
  const { runWorkerOnce } = await import('../dist/api/worker.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const adapter = new MockLineMessagingAdapter();
    const repo = createPostgresRepository(pool);
    await assert.rejects(() => repo.prepareOutbox(job.id, 'not-the-claiming-worker'), /no longer owned/);
    const first = await runWorkerOnce(repo, adapter, { workerId: `phase4b-ledger-a-${Date.now()}`, jobId: job.id });
    const second = await runWorkerOnce(repo, adapter, { workerId: `phase4b-ledger-b-${Date.now()}`, jobId: job.id });
    const deliveries = await repo.listOutbox(undefined, job.id);
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'idle');
    assert.ok(deliveries.length >= 1);
    assert.ok(deliveries.every((delivery) => delivery.status === 'SENT' && delivery.attempts === 1));
    assert.equal(adapter.transport.requests.length, deliveries.length);
    assert.deepEqual(adapter.transport.requests.map((request) => request.retryKey).sort(), deliveries.map((delivery) => delivery.lineRetryKey).sort());
  } finally { await pool.end(); }
});

test('stale worker lease recovers the matching SENDING outbox row', async () => {
  const job = await createDueJob(admin);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("update scheduler_jobs set status='SENDING', claimed_at=now()-interval '10 minutes', claimed_by='crashed-worker' where id=$1", [job.id]);
    await pool.query("insert into outbox_deliveries(workspace_id,scheduler_job_id,oa_integration_id,recipient_key,idempotency_key,line_retry_key,status,attempts,claimed_by,claimed_at) select workspace_id,id,oa_integration_id,'__recovery__',gen_random_uuid(),gen_random_uuid(),'SENDING',1,'crashed-worker',now()-interval '10 minutes' from scheduler_jobs where id=$1", [job.id]);
    const { createPostgresRepository } = await import('../dist/api/repository.js');
    const { MockLineMessagingAdapter } = await import('../dist/api/lineAdapter.js');
    const { runWorkerOnce } = await import('../dist/api/worker.js');
    const repo = createPostgresRepository(pool);
    const result = await runWorkerOnce(repo, new MockLineMessagingAdapter(), { workerId: `phase4b-recovery-${Date.now()}`, jobId: job.id });
    const deliveries = await repo.listOutbox(undefined, job.id);
    assert.equal(result.status, 'completed');
    assert.ok(deliveries.every((delivery) => delivery.status === 'SENT'));
    assert.ok(deliveries.some((delivery) => delivery.recipientKey === '__recovery__' && delivery.attempts === 2));
  } finally { await pool.end(); }
});

test('system kill switch and disabled OA stop delivery before transport', async () => {
  const job = await createDueJob(admin);
    const { createPostgresRepository } = await import('../dist/api/repository.js');
    const { runWorkerOnce } = await import('../dist/api/worker.js');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const repo = createPostgresRepository(pool);
    assert.ok(job.workspaceId, JSON.stringify(job));
    const adapter = { kind: 'mock', calls: 0, async send() { this.calls += 1; return { dryRun: true, outbound: false, idempotencyKey: job.idempotencyKey, providerStatus: 200 }; } };
    const systemStop = await admin.request('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, reason: 'Phase 4B pre-transport stop test' }) });
    assert.equal(systemStop.response.status, 200, JSON.stringify(systemStop.body));
    const readiness = await admin.request(`/api/campaigns/welcome/readiness?oaId=${encodeURIComponent(enabledOa)}`);
    assert.equal(readiness.response.status, 200, JSON.stringify(readiness.body));
    assert.equal(readiness.body.systemKillSwitch, true, JSON.stringify(readiness.body));
    const repositoryReadiness = await repo.getCampaignReadiness(job.campaignId, job.workspaceId, job.oaId);
    assert.equal(repositoryReadiness.systemKillSwitch, true, JSON.stringify(repositoryReadiness));
    const stopped = await runWorkerOnce(repo, adapter, { workerId: `phase4b-system-stop-${Date.now()}`, jobId: job.id });
    assert.equal(stopped.status, 'failed');
    assert.equal(adapter.calls, 0);
    await admin.request('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4B pre-transport stop cleanup' }) });

    const secondJob = await createDueJob(admin);
    const disabled = await admin.request(`/api/oas/${enabledOa}/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    assert.equal(disabled.response.status, 200, JSON.stringify(disabled.body));
    const disabledReadiness = await admin.request(`/api/campaigns/welcome/readiness?oaId=${encodeURIComponent(enabledOa)}`);
    assert.equal(disabledReadiness.body.canSchedule, false, JSON.stringify(disabledReadiness.body));
    const oaStopped = await runWorkerOnce(repo, adapter, { workerId: `phase4b-oa-stop-${Date.now()}`, jobId: secondJob.id });
    assert.equal(oaStopped.status, 'failed');
    assert.equal(adapter.calls, 0);
  } finally { await admin.request(`/api/oas/${enabledOa}/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }); await pool.end(); }
});

test('policy is rechecked immediately before transport', async () => {
  const job = await createDueJob(admin);
  const { createPostgresRepository } = await import('../dist/api/repository.js');
  const { runWorkerOnce } = await import('../dist/api/worker.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let calls = 0;
  try {
    const repo = createPostgresRepository(pool);
    const guardedRepo = Object.create(repo);
    guardedRepo.markOutboxSending = async (...args) => {
      const result = await repo.markOutboxSending(...args);
      const stopped = await admin.request('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, reason: 'Phase 4B race-window test' }) });
      assert.equal(stopped.response.status, 200, JSON.stringify(stopped.body));
      return result;
    };
    const adapter = { kind: 'mock', async send() { calls += 1; return { dryRun: true, outbound: false, idempotencyKey: job.idempotencyKey, providerStatus: 200 }; } };
    const result = await runWorkerOnce(guardedRepo, adapter, { workerId: `phase4b-policy-race-${Date.now()}`, jobId: job.id });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 0);
  } finally {
    await admin.request('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4B race-window cleanup' }) });
    await pool.end();
  }
});

test('retryable provider failure reuses one outbox delivery and uncertain failure is not retried', async () => {
  const { createPostgresRepository } = await import('../dist/api/repository.js');
  const { ProviderTransportError } = await import('../dist/api/lineAdapter.js');
  const { runWorkerOnce } = await import('../dist/api/worker.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const job = await createDueJob(admin);
    const repo = createPostgresRepository(pool);
    let calls = 0;
    const retryAdapter = { kind: 'mock', async send() { calls += 1; if (calls === 1) throw new ProviderTransportError(429, true, false, 'PROVIDER_RATE_LIMITED', 'mock-429', 1); return { dryRun: true, outbound: false, idempotencyKey: job.idempotencyKey, providerStatus: 200, providerRequestId: 'mock-ok' }; } };
    const first = await runWorkerOnce(repo, retryAdapter, { workerId: `phase4b-retry-a-${Date.now()}`, jobId: job.id, retryBaseMs: 1 });
    assert.equal(first.status, 'retryable');
    const second = await runWorkerOnce(repo, retryAdapter, { workerId: `phase4b-retry-b-${Date.now()}`, jobId: job.id, now: new Date(Date.now() + 10), retryBaseMs: 1 });
    assert.equal(second.status, 'completed');
    const deliveries = await repo.listOutbox(undefined, job.id);
    assert.ok(deliveries.length >= 1);
    assert.ok(deliveries.every((delivery) => delivery.status === 'SENT'));
    assert.equal(deliveries.filter((delivery) => delivery.attempts === 2).length, 1);
    assert.equal(deliveries.filter((delivery) => delivery.attempts === 1).length, deliveries.length - 1);
    assert.equal(calls, deliveries.length + 1);

    const uncertainJob = await createDueJob(admin);
    const uncertain = { kind: 'mock', async send() { throw new ProviderTransportError(503, true, true, 'PROVIDER_SERVER_ERROR', 'mock-503'); } };
    const uncertainResult = await runWorkerOnce(repo, uncertain, { workerId: `phase4b-unknown-${Date.now()}`, jobId: uncertainJob.id, maxAttempts: 3 });
    assert.equal(uncertainResult.status, 'failed');
    const uncertainDeliveries = await repo.listOutbox(undefined, uncertainJob.id);
    assert.equal(uncertainDeliveries[0].status, 'UNKNOWN');
  } finally { await pool.end(); }
});

test('viewer cannot manage OA state and outbox is workspace-filtered', async () => {
  const forbidden = await viewer.request(`/api/oas/${enabledOa}/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(forbidden.response.status, 403);
  const job = await createDueJob(admin);
  const listed = await admin.request(`/api/scheduler/jobs/${job.id}/outbox`);
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.deliveries, []);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { createPostgresRepository } = await import('../dist/api/repository.js');
    assert.deepEqual(await createPostgresRepository(pool).listOutbox('00000000-0000-0000-0000-000000000000', job.id), []);
    const mismatch = await pool.query('select id from oa_integrations where workspace_id=(select workspace_id from scheduler_jobs where id=$1) and id<>$2 limit 1', [job.id, enabledOa]);
    assert.ok(mismatch.rows[0]);
    await assert.rejects(() => pool.query("insert into outbox_deliveries(workspace_id,scheduler_job_id,oa_integration_id,recipient_key,idempotency_key,line_retry_key) select workspace_id,id,$2,'__wrong-oa__',gen_random_uuid(),gen_random_uuid() from scheduler_jobs where id=$1", [job.id, mismatch.rows[0].id]), /workspace|OA/);
  } finally { await pool.end(); }
});
