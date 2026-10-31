import { createHash, randomBytes } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

export type ReferralStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED';
export type ReferralView = {
  id: string;
  staffId: string;
  oaId: string;
  status: ReferralStatus;
  expiresAt?: string;
  createdAt: string;
};
export type ReferralDashboardRow = {
  staffId: string;
  staffName: string;
  email: string;
  activeLinks: number;
  clicks: number;
  logins: number;
  followVerified: number;
  conversionRate: number;
  latestActivity: string | null;
};
export type ReferralEventView = {
  id: string;
  referralId: string;
  workspaceId: string;
  staffId: string;
  oaId: string;
  type: 'CLICK' | 'LOGIN' | 'FOLLOW_VERIFIED';
  evidenceRef?: string;
  occurredAt: string;
};
export type ReferralStaffView = { id: string; displayName: string; email: string; active: boolean };
export type ReferralFollowResult = { accepted: true; duplicate: boolean; matched: boolean; referralId?: string };

export class ReferralError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'ReferralError';
  }
}

export const REFERRAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REFERRAL_TTL_MS = 366 * 24 * 60 * 60 * 1000;

export function hashReferralToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function referralUrl(token: string) {
  const configured = process.env.PUBLIC_APP_ORIGIN || 'http://127.0.0.1:5173';
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    throw new ReferralError('PUBLIC_APP_ORIGIN is not a valid URL', 500);
  }
  if (!['http:', 'https:'].includes(origin.protocol)) throw new ReferralError('PUBLIC_APP_ORIGIN must use http or https', 500);
  return `${origin.origin}/r/${encodeURIComponent(token)}`;
}

