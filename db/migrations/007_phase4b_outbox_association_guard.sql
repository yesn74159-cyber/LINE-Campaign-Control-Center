-- Keep the Phase 4B ledger bound to the exact OA selected by its scheduler job.
-- This is additive because migration 006 may already be recorded as applied.
create or replace function check_outbox_workspace() returns trigger
language plpgsql
as $$
declare
  job_workspace uuid;
  job_oa uuid;
  oa_workspace uuid;
begin
  select workspace_id, oa_integration_id into job_workspace, job_oa
  from scheduler_jobs
  where id = new.scheduler_job_id;

  select workspace_id into oa_workspace
  from oa_integrations
  where id = new.oa_integration_id;

  if job_workspace is null or oa_workspace is null
     or new.workspace_id <> job_workspace
     or new.workspace_id <> oa_workspace
     or new.oa_integration_id <> job_oa then
    raise exception 'outbox delivery references resources from another workspace or OA';
  end if;
  return new;
end;
$$;
