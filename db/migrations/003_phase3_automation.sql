-- Phase 3 staging automation. No provider credentials or outbound LINE calls.
alter table scheduler_jobs add column if not exists time_zone text not null default 'Asia/Bangkok';
alter table scheduler_jobs add column if not exists claimed_at timestamptz;
alter table scheduler_jobs add column if not exists claimed_by text;
alter table scheduler_jobs add column if not exists updated_at timestamptz not null default now();
alter table scheduler_jobs add column if not exists max_attempts integer not null default 3;

alter table scheduler_jobs drop constraint if exists scheduler_jobs_status_check;
update scheduler_jobs set status='SCHEDULED' where status='QUEUED';
update scheduler_jobs set status='CANCELLED' where status='CANCELED';
update scheduler_jobs set status='FAILED' where status='FAILED_FINAL';
alter table scheduler_jobs add constraint scheduler_jobs_status_check check (status in ('DRAFT','SCHEDULED','PAUSED','CLAIMED','SENDING','RETRYABLE','COMPLETED','FAILED','CANCELLED','QUEUED','CANCELED','FAILED_FINAL'));
alter table scheduler_jobs add constraint scheduler_jobs_attempts_check check (attempts >= 0 and max_attempts between 1 and 10);

update scheduler_jobs set updated_at=coalesce(updated_at, created_at), time_zone=coalesce(nullif(time_zone,''),'Asia/Bangkok');
create index if not exists scheduler_jobs_worker_idx on scheduler_jobs (status, available_at, scheduled_at, updated_at);
