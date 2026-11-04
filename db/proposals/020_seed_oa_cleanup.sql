-- Proposal — run by hand by the owner; it is not a migration and migrate.ts never sees it.
--
-- Two rows written by an early seed share provider_id='staging-provider' with the real OA
-- (@453yfyvc). While either one is enabled, two readers can resolve to it:
--   * /api/config — `select basic_id from oa_integrations where enabled order by created_at limit 1`
--     so the add-friend URL on the card-less /share page can point at a seed row
--   * the audience join — `customers cu join oa_integrations oa on cu.provider_id = oa.provider_id`
--     so a seed provider_id yields an empty audience (eligible=0) and the job sends nothing
--
-- This renames and disables the two rows. It deletes nothing. It refuses to run unless
-- exactly one row matches each id prefix from the audit, so pointing it at the wrong
-- database fails instead of editing a different OA.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
--     -f db/proposals/020_seed_oa_cleanup.sql
--
-- Ids from the 2026-11-05 audit: b1e648d0-…, 5059f7fc-…
-- The transaction comes from `--single-transaction`: it commits on the last statement and
-- rolls back everything if any guard raises.

do $$
declare
  first_id  uuid;
  second_id uuid;
begin
  if (select count(*) from oa_integrations where id::text like 'b1e648d0-%') <> 1 then
    raise exception 'expected exactly 1 OA row whose id starts with b1e648d0-; stopping';
  end if;
  if (select count(*) from oa_integrations where id::text like '5059f7fc-%') <> 1 then
    raise exception 'expected exactly 1 OA row whose id starts with 5059f7fc-; stopping';
  end if;

  select id into first_id from oa_integrations where id::text like 'b1e648d0-%';
  select id into second_id from oa_integrations where id::text like '5059f7fc-%';
  if first_id = second_id then
    raise exception 'both prefixes matched the same row (%)', first_id;
  end if;
  if exists (select 1 from oa_integrations where id in (first_id, second_id) and provider_id <> 'staging-provider') then
    raise exception 'both target rows must be provider_id=staging-provider seed rows; stopping';
  end if;

  raise notice 'seed row % (basic_id=%, enabled=%)', first_id, (select basic_id from oa_integrations where id = first_id), (select enabled from oa_integrations where id = first_id);
  raise notice 'seed row % (basic_id=%, enabled=%)', second_id, (select basic_id from oa_integrations where id = second_id), (select enabled from oa_integrations where id = second_id);
end $$;

update oa_integrations
set display_name = '(seed – ไม่ใช้)',
    basic_id = case when id::text like 'b1e648d0-%' then '@unused-seed-1' else '@unused-seed-2' end,
    enabled = false
where id::text like 'b1e648d0-%' or id::text like '5059f7fc-%';

-- Eligibility per OA after the change. The real OA must keep its customers; the seed rows
-- must no longer be able to win the /api/config lookup or the audience join.
select oa.id, oa.display_name, oa.basic_id, oa.provider_id, oa.enabled,
       (select count(*) from customers c
         where c.workspace_id = oa.workspace_id
           and c.provider_id = oa.provider_id
           and c.opt_in and c.blocked_at is null) as eligible
from oa_integrations oa
order by oa.enabled desc, oa.created_at;

-- Nothing is deleted, so reverting the change is a display_name/basic_id/enabled update.
