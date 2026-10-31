# Phase 5B — Referral & Customer Journey on PostgreSQL

Status: implemented locally, PostgreSQL integration validation pending.
Mode: `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false`, `LINE_WEBHOOK_ENABLED=false`.

## Goal

Make the referral journey real on PostgreSQL: an owner/admin creates a staff link, a member opens it, LINE Login binds the member, and a signed follow webhook verifies that the follow actually happened — with every count scoped to one workspace.

No new migration was needed. The phase reuses `staff_invite_links`, `referral_attribution_events`, `line_customers`, `line_customer_login_states`, and `line_customer_sessions` from migrations 008, 010, and 011.

## Data flow

1. `POST /api/referrals` resolves an active staff membership and an enabled `STAGING` OA in the caller's workspace, then inserts `staff_invite_links` with `token_hash = sha256(token)`.
2. The response contains the plaintext token once and the share URL `${PUBLIC_APP_ORIGIN}/r/:token`. Neither the list nor the dashboard ever selects the token or its hash.
3. `GET /r/:token` (Admin SPA) renders `StaffPortal`, which calls `POST /api/referrals/:token/click`. The click route is public and IP rate limited; it records `CLICK` in `referral_attribution_events`.
4. "Login with LINE" starts the existing LINE Login flow with the referral token. The Postgres store resolves the invite link, seals the flow state, and on callback upserts `line_customers` and records `LOGIN` against the customer's first-touch `attributed_invite_link_id`.
5. A signed `follow` webhook event is verified, the raw LINE user ID is HMAC'd with `LINE_IDENTITY_HASH_KEY`, matched against `line_customers.line_subject_hmac`, and recorded as `FOLLOW_VERIFIED` with its webhook event ID as evidence.
6. The dashboard aggregates clicks, logins, and verified follows per staff/OA/date, all inside the caller's workspace.

## API

| Method | Route | Access | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/referrals/staff` | workspace member | Staff choices for filters and creation; safe for editors/viewers. |
| `GET` | `/api/referrals?staffId&oaId` | workspace member | Tenant-scoped, max 200, no token material. |
| `POST` | `/api/referrals` | owner/admin + CSRF | 201; returns URL and one-time token; 60 creates/hour per workspace+user. |
| `POST` | `/api/referrals/:id/status` | owner/admin + CSRF | `ACTIVE`, `PAUSED`, `REVOKED`; `REVOKED` is terminal. |
| `GET` | `/api/referral-dashboard?staffId&oaId&from&to` | workspace member | Counts plus `conversionRate = follows / clicks`. |
| `GET` | `/api/referral-events` | workspace member | Latest 100 events, no subject HMAC. |
| `POST` | `/api/referrals/:token/click` | public | Strict token shape, 120 requests/minute per IP, fails closed for revoked/expired/disabled targets. |

`from`/`to` are ISO timestamps; the Admin sends Bangkok day boundaries (`+07:00`) so a date filter matches the local day.

## Token and attribution rules

- Token: 32 random bytes, base64url, exactly 43 characters. Only the SHA-256 hex hash is persisted.
- Expiry: optional, must be in the future and at most 366 days; absent means no expiry.
- A link is usable only while `ACTIVE`, unexpired, the staff membership is `ACTIVE`, and the OA is enabled in `STAGING`.
- `PAUSED` can be resumed; `REVOKED` cannot.
- First-touch: a repeat LINE Login through another staff link keeps the customer's original `attributed_invite_link_id`; `LOGIN` events are logged against that original link.
- Follow verification dedupes on the existing partial unique indexes (evidence event ID, one verified follow per customer). Re-processing a duplicate webhook is safe and lets attribution self-heal after a partial failure.
- The webhook path is still gated by `LINE_WEBHOOK_ENABLED=true`; when the gate or the identity hash key is absent, no follow verification is attempted.

## Admin UI

- Section "Referral Dashboard": staff/OA/date filters, summary cards, per-staff table, and latest events.
- Owner/admin see the create panel and pause/resume/revoke actions; other roles see the read-only dashboard.
- Creating a link shows the URL and QR once with a copy action; the token is not shown again after the panel closes.
- Empty, loading, and error states are handled explicitly; disabled OAs cannot be chosen for new links.
- Staff and OA options come from `/api/referrals/staff` and `/api/oas`, so the page does not depend on owner/admin-only workspace endpoints.

## Verification performed

- `npm run typecheck`
- `npm run build` (Admin Vite build + API `tsc`)
- `npm test` — 17/17
- `npm run test:security` — 3/3
- `npm run test:phase5a` — 7/7
- `npm run test:phase5b` — 3/3
- `npm run test:campaign-mock` — 4/4
- `npm run test:line-login` — 6/6
- `npm run test:oa:connect` — 7/7
- `npm run test:live-contract` — 3/3
- `npm run test:tenant` — 11 passed, 1 skipped (database suite)
- `tests/tenant-admin.ui.test.mjs` — workspace browser flow passed
- `tests/line-login-postgres.integration.test.mjs` — migration shape passed; database suite skipped
- `tests/referral-postgres.integration.test.mjs` — skipped without `REFERRAL_TEST_DATABASE_URL`

The PostgreSQL journey suite requires a fresh disposable loopback database whose name starts with `line_ccc_referral_qa_`. It is refused for non-loopback hosts and for any database with a migration ledger. It was not run here because no local PostgreSQL is available.

## Known limits

- Click and creation limiters are in-process; multi-instance deployment needs a shared limiter.
- The public click route is intentionally unauthenticated and cannot be fully shielded from bots beyond IP rate limiting and the token shape check.
- Dashboard conversion is follows/clicks, not unique people; repeat clicks by the same browser still count.
- No email/SMS delivery of links; the operator copies the URL or QR.
- Applying migrations and enabling the webhook remain explicit approval steps. Nothing was deployed.
