-- Encrypted LINE OA credential vault. The AES-256-GCM key is never stored in PostgreSQL.
-- Requires migration 008. This migration creates no LIVE dispatch capability.
create table if not exists oa_credential_vault (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  oa_integration_id uuid not null,
  token_sealed text not null check (length(token_sealed) between 50 and 8192),
  secret_sealed text not null check (length(secret_sealed) between 50 and 8192),
  cipher_version integer not null default 1 check (cipher_version = 1),
  access_token_checked_at timestamptz,
  bot_basic_id text not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, oa_integration_id),
  foreign key (oa_integration_id, workspace_id)
    references oa_integrations(id,workspace_id) on delete cascade,
  check (bot_basic_id ~ '^@[A-Za-z0-9._-]{2,50}$')
);
create index if not exists oa_credential_vault_checked_idx
  on oa_credential_vault(workspace_id,access_token_checked_at desc);
-- A signature must be verified from a real LINE webhook before considering
-- the channel secret validated. Bot-info GET only validates the access token.