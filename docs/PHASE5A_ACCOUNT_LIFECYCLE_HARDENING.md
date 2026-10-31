# Phase 5A — Account Lifecycle & Baseline Hardening

Status: implemented locally, staging validation pending.
Mode: `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false`, `LINE_WEBHOOK_ENABLED=false`.

## Goal

Close the invitation dead-end and raise the baseline security of the staging Admin without enabling any LINE send or production surface.

## Account lifecycle

- A new member is created as `INVITED` with an unusable random password.
- The invite API now returns a one-time setup URL (`/account-setup?token=...`) and never returns password material.
- `POST /api/workspace/members/:id/account-link` with `{ "purpose": "INVITE" | "RESET" }` issues a fresh link:
  - `INVITE` requires membership status `INVITED`.
  - `RESET` requires membership status `ACTIVE`.
  - Admin roles cannot issue links for an owner account.
- `POST /api/account/setup` accepts the token once, enforces a 12-character minimum, activates invited memberships, and revokes every existing session for that account.
- Tokens are 32 random bytes rendered as 43 URL-safe characters; only the SHA-256 hash is stored. Issuing a new token invalidates the previous unused token for the same user and purpose.
- `PATCH /api/workspace/members/:id` no longer allows `INVITED → ACTIVE` directly; the setup link is the only activation path. Suspending a member revokes their sessions.
- Admin UI: member rows offer `คัดลอกลิงก์เชิญ` / `ส่งลิงก์รีเซ็ต`, show the one-time URL once with a copy action, and hide link actions for non-persisted mock members.

Token lifetime: 7 days (server-side default in `apps/api/src/accountTokens.ts`).

## Baseline hardening

- Password verification uses async scrypt; unknown accounts are compared against a dummy hash so timing and response bodies match.
- Login is limited per `IP + email` (10 attempts / 15 min) and per IP (50 / 15 min); a successful login resets the account bucket.
- Account setup is limited to 10 attempts / 15 min per IP.
- LINE OA connection attempts are limited to 10 / hour per workspace per process.
- Mutating requests with an untrusted `Origin` are rejected. Requests without an `Origin` header (server-to-server, tests) continue to rely on CSRF.
- Security headers: `x-content-type-options`, `x-frame-options`, `referrer-policy`, `cross-origin-resource-policy`, `permissions-policy`, and `cache-control: no-store` for `/api/*`.
- Errors return a generic 500 body with a request ID; 4xx responses keep their public message.
- Scheduler job creation accepts an `Idempotency-Key` header (8–100 URL-safe characters). A repeated key returns the original job instead of creating another. The Admin form sends `crypto.randomUUID()` and rotates it only after a successful create.

## Correctness changes

- `secretConfigured` for an OA is derived from `oa_credential_vault`, not the legacy `secret_ref` column.
- Reviewer role is read + approve only; editor retains write. The Admin UI disables write/approve/schedule controls accordingly.
- Memory mode now serves a merged audit feed (repository + mock referral events) instead of shadowing the repository audit.
- Dashboard date, campaign count, OA count, and enabled count come from live values.
- The scheduler form initializes `datetime-local` in local wall time, so the default is no longer an hour in the past for UTC+7 users.

## Migration

`db/migrations/012_account_invites.sql` (additive):

- `admin_account_tokens` (hashed one-time tokens, FK to `admin_users` + workspace).
- `scheduler_jobs.client_request_key` plus a unique `(workspace_id, client_request_key)` index.

Apply only after a database backup. The migration adds nullable columns/tables only and is safe for old code to ignore.

## Verification performed

- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run test:security`
- `npm run test:campaign-mock`
- `npm run test:oa:connect`
- `npm run test:line-login`
- `npm run test:live-contract`
- `node --test tests/tenant-admin-api.test.mjs tests/multitenant-login.test.mjs`
- `npm run test:phase5a`
- Manual browser checks: `/account-setup` renders, rejects mismatched passwords, shows the generic invalid-link error; Admin dashboard shows the current date and live counts; scheduler default time is one hour ahead in local time.

PostgreSQL-dependent integration/E2E suites were not run because no local database/browser drivers are available in this environment.

## Known limits / next phases

- Rate-limit buckets are in-process; a multi-instance deployment needs a shared store (Redis or Postgres) before production.
- There is no self-service “forgot password”; an owner/admin issues a reset link.
- Live worker pipeline, outbox delivery, and run-dry parity remain Phase 5D.
- `apps/api/src/store.ts` is still unused legacy code; removal is deferred to avoid touching the Phase 1 source-audit test.
