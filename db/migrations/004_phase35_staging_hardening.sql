-- Phase 3.5 staging hardening. Keep this database DRY_RUN-only and workspace-scoped.
alter table scheduler_jobs drop constraint if exists scheduler_jobs_status_check;
alter table scheduler_jobs add constraint scheduler_jobs_status_check check (status in ('DRAFT','SCHEDULED','PAUSED','CLAIMED','SENDING','RETRYABLE','COMPLETED','FAILED','CANCELLED'));

alter table scheduler_jobs drop constraint if exists scheduler_jobs_mode_staging_check;
alter table scheduler_jobs add constraint scheduler_jobs_mode_staging_check check (mode = 'DRY_RUN');
alter table scheduler_jobs drop constraint if exists scheduler_jobs_timezone_staging_check;
alter table scheduler_jobs add constraint scheduler_jobs_timezone_staging_check check (time_zone = 'Asia/Bangkok');

create or replace function check_scheduler_job_workspace() returns trigger
language plpgsql
as $$
declare
  revision_workspace uuid;
  oa_workspace uuid;
begin
  select c.workspace_id into revision_workspace
  from campaign_revisions r
  join campaigns c on c.id = r.campaign_id
  where r.id = new.campaign_revision_id;

  select workspace_id into oa_workspace
  from oa_integrations
  where id = new.oa_integration_id;

  if revision_workspace is null or oa_workspace is null or new.workspace_id <> revision_workspace or new.workspace_id <> oa_workspace then
    raise exception 'scheduler job references resources from another workspace';
  end if;
  return new;
end;
$$;

drop trigger if exists scheduler_jobs_workspace_guard on scheduler_jobs;
create trigger scheduler_jobs_workspace_guard
before insert or update of workspace_id, campaign_revision_id, oa_integration_id on scheduler_jobs
for each row execute function check_scheduler_job_workspace();
