import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const { sealOaSecret, openOaSecret } = await import('../dist/api/lineOaConnect.js');
const { rotationKeys, rotateVault } = await import('../dist/api/vaultRotate.js');
const { buildOpsAlert, buildOpsAlertBody, alertWebhookUrl, opsAlertMessage, opsAlertFormat, sendOpsAlert } = await import('../dist/api/opsNotify.js');

const workspaceA = '11111111-1111-4111-8111-111111111111';
const workspaceB = '22222222-2222-4222-8222-222222222222';
const oaA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const oaB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function credentialRow(workspaceId, oaId, key, token, secret) {
  return {
    workspace_id: workspaceId,
    oa_integration_id: oaId,
    token_sealed: sealOaSecret(token, workspaceId, oaId, 'token', key),
    secret_sealed: sealOaSecret(secret, workspaceId, oaId, 'secret', key)
  };
}

function fakePool(rows) {
  const calls = { begin: 0, commit: 0, rollback: 0, updates: [], audits: [], release: 0 };
  const client = {
    async query(sql, params = []) {
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') { calls[text] += 1; return { rows: [] }; }
      if (text.startsWith('select current_database')) return { rows: [{ name: 'line_ccc_qa' }] };
      if (text.startsWith('select workspace_id, oa_integration_id')) return { rows };
      if (text.startsWith('update oa_credential_vault')) { calls.updates.push(params); return { rowCount: 1, rows: [] }; }
      if (text.startsWith('insert into audit_log')) { calls.audits.push(params); return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected query: ${text.slice(0, 40)}`);
    },
    release() { calls.release += 1; }
  };
  return { pool: { connect: async () => client }, calls };
}

test('vault rotation is dry-run by default and leaves the database untouched', async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const rows = [
    credentialRow(workspaceA, oaA, oldKey, 'token-value-a', 'secret-value-a'),
    credentialRow(workspaceB, oaB, oldKey, 'token-value-b', 'secret-value-b')
  ];
  const { pool, calls } = fakePool(rows);
  const result = await rotateVault(pool, { oldKey, newKey });
  assert.deepEqual(result, { dryRun: true, database: 'line_ccc_qa', scanned: 2, verified: 2, updated: 0, workspaces: 2 });
  assert.equal(calls.begin, 1);
  assert.equal(calls.rollback, 1);
  assert.equal(calls.commit, 0);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.audits.length, 0);
  assert.equal(calls.release, 1);
});

test('confirmed rotation re-seals every row with the new key and writes a secret-free audit entry', async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const rows = [
    credentialRow(workspaceA, oaA, oldKey, 'token-value-a', 'secret-value-a'),
    credentialRow(workspaceB, oaB, oldKey, 'token-value-b', 'secret-value-b')
  ];
  const { pool, calls } = fakePool(rows);
  const result = await rotateVault(pool, { oldKey, newKey, dryRun: false });
  assert.deepEqual(result, { dryRun: false, database: 'line_ccc_qa', scanned: 2, verified: 2, updated: 2, workspaces: 2 });
  assert.equal(calls.commit, 1);
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.audits.length, 2);

  for (const params of calls.updates) {
    const [tokenSealed, secretSealed, workspaceId, oaId] = params;
    assert.ok(tokenSealed.startsWith('v1.') && secretSealed.startsWith('v1.'));
    assert.doesNotMatch(tokenSealed, /token-value/);
    assert.equal(openOaSecret(tokenSealed, workspaceId, oaId, 'token', newKey), `token-value-${workspaceId === workspaceA ? 'a' : 'b'}`);
    assert.equal(openOaSecret(secretSealed, workspaceId, oaId, 'secret', newKey), `secret-value-${workspaceId === workspaceA ? 'a' : 'b'}`);
    assert.throws(() => openOaSecret(tokenSealed, workspaceId, oaId, 'token', oldKey), 'the old key must no longer open rotated rows');
  }

  for (const params of calls.audits) {
    const detail = JSON.parse(params[1]);
    assert.equal(detail.credentials, 1);
    assert.ok(!JSON.stringify(detail).includes('token-value'));
    assert.ok(!JSON.stringify(detail).includes('secret-value'));
  }
});

test('rotation rolls back the whole transaction when any row cannot be opened', async () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const rows = [credentialRow(workspaceA, oaA, oldKey, 'token', 'secret')];
  rows[0].secret_sealed = rows[0].secret_sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  const { pool, calls } = fakePool(rows);
  await assert.rejects(rotateVault(pool, { oldKey, newKey, dryRun: false }), /could not be opened with the old key/);
  assert.equal(calls.rollback, 1);
  assert.equal(calls.commit, 0);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.release, 1);
});

test('rotation keys require distinct, well-formed 32-byte base64 values', () => {
  const current = randomBytes(32).toString('base64');
  const next = randomBytes(32).toString('base64');
  const keys = rotationKeys({ LINE_CREDENTIAL_ENCRYPTION_KEY: current, LINE_CREDENTIAL_ENCRYPTION_KEY_NEW: next });
  assert.equal(keys.oldKey.length, 32);
  assert.equal(keys.newKey.length, 32);
  assert.throws(() => rotationKeys({}), /LINE_CREDENTIAL_ENCRYPTION_KEY_OLD or LINE_CREDENTIAL_ENCRYPTION_KEY/);
  assert.throws(() => rotationKeys({ LINE_CREDENTIAL_ENCRYPTION_KEY: current }), /LINE_CREDENTIAL_ENCRYPTION_KEY_NEW/);
  assert.throws(() => rotationKeys({ LINE_CREDENTIAL_ENCRYPTION_KEY: current, LINE_CREDENTIAL_ENCRYPTION_KEY_NEW: current }), /must differ/);
  assert.throws(() => rotationKeys({ LINE_CREDENTIAL_ENCRYPTION_KEY: 'short', LINE_CREDENTIAL_ENCRYPTION_KEY_NEW: next }), /vault/i);
});

const healthFixture = {
  generatedAt: '2026-11-01T00:00:00.000Z',
  counts: { pending: 2, sending: 0, retryable: 0, unknown: 1, sent: 5, failed: 0, skipped: 0, stuck: 2 },
  oldestPendingSeconds: 900,
  lastWorkerActivity: null,
  workerStale: true,
  quota: [{ oaId: 'secret-oa-id', displayName: 'Secret OA Name', limitPerMinute: 10, usedThisMinute: 10, monthlyQuota: 1000, monthlyUsed: 900, monthlyPercent: 90 }],
  alerts: ['UNKNOWN_DELIVERIES', 'STUCK_DELIVERIES', 'WORKER_STALE', 'QUOTA_NEAR_LIMIT', 'OA_RATE_LIMIT_REACHED'],
  ok: false
};

test('alert payload keeps actionable counters and drops identifiers', () => {
  const payload = buildOpsAlert(healthFixture);
  assert.equal(payload.source, 'line-campaign-control-center');
  assert.deepEqual(payload.alerts, healthFixture.alerts);
  assert.deepEqual(payload.counts, healthFixture.counts);
  assert.deepEqual(payload.quota, [{ monthlyPercent: 90, usedThisMinute: 10, limitPerMinute: 10 }]);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('secret-oa-id'));
  assert.ok(!serialized.includes('Secret OA Name'));
  assert.ok(!/U[a-z0-9]{32}/.test(serialized));
});

test('alert webhook URL must be HTTPS except loopback and must not embed credentials', () => {
  assert.equal(alertWebhookUrl(''), null);
  assert.equal(alertWebhookUrl(undefined), null);
  assert.match(alertWebhookUrl('https://alerts.example.invalid/hook'), /^https:\/\/alerts\.example\.invalid\/hook$/);
  assert.match(alertWebhookUrl('http://127.0.0.1:9999/hook'), /^http:\/\/127\.0\.0\.1:9999\/hook$/);
  assert.throws(() => alertWebhookUrl('http://alerts.example.invalid/hook'), /must use HTTPS/);
  assert.throws(() => alertWebhookUrl('ftp://alerts.example.invalid/hook'), /must use HTTPS/);
  assert.throws(() => alertWebhookUrl('https://user:pass@alerts.example.invalid/hook'), /must not embed credentials/);
  assert.throws(() => alertWebhookUrl('not a url'), /not a valid URL/);
});

test('ops alert delivery reports provider status without echoing the webhook URL', async () => {
  let captured = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      captured = { method: request.method, url: request.url, contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') };
      response.writeHead(request.url === '/fail' ? 500 : 204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ok = await sendOpsAlert(`http://127.0.0.1:${port}/hook`, healthFixture);
    assert.deepEqual(ok, { delivered: true, status: 204 });
    assert.equal(captured.method, 'POST');
    assert.equal(captured.contentType, 'application/json');
    const body = JSON.parse(captured.body);
    assert.equal(body.source, 'line-campaign-control-center');
    assert.deepEqual(body.alerts, healthFixture.alerts);
    assert.ok(!captured.body.includes('secret-oa-id'));
    assert.ok(!captured.body.includes('Secret OA Name'));

    const slack = await sendOpsAlert(`http://127.0.0.1:${port}/hook`, healthFixture, { format: 'slack' });
    assert.deepEqual(slack, { delivered: true, status: 204 });
    assert.equal(typeof JSON.parse(captured.body).text, 'string');
    assert.match(JSON.parse(captured.body).text, /STUCK_DELIVERIES/);

    const failed = await sendOpsAlert(`http://127.0.0.1:${port}/fail`, healthFixture);
    assert.deepEqual(failed, { delivered: false, status: 500 });
    const unreachable = await sendOpsAlert('http://127.0.0.1:1/hook', healthFixture);
    assert.deepEqual(unreachable, { delivered: false, status: null });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('alert formats for chat channels stay aggregate-only', () => {
  const message = opsAlertMessage(healthFixture);
  assert.match(message, /UNKNOWN_DELIVERIES/);
  assert.match(message, /pending=2/);
  const slack = buildOpsAlertBody('slack', healthFixture);
  assert.deepEqual(Object.keys(slack), ['text']);
  assert.equal(slack.text, message);
  const discord = buildOpsAlertBody('discord', healthFixture);
  assert.deepEqual(Object.keys(discord), ['content']);
  assert.equal(discord.content, message);
  assert.equal(opsAlertFormat(undefined), 'generic');
  assert.equal(opsAlertFormat('Slack'), 'slack');
  assert.throws(() => opsAlertFormat('email'), /generic, slack or discord/);
  for (const serialized of [message, JSON.stringify(slack), JSON.stringify(discord)]) {
    assert.ok(!serialized.includes('Secret OA Name'));
    assert.ok(!serialized.includes('secret-oa-id'));
    assert.ok(!/U[a-z0-9]{32}/.test(serialized));
  }
});

test('CLI exposes vault rotation and alert notification with explicit opt-in', () => {
  const cli = read('apps/api/src/cli.ts');
  assert.match(cli, /command === 'rotate-vault'/);
  assert.match(cli, /const dryRun = !process\.argv\.includes\('--confirm'\)/);
  assert.match(cli, /await rotateVault\(database\.pool, \{ \.\.\.keys, dryRun \}\)/);
  assert.match(cli, /process\.argv\.includes\('--notify'\)/);
  assert.match(cli, /sendOpsAlert\(webhookUrl, health, \{ format: opsAlertFormat\(\) \}\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['vault:rotate'], 'tsx apps/api/src/cli.ts rotate-vault');
  assert.equal(pkg.scripts['test:phase5f'], 'npm run build:api && node --test tests/phase5f.test.mjs');
});

test('RLS and grant rollout stays a guarded proposal outside migrations', () => {
  const migrationFiles = fs.readdirSync(path.join(root, 'db', 'migrations'));
  assert.equal(migrationFiles.some((file) => /rls_grant|fk_supporting_indexes/.test(file)), false, 'proposal must not be an auto-applied migration');

  const rls = read('db/proposals/013_rls_grant_tier_ab.sql');
  const rlsCode = rls.replace(/--.*$/gm, '');
  assert.match(rls, /pg_roles where rolname = r/, 'browser roles must be checked before revoking');
  assert.match(rlsCode, /enable row level security/);
  assert.doesNotMatch(rlsCode, /force row level security/i, 'FORCE must wait for the dedicated app role');
  assert.doesNotMatch(rlsCode, /create policy/i, 'deny-by-default must not add browser policies');
  assert.match(rlsCode, /if s <> 'public' then/, 'PUBLIC schema usage must only be revoked for a dedicated schema');

  const indexes = read('db/proposals/013_fk_supporting_indexes.sql');
  assert.equal((indexes.match(/create index concurrently if not exists/g) || []).length, 7);
  assert.match(read('db/proposals/README.md'), /PROPOSAL ONLY|ข้อเสนอ/);

  const verify = read('db/proposals/verify-rls-grant.sql');
  const verifyCode = verify.replace(/--.*$/gm, '');
  assert.doesNotMatch(verifyCode, /\b(insert|update|delete|alter|create|drop|grant|revoke)\b/i, 'verification SQL must stay read-only');
});

