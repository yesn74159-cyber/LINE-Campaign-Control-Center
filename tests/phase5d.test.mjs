import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createMessagingAdapter,
  HttpTransport,
  LiveLineMessagingAdapter,
  MockLineMessagingAdapter,
  MockTransport,
  ProviderTransportError
} from '../dist/api/lineAdapter.js';
import { buildDeliveryPayload, buildLivePushBody, PREVIEW_RECIPIENT } from '../dist/api/livePushPayload.js';
import { resolveOaAccessToken, sealOaSecret } from '../dist/api/lineOaConnect.js';
import { OaPolicyError } from '../dist/api/oaPolicy.js';
import { runWorkerOnce } from '../dist/api/worker.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const oaId = '22222222-2222-4222-8222-222222222222';
const otherOaId = '33333333-3333-4333-8333-333333333333';
const key = randomBytes(32);
const userId = `U${'a'.repeat(32)}`;
const secondUserId = `U${'b'.repeat(32)}`;
const flex = {
  type: 'flex',
  altText: 'โปรโมชันพิเศษสำหรับคุณ',
  contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } }
};

function liveJob(overrides = {}) {
  return {
    id: 'job-live', workspaceId, campaignId: 'welcome', campaignRevisionId: 'rev-1', oaId,
    scheduledAt: new Date().toISOString(), timeZone: 'Asia/Bangkok', mode: 'LIVE', status: 'SCHEDULED',
    attempts: 0, idempotencyKey: 'idem-live', createdAt: new Date().toISOString(), ...overrides
  };
}

function fakeHttpTransport(handler) {
  const requests = [];
  return {
    kind: 'http',
    requests,
    async send(input) {
      requests.push(structuredClone(input));
      return handler ? handler(input) : { status: 200, requestId: 'req-live' };
    }
  };
}

test('payload builder is deterministic, frozen, and shared by mock and live adapters', async () => {
  const source = structuredClone(flex);
  const payload = buildDeliveryPayload({ recipientKey: userId, flexMessage: source });
  assert.deepEqual(payload, { preview: false, to: userId, messages: [flex] });
  source.altText = 'mutated after snapshot';
  assert.equal(payload.messages[0].altText, flex.altText);

  const preview = buildDeliveryPayload({ recipientKey: PREVIEW_RECIPIENT, flexMessage: flex });
  assert.deepEqual(preview, { preview: true, messages: [flex] });
  assert.equal('to' in preview, false);

  assert.throws(() => buildLivePushBody({ lineUserId: 'U-not-hex', flexMessage: flex }), /recipient must be an OA-scoped LINE userId/);
  assert.throws(() => buildDeliveryPayload({ recipientKey: 'U-not-hex', flexMessage: flex }), /recipient must be an OA-scoped LINE userId/);
  assert.throws(() => buildDeliveryPayload({ recipientKey: userId, flexMessage: { ...flex, altText: '   ' } }), /altText must not be empty/);
  assert.throws(() => buildDeliveryPayload({ recipientKey: userId, flexMessage: { type: 'flex', altText: 'x', contents: {} } }), /invalid LINE Flex document/);

  const transport = new MockTransport();
  const adapter = new MockLineMessagingAdapter(transport);
  const job = liveJob({ mode: 'DRY_RUN', status: 'SCHEDULED' });
  const delivery = { id: 'd1', workspaceId, jobId: job.id, oaId, recipientKey: userId, idempotencyKey: 'idem', lineRetryKey: 'retry-d1', status: 'PENDING', attempts: 0, createdAt: '', updatedAt: '' };
  await adapter.send({ job, delivery, payload });
  await adapter.send({ job, delivery, payload: buildDeliveryPayload({ recipientKey: PREVIEW_RECIPIENT, flexMessage: flex }) });
  assert.deepEqual(transport.requests[0].body, { to: userId, messages: [flex] });
  assert.deepEqual(transport.requests[1].body, { preview: true, messages: [flex] });
  assert.equal(transport.requests[0].retryKey, 'retry-d1');
  assert.equal(transport.requests[0].token, '');
});

