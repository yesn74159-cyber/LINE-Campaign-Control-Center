-- PROPOSAL ONLY — supporting indexes for the seven FK columns reported by the
-- 2026-10-21 audit. CREATE INDEX CONCURRENTLY cannot run inside a transaction,
-- so run each statement individually outside a transaction:
--   psql "$DATABASE_URL" -f 013_fk_supporting_indexes.sql
-- Rollback: drop each index concurrently with the matching name.

create index concurrently if not exists scheduler_jobs_campaign_revision_idx
  on scheduler_jobs(campaign_revision_id);
create index concurrently if not exists scheduler_jobs_oa_integration_idx
  on scheduler_jobs(oa_integration_id);
create index concurrently if not exists scheduler_jobs_workspace_idx
  on scheduler_jobs(workspace_id);
create index concurrently if not exists audit_log_workspace_idx
  on audit_log(workspace_id);
create index concurrently if not exists webhook_events_workspace_idx
  on webhook_events(workspace_id);
create index concurrently if not exists auth_sessions_user_idx
  on auth_sessions(user_id);
create index concurrently if not exists outbox_deliveries_oa_integration_idx
  on outbox_deliveries(oa_integration_id);
