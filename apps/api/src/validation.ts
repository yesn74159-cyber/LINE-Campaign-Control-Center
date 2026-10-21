import type { AdminRole } from './types.js';

const roles = new Set<AdminRole>(['owner', 'admin', 'editor', 'reviewer', 'viewer']);

export function assertEmail(value: unknown) {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('valid email is required');
  return value.trim().toLowerCase();
}

export function assertPassword(value: unknown) {
  if (typeof value !== 'string' || value.length < 12) throw new Error('password must be at least 12 characters');
  return value;
}

export function assertTimeZone(value: unknown) {
  if (value !== 'Asia/Bangkok') throw new Error('only Asia/Bangkok is enabled in staging');
  return value;
}

export function assertSchedulerStatus(value: unknown) {
  if (value !== undefined && value !== 'DRAFT' && value !== 'SCHEDULED') throw new Error('scheduler status must be DRAFT or SCHEDULED');
  return (value || 'SCHEDULED') as 'DRAFT' | 'SCHEDULED';
}

export function assertScheduledAt(value: unknown, status: 'DRAFT' | 'SCHEDULED') {
  if (typeof value !== 'string') throw new Error('scheduledAt must be a valid ISO date');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error('scheduledAt must be a valid ISO date');
  if (status === 'SCHEDULED' && parsed.getTime() <= Date.now()) throw new Error('scheduledAt must be in the future');
  return parsed.toISOString();
}

export function assertFlexJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('flexJson must be an object');
  const flex = value as Record<string, unknown>;
  const contents = flex.contents as Record<string, unknown> | undefined;
  if (flex.type !== 'flex' || typeof flex.altText !== 'string' || !contents || !['bubble', 'carousel'].includes(String(contents.type))) throw new Error('invalid LINE Flex document');
  if (String(flex.altText).length > 400 || JSON.stringify(value).length > 45000) throw new Error('Flex document exceeds LINE safety limits');
  return flex;
}

export function assertRole(value: unknown): AdminRole {
  if (typeof value !== 'string' || !roles.has(value as AdminRole)) throw new Error('invalid admin role');
  return value as AdminRole;
}

export function assertOaMetadata(value: unknown, field: string, maxLength = 160) {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > maxLength || /[\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value.trim();
}

export function assertControlReason(value: unknown) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 240 || /[\r\n]/.test(value)) throw new Error('reason is required');
  return value.trim();
}

export function can(role: AdminRole, action: 'read' | 'write' | 'approve' | 'manage_oa' | 'manage_users') {
  if (role === 'owner' || role === 'admin') return true;
  if (action === 'read') return true;
  if (action === 'write') return role === 'editor' || role === 'reviewer';
  if (action === 'approve') return role === 'reviewer';
  return false;
}
