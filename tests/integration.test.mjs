import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';

const base = 'http://127.0.0.1:8790';
const password = process.env.STAGING_ADMIN_PASSWORD;
const viewerPassword = process.env.STAGING_VIEWER_PASSWORD;
const webhookSecret = process.env.STAGING_WEBHOOK_SECRET;
const webhookConfigured = Boolean(webhookSecret && process.env.LINE_CREDENTIAL_ENCRYPTION_KEY);
if (!password || !viewerPassword) throw new Error('STAGING_ADMIN_PASSWORD and STAGING_VIEWER_PASSWORD are required; fixed staging credentials are not allowed');
let child;
let cookie = '';
let csrf = '';
let sessionCookie = '';

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) { try { const response = await fetch(`${base}/health`); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error('API did not become healthy');
}

function startApi() {
  child = spawn(process.execPath, ['dist/api/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '8790', PERSISTENCE: 'postgres', APP_MODE: 'DRY_RUN', LINE_WEBHOOK_ENABLED: webhookConfigured ? 'true' : 'false' }, stdio: 'ignore' });
  return waitForHealth();
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

before(async () => { await startApi(); });
after(() => { child?.kill(); });

test('unauthenticated admin API is rejected', async () => {
  const previous = cookie; cookie = '';
  const { response } = await request('/api/dashboard');
  cookie = previous;
  assert.equal(response.status, 401);
});

test('admin login loads seven campaigns from PostgreSQL', async () => {
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.STAGING_ADMIN_EMAIL || 'admin@staging.local', password }) });
  assert.equal(login.response.status, 200);
  const result = await request('/api/campaigns');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.campaigns.length, 7);
  assert.ok(result.body.campaigns.every((campaign) => campaign.flexJson?.type === 'flex'));
});

test('Flex revision survives API restart and invalid Flex is blocked', async () => {
  const campaigns = await request('/api/campaigns');
  const original = campaigns.body.campaigns.find((campaign) => campaign.id === 'welcome').flexJson;
  const invalid = await request('/api/campaigns/welcome/revisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flexJson: { type: 'text' } }) });
  assert.equal(invalid.response.status, 400);
  const edited = { ...original, altText: `${original.altText} Phase2` };
  const saved = await request('/api/campaigns/welcome/revisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flexJson: edited }) });
  assert.equal(saved.response.status, 201);
  const revisionId = saved.body.id;
  child.kill(); await new Promise((resolve) => setTimeout(resolve, 350)); await startApi();
  cookie = '';
  await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.STAGING_ADMIN_EMAIL || 'admin@staging.local', password }) });
  const revisions = await request('/api/campaigns/welcome/revisions');
  assert.ok(revisions.body.revisions.some((revision) => revision.id === revisionId && revision.flexJson.altText.endsWith('Phase2')));
});

test('viewer RBAC cannot create a Flex revision', async () => {
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.STAGING_VIEWER_EMAIL || 'viewer@staging.local', password: viewerPassword }) });
  assert.equal(login.response.status, 200);
  const result = await request('/api/campaigns/welcome/revisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flexJson: { type: 'flex', altText: 'blocked', contents: { type: 'bubble' } } }) });
  assert.equal(result.response.status, 403);
  cookie = '';
  await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.STAGING_ADMIN_EMAIL || 'admin@staging.local', password }) });
});

test('LINE webhook verifies per-OA vault secret and deduplicates event id', { skip: webhookConfigured ? false : 'STAGING_WEBHOOK_SECRET and LINE_CREDENTIAL_ENCRYPTION_KEY are required; PostgreSQL webhooks no longer accept an environment secret' }, async () => {
  const oas = await request('/api/oas');
  const oaId = oas.body.oas.find((oa) => oa.enabled).id;
  const eventId = `phase2-event-${Date.now()}`;
  const raw = JSON.stringify({ events: [{ webhookEventId: eventId, type: 'follow', source: { userId: `U-phase2-${Date.now()}` } }] });
  const signature = createHmac('sha256', webhookSecret).update(raw).digest('base64');
  const invalid = await request(`/api/webhooks/line/${oaId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': 'invalid' }, body: raw });
  assert.equal(invalid.response.status, 401);
  const first = await request(`/api/webhooks/line/${oaId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, body: raw });
  const second = await request(`/api/webhooks/line/${oaId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, body: raw });
  assert.equal(first.response.status, 200); assert.equal(first.body.duplicates, 0);
  assert.equal(second.response.status, 200); assert.equal(second.body.duplicates, 1);
});

test('scheduler supports pause, retry, DRY RUN and audit persistence', async () => {
  const oas = await request('/api/oas');
  const oaId = oas.body.oas.find((oa) => oa.enabled).id;
  const scheduled = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignId: 'welcome', oaId, scheduledAt: new Date(Date.now() + 3600000).toISOString() }) });
  assert.equal(scheduled.response.status, 201);
  const jobId = scheduled.body.id;
  const paused = await request(`/api/scheduler/jobs/${jobId}/pause`, { method: 'POST' });
  assert.equal(paused.response.status, 200);
  assert.equal(paused.body.status, 'PAUSED');
  const retried = await request(`/api/scheduler/jobs/${jobId}/retry`, { method: 'POST' });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.body.status, 'RETRYABLE');
  const dryRun = await request(`/api/scheduler/jobs/${jobId}/dry-run`, { method: 'POST' });
  assert.equal(dryRun.response.status, 200);
  assert.equal(dryRun.body.status, 'COMPLETED');
  assert.equal(dryRun.body.attempts, 1);
  const outbox = await request(`/api/scheduler/jobs/${jobId}/outbox`);
  assert.equal(outbox.response.status, 200);
  assert.equal(outbox.body.deliveries.length, 1);
  assert.equal(outbox.body.deliveries[0].status, 'SENT');
  assert.equal(outbox.body.deliveries[0].recipientKey, '__campaign__');
  const audit = await request('/api/audit');
  assert.ok(audit.body.events.some((event) => event.target === jobId && event.action === 'DRY_RUN_ENQUEUED'));
  assert.ok(audit.body.events.some((event) => event.target === jobId && event.action === 'WORKER_COMPLETED'));
});
