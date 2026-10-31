-- Single-use account setup links for staff invitations and password resets.
-- Only SHA-256 digests are stored. Plain tokens are returned to the caller once.

create table if not exists admin_account_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  admin_user_id uuid not null,
  purpose text not null check (purpose in ('INVITE','RESET')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  foreign key (admin_user_id, workspace_id)
    references admin_users(id, workspace_id) on delete cascade
);

create index if not exists admin_account_tokens_user_idx
  on admin_account_tokens(workspace_id, admin_user_id, purpose, created_at desc);
create index if not exists admin_account_tokens_active_idx
  on admin_account_tokens(expires_at)
  where used_at is null;

-- Optional client-supplied idempotency key. Nulls are distinct in PostgreSQL,
-- so existing jobs without a key remain valid.
alter table scheduler_jobs
  add column if not exists client_request_key text;
create unique index if not exists scheduler_jobs_workspace_client_key_uq
  on scheduler_jobs(workspace_id, client_request_key);
