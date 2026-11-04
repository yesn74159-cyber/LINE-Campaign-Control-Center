-- monthly_used only ever grew. An OA whose monthly_quota matches the LINE plan ceiling would
-- pass the first month and then refuse every delivery forever, because nothing reset the counter.
--
-- The reset happens in reserveDeliverySlot instead of a cron job: the row is already locked with
-- `for update` there, so the rollover and the increment cannot interleave, and a month nobody
-- sends in does not need any scheduled work at all. The period is recorded so a stale counter
-- can be recognised rather than guessed at from now().
alter table oa_integrations
  add column if not exists quota_period_start date not null default date_trunc('month', now())::date;
