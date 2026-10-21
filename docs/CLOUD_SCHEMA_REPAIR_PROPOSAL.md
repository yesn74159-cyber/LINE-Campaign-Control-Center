# Cloud Schema Repair Migration Proposal

Target: Supabase project `bgwsxoeseyqwwcupzeoo`, schema `line_ccc`.

**Status: proposal only. Nothing in this file has been applied.** Do not run these statements until the read-only Cloud audit is complete and the owner approves the exact target, backend role, ledger rows, and repair order.

## Preconditions

1. Run [cloud_schema_audit.sql](../db/queries/cloud_schema_audit.sql) through the approved Supabase Connector or a server process with a hidden `DATABASE_URL`. Keep the result read-only.
2. Confirm all 14 expected tables and every final column/default/constraint against migrations 001–007.
3. Confirm that no existing `schema_migrations` table in any schema is the application ledger for this checkout.
4. Compare Cloud catalog state with the source migration hashes below. A Supabase History record is not an application ledger record.
5. Identify the actual server backend role. Do not replace `<BACKEND_ROLE>` with `anon`, `authenticated`, or a guessed service role.
6. Confirm a backup/restore point and a maintenance procedure for `CREATE INDEX CONCURRENTLY` before any index operation.

## Source migration fingerprints

These SHA-256 values describe the current local SQL files and are evidence for reconciliation. They do not prove that the same SQL was applied in Cloud.

| File | SHA-256 |
| --- | --- |
| `001_control_center.sql` | `F8D1A5D0E0D48223C8E7BE13114566B256A6518027AE28B98623AF468FF73777` |
| `002_phase2_auth.sql` | `C6009BD9C92C36B1F90E9A02CD3D7CA4F6226B939D8060336CE243ABABD07707` |
| `003_phase3_automation.sql` | `E20351269FFEA08D4AF007DAD9E44CA733ED2BF0CBD70090CD55FBAE029163A7` |
| `004_phase35_staging_hardening.sql` | `722BA333B4A29725FF11A6AD3A34EABF84E52B754BE708AE6E297584D58BA91A` |
| `005_phase4a_oa_readiness.sql` | `118F6953B34C3993E080C0E65928D2870669AD0AE62BEFE1B20FD0C6AFBFBB7C` |
| `006_phase4b_outbox_ledger.sql` | `D2E61D6FD058599D3FAF6DEECF58EBBA816A4DF1ABC742A12B5A62008BA616EE` |
| `007_phase4b_outbox_association_guard.sql` | `6F9123C4BA1FC1A4898EA47D84B7B49E1874EE64A6B45CF4DED03B29901CDD0F` |

## Final source inventory

The final expected tables are: `workspaces`, `oa_integrations`, `customers`, `campaigns`, `campaign_revisions`, `scheduler_jobs`, `audit_log`, `webhook_events`, `admin_users`, `auth_sessions`, `workspace_controls`, `campaign_controls`, `oa_rate_limit_windows`, and `outbox_deliveries`.

The final column additions after 001 are:

- `campaigns`: `title`, `description`, `image`, `cta`, `flex_file`.
- `scheduler_jobs`: `time_zone`, `claimed_at`, `claimed_by`, `updated_at`, `max_attempts`.
- `oa_integrations`: `connection_status`, `credential_status`, `quota_per_minute`, `monthly_quota`, `monthly_used`, `kill_switch`, `kill_switch_reason`, `last_validated_at`, `validation_error`.

The final staging constraints are:

- `scheduler_jobs.status` is limited to `DRAFT`, `SCHEDULED`, `PAUSED`, `CLAIMED`, `SENDING`, `RETRYABLE`, `COMPLETED`, `FAILED`, or `CANCELLED`.
- `scheduler_jobs.mode` must be `DRY_RUN`.
- `scheduler_jobs.time_zone` must be `Asia/Bangkok`.
- `scheduler_jobs.attempts >= 0` and `max_attempts between 1 and 10`.
- OA readiness fields use the exact values defined in migration 005.
- Workspace and campaign control fields use the exact checks defined in migration 005.
- Outbox status and attempts use the exact checks defined in migration 006.

The source indexes are:

| Existing source index | Columns / predicate |
| --- | --- |
| `workspaces_name_unique` | `workspaces(name)` |
| `scheduler_jobs_claim_idx` | `scheduler_jobs(status, available_at)` |
| `scheduler_jobs_worker_idx` | `scheduler_jobs(status, available_at, scheduled_at, updated_at)` |
| `auth_sessions_active_idx` | `auth_sessions(token_hash, expires_at)` where `revoked_at is null` |
| `outbox_deliveries_status_idx` | `outbox_deliveries(status, updated_at)` |
| `outbox_deliveries_workspace_idx` | `outbox_deliveries(workspace_id, created_at desc)` |