test('adapter factory follows the job mode and keeps LIVE locked until every gate is set', () => {
  assert.equal(createMessagingAdapter({ pool: null, jobMode: 'DRY_RUN', env: { APP_MODE: 'DRY_RUN' } }).kind, 'mock');
  assert.equal(createMessagingAdapter({ pool: null, jobMode: 'DRY_RUN', env: { APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'true' } }).kind, 'mock');
  assert.equal(createMessagingAdapter({ pool: null, jobMode: 'dry_run', env: {} }).kind, 'mock');

  assert.throws(() => createMessagingAdapter({ pool: null, jobMode: 'LIVE', env: { APP_MODE: 'LIVE' } }), (error) => error instanceof OaPolicyError && error.code === 'LIVE_MODE_LOCKED');
  assert.throws(() => createMessagingAdapter({ pool: null, jobMode: 'LIVE', env: { APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'false' } }), /disabled by default/);
  assert.throws(() => createMessagingAdapter({ pool: null, jobMode: 'LIVE', env: { APP_MODE: 'DRY_RUN', LINE_LIVE_ENABLED: 'true' } }), (error) => error instanceof OaPolicyError && error.code === 'LIVE_MODE_LOCKED');
  assert.throws(() => createMessagingAdapter({ pool: null, jobMode: 'LIVE', env: { APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'true' } }), (error) => error instanceof OaPolicyError && error.code === 'DATABASE_REQUIRED');
  assert.throws(() => createMessagingAdapter({ pool: {}, jobMode: 'LIVE', env: { APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'true', LINE_CREDENTIAL_ENCRYPTION_KEY: 'short' } }), /vault is not configured/);
  assert.throws(() => createMessagingAdapter({ pool: {}, jobMode: 'STAGING', env: { APP_MODE: 'LIVE' } }), (error) => error instanceof OaPolicyError && error.code === 'JOB_MODE_INVALID');

  const live = createMessagingAdapter({ pool: { query: async () => ({ rows: [] }) }, jobMode: 'LIVE', env: { APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'true', LINE_CREDENTIAL_ENCRYPTION_KEY: key.toString('base64') } });
  assert.equal(live.kind, 'live');
  assert.throws(() => new LiveLineMessagingAdapter(new MockTransport(), async () => null, undefined, { appMode: 'LIVE', liveEnabled: true }), (error) => error instanceof OaPolicyError && error.code === 'HTTP_TRANSPORT_REQUIRED');
});

test('live adapter decrypts the per-OA token, never sends previews, and zeroizes the buffer', async () => {
  const token = 'live-channel-access-token-value';
  const buffer = Buffer.from(token);
  const transport = fakeHttpTransport();
  const adapter = new LiveLineMessagingAdapter(transport, async ({ oaId: requestedOa, workspaceId: requestedWorkspace }) => {
    assert.equal(requestedOa, oaId);
    assert.equal(requestedWorkspace, workspaceId);
    return buffer;
  }, undefined, { appMode: 'LIVE', liveEnabled: true });
  const delivery = { id: 'd1', workspaceId, jobId: 'job-live', oaId, recipientKey: userId, idempotencyKey: 'idem', lineRetryKey: 'retry-live', status: 'PENDING', attempts: 0, createdAt: '', updatedAt: '' };
  const result = await adapter.send({ job: liveJob(), delivery, payload: buildDeliveryPayload({ recipientKey: userId, flexMessage: flex }) });
  assert.deepEqual(result, { dryRun: false, outbound: true, idempotencyKey: 'retry-live', providerStatus: 200, providerRequestId: 'req-live' });
  assert.deepEqual(transport.requests[0].body, { to: userId, messages: [flex] });
  assert.equal(transport.requests[0].token, token);
  assert.equal(transport.requests[0].endpoint, 'https://api.line.me/v2/bot/message/push');
  assert.ok(buffer.every((byte) => byte === 0), 'token buffer must be zeroized after send');

  await assert.rejects(
    () => adapter.send({ job: liveJob(), delivery, payload: buildDeliveryPayload({ recipientKey: PREVIEW_RECIPIENT, flexMessage: flex }) }),
    (error) => error instanceof OaPolicyError && error.code === 'RECIPIENT_REQUIRED'
  );
  await assert.rejects(
    () => adapter.send({ job: liveJob({ mode: 'DRY_RUN' }), delivery, payload: buildDeliveryPayload({ recipientKey: userId, flexMessage: flex }) }),
    (error) => error instanceof OaPolicyError && error.code === 'DRY_RUN_ONLY'
  );

  const failingBuffer = Buffer.from(token);
  const failing = new LiveLineMessagingAdapter(fakeHttpTransport(() => ({ status: 503, requestId: 'req-503' })), async () => failingBuffer, undefined, { appMode: 'LIVE', liveEnabled: true });
  await assert.rejects(
    () => failing.send({ job: liveJob(), delivery, payload: buildDeliveryPayload({ recipientKey: userId, flexMessage: flex }) }),
    (error) => error instanceof ProviderTransportError && error.status === 503 && error.retryable && error.uncertain && !error.message.includes(token)
  );
  assert.ok(failingBuffer.every((byte) => byte === 0), 'token buffer must be zeroized on provider errors');

  const missing = new LiveLineMessagingAdapter(fakeHttpTransport(), async () => null, undefined, { appMode: 'LIVE', liveEnabled: true });
  await assert.rejects(
    () => missing.send({ job: liveJob(), delivery, payload: buildDeliveryPayload({ recipientKey: userId, flexMessage: flex }) }),
    (error) => error instanceof OaPolicyError && error.code === 'CREDENTIAL_REFERENCE_MISSING'
  );
});

