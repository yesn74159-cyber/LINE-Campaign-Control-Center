-- Consent used to change only when LINE told us: a follow event opted someone in and an
-- unfollow set blocked_at. A customer who asks by phone therefore stayed queued until
-- they happened to unfollow. The operator path added in this round can only turn consent
-- OFF; putting someone back on the list still requires their own follow event, which is
-- the only signal we can honestly call consent.
--
-- blocked_at already means "do not send" (prepareOutbox and the push preview filter it),
-- so opt_out_at/opt_out_source record *why* without touching the delivery predicate.

alter table customers
  add column if not exists opt_out_source text,
  add column if not exists opt_out_at timestamptz;

do $$ begin
  alter table customers add constraint customers_opt_out_source_check
    check (opt_out_source is null or opt_out_source in ('operator', 'line_unfollow'));
exception when duplicate_object then null;
end $$;

-- Audience counts in readiness filter (workspace_id, provider_id, blocked_at).
create index if not exists customers_audience_idx
  on customers (workspace_id, provider_id, blocked_at);

-- Retention pruning deletes by age alone, so each table needs a plain timestamp index;
-- the existing workspace-first indexes cannot serve that scan.
create index if not exists audit_log_created_idx on audit_log (created_at);
create index if not exists webhook_events_received_idx on webhook_events (received_at);
create index if not exists outbox_deliveries_created_idx on outbox_deliveries (created_at);
