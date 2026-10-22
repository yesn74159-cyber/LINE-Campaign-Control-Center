import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.PERSISTENCE = 'memory';
process.env.APP_MODE = 'DRY_RUN';
process.env.MEMORY_ADMIN_PASSWORD = 'local-memory-password-123';
process.env.MEMORY_ADMIN_EMAIL = 'owner@mock.local';
process.env.LINE_WEBHOOK_ENABLED = 'false';
process.env.LINE_LIVE_ENABLED = 'false';
process.env.PUBLIC_APP_ORIGIN = 'http://127.0.0.1:5173';

const { buildApp } = await import('../dist/api/server.js');
const { CampaignMockStore, mockWebhookSignature } = await import('../dist/api/campaignMock.js');
let app;

function cookies(response) { return (response.headers['set-cookie'] || []).map(value => value.split(';', 1)[0]).join('; '); }
function csrf(cookie) { return cookie.split('; ').find(value => value.startsWith('ccc_csrf='))?.slice('ccc_csrf='.length); }
async function json(response) { return response.json(); }

before(async () => { app = buildApp(); await app.ready(); });
after(async () => { await app.close(); });

test('local mock completes owner to verified-follow flow without raw identity or token persistence', async () => {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@mock.local', password: process.env.MEMORY_ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = cookies(login); const token = csrf(cookie);
  const invited = await app.inject({ method: 'POST', url: '/api/workspace/members', headers: { cookie, 'x-csrf-token': token }, payload: { email: 'staff@mock.local', displayName: 'Mock Staff', role: 'editor' } });
  assert.equal(invited.statusCode, 201, invited.body);
  const staff = invited.json();
  const referralResponse = await app.inject({ method: 'POST', url: '/api/referrals', headers: { cookie, 'x-csrf-token': token }, payload: { staffId: staff.id, oaId: 'oa-staging-primary' } });
  assert.equal(referralResponse.statusCode, 201, referralResponse.body);
  const created = referralResponse.json();
  assert.match(created.url, /\/r\/[A-Za-z0-9_-]{40,}$/);
  assert.doesNotMatch(JSON.stringify(created.referral), /tokenHash|plainToken|MOCK/);
  const publicToken = new URL(created.url).pathname.split('/').pop();

  const click = await app.inject({ method: 'POST', url: `/api/referrals/${publicToken}/click` });
  assert.equal(click.statusCode, 200, click.body);
  const start = await app.inject({ method: 'POST', url: '/api/line-login/mock/start', payload: { referralToken: publicToken } });
  assert.equal(start.statusCode, 200, start.body);
  const loginStart = start.json();
  const callbackPayload = { state: loginStart.state, nonce: loginStart.nonce, idToken: { iss: loginStart.issuer, aud: loginStart.audience, exp: Math.floor(Date.now() / 1000) + 300, nonce: loginStart.nonce, sub: 'mock-subject-flow-1', signature: 'MOCK_VALID' } };
  const callback = await app.inject({ method: 'POST', url: '/api/line-login/mock/callback', payload: callbackPayload });
  assert.equal(callback.statusCode, 200, callback.body);
  assert.equal(callback.json().identity, 'HMAC_STORED_ONLY');
  const replay = await app.inject({ method: 'POST', url: '/api/line-login/mock/callback', payload: callbackPayload });
  assert.equal(replay.statusCode, 400);

  const evidence = { referralId: created.referral.id, eventId: 'mock-follow-event-1', followerSubject: 'mock-subject-flow-1', evidenceRef: 'mock-evidence-1', eventType: 'follow' };
  const raw = JSON.stringify(evidence);
  const forged = await app.inject({ method: 'POST', url: '/api/mock/webhook/follow', headers: { 'x-mock-signature': 'forged' }, payload: evidence });
  assert.equal(forged.statusCode, 401);
  const verified = await app.inject({ method: 'POST', url: '/api/mock/webhook/follow', headers: { 'x-mock-signature': mockWebhookSignature(raw) }, payload: evidence });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().duplicate, false);
  const duplicateEvent = await app.inject({ method: 'POST', url: '/api/mock/webhook/follow', headers: { 'x-mock-signature': mockWebhookSignature(raw) }, payload: evidence });
  assert.equal(duplicateEvent.json().duplicate, true);
  const duplicateSubject = { ...evidence, eventId: 'mock-follow-event-2', evidenceRef: 'mock-evidence-2' };
  const duplicateSubjectResponse = await app.inject({ method: 'POST', url: '/api/mock/webhook/follow', headers: { 'x-mock-signature': mockWebhookSignature(JSON.stringify(duplicateSubject)) }, payload: duplicateSubject });
  assert.equal(duplicateSubjectResponse.json().duplicate, true);

  const dashboard = await app.inject({ method: 'GET', url: '/api/referral-dashboard', headers: { cookie } });
  assert.equal(dashboard.statusCode, 200, dashboard.body);
  const row = dashboard.json().rows.find(item => item.staffId === staff.id);
  assert.deepEqual({ clicks: row.clicks, logins: row.logins, followVerified: row.followVerified, conversionRate: row.conversionRate }, { clicks: 1, logins: 1, followVerified: 1, conversionRate: 100 });
  const events = (await json(await app.inject({ method: 'GET', url: '/api/referral-events', headers: { cookie } }))).events;
  assert.equal(events.filter(item => item.type === 'FOLLOW_VERIFIED').length, 1);
  assert.doesNotMatch(JSON.stringify(events), /mock-subject-flow-1|Uraw/);
});