test('resolveOaAccessToken reads only the workspace-scoped STAGING vault row', async () => {
  const sealed = sealOaSecret('vault-token-value', workspaceId, oaId, 'token', key);
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rows: [{ token_sealed: sealed }] }; } };
  const buffer = await resolveOaAccessToken(pool, { workspaceId, oaId, key });
  assert.equal(buffer.toString('utf8'), 'vault-token-value');
  assert.match(calls[0].sql, /oa_credential_vault/);
  assert.match(calls[0].sql, /environment='STAGING'/);
  assert.deepEqual(calls[0].params, [workspaceId, oaId]);

  let touched = false;
  assert.equal(await resolveOaAccessToken({ async query() { touched = true; return { rows: [] }; } }, { workspaceId, oaId: 'not-a-uuid', key }), null);
  assert.equal(touched, false);
  assert.equal(await resolveOaAccessToken({ async query() { return { rows: [{ token_sealed: null }] }; } }, { workspaceId, oaId, key }), null);

  const wrongAad = sealOaSecret('vault-token-value', workspaceId, otherOaId, 'token', key);
  await assert.rejects(() => resolveOaAccessToken({ async query() { return { rows: [{ token_sealed: wrongAad }] }; } }, { workspaceId, oaId, key }));
});

const readinessBase = {
  campaignId: 'welcome',
  approvalStatus: 'APPROVED',
  systemKillSwitch: false,
  oaKillSwitch: false,
  campaignKillSwitch: false,
  quota: { limitPerMinute: 60, usedInWindow: 0, remaining: 60 },
  audience: { eligible: 2, optedOut: 0, blocked: 0 },
  canSchedule: true,
  blockers: []
};

function fakeDelivery(id, recipientKey, overrides = {}) {
  return { id, workspaceId, jobId: 'job-dry', oaId, recipientKey, idempotencyKey: `idem-${id}`, lineRetryKey: `retry-${id}`, status: 'PENDING', attempts: 0, createdAt: '', updatedAt: '', ...overrides };
}

