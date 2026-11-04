-- Tier C verifier - READ ONLY. Safe to run before and after 015_tier_c_app_role.sql, and
-- safe to run on any schedule afterwards. It changes nothing; the last block uses
-- `set local role` inside a transaction that always rolls back, which is how it measures
-- what the runtime role can actually see without leaving the session in that role.
--
--   psql "$OWNER_URL" -X -f db/proposals/verify-tier-c.sql

\echo '--- 1. role attributes. Expect line_ccc superuser=t (cannot be changed - bootstrap user)'
\echo '    and line_ccc_app superuser=f bypassrls=f createdb=f createrole=f login=t.'
select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
       r.rolcanlogin, r.rolconnlimit
from pg_roles r
where r.rolname in ('line_ccc', 'line_ccc_app')
order by r.rolname;

\echo '--- 2. RLS coverage vs the app policies. Expect tables_with_app_policy = tables_with_rls.'
select count(*) filter (where c.relrowsecurity) as tables_with_rls,
       count(distinct p.polrelid)               as tables_with_app_policy,
       count(*)                                as total_tables
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid and p.polname = c.relname || '_app_access'
where n.nspname = 'public' and c.relkind = 'r';

\echo '--- 3. DRIFT: RLS tables the app role has no policy for. Expect zero rows.'
\echo '    A new migration that enables RLS without re-running 015 lands here, and the'
\echo '    runtime silently reads that table as empty until it is fixed.'
select c.relname as table_missing_app_policy
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (
    select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_app_access'
  )
order by 1;

\echo '--- 4. DRIFT: tables the app role cannot write to at all. Expect zero rows.'
select c.relname as table_missing_dml
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and not has_table_privilege('line_ccc_app', c.oid, 'insert')
order by 1;

\echo '--- 5. the app role must NOT be able to do DDL. Expect all false.'
select has_schema_privilege('line_ccc_app', 'public', 'create')  as can_create_in_schema,
       has_database_privilege('line_ccc_app', current_database(), 'create') as can_create_objects,
       pg_has_role('line_ccc_app', 'pg_write_all_data', 'MEMBER') as is_write_all_data,
       (select rolbypassrls from pg_roles where rolname = 'line_ccc_app') as bypassrls;

\echo '--- 6. default privileges for objects created by the owner after this point.'
\echo '    Expect the owner roleid with insert/selected privileges listed.'
select pg_get_userbyid(d.defaclrole) as for_owner,
       d.defaclobjtype,
       array_remove(string_to_array(trim(both '{}' from d.defaclacl::text), ','), '') as acl
from pg_default_acl d
join pg_roles r on r.oid = d.defaclrole
where r.rolname = 'line_ccc';

\echo '--- 7. sequences. Expect 0 (every id is uuid from gen_random_uuid()).'
select count(*) as sequences
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'S';

\echo '--- 8. live visibility probe: the owner and the runtime role count every table in the'
\echo '    same transaction, and only a table the owner can read but the app role cannot is'
\echo '    reported. Expect "NO DIFFERENCE". An empty-looking admin panel with this line'
\echo '    reporting a difference is the missing-policy failure mode, not a code bug.'
begin;
do $$
declare
  t record;
  n_owner bigint;
  n_app bigint;
  diffs int := 0;
begin
  for t in select relname from pg_class c
           join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'public' and c.relkind = 'r'
           order by relname
  loop
    execute format('select count(*) from %I', t.relname) into n_owner;
    execute 'set local role line_ccc_app';
    begin
      execute format('select count(*) from %I', t.relname) into n_app;
    exception when insufficient_privilege then
      n_app := null;
    end;
    execute format('set local role %I', session_user);
    if n_app is distinct from n_owner then
      diffs := diffs + 1;
      raise notice 'DIFFERENCE %: owner sees %, line_ccc_app sees %',
        t.relname, n_owner, coalesce(n_app::text, 'permission denied');
    end if;
  end loop;
  if diffs = 0 then
    raise notice 'NO DIFFERENCE across % tables', (select count(*) from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r');
  end if;
end $$;
rollback;
