# Worklog

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