function fakeRepo({ job, deliveries, contexts, readiness = () => readinessBase, reserve }) {
  const calls = [];
  const state = { job: { ...job, status: 'CLAIMED', attempts: (job.attempts ?? 0) + 1 }, deliveries: deliveries.map((item) => ({ ...item })), readiness };
  return {
    state,
    calls,
    async recoverStaleJobs() { calls.push(['recoverStaleJobs']); },
    async claimDueJob() { calls.push(['claimDueJob']); return { ...state.job }; },
    async getCampaignReadiness(...args) { calls.push(['getCampaignReadiness', ...args]); return state.readiness(state); },
    async markJobSending(id, workerId) { calls.push(['markJobSending', id, workerId]); state.job.status = 'SENDING'; },
    async prepareOutbox(jobId) { calls.push(['prepareOutbox', jobId]); return state.deliveries.map((item) => ({ ...item })); },
    async getDeliveryContext(deliveryId) { calls.push(['getDeliveryContext', deliveryId]); if (!contexts[deliveryId]) throw new Error('delivery context missing'); return contexts[deliveryId]; },
    async markOutboxSending(id, workerId) { calls.push(['markOutboxSending', id, workerId]); const item = state.deliveries.find((entry) => entry.id === id); item.status = 'SENDING'; item.attempts += 1; },
    async reserveDeliverySlot(input) { calls.push(['reserveDeliverySlot', input]); return reserve ? reserve(input) : { windowStartedAt: input.count ? '2026-11-01T10:00:00.000Z' : null, counted: input.count }; },
    async releaseDeliverySlot(input) { calls.push(['releaseDeliverySlot', input]); },
    async markOutboxCompleted(id, workerId, result) { calls.push(['markOutboxCompleted', id, workerId, result]); const item = state.deliveries.find((entry) => entry.id === id); item.status = 'SENT'; item.providerStatus = result.providerStatus; item.providerRequestId = result.providerRequestId; },
    async markOutboxFailure(id, workerId, error, status) { calls.push(['markOutboxFailure', id, status, error]); const item = state.deliveries.find((entry) => entry.id === id); item.status = status; item.lastError = error; },
    async markJobCompleted(id, workerId) { calls.push(['markJobCompleted', id, workerId]); state.job.status = 'COMPLETED'; return { ...state.job }; },
    async markJobFailure(id, workerId, error, retryAt) { calls.push(['markJobFailure', id, workerId, retryAt, error]); state.job.status = retryAt ? 'RETRYABLE' : 'FAILED'; state.job.lastError = error; return { ...state.job }; }
  };
}

function dryRunFixture(overrides = {}) {
  const job = liveJob({ id: 'job-dry', mode: 'DRY_RUN', ...overrides.job });
  const deliveries = [
    fakeDelivery('d1', userId),
    fakeDelivery('d2', secondUserId)
  ];
  const contexts = {
    d1: { jobId: job.id, workspaceId, oaId, campaignRevisionId: 'rev-1', recipientKey: userId, flexJson: flex },
    d2: { jobId: job.id, workspaceId, oaId, campaignRevisionId: 'rev-1', recipientKey: secondUserId, flexJson: flex }
  };
  return { job, deliveries, contexts: overrides.contexts || contexts, readiness: overrides.readiness, reserve: overrides.reserve };
}

test('worker sends every pending recipient in DRY_RUN, reserves without counting, and completes the job', async () => {
  const fixture = dryRunFixture();
  const repo = fakeRepo(fixture);
  const adapter = new MockLineMessagingAdapter();
  const now = new Date('2026-11-01T10:00:00.000Z');
  const outcome = await runWorkerOnce(repo, adapter, { jobId: 'job-dry', workerId: 'worker-test', now });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.job.status, 'COMPLETED');
  assert.deepEqual(adapter.transport.requests.map((item) => item.body), [
    { to: userId, messages: [flex] },
    { to: secondUserId, messages: [flex] }
  ]);
  assert.deepEqual(adapter.transport.requests.map((item) => item.retryKey), ['retry-d1', 'retry-d2']);
  const reservations = repo.calls.filter((call) => call[0] === 'reserveDeliverySlot');
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((call) => call[1].count === false));
  assert.equal(repo.calls.filter((call) => call[0] === 'releaseDeliverySlot').length, 0);
  assert.deepEqual(repo.state.deliveries.map((item) => item.status), ['SENT', 'SENT']);
  assert.ok(repo.calls.some((call) => call[0] === 'markJobCompleted'));
  assert.equal(repo.calls.filter((call) => call[0] === 'getCampaignReadiness').length, 3, 'policy is re-read before the job and before every recipient');
});

test('worker picks the transport from the job mode, so a DRY_RUN job cannot reach LINE on a LIVE host', async () => {
  const fixture = dryRunFixture();
  const repo = fakeRepo(fixture);
  const env = { APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'true', LINE_CREDENTIAL_ENCRYPTION_KEY: key.toString('base64') };
  const built = [];
  const outcome = await runWorkerOnce(repo, (job) => {
    const adapter = createMessagingAdapter({ pool: { query: async () => ({ rows: [] }) }, env, jobMode: job.mode });
    built.push(adapter.kind);
    return adapter;
  }, { jobId: 'job-dry', workerId: 'worker-mode-guard', now: new Date('2026-11-01T10:00:00.000Z') });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(built, ['mock']);
  assert.deepEqual(repo.calls.filter((call) => call[0] === 'reserveDeliverySlot').map((call) => call[1].count), [false, false]);
});

