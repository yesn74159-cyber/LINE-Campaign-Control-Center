import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InvalidLineLoginReferralError, type LineLoginStore } from './lineLoginStore.js';

const AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const FLOW_TTL_MS = 5 * 60 * 1000;

export interface LineLoginConfig {
  enabled: boolean;
  channelId: string;
  channelSecret: string;
  redirectUri: string;
  publicAppOrigin: string;
  identityHashKey: string;
  flowEncryptionKey: Buffer;
  secureCookies: boolean;
  fetcher?: typeof fetch;
}

type LineIdTokenClaims = {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  nonce?: unknown;
  name?: unknown;
};

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalHex(left: string, right: string) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sealLineLoginValue(value: string, key: Buffer) {
  if (key.length !== 32) throw new Error('LINE Login flow encryption key must contain 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function unsealLineLoginValue(value: string, key: Buffer) {
  if (key.length !== 32) throw new Error('LINE Login flow encryption key must contain 32 bytes');
  const [ivText, tagText, ciphertextText] = value.split('.');
  if (!ivText || !tagText || !ciphertextText) throw new Error('invalid sealed LINE Login value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}

function cookieOptions(config: LineLoginConfig, maxAge: number) {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const, path: '/api/line-login', maxAge };
}

function parseClaims(value: unknown): LineIdTokenClaims | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as LineIdTokenClaims;
}

function isSafeHttpUrl(value: string, callback: boolean) {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const secureTransport = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    const validPath = callback ? url.pathname === '/api/line-login/callback' : url.pathname === '/';
    return secureTransport && !url.username && !url.password && !url.search && !url.hash && validPath;
  } catch {
    return false;
  }
}

function safeReturnUrl(config: LineLoginConfig, referralToken: string, result: 'success' | 'error') {
  const origin = new URL(config.publicAppOrigin);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('invalid public app origin');
  const target = new URL(`/r/${encodeURIComponent(referralToken)}`, origin.origin);
  target.searchParams.set('lineLogin', result);
  return target.toString();
}

export function createLineLoginConfig(env: NodeJS.ProcessEnv = process.env): LineLoginConfig {
  const flowEncryptionKey = Buffer.from(env.LINE_LOGIN_FLOW_ENCRYPTION_KEY || '', 'base64');
  return {
    enabled: env.LINE_LOGIN_ENABLED === 'true',
    channelId: env.LINE_LOGIN_CHANNEL_ID || '',
    channelSecret: env.LINE_LOGIN_CHANNEL_SECRET || '',
    redirectUri: env.LINE_LOGIN_REDIRECT_URI || '',
    publicAppOrigin: env.PUBLIC_APP_ORIGIN || 'http://127.0.0.1:5173',
    identityHashKey: env.LINE_IDENTITY_HASH_KEY || '',
    flowEncryptionKey: flowEncryptionKey.length === 32 ? flowEncryptionKey : Buffer.alloc(0),
    secureCookies: env.NODE_ENV === 'production' || env.LINE_LOGIN_COOKIE_SECURE === 'true'
  };
}