Primary keys, unique constraints, foreign keys, checks, and triggers must be compared from the exact `pg_get_constraintdef`, `pg_get_triggerdef`, and `pg_get_functiondef` output. The two source trigger functions are `check_scheduler_job_workspace()` and the final 007 version of `check_outbox_workspace()`.

## Repair order

### A. Application ledger, additive and empty first

The application expects filenames in the `version` column, for example `001_control_center.sql`. The proposed table shape is:

```sql
create table line_ccc.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now(),
  checksum text,
  source text not null default 'line-ccc'
);
```

This is a proposal only. Do not create it until the audit confirms that the relation is absent and the owner approves. Do not backfill `001`–`007` solely because Supabase History contains those labels. Backfill one filename only after its catalog state and source hash have been reviewed. Do not run the SQL bodies as part of ledger reconciliation.

### B. Foreign-key indexes, additive and concurrent

The seven Advisor findings should be mapped to the exact Cloud foreign keys before naming indexes. The candidate plan, subject to the audit confirming no equivalent index exists, is:

```sql
create index concurrently if not exists scheduler_jobs_campaign_revision_id_idx on line_ccc.scheduler_jobs (campaign_revision_id);
create index concurrently if not exists scheduler_jobs_oa_integration_id_idx on line_ccc.scheduler_jobs (oa_integration_id);
create index concurrently if not exists scheduler_jobs_workspace_id_idx on line_ccc.scheduler_jobs (workspace_id);
create index concurrently if not exists audit_log_workspace_id_idx on line_ccc.audit_log (workspace_id);
create index concurrently if not exists webhook_events_workspace_id_idx on line_ccc.webhook_events (workspace_id);
create index concurrently if not exists auth_sessions_user_id_idx on line_ccc.auth_sessions (user_id);
create index concurrently if not exists outbox_deliveries_oa_integration_id_idx on line_ccc.outbox_deliveries (oa_integration_id);
```

These statements must run outside a transaction and only after the actual Advisor mapping is confirmed. They have not been run.

### C. Confirmed schema drift only

For a missing column, constraint, or table, prepare a narrowly scoped `ADD` statement with a precondition check. For a trigger or function difference, review the exact Cloud definition first. Migration 003, 004, 005, 006, and 007 contain updates, inserts, constraint replacement, trigger replacement, and function replacement; rerunning them is not an additive repair strategy.

The source functions do not declare an explicit function-level `search_path`. The audit must confirm the effective setting and whether the backend connection supplies `line_ccc, extensions`. If the owner approves a function hardening change, use an exact reviewed `CREATE OR REPLACE FUNCTION line_ccc... SET search_path = line_ccc, extensions` migration after preserving the current function body and testing trigger behavior. Do not add `SECURITY DEFINER` as a shortcut.

### D. Backend-only RLS and privileges

After effective privilege review, prepare a separate policy migration. The intended outcome is:

```sql
-- Placeholder only. Replace <BACKEND_ROLE> after the read-only audit.
revoke all on schema line_ccc from anon, authenticated;
revoke all on all tables in schema line_ccc from anon, authenticated;
alter default privileges in schema line_ccc revoke all on tables from anon, authenticated;

-- Repeat for each of the 14 tables after reviewing the backend role.
alter table line_ccc.workspaces enable row level security;
create policy backend_only_workspaces on line_ccc.workspaces
  for all to <BACKEND_ROLE> using (true) with check (true);
```

This block is intentionally incomplete and must not be executed as-is. The final policy must cover every table, avoid client roles, and account for whether the backend role owns the tables or bypasses RLS. No RLS or GRANT change is authorized in this task.

## Rollback and verification

The ledger table and indexes are additive and can be removed only through a separately approved rollback plan. Do not use `DROP` as a drift shortcut. After any approved apply, rerun the read-only audit, verify all 14 row counts remain unchanged, run the server-only connection check, and rerun local regression/security/typecheck/build. Keep `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false`, and `LINE_WEBHOOK_ENABLED=false`.

**Approval gate:** Database Password or hidden `DATABASE_URL` entry is needed only for the server-side read-only connection test. It is not needed for this static proposal. No online schema change may proceed without a separate explicit approval after the read-only result is reviewed.
