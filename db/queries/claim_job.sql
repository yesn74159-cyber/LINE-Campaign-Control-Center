-- Durable scheduler claim. Run inside a short transaction and never create a new
-- idempotency key when retrying the same job.
with next_job as (
  select id
  from scheduler_jobs
  where status in ('QUEUED', 'RETRYABLE')
    and available_at <= now()
  order by available_at, created_at
  for update skip locked
  limit 1
)
update scheduler_jobs as job
set status = 'CLAIMED'
from next_job
where job.id = next_job.id
returning job.*;
