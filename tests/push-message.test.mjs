import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerPushMessageRoutes } from '../dist/api/pushMessage.js';
import { checkLineProfile, sealOaSecret } from '../dist/api/lineOaConnect.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OA_ID = '22222222-2222-4222-8222-222222222222';
const RECIPIENT = 'U' + 'a'.repeat(32);
const VAULT_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const VAULT_KEY_B64 = VAULT_KEY.toString('base64');

const sessionUser = (role = 'owner') => ({
  id: 'admin-1', workspaceId: WORKSPACE, email: 'owner@example.test', displayName: 'Owner', role
});

/**
 * The routes run against an in-memory stand-in for manual_push_requests so the
 * single-use claim (PREVIEW -> SENDING) is real, and the LINE profile lookup is
 * injected so no test reaches the network.
 */
function harness(options = {}) {
  const state = {
    oa: { id: OA_ID, display_name: 'Heekoom Staging', provider_id: 'provider-a', enabled: true, kill_switch: false, system_kill_switch: false },
    consent: options.consent ?? true,
    membership: options.membership ?? true,
    credential: options.credential ?? true,
    rows: new Map(),
    queries: [],
    slotCount: null,
    env: options.env || { APP_MODE: 'DRY_RUN' }
  };
  if (options.oa) Object.assign(state.oa, options.oa);

  const pool = {
    async query(sql, args = []) {
      state.queries.push({ sql, args });
      if (sql.includes('from workspace_memberships')) return { rowCount: state.membership ? 1 : 0, rows: [] };
      if (sql.includes('from oa_integrations oa left join workspace_controls')) return { rowCount: 1, rows: [state.oa] };
      if (sql.includes('from customers where workspace_id')) return { rowCount: state.consent ? 1 : 0, rows: [] };
      if (sql.includes('from oa_credential_vault')) {
        if (!state.credential) return { rowCount: 0, rows: [] };
        const sealed = sealOaSecret('line-channel-token', WORKSPACE, OA_ID, 'token', VAULT_KEY);
        return { rowCount: 1, rows: [{ token_sealed: sealed }] };
      }
      if (sql.startsWith('insert into manual_push_requests')) {
        const row = {
          id: '33333333-3333-4333-8333-333333333333', workspace_id: args[0], oa_integration_id: args[1],
          requested_by: args[2], recipient_key: args[3], message_text: args[4], mode: args[5],
          status: 'PREVIEW', line_retry_key: args[6], recipient_display_name: args[7],
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString()
        };
        state.rows.set(row.id, row);
        return { rowCount: 1, rows: [{ id: row.id, expires_at: row.expires_at }] };
      }
      if (sql.includes("set status='SENDING'")) {
        const row = state.rows.get(args[0]);
        const claimable = row && row.status === 'PREVIEW' && row.workspace_id === args[1] && row.requested_by === args[2]
          && new Date(row.expires_at).getTime() > Date.now();
        if (!claimable) return { rowCount: 0, rows: [] };
        row.status = 'SENDING';
        return { rowCount: 1, rows: [{ ...row }] };
      }
      if (sql.includes('update manual_push_requests set')) {
        const row = state.rows.get(args[0]);
        if (row) {
          const literal = /set status='([A-Z_]+)'/.exec(sql)?.[1];
          row.status = literal || args[1];
          if (sql.includes('last_error=$2')) row.last_error = args[1];
          if (sql.includes('last_error=$3')) row.last_error = args[2];
          if (sql.includes('provider_status=$2')) { row.provider_status = args[1]; row.provider_request_id = args[2]; row.provider_message_id = args[3]; }
          if (sql.includes('provider_status=$4')) { row.provider_status = args[3]; row.provider_request_id = args[4]; }
        }
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from manual_push_requests where workspace_id')) {
        return {
          rowCount: state.rows.size,
          rows: [...state.rows.values()].map((row) => ({
            id: row.id, recipient_key: row.recipient_key, message_text: row.message_text, mode: row.mode,
            status: row.status, provider_status: row.provider_status ?? null, provider_request_id: row.provider_request_id ?? null,
            provider_message_id: row.provider_message_id ?? null, recipient_display_name: row.recipient_display_name,
            last_error: row.last_error ?? null, oa_integration_id: row.oa_integration_id,
            created_at: new Date().toISOString(), confirmed_at: null
          }))
        };
      }
      return { rowCount: 1, rows: [] };
    }
  };

  const repo = {
    async reserveDeliverySlot(input) { state.slotCount = input.count; return { windowStartedAt: new Date().toISOString(), counted: input.count }; },
    async releaseDeliverySlot() { return true; }
  };

  const app = Fastify();
  const requireUser = async (request) => { request.user = sessionUser(options.role); };
  const requireCsrf = (request, reply) => {
    if (request.headers['x-csrf-token'] !== 'valid-csrf') return reply.code(403).send({ error: 'csrf required' });
  };
  registerPushMessageRoutes(app, pool, repo, requireUser, requireCsrf, state.env, options.profileCheck || (async () => ({ reachable: true, displayName: 'คุณลูกค้า' })));
  return { app, state, pool };
}

