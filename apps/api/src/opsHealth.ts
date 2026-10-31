import type { Pool } from 'pg';

export type OpsThresholds = {
  stuckMinutes: number;
  workerStaleMinutes: number;
  quotaWarnPercent: number;
};

export type QuotaHealth = {
  oaId: string;
  displayName: string;
  limitPerMinute: number;
  usedThisMinute: number;
  monthlyQuota: number;
  monthlyUsed: number;
  monthlyPercent: number;
};

export type DeliveryHealth = {
  generatedAt: string;
  counts: {
    pending: number;
    sending: number;
    retryable: number;
    unknown: number;
    sent: number;
    failed: number;
    skipped: number;
    stuck: number;
  };
  oldestPendingSeconds: number | null;
  lastWorkerActivity: string | null;
  workerStale: boolean;
  quota: QuotaHealth[];
  alerts: string[];
  ok: boolean;
};

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function opsThresholds(env: NodeJS.ProcessEnv = process.env): OpsThresholds {
  return {
    stuckMinutes: integerEnv(env, 'OPS_STUCK_MINUTES', 15, 1, 1440),
    workerStaleMinutes: integerEnv(env, 'OPS_WORKER_STALE_MINUTES', 10, 1, 1440),
    quotaWarnPercent: integerEnv(env, 'OPS_QUOTA_WARN_PERCENT', 80, 1, 100)
  };
}

type DeliveryRow = {
  pending: number;
  sending: number;
  retryable: number;
  unknown: number;
  sent: number;
  failed: number;
  skipped: number;
  stuck: number;
  oldest_pending_seconds: string | number | null;
  last_worker_activity: Date | string | null;
};

type QuotaRow = {
  id: string;
  display_name: string;
  quota_per_minute: number;
  monthly_quota: number;
  monthly_used: number;
  used_this_minute: number;
};

/**
 * Read-only operational snapshot for outbox health. It exposes aggregate counts
 * only: no recipient keys, push bodies, tokens, or secrets.
 */
export async function readDeliveryHealth(pool: Pool, input: { workspaceId?: string | null; now?: Date; thresholds?: OpsThresholds } = {}): Promise<DeliveryHealth> {
  const now = input.now || new Date();
  const thresholds = input.thresholds || opsThresholds();
  const workspaceId = input.workspaceId || null;
  const delivery = await pool.query<DeliveryRow>(
    `with delivery as (
       select
         count(*) filter (where status='PENDING')::int as pending,
         count(*) filter (where status='SENDING')::int as sending,
         count(*) filter (where status='RETRYABLE')::int as retryable,
         count(*) filter (where status='UNKNOWN')::int as unknown,
         count(*) filter (where status='SENT')::int as sent,
         count(*) filter (where status='FAILED')::int as failed,
         count(*) filter (where status='SKIPPED')::int as skipped,
         count(*) filter (where status in ('PENDING','SENDING','RETRYABLE') and updated_at < now() - ($2::int * interval '1 minute'))::int as stuck,
         extract(epoch from now() - (min(updated_at) filter (where status in ('PENDING','SENDING','RETRYABLE'))))::bigint as oldest_pending_seconds
       from outbox_deliveries
       where ($1::uuid is null or workspace_id=$1)
     )
     select d.*,
       (select max(created_at) from audit_log where ($1::uuid is null or workspace_id=$1) and action in ('WORKER_CLAIMED','WORKER_COMPLETED','WORKER_RETRY','WORKER_FAILED','WORKER_RECOVERED')) as last_worker_activity
     from delivery d`,
    [workspaceId, thresholds.stuckMinutes]
  );
  const quota = await pool.query<QuotaRow>(
    `select oa.id, oa.display_name, oa.quota_per_minute, oa.monthly_quota, oa.monthly_used,
       coalesce(w.used_count, 0)::int as used_this_minute
     from oa_integrations oa
     left join oa_rate_limit_windows w
       on w.oa_integration_id=oa.id and w.window_started_at=date_trunc('minute', now())
     where ($1::uuid is null or oa.workspace_id=$1) and oa.environment='STAGING' and oa.enabled
     order by oa.display_name`,
    [workspaceId]
  );
  const row = delivery.rows[0];
  const counts = {
    pending: Number(row?.pending || 0),
    sending: Number(row?.sending || 0),
    retryable: Number(row?.retryable || 0),
    unknown: Number(row?.unknown || 0),
    sent: Number(row?.sent || 0),
    failed: Number(row?.failed || 0),
    skipped: Number(row?.skipped || 0),
    stuck: Number(row?.stuck || 0)
  };
  const oldestPendingSeconds = row?.oldest_pending_seconds == null ? null : Number(row.oldest_pending_seconds);
  const lastWorkerActivity = row?.last_worker_activity ? new Date(row.last_worker_activity).toISOString() : null;
  const inFlight = counts.pending + counts.sending + counts.retryable;
  const workerStale = inFlight > 0 && (lastWorkerActivity === null || now.getTime() - Date.parse(lastWorkerActivity) > thresholds.workerStaleMinutes * 60_000);
  const quotas = quota.rows.map((item) => {
    const monthlyQuota = Number(item.monthly_quota);
    const monthlyUsed = Number(item.monthly_used);
    return {
      oaId: String(item.id),
      displayName: String(item.display_name),
      limitPerMinute: Number(item.quota_per_minute),
      usedThisMinute: Number(item.used_this_minute),
      monthlyQuota,
      monthlyUsed,
      monthlyPercent: monthlyQuota > 0 ? Math.min(100, Math.round((monthlyUsed / monthlyQuota) * 100)) : 0
    };
  });
  const alerts: string[] = [];
  if (counts.unknown > 0) alerts.push('UNKNOWN_DELIVERIES');
  if (counts.stuck > 0) alerts.push('STUCK_DELIVERIES');
  if (workerStale) alerts.push('WORKER_STALE');
  if (quotas.some((item) => item.monthlyQuota > 0 && item.monthlyPercent >= thresholds.quotaWarnPercent)) alerts.push('QUOTA_NEAR_LIMIT');
  if (quotas.some((item) => item.usedThisMinute >= item.limitPerMinute)) alerts.push('OA_RATE_LIMIT_REACHED');
  return {
    generatedAt: now.toISOString(),
    counts,
    oldestPendingSeconds,
    lastWorkerActivity,
    workerStale,
    quota: quotas,
    alerts,
    ok: alerts.length === 0
  };
}
