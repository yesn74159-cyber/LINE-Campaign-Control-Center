-- 004 pinned scheduler_jobs to DRY_RUN so a staging database could not queue a real send.
-- That check has to go before a scheduled LIVE job can exist at all; until now every real send
-- was a manual push, and every row in this table was DRY_RUN.
--
-- The database is not the gate. The API still requires owner/admin, a typed `confirm: 'LIVE'`
-- and isLiveSendEnabled(), readiness is re-checked at schedule/resume/retry, and the worker
-- re-reads policy before transport. To close the door again, restore the old check:
--   alter table scheduler_jobs drop constraint scheduler_jobs_mode_staging_check;
--   alter table scheduler_jobs add constraint scheduler_jobs_mode_staging_check check (mode = 'DRY_RUN');
alter table scheduler_jobs drop constraint if exists scheduler_jobs_mode_staging_check;
alter table scheduler_jobs add constraint scheduler_jobs_mode_staging_check check (mode in ('DRY_RUN', 'LIVE'));
