import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AdminRole } from './types.js';

export type MemberStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export type AttributionType = 'CLICK' | 'LOGIN' | 'FOLLOW_VERIFIED';

export type MockMember = {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: AdminRole;
  status: MemberStatus;
  createdAt: string;
};

type Referral = {
  id: string;
  workspaceId: string;
  staffId: string;
  oaId: string;
  tokenHash: string;
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  expiresAt?: string;
  createdAt: string;
};

export type SafeReferral = Omit<Referral, 'tokenHash'> & { url?: string };
export type AttributionEvent = {
  id: string;
  referralId: string;
  workspaceId: string;
  staffId: string;
  oaId: string;
  type: AttributionType;
  evidenceRef?: string;
  occurredAt: string;
};

type LoginState = {
  stateHash: string;
  nonceHash: string;
  referralId: string;
  staffId: string;
  oaId: string;
  expiresAt: number;
  used: boolean;
};

type IdentityOwner = { workspaceId: string; staffId: string };
const identityOwners = new Map<string, IdentityOwner>();

function now() { return new Date(); }
function id() { return randomBytes(16).toString('hex'); }
function sha256(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function mockIdentityHmac(subject: string) {
  const key = process.env.MOCK_IDENTITY_HMAC_KEY || 'line-ccc-local-dry-run-identity-key';
  return createHmac('sha256', key).update(subject, 'utf8').digest('hex');
}
function equalHash(left: string, right: string) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function cleanEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('valid member email is required');
  return email;
}
function cleanRole(value: string): AdminRole {
  if (!['owner', 'admin', 'editor', 'reviewer', 'viewer'].includes(value)) throw new Error('invalid member role');
  return value as AdminRole;
}

export class CampaignMockStore {
  readonly workspaceId: string;
  private workspaceName = 'LINE CCC Local Workspace';
  private readonly members: MockMember[];
  private readonly referrals: Referral[] = [];
  private readonly events: AttributionEvent[] = [];
  private readonly audit: Array<{ id: string; action: string; actor: string; target: string; detail: string; createdAt: string }> = [];
  private readonly loginStates = new Map<string, LoginState>();
  private readonly webhookReceipts = new Set<string>();
  private readonly verifiedSubjects = new Set<string>();

  constructor(owner: { id: string; workspaceId: string; email: string; displayName: string; role: AdminRole }) {
    this.workspaceId = owner.workspaceId;
    this.members = [{ ...owner, status: 'ACTIVE', createdAt: now().toISOString() }];
  }

  private log(action: string, actor: string, target: string, detail: string) {
    this.audit.unshift({ id: id(), action, actor, target, detail, createdAt: now().toISOString() });
  }
  private member(memberId: string) {
    const member = this.members.find(item => item.id === memberId && item.workspaceId === this.workspaceId);
    if (!member) throw new Error('member is not in this workspace');
    return member;
  }
  private referral(referralId: string) {
    const referral = this.referrals.find(item => item.id === referralId && item.workspaceId === this.workspaceId);
    if (!referral) throw new Error('referral is not in this workspace');
    return referral;
  }
  private activeReferral(referral: Referral) {
    if (referral.status !== 'ACTIVE') throw new Error('referral is paused or revoked');
    if (referral.expiresAt && new Date(referral.expiresAt).getTime() <= Date.now()) throw new Error('referral has expired');
  }
  private safeReferral(referral: Referral, origin?: string): SafeReferral {
    return { id: referral.id, workspaceId: referral.workspaceId, staffId: referral.staffId, oaId: referral.oaId, status: referral.status, expiresAt: referral.expiresAt, createdAt: referral.createdAt, ...(origin ? { url: `${origin.replace(/\/$/, '')}/r/${referral.id}` } : {}) };
  }

