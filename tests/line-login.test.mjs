import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerLineLoginRoutes } from '../dist/api/lineLogin.js';

const callbackUri = 'http://127.0.0.1:8787/api/line-login/callback';
const channelId = 'local-test-channel-id';

function createFixture(claimOverrides = {}) {
  const state = { calls: [], identity: null, session: null, flows: new Map(), revoked: false };
  const store = {
    resolveLineLoginMember(token) {
      if (token !== 'opaque-referral-token-for-local-test') throw new Error('referral token not found');
      return { workspaceId: 'workspace-local-1', oaId: 'oa-local-1', referralId: 'referral-local-1', referralToken: token };
    },
    saveLineLoginFlow(flow) { state.flows.set(flow.stateHash, flow); },
    getLineLoginFlow(stateHash, browserBindingHash) {
      const flow = state.flows.get(stateHash);
      return flow?.browserBindingHash === browserBindingHash && flow.expiresAt > new Date() ? flow : null;
    },
    completeLineLogin(input) {
      const flow = state.flows.get(input.stateHash);
      if (!flow || flow.browserBindingHash !== input.browserBindingHash || flow.expiresAt <= new Date()) return null;
      state.flows.delete(input.stateHash);
      state.identity = { subjectHmac: input.subjectHmac, referralId: flow.referralId, displayName: input.displayName };
      state.session = { token: input.sessionToken, expiresAt: input.expiresAt, customerId: 'customer-local-1' };
      return { token: input.sessionToken, expiresAt: input.expiresAt, customer: { id: 'customer-local-1', displayName: input.displayName, role: 'customer' } };
    },
    getLineMemberSession(token) {
      return token === state.session?.token && !state.revoked ? { id: state.session.customerId, displayName: 'Local Member', role: 'customer' } : null;
    },
    revokeLineMemberSession(token) { if (token === state.session?.token) state.revoked = true; },
    discardLineLoginState(stateHash, browserBindingHash) {
      if (state.flows.get(stateHash)?.browserBindingHash === browserBindingHash) state.flows.delete(stateHash);
    },
    cleanupExpiredLineLoginData() {
      for (const [hash, flow] of state.flows) if (flow.expiresAt <= new Date()) state.flows.delete(hash);
    }
  };
  const fetcher = async (url, options) => {
    state.calls.push({ url: String(url), options });
    const form = new URLSearchParams(options.body);
    if (String(url) === 'https://api.line.me/oauth2/v2.1/token') {
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), channelId);
      assert.equal(form.get('client_secret'), 'not-a-real-channel-secret');
      assert.equal(form.get('redirect_uri'), callbackUri);
      assert.match(form.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
      return Response.json({ id_token: 'mock-id-token-not-signed' });
    }
    assert.equal(String(url), 'https://api.line.me/oauth2/v2.1/verify');
    assert.equal(form.get('id_token'), 'mock-id-token-not-signed');
    assert.equal(form.get('client_id'), channelId);
    const claims = {
      iss: 'https://access.line.me', sub: 'U-local-member-subject', aud: channelId,
      exp: Math.floor(Date.now() / 1000) + 300, nonce: state.nonce,
      name: 'Local Member', ...claimOverrides
    };
    return Response.json(claims);
  };
  const app = Fastify();
  app.register(cookie);
  registerLineLoginRoutes(app, store, {
    enabled: true, channelId, channelSecret: 'not-a-real-channel-secret',
    redirectUri: callbackUri, publicAppOrigin: 'http://127.0.0.1:5173',
    identityHashKey: 'local-test-identity-hash-key-not-a-secret', flowEncryptionKey: Buffer.alloc(32, 7), secureCookies: false,
    fetcher
  });
  return { app, state, async ready() { await app.ready(); }, async close() { await app.close(); } };
}

function cookiePair(response, name) {
  const headers = response.headers['set-cookie'];
  const values = Array.isArray(headers) ? headers : [headers].filter(Boolean);
  const header = values.find(value => value.startsWith(`${name}=`));
  return header?.split(';', 1)[0] || '';
}

async function startFlow(fixture) {
  const response = await fixture.app.inject({ method: 'GET', url: '/api/line-login/start?referralToken=opaque-referral-token-for-local-test' });
  const authorization = new URL(response.headers.location);
  const verifierCookie = cookiePair(response, 'line_login_flow');
  fixture.state.nonce = authorization.searchParams.get('nonce');
  return { response, authorization, verifierCookie };
}

test('LINE Login start requests authorization code, OIDC, state, nonce, and PKCE S256', async t => {
  const fixture = createFixture(); await fixture.ready(); t.after(() => fixture.close());
  const { response, authorization, verifierCookie } = await startFlow(fixture);
  assert.equal(response.statusCode, 302);
  assert.equal(authorization.origin + authorization.pathname, 'https://access.line.me/oauth2/v2.1/authorize');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('client_id'), channelId);
  assert.equal(authorization.searchParams.get('redirect_uri'), callbackUri);
  assert.equal(authorization.searchParams.get('scope'), 'openid profile');
  assert.match(authorization.searchParams.get('state'), /^[a-f0-9]{64}$/);
  assert.ok(authorization.searchParams.get('nonce'));
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(verifierCookie, /^line_login_flow=/);
  assert.match([].concat(response.headers['set-cookie'] || []).join(';'), /HttpOnly/i);
});