export function registerLineLoginRoutes(app: FastifyInstance, store: LineLoginStore, config: LineLoginConfig) {
  const fetcher = config.fetcher || fetch;
  const configured = () => config.enabled && Boolean(config.channelId && config.channelSecret && config.identityHashKey.length >= 32 && config.flowEncryptionKey.length === 32) &&
    isSafeHttpUrl(config.redirectUri, true) && isSafeHttpUrl(config.publicAppOrigin, false);
  const flowCookie = (request: FastifyRequest) => (request as FastifyRequest & { cookies?: Record<string, string> }).cookies?.line_login_flow;
  const memberCookie = (request: FastifyRequest) => (request as FastifyRequest & { cookies?: Record<string, string> }).cookies?.line_member_session;

  app.get('/api/line-login/config', async () => ({ enabled: configured() }));

  app.get<{ Querystring: { referralToken?: string } }>('/api/line-login/start', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    if (!configured()) return reply.code(503).send({ error: 'LINE Login is not configured for local use' });
    const referralToken = request.query.referralToken || '';
    let member: Awaited<ReturnType<LineLoginStore['resolveLineLoginMember']>>;
    try {
      member = await store.resolveLineLoginMember(referralToken);
    } catch (error) {
      if (error instanceof InvalidLineLoginReferralError) return reply.code(400).send({ error: error.message });
      return reply.code(503).send({ error: 'LINE Login persistence is unavailable' });
    }

    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const browserBinding = randomBytes(32).toString('base64url');
    const stateHash = sha256(state);
    const browserBindingHash = sha256(browserBinding);
    await store.saveLineLoginFlow({
      stateHash, browserBindingHash, workspaceId: member.workspaceId, oaId: member.oaId,
      referralId: member.referralId, nonceHash: sha256(nonce),
      nonceSealed: sealLineLoginValue(nonce, config.flowEncryptionKey),
      codeVerifierSealed: sealLineLoginValue(codeVerifier, config.flowEncryptionKey),
      referralTokenSealed: sealLineLoginValue(member.referralToken, config.flowEncryptionKey),
      expiresAt: new Date(Date.now() + FLOW_TTL_MS)
    });
    await store.cleanupExpiredLineLoginData();

    const authorization = new URL(AUTHORIZE_URL);
    authorization.search = new URLSearchParams({
      response_type: 'code', client_id: config.channelId, redirect_uri: config.redirectUri,
      state, scope: 'openid profile', nonce, code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    }).toString();
    reply.setCookie('line_login_flow', browserBinding, cookieOptions(config, FLOW_TTL_MS / 1000));
    return reply.redirect(authorization.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/line-login/callback', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    const state = request.query.state || '';
    if (!/^[a-f0-9]{64}$/.test(state)) return reply.code(400).send({ error: 'LINE Login state is invalid' });
    const stateHash = sha256(state);
    const binding = flowCookie(request) || '';
    reply.clearCookie('line_login_flow', cookieOptions(config, 0));

    if (!binding) {
      return reply.code(400).send({ error: 'LINE Login state is invalid, expired, or belongs to another browser' });
    }
    const browserBindingHash = sha256(binding);
    const saved = await store.getLineLoginFlow(stateHash, browserBindingHash);
    if (!saved || !equalHex(saved.browserBindingHash, browserBindingHash)) {
      return reply.code(400).send({ error: 'LINE Login state is invalid, expired, or belongs to another browser' });
    }
    const nonce = unsealLineLoginValue(saved.nonceSealed, config.flowEncryptionKey);
    const codeVerifier = unsealLineLoginValue(saved.codeVerifierSealed, config.flowEncryptionKey);
    const referralToken = unsealLineLoginValue(saved.referralTokenSealed, config.flowEncryptionKey);
    if (!equalHex(saved.nonceHash, sha256(nonce))) return reply.code(400).send({ error: 'LINE Login nonce state is invalid' });
    if (request.query.error || !request.query.code || request.query.code.length > 4096) {
      await store.discardLineLoginState(stateHash, browserBindingHash);
      return reply.redirect(safeReturnUrl(config, referralToken, 'error'));
    }

    let claims: LineIdTokenClaims | null;
    try {
      const tokenResponse = await fetcher(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: request.query.code,
          redirect_uri: config.redirectUri, client_id: config.channelId,
          client_secret: config.channelSecret, code_verifier: codeVerifier
        }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!tokenResponse.ok) throw new Error('LINE token exchange failed');
      const tokenBody = await tokenResponse.json() as { id_token?: unknown };
      if (typeof tokenBody.id_token !== 'string' || !tokenBody.id_token) throw new Error('LINE token response did not contain an ID token');

      const verifyResponse = await fetcher(VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: tokenBody.id_token, client_id: config.channelId, nonce }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!verifyResponse.ok) throw new Error('LINE ID token verification failed');
      claims = parseClaims(await verifyResponse.json());
      if (!claims || claims.iss !== 'https://access.line.me' || claims.aud !== config.channelId ||
          typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(claims.sub) ||
          typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000) ||
          claims.nonce !== nonce) {
        throw new Error('LINE ID token claims are invalid');
      }

    } catch {
      await store.discardLineLoginState(stateHash, browserBindingHash);
      return reply.redirect(safeReturnUrl(config, referralToken, 'error'));
    }

    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const subjectHmac = createHmac('sha256', config.identityHashKey).update(claims!.sub as string, 'utf8').digest('hex');
    const displayName = typeof claims!.name === 'string' ? claims!.name.trim().slice(0, 120) || 'LINE Member' : 'LINE Member';
    const session = await store.completeLineLogin({ stateHash, browserBindingHash, subjectHmac, displayName, sessionToken, expiresAt });
    if (!session) {
      await store.discardLineLoginState(stateHash, browserBindingHash);
      return reply.redirect(safeReturnUrl(config, referralToken, 'error'));
    }
    reply.setCookie('line_member_session', session.token, cookieOptions(config, Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000))));
    return reply.redirect(safeReturnUrl(config, referralToken, 'success'));
  });

  app.get('/api/line-login/session', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const token = memberCookie(request);
    const member = token ? await store.getLineMemberSession(token) : null;
    if (!member) return reply.code(401).send({ error: 'member session required' });
    return { member };
  });

  app.post('/api/line-login/logout', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const token = memberCookie(request);
    if (token) await store.revokeLineMemberSession(token);
    reply.clearCookie('line_member_session', cookieOptions(config, 0));
    return { ok: true };
  });
}