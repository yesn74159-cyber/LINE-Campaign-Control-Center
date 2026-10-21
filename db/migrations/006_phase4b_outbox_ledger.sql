-- Phase 4B durable delivery ledger. This table stores staging delivery state only;
-- no provider token, channel secret, or raw credential is stored here.
create table if not exists outbox_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  scheduler_job_id uuid not null references scheduler_jobs(id) on delete cascade,
  oa_integration_id uuid not null references oa_integrations(id) on delete restrict,
  recipient_key text not null,
  idempotency_key uuid not null unique,
  line_retry_key uuid not null,
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','RETRYABLE','FAILED','UNKNOWN','SKIPPED')),
  attempts integer not null default 0 check (attempts >= 0),
  provider_status integer,
  provider_request_id text,
  last_error text,
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scheduler_job_id, recipient_key)
);

create index if not exists outbox_deliveries_status_idx on outbox_deliveries (status, updated_at);
create index if not exists outbox_deliveries_workspace_idx on outbox_deliveries (workspace_id, created_at desc);

create or replace function check_outbox_workspace() returns trigger
language plpgsql
as $$
declare
  job_workspace uuid;
  oa_workspace uuid;
begin
  select workspace_id into job_workspace from scheduler_jobs where id = new.scheduler_job_id;
  select workspace_id into oa_workspace from oa_integrations where id = new.oa_integration_id;
  if job_workspace is null or oa_workspace is null or new.workspace_id <> job_workspace or new.workspace_id <> oa_workspace then
    raise exception 'outbox delivery references resources from another workspace';
  end if;
  return new;
end;
$$;

drop trigger if exists outbox_deliveries_workspace_guard on outbox_deliveries;
create trigger outbox_deliveries_workspace_guard
before insert or update of workspace_id, scheduler_job_id, oa_integration_id on outbox_deliveries
for each row execute function check_outbox_workspace();