test('a LIVE job on a host without the release gate fails closed instead of falling back to mock', async () => {
  const job = liveJob();
  const deliveries = [fakeDelivery('d1', userId, { jobId: job.id })];
  const fixture = { job, deliveries, contexts: { d1: { jobId: job.id, workspaceId, oaId, campaignRevisionId: 'rev-1', recipientKey: userId, flexJson: flex } } };
  const repo = fakeRepo(fixture);
  const outcome = await runWorkerOnce(repo, (entry) => createMessagingAdapter({ pool: {}, env: { APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'false' }, jobMode: entry.mode }), { jobId: job.id, workerId: 'worker-gate-off', now: new Date('2026-11-01T10:00:00.000Z') });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.job.lastError, /disabled by default/);
  assert.equal(repo.calls.some((call) => call[0] === 'markOutboxSending'), false, 'no delivery is claimed when the gate is off');
});

test('worker skips already-sent deliveries so a re-run is idempotent', async () => {
  const fixture = dryRunFixture();
  fixture.deliveries[0].status = 'SENT';
  const repo = fakeRepo(fixture);
  const adapter = new MockLineMessagingAdapter();
  const outcome = await runWorkerOnce(repo, adapter, { jobId: 'job-dry', workerId: 'worker-test', now: new Date('2026-11-01T10:00:00.000Z') });
  assert.equal(outcome.status, 'completed');
  assert.equal(adapter.transport.requests.length, 1);
  assert.deepEqual(adapter.transport.requests[0].body, { to: secondUserId, messages: [flex] });
  assert.equal(repo.calls.filter((call) => call[0] === 'markOutboxSending').length, 1);
});

test('rate limiting releases nothing before reservation and schedules a retry', async () => {
  const fixture = dryRunFixture({
    reserve: () => { throw new OaPolicyError('RATE_LIMITED', 'OA per-minute delivery limit reached', true); }
  });
  const repo = fakeRepo(fixture);
  const now = new Date('2026-11-01T10:00:00.000Z');
  const outcome = await runWorkerOnce(repo, new MockLineMessagingAdapter(), { jobId: 'job-dry', workerId: 'worker-test', now });
  assert.equal(outcome.status, 'retryable');
  const failure = repo.calls.find((call) => call[0] === 'markOutboxFailure');
  assert.equal(failure[1], 'd1');
  assert.equal(failure[2], 'RETRYABLE');
  const jobFailure = repo.calls.find((call) => call[0] === 'markJobFailure');
  assert.equal(jobFailure[3].toISOString(), '2026-11-01T10:01:00.000Z');
  assert.equal(repo.calls.filter((call) => call[0] === 'releaseDeliverySlot').length, 0);
});

test('uncertain provider failures keep the reservation and become UNKNOWN without auto-retry', async () => {
  const fixture = dryRunFixture();
  const repo = fakeRepo(fixture);
  const adapter = new MockLineMessagingAdapter(new MockTransport({ status: 503, requestId: 'uncertain-request' }));
  const outcome = await runWorkerOnce(repo, adapter, { jobId: 'job-dry', workerId: 'worker-test', now: new Date('2026-11-01T10:00:00.000Z') });
  assert.equal(outcome.status, 'failed');
  const failure = repo.calls.find((call) => call[0] === 'markOutboxFailure');
  assert.equal(failure[2], 'UNKNOWN');
  assert.equal(repo.calls.filter((call) => call[0] === 'releaseDeliverySlot').length, 0, 'uncertain delivery must keep its reservation');
  const jobFailure = repo.calls.find((call) => call[0] === 'markJobFailure');
  assert.equal(jobFailure[3], null);
  assert.equal(repo.state.deliveries[0].status, 'UNKNOWN');
});

