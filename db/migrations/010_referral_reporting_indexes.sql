-- Reporting indexes for workspace-scoped referral dashboards.
-- No raw LINE identity, token, or secret is introduced.
create index if not exists referral_events_workspace_oa_time_idx
  on referral_attribution_events(workspace_id, oa_integration_id, occurred_at desc);
create index if not exists referral_events_workspace_invite_type_time_idx
  on referral_attribution_events(workspace_id, invite_link_id, event_type, occurred_at desc);
create index if not exists staff_invite_links_workspace_staff_status_idx
  on staff_invite_links(workspace_id, admin_user_id, status, created_at desc);

-- One-time Login state. Only SHA-256 digests are persisted; raw state/nonce are
-- returned to the local mock client and discarded after callback verification.
create table if not exists line_login_states (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  invite_link_id uuid not null,
  admin_user_id uuid not null,
  state_hash text not null check (state_hash ~ '^[a-f0-9]{64}$'),
  nonce_hash text not null check (nonce_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (state_hash),
  foreign key (invite_link_id, workspace_id) references staff_invite_links(id, workspace_id),
  foreign key (admin_user_id, workspace_id) references admin_users(id, workspace_id)
);
create index if not exists line_login_states_expiry_idx
  on line_login_states(workspace_id, expires_at)
  where used_at is null;

-- Webhook event receipts make signed-event replay rejection explicit. The
-- follower subject remains an HMAC digest in the attribution table.
alter table referral_attribution_events
  add column if not exists evidence_event_id text;
create unique index if not exists referral_evidence_event_unique
  on referral_attribution_events(workspace_id, oa_integration_id, evidence_event_id)
  where evidence_event_id is not null;
