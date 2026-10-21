# Cloud Preparation Plan — LINE Campaign Control Center

Target: Supabase project `bgwsxoeseyqwwcupzeoo`, application schema `line_ccc`.

Status: **prepared locally; Cloud credential and Cloud apply gates remain on hold**.

This plan does not connect to Supabase, apply migrations, change RLS or grants, modify customer data, start a Docker container, commit, push, deploy, open LINE Live, or enable a production webhook.

## Current gates

| Area | Result | Evidence / next gate |
| --- | --- | --- |
| Local Docker contract | PASS / NOT RUN | Compose resolves PostgreSQL 16 on `127.0.0.1:55433`; Docker Engine access is unavailable in this session. No volume was started or changed. |
| Local Mock API | PASS | `PERSISTENCE=memory`, `APP_MODE=DRY_RUN`, mock LINE adapter, and webhook-disabled defaults exist. |
| Git ignore and local secret scan | PASS | `.env`, backups, dumps, certificates, and key files are ignored; tracked scan found no non-placeholder credential values. |
| Git remote | FAIL / HOLD | No remote is configured in this checkout. Do not add or push until the owner confirms the exact GitHub remote. |
| GitHub visibility | UNVERIFIED | Anonymous GitHub request returned 404. This cannot distinguish a private repository from a wrong name or insufficient access. Verify while authenticated. |
| Cloud schema parity | PENDING | Requires a server-side read-only connection or approved connector result. Existing static report identifies the ledger/RLS/index gates. |
| Database credentials | NOT REQUIRED for this phase | Needed only for the later server-side read-only connection and approved Cloud audit. |

## Local development and test profile

Keep local development on the existing Docker profile:

```text
DB_TARGET=LOCAL_DEV
DB_SCHEMA=public
DB_EXTENSION_SCHEMA=public
DB_SSL_MODE=disable
DB_POOL_MODE=session
PERSISTENCE=postgres
APP_MODE=DRY_RUN
LINE_LIVE_ENABLED=false
LINE_WEBHOOK_ENABLED=false
```

The compose file maps only `127.0.0.1:55433` to PostgreSQL. Do not use the Cloud `line_ccc` profile against this local database, and do not run `db:setup`, `db:migrate`, or integration tests until the local Docker service is intentionally available.

For a no-database Preview API, use the existing memory repository instead:

```powershell
npm run dev:api
```

This is a Mock API and remains `DRY_RUN`; it does not make outbound LINE requests.

## Separate online Staging Preview

Use three separate Staging runtime surfaces, distinct from the existing Production website:

1. **Admin Preview:** static HTTPS build from `apps/admin`.
2. **Fastify Preview API:** private HTTPS service, either `PERSISTENCE=memory` for a no-Cloud mock or `PERSISTENCE=postgres` after the Cloud gate passes.
3. **Worker:** private process running `npm run worker:staging`; never expose it publicly.

The Admin build now accepts the public, non-secret `VITE_API_ORIGIN`. Prefer an HTTPS reverse proxy that serves Admin and API under one site so session cookies remain first-party. If separate origins are required, set `VITE_API_ORIGIN` to the Staging API origin and set `CORS_ALLOWED_ORIGINS` to the exact Admin Preview origin; do not put database URLs, Supabase keys, LINE tokens, or channel secrets in `VITE_*` variables.

For a mock online Preview, deploy the API with:

```text
NODE_ENV=production
HOST=0.0.0.0
PERSISTENCE=memory
APP_MODE=DRY_RUN
LINE_LIVE_ENABLED=false
LINE_WEBHOOK_ENABLED=false
```

Do not reuse the Production Admin origin, API origin, cookies, database, or webhook endpoint.

## Cloud Schema / Fastify compatibility gate

Static source compatibility is prepared for the 14 expected tables from migrations `001`–`007`, including `scheduler_jobs`, OA readiness metadata, workspace/campaign controls, and `outbox_deliveries`. Fastify expects:

- `search_path=line_ccc,extensions`;
- `gen_random_uuid()` available through that path;
- final `DRY_RUN` scheduler constraints;
- final workspace and exact-OA outbox trigger guards;
- application ledger `line_ccc.schema_migrations`.

The Cloud catalog is not confirmed in this phase. Do not infer parity from Supabase migration history alone. The existing [CLOUD_SCHEMA_PARITY_REPORT.md](./CLOUD_SCHEMA_PARITY_REPORT.md) records the known gates: missing application ledger evidence, RLS disabled evidence, and seven foreign-key index findings.

## Migration Ledger repair plan

1. Run the existing read-only catalog audit and capture exact table, column, constraint, index, trigger, function, grant, RLS, and row-count evidence.
2. Confirm whether `line_ccc.schema_migrations` exists and whether it belongs to this checkout.
3. Compare each local SQL file hash and final catalog state; Supabase History is not sufficient to backfill the application ledger.
4. If approved, add the ledger as a narrowly scoped additive operation and backfill only individually verified versions with checksum/source metadata.
5. Prepare the seven missing FK indexes as separate reviewed `CREATE INDEX CONCURRENTLY` operations only after confirming no equivalent index exists.
6. Prepare RLS/grant changes as a separate reviewed gate. Never grant browser roles direct access to the Admin/Auth/customer/outbox tables.
7. Rerun read-only audit, Fastify connection check, local tests, and staging smoke tests after any approved Cloud change.

No repair SQL is executed by this preparation.

## Deployment approval gates

Cloud deployment remains **FAIL / HOLD** until all of these are explicitly approved:

- authenticated GitHub visibility and exact remote;
- Admin Preview origin separated from Production;
- mock Preview smoke test;
- server-side `CLOUD_STAGING` read-only connection with `DB_SCHEMA=line_ccc` and verified SSL;
- exact Cloud catalog parity and ledger reconciliation;
- RLS/grant review and backend role confirmation;
- backup/restore evidence and rollback plan.

LINE Live, Production Webhook, real provider credentials, and real customer traffic remain out of scope.