test('retryable provider failures release the reserved slot and retry with the provider delay', async () => {
  const fixture = dryRunFixture();
  const repo = fakeRepo(fixture);
  const certainFailure = { kind: 'mock', async send() { throw new ProviderTransportError(429, true, false, 'PROVIDER_RATE_LIMITED', 'rate-limited', 2000); } };
  const now = new Date('2026-11-01T10:00:00.000Z');
  const outcome = await runWorkerOnce(repo, certainFailure, { jobId: 'job-dry', workerId: 'worker-test', now });
  assert.equal(outcome.status, 'retryable');
  const release = repo.calls.find((call) => call[0] === 'releaseDeliverySlot');
  assert.deepEqual(release[1], { workspaceId, oaId, windowStartedAt: null });
  const jobFailure = repo.calls.find((call) => call[0] === 'markJobFailure');
  assert.equal(jobFailure[3].toISOString(), '2026-11-01T10:00:02.000Z');
  assert.equal(repo.calls.find((call) => call[0] === 'markOutboxFailure')[2], 'RETRYABLE');

  const uncertain429 = dryRunFixture();
  const uncertainRepo = fakeRepo(uncertain429);
  const uncertainOutcome = await runWorkerOnce(uncertainRepo, new MockLineMessagingAdapter(new MockTransport({ status: 429, requestId: 'uncertain-429' })), { jobId: 'job-dry', workerId: 'worker-test', now });
  assert.equal(uncertainOutcome.status, 'failed');
  assert.equal(uncertainRepo.calls.find((call) => call[0] === 'markOutboxFailure')[2], 'UNKNOWN');
  assert.equal(uncertainRepo.calls.filter((call) => call[0] === 'releaseDeliverySlot').length, 0);

  const stuck = dryRunFixture({ job: { attempts: 3 } });
  const stuckRepo = fakeRepo(stuck);
  const stuckAdapter = { kind: 'mock', async send() { throw new ProviderTransportError(503, true, false, 'PROVIDER_SERVER_ERROR', 'stuck-request'); } };
  const finalOutcome = await runWorkerOnce(stuckRepo, stuckAdapter, { jobId: 'job-dry', workerId: 'worker-test', now });
  assert.equal(finalOutcome.status, 'failed');
  assert.equal(stuckRepo.calls.find((call) => call[0] === 'markOutboxFailure')[2], 'FAILED');
  assert.equal(stuckRepo.calls.find((call) => call[0] === 'markJobFailure')[3], null);
});

test('kill switches are re-read before every recipient and abort mid-run', async () => {
  const fixture = dryRunFixture();
  let sent = 0;
  const repo = fakeRepo({ ...fixture, readiness: () => sent === 0 ? readinessBase : { ...readinessBase, oaKillSwitch: true, canSchedule: false, blockers: ['OA kill switch is active'] } });
  const adapter = { kind: 'mock', async send() { sent += 1; return { dryRun: true, outbound: false, idempotencyKey: 'retry-d1', providerStatus: 200 }; } };
  const outcome = await runWorkerOnce(repo, adapter, { jobId: 'job-dry', workerId: 'worker-test', now: new Date('2026-11-01T10:00:00.000Z') });
  assert.equal(outcome.status, 'failed');
  assert.equal(sent, 1);
  assert.equal(repo.state.deliveries[0].status, 'SENT');
  assert.equal(repo.state.deliveries[1].status, 'PENDING');
  assert.equal(repo.calls.filter((call) => call[0] === 'markOutboxFailure').length, 0);
  assert.equal(outcome.job.status, 'FAILED');
  assert.equal(repo.calls.filter((call) => call[0] === 'getCampaignReadiness').length, 3);
});

test('invalid payloads fail terminally before the outbox row is marked SENDING', async () => {
  const fixture = dryRunFixture();
  fixture.contexts.d1 = { ...fixture.contexts.d1, flexJson: { ...flex, altText: '  ' } };
  const repo = fakeRepo(fixture);
  const adapter = new MockLineMessagingAdapter();
  const outcome = await runWorkerOnce(repo, adapter, { jobId: 'job-dry', workerId: 'worker-test', now: new Date('2026-11-01T10:00:00.000Z') });
  assert.equal(outcome.status, 'failed');
  assert.equal(adapter.transport.requests.length, 0);
  assert.equal(repo.calls.filter((call) => call[0] === 'markOutboxSending').length, 0);
  assert.equal(repo.calls.filter((call) => call[0] === 'reserveDeliverySlot').length, 0);
  assert.equal(repo.calls.filter((call) => call[0] === 'markOutboxFailure').length, 0);
});

