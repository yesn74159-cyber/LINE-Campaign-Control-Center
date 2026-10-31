-- Read-only verification for the RLS/grant proposal. Safe to run before and
-- after the change; it never modifies objects or data.
\set ON_ERROR_STOP on

\echo '== session =='
select current_database() as database, current_user as role, current_schema() as schema;

\echo '== RLS coverage (expect rls_disabled = 0 after Tier B) =='
select count(*)::int as tables,
       count(*) filter (where c.relrowsecurity)::int as rls_enabled,
       count(*) filter (where not c.relrowsecurity)::int as rls_disabled,
       count(*) filter (where c.relforcerowsecurity)::int as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = current_schema() and c.relkind = 'r';

\echo '== Tables still without RLS =='
select c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = current_schema() and c.relkind = 'r' and not c.relrowsecurity
order by c.relname;

\echo '== Policies (expect none for anon/authenticated) =='
select tablename, policyname, roles::text, cmd
from pg_policies
where schemaname = current_schema()
order by tablename, policyname;

\echo '== Browser-role privileges (expect no_table_grants = 0 after Tier A) =='
select r.rolname as role,
       has_schema_privilege(r.rolname, current_schema(), 'USAGE') as schema_usage,
       (select count(*)::int from information_schema.role_table_grants g
        where g.grantee = r.rolname and g.table_schema = current_schema()) as table_grants
from pg_roles r
where r.rolname in ('anon', 'authenticated')
order by r.rolname;

\echo '== FK columns without a leading index (expect none after the index file) =='
select con.conrelid::regclass as table_name,
       a.attname as column_name,
       con.conname as constraint_name
from pg_constraint con
join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
where con.contype = 'f'
  and connamespace = current_schema()::regnamespace
  and not exists (
    select 1 from pg_index idx
    where idx.indrelid = con.conrelid and idx.indkey[0] = con.conkey[1]
  )
order by table_name, column_name;
