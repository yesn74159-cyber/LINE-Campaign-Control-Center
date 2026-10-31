import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AccountTokenPurpose } from './types.js';

export const ACCOUNT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createAccountToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') };
}

export function hashAccountToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueAccountToken(client: PoolClient, input: {
  workspaceId: string;
  adminUserId: string;
  purpose: AccountTokenPurpose;
  createdBy: string;
  ttlMs?: number;
}) {
  const { token, tokenHash } = createAccountToken();
  const expiresAt = new Date(Date.now() + (input.ttlMs || ACCOUNT_TOKEN_TTL_MS));
  await client.query(
    'update admin_account_tokens set used_at=now() where workspace_id=$1 and admin_user_id=$2 and purpose=$3 and used_at is null',
    [input.workspaceId, input.adminUserId, input.purpose]
  );
  await client.query(
    'insert into admin_account_tokens(workspace_id,admin_user_id,purpose,token_hash,expires_at,created_by) values ($1,$2,$3,$4,$5,$6)',
    [input.workspaceId, input.adminUserId, input.purpose, tokenHash, expiresAt.toISOString(), input.createdBy]
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export function accountSetupUrl(token: string) {
  const origin = process.env.PUBLIC_APP_ORIGIN || 'http://127.0.0.1:5173';
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('PUBLIC_APP_ORIGIN must be http or https');
  const url = new URL('/account-setup', base.origin);
  url.searchParams.set('token', token);
  return url.toString();
}
