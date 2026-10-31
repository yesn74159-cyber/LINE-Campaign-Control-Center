#!/usr/bin/env node
// Read-only staging smoke. Never prints credentials, cookies or tokens.
//   SMOKE_BASE_URL=https://staging.example.invalid \
//   SMOKE_ADMIN_EMAIL=... SMOKE_ADMIN_PASSWORD=... \
//   npm run smoke:staging
// Admin checks are skipped when the credentials are absent.
const base = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const allowLive = process.env.SMOKE_ALLOW_LIVE === '1';
const email = process.env.SMOKE_ADMIN_EMAIL || '';
const password = process.env.SMOKE_ADMIN_PASSWORD || '';
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path, init = {}) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
  return response;
}

async function main() {
  const health = await get('/health');
  const healthBody = await health.json().catch(() => null);
  record('health responds', health.ok, `HTTP ${health.status}`);
  if (!healthBody) throw new Error('health did not return JSON');
  record('health ok flag', healthBody.ok === true);
  record('APP_MODE is DRY_RUN', allowLive ? healthBody.mode === 'DRY_RUN' || healthBody.mode === 'LIVE' : healthBody.mode === 'DRY_RUN', `mode=${healthBody.mode}`);
  record('persistence reported', typeof healthBody.persistence === 'string', `persistence=${healthBody.persistence}`);
  record('nosniff header', health.headers.get('x-content-type-options') === 'nosniff');
  record('frame deny header', health.headers.get('x-frame-options') === 'DENY');

  const loginConfig = await get('/api/line-login/config');
  const loginBody = await loginConfig.json().catch(() => null);
  record('LINE Login config reachable', loginConfig.ok && typeof loginBody?.enabled === 'boolean', `enabled=${loginBody?.enabled}`);
  record('LINE Login stays disabled', loginBody?.enabled === false);

  const unauthenticated = await get('/api/dashboard');
  record('dashboard requires a session', unauthenticated.status === 401, `HTTP ${unauthenticated.status}`);

  if (!email || !password) {
    record('admin checks', true, 'skipped (SMOKE_ADMIN_EMAIL/PASSWORD not set)');
    return;
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const cookies = (login.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]);
  const sessionCookie = cookies.find((value) => value.startsWith('ccc_session='));
  const csrfCookie = cookies.find((value) => value.startsWith('ccc_csrf='));
  record('admin login', login.ok && Boolean(sessionCookie) && Boolean(csrfCookie), `HTTP ${login.status}`);
  if (!login.ok) return;

  const cookieHeader = `ccc_session=${sessionCookie.split('=')[1]}; ccc_csrf=${csrfCookie.split('=')[1]}`;
  const session = await get('/api/auth/me', { headers: { cookie: cookieHeader } });
  const sessionBody = await session.json().catch(() => null);
  record('session resolves to a user', session.ok && Boolean(sessionBody?.user?.id), `role=${sessionBody?.user?.role}`);

  const ops = await get('/api/ops/delivery-health', { headers: { cookie: cookieHeader } });
  const opsBody = await ops.json().catch(() => null);
  record('delivery health readable', ops.ok && typeof opsBody?.ok === 'boolean', `alerts=${Array.isArray(opsBody?.alerts) ? opsBody.alerts.join(',') || 'none' : 'n/a'}`);
  record('delivery health has counters', Number.isInteger(opsBody?.counts?.pending) && Number.isInteger(opsBody?.counts?.unknown));
  record('quota snapshot present', Array.isArray(opsBody?.quota));

  const audit = await get('/api/audit', { headers: { cookie: cookieHeader } });
  const auditBody = await audit.json().catch(() => null);
  record('audit log readable', audit.ok && Array.isArray(auditBody?.events), `events=${auditBody?.events?.length ?? 'n/a'}`);

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfCookie.split('=')[1] }
  });
  record('admin logout', logout.ok, `HTTP ${logout.status}`);
}

main()
  .catch((error) => record('smoke run', false, error instanceof Error ? error.message : 'unknown error'))
  .finally(() => {
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  });
