import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.PERSISTENCE = 'memory';
process.env.APP_MODE = 'DRY_RUN';
process.env.LINE_WEBHOOK_ENABLED = 'false';
process.env.MEMORY_ADMIN_EMAIL = 'admin@memory.local';
process.env.MEMORY_ADMIN_PASSWORD = 'phase5a-original-password';

const { buildApp } = await import('../dist/api/server.js');
const { createMemoryRepository } = await import('../dist/api/repository.js');
const { can } = await import('../dist/api/validation.js');
const repo = createMemoryRepository();
const app = buildApp(repo);
const originalPassword = 'phase5a-original-password';
const newPassword = 'Phase5A-NewPass-2026!';
let csrf = '';
let cookie = '';

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (csrf && (options.method || 'GET') !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await app.inject({ ...options, url: path, headers });
  const setCookies = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [response.headers['set-cookie']].filter(Boolean);
  for (const value of setCookies) {
    const session = String(value).match(/^ccc_session=([^;]+)/)?.[1];
    const nextCsrf = String(value).match(/^ccc_csrf=([^;]+)/)?.[1];
    if (session) cookie = `ccc_session=${session}${csrf ? `; ccc_csrf=${csrf}` : ''}`;
    if (nextCsrf) { csrf = nextCsrf; if (cookie) cookie = cookie.replace(/ccc_csrf=[^;]+/, `ccc_csrf=${csrf}`); }
  }
  return { response, body: response.json() };
}

const login = (email, password) => request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email, password }) });

before(async () => { await app.ready(); });
after(async () => { await app.close(); });

test('baseline security headers are applied to API responses', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.ok(response.headers['x-request-id']);
});

test('the public health reply tells the login screen which gate is open', async () => {
  const health = (await app.inject({ method: 'GET', url: '/health' })).json();
  assert.equal(health.mode, 'DRY_RUN');
  assert.equal(health.liveSendEnabled, false, 'a host without the release gate must not advertise live sending');
});

test('cross-origin mutations are rejected while the configured origin is accepted', async () => {
  const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, payload: JSON.stringify({ email: 'admin@memory.local', password: originalPassword }) });
  assert.equal(blocked.statusCode, 403);
  const allowed = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' }, payload: JSON.stringify({ email: 'admin@memory.local', password: originalPassword }) });
  assert.equal(allowed.statusCode, 200);
});

test('password login compares asynchronously and hides unknown accounts', async () => {
  const wrong = await login('admin@memory.local', 'wrong-password-2026');
  assert.equal(wrong.response.statusCode, 401);
  const unknown = await login('nobody@memory.local', 'wrong-password-2026');
  assert.equal(unknown.response.statusCode, 401);
  assert.deepEqual(unknown.body, { error: 'invalid credentials' });
  const success = await login('admin@memory.local', originalPassword);
  assert.equal(success.response.statusCode, 200);
});

test('reviewer is read and approve only while editor keeps write access', () => {
  assert.equal(can('reviewer', 'read'), true);
  assert.equal(can('reviewer', 'approve'), true);
  assert.equal(can('reviewer', 'write'), false);
  assert.equal(can('editor', 'write'), true);
  assert.equal(can('editor', 'approve'), false);
});

test('one-time account links activate a password, expire after use, and revoke sessions', async () => {
  const inviteMismatch = await repo.createAccountToken({ workspaceId: 'memory-workspace', adminUserId: 'memory-admin', purpose: 'INVITE', actor: 'admin@memory.local' });
  const rejected = await app.inject({ method: 'POST', url: '/api/account/setup', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ token: inviteMismatch.token, password: newPassword }) });
  assert.equal(rejected.statusCode, 400);

  const issued = await repo.createAccountToken({ workspaceId: 'memory-workspace', adminUserId: 'memory-admin', purpose: 'RESET', actor: 'admin@memory.local' });
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  const completed = await app.inject({ method: 'POST', url: '/api/account/setup', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ token: issued.token, password: newPassword }) });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().user.email, 'admin@memory.local');

  const reused = await app.inject({ method: 'POST', url: '/api/account/setup', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ token: issued.token, password: newPassword }) });
  assert.equal(reused.statusCode, 400);

  const oldPassword = await login('admin@memory.local', originalPassword);
  assert.equal(oldPassword.response.statusCode, 401);
  const newPasswordLogin = await login('admin@memory.local', newPassword);
  assert.equal(newPasswordLogin.response.statusCode, 200);
});

test('scheduler idempotency key returns the original job instead of duplicating it', async () => {
  const payload = JSON.stringify({ campaignId: 'welcome', oaId: 'oa-staging-primary', scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(), timeZone: 'Asia/Bangkok', status: 'SCHEDULED' });
  const first = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'phase5a-schedule-key-1' }, payload });
  assert.equal(first.response.statusCode, 201, first.body);
  const second = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'phase5a-schedule-key-1' }, payload });
  assert.equal(second.response.statusCode, 201, second.body);
  assert.equal(second.body.id, first.body.id);
  const jobs = await request('/api/scheduler/jobs');
  assert.equal(jobs.body.jobs.filter((job) => job.id === first.body.id).length, 1);
  const jobsTotal = jobs.body.jobs.length;
  assert.equal(jobsTotal, 1);

  const invalidKey = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'short' }, payload });
  assert.equal(invalidKey.response.statusCode, 400);

  const audit = await request('/api/audit');
  assert.ok(audit.body.events.some((event) => event.action === 'SCHEDULE_CREATED'));
});

test('login attempts are rate limited per account and address', async () => {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await login('rate-limit@memory.local', 'rate-limit-password'); 
    lastStatus = response.response.statusCode;
  }
  assert.equal(lastStatus, 429);
});