test('mock store blocks cross-workspace identity ownership and last-owner lockout', () => {
  const ownerA = { id: 'owner-a', workspaceId: 'workspace-a', email: 'a@example.test', displayName: 'A', role: 'owner' };
  const ownerB = { id: 'owner-b', workspaceId: 'workspace-b', email: 'b@example.test', displayName: 'B', role: 'owner' };
  const storeA = new CampaignMockStore(ownerA);
  const storeB = new CampaignMockStore(ownerB);
  const memberA = storeA.inviteMember({ email: 'staff-a@example.test', displayName: 'Staff A', role: 'editor', actorId: ownerA.id, actorRole: 'owner', actorEmail: ownerA.email });
  assert.throws(() => storeA.updateMember(ownerA.id, { status: 'SUSPENDED', actorId: ownerA.id, actorRole: 'owner', actorEmail: ownerA.email }), /last active owner|cannot suspend/);
  const aReferral = storeA.createReferral({ staffId: memberA.id, oaId: 'oa-a', actorEmail: ownerA.email }, 'http://localhost:5173', new Set(['oa-a']));
  const aStart = storeA.startLogin(aReferral.plainToken);
  const subject = 'cross-workspace-subject-' + Date.now();
  storeA.completeLogin({ state: aStart.state, nonce: aStart.nonce, idToken: { iss: aStart.issuer, aud: aStart.audience, exp: Math.floor(Date.now() / 1000) + 300, nonce: aStart.nonce, sub: subject, signature: 'MOCK_VALID' } });
  const memberB = storeB.inviteMember({ email: 'staff-b@example.test', displayName: 'Staff B', role: 'editor', actorId: ownerB.id, actorRole: 'owner', actorEmail: ownerB.email });
  const bReferral = storeB.createReferral({ staffId: memberB.id, oaId: 'oa-b', actorEmail: ownerB.email }, 'http://localhost:5173', new Set(['oa-b']));
  const bStart = storeB.startLogin(bReferral.plainToken);
  assert.throws(() => storeB.completeLogin({ state: bStart.state, nonce: bStart.nonce, idToken: { iss: bStart.issuer, aud: bStart.audience, exp: Math.floor(Date.now() / 1000) + 300, nonce: bStart.nonce, sub: subject, signature: 'MOCK_VALID' } }), /another workspace/);
  const invalidAudience = storeB.startLogin(bReferral.plainToken);
  assert.throws(() => storeB.completeLogin({ state: invalidAudience.state, nonce: invalidAudience.nonce, idToken: { iss: invalidAudience.issuer, aud: 'wrong-audience', exp: Math.floor(Date.now() / 1000) + 300, nonce: invalidAudience.nonce, sub: 'invalid-audience-subject', signature: 'MOCK_VALID' } }), /invalid LINE audience/);
  const expired = storeB.startLogin(bReferral.plainToken);
  assert.throws(() => storeB.completeLogin({ state: expired.state, nonce: expired.nonce, idToken: { iss: expired.issuer, aud: expired.audience, exp: Math.floor(Date.now() / 1000) - 1, nonce: expired.nonce, sub: 'expired-subject', signature: 'MOCK_VALID' } }), /expired/);
});

