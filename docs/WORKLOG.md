# Worklog

## 2026-11-01 — Dedicated staging host deployed live (Lightsail)

- Chose an isolated staging VM instead of reusing the shared preview host `line-ccc-v1`, where 80/443 and the PHP packages are already serving other apps. Instance `line-ccc-staging`: Ubuntu 24.04.4, ap-southeast-1a, 4 GB/2 vCPU/80 GB, static IP 13.212.244.219, served at `https://13-212-244-219.sslip.io/`.
- Code ships from branch `staging-deploy-2026-11-01` (main untouched; main was stale and missed phases 5A–5F plus the fresh-DB fixes, so deploying from main would have broken migration 010 and login).
- `deploy/host-bootstrap.sh` provisioned Docker 29.9.2 + compose plugin, 2 GB swap, ufw 22/80/443, fail2ban, unattended-upgrades, journald 500 MB cap, and `/srv/line-ccc-staging`. Compose logs capped at 10 MB × 3 files.
- Lightsail IPv4 firewall serves 22/80/443; 443 was opened from the console after the first deploy (Caddy obtained a Let's Encrypt cert via HTTP-01 while only 80 was open, then HTTPS went live).
- Compose stack runs postgres (loopback 55433 only), api, worker (no ports), admin behind Nginx, Caddy on 80/443 with HSTS/CSP/nosniff. Migrations 001–012 applied; seed created 7 campaigns plus owner/viewer users.
- Fixed the fresh-image EACCES that blocked the CLI: build-context files arrived mode 600/700 and Docker COPY preserved those modes while the image runs `USER node`. `deploy/Dockerfile` now copies `dist`, `db`, `campaigns.json` and `flex` with `--chown=node:node`, with a phase5e regression assertion per asset. The one-off migrate/seed ran as root before this fix and is no longer needed after the rebuild.
- Read-only staging smoke against the live URL: 10/10 checks (health, DRY_RUN mode, postgres persistence, security headers, LINE Login disabled, dashboard auth gate, admin login, ops delivery health, audit log, logout).
- Safety posture unchanged: `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false`, `LINE_WEBHOOK_ENABLED=false`, LINE Login disabled, no real LINE/OA secrets on the host, DB reachable only on loopback.
- Remaining: backups still live only on the VM (offsite copy pending), read-only cloud audit + backup/restore drill recorded in the entry below.

## 2026-11-01 — Backup/restore drill and read-only cloud audit on live staging

- `pg_dump --format=custom` from the postgres container wrote a 93,599-byte archive to `/srv/line-ccc-staging/backups/` (PGDMP magic verified, sha256 sidecar written). The host has no PostgreSQL client, so the drill used `docker compose exec -T postgres sh -c 'pg_dump ...'` — the runbook now documents both paths.
- Restore drill: created `line_ccc_restore_drill`, `pg_restore` exit 0, row counts matched the live database exactly (schema_migrations 12, campaigns 7, admin_users 2, audit_log 7, outbox_deliveries 0), then dropped the drill database.
- Read-only audit (`begin read only`, SELECT-only guard, role `line_ccc`): migrations 001–012 all applied; all 25 expected tables present and no unexpected public tables; outbox empty; the three `line_customer_*` tables have RLS enabled with zero policies (migration 011) — harmless while the API connects as the owning superuser, but tracked by the RLS proposal; the app role `line_ccc` is `rolsuper` with `BYPASSRLS` and full DML grants on all 26 tables — exactly the posture the Tier A/B proposal exists to tighten; FK audit reports 25 composite FKs without a leading-column index (the 7 covered by `db/proposals/013_fk_supporting_indexes.sql` plus the 18 additional gaps recorded during the 5F rehearsal).
- Fixed two repo defects found by the drill: `.gitignore` had `audit/` which silently excluded `db/audit/read-only-audit.sql` from version control (now `/audit/`, file tracked); the FK-index audit query referenced an output alias inside `ORDER BY`, which PostgreSQL rejects (now wrapped in a subquery).
- No production data changed: the restore touched only the disposable drill database and the audit ran in a read-only transaction.

## 2026-11-01 — RLS/grant proposal rehearsal on disposable PostgreSQL

- Added `db/proposals/` with Tier A+B RLS/grant SQL, seven FK supporting indexes, a read-only verification query, and a README apply/rollback guide. Nothing was added to `db/migrations/`, so no automatic apply.
- Tier A revokes `anon`/`authenticated` only when those roles exist and revokes `PUBLIC` schema usage only for a dedicated (non-`public`) schema. Tier B enables RLS on every table in the current schema with no policies and no `FORCE`.
- Rehearsed on a loopback Postgres 16 container: migrations 001–012, simulated browser roles with SELECT grants, then applied the proposal. Result: RLS 26/26 tables, 0 policies, 0 table grants for browser roles, and the API owner connection still passed the 16/16 smoke including login, ops health and audit.
- Recorded two findings: browser-role schema USAGE on `public` comes from `PUBLIC`, not a direct grant; the stricter FK check reports 18 additional composite-FK leading-column gaps beyond the seven indexed.
- Added a Phase 5F regression test that keeps the SQL as a guarded proposal, rejects `FORCE`/`CREATE POLICY`, and keeps the verification query read-only. Phase 5E+5F suites: 19/19.
- No cloud connection, no RLS/grant apply, no migration, no deploy, no commit.

## 2026-11-01 — Docker compose staging rehearsal and fresh-database fixes

- Installed the missing WSL2 kernel and WSL package, started Docker Desktop, and ran the full staging compose topology locally: postgres (loopback), private api/worker, admin behind Nginx, and Caddy TLS on 80/443.
- Built all three images from `deploy/Dockerfile`; applied migrations 001–012 to an empty container database and seeded 7 campaigns.
- Fixed two fresh-database defects found by the rehearsal:
  - `010_referral_reporting_indexes.sql` created a composite FK on `staff_invite_links(id, workspace_id)` before the matching unique index, so migration aborted with `42830`. The unique index now precedes the FK.
  - `seed.ts` created admin users without `workspace_memberships`, and the membership backfill in 008 only covers rows that existed at migration time. Login therefore returned 401 on every fresh setup. Seed now upserts an ACTIVE membership for both owner and viewer.
- Verified Caddy HTTPS (200), security headers, admin health, API `/health` (DRY_RUN, postgres), and the read-only smoke inside the compose network: 16/16 checks including login, session, ops health, audit and logout. Worker stayed up with zero restarts.
- Added regression assertions to `tests/phase5e.test.mjs` (index-before-FK ordering and membership seeding); 9/9 pass, typecheck and 37/37 static suites green.
- No cloud connection, no migration 012 apply, no RLS/grant change, no deploy, no commit.

## 2026-11-01 — Phase 5F vault rotation, alert delivery and RLS/grant proposal

- Added `vaultRotate.ts` and `npm run vault:rotate`: dry-run by default, `--confirm` writes, decrypt/re-encrypt with the same tenant-bound AAD, round-trip verification, one transaction for all rows, and secret-free `OA_VAULT_REKEYED` audit rows. Old key falls back to `LINE_CREDENTIAL_ENCRYPTION_KEY`; the new key comes from `LINE_CREDENTIAL_ENCRYPTION_KEY_NEW`.
- Added `opsNotify.ts` and `npm run ops:health -- --notify`: aggregate-only alert payload, HTTPS requirement (loopback HTTP for tests), credential-free URL validation, 5s timeout, no redirects, and non-secret failure reporting. CLI keeps exit code 1 on alerts or failed delivery.
- Documented rotation order/rollback, cron-driven alerting, and a three-tier RLS/grant proposal (revoke browser roles, deny-by-default RLS for browser roles, later dedicated app role with `FORCE RLS` and tenant policies). No RLS, GRANT, index or migration SQL was executed.
- Added `tests/phase5f.test.mjs` (8 tests) with a fake pool for rotation and a local HTTP server for webhook delivery; wired `test:phase5f` into CI.
- Cloud read-only audit and backup/restore drill remain blocked: this session has no `AUDIT_DATABASE_URL`/`BACKUP_DATABASE_URL`, no `psql`/`pg_dump`/`pg_restore`, and no disposable restore database. Docker Compose testing also remains blocked because Docker Desktop and WSL are unavailable on this machine.
- Safety posture unchanged: no cloud connection, no deploy, no migration 012, RLS/grants untouched, LINE live/webhook disabled, and no secret values printed or committed.

## 2026-11-01 — Phase 5E staging hardening, CI coverage and ops tooling

- Rewrote `.github/workflows/staging-ci.yml`: Node 22 with npm cache, concurrency, `npm audit --omit=dev`, eight disposable PostgreSQL services with per-job databases and matching `pg_isready` health checks (fixing the old `line_campaign_ccc` mismatch), migration replay from an empty database, and an Admin E2E job that installs Chromium and uploads logs/screenshots on failure.
- Added deployment assets for three private surfaces plus an edge: `deploy/Dockerfile` (`api`/`admin` targets), `docker-compose.staging.yml` (Caddy → admin → api; worker with no ports), `deploy/nginx.conf` (rate limit, CSP, security headers, dotfile deny), `deploy/Caddyfile` (TLS/HSTS), `deploy/staging.env.example`, and `.dockerignore` covering `.env` and backup directories.
- Added `TRUST_PROXY` support to the Fastify factory so rate limits and audit trails see the forwarded client address only when explicitly enabled.
- Added `opsHealth.ts` with aggregate outbox counters, stuck/oldest-age detection, worker heartbeat from audit activity, per-OA monthly/minute quota, and alerts (`UNKNOWN_DELIVERIES`, `STUCK_DELIVERIES`, `WORKER_STALE`, `QUOTA_NEAR_LIMIT`, `OA_RATE_LIMIT_REACHED`); exposed through the authenticated `/api/ops/delivery-health` route and `npm run ops:health`.
- Added guarded tooling: `scripts/staging-smoke.mjs` (read-only smoke against a local memory API), `scripts/db-backup.mjs` (pg_dump custom archive with PGDMP/sha256 verification), `scripts/db-restore.mjs` (restore drill only, rejects source/unsafe target names and checksum mismatch), and `scripts/cloud-audit.mjs` plus `db/audit/read-only-audit.sql` (SELECT-only, `begin read only`).
- Documented topology, secrets/key backup and rotation, alert handling, pre-migration gate, rollback/restore drill, and acceptance status in `docs/PHASE5E_STAGING_HARDENING.md`; updated README and `.env.example`.
- Added `tests/phase5e.test.mjs` (8 tests) covering the workflow, compose topology, edge configs, trustProxy, ops health thresholds/alerts, a live smoke against the memory API, guard scripts, and read-only audit SQL. Updated the referral E2E for the current Staff Portal. All Phase 5E tests pass locally.
- No deploy, no cloud connection, no migration 012 applied, no RLS/grant change, and no secret values touched. Docker/Caddy configs are statically validated only because Docker is not installed on this machine.

## 2026-11-01 — Phase 5D per-recipient delivery pipeline and outbox ledger

- The worker now always runs the outbox pipeline. DRY_RUN uses the mock transport and LIVE would use the HTTP adapter; `createMessagingAdapter` requires APP_MODE=LIVE, `LINE_LIVE_ENABLED=true`, PostgreSQL, and the vault key together, so live stays locked.
- Prepared one delivery per opted-in, unblocked recipient against the frozen campaign revision; `buildDeliveryPayload` is shared by both adapters and rejects non-`U…` userIds, empty `altText`, and preview payloads on the live path.
- Resolved the OA access token at send time from the vault with workspace/OA-bound AAD, no cache or fallback, and zeroized the buffer in `finally`.
- Added transactional quota reservation: OA row lock, per-minute window, monthly quota, increment only in LIVE, release on certain failures, and `usedInWindow` in readiness.
- 429/5xx are treated as uncertain: the outbox becomes `UNKNOWN`, the job `FAILED`, and an operator reconciles via the new workspace-scoped outbox/reconcile endpoints (`OUTBOX_RECONCILED` audit). Certain retryable errors back off up to three attempts.
- Kill switches, approval, consent, and quota are re-read before every recipient; a mid-run failure leaves remaining deliveries `PENDING`.
- `POST .../dry-run` now enqueues and runs the same worker with the mock adapter; the staging job ends `COMPLETED` with a `SENT` preview delivery.
- Added the Admin Delivery Ledger with per-recipient status, masked recipients, and UNKNOWN reconcile actions; it remounts on job status/attempt changes so a Run refreshes it.
- Added `tests/phase5d.test.mjs` (13 tests) and a guarded `tests/delivery-postgres.integration.test.mjs`, plus `docs/PHASE5D_DELIVERY_PIPELINE.md` and `.env.example` notes.
- No new migration. Safety posture unchanged: DRY_RUN, live/webhook disabled, no secret touched. PostgreSQL delivery suite remains skipped locally.

## 2026-11-01 — Phase 5C webhook, consent, and per-OA channel secret

- Extracted the LINE webhook into `lineWebhook.ts`: strict body/event validation, event-count and body-size limits, IP/OA rate limits, and safe 400/401/503 responses.
- PostgreSQL webhooks now resolve the OA and decrypt its Channel Secret from `oa_credential_vault` with tenant-bound AAD; `LINE_CHANNEL_SECRET` is passed only for memory mode and is never a PostgreSQL fallback.
- The first valid signed batch marks `workspace_oa_channels` `VERIFIED` with `verified_at`, guarded by the channel/provider ID constraint, and writes `OA_CHANNEL_VERIFIED` to the audit log.
- Follow upserts opt-in and clears the block; unfollow upserts a blocked customer. Other events store only the webhook receipt hash, never message contents or customer PII.
- The webhook path ignores system/campaign/OA kill switches so opt-out still works while sending is stopped.
- OA connection status now includes `verifiedAt`, and the Admin UI shows "รอ signed webhook แรก" / "ยืนยัน signed webhook แล้ว" instead of the raw status.
- Added `tests/phase5c.test.mjs` and a guarded `tests/webhook-postgres.integration.test.mjs`; updated the Phase 5B static wiring test for the extracted module, and the staging integration test now signs with `STAGING_WEBHOOK_SECRET` (the OA vault secret) and skips when it is not configured.
- No new migration. Safety posture unchanged: DRY_RUN, webhook gate disabled by default, no LINE API call, no secret in responses or logs. PostgreSQL integration remains skipped locally.

## 2026-11-01 — Phase 5B referral and customer journey on PostgreSQL

- Added `referralStore.ts` and `referralRoutes.ts`: staff/OA scoped link creation, pause/resume/revoke, click recording, dashboard aggregation, event feed, and rate limits.
- Referral tokens are 32 random bytes (base64url), stored only as SHA-256 hashes, and returned once with the `${PUBLIC_APP_ORIGIN}/r/:token` share URL. No query selects token material.
- Wired `/r/:token` to the member portal and the existing LINE Login flow; Postgres login now preserves first-touch attribution by using the customer's `attributed_invite_link_id`.
- Verified signed follow webhooks by HMAC'ing the LINE user ID with `LINE_IDENTITY_HASH_KEY`, matching `line_customers`, and recording `FOLLOW_VERIFIED` with the webhook event ID as evidence; duplicate events remain idempotent.
- Reworked the Referral Dashboard for PostgreSQL mode: staff/OA/date filters, summary and per-staff counts, one-time URL/QR, status actions, and read-only mode for editors/viewers.
- Added `tests/phase5b.test.mjs`, a guarded `tests/referral-postgres.integration.test.mjs`, and `docs/PHASE5B_REFERRAL_POSTGRES.md`; fixed the migration-011 shape assertions to accept `create table if not exists`.
- No new migration: existing 008/010/011 tables are reused, and 012 from Phase 5A still awaits a backup and explicit approval.
- Safety posture unchanged: DRY_RUN, LINE live/webhook disabled, no secret values touched. PostgreSQL journey tests remain skipped locally pending a disposable loopback database.

## 2026-11-01 — Phase 5A account lifecycle and baseline hardening

- Added `012_account_invites.sql`: hashed one-time account tokens and idempotent scheduler client keys.
- Replaced the invite dead-end with one-time invite/reset links, `/account-setup`, session revocation on password change, and no plaintext password material in API responses.
- Switched login to async scrypt with a dummy hash for unknown accounts, added per-account/IP rate limits, trusted-Origin checks, security headers, request IDs, and generic 500 handling.
- Added `Idempotency-Key` support for scheduler creation and rotated keys after success in the Admin UI.
- Fixed OA `secretConfigured` to use the credential vault, enforced reviewer separation of duties, merged the memory audit feed, replaced hard-coded dashboard values, and corrected the scheduler local-time default.
- Added `tests/phase5a.test.mjs`, tenant invite/link tests, and `docs/PHASE5A_ACCOUNT_LIFECYCLE_HARDENING.md`.
- Safety posture unchanged: DRY_RUN, LINE live/webhook disabled, no credential or token values committed. PostgreSQL integration suites remain blocked locally pending a staging database.

## 2026-10-21 — Pre-push credential and manifest remediation

- Removed the Memory repository's implicit credential/runtime fallback: it now requires explicit `PERSISTENCE=memory`, `APP_MODE=DRY_RUN`, a `MEMORY_ADMIN_PASSWORD` of at least 12 characters, and rejects `LINE_LIVE_ENABLED=true`.
- Added security regression coverage for missing Memory credentials and live-mode attempts.
- Extended `.gitignore` for additional private-key formats and customer-export naming variants without ignoring source/test fixtures.
- Kept the existing PostgreSQL staging volume, database password, and branch history untouched; commit/push remain pending approval.

## 2026-10-20 — Phase 4B continuation

- Reviewed the existing working-tree diff, staging workflow, repository, worker, transport, policy, migration, and Phase 4B tests.
- Kept staging safety boundaries: `APP_MODE=DRY_RUN`, no live LINE calls, no production webhook, no credentials or tokens in source or logs.
- Changed PostgreSQL Outbox preparation to verify the claiming worker and create/list delivery rows in one transaction.
- Bound Outbox sending/completion/failure transitions to the same workspace and worker-owned scheduler job.
- Re-read campaign approval, kill switches, OA enabled state, consent, quota, and rate policy immediately before every transport call.
- Added migration `007_phase4b_outbox_association_guard.sql` so a delivery cannot reference an OA different from its scheduler job.
- Added Phase 4B regression coverage for non-owner preparation, the policy race window, and wrong-OA workspace association.
- Verified local regression, security, OA transport, typecheck, build, and problem checks. PostgreSQL-dependent migration/integration/E2E execution remains blocked until the user supplies staging environment values and the staging PostgreSQL service is available.
