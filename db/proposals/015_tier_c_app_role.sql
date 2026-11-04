-- PROPOSAL ONLY (Tier C) — do not move into db/migrations until the Phase 5F gates pass:
--   1. real read-only audit reviewed (pg_roles shows line_ccc = superuser + bypassrls)
--   2. backup + checksum + restore drill verified on the dump taken immediately before
--   3. explicit change window approved, with the operator named
--   4. docs/PHASE5F_OPERATIONS_ROTATION_RLS.md section "Tier C" read
--
-- Goal: stop the backend from running as a superuser.
--
-- WHAT THE 2026-11-04 DRILL RULED OUT FIRST: `line_ccc` cannot be demoted.
-- The staging cluster was initialised with POSTGRES_USER=line_ccc, which makes it the
-- initdb bootstrap user, and PostgreSQL refuses to take SUPERUSER away from that role:
--   alter role line_ccc with nosuperuser
--   ERROR:  permission denied to alter role
--   DETAIL: The bootstrap user must have the SUPERUSER attribute.
-- Setting NOBYPASSRLS on it is possible but worthless, and this file deliberately does
-- not do it: the drill showed a role with rolsuper=t / rolbypassrls=f still read all 7
-- campaign rows and inserted new ones, because superuser-ness bypasses RLS on its own.
-- Flipping that flag would only make the audit read better than the truth.
--
-- So Tier C is privilege separation by connection string, not a demotion:
--   line_ccc      stays the owner + the only superuser. Used for migrations, DDL,
--                 the nightly backup and the restore drill. Referenced by nothing at
--                 runtime once .env.staging points DATABASE_URL at the app role.
--   line_ccc_app  the runtime role for api/worker: NOBYPASSRLS, not the owner, so the
--                 policies created below decide exactly what it can see and write.
--
-- The policy block is not optional. Tier B enabled RLS with zero policies, which is
-- deny-by-default for any non-owner. Rehearsed 2026-11-04 with a throwaway role that had
-- the same grants as line_ccc_app but no policy:
--   select count(*) from campaigns            -> 0        (silently, no error)
--   update campaigns ... / delete from ...    -> UPDATE 0 / DELETE 0
--   insert into campaigns (...)               -> ERROR: new row violates row-level security policy
--   create table / alter table                -> permission denied / must be owner
-- A backend in that state does not crash - it serves an empty admin panel. That is the
-- failure mode this file exists to prevent, and the reason it is one transaction.
--
-- Idempotent. There is deliberately no BEGIN/COMMIT here: run it as ONE transaction so the
-- role, the grants and the 27 policies either all land or none do.
--   psql "$OWNER_URL" --single-transaction -v ON_ERROR_STOP=1 -f db/proposals/015_tier_c_app_role.sql
-- Then set the password out of argv and out of this file:
--   psql "$OWNER_URL" -c '\password line_ccc_app'
--
-- No sequences are granted: the schema has none (every id is uuid from
-- gen_random_uuid()) - pg_class in the drill listed only relkind 'r' and 'i'.
--
-- INvariant to remember after applying: this file grants DML for tables that exist now and
-- sets default privileges for tables created later, but it creates policies only for tables
-- that exist now. After any migration that adds a table, re-run this file - it is idempotent.

-- 1. the runtime role.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'line_ccc_app') then
    -- No PASSWORD clause on purpose; set with \password after this script.
    create role line_ccc_app with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls
      connection limit 20;
  else
    -- Re-assert in case a previous partial run left it NOLOGIN or bypassrls.
    alter role line_ccc_app with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls
      connection limit 20;
  end if;
end $$;

-- connection limit 20 is headroom over the real demand: DB_POOL_MAX defaults to 5 per
-- process and only api + worker connect with this role.

-- 2. least-privilege grants on the objects that exist now. DML only - no truncate, no
-- references, no ddl. The runtime never issues DDL (verified across apps/api/src; the only
-- create table is in migrate.ts, which runs as the owner).
do $$
begin
  execute format('grant connect on database %I to line_ccc_app', current_database());
end $$;
grant usage on schema public to line_ccc_app;
grant select, insert, update, delete on all tables in schema public to line_ccc_app;

-- 3. future migrations run as the owner, so their new objects must reach the app role
-- without a hand-run grant; without this the next migration silently leaves the runtime
-- role with 0 privileges on the new table.
alter default privileges in schema public grant select, insert, update, delete on tables to line_ccc_app;
alter default privileges in schema public grant usage, select, update on sequences to line_ccc_app;

-- 4. RLS policies for the runtime role. Tier B left every table with relrowsecurity =
--    true and no policy, so a non-owner sees nothing. One permissive FOR ALL policy per
--    table restores the visibility the owner role had, and is the hook that Tier C2
--    (tenant scoping via current_setting('app.workspace_id')) tightens later.
do $$
declare
  t record;
  n int := 0;
begin
  for t in
    select c.oid::regclass as rel, c.relname
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_app_access'
      )
    order by c.relname
  loop
    execute format('create policy %I on %s as permissive for all to line_ccc_app using (true) with check (true)',
      t.relname || '_app_access', t.rel);
    n := n + 1;
  end loop;
  raise notice 'policies created for line_ccc_app: %', n;
end $$;

-- 5. summary the operator pastes into the worklog.
select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolconnlimit
from pg_roles r
where r.rolname in ('line_ccc', 'line_ccc_app')
order by r.rolname;

select count(*) filter (where relrowsecurity) as tables_with_rls,
       count(distinct p.polrelid) as tables_with_app_policy,
       count(*) as total_tables
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid and p.polname = c.relname || '_app_access'
where n.nspname = 'public' and c.relkind = 'r';