test('callback exchanges code, verifies claims, binds member, and issues an isolated HttpOnly session', async t => {
  const fixture = createFixture(); await fixture.ready(); t.after(() => fixture.close());
  const { authorization, verifierCookie } = await startFlow(fixture);
  const challenge = authorization.searchParams.get('code_challenge');
  const callback = await fixture.app.inject({
    method: 'GET', url: `/api/line-login/callback?code=mock-auth-code&state=${authorization.searchParams.get('state')}`,
    headers: { cookie: verifierCookie }
  });
  assert.equal(callback.statusCode, 302);
  assert.match(callback.headers.location, /^http:\/\/127\.0\.0\.1:5173\/r\/opaque-referral-token-for-local-test\?lineLogin=success$/);
  assert.equal(fixture.state.calls.length, 2);
  const verifier = new URLSearchParams(fixture.state.calls[0].options.body).get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
  assert.equal(fixture.state.identity.referralId, 'referral-local-1');
  assert.match(fixture.state.identity.subjectHmac, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify([...fixture.state.flows.values()]), /U-local-member-subject|mock-auth-code|mock-id-token/);
  const sessionCookie = cookiePair(callback, 'line_member_session');
  assert.equal(sessionCookie, `line_member_session=${fixture.state.session.token}`);
  const setCookies = [].concat(callback.headers['set-cookie'] || []).join(';');
  assert.match(setCookies, /line_member_session=.*HttpOnly/i);
  assert.match(setCookies, /SameSite=Lax/i);
  assert.doesNotMatch(setCookies, /ccc_session=/);
  const session = await fixture.app.inject({ method: 'GET', url: '/api/line-login/session', headers: { cookie: sessionCookie } });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().member.id, 'customer-local-1');
  assert.equal(session.json().member.role, 'customer');
});

test('callback rejects missing or browser-mismatched state without calling LINE', async t => {
  const fixture = createFixture(); await fixture.ready(); t.after(() => fixture.close());
  const { authorization, verifierCookie } = await startFlow(fixture);
  const wrongState = await fixture.app.inject({
    method: 'GET', url: '/api/line-login/callback?code=mock-auth-code&state=wrong-state',
    headers: { cookie: verifierCookie }
  });
  assert.equal(wrongState.statusCode, 400);
  const mismatch = await fixture.app.inject({
    method: 'GET', url: `/api/line-login/callback?code=mock-auth-code&state=${authorization.searchParams.get('state')}`,
    headers: { cookie: 'line_login_flow=wrong-browser' }
  });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(fixture.state.calls.length, 0);
});

test('callback rejects invalid nonce and consumes the authorization state', async t => {
  const fixture = createFixture({ nonce: 'wrong-nonce' }); await fixture.ready(); t.after(() => fixture.close());
  const { authorization, verifierCookie } = await startFlow(fixture);
  const callbackUrl = `/api/line-login/callback?code=mock-auth-code&state=${authorization.searchParams.get('state')}`;
  const first = await fixture.app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: verifierCookie } });
  assert.equal(first.statusCode, 302);
  assert.match(first.headers.location, /lineLogin=error$/);
  assert.equal(fixture.state.identity, null);
  assert.equal(fixture.state.session, null);
  const replay = await fixture.app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: verifierCookie } });
  assert.equal(replay.statusCode, 400);
});

test('callback rejects invalid issuer, audience, expiry, and subject claims', async t => {
  for (const overrides of [
    { iss: 'https://attacker.invalid' },
    { aud: 'different-channel' },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { sub: 'contains whitespace' }
  ]) {
    const fixture = createFixture(overrides); await fixture.ready();
    try {
      const { authorization, verifierCookie } = await startFlow(fixture);
      const callback = await fixture.app.inject({
        method: 'GET', url: `/api/line-login/callback?code=mock-auth-code&state=${authorization.searchParams.get('state')}`,
        headers: { cookie: verifierCookie }
      });
      assert.equal(callback.statusCode, 302);
      assert.match(callback.headers.location, /lineLogin=error$/);
      assert.equal(fixture.state.identity, null);
      assert.equal(fixture.state.session, null);
    } finally { await fixture.close(); }
  }
});

test('member logout revokes only the LINE session', async t => {
  const fixture = createFixture(); await fixture.ready(); t.after(() => fixture.close());
  const { authorization, verifierCookie } = await startFlow(fixture);
  const callback = await fixture.app.inject({
    method: 'GET', url: `/api/line-login/callback?code=mock-auth-code&state=${authorization.searchParams.get('state')}`,
    headers: { cookie: verifierCookie }
  });
  const sessionCookie = cookiePair(callback, 'line_member_session');
  const logout = await fixture.app.inject({ method: 'POST', url: '/api/line-login/logout', headers: { cookie: sessionCookie } });
  assert.equal(logout.statusCode, 200);
  const session = await fixture.app.inject({ method: 'GET', url: '/api/line-login/session', headers: { cookie: sessionCookie } });
  assert.equal(session.statusCode, 401);
});