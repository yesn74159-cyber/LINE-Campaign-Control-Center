# Cloud Schema Parity and Security Gate

Audit target: Supabase project `bgwsxoeseyqwwcupzeoo`, schema `line_ccc`.

Audit date: 2026-10-21. This report is read-only. No cloud migration, seed, RLS change, GRANT, reset, deploy, LINE webhook, or LINE message was performed.

## Decision

**FAIL / HOLD for Fastify API and Worker deployment.**

The Cloud database is healthy at the project level and contains 14 application tables, but deployment readiness is not proven. The blocking gaps are:

- RLS is disabled on all 14 application tables.
- Supabase Advisor reports seven foreign-key columns without supporting indexes.
- The Supabase migration history has `private schema` plus `001`–`007`, while the application ledger table `line_ccc.schema_migrations` is absent.
- This checkout has no authenticated, secret-safe Cloud database connection available, so exact catalog parity, grants, trigger bodies, function settings, SSL handshake, and real search path remain unverified.
- The Git checkout has no configured remote, so GitHub visibility and remote-side secret scanning cannot be verified.

## Evidence and boundaries

The project state above is the latest Supabase Connector evidence supplied for this audit. The exact Cloud table names, columns, constraints, indexes, trigger definitions, function settings, role grants, and row counts still require the read-only statements in [cloud_schema_audit.sql](../db/queries/cloud_schema_audit.sql). The proposed additive repair sequence is recorded in [CLOUD_SCHEMA_REPAIR_PROPOSAL.md](CLOUD_SCHEMA_REPAIR_PROPOSAL.md). No value from a credential or database connection was printed.

The local Docker contract remains unchanged: `docker-compose.staging.yml` uses PostgreSQL on `127.0.0.1:55433` with `DB_SCHEMA=public`. The Cloud contract must use `DB_TARGET=CLOUD_STAGING`, `DB_SCHEMA=line_ccc`, and SSL. These profiles must not be mixed.

## Expected schema from migrations 001–007

The migrations use unqualified identifiers, so the active `search_path` is part of the schema contract. The expected 14 tables are:

| Migration | Expected tables |
| --- | --- |
| 001 | `workspaces`, `oa_integrations`, `customers`, `campaigns`, `campaign_revisions`, `scheduler_jobs`, `audit_log`, `webhook_events` |
| 002 | `admin_users`, `auth_sessions` |
| 003–004 | Alter `scheduler_jobs`; add staging-only checks and workspace trigger |
| 005 | Alter `oa_integrations`; add `workspace_controls`, `campaign_controls`, `oa_rate_limit_windows` |
| 006 | Add `outbox_deliveries`, indexes, and outbox workspace trigger |
| 007 | Replace the outbox trigger function with the exact OA association guard |

The expected constraint and trigger behavior is more specific than the table count. In particular, 003–004 constrain jobs to `DRY_RUN` and `Asia/Bangkok`, 004 binds job resources to one workspace, and 007 binds an outbox row to the exact OA selected by its scheduler job.

## Parity matrix

| Area | Expected from source | Cloud evidence | Result |
| --- | --- | --- | --- |
| Project health | Active and reachable | `ACTIVE_HEALTHY` supplied | PASS at project level |
| Application tables | 14 named tables in `line_ccc` | 14 tables supplied; names not supplied | PENDING exact-name check |
| Columns/defaults | Final state of 001–007 | Not read from Cloud in this process | PENDING |
| PK/FK/unique/check constraints | Final catalog state and 004/005/007 guards | Not read from Cloud in this process | PENDING |
| Indexes | Source indexes plus FK support indexes | Seven FK index gaps reported by Advisor | FAIL / repair required |
| Triggers/functions | Scheduler guard and final outbox guard | Not read from Cloud in this process | PENDING |
| Function search paths | Explicit safe settings or verified controlled defaults | Not read from Cloud in this process | PENDING / security gate |
| Rows | Empty staging tables | Empty supplied | PASS for clean staging state |
| pgcrypto | `gen_random_uuid()` available through configured path | Extension present; active path not verified | PENDING connection test |
| App ledger | `line_ccc.schema_migrations` for 001–007 | Table absent | FAIL / migration gate |
| Supabase History | private schema plus 001–007 | 8 entries supplied | PASS as platform history; not equivalent to app ledger |

## Migration ledger finding

Supabase migration history and the application ledger are separate systems:

1. Supabase History records platform migration execution.
2. `apps/api/src/migrate.ts` creates an unqualified `schema_migrations` table and records filenames such as `001_control_center.sql`.
3. With `search_path=line_ccc,extensions`, that unqualified table resolves to `line_ccc.schema_migrations`.
4. Because the Cloud application ledger is absent, running `npm run db:migrate` against Cloud would treat all local SQL files as unapplied. Several files contain `ALTER`, `UPDATE`, `INSERT`, trigger replacement, and staging hardening logic.

Therefore `npm run db:migrate`, `npm run db:setup`, `supabase db push`, reset commands, and any automatic bootstrap are blocked for Cloud until a human approves a reconciled ledger plan. The report does not infer that Supabase History means the app ledger is safe to create or backfill.

## Role and RLS gate

The supplied Cloud evidence says RLS is disabled on all 14 tables. That is a FAIL for an exposed Supabase schema. The intended access boundary is:

| Principal | Intended access |
| --- | --- |
| `anon` | No table access; no access to `admin_users`, `customers`, `outbox_deliveries`, or auth/session data |
| `authenticated` | No direct table access for this server-admin design; browser uses the Fastify API session, not Supabase table access |
| Backend role | Server-only access through the API/Worker secret store, with least-privilege grants reviewed against actual queries |

RLS and GRANT statements are deliberately not proposed for immediate execution. Before any approval, inspect table grants, schema usage, policies, service role/bypass-RLS status, and the exact backend role using [cloud_schema_audit.sql](../db/queries/cloud_schema_audit.sql). Then prepare a separate reviewed policy migration. No client should receive a database URL, database password, service role key, or channel secret.

## CLOUD_STAGING connection gate

The server-side check is [connectionCheck.ts](../apps/api/src/connectionCheck.ts). It reads only server environment variables and performs a read-only query. It now reports `target`, `expectedSchema`, `currentSchema`, the actual `searchPath`, SSL state, and declared pool mode. It fails closed when:

- `DB_TARGET=CLOUD_STAGING` is pointed at loopback;
- Cloud SSL is disabled;
- the active schema is not `line_ccc`;
- `gen_random_uuid()` is unavailable through the configured path; or
- no server-only connection string is configured.

Use `CLOUD_STAGING_DATABASE_URL` in the server environment, with `DB_SCHEMA=line_ccc`, `DB_EXTENSION_SCHEMA=extensions`, and `DB_SSL_MODE=require` or `verify-full`. The current code can prove the TLS session and active search path after a server-side run. It cannot prove whether a hostname is backed by a session pooler or transaction pooler; that requires endpoint/configuration evidence from the operator. The `DB_POOL_MODE` value is currently an explicit deployment contract, not a substitute for verifying the actual Supabase endpoint.

## Frontend and secret scan

The Admin bundle calls the Fastify API and does not reference database URLs or Supabase keys. The only browser password field is the login form; it is submitted to the API and is not persisted. OA screens accept metadata only and do not accept or return provider secrets. `.env`, backups, dumps, and local screenshots are ignored.

Repository scan found no credential values in tracked source. The workflow contains GitHub secret references and a localhost CI fixture URL with a secret placeholder; these are not Cloud credentials. The scan is a local source check only because this checkout has no Git remote configured.

## Repair plan, prepared but not applied

1. **Ledger:** after exact parity and checksum review, create the application ledger in `line_ccc` with the columns required by the app. Backfill only entries whose final catalog state and migration checksum are verified. Do not mark a migration applied from Supabase History alone.
2. **Indexes:** add the seven Advisor-reported foreign-key indexes with additive `CREATE INDEX CONCURRENTLY` statements, one reviewed statement per index, after confirming there is no equivalent composite/partial index. `CONCURRENTLY` requires an execution procedure outside a transaction.
3. **Drift:** prepare additive `ALTER TABLE ... ADD COLUMN/CONSTRAINT` or `CREATE OR REPLACE FUNCTION` statements only for confirmed differences. Do not use `DROP`, `RESET`, or broad re-run of 001–007.
4. **RLS/grants:** prepare a separately reviewed policy migration after role/grant inspection. Keep Admin, Customer, Outbox, and Auth/session tables inaccessible to browser roles.
5. **Verification:** rerun the read-only audit, backend connection check, local tests, and server smoke test. Require explicit approval before any Cloud apply.

## Deploy approval checklist

| Gate | Status |
| --- | --- |
| Exact Cloud catalog parity report complete | BLOCKED: connector result or server-side audit output required |
| Ledger reconciliation approved | BLOCKED: app ledger absent |
| Seven FK indexes repaired and verified | BLOCKED: additive repair approval required |
| RLS policy and grants reviewed | BLOCKED: RLS disabled |
| Server `CLOUD_STAGING` connection check passes | BLOCKED: no server connection configured in this process |
| Backend role, SSL, search path, and pooler endpoint verified | BLOCKED |
| Frontend secret scan and Git ignore check | PASS locally; remote scan pending |
| Local regression/security/typecheck/build | PASS: 17/17 baseline, 2/2 security, 7/7 OA, typecheck, and build |
| LINE Live, webhook, and real message traffic | HOLD by policy |

**Deploy decision: FAIL / HOLD.** Approval is required for the repair SQL, RLS/grants policy, credential-store configuration, and any subsequent Cloud apply.
