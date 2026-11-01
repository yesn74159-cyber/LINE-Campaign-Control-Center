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

const VIDEO_BUBBLE_SIZES = new Set(['kilo', 'mega', 'giga']);

type VideoSite = { node: Record<string, unknown>; key: string | null; parent: Record<string, unknown> | null };

function collectVideoSites(value: unknown, key: string | null, parent: Record<string, unknown> | null, out: VideoSite[]) {
  if (Array.isArray(value)) { for (const item of value) collectVideoSites(item, key, parent, out); return; }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (node.type === 'video') out.push({ node, key, parent });
  for (const [childKey, child] of Object.entries(node)) if (childKey !== 'type') collectVideoSites(child, childKey, node, out);
}

const BOX_LAYOUTS = new Set(['horizontal', 'vertical', 'baseline']);

/** LINE rejects a box without a layout, so an operator finds out here instead of at send time. */
function assertBoxLayouts(value: unknown, path = 'contents') {
  if (Array.isArray(value)) { value.forEach((item, index) => assertBoxLayouts(item, `${path}[${index}]`)); return; }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (node.type === 'box' && !BOX_LAYOUTS.has(String(node.layout))) throw new Error(`${path} is a box without a valid layout (horizontal, vertical or baseline)`);
  for (const [key, child] of Object.entries(node)) if (key !== 'type') assertBoxLayouts(child, `${path}.${key}`);
}

/** LINE plays a video only as the hero of one large bubble; anywhere else the card fails to render. */
function assertFlexVideoRules(flex: Record<string, unknown>) {
  assertBoxLayouts(flex.contents);
  const contents = flex.contents as Record<string, unknown>;
  const sites: VideoSite[] = [];
  collectVideoSites(contents, null, null, sites);
  if (sites.length === 0) return;
  if (contents.type === 'carousel') throw new Error('LINE cannot play a video inside a carousel; use a single bubble');
  for (const site of sites) {
    if (site.key !== 'hero' || site.parent?.type !== 'bubble') throw new Error('a video is only allowed as the hero of a bubble');
    if (typeof site.node.url !== 'string' || !site.node.url.startsWith('https://')) throw new Error('a video needs an https url');
    if (site.node.previewUrl !== undefined && !(typeof site.node.previewUrl === 'string' && site.node.previewUrl.startsWith('https://'))) throw new Error('video previewUrl must be an https URL');
    if (!site.node.altContent || typeof site.node.altContent !== 'object') throw new Error('a video needs altContent, the image LINE shows when it cannot play');
  }
  const size = String(contents.size || 'mega');
  if (!VIDEO_BUBBLE_SIZES.has(size)) throw new Error(`a bubble with a video needs size kilo, mega or giga (got ${size})`);
}

export function assertFlexJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('flexJson must be an object');
  const flex = value as Record<string, unknown>;
  const contents = flex.contents as Record<string, unknown> | undefined;
  if (flex.type !== 'flex' || typeof flex.altText !== 'string' || !contents || !['bubble', 'carousel'].includes(String(contents.type))) throw new Error('invalid LINE Flex document');
  if (String(flex.altText).length > 400 || JSON.stringify(value).length > 45000) throw new Error('Flex document exceeds LINE safety limits');
  assertFlexVideoRules(flex);
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
  if (action === 'write') return role === 'editor';
  if (action === 'approve') return role === 'reviewer';
  return false;
}
