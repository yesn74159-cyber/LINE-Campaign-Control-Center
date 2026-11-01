-- Read-only cloud/staging audit. Every statement is a SELECT: nothing here
-- writes, applies migrations, changes grants or enables RLS.
--   psql "$AUDIT_DATABASE_URL" -v audit_role=line_ccc -f db/audit/read-only-audit.sql
-- The connection string and any sealed credential payloads are never selected.

\pset pager off
\timing off

\echo '== connection =='
select current_database() as database, current_user as role, version() as server_version;

\echo '== migration ledger (expected 001-012) =='
with expected(version) as (values
  ('001_control_center.sql'),
  ('002_phase2_auth.sql'),
  ('003_phase3_automation.sql'),
  ('004_phase35_staging_hardening.sql'),
  ('005_phase4a_oa_readiness.sql'),
  ('006_phase4b_outbox_ledger.sql'),
  ('007_phase4b_outbox_association_guard.sql'),
  ('008_multitenant_foundation.sql'),
  ('009_oa_credential_vault.sql'),
  ('010_referral_reporting_indexes.sql'),
  ('011_line_customer_login_persistence.sql'),
  ('012_account_invites.sql')
)
select e.version,
       (m.version is not null) as applied,
       m.applied_at
from expected e
left join schema_migrations m on m.version = e.version
order by e.version;

\echo '== schema parity (expected tables) =='
with expected(name) as (values
  ('admin_account_tokens'), ('admin_users'), ('audit_log'), ('auth_sessions'),
  ('campaign_controls'), ('campaign_revisions'), ('campaigns'), ('customers'),
  ('line_customer_login_states'), ('line_customer_sessions'), ('line_customers'),
  ('line_login_states'), ('oa_credential_vault'), ('oa_integrations'),
  ('oa_rate_limit_windows'), ('outbox_deliveries'), ('referral_attribution_events'),
  ('scheduler_jobs'), ('staff_invite_links'), ('webhook_events'),
  ('workspace_controls'), ('workspace_line_identities'), ('workspace_memberships'),
  ('workspace_oa_channels'), ('workspaces')
)
select e.name as table_name,
       case when c.oid is null then 'MISSING' else 'present' end as status
from expected e
left join pg_class c
  on c.relname = e.name and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by status desc, e.name;

\echo '== unexpected public tables =='
select c.relname as table_name
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relkind = 'r'
  and c.relname <> all (array[
    'admin_account_tokens','admin_users','audit_log','auth_sessions',
    'campaign_controls','campaign_revisions','campaigns','customers',
    'line_customer_login_states','line_customer_sessions','line_customers',
    'line_login_states','oa_credential_vault','oa_integrations',
    'oa_rate_limit_windows','outbox_deliveries','referral_attribution_events',
    'scheduler_jobs','staff_invite_links','webhook_events','workspace_controls',
    'workspace_line_identities','workspace_memberships','workspace_oa_channels',
    'workspaces','schema_migrations'
  ])
order by c.relname;

\echo '== RLS status per public table =='
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::int as policy_count
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relkind = 'r'
order by c.relrowsecurity asc, c.relname;

\echo '== privileges for the application role =='
select rolname, rolcanlogin, rolsuper, rolbypassrls
from pg_roles
where rolname = :'audit_role';

select grantee, privilege_type, count(*)::int as tables
from information_schema.role_table_grants
where table_schema = 'public' and grantee = :'audit_role'
group by grantee, privilege_type
order by privilege_type;

\echo '== foreign keys without a leading-column index =='
select table_name, conname, covering_index
from (
  select con.conrelid::regclass::text as table_name,
         con.conname,
         coalesce((
           select idx.indexrelid::regclass::text
           from pg_index idx
           where idx.indrelid = con.conrelid
             and idx.indisvalid
             and idx.indkey[0] = con.conkey[1]
           limit 1
         ), 'MISSING') as covering_index
  from pg_constraint con
  where con.contype = 'f'
    and con.connamespace = 'public'::regnamespace
) fk_indexes
order by covering_index = 'MISSING' desc, table_name, conname;

\echo '== vault inventory (counts only; never the sealed payload) =='
select count(*)::int as vault_rows,
       count(*) filter (where access_token_checked_at is not null)::int as token_checked_rows,
       max(updated_at) as last_vault_update
from oa_credential_vault;

\echo '== delivery backlog summary =='
select status, count(*)::int as rows
from outbox_deliveries
group by status
order by status;
