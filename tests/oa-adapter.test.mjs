import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.APP_MODE = 'DRY_RUN';
process.env.LINE_LIVE_ENABLED = 'false';

const { MockLineMessagingAdapter, LiveLineMessagingAdapter, MockTransport, HttpTransport, ProviderTransportError } = await import('../dist/api/lineAdapter.js');
const { OaPolicyError, validateDispatchPolicy, classifyProviderError, retryDelayMs } = await import('../dist/api/oaPolicy.js');

const job = { id: 'job-phase4a', campaignId: 'welcome', oaId: 'oa-staging-primary', scheduledAt: new Date().toISOString(), timeZone: 'Asia/Bangkok', mode: 'DRY_RUN', status: 'SCHEDULED', attempts: 0, idempotencyKey: 'retry-key-phase4a', createdAt: new Date().toISOString() };
const approvedPolicy = { appMode: 'DRY_RUN', systemKillSwitch: false, oaKillSwitch: false, campaignKillSwitch: false, approvalStatus: 'APPROVED', consentedRecipients: 10, quotaRemaining: 10, quotaPerMinute: 60, requestedRecipients: 2 };

test('Mock adapter completes DRY_RUN without outbound transport', async () => {
  const adapter = new MockLineMessagingAdapter();
  const result = await adapter.send({ job, policy: approvedPolicy });
  assert.deepEqual(result, { dryRun: true, outbound: false, idempotencyKey: job.idempotencyKey, providerStatus: 200, providerRequestId: 'mock-request' });
});

test('Live adapter is locked by default in DRY_RUN', () => {
  assert.throws(() => new LiveLineMessagingAdapter(new HttpTransport(), async () => null), (error) => error instanceof OaPolicyError && error.code === 'LIVE_MODE_LOCKED');
});

test('Mock transport is isolated and never uses HTTP', async () => {
  const transport = new MockTransport();
  const result = await new MockLineMessagingAdapter(transport).send({ job, policy: approvedPolicy });
  assert.equal(result.outbound, false);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].endpoint, 'mock://line-messaging');
  assert.equal(transport.requests[0].token, '');
});

test('HttpTransport uses the retry key and maps mocked provider responses', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ retryKey: request.headers['x-line-retry-key'], authorization: request.headers.authorization });
    const status = Number(request.url?.slice(1));
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-line-request-id', `mock-${status}`);
    if (status === 429) response.setHeader('retry-after', '2');
    response.statusCode = status;
    response.end(JSON.stringify({ status }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const response = await new HttpTransport().send({ endpoint: `http://127.0.0.1:${port}/${status}`, token: 'fixture', retryKey: job.idempotencyKey, body: { safe: true } });
      assert.equal(response.status, status);
      assert.equal(response.requestId, `mock-${status}`);
      if (status === 429) assert.equal(response.retryAfterMs, 2000);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
  assert.equal(seen.length, 6);
  assert.ok(seen.every((item) => item.retryKey === job.idempotencyKey));
  assert.ok(seen.every((item) => item.authorization === 'Bearer fixture'));
});

test('provider response errors expose retry safety without leaking payloads', () => {
  const transport = new MockTransport({ status: 503, requestId: 'uncertain-request' });
  assert.rejects(() => new MockLineMessagingAdapter(transport).send({ job, policy: approvedPolicy }), (error) => error instanceof ProviderTransportError && error.status === 503 && error.retryable && error.uncertain && !error.message.includes('token'));
});

test('dispatch policy blocks unsafe approval, consent, quota, rate and kill-switch states', () => {
  assert.throws(() => validateDispatchPolicy({ ...approvedPolicy, approvalStatus: 'VALIDATED' }), /validated and approved/);
  assert.throws(() => validateDispatchPolicy({ ...approvedPolicy, requestedRecipients: 11 }), /consent/);
  assert.throws(() => validateDispatchPolicy({ ...approvedPolicy, quotaRemaining: 1 }), /quota/);
  assert.throws(() => validateDispatchPolicy({ ...approvedPolicy, quotaPerMinute: 1 }), /rate limit/);
  assert.throws(() => validateDispatchPolicy({ ...approvedPolicy, systemKillSwitch: true }), /kill switch/);
});

test('provider error policy retries only rate limit and transient 5xx, preserving retry key', () => {
  assert.equal(classifyProviderError(400).retryable, false);
  assert.equal(classifyProviderError(401).retryable, false);
  assert.equal(classifyProviderError(403).retryable, false);
  assert.equal(classifyProviderError(409).code, 'PROVIDER_RETRY_KEY_ACCEPTED');
  assert.equal(classifyProviderError(429).retryable, true);
  assert.equal(classifyProviderError(503).retryable, true);
  assert.equal(retryDelayMs(3), 4000);
  assert.equal(retryDelayMs(1, 1000, 60000), 60000);
  assert.equal(job.idempotencyKey, 'retry-key-phase4a');
});