  workspace() { return { id: this.workspaceId, slug: `ws-${this.workspaceId.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`, name: this.workspaceName, mode: 'DRY_RUN' }; }
  renameWorkspace(name: string, actor: string) {
    const clean = name.trim();
    if (clean.length < 3 || clean.length > 100) throw new Error('workspace name must be 3-100 characters');
    this.workspaceName = clean;
    this.log('WORKSPACE_RENAMED', actor, this.workspaceId, 'Workspace display name changed in local mock');
    return this.workspace();
  }
  listMembers() { return this.members.map(item => ({ ...item })); }
  inviteMember(input: { email: string; displayName: string; role: string; actorId: string; actorRole: AdminRole; actorEmail: string }) {
    if (input.actorRole !== 'owner' && input.actorRole !== 'admin') throw new Error('owner or admin role required');
    const email = cleanEmail(input.email);
    if (this.members.some(item => item.email === email)) throw new Error('member email already exists');
    const member: MockMember = { id: id(), workspaceId: this.workspaceId, email, displayName: input.displayName.trim().slice(0, 120), role: cleanRole(input.role), status: 'INVITED', createdAt: now().toISOString() };
    if (!member.displayName) throw new Error('member display name is required');
    this.members.push(member);
    this.log('MEMBER_INVITED', input.actorEmail, member.id, `Member invited with role ${member.role}`);
    return { ...member };
  }
  updateMember(memberId: string, input: { role?: string; status?: MemberStatus; actorId: string; actorRole: AdminRole; actorEmail: string }) {
    if (input.actorRole !== 'owner' && input.actorRole !== 'admin') throw new Error('owner or admin role required');
    const member = this.member(memberId);
    if (input.actorRole === 'admin' && member.role === 'owner') throw new Error('admin cannot manage the owner');
    if (input.actorRole === 'admin' && input.role === 'owner') throw new Error('admin cannot grant owner role');
    if (member.id === input.actorId && (input.status === 'SUSPENDED' || (input.role && input.role !== 'owner'))) throw new Error('you cannot suspend or lower your own access');
    const nextRole = input.role ? cleanRole(input.role) : member.role;
    const nextStatus = input.status || member.status;
    const ownerCount = this.members.filter(item => item.role === 'owner' && item.status === 'ACTIVE').length;
    if (member.role === 'owner' && member.status === 'ACTIVE' && (nextRole !== 'owner' || nextStatus !== 'ACTIVE') && ownerCount <= 1) throw new Error('the last active owner cannot be suspended or demoted');
    member.role = nextRole;
    member.status = nextStatus;
    this.log('MEMBER_UPDATED', input.actorEmail, member.id, `Member role/status changed to ${member.role}/${member.status}`);
    return { ...member };
  }

