-- Manual one-recipient LINE push: preview first, then a typed confirmation sends the message.
-- Stores message text and provider receipts only. No credential is stored here; the channel
-- access token is resolved from oa_credential_vault at send time.
create table if not exists manual_push_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  oa_integration_id uuid not null references oa_integrations(id) on delete cascade,
  requested_by text not null,
  recipient_key text not null check (recipient_key ~* '^u[0-9a-f]{32}$'),
  message_text text not null check (message_text <> ''),
  mode text not null default 'DRY_RUN' check (mode in ('DRY_RUN','LIVE')),
  status text not null default 'PREVIEW' check (status in ('PREVIEW','SENDING','SENT','FAILED','UNKNOWN','EXPIRED','BLOCKED')),
  line_retry_key text not null unique,
  provider_status integer,
  provider_request_id text,
  provider_message_id text,
  recipient_display_name text,
  last_error text,
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists manual_push_requests_workspace_created_idx
  on manual_push_requests (workspace_id, created_at desc);

alter table manual_push_requests enable row level security;
