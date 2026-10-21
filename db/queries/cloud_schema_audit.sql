-- READ-ONLY Cloud staging audit for Supabase project bgwsxoeseyqwwcupzeoo.
-- Run each statement separately through the approved Supabase connector.
-- This file intentionally contains no DDL, DML, transaction, or migration call.

-- 1) Connection identity, active schema, search_path, and TLS.
select
  current_database() as database_name,
  current_user as backend_role,
  current_schema() as current_schema,
  current_setting('search_path') as search_path,
  exists (
    select 1
    from pg_stat_ssl
    where pid = pg_backend_pid() and ssl
  ) as ssl,
  to_regprocedure('gen_random_uuid()') is not null as gen_random_uuid_available;

-- 2) Tables and row estimates for the application schema.
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  coalesce(s.n_live_tup, 0)::bigint as estimated_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_all_tables s on s.relid = c.oid
where n.nspname = 'line_ccc' and c.relkind = 'r'
order by c.relname;

-- 3) Exact columns, defaults, and nullability.
select
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_schema,
  c.udt_name,
  c.is_nullable,
  c.column_default
from information_schema.columns c
where c.table_schema = 'line_ccc'
order by c.table_name, c.ordinal_position;

-- 4) Primary, unique, foreign-key, and check constraints.
select
  n.nspname as schema_name,
  rel.relname as table_name,
  con.conname as constraint_name,
  case con.contype
    when 'p' then 'PRIMARY KEY'
    when 'u' then 'UNIQUE'
    when 'f' then 'FOREIGN KEY'
    when 'c' then 'CHECK'
    else con.contype::text
  end as constraint_type,
  pg_get_constraintdef(con.oid, true) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'line_ccc'
order by rel.relname, con.conname;

-- 5) Indexes, including partial indexes and their predicates.
select
  schemaname as schema_name,
  tablename as table_name,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'line_ccc'
order by tablename, indexname;

-- 6) Trigger definitions and trigger function bodies.
select
  tn.nspname as schema_name,
  t.relname as table_name,
  tr.tgname as trigger_name,
  pg_get_triggerdef(tr.oid, true) as trigger_definition,
  pn.nspname as function_schema,
  p.proname as function_name,
  p.prosecdef as security_definer,
  pg_get_functiondef(p.oid) as function_definition
from pg_trigger tr
join pg_class t on t.oid = tr.tgrelid
join pg_namespace tn on tn.oid = t.relnamespace
join pg_proc p on p.oid = tr.tgfoid
join pg_namespace pn on pn.oid = p.pronamespace
where not tr.tgisinternal and tn.nspname = 'line_ccc'
order by t.relname, tr.tgname;

-- 7) Function-level search_path and privilege posture for trigger functions.
select
  n.nspname as function_schema,
  p.oid::regprocedure as function_signature,
  p.prosecdef as security_definer,
  coalesce(array_to_string(p.proconfig, ', '), '<database default>') as function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege(current_user, p.oid, 'EXECUTE') as backend_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'line_ccc'
order by function_signature::text;

-- 8) RLS policies and role grants for anon/authenticated/backend.
select
  schemaname as schema_name,
  tablename as table_name,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'line_ccc'
order by tablename, policyname;

select
  table_name,
  grantee,
  privilege_type,
  is_grantable
from information_schema.role_table_grants
where table_schema = 'line_ccc'
  and grantee in ('anon', 'authenticated', current_user)
order by table_name, grantee, privilege_type;

select
  role_name,
  has_schema_privilege(role_name, 'line_ccc', 'USAGE') as schema_usage,
  has_schema_privilege(role_name, 'line_ccc', 'CREATE') as schema_create
from (values ('anon'::name), ('authenticated'::name), (current_user::name)) roles(role_name)
order by role_name;

with app_tables(table_name) as (
  values
    ('workspaces'::name), ('oa_integrations'::name), ('customers'::name),
    ('campaigns'::name), ('campaign_revisions'::name), ('scheduler_jobs'::name),
    ('audit_log'::name), ('webhook_events'::name), ('admin_users'::name),
    ('auth_sessions'::name), ('workspace_controls'::name), ('campaign_controls'::name),
    ('oa_rate_limit_windows'::name), ('outbox_deliveries'::name)
), principals(role_name) as (
  values ('anon'::name), ('authenticated'::name), (current_user::name)
)
select
  app_tables.table_name,
  principals.role_name,
  has_table_privilege(principals.role_name, format('line_ccc.%I', app_tables.table_name), 'SELECT') as can_select,
  has_table_privilege(principals.role_name, format('line_ccc.%I', app_tables.table_name), 'INSERT') as can_insert,
  has_table_privilege(principals.role_name, format('line_ccc.%I', app_tables.table_name), 'UPDATE') as can_update,
  has_table_privilege(principals.role_name, format('line_ccc.%I', app_tables.table_name), 'DELETE') as can_delete
from app_tables
cross join principals
order by app_tables.table_name, principals.role_name;

-- 9) Application ledger and exact row counts. Counts are read-only.
select table_schema, table_name
from information_schema.tables
where table_name = 'schema_migrations'
order by table_schema;

select
  to_regclass('line_ccc.schema_migrations') as app_schema_migrations_table,
  exists (
    select 1 from information_schema.tables
    where table_schema = 'line_ccc' and table_name = 'schema_migrations'
  ) as app_ledger_present;

-- Run this next statement only when app_ledger_present=true above; a missing
-- relation is itself an expected FAIL and must not be created by this audit.
select version, applied_at
from line_ccc.schema_migrations
order by version;

select 'workspaces' as table_name, count(*)::bigint as row_count from line_ccc.workspaces
union all select 'oa_integrations', count(*)::bigint from line_ccc.oa_integrations
union all select 'customers', count(*)::bigint from line_ccc.customers
union all select 'campaigns', count(*)::bigint from line_ccc.campaigns
union all select 'campaign_revisions', count(*)::bigint from line_ccc.campaign_revisions
union all select 'scheduler_jobs', count(*)::bigint from line_ccc.scheduler_jobs
union all select 'audit_log', count(*)::bigint from line_ccc.audit_log
union all select 'webhook_events', count(*)::bigint from line_ccc.webhook_events
union all select 'admin_users', count(*)::bigint from line_ccc.admin_users
union all select 'auth_sessions', count(*)::bigint from line_ccc.auth_sessions
union all select 'workspace_controls', count(*)::bigint from line_ccc.workspace_controls
union all select 'campaign_controls', count(*)::bigint from line_ccc.campaign_controls
union all select 'oa_rate_limit_windows', count(*)::bigint from line_ccc.oa_rate_limit_windows
union all select 'outbox_deliveries', count(*)::bigint from line_ccc.outbox_deliveries
order by table_name;