const csrfHeaders = { 'x-csrf-token': 'valid-csrf', 'content-type': 'application/json' };
const previewPayload = { oaId: OA_ID, recipient: RECIPIENT, text: 'สวัสดีครับ มีโปรโมชั่นพิเศษสำหรับคุณ' };

async function preview(app, body = previewPayload, headers = csrfHeaders) {
  return app.inject({ method: 'POST', url: '/api/messages/push/preview', payload: body, headers });
}
async function send(app, body, headers = csrfHeaders) {
  return app.inject({ method: 'POST', url: '/api/messages/push/send', payload: body, headers });
}
const liveEnv = () => ({ APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'true', LINE_CREDENTIAL_ENCRYPTION_KEY: VAULT_KEY_B64 });

test('preview stores a DRY_RUN request and refuses a malformed message', async () => {
  const { app, state } = harness();
  const response = await preview(app);
  assert.equal(response.statusCode, 201);
  const data = response.json();
  assert.equal(data.mode, 'DRY_RUN');
  assert.equal(data.confirmWord, 'SEND');
  assert.equal(data.recipientName, null);
  assert.ok(data.previewId);
  assert.equal(state.rows.get(data.previewId).status, 'PREVIEW');
  assert.equal(state.queries.some((item) => item.sql.includes('insert into audit_log')), true);

  for (const body of [
    { ...previewPayload, recipient: '@' + 'a'.repeat(32) },
    { ...previewPayload, recipient: 'U' + 'z'.repeat(32) },
    { ...previewPayload, text: '   ' },
    { ...previewPayload, text: 'ก'.repeat(5001) }
  ]) {
    const bad = await preview(app, body);
    assert.equal(bad.statusCode, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(bad.json().code, 'MESSAGE_INVALID');
  }
  assert.equal((await preview(app, { ...previewPayload, recipient: 'Uabc' })).statusCode, 400);
  assert.equal(state.rows.size, 1, 'only the valid preview is stored');
});

test('preview enforces kill switches, OA state, consent, role and CSRF', async () => {
  const cases = [
    { options: { oa: { kill_switch: true } }, code: 'KILL_SWITCH_ACTIVE' },
    { options: { oa: { system_kill_switch: true } }, code: 'KILL_SWITCH_ACTIVE' },
    { options: { oa: { enabled: false } }, code: 'OA_DISABLED' },
    { options: { consent: false }, code: 'CONSENT_REQUIRED' },
    { options: { role: 'viewer' }, code: 'ROLE_REQUIRED' },
    { options: { membership: false }, code: 'MEMBERSHIP_INACTIVE' }
  ];
  for (const item of cases) {
    const { app, state } = harness(item.options);
    const response = await preview(app);
    assert.notEqual(response.statusCode, 201, item.code);
    assert.equal(response.json().code, item.code);
    assert.equal(state.rows.size, 0, item.code);
  }
  const noCsrf = harness();
  const csrfBlocked = await preview(noCsrf.app, previewPayload, { 'content-type': 'application/json' });
  assert.equal(csrfBlocked.statusCode, 403);
  assert.equal(noCsrf.state.rows.size, 0);
});

test('send requires the typed SEND word and only runs once per preview', async () => {
  const { app, state } = harness();
  const previewId = (await preview(app)).json().previewId;

  for (const confirm of ['send', 'Yes', 'SEND ']) {
    const refused = await send(app, { previewId, confirm });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().code, 'CONFIRMATION_REQUIRED');
  }
  assert.equal((await send(app, { previewId })).statusCode, 400, 'the confirm word is required by the schema');
  assert.equal(state.rows.get(previewId).status, 'PREVIEW');

  const sent = await send(app, { previewId, confirm: 'SEND' });
  assert.equal(sent.statusCode, 200);
  const result = sent.json();
  assert.equal(result.status, 'SENT');
  assert.equal(result.outbound, false, 'DRY_RUN must not call LINE');
  assert.equal(result.providerStatus, 200);
  assert.equal(state.rows.get(previewId).status, 'SENT');
  assert.equal(state.slotCount, false, 'DRY_RUN must not consume the live quota slot');
  assert.deepEqual(state.queries.find((item) => item.sql.includes("set status='SENDING'")).args, [previewId, WORKSPACE, 'owner@example.test']);

  const replay = await send(app, { previewId, confirm: 'SEND' });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().code, 'PREVIEW_STALE');
});