test('LINE Login creates an isolated customer session and stores only an HMAC identity', () => {
  const owner = { id: 'owner-line-customer', workspaceId: 'workspace-line-customer', email: 'owner-line@example.test', displayName: 'Owner', role: 'owner' };
  const store = new CampaignMockStore(owner);
  const staff = store.inviteMember({ email: 'referrer@example.test', displayName: 'Referrer', role: 'editor', actorId: owner.id, actorRole: 'owner', actorEmail: owner.email });
  store.updateMember(staff.id, { status: 'ACTIVE', actorId: owner.id, actorRole: 'owner', actorEmail: owner.email });
  const referral = store.createReferral({ staffId: staff.id, oaId: 'oa-customer-test', actorEmail: owner.email }, 'http://localhost:5173', new Set(['oa-customer-test']));
  const context = store.resolveLineLoginMember(referral.plainToken);
  const rawSubject = 'U-sensitive-line-subject-local-test';
  const customerId = store.bindLineIdentity(rawSubject, context.referralId, 'LINE Customer', 'local-test-identity-hmac-key-with-enough-length');
  assert.notEqual(customerId, staff.id);
  assert.equal(JSON.stringify([...store.lineCustomers.values()]).includes(rawSubject), false);
  const session = store.createLineMemberSession(customerId);
  assert.deepEqual(store.getLineMemberSession(session.token), { id: customerId, displayName: 'LINE Customer', role: 'customer' });
  store.revokeLineMemberSession(session.token);
  assert.equal(store.getLineMemberSession(session.token), null);
});

test('referral tokens are unique and revoked or expired links cannot be used', async () => {
  const owner = { id: 'owner-c', workspaceId: 'workspace-c', email: 'c@example.test', displayName: 'C', role: 'owner' };
  const store = new CampaignMockStore(owner);
  const staff = store.inviteMember({ email: 'staff-c@example.test', displayName: 'Staff C', role: 'editor', actorId: owner.id, actorRole: 'owner', actorEmail: owner.email });
  const tokens = new Set();
  for (let index = 0; index < 25; index++) tokens.add(store.createReferral({ staffId: staff.id, oaId: 'oa-c', actorEmail: owner.email }, 'http://localhost:5173', new Set(['oa-c'])).plainToken);
  assert.equal(tokens.size, 25);
  const revoked = store.createReferral({ staffId: staff.id, oaId: 'oa-c', actorEmail: owner.email }, 'http://localhost:5173', new Set(['oa-c']));
  store.updateReferral(revoked.referral.id, 'REVOKED', owner.email);
  assert.throws(() => store.recordClick(revoked.plainToken), /paused or revoked/);
  const expiring = store.createReferral({ staffId: staff.id, oaId: 'oa-c', expiresAt: new Date(Date.now() + 100).toISOString(), actorEmail: owner.email }, 'http://localhost:5173', new Set(['oa-c']));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.throws(() => store.recordClick(expiring.plainToken), /expired/);
});
