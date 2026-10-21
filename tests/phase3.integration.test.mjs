import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import pg from 'pg';

const base = 'http://127.0.0.1:8791';
const password = process.env.STAGING_ADMIN_PASSWORD;
if (!password) throw new Error('STAGING_ADMIN_PASSWORD is required; fixed staging credentials are not allowed');
let child;
let cookie = '';
let csrf = '';
let sessionCookie = '';
let enabledOa;

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) { try { const response = await fetch(`${base}/health`); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error('Phase 3 API did not become healthy');
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (csrf && (options.method || 'GET') !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const setCookies = response.headers.getSetCookie?.() || [];
  for (const value of setCookies) {
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

async function createJob(status = 'SCHEDULED', scheduledAt = new Date(Date.now() + 3_600_000).toISOString()) {
  const result = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignId: 'welcome', oaId: enabledOa, scheduledAt, timeZone: 'Asia/Bangkok', status }) });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body;
}

before(async () => {
  child = spawn(process.execPath, ['dist/api/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '8791', PERSISTENCE: 'postgres', APP_MODE: 'DRY_RUN', LINE_WEBHOOK_ENABLED: 'false' }, stdio: 'ignore' });
  await waitForHealth();
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.STAGING_ADMIN_EMAIL || 'admin@staging.local', password }) });
  assert.equal(login.response.status, 200);
  const oas = await request('/api/oas');
  enabledOa = oas.body.oas.find((oa) => oa.enabled && oa.environment === 'STAGING')?.id;
  assert.ok(enabledOa);
});

after(() => child?.kill());

test('scheduler validation blocks invalid timezone and disabled OA, then creates and schedules a draft', async () => {
  const invalidZone = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignId: 'welcome', oaId: enabledOa, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'UTC' }) });
  assert.equal(invalidZone.response.status, 400);
  const disabledOa = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignId: 'welcome', oaId: 'oa-staging-secondary', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'Asia/Bangkok' }) });
  assert.equal(disabledOa.response.status, 400);
  const draft = await createJob('DRAFT');
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.timeZone, 'Asia/Bangkok');
  const scheduled = await request(`/api/scheduler/jobs/${draft.id}/schedule`, { method: 'POST' });
  assert.equal(scheduled.response.status, 200);
  assert.equal(scheduled.body.status, 'SCHEDULED');
});

