import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.PERSISTENCE = 'memory';
process.env.APP_MODE = 'DRY_RUN';
process.env.LINE_WEBHOOK_ENABLED = 'true';
process.env.LINE_CHANNEL_SECRET = 'security-test-secret';
process.env.MEMORY_ADMIN_EMAIL = 'admin@memory.local';
process.env.MEMORY_ADMIN_PASSWORD = 'memory-test-password';

const { buildApp } = await import('../dist/api/server.js');
const { createMemoryRepository } = await import('../dist/api/repository.js');
const app = buildApp(createMemoryRepository());
let cookie = '';
let csrf = '';
let sessionCookie = '';

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (csrf && (options.method || 'GET') !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await app.inject({ ...options, url: path, headers });
  const setCookies = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [response.headers['set-cookie']].filter(Boolean);
  for (const value of setCookies) {
    const session = String(value).match(/^ccc_session=([^;]+)/)?.[1];
    const nextCsrf = String(value).match(/^ccc_csrf=([^;]+)/)?.[1];
    if (session) sessionCookie = `ccc_session=${session}`;
    if (nextCsrf) csrf = nextCsrf;
  }
  if (sessionCookie && csrf) cookie = `${sessionCookie}; ccc_csrf=${csrf}`;
  else if (sessionCookie) cookie = sessionCookie;
  return { response, body: response.json() };
}

before(async () => { await app.ready(); });
after(async () => { await app.close(); });

test('authentication and Flex validation protect mutating routes', async () => {
  assert.equal((await request('/api/campaigns')).response.statusCode, 401);
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'admin@memory.local', password: 'memory-test-password' }) });
  assert.equal(login.response.statusCode, 200);
  const missingCsrf = await app.inject({ method: 'POST', url: '/api/campaigns/welcome/revisions', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, payload: JSON.stringify({ flexJson: { type: 'flex', altText: 'csrf', contents: { type: 'bubble' } } }) });
  assert.equal(missingCsrf.statusCode, 403);
  const invalid = await request('/api/campaigns/welcome/revisions', { method: 'POST', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ flexJson: { type: 'text' } }) });
  assert.equal(invalid.response.statusCode, 400);
});

test('memory mode has no credential fallback and cannot run live', async () => {
  const originalPassword = process.env.MEMORY_ADMIN_PASSWORD;
  const originalPersistence = process.env.PERSISTENCE;
  const originalAppMode = process.env.APP_MODE;
  const originalLiveEnabled = process.env.LINE_LIVE_ENABLED;
  try {
    delete process.env.MEMORY_ADMIN_PASSWORD;
    assert.throws(() => createMemoryRepository(), /no fallback credential exists/);

    process.env.MEMORY_ADMIN_PASSWORD = 'memory-test-password';
    process.env.PERSISTENCE = 'memory';
    process.env.APP_MODE = 'LIVE';
    assert.throws(() => createMemoryRepository(), /explicit APP_MODE=DRY_RUN/);

    process.env.APP_MODE = 'DRY_RUN';
    process.env.LINE_LIVE_ENABLED = 'true';
    assert.throws(() => createMemoryRepository(), /cannot run with LINE_LIVE_ENABLED=true/);
  } finally {
    if (originalPassword === undefined) delete process.env.MEMORY_ADMIN_PASSWORD; else process.env.MEMORY_ADMIN_PASSWORD = originalPassword;
    if (originalPersistence === undefined) delete process.env.PERSISTENCE; else process.env.PERSISTENCE = originalPersistence;
    if (originalAppMode === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = originalAppMode;
    if (originalLiveEnabled === undefined) delete process.env.LINE_LIVE_ENABLED; else process.env.LINE_LIVE_ENABLED = originalLiveEnabled;
  }
});

test('LINE signature rejects tampering and deduplicates accepted events', async () => {
  const event = `security-${Date.now()}`;
  const userId = `U-security-${Date.now()}`;
  const raw = JSON.stringify({ events: [{ webhookEventId: event, type: 'follow', source: { userId } }] });
  const invalid = await request('/api/webhooks/line/oa-staging-primary', { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': 'bad' }, payload: raw });
  assert.equal(invalid.response.statusCode, 401);
  const signature = createHmac('sha256', 'security-test-secret').update(raw).digest('base64');
  const first = await request('/api/webhooks/line/oa-staging-primary', { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, payload: raw });
  const second = await request('/api/webhooks/line/oa-staging-primary', { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, payload: raw });
  assert.equal(first.response.statusCode, 200);
  assert.equal(first.body.duplicates, 0);
  assert.equal(second.body.duplicates, 1);
  const customers = await request('/api/customers');
  assert.equal(customers.body.customers.some((customer) => customer.lineUserKey === userId && customer.optIn), true);
});

test('an operator can record an opt-out, and only the customer can undo it', async () => {
  const sign = (raw) => createHmac('sha256', 'security-test-secret').update(raw).digest('base64');
  const follow = (userId, event) => {
    const raw = JSON.stringify({ events: [{ webhookEventId: event, type: 'follow', source: { userId } }] });
    return request('/api/webhooks/line/oa-staging-primary', { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': sign(raw) }, payload: raw });
  };
  const userId = `U-optout-${Date.now()}`;
  await follow(userId, `optout-follow-${Date.now()}`);
  const listed = (await request('/api/customers')).body.customers.find((customer) => customer.lineUserKey === userId);
  assert.ok(listed, 'the follow event must create the customer before the opt-out test');

  const optedOut = await request(`/api/customers/${listed.id}/opt-out`, { method: 'POST' });
  assert.equal(optedOut.response.statusCode, 200);
  assert.equal(optedOut.body.optIn, false);
  assert.equal(optedOut.body.optOutSource, 'operator');
  assert.ok(optedOut.body.blockedAt && optedOut.body.optOutAt);
  const afterOptOut = (await request('/api/customers')).body.customers.find((customer) => customer.id === listed.id);
  assert.equal(afterOptOut.optIn, false);
  assert.equal(afterOptOut.optOutSource, 'operator');
  assert.equal((await request('/api/audit')).body.events.some((event) => event.action === 'CUSTOMER_OPT_OUT' && event.target === listed.id), true);
  assert.equal((await request('/api/customers/does-not-exist/opt-out', { method: 'POST' })).response.statusCode, 404);

  // The opt-out is a stop signal, not a toggle: consent comes back only from the customer's own follow.
  await follow(userId, `optout-refollow-${Date.now()}`);
  const afterRefollow = (await request('/api/customers')).body.customers.find((customer) => customer.id === listed.id);
  assert.equal(afterRefollow.optIn, true);
  assert.equal(afterRefollow.blockedAt, undefined);
  assert.equal(afterRefollow.optOutSource, undefined);
});