test('expired preview cannot be sent', async () => {
  const { app, state } = harness();
  const previewId = (await preview(app)).json().previewId;
  state.rows.get(previewId).expires_at = new Date(Date.now() - 1000).toISOString();
  const expired = await send(app, { previewId, confirm: 'SEND' });
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().code, 'PREVIEW_STALE');
  assert.equal(state.rows.get(previewId).status, 'PREVIEW');
});

test('a guard that appears at send time blocks the row instead of sending', async () => {
  const { app, state } = harness();
  const previewId = (await preview(app)).json().previewId;
  state.consent = false;
  const blocked = await send(app, { previewId, confirm: 'SEND' });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, 'CONSENT_REQUIRED');
  assert.equal(state.rows.get(previewId).status, 'BLOCKED');
  assert.equal(state.slotCount, null, 'a blocked send must not reserve a quota slot');
});

test('live mode requires the release gate and a reachable recipient', async () => {
  const gateOff = harness({ env: { APP_MODE: 'LIVE', LINE_LIVE_ENABLED: 'false' } });
  const refused = await preview(gateOff.app);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'LIVE_GATE_OFF');

  const live = harness({ env: liveEnv() });
  const ok = await preview(live.app);
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().mode, 'LIVE');
  assert.equal(ok.json().recipientName, 'คุณลูกค้า');
  assert.equal(live.state.rows.get(ok.json().previewId).recipient_display_name, 'คุณลูกค้า');

  const unreachable = harness({ env: liveEnv(), profileCheck: async () => ({ reachable: false }) });
  const blockedProfile = await preview(unreachable.app);
  assert.equal(blockedProfile.statusCode, 409);
  assert.equal(blockedProfile.json().code, 'RECIPIENT_UNREACHABLE');
  assert.equal(unreachable.state.rows.size, 0);

  const failing = harness({ env: liveEnv(), profileCheck: async () => { throw new Error('LINE API unreachable'); } });
  const checkFailed = await preview(failing.app);
  assert.equal(checkFailed.statusCode, 502);
  assert.equal(checkFailed.json().code, 'PROFILE_CHECK_FAILED');

  const noCredential = harness({ env: liveEnv(), credential: false });
  const missingToken = await preview(noCredential.app);
  assert.equal(missingToken.statusCode, 409);
  assert.equal(missingToken.json().code, 'CREDENTIAL_REFERENCE_MISSING');
});

test('runtime mode change after a preview blocks the send', async () => {
  const { app, state } = harness();
  const previewId = (await preview(app)).json().previewId;
  Object.assign(state.env, liveEnv());
  const stale = await send(app, { previewId, confirm: 'SEND' });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'PREVIEW_BLOCKED');
  assert.equal(state.rows.get(previewId).status, 'BLOCKED');
});

test('history lists workspace pushes without credentials', async () => {
  const { app } = harness();
  const previewId = (await preview(app)).json().previewId;
  await send(app, { previewId, confirm: 'SEND' });
  const history = await app.inject({ method: 'GET', url: '/api/messages/push/history' });
  assert.equal(history.statusCode, 200);
  const rows = history.json().pushes;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'SENT');
  assert.equal(rows[0].mode, 'DRY_RUN');
  assert.equal(rows[0].providerRequestId, 'mock-request');
  assert.equal(history.body.includes('token'), false);
});

test('checkLineProfile only reads the fixed profile endpoint', async () => {
  const knownId = 'U' + '0'.repeat(32);
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith(knownId)) return { status: 200, ok: true, json: async () => ({ displayName: 'คุณลูกค้า', userId: knownId }) };
    return { status: 404, ok: false, json: async () => ({}) };
  };
  assert.deepEqual(await checkLineProfile('token-value', knownId, transport), { reachable: true, displayName: 'คุณลูกค้า' });
  assert.deepEqual(await checkLineProfile('token-value', RECIPIENT, transport), { reachable: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-value');
  assert.ok(calls[0].url.startsWith('https://api.line.me/v2/bot/profile/'));

  for (const bad of ['', 'a'.repeat(5000), 'token\nX']) await assert.rejects(() => checkLineProfile(bad, RECIPIENT, transport), /invalid access token/);
  for (const bad of ['', '@heekoom', 'U' + 'z'.repeat(32)]) await assert.rejects(() => checkLineProfile('token-value', bad, transport), /invalid LINE userId/);
  await assert.rejects(() => checkLineProfile('token-value', RECIPIENT, async () => { throw new Error('network'); }), /unreachable/);
  await assert.rejects(() => checkLineProfile('token-value', RECIPIENT, async () => ({ status: 401, ok: false, json: async () => ({}) })), /rejected the channel access token/);
  await assert.rejects(() => checkLineProfile('token-value', RECIPIENT, async () => ({ status: 500, ok: false, json: async () => ({}) })), /profile check failed/);
  await assert.rejects(() => checkLineProfile('token-value', RECIPIENT, async () => ({ status: 200, ok: true, json: async () => ({ displayName: '' }) })), /invalid LINE profile/);
});
