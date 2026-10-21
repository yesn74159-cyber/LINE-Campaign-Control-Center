# Supabase Cloud Staging Preparation

This document describes the deployment boundary for the existing LINE Campaign Control Center. It does not apply migrations, seed passwords, connect to LINE, or deploy any service.

## Server-side database profiles

The API and worker select their database profile from server environment variables:

| Profile | Required settings | Purpose |
| --- | --- | --- |
| `LOCAL_DEV` | `LOCAL_DATABASE_URL` or `DATABASE_URL`, `DB_SCHEMA=public`, `DB_SSL_MODE=disable` | Existing Docker PostgreSQL on loopback |
| `CLOUD_STAGING` | `CLOUD_STAGING_DATABASE_URL` or `DATABASE_URL`, `DB_SCHEMA=line_ccc`, `DB_SSL_MODE=require` or `verify-full` | Supabase staging from a server-only process |

Never put either URL in the repository, browser bundle, GitHub workflow source, logs, or issue comments. The application rejects loopback hosts when `DB_TARGET=CLOUD_STAGING`, checks the active PostgreSQL schema at startup, and fails closed if the expected schema is not active.

Recommended cloud settings:

```text
DB_TARGET=CLOUD_STAGING
DB_SCHEMA=line_ccc
DB_EXTENSION_SCHEMA=extensions
DB_SSL_MODE=verify-full
DB_SSL_REJECT_UNAUTHORIZED=true
DB_POOL_MODE=session
DB_POOL_MAX=5
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECTION_TIMEOUT_MS=10000
DB_STATEMENT_TIMEOUT_MS=30000
PERSISTENCE=postgres
APP_MODE=DRY_RUN
LINE_LIVE_ENABLED=false
LINE_WEBHOOK_ENABLED=false
```

Use a Supabase direct connection or session pooler for a long-running API/worker. A transaction pooler is an option for short-lived/serverless processes, but it must be verified against the driver's prepared-statement and session-state limitations. The current repository uses parameterized `pg` queries and keeps external transport calls outside database transactions.

## Read-only connection check

Run `npm run test:db-connection` from the server environment before any migration decision. It reports only configuration state, target, expected/current schema, SSL state, pool mode, and a generic message. It does not create tables or write rows.

For cloud staging, the check must report `target=CLOUD_STAGING`, `expectedSchema=line_ccc`, `currentSchema=line_ccc`, and `ssl=true`. A `public` current schema is a schema-selection failure, not a successful cloud readiness result.

## Schema drift gate

The source migrations are `001` through `007` under [db/migrations](../db/migrations). They currently use unqualified identifiers, so the connection `search_path` is part of the schema contract. Before any cloud migration approval, compare these read-only catalog facts in Supabase:

- tables and columns in `line_ccc`;
- primary, foreign-key, unique, and check constraints;
- indexes and partial indexes;
- triggers and trigger functions;
- `schema_migrations` rows for `001` through `007`;
- row counts and backup evidence supplied by the operator.

The current Docker `public` catalog also reports foreign-key columns without a supporting index on `scheduler_jobs.campaign_revision_id`, `scheduler_jobs.oa_integration_id`, `scheduler_jobs.workspace_id`, `audit_log.workspace_id`, `webhook_events.workspace_id`, `auth_sessions.user_id`, and `outbox_deliveries.oa_integration_id`. Treat these as a performance hardening proposal for a future additive migration after cloud parity is confirmed; no index migration is created or applied by this preparation.

Do not compare against `public` and infer that `line_ccc` is correct. Do not run `db:setup`, `db:seed`, `db:migrate`, `supabase db push`, or any reset command against the cloud project until the drift report is approved.

## Deployment shape

1. **Admin:** deploy the existing static Admin bundle on an HTTPS static host. It receives only the public API origin. It must not receive `DATABASE_URL`, Supabase database credentials, service-role keys, LINE tokens, or channel secrets.
2. **Fastify API:** run the existing API as a private/server-side HTTPS service behind a managed TLS proxy. Set the cloud database variables only in the service secret store. Keep authentication, RBAC, DRY RUN, and webhook-disabled defaults enabled.
3. **Worker:** run `npm run worker:staging` as a separate private process/container with the same server-only database profile. It does not need a public listener. Keep the LINE adapter mock and `LINE_LIVE_ENABLED=false` until a separately approved live-readiness phase.
4. **CI:** use the disposable PostgreSQL service in [staging-ci.yml](../.github/workflows/staging-ci.yml). CI must use `DB_TARGET=LOCAL_DEV`, `DB_SCHEMA=public`, loopback `DATABASE_URL`, and no `CLOUD_STAGING_DATABASE_URL`. The workflow must never discover or import Supabase credentials automatically.

## Not yet verified

The Supabase project schema for `bgwsxoeseyqwwcupzeoo` has not been read in this checkout because no authenticated, secret-safe database connection is available to the current process. Therefore cloud schema parity, cloud SSL handshake, cloud pooler mode, RLS/exposure settings, backup freshness, and cloud migration ledger parity remain pending.
