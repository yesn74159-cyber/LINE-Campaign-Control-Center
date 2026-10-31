import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import {
  LineWebhookError,
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_EVENTS,
  markOaChannelVerified,
  parseLineWebhookBody,
  registerLineWebhookRoutes,
  resolveOaWebhookSecret
} from '../dist/api/lineWebhook.js';
import { sealOaSecret } from '../dist/api/lineOaConnect.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const oaId = '22222222-2222-4222-8222-222222222222';
const otherOaId = '33333333-3333-4333-8333-333333333333';
const key = randomBytes(32);
const secret = 'd'.repeat(32);
const identityKey = 'i'.repeat(32);

function signature(raw, channelSecret) {
  return createHmac('sha256', channelSecret).update(raw).digest('base64');
}

function fakePool({ rows = [], updateCount = 1, onQuery } = {}) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({ kind: 'query', sql, params });
        if (onQuery) return onQuery(sql, params);
        return { rowCount: rows.length, rows };
      },
      async connect() {
        return {
          async query(sql, params = []) {
            calls.push({ kind: 'client', sql, params });
            if (sql === 'begin' || sql === 'commit') return { rowCount: 0, rows: [] };
            if (sql.startsWith('rollback')) return { rowCount: 0, rows: [] };
            if (sql.includes('update workspace_oa_channels')) return { rowCount: updateCount, rows: updateCount ? [{ id: oaId }] : [] };
            return { rowCount: 1, rows: [] };
          },
          release() {}
        };
      }
    }
  };
}

function webhookApp(pool, repo, options = {}) {
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.raw.rawBody = String(body);
    try { done(null, JSON.parse(String(body))); } catch { done(new Error('invalid JSON body')); }
  });
  registerLineWebhookRoutes(app, {
    repo,
    pool,
    enabled: true,
    fallbackChannelSecret: 'environment-fallback-secret',
    identityHashKey: identityKey,
    ...options
  });
  return app;
}

test('webhook parser keeps only routing fields and rejects malformed events', () => {
  const raw = JSON.stringify({
    events: [{
      webhookEventId: '01HX-event-1', type: 'follow', timestamp: 1730000000000,
      source: { userId: 'U1234567890', type: 'user', displayName: 'do not keep' },
      message: { text: 'do not keep' }
    }]
  });
  assert.deepEqual(parseLineWebhookBody(raw, JSON.parse(raw)), [
    { webhookEventId: '01HX-event-1', type: 'follow', timestamp: 1730000000000, userId: 'U1234567890' }
  ]);
  assert.deepEqual(parseLineWebhookBody(JSON.stringify({ events: [] }), { events: [] }), []);
  assert.deepEqual(parseLineWebhookBody(JSON.stringify({ events: [{ webhookEventId: 'e1', type: 'message' }] }), { events: [{ webhookEventId: 'e1', type: 'message' }] }), [
    { webhookEventId: 'e1', type: 'message' }
  ]);

  const invalid = [
    [null, 'invalid webhook body'],
    [{}, 'invalid webhook body'],
    [{ events: 'nope' }, 'invalid webhook body'],
    [{ events: [{ type: 'follow', source: { userId: 'U1' } }] }, 'invalid webhook event id'],
    [{ events: [{ webhookEventId: 'bad id', type: 'follow', source: { userId: 'U1' } }] }, 'invalid webhook event id'],
    [{ events: [{ webhookEventId: 'e1', type: 'bad-type' }] }, 'invalid webhook event type'],
    [{ events: [{ webhookEventId: 'e1', type: 'follow' }] }, 'missing a source'],
    [{ events: [{ webhookEventId: 'e1', type: 'follow', source: { userId: 'bad user' } }] }, 'invalid webhook event source'],
    [{ events: [{ webhookEventId: 'e1', type: 'message', timestamp: 'now' }] }, 'invalid webhook event timestamp']
  ];
  for (const [body, message] of invalid) assert.throws(() => parseLineWebhookBody(JSON.stringify(body), body), new RegExp(message));

  const tooMany = { events: Array.from({ length: MAX_WEBHOOK_EVENTS + 1 }, (_, index) => ({ webhookEventId: `e${index}`, type: 'message' })) };
  assert.throws(() => parseLineWebhookBody(JSON.stringify(tooMany), tooMany), /too many webhook events/);
  const oversized = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1);
  assert.throws(() => parseLineWebhookBody(oversized, { events: [] }), error => error instanceof LineWebhookError && error.statusCode === 413);
});

