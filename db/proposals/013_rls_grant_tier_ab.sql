-- PROPOSAL ONLY — do not move into db/migrations until the Phase 5F gates pass:
--   1. real read-only audit reviewed
--   2. backup + checksum + restore drill verified
--   3. explicit change window approved
--
-- Tier A + B from docs/PHASE5F_OPERATIONS_ROTATION_RLS.md:
--   A. remove browser-role exposure (Supabase anon/authenticated) when those roles exist
--   B. enable RLS deny-by-default on every table in the current schema
--
-- No policy is created for anon/authenticated, and FORCE ROW LEVEL SECURITY is
-- deliberately NOT used: the backend connects as the table owner and must keep
-- working until a dedicated NOBYPASSRLS app role and tenant policies exist (Tier C).
-- Idempotent. Run with: psql --single-transaction -f 013_rls_grant_tier_ab.sql

do $$
declare
  s text := current_schema();
  r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema %I from %I', s, r);
      execute format('revoke all on all tables in schema %I from %I', s, r);
      execute format('revoke all on all sequences in schema %I from %I', s, r);
      execute format('revoke all on all functions in schema %I from %I', s, r);
      execute format('alter default privileges in schema %I revoke all on tables from %I', s, r);
      execute format('alter default privileges in schema %I revoke all on sequences from %I', s, r);
      execute format('alter default privileges in schema %I revoke all on functions from %I', s, r);
    end if;
  end loop;
  -- PUBLIC keeps USAGE on the built-in public schema; only revoke it for a
  -- dedicated schema such as line_ccc, where PUBLIC has no business using it.
  if s <> 'public' then
    execute format('revoke all on schema %I from public', s);
  end if;
end $$;

do $$
declare
  s text := current_schema();
  t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = s
    order by tablename
  loop
    execute format('alter table %I.%I enable row level security', s, t.tablename);
  end loop;
end $$;
