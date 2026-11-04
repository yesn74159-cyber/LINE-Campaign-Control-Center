import type { Pool } from 'pg';

const DAY_MS = 86_400_000;

/** Only deliveries whose outcome is already written down may age out. */
const TERMINAL_DELIVERY_STATUSES = ['SENT', 'FAILED', 'SKIPPED'];

export interface PruneOptions {
  days: number;
  dryRun: boolean;
  batchSize?: number;
  now?: Date;
}

export interface PruneResult {
  cutoff: string;
  dryRun: boolean;
  tables: { table: string; candidates: number; deleted: number }[];
}

function assertDays(days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('days must be an integer between 1 and 3650');
}

/**
 * Age out append-only history. Deletes run in id batches so a backlog on a small VM does not
 * hold one long transaction, and `outbox_deliveries` keeps every row whose send is still in
 * flight or unresolved (PENDING/SENDING/RETRYABLE/UNKNOWN) no matter how old it is.
 */
export async function pruneHistory(pool: Pool, options: PruneOptions): Promise<PruneResult> {
  assertDays(options.days);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.valueOf() - options.days * DAY_MS).toISOString();
  const batchSize = Math.min(Math.max(options.batchSize ?? 5000, 1), 50_000);
  const targets = [
    { table: 'webhook_events', predicate: 'received_at < $1', args: [cutoff] },
    { table: 'audit_log', predicate: 'created_at < $1', args: [cutoff] },
    { table: 'outbox_deliveries', predicate: 'created_at < $1 and status = any($2::text[])', args: [cutoff, TERMINAL_DELIVERY_STATUSES] }
  ];

  const tables: PruneResult['tables'] = [];
  for (const target of targets) {
    const counted = await pool.query<{ count: number }>(`select count(*)::int as count from ${target.table} where ${target.predicate}`, target.args);
    const candidates = Number(counted.rows[0]?.count || 0);
    if (options.dryRun) {
      tables.push({ table: target.table, candidates, deleted: 0 });
      continue;
    }
    let deleted = 0;
    const batchArgs = [...target.args, batchSize];
    const limit = `$${batchArgs.length}`;
    while (deleted < candidates) {
      const result = await pool.query(
        `delete from ${target.table} where id in (select id from ${target.table} where ${target.predicate} limit ${limit})`,
        batchArgs
      );
      const removed = result.rowCount || 0;
      deleted += removed;
      if (removed < batchSize) break;
    }
    tables.push({ table: target.table, candidates, deleted });
  }
  return { cutoff, dryRun: options.dryRun, tables };
}
