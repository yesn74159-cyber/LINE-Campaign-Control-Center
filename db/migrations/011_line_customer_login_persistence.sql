-- Durable LINE Login state and customer sessions. No provider tokens or raw LINE subjects are stored.

create unique index if not exists staff_invite_links_id_workspace_uq
  on staff_invite_links(id, workspace_id);

create table if not exists line_customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  oa_integration_id uuid not null,
  attributed_invite_link_id uuid not null,
  line_subject_hmac text not null check (line_subject_hmac ~ '^[a-f0-9]{64}$'),
  display_name text not null default 'LINE Member' check (length(display_name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id, oa_integration_id),
  unique (workspace_id, oa_integration_id, line_subject_hmac),
  foreign key (oa_integration_id, workspace_id)
    references oa_integrations(id, workspace_id) on delete cascade,
  foreign key (attributed_invite_link_id, workspace_id, oa_integration_id)
    references staff_invite_links(id, workspace_id, oa_integration_id)
);
create index if not exists line_customers_workspace_oa_idx
  on line_customers(workspace_id, oa_integration_id, created_at desc);

create table if not exists line_customer_login_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  oa_integration_id uuid not null,
  invite_link_id uuid not null,
  browser_binding_hash text not null check (browser_binding_hash ~ '^[a-f0-9]{64}$'),
  referral_token_sealed text not null check (length(referral_token_sealed) between 32 and 512),
  nonce_hash text not null check (nonce_hash ~ '^[a-f0-9]{64}$'),
  nonce_sealed text not null check (length(nonce_sealed) between 32 and 512),
  code_verifier_sealed text not null check (length(code_verifier_sealed) between 32 and 512),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (oa_integration_id, workspace_id)
    references oa_integrations(id, workspace_id) on delete cascade,
  foreign key (invite_link_id, workspace_id, oa_integration_id)
    references staff_invite_links(id, workspace_id, oa_integration_id) on delete cascade
);
create index if not exists line_customer_login_states_expiry_idx
  on line_customer_login_states(expires_at);

create table if not exists line_customer_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  customer_id uuid not null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  oa_integration_id uuid not null,
  invite_link_id uuid not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (customer_id, workspace_id, oa_integration_id)
    references line_customers(id, workspace_id, oa_integration_id) on delete cascade,
  foreign key (invite_link_id, workspace_id, oa_integration_id)
    references staff_invite_links(id, workspace_id, oa_integration_id) on delete cascade
);
create index if not exists line_customer_sessions_active_idx
  on line_customer_sessions(token_hash, expires_at)
  where revoked_at is null;
create index if not exists line_customer_sessions_expiry_idx
  on line_customer_sessions(expires_at);

alter table referral_attribution_events
  add column if not exists customer_id uuid;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'referral_events_customer_scope_fk'
      and conrelid = 'referral_attribution_events'::regclass
  ) then
    alter table referral_attribution_events
      add constraint referral_events_customer_scope_fk
      foreign key (customer_id, workspace_id, oa_integration_id)
      references line_customers(id, workspace_id, oa_integration_id);
  end if;
end $$;
create index if not exists referral_events_customer_idx
  on referral_attribution_events(customer_id, occurred_at desc)
  where customer_id is not null;

alter table line_customers enable row level security;
alter table line_customer_login_states enable row level security;
alter table line_customer_sessions enable row level security;