function iso(value: unknown) {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function assertUuid(value: string | undefined, field: string, required = false) {
  if (!value) {
    if (required) throw new ReferralError(`${field} is required`);
    return null;
  }
  if (!UUID_PATTERN.test(value)) throw new ReferralError(`${field} is invalid`);
  return value;
}

function parseRange(value: string | undefined, field: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new ReferralError(`${field} must be a valid ISO date`);
  return parsed.toISOString();
}

function mapReferral(row: QueryResultRow): ReferralView {
  return {
    id: String(row.id),
    staffId: String(row.staffId),
    oaId: String(row.oaId),
    status: row.status as ReferralStatus,
    expiresAt: row.expires_at ? iso(row.expires_at) : undefined,
    createdAt: iso(row.created_at)
  };
}

export async function createReferral(pool: Pool, input: {
  workspaceId: string;
  staffId: string;
  oaId: string;
  expiresAt?: string;
  actor: string;
}) {
  const staffId = assertUuid(input.staffId, 'staffId', true)!;
  const oaId = assertUuid(input.oaId, 'oaId', true)!;
  let expiresAt: string | null = null;
  if (input.expiresAt) {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.valueOf())) throw new ReferralError('expiresAt must be a valid ISO date');
    if (parsed.getTime() <= Date.now()) throw new ReferralError('expiresAt must be in the future');
    if (parsed.getTime() > Date.now() + MAX_REFERRAL_TTL_MS) throw new ReferralError('expiresAt must be within 366 days');
    expiresAt = parsed.toISOString();
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const staff = await client.query(
      `select u.id
       from admin_users u
       join workspace_memberships m on m.admin_user_id=u.id and m.workspace_id=u.workspace_id
       where u.workspace_id=$1 and u.id=$2 and u.active=true and m.status='ACTIVE'
       limit 2`,
      [input.workspaceId, staffId]
    );
    if (staff.rows.length !== 1) throw new ReferralError('staff member is not active in this workspace');
    const oa = await client.query(
      "select id from oa_integrations where workspace_id=$1 and id=$2 and environment='STAGING' and enabled=true limit 2",
      [input.workspaceId, oaId]
    );
    if (oa.rows.length !== 1) throw new ReferralError('selected OA is not an enabled staging OA in this workspace');

    const plainToken = randomBytes(32).toString('base64url');
    const inserted = await client.query(
      `insert into staff_invite_links(workspace_id,admin_user_id,oa_integration_id,token_hash,status,expires_at)
       values ($1,$2,$3,$4,'ACTIVE',$5)
       returning id, admin_user_id as "staffId", oa_integration_id as "oaId", status, expires_at, created_at`,
      [input.workspaceId, staffId, oaId, hashReferralToken(plainToken), expiresAt]
    );
    const referral = mapReferral(inserted.rows[0]);
    await client.query(
      "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,'REFERRAL_CREATED','referral',$3,$4::jsonb)",
      [input.workspaceId, input.actor, referral.id, JSON.stringify({ detail: `Referral link created for staff ${staffId} and OA ${oaId}`, oaId })]
    );
    await client.query('commit');
    return { referral, plainToken, url: referralUrl(plainToken) };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listReferrals(pool: Pool, workspaceId: string, filters: { staffId?: string; oaId?: string }) {
  const staffId = assertUuid(filters.staffId, 'staffId');
  const oaId = assertUuid(filters.oaId, 'oaId');
  const result = await pool.query(
    `select id, admin_user_id as "staffId", oa_integration_id as "oaId", status, expires_at, created_at
     from staff_invite_links
     where workspace_id=$1
       and ($2::uuid is null or admin_user_id=$2)
       and ($3::uuid is null or oa_integration_id=$3)
     order by created_at desc
     limit 200`,
    [workspaceId, staffId, oaId]
  );
  return result.rows.map(mapReferral);
}

export async function setReferralStatus(pool: Pool, workspaceId: string, referralId: string, status: ReferralStatus, actor: string) {
  const id = assertUuid(referralId, 'referralId', true)!;
  if (!['ACTIVE', 'PAUSED', 'REVOKED'].includes(status)) throw new ReferralError('referral status is invalid');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query<{ status: ReferralStatus }>('select status from staff_invite_links where id=$1 and workspace_id=$2 for update', [id, workspaceId]);
    if (!current.rows[0]) throw new ReferralError('referral link is not in this workspace', 404);
    if (current.rows[0].status === 'REVOKED' && status !== 'REVOKED') throw new ReferralError('revoked referral links cannot be reactivated');
    const updated = await client.query(
      `update staff_invite_links set status=$3
       where id=$1 and workspace_id=$2
       returning id, admin_user_id as "staffId", oa_integration_id as "oaId", status, expires_at, created_at`,
      [id, workspaceId, status]
    );
    await client.query(
      "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,$3,'referral',$4,$5::jsonb)",
      [workspaceId, actor, `REFERRAL_${status}`, id, JSON.stringify({ detail: `Referral status changed to ${status}` })]
    );
    await client.query('commit');
    return mapReferral(updated.rows[0]);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordClick(pool: Pool, token: string) {
  if (!REFERRAL_TOKEN_PATTERN.test(token)) throw new ReferralError('referral link is invalid or inactive', 404);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const resolved = await client.query<{ id: string; workspace_id: string; oaId: string; staffName: string }>(
      `select il.id, il.workspace_id, il.oa_integration_id as "oaId", u.display_name as "staffName"
       from staff_invite_links il
       join admin_users u on u.id=il.admin_user_id and u.workspace_id=il.workspace_id and u.active=true
       join workspace_memberships m on m.admin_user_id=u.id and m.workspace_id=u.workspace_id and m.status='ACTIVE'
       join oa_integrations oa on oa.id=il.oa_integration_id and oa.workspace_id=il.workspace_id and oa.enabled=true and oa.environment='STAGING'
       where il.token_hash=$1 and il.status='ACTIVE' and (il.expires_at is null or il.expires_at>now())
       limit 2`,
      [hashReferralToken(token)]
    );
    if (resolved.rows.length !== 1) throw new ReferralError('referral link is invalid or inactive', 404);
    const referral = resolved.rows[0];
    await client.query(
      `insert into referral_attribution_events(workspace_id,invite_link_id,oa_integration_id,event_type)
       values ($1,$2,$3,'CLICK')`,
      [referral.workspace_id, referral.id, referral.oaId]
    );
    await client.query('commit');
    return {
      referral: { id: referral.id, oaId: referral.oaId, status: 'ACTIVE' as const },
      staffName: referral.staffName,
      oaId: referral.oaId,
      next: 'LINE_LOGIN'
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getReferralStaff(pool: Pool, workspaceId: string): Promise<ReferralStaffView[]> {
  const result = await pool.query(
    `select u.id, u.display_name as "displayName", u.email,
            (u.active=true and m.status='ACTIVE') as active
     from workspace_memberships m
     join admin_users u on u.id=m.admin_user_id and u.workspace_id=m.workspace_id
     where m.workspace_id=$1
     order by u.created_at`,
    [workspaceId]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    displayName: String(row.displayName),
    email: String(row.email),
    active: Boolean(row.active)
  }));
}

export async function referralDashboard(pool: Pool, workspaceId: string, filters: { staffId?: string; oaId?: string; from?: string; to?: string }) {
  const staffId = assertUuid(filters.staffId, 'staffId');
  const oaId = assertUuid(filters.oaId, 'oaId');
  const from = parseRange(filters.from, 'from');
  const to = parseRange(filters.to, 'to');
  if (from && to && from > to) throw new ReferralError('from must be before to');
  const result = await pool.query(
    `select u.id as "staffId", u.display_name as "staffName", u.email,
            coalesce(links.active_links,0)::int as "activeLinks",
            coalesce(ev.clicks,0)::int as clicks,
            coalesce(ev.logins,0)::int as logins,
            coalesce(ev.follow_verified,0)::int as "followVerified",
            ev.latest_activity as "latestActivity"
     from workspace_memberships m
     join admin_users u on u.id=m.admin_user_id and u.workspace_id=m.workspace_id
     left join lateral (
       select count(*)::int as active_links
       from staff_invite_links il
       where il.workspace_id=u.workspace_id and il.admin_user_id=u.id
         and il.status='ACTIVE' and (il.expires_at is null or il.expires_at>now())
         and ($2::uuid is null or il.oa_integration_id=$2)
     ) links on true
     left join lateral (
       select count(*) filter (where e.event_type='CLICK')::int as clicks,
              count(*) filter (where e.event_type='LOGIN')::int as logins,
              count(*) filter (where e.event_type='FOLLOW_VERIFIED')::int as follow_verified,
              max(e.occurred_at) as latest_activity
       from referral_attribution_events e
       join staff_invite_links il on il.id=e.invite_link_id and il.workspace_id=e.workspace_id and il.oa_integration_id=e.oa_integration_id
       where e.workspace_id=u.workspace_id and il.admin_user_id=u.id
         and ($2::uuid is null or e.oa_integration_id=$2)
         and ($3::timestamptz is null or e.occurred_at >= $3)
         and ($4::timestamptz is null or e.occurred_at <= $4)
     ) ev on true
     where m.workspace_id=$1 and m.status='ACTIVE' and u.active=true
       and ($5::uuid is null or u.id=$5)
     order by u.created_at`,
    [workspaceId, oaId, from, to, staffId]
  );
  return result.rows.map((row): ReferralDashboardRow => {
    const clicks = Number(row.clicks);
    const followVerified = Number(row.followVerified);
    return {
      staffId: String(row.staffId),
      staffName: String(row.staffName),
      email: String(row.email),
      activeLinks: Number(row.activeLinks),
      clicks,
      logins: Number(row.logins),
      followVerified,
      conversionRate: clicks ? Number(((followVerified / clicks) * 100).toFixed(2)) : 0,
      latestActivity: row.latestActivity ? iso(row.latestActivity) : null
    };
  });
}

export async function listReferralEvents(pool: Pool, workspaceId: string): Promise<ReferralEventView[]> {
  const result = await pool.query(
    `select e.id, e.workspace_id as "workspaceId", e.invite_link_id as "referralId",
            il.admin_user_id as "staffId", e.oa_integration_id as "oaId",
            e.event_type as type, e.evidence_ref as "evidenceRef", e.occurred_at as "occurredAt"
     from referral_attribution_events e
     join staff_invite_links il on il.id=e.invite_link_id and il.workspace_id=e.workspace_id and il.oa_integration_id=e.oa_integration_id
     where e.workspace_id=$1
     order by e.occurred_at desc
     limit 100`,
    [workspaceId]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    referralId: String(row.referralId),
    workspaceId: String(row.workspaceId),
    staffId: String(row.staffId),
    oaId: String(row.oaId),
    type: row.type as ReferralEventView['type'],
    evidenceRef: row.evidenceRef ? String(row.evidenceRef) : undefined,
    occurredAt: iso(row.occurredAt)
  }));
}

