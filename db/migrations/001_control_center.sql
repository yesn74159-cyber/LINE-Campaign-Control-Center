-- Staging-first schema. Apply explicitly to a staging PostgreSQL database.
-- No LINE secrets are stored in this schema; secret_ref points to an external secret manager.
create extension if not exists pgcrypto;

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null default 'DRY_RUN' check (mode in ('DRY_RUN', 'LIVE_LOCKED', 'LIVE')),
  created_at timestamptz not null default now()
);
create unique index if not exists workspaces_name_unique on workspaces (name);

create table if not exists oa_integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  provider_id text not null,
  basic_id text not null,
  display_name text not null,
  environment text not null default 'STAGING' check (environment in ('STAGING', 'PRODUCTION')),
  secret_ref text,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider_id, basic_id)
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  provider_id text not null,
  line_user_key text not null,
  display_name text,
  opt_in boolean not null default false,
  blocked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider_id, line_user_key)
);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  slug text not null,
  name text not null,
  title text not null default '',
  description text not null default '',
  image text not null default '',
  cta text not null default '',
  flex_file text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists campaign_revisions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  revision integer not null,
  flex_json jsonb not null,
  state text not null default 'DRAFT' check (state in ('DRAFT', 'PREVIEWED', 'APPROVED', 'PUBLISHED', 'RETIRED')),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (campaign_id, revision)
);

create table if not exists scheduler_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  campaign_revision_id uuid not null references campaign_revisions(id),
  oa_integration_id uuid not null references oa_integrations(id),
  mode text not null default 'DRY_RUN' check (mode in ('DRY_RUN', 'LIVE')),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'PAUSED', 'CLAIMED', 'SENDING', 'RETRYABLE', 'COMPLETED', 'FAILED_FINAL', 'CANCELED')),
  scheduled_at timestamptz not null,
  available_at timestamptz not null,
  attempts integer not null default 0,
  idempotency_key uuid not null unique,
  line_retry_key uuid,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists scheduler_jobs_claim_idx on scheduler_jobs (status, available_at);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  actor text not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  oa_integration_id uuid not null references oa_integrations(id),
  webhook_event_id text not null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  unique (oa_integration_id, webhook_event_id)
);
