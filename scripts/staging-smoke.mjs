#!/usr/bin/env node
// Read-only staging smoke. Never prints credentials, cookies, tokens or customer identities.
//   SMOKE_BASE_URL=https://staging.example.invalid \
//   SMOKE_ADMIN_EMAIL=... SMOKE_ADMIN_PASSWORD=... \
//   npm run smoke:staging
// Admin credentials are required. A run that cannot log in never proves readiness, so a
// missing credential is a FAIL here and not a skip; the caller must supply one.
const base = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const allowLive = process.env.SMOKE_ALLOW_LIVE === '1';
const email = (process.env.SMOKE_ADMIN_EMAIL || '').trim();
const password = process.env.SMOKE_ADMIN_PASSWORD || '';
// The worker writes a heartbeat on every loop (P0-6) and audits one every five minutes.
const workerIdleMinutes = Number(process.env.SMOKE_WORKER_IDLE_MINUTES || 15);
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
  // Memory has no database to reach, so only a postgres deployment can attest `db=up`.
  const expectedDb = healthBody.persistence === 'memory' ? 'not_configured' : 'up';
  record('health db reachable', healthBody.db === expectedDb, `db=${healthBody.db}`);
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
    record('admin credentials provided', false, 'SMOKE_ADMIN_EMAIL/SMOKE_ADMIN_PASSWORD not set — without them the admin surface is never checked');
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
  const opsReadable = ops.ok && Boolean(opsBody);
  record('delivery health readable', opsReadable && typeof opsBody?.ok === 'boolean', `HTTP ${ops.status} alerts=${Array.isArray(opsBody?.alerts) ? opsBody.alerts.join(',') || 'none' : 'n/a'}`);
  record('delivery health has counters', Number.isInteger(opsBody?.counts?.pending) && Number.isInteger(opsBody?.counts?.unknown));
  // A stale worker leaves a scheduled campaign sitting in QUEUED forever; nothing else in
  // the smoke would notice it.
  record('worker not stale', opsReadable && opsBody?.workerStale === false, `workerStale=${opsBody?.workerStale}`);
  const lastSeen = opsBody?.lastWorkerHeartbeat || opsBody?.lastWorkerActivity || null;
  const workerAgeMinutes = lastSeen === null ? null : Math.round((Date.now() - Date.parse(lastSeen)) / 60_000);
  record('worker seen recently', workerAgeMinutes !== null && workerAgeMinutes <= workerIdleMinutes, workerAgeMinutes === null ? 'no worker heartbeat or delivery recorded yet' : `last worker evidence ${workerAgeMinutes}m ago (limit ${workerIdleMinutes}m)`);
  record('quota snapshot present', Array.isArray(opsBody?.quota));

  const customers = await get('/api/customers', { headers: { cookie: cookieHeader } });
  const customersBody = await customers.json().catch(() => null);
  const customerRows = Array.isArray(customersBody?.customers) ? customersBody.customers : null;
  // Counts only: the smoke must never echo a recipient key or a display name.
  const customersShaped = customerRows !== null && customerRows.every((item) => typeof item.id === 'string' && typeof item.lineUserKey === 'string' && typeof item.optIn === 'boolean' && (item.optOutSource === undefined || typeof item.optOutSource === 'string') && (item.blockedAt === undefined || typeof item.blockedAt === 'string') && (item.optOutAt === undefined || typeof item.optOutAt === 'string'));
  record('customers payload shaped', customers.ok && customersShaped, `HTTP ${customers.status} customers=${customerRows?.length ?? 'n/a'}`);

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
