-- Phase 4A readiness metadata. No access token or channel secret is stored here.
alter table oa_integrations add column if not exists connection_status text not null default 'NOT_CONFIGURED';
alter table oa_integrations add column if not exists credential_status text not null default 'NOT_CONFIGURED';
alter table oa_integrations add column if not exists quota_per_minute integer not null default 60;
alter table oa_integrations add column if not exists monthly_quota integer not null default 0;
alter table oa_integrations add column if not exists monthly_used integer not null default 0;
alter table oa_integrations add column if not exists kill_switch boolean not null default false;
alter table oa_integrations add column if not exists kill_switch_reason text;
alter table oa_integrations add column if not exists last_validated_at timestamptz;
alter table oa_integrations add column if not exists validation_error text;

alter table oa_integrations drop constraint if exists oa_integrations_connection_status_check;
alter table oa_integrations add constraint oa_integrations_connection_status_check check (connection_status in ('NOT_CONFIGURED','DRY_RUN_READY','VALIDATION_FAILED','LIVE_LOCKED'));
alter table oa_integrations drop constraint if exists oa_integrations_credential_status_check;
alter table oa_integrations add constraint oa_integrations_credential_status_check check (credential_status in ('NOT_CONFIGURED','REFERENCE_CONFIGURED','VALIDATION_FAILED'));
alter table oa_integrations drop constraint if exists oa_integrations_quota_check;
alter table oa_integrations add constraint oa_integrations_quota_check check (quota_per_minute between 1 and 500 and monthly_quota >= 0 and monthly_used >= 0);

create table if not exists workspace_controls (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  system_kill_switch boolean not null default false,
  reason text,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists campaign_controls (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  campaign_id uuid primary key references campaigns(id) on delete cascade,
  approval_status text not null default 'DRAFT' check (approval_status in ('DRAFT','VALIDATED','APPROVED')),
  campaign_kill_switch boolean not null default false,
  reason text,
  validated_at timestamptz,
  validated_by text,
  approved_at timestamptz,
  approved_by text,
  updated_at timestamptz not null default now(),
  unique (workspace_id, campaign_id)
);

create table if not exists oa_rate_limit_windows (
  oa_integration_id uuid not null references oa_integrations(id) on delete cascade,
  window_started_at timestamptz not null,
  used_count integer not null default 0 check (used_count >= 0),
  primary key (oa_integration_id, window_started_at)
);

insert into workspace_controls(workspace_id)
select id from workspaces
on conflict (workspace_id) do nothing;

insert into campaign_controls(workspace_id, campaign_id, approval_status, validated_at, validated_by, approved_at, approved_by)
select c.workspace_id, c.id, 'APPROVED', now(), 'phase3-seed', now(), 'phase3-seed'
from campaigns c
on conflict (campaign_id) do nothing;

update oa_integrations
set connection_status = case when environment = 'STAGING' and enabled then 'DRY_RUN_READY' else 'LIVE_LOCKED' end,
    credential_status = case when secret_ref is null then 'NOT_CONFIGURED' else 'REFERENCE_CONFIGURED' end
where connection_status = 'NOT_CONFIGURED';