test('per-OA webhook secret is decrypted from the vault and never falls back to the environment in PostgreSQL mode', async () => {
  const sealed = sealOaSecret(secret, workspaceId, oaId, 'secret', key);
  const resolvedPool = fakePool({ rows: [{ workspace_id: workspaceId, secret_sealed: sealed }] });
  assert.deepEqual(await resolveOaWebhookSecret(resolvedPool.pool, oaId, key), { workspaceId, secret });
  assert.match(resolvedPool.calls[0].sql, /oa_credential_vault/);
  assert.match(resolvedPool.calls[0].sql, /environment='STAGING'/);

  const missingVault = fakePool({ rows: [{ workspace_id: workspaceId, secret_sealed: null }] });
  assert.deepEqual(await resolveOaWebhookSecret(missingVault.pool, oaId, key), { workspaceId, secret: null });

  const unknownOa = fakePool({ rows: [] });
  assert.equal(await resolveOaWebhookSecret(unknownOa.pool, oaId, key), null);

  let touched = false;
  const invalidId = await resolveOaWebhookSecret({ async query() { touched = true; return { rows: [] }; } }, 'not-a-uuid', key);
  assert.equal(invalidId, null);
  assert.equal(touched, false);

  const wrongAad = sealOaSecret(secret, workspaceId, otherOaId, 'secret', key);
  await assert.rejects(() => resolveOaWebhookSecret(fakePool({ rows: [{ workspace_id: workspaceId, secret_sealed: wrongAad }] }).pool, oaId, key));

  const repo = { calls: [], async acceptWebhook(input) { this.calls.push(input); return { accepted: true, duplicate: false }; } };
  const noVaultSecret = fakePool({ rows: [{ workspace_id: workspaceId, secret_sealed: null }] });
  const app = webhookApp(noVaultSecret.pool, repo);
  const originalKey = process.env.LINE_CREDENTIAL_ENCRYPTION_KEY;
  process.env.LINE_CREDENTIAL_ENCRYPTION_KEY = key.toString('base64');
  try {
    const raw = JSON.stringify({ events: [{ webhookEventId: 'e1', type: 'message' }] });
    const response = await app.inject({
      method: 'POST', url: `/api/webhooks/line/${oaId}`,
      headers: { 'content-type': 'application/json', 'x-line-signature': signature(raw, 'environment-fallback-secret') },
      payload: raw
    });
    assert.equal(response.statusCode, 503);
    assert.equal(repo.calls.length, 0);

    const unknownApp = webhookApp(fakePool({ rows: [] }).pool, repo);
    try {
      const unknown = await unknownApp.inject({
        method: 'POST', url: `/api/webhooks/line/${oaId}`,
        headers: { 'content-type': 'application/json', 'x-line-signature': signature(raw, 'environment-fallback-secret') },
        payload: raw
      });
      assert.equal(unknown.statusCode, 404);
      assert.equal(repo.calls.length, 0);
    } finally { await unknownApp.close(); }

    const disabledApp = webhookApp(fakePool({ rows: [] }).pool, repo, { enabled: false });
    try {
      const disabled = await disabledApp.inject({
        method: 'POST', url: `/api/webhooks/line/${oaId}`,
        headers: { 'content-type': 'application/json', 'x-line-signature': signature(raw, 'environment-fallback-secret') },
        payload: raw
      });
      assert.equal(disabled.statusCode, 503);
    } finally { await disabledApp.close(); }
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.LINE_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.LINE_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  }
});