export async function verifyReferralFollow(pool: Pool, input: {
  oaId: string;
  eventId: string;
  followerSubjectHmac: string;
  evidenceRef: string;
  occurredAt?: Date;
}): Promise<ReferralFollowResult> {
  const oaId = assertUuid(input.oaId, 'oaId', true)!;
  if (!/^[a-f0-9]{64}$/.test(input.followerSubjectHmac)) throw new ReferralError('follow subject digest is invalid');
  if (!input.eventId || input.eventId.length > 200) throw new ReferralError('follow evidence event id is invalid');
  const evidenceRef = input.evidenceRef.trim();
  if (!evidenceRef || evidenceRef.length > 240) throw new ReferralError('follow evidence reference is invalid');
  const occurredAt = input.occurredAt && Number.isFinite(input.occurredAt.getTime()) ? input.occurredAt : new Date();

  const client = await pool.connect();
  try {
    await client.query('begin');
    const oa = await client.query<{ workspace_id: string }>("select workspace_id from oa_integrations where id=$1 and environment='STAGING'", [oaId]);
    if (!oa.rows[0]) {
      await client.query('rollback');
      return { accepted: true, duplicate: false, matched: false };
    }
    const workspaceId = String(oa.rows[0].workspace_id);
    const customer = await client.query<{ id: string; attributed_invite_link_id: string }>(
      `select id, attributed_invite_link_id
       from line_customers
       where workspace_id=$1 and oa_integration_id=$2 and line_subject_hmac=$3
       limit 2`,
      [workspaceId, oaId, input.followerSubjectHmac]
    );
    if (customer.rows.length !== 1) {
      await client.query('rollback');
      return { accepted: true, duplicate: false, matched: false };
    }
    const attribution = customer.rows[0];
    const inserted = await client.query<{ id: string }>(
      `insert into referral_attribution_events(
         workspace_id,invite_link_id,oa_integration_id,event_type,
         follower_subject_hmac,evidence_ref,evidence_event_id,customer_id,occurred_at
       ) values ($1,$2,$3,'FOLLOW_VERIFIED',$4,$5,$6,$7,$8)
       on conflict do nothing
       returning id`,
      [workspaceId, attribution.attributed_invite_link_id, oaId, input.followerSubjectHmac, evidenceRef, input.eventId, attribution.id, occurredAt.toISOString()]
    );
    const duplicate = inserted.rowCount === 0;
    if (!duplicate) {
      await client.query(
        "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,'line-webhook','FOLLOW_VERIFIED','referral',$2,$3::jsonb)",
        [workspaceId, attribution.attributed_invite_link_id, JSON.stringify({ detail: `Signed webhook follow evidence accepted (${input.eventId})`, evidenceEventId: input.eventId, customerId: attribution.id })]
      );
    }
    await client.query('commit');
    return { accepted: true, duplicate, matched: true, referralId: String(attribution.attributed_invite_link_id) };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
