import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  REFERRAL_TOKEN_PATTERN,
  ReferralError,
  createReferral,
  hashReferralToken,
  listReferrals,
  recordClick,
  referralDashboard,
  referralUrl,
  setReferralStatus,
  verifyReferralFollow
} from '../dist/api/referralStore.js';

const uuid = '11111111-2222-4333-8444-555555555555';
const unreachable = {
  connect() { throw new Error('database must not be touched for invalid input'); },
  query() { throw new Error('database must not be touched for invalid input'); }
};

test('referral tokens are 32 random bytes, hashed with SHA-256, and exposed only in the share URL', () => {
  const plain = randomBytes(32).toString('base64url');
  assert.equal(plain.length, 43);
  assert.match(plain, REFERRAL_TOKEN_PATTERN);
  const digest = hashReferralToken(plain);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, hashReferralToken(plain));
  assert.notEqual(digest, plain);
  assert.equal(REFERRAL_TOKEN_PATTERN.test('not-a-referral-token'), false);

  const previous = process.env.PUBLIC_APP_ORIGIN;
  process.env.PUBLIC_APP_ORIGIN = 'http://127.0.0.1:5173/';
  try {
    assert.equal(referralUrl(plain), `http://127.0.0.1:5173/r/${plain}`);
    process.env.PUBLIC_APP_ORIGIN = 'ftp://127.0.0.1:5173';
    assert.throws(() => referralUrl(plain), error => error instanceof ReferralError && error.statusCode === 500);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = previous;
  }
});

test('invalid referral input is rejected before touching PostgreSQL', async () => {
  await assert.rejects(
    () => createReferral(unreachable, { workspaceId: uuid, staffId: 'not-a-uuid', oaId: uuid, actor: 'owner@example.test' }),
    /staffId is invalid/
  );
  await assert.rejects(
    () => createReferral(unreachable, { workspaceId: uuid, staffId: uuid, oaId: uuid, actor: 'owner@example.test', expiresAt: '2000-01-01T00:00:00.000Z' }),
    /expiresAt must be in the future/
  );
  await assert.rejects(
    () => createReferral(unreachable, { workspaceId: uuid, staffId: uuid, oaId: uuid, actor: 'owner@example.test', expiresAt: '2999-01-01T00:00:00.000Z' }),
    /within 366 days/
  );
  await assert.rejects(() => listReferrals(unreachable, uuid, { staffId: 'bad' }), /staffId is invalid/);
  await assert.rejects(() => setReferralStatus(unreachable, uuid, uuid, 'BOGUS', 'owner@example.test'), /status is invalid/);
  await assert.rejects(() => recordClick(unreachable, 'too-short'), error => error instanceof ReferralError && error.statusCode === 404);
  await assert.rejects(() => referralDashboard(unreachable, uuid, { from: 'not-a-date' }), /from must be a valid ISO date/);
  await assert.rejects(
    () => verifyReferralFollow(unreachable, { oaId: uuid, eventId: 'event-1', followerSubjectHmac: 'bad', evidenceRef: 'line-webhook:event-1' }),
    /follow subject digest is invalid/
  );
  await assert.rejects(
    () => verifyReferralFollow(unreachable, { oaId: uuid, eventId: '', followerSubjectHmac: 'a'.repeat(64), evidenceRef: 'line-webhook:event-1' }),
    /evidence event id is invalid/
  );
});

test('PostgreSQL referral wiring keeps tokens hashed and verifies follow evidence from a signed webhook', () => {
  const schema = readFileSync(new URL('../db/migrations/008_multitenant_foundation.sql', import.meta.url), 'utf8');
  assert.match(schema, /create table if not exists staff_invite_links/i);
  assert.match(schema, /token_hash text not null unique check \(token_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(schema, /create table if not exists referral_attribution_events/i);
  assert.match(schema, /referral_one_verified_follow_per_oa/i);
  assert.doesNotMatch(schema, /\b(?:access_token|channel_secret|plain_token)\b/i);

  const evidenceSchema = readFileSync(new URL('../db/migrations/010_referral_reporting_indexes.sql', import.meta.url), 'utf8');
  assert.match(evidenceSchema, /evidence_event_id/i);
  assert.match(evidenceSchema, /referral_evidence_event_unique/i);

  const lineLogin = readFileSync(new URL('../apps/api/src/lineLoginPostgresStore.ts', import.meta.url), 'utf8');
  assert.match(lineLogin, /attributedInviteLinkId/);
  assert.match(lineLogin, /referral_attribution_events/);

  const server = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /registerReferralRoutes\(app, pool/);
  assert.match(server, /registerLineWebhookRoutes\(app/);
  assert.match(server, /LINE_IDENTITY_HASH_KEY/);

  const webhook = readFileSync(new URL('../apps/api/src/lineWebhook.ts', import.meta.url), 'utf8');
  assert.match(webhook, /verifyReferralFollow\(options\.pool/);
  assert.match(webhook, /event\.type === 'follow'/);

  const routes = readFileSync(new URL('../apps/api/src/referralRoutes.ts', import.meta.url), 'utf8');
  assert.match(routes, /\/api\/referrals\/:token\/click/);
  assert.match(routes, /referral link management requires owner or admin/);
  assert.match(routes, /too many referral clicks/);
});