test('memory DRY_RUN enqueues through the same outbox pipeline', async () => {
  const previous = {
    PERSISTENCE: process.env.PERSISTENCE, APP_MODE: process.env.APP_MODE,
    LINE_LIVE_ENABLED: process.env.LINE_LIVE_ENABLED, MEMORY_ADMIN_PASSWORD: process.env.MEMORY_ADMIN_PASSWORD
  };
  process.env.PERSISTENCE = 'memory';
  process.env.APP_MODE = 'DRY_RUN';
  process.env.LINE_LIVE_ENABLED = 'false';
  process.env.MEMORY_ADMIN_PASSWORD = 'memory-test-password';
  try {
    const { createMemoryRepository } = await import('../dist/api/repository.js');
    const repo = createMemoryRepository();
    const oa = (await repo.listOas()).find((item) => item.enabled && item.environment === 'STAGING');
    assert.ok(oa);
    const job = await repo.addJob({ campaignId: 'welcome', oaId: oa.id, scheduledAt: new Date(Date.now() - 1000).toISOString(), timeZone: 'Asia/Bangkok', status: 'SCHEDULED', workspaceId: 'memory-workspace', actor: 'phase5d@test.invalid' });
    await repo.runDryRun(job.id, 'phase5d@test.invalid', 'memory-workspace');
    const outcome = await runWorkerOnce(repo, new MockLineMessagingAdapter(), { jobId: job.id, workerId: 'memory-worker', maxAttempts: 1 });
    assert.equal(outcome.status, 'completed');
    const outbox = await repo.listOutbox('memory-workspace', job.id);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].status, 'SENT');
    assert.equal(outbox[0].recipientKey, PREVIEW_RECIPIENT);
    const audit = await repo.listAudit();
    assert.ok(audit.some((event) => event.action === 'DRY_RUN_ENQUEUED' && event.target === job.id));
    assert.ok(audit.some((event) => event.action === 'WORKER_COMPLETED' && event.target === job.id));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('delivery pipeline source keeps vault-only credentials, atomic quota and operator reconciliation', () => {
  const adapter = readFileSync(new URL('../apps/api/src/lineAdapter.ts', import.meta.url), 'utf8');
  assert.match(adapter, /tokenBuffer\.fill\(0\)/);
  assert.doesNotMatch(adapter, /console\./);
  assert.doesNotMatch(adapter, /LINE_CHANNEL_SECRET/);

  const worker = readFileSync(new URL('../apps/api/src/worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /createMessagingAdapter\(/);
  assert.match(worker, /reserveDeliverySlot\(/);
  assert.match(worker, /releaseDeliverySlot\(/);
  assert.match(worker, /ProviderTransportError/);
  assert.match(worker, /readDispatchPolicy\(\)/);
  assert.doesNotMatch(worker, /new MockLineMessagingAdapter\(\).*adapter\.send/s);

  const repository = readFileSync(new URL('../apps/api/src/repository.ts', import.meta.url), 'utf8');
  assert.match(repository, /from oa_integrations where id=\$1 and workspace_id=\$2 and environment='STAGING' and enabled for update/);
  assert.match(repository, /insert into oa_rate_limit_windows/);
  assert.match(repository, /monthly_used=monthly_used\+1/);
  assert.match(repository, /greatest\(monthly_used-1,0\)/);
  assert.match(repository, /status='UNKNOWN'/);
  assert.match(repository, /'OUTBOX_RECONCILED'/);

  const server = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /outbox\/:deliveryId\/reconcile/);
  assert.match(server, /runWorkerOnce\(repo, new MockLineMessagingAdapter\(\)/);
  assert.match(server, /repo\.runDryRun\(/);

  const ledger = readFileSync(new URL('../apps/admin/src/DeliveryLedger.tsx', import.meta.url), 'utf8');
  assert.match(ledger, /UNKNOWN/);
  assert.match(ledger, /reconcile/);
  assert.match(ledger, /x-csrf-token/);
  const main = readFileSync(new URL('../apps/admin/src/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /import DeliveryLedger from '\.\/DeliveryLedger\.js'/);
  assert.match(main, /<DeliveryLedger key=\{`\$\{ledgerJob\.id\}:\$\{ledgerJob\.status\}:\$\{ledgerJob\.attempts\}`\} jobId=\{ledgerJob\.id\}/);

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(envExample, /LINE_LIVE_ENABLED=false/);
  assert.match(envExample, /LINE_CREDENTIAL_ENCRYPTION_KEY=/);
  assert.doesNotMatch(envExample, /LINE_CHANNEL_SECRET=\S/);
});
