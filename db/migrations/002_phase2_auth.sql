create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  email text not null,
  display_name text not null,
  role text not null check (role in ('owner', 'admin', 'editor', 'reviewer', 'viewer')),
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

alter table campaigns add column if not exists title text not null default '';
alter table campaigns add column if not exists description text not null default '';
alter table campaigns add column if not exists image text not null default '';
alter table campaigns add column if not exists cta text not null default '';
alter table campaigns add column if not exists flex_file text not null default '';

create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references admin_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists auth_sessions_active_idx on auth_sessions (token_hash, expires_at) where revoked_at is null;
