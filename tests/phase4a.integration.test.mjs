import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const base = 'http://127.0.0.1:8792';
const password = process.env.STAGING_ADMIN_PASSWORD;
if (!password) throw new Error('STAGING_ADMIN_PASSWORD is required; fixed staging credentials are not allowed');
let child;
let cookie = '';
let csrf = '';
let sessionCookie = '';
let enabledOa;

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) { try { const response = await fetch(`${base}/health`); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error('Phase 4A API did not become healthy');
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (csrf && (options.method || 'GET') !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const setCookies = response.headers.getSetCookie?.() || [];
  for (const value of setCookies) { const session = value.match(/^ccc_session=([^;]+)/)?.[1]; const nextCsrf = value.match(/^ccc_csrf=([^;]+)/)?.[1]; if (session) sessionCookie = `ccc_session=${session}`; if (nextCsrf) csrf = nextCsrf; }
  if (sessionCookie && csrf) cookie = `${sessionCookie}; ccc_csrf=${csrf}`; else if (sessionCookie) cookie = sessionCookie;
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

before(async () => {
  child = spawn(process.execPath, ['dist/api/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: '8792', PERSISTENCE: 'postgres', APP_MODE: 'DRY_RUN', LINE_WEBHOOK_ENABLED: 'false' }, stdio: 'ignore' });
  await waitForHealth();
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.STAGING_ADMIN_EMAIL || 'admin@staging.local', password }) });
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  const oas = await request('/api/oas');
  enabledOa = oas.body.oas.find((oa) => oa.enabled && oa.environment === 'STAGING')?.id;
  assert.ok(enabledOa);
});

after(async () => {
  if (cookie && csrf) {
    await request(`/api/oas/${enabledOa}/kill-switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4A test cleanup' }) }).catch(() => undefined);
    await request('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4A test cleanup' }) }).catch(() => undefined);
    await request('/api/campaigns/welcome/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4A test cleanup' }) }).catch(() => undefined);
  }
  child?.kill();
});

test('OA metadata is workspace-scoped and never returns credential values', async () => {
  const created = await request('/api/oas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: `phase4a-${Date.now()}`, basicId: '@phase4a-staging', displayName: 'Phase 4A Staging OA' }) });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.environment, 'STAGING');
  assert.equal(created.body.secretConfigured, false);
  assert.equal(Object.prototype.hasOwnProperty.call(created.body, 'secret'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(created.body, 'token'), false);
  const validated = await request(`/api/oas/${created.body.id}/validate`, { method: 'POST' });
  assert.equal(validated.response.status, 200);
  assert.equal(validated.body.connectionStatus, 'DRY_RUN_READY');
  assert.equal(validated.body.credentialStatus, 'NOT_CONFIGURED');
});

test('campaign readiness enforces Validate then Approve and all three kill switches', async () => {
  const initial = await request(`/api/campaigns/welcome/readiness?oaId=${encodeURIComponent(enabledOa)}`);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.approvalStatus, 'APPROVED');
  const validated = await request('/api/campaigns/welcome/validate', { method: 'POST' });
  assert.equal(validated.body.approvalStatus, 'VALIDATED');
  const approved = await request('/api/campaigns/welcome/approve', { method: 'POST' });
  assert.equal(approved.body.approvalStatus, 'APPROVED');
  const oaStop = await request(`/api/oas/${enabledOa}/kill-switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, reason: 'Phase 4A kill switch test' }) });
  assert.equal(oaStop.body.killSwitch, true);
  assert.equal((await request(`/api/campaigns/welcome/readiness?oaId=${encodeURIComponent(enabledOa)}`)).body.canSchedule, false);
  await request(`/api/oas/${enabledOa}/kill-switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4A kill switch test cleanup' }) });
  const systemStop = await request('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, reason: 'Phase 4A system switch test' }) });
  assert.equal(systemStop.body.enabled, true);
  assert.equal((await request(`/api/campaigns/welcome/readiness?oaId=${encodeURIComponent(enabledOa)}`)).body.systemKillSwitch, true);
  await request('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'Phase 4A system switch test cleanup' }) });
  const campaignStop = await request('/api/campaigns/welcome/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, reason: 'Phase 4A campaign switch test' }) });
  assert.equal(campaignStop.body.campaignKillSwitch, true);
  assert.equal((await request(`/api/campaigns/welcome/readiness?oaId=${encodeURIComponent(enabledOa)}`)).body.canSchedule, false);
});