  createReferral(input: { staffId: string; oaId: string; expiresAt?: string; actorEmail: string }, origin: string, validOaIds: Set<string>) {
    const staff = this.member(input.staffId);
    if (staff.status === 'SUSPENDED') throw new Error('suspended member cannot receive a referral link');
    if (!validOaIds.has(input.oaId)) throw new Error('selected OA is not in this workspace');
    if (input.expiresAt && Number.isNaN(new Date(input.expiresAt).valueOf())) throw new Error('expiresAt must be a valid ISO date');
    if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) throw new Error('expiresAt must be in the future');
    const plainToken = randomBytes(32).toString('base64url');
    const referral: Referral = { id: id(), workspaceId: this.workspaceId, staffId: staff.id, oaId: input.oaId, tokenHash: sha256(plainToken), status: 'ACTIVE', expiresAt: input.expiresAt, createdAt: now().toISOString() };
    this.referrals.unshift(referral);
    this.log('REFERRAL_CREATED', input.actorEmail, referral.id, `Referral link created for member ${staff.email}`);
    return { referral: this.safeReferral(referral), plainToken, url: `${origin.replace(/\/$/, '')}/r/${plainToken}` };
  }
  listReferrals(origin: string, filters: { staffId?: string; oaId?: string }) {
    void origin;
    return this.referrals.filter(item => (!filters.staffId || item.staffId === filters.staffId) && (!filters.oaId || item.oaId === filters.oaId)).map(item => this.safeReferral(item));
  }
  updateReferral(referralId: string, status: 'ACTIVE' | 'PAUSED' | 'REVOKED', actorEmail: string) {
    const referral = this.referral(referralId);
    referral.status = status;
    this.log(`REFERRAL_${status}`, actorEmail, referral.id, `Referral status changed to ${status}`);
    return this.safeReferral(referral);
  }
  resolveToken(token: string) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new Error('invalid referral token');
    const hash = sha256(token);
    const referral = this.referrals.find(item => equalHash(item.tokenHash, hash));
    if (!referral) throw new Error('referral token not found');
    this.activeReferral(referral);
    return referral;
  }
  recordClick(token: string) {
    const referral = this.resolveToken(token);
    const staff = this.member(referral.staffId);
    this.events.push({ id: id(), referralId: referral.id, workspaceId: this.workspaceId, staffId: staff.id, oaId: referral.oaId, type: 'CLICK', occurredAt: now().toISOString() });
    return { referral: this.safeReferral(referral), staffName: staff.displayName, oaId: referral.oaId, next: 'LINE_LOGIN_MOCK' };
  }
  startLogin(token: string) {
    const referral = this.resolveToken(token);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    this.loginStates.set(sha256(state), { stateHash: sha256(state), nonceHash: sha256(nonce), referralId: referral.id, staffId: referral.staffId, oaId: referral.oaId, expiresAt: Date.now() + 5 * 60 * 1000, used: false });
    return { state, nonce, issuer: 'https://access.line.me', audience: process.env.MOCK_LINE_LOGIN_AUDIENCE || 'line-ccc-local-login', expiresInSeconds: 300 };
  }
  completeLogin(input: { state: string; nonce: string; idToken: { iss: string; aud: string; exp: number; nonce: string; sub: string; signature?: string } }) {
    const stateHash = sha256(input.state);
    const saved = this.loginStates.get(stateHash);
    if (!saved || saved.used || saved.expiresAt <= Date.now()) throw new Error('state is invalid, expired, or already used');
    if (!equalHash(saved.nonceHash, sha256(input.nonce)) || input.idToken.nonce !== input.nonce) throw new Error('nonce validation failed');
    if (input.idToken.iss !== 'https://access.line.me') throw new Error('invalid LINE issuer');
    if (input.idToken.aud !== (process.env.MOCK_LINE_LOGIN_AUDIENCE || 'line-ccc-local-login')) throw new Error('invalid LINE audience');
    if (!Number.isFinite(input.idToken.exp) || input.idToken.exp <= Math.floor(Date.now() / 1000)) throw new Error('LINE identity token has expired');
    if (input.idToken.signature !== 'MOCK_VALID') throw new Error('mock identity signature is invalid');
    if (!input.idToken.sub || input.idToken.sub.length > 200 || /[\r\n]/.test(input.idToken.sub)) throw new Error('invalid LINE subject');
    const owner = this.member(saved.staffId);
    const subjectHmac = mockIdentityHmac(input.idToken.sub);
    const existing = identityOwners.get(subjectHmac);
    if (existing && (existing.workspaceId !== this.workspaceId || existing.staffId !== owner.id)) throw new Error('LINE identity is already bound to another workspace member');
    identityOwners.set(subjectHmac, { workspaceId: this.workspaceId, staffId: owner.id });
    saved.used = true;
    const referral = this.referral(saved.referralId);
    this.events.push({ id: id(), referralId: referral.id, workspaceId: this.workspaceId, staffId: owner.id, oaId: referral.oaId, type: 'LOGIN', occurredAt: now().toISOString() });
    this.log('LINE_LOGIN_MOCK_VERIFIED', owner.email, owner.id, 'Issuer, audience, expiry, nonce, state, and mock signature verified; raw subject discarded');
    return { ok: true, referralId: referral.id, staffId: owner.id, identity: 'HMAC_STORED_ONLY' };
  }
  verifyFollow(input: { referralId: string; eventId: string; followerSubject: string; evidenceRef: string; eventType: string; occurredAt?: string }) {
    const referral = this.referral(input.referralId);
    this.activeReferral(referral);
    if (input.eventType !== 'follow') throw new Error('only follow evidence can be verified');
    if (!input.eventId || input.eventId.length > 200 || !input.followerSubject || !input.evidenceRef?.trim()) throw new Error('follow evidence is incomplete');
    const receiptKey = `${this.workspaceId}:${referral.oaId}:${input.eventId}`;
    if (this.webhookReceipts.has(receiptKey)) return { accepted: true, duplicate: true, type: 'FOLLOW_VERIFIED' as const };
    const subjectHmac = mockIdentityHmac(input.followerSubject);
    const subjectKey = `${this.workspaceId}:${referral.oaId}:${subjectHmac}`;
    if (this.verifiedSubjects.has(subjectKey)) {
      this.webhookReceipts.add(receiptKey);
      return { accepted: true, duplicate: true, type: 'FOLLOW_VERIFIED' as const };
    }
    this.webhookReceipts.add(receiptKey);
    this.verifiedSubjects.add(subjectKey);
    this.events.push({ id: id(), referralId: referral.id, workspaceId: this.workspaceId, staffId: referral.staffId, oaId: referral.oaId, type: 'FOLLOW_VERIFIED', evidenceRef: input.evidenceRef, occurredAt: input.occurredAt || now().toISOString() });
    this.log('FOLLOW_VERIFIED', 'mock-webhook', referral.id, 'Signed mock webhook evidence accepted; subject HMAC only');
    return { accepted: true, duplicate: false, type: 'FOLLOW_VERIFIED' as const };
  }
  dashboard(filters: { staffId?: string; oaId?: string; from?: string; to?: string }) {
    const inRange = (event: AttributionEvent) => (!filters.from || event.occurredAt >= filters.from) && (!filters.to || event.occurredAt <= filters.to);
    return this.members.filter(member => member.status !== 'SUSPENDED' && (!filters.staffId || member.id === filters.staffId)).map(member => {
      const referrals = this.referrals.filter(item => item.staffId === member.id && (!filters.oaId || item.oaId === filters.oaId));
      const events = this.events.filter(event => event.staffId === member.id && (!filters.oaId || event.oaId === filters.oaId) && inRange(event));
      const clicks = events.filter(event => event.type === 'CLICK').length;
      const logins = events.filter(event => event.type === 'LOGIN').length;
      const follows = events.filter(event => event.type === 'FOLLOW_VERIFIED').length;
      const activity = events.map(event => event.occurredAt).sort().at(-1);
      return { staffId: member.id, staffName: member.displayName, email: member.email, activeLinks: referrals.filter(item => item.status === 'ACTIVE' && (!item.expiresAt || item.expiresAt > new Date().toISOString())).length, clicks, logins, followVerified: follows, conversionRate: clicks ? Number(((follows / clicks) * 100).toFixed(2)) : 0, latestActivity: activity || null };
    });
  }
  listEvents() { return this.events.map(event => ({ ...event })); }
  listAudit() { return this.audit.map(item => ({ ...item })); }
}

export function mockWebhookSignature(rawBody: string) {
  const secret = process.env.MOCK_WEBHOOK_SECRET || 'line-ccc-local-dry-run-webhook-key';
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

export function isValidMockWebhookSignature(rawBody: string, signature: string | undefined) {
  if (!signature) return false;
  const expected = mockWebhookSignature(rawBody);
  const a = Buffer.from(signature, 'base64');
  const b = Buffer.from(expected, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}