test('automation transitions support pause, resume, cancel and preserve DRY_RUN', async () => {
  const job = await createJob('SCHEDULED');
  const paused = await request(`/api/scheduler/jobs/${job.id}/pause`, { method: 'POST' });
  assert.equal(paused.body.status, 'PAUSED');
  const resumed = await request(`/api/scheduler/jobs/${job.id}/resume`, { method: 'POST' });
  assert.equal(resumed.body.status, 'SCHEDULED');
  const cancelled = await request(`/api/scheduler/jobs/${job.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.body.status, 'CANCELLED');
  assert.equal(cancelled.body.mode, 'DRY_RUN');
});

test('worker claims a due PostgreSQL job, uses Mock adapter, completes and audits it', async () => {
  const job = await createJob('DRAFT', new Date(Date.now() - 5_000).toISOString());
  const scheduled = await request(`/api/scheduler/jobs/${job.id}/schedule`, { method: 'POST' });
  assert.equal(scheduled.body.status, 'SCHEDULED');
  const { createPostgresRepository } = await import('../dist/api/repository.js');
  const { MockLineMessagingAdapter } = await import('../dist/api/lineAdapter.js');
  const { runWorkerOnce } = await import('../dist/api/worker.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const repo = createPostgresRepository(pool);
    const result = await runWorkerOnce(repo, new MockLineMessagingAdapter(), { workerId: `phase3-complete-${Date.now()}`, jobId: job.id });
    assert.equal(result.status, 'completed');
    assert.equal(result.job.id, job.id);
    assert.equal(result.job.status, 'COMPLETED');
    const audit = await request('/api/audit');
    assert.ok(audit.body.events.some((event) => event.target === job.id && event.action === 'WORKER_COMPLETED'));
  } finally { await pool.end(); }
});

test('completed job is idempotent across a second worker run', async () => {
  const { createPostgresRepository } = await import('../dist/api/repository.js');
  const { MockLineMessagingAdapter } = await import('../dist/api/lineAdapter.js');
  const { runWorkerOnce } = await import('../dist/api/worker.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const job = await createJob('DRAFT', new Date(Date.now() - 5_000).toISOString());
    await request(`/api/scheduler/jobs/${job.id}/schedule`, { method: 'POST' });
    const repo = createPostgresRepository(pool);
    const adapter = new MockLineMessagingAdapter();
    const first = await runWorkerOnce(repo, adapter, { workerId: `phase3-idempotent-${Date.now()}`, jobId: job.id });
    const result = await runWorkerOnce(repo, adapter, { workerId: `phase3-idle-${Date.now()}`, jobId: job.id });
    assert.equal(first.status, 'completed');
    assert.equal(result.status, 'idle');
  } finally { await pool.end(); }
});

test('worker retry uses exponential backoff and reaches FAILED after max attempts', async () => {
  const { createPostgresRepository } = await import('../dist/api/repository.js');
  const { runWorkerOnce } = await import('../dist/api/worker.js');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const now = new Date();
    const job = await createJob('DRAFT', new Date(now.getTime() - 5_000).toISOString());
    await request(`/api/scheduler/jobs/${job.id}/schedule`, { method: 'POST' });
    const repo = createPostgresRepository(pool);
    const failingAdapter = { async send() { throw new Error('simulated staging adapter failure'); } };
    const first = await runWorkerOnce(repo, failingAdapter, { workerId: `phase35-retry-a-${Date.now()}`, jobId: job.id, now, maxAttempts: 2, retryBaseMs: 1_000 });
    assert.equal(first.status, 'retryable');
    assert.equal(first.job.status, 'RETRYABLE');
    assert.equal(first.job.idempotencyKey, job.idempotencyKey);
    assert.ok(new Date(first.job.availableAt).getTime() >= now.getTime() + 900, `${first.job.availableAt} must be at least 900ms after ${now.toISOString()}`);
    const second = await runWorkerOnce(repo, failingAdapter, { workerId: `phase35-retry-b-${Date.now()}`, jobId: job.id, now: new Date(now.getTime() + 2_000), maxAttempts: 2, retryBaseMs: 1_000 });
    assert.equal(second.status, 'failed');
    assert.equal(second.job.status, 'FAILED');
    assert.match(second.job.lastError, /simulated staging adapter failure/);
  } finally { await pool.end(); }
});

test('two workers cannot claim the same due job', async () => {
  const job = await createJob('DRAFT', new Date(Date.now() - 5_000).toISOString());
  const scheduled = await request(`/api/scheduler/jobs/${job.id}/schedule`, { method: 'POST' });
  assert.equal(scheduled.body.status, 'SCHEDULED');
  const { createPostgresRepository } = await import('../dist/api/repository.js');
  const { MockLineMessagingAdapter } = await import('../dist/api/lineAdapter.js');
  const { runWorkerOnce } = await import('../dist/api/worker.js');
  const poolA = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const poolB = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const [a, b] = await Promise.all([
      runWorkerOnce(createPostgresRepository(poolA), new MockLineMessagingAdapter(), { workerId: `phase3-a-${Date.now()}`, jobId: job.id }),
      runWorkerOnce(createPostgresRepository(poolB), new MockLineMessagingAdapter(), { workerId: `phase3-b-${Date.now()}`, jobId: job.id })
    ]);
    const results = [a, b].filter((item) => item.job?.id === job.id);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'completed');
  } finally { await Promise.all([poolA.end(), poolB.end()]); }
});

test('stale CLAIMED lease recovers after worker restart and completes', async () => {
  const job = await createJob('DRAFT', new Date(Date.now() - 5_000).toISOString());
  const scheduled = await request(`/api/scheduler/jobs/${job.id}/schedule`, { method: 'POST' });
  assert.equal(scheduled.body.status, 'SCHEDULED');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("update scheduler_jobs set status='CLAIMED', claimed_at=now()-interval '10 minutes', claimed_by='crashed-worker' where id=$1", [job.id]);
    const { createPostgresRepository } = await import('../dist/api/repository.js');
    const { MockLineMessagingAdapter } = await import('../dist/api/lineAdapter.js');
    const { runWorkerOnce } = await import('../dist/api/worker.js');
    const repo = createPostgresRepository(pool);
    assert.equal(await repo.recoverStaleJobs(new Date(Date.now() - 60_000)), 1);
    const result = await runWorkerOnce(repo, new MockLineMessagingAdapter(), { workerId: `phase3-recovery-${Date.now()}`, jobId: job.id });
    assert.equal(result.job.id, job.id);
    assert.equal(result.job.status, 'COMPLETED');
  } finally { await pool.end(); }
});