test('valid signed PG webhook marks the channel VERIFIED, passes consent only for follow/unfollow, and dedupes', async () => {
  const sealed = sealOaSecret(secret, workspaceId, oaId, 'secret', key);
  const db = fakePool({ rows: [{ workspace_id: workspaceId, secret_sealed: sealed }], updateCount: 1 });
  const seen = new Set();
  const repo = {
    calls: [],
    async acceptWebhook(input) {
      this.calls.push(input);
      const duplicate = seen.has(input.eventId);
      seen.add(input.eventId);
      return { accepted: true, duplicate };
    }
  };
  const app = webhookApp(db.pool, repo);
  const originalKey = process.env.LINE_CREDENTIAL_ENCRYPTION_KEY;
  process.env.LINE_CREDENTIAL_ENCRYPTION_KEY = key.toString('base64');
  try {
    const raw = JSON.stringify({ events: [
      { webhookEventId: 'e1', type: 'message' },
      { webhookEventId: 'e2', type: 'unfollow', source: { userId: 'U999' } }
    ] });
    const first = await app.inject({
      method: 'POST', url: `/api/webhooks/line/${oaId}`,
      headers: { 'content-type': 'application/json', 'x-line-signature': signature(raw, secret) },
      payload: raw
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { accepted: true, eventCount: 2, duplicates: 0 });
    assert.equal(repo.calls[0].lineUserKey, undefined);
    assert.equal(repo.calls[1].lineUserKey, 'U999');
    assert.equal(repo.calls[0].eventType, 'message');
    assert.equal(repo.calls[1].eventType, 'unfollow');
    assert.match(repo.calls[0].payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(repo.calls[0].payloadHash, repo.calls[1].payloadHash);

    const verifiedUpdate = db.calls.find(call => call.kind === 'client' && call.sql.includes('update workspace_oa_channels'));
    assert.ok(verifiedUpdate);
    assert.match(verifiedUpdate.sql, /status='VERIFIED'/);
    assert.match(verifiedUpdate.sql, /messaging_channel_id is not null/);
    assert.match(verifiedUpdate.sql, /verified_at=now\(\)/);
    const audit = db.calls.find(call => call.kind === 'client' && call.sql.includes('OA_CHANNEL_VERIFIED'));
    assert.ok(audit);
    assert.equal(audit.params[0], workspaceId);
    assert.equal(audit.params[1], oaId);
    assert.equal(JSON.stringify(audit.params).includes(secret), false);

    const replay = JSON.stringify({ events: [{ webhookEventId: 'e1', type: 'message' }] });
    const second = await app.inject({
      method: 'POST', url: `/api/webhooks/line/${oaId}`,
      headers: { 'content-type': 'application/json', 'x-line-signature': signature(replay, secret) },
      payload: replay
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().duplicates, 1);

    const tampered = await app.inject({
      method: 'POST', url: `/api/webhooks/line/${oaId}`,
      headers: { 'content-type': 'application/json', 'x-line-signature': signature(raw, 'wrong-secret') },
      payload: raw
    });
    assert.equal(tampered.statusCode, 401);

    const malformed = JSON.stringify({ events: [{ type: 'follow' }] });
    const invalidShape = await app.inject({
      method: 'POST', url: `/api/webhooks/line/${oaId}`,
      headers: { 'content-type': 'application/json', 'x-line-signature': signature(malformed, secret) },
      payload: malformed
    });
    assert.equal(invalidShape.statusCode, 400);
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.LINE_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.LINE_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  }
});

test('channel verification is audited only on the first transition and consent SQL blocks unfollows', async () => {
  const first = fakePool({ updateCount: 1 });
  assert.equal(await markOaChannelVerified(first.pool, { workspaceId, oaId }), true);
  assert.ok(first.calls.some(call => call.kind === 'client' && call.sql.includes('OA_CHANNEL_VERIFIED')));

  const second = fakePool({ updateCount: 0 });
  assert.equal(await markOaChannelVerified(second.pool, { workspaceId, oaId }), false);
  assert.equal(second.calls.some(call => call.kind === 'client' && call.sql.includes('OA_CHANNEL_VERIFIED')), false);

  const repository = readFileSync(new URL('../apps/api/src/repository.ts', import.meta.url), 'utf8');
  assert.match(repository, /insert into customers \(workspace_id, provider_id, line_user_key, opt_in, blocked_at\) values \(\$1,\$2,\$3,false,now\(\)\)/);
  assert.match(repository, /do update set opt_in=false, blocked_at=now\(\)/);

  const server = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /registerLineWebhookRoutes\(app/);
  assert.match(server, /pool: selected\.database\?\.pool \?\? null/);
  assert.match(server, /enabled: process\.env\.LINE_WEBHOOK_ENABLED === 'true'/);
  assert.match(server, /fallbackChannelSecret: selected\.database\?\.pool \? undefined : process\.env\.LINE_CHANNEL_SECRET/);

  const webhook = readFileSync(new URL('../apps/api/src/lineWebhook.ts', import.meta.url), 'utf8');
  assert.match(webhook, /oa_credential_vault/);
  assert.match(webhook, /openOaSecret\(/);
  assert.match(webhook, /OA_CHANNEL_VERIFIED/);
  assert.match(webhook, /createFixedWindowLimiter/);
  assert.match(webhook, /event\.type === 'follow' \|\| event\.type === 'unfollow' \? event\.userId : undefined/);
  assert.doesNotMatch(webhook, /process\.env\.LINE_CHANNEL_SECRET/);

  const ui = readFileSync(new URL('../apps/admin/src/ConnectLineOa.tsx', import.meta.url), 'utf8');
  assert.match(ui, /ยืนยัน signed webhook แล้ว/);
});
