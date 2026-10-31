import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const scryptAsync = promisify(scrypt) as (password: string, salt: string, keyLength: number) => Promise<Buffer>;

export function hashPasswordSync(password: string) {
  if (!password || password.length < 12) throw new Error('password must be at least 12 characters');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export async function hashPassword(password: string) {
  if (!password || password.length < 12) throw new Error('password must be at least 12 characters');
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [scheme, salt, expected] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = await scryptAsync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

// Unknown accounts still pay the scrypt cost so login timing does not reveal
// whether an email exists. The plaintext behind this hash is discarded.
export const DUMMY_PASSWORD_HASH = hashPasswordSync(randomBytes(32).toString('base64url'));

export function createSessionToken() { return randomBytes(32).toString('base64url'); }
export function hashSessionToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function sessionExpiresAt() { return new Date(Date.now() + SESSION_TTL_MS); }
