-- Multi-workspace foundation only. No LINE tokens, secrets, or personal LINE IDs.
-- Do not enable LIVE delivery or allow workspace self-registration in this phase.

alter table workspaces add column if not exists slug text;
update workspaces
set slug = 'ws-' || replace(id::text, '-', '')
where slug is null;
alter table workspaces alter column slug set default ('ws-' || replace(gen_random_uuid()::text, '-', ''));
alter table workspaces alter column slug set not null;
alter table workspaces add constraint workspaces_slug_format
  check (slug ~ '^[a-z][a-z0-9-]{2,62}$');
create unique index if not exists workspaces_slug_unique on workspaces (slug);

-- Composite keys allow foreign keys to prove same-workspace ownership at the database layer.
create unique index if not exists admin_users_id_workspace_uq on admin_users(id,workspace_id);
create unique index if not exists oa_integrations_id_workspace_uq on oa_integrations(id,workspace_id);

create table if not exists workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  admin_user_id uuid not null,
  status text not null default 'ACTIVE' check (status in ('INVITED','ACTIVE','SUSPENDED')),
  joined_at timestamptz not null default now(),
  unique (workspace_id, admin_user_id),
  foreign key (admin_user_id, workspace_id)
    references admin_users(id, workspace_id) on delete cascade
);

insert into workspace_memberships(workspace_id, admin_user_id, status)
select workspace_id, id, 'ACTIVE' from admin_users
on conflict (workspace_id, admin_user_id) do nothing;

-- Only provider/channel identifiers and an external server-side credential reference.
-- Actual channel access tokens and secrets must never be persisted in these tables.
create table if not exists workspace_oa_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  oa_integration_id uuid not null,
  messaging_channel_id text,
  login_channel_id text,
  line_provider_id text,
  credential_ref text,
  status text not null default 'NOT_CONFIGURED'
    check (status in ('NOT_CONFIGURED','VERIFY_PENDING','VERIFIED','DISABLED')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, oa_integration_id),
  foreign key (oa_integration_id, workspace_id)
    references oa_integrations(id, workspace_id) on delete cascade,
  check (messaging_channel_id is null or messaging_channel_id ~ '^[0-9]{5,30}$'),
  check (login_channel_id is null or login_channel_id ~ '^[0-9]{5,30}$'),
  check (credential_ref is null or length(credential_ref) between 8 and 256),
  check (status <> 'VERIFIED' or
    (messaging_channel_id is not null and line_provider_id is not null and verified_at is not null))
);
create unique index if not exists workspace_oa_channels_messaging_unique
  on workspace_oa_channels(messaging_channel_id)
  where messaging_channel_id is not null;

-- Store only HMAC digests of LINE identities; no raw LINE user IDs in this mapping.
-- The LINE Login callback must validate issuer, audience, signature, state and nonce
-- before any identity is inserted (callback is NOT implemented in this phase).
create table if not exists workspace_line_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  admin_user_id uuid not null,
  provider_id text not null,
  subject_hmac text not null check (subject_hmac ~ '^[a-f0-9]{64}$'),
  linked_at timestamptz not null default now(),
  unique (workspace_id, provider_id, subject_hmac),
  foreign key (admin_user_id, workspace_id)
    references admin_users(id, workspace_id) on delete cascade
);

-- Invite codes themselves must be generated with a CSPRNG and never stored in clear.
create table if not exists staff_invite_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  admin_user_id uuid not null,
  oa_integration_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','REVOKED')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, workspace_id, oa_integration_id),
  foreign key (admin_user_id, workspace_id)
    references admin_users(id, workspace_id),
  foreign key (oa_integration_id, workspace_id)
    references oa_integrations(id, workspace_id)
);
create index if not exists staff_invite_links_owner_idx
  on staff_invite_links(workspace_id, admin_user_id, created_at desc);

-- Clicks do not count as follows. A verified follow requires both an opaque
-- webhook-evidence reference and an HMAC digest of the provider-scoped subject.
create table if not exists referral_attribution_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  invite_link_id uuid not null,
  oa_integration_id uuid not null,
  event_type text not null check (event_type in ('CLICK','LOGIN','FOLLOW_VERIFIED')),
  follower_subject_hmac text check (follower_subject_hmac ~ '^[a-f0-9]{64}$'),
  evidence_ref text,
  occurred_at timestamptz not null default now(),
  foreign key (invite_link_id, workspace_id, oa_integration_id)
    references staff_invite_links(id, workspace_id, oa_integration_id),
  check (event_type <> 'FOLLOW_VERIFIED'
    or (follower_subject_hmac is not null and nullif(trim(evidence_ref), '') is not null))
);
create unique index if not exists referral_one_verified_follow_per_oa
  on referral_attribution_events(workspace_id, oa_integration_id, follower_subject_hmac)
  where event_type = 'FOLLOW_VERIFIED';
create index if not exists referral_events_invite_idx
  on referral_attribution_events(workspace_id, invite_link_id, occurred_at desc);

-- All structures are inert until the authenticated onboarding and LINE webhook
-- verification endpoints are implemented and audited.