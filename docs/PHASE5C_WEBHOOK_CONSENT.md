# Phase 5C — Webhook, Consent, and Per-OA Channel Secret

Status: implemented locally, PostgreSQL integration validation pending.
Mode: `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false`, `LINE_WEBHOOK_ENABLED=false` by default.

## Goal

Make the staging webhook trustworthy per LINE OA: verify the raw request body with that OA's own Channel Secret from the encrypted vault, record signed events exactly once, update consent for follow/unfollow, and only mark the channel `VERIFIED` after the first valid signed event.

The global `LINE_CHANNEL_SECRET` is no longer used in PostgreSQL mode. PostgreSQL webhooks fail closed when the OA has no vault secret.

## Request flow

1. `POST /api/webhooks/line/:oaId` is disabled unless `LINE_WEBHOOK_ENABLED=true`.
2. IP and OA fixed-window limiters run before any database lookup.
3. In PostgreSQL mode the route resolves the OA (`STAGING` only) and decrypts `oa_credential_vault.secret_sealed` with AES-256-GCM and AAD `lineccc:v1:<workspaceId>:<oaId>:secret`.
4. The HMAC-SHA256 signature of the exact raw body is compared with `x-line-signature` using a timing-safe comparison.
5. The body is validated before persistence: object body, `events` array, at most 100 events, safe event IDs/types, numeric timestamps, and a valid source for follow/unfollow.
6. Each accepted event is inserted into `webhook_events` with the batch payload hash; the unique `(oa_integration_id, webhook_event_id)` index makes replays no-ops.
7. Follow sets `customers.opt_in=true` and clears `blocked_at`; unfollow upserts `opt_in=false` with `blocked_at=now()`. Other event types do not write customer rows or store message contents.
8. On the first accepted batch with events, the route marks `workspace_oa_channels.status='VERIFIED'` with `verified_at=now()` (only when channel/provider IDs are present) and writes `OA_CHANNEL_VERIFIED` to `audit_log`.
9. Follow events with `LINE_IDENTITY_HASH_KEY` also create the Phase 5B `FOLLOW_VERIFIED` attribution only when the subject HMAC matches a LINE Login customer.

No raw line user ID, access token, channel secret, or signature is stored in `webhook_events`. The response contains only `{ accepted, eventCount, duplicates }`.

## Consent and kill switches

- Follow re-opts a previously blocked customer; unfollow always blocks, even if the customer row did not exist before.
- The webhook route never checks the system, campaign, or OA kill switch. Opt-out processing therefore keeps working while sending is stopped.
- `LINE_WEBHOOK_ENABLED=false` still disables the endpoint entirely; that is the staging transport gate, not a kill switch.
- Events other than follow/unfollow are deduplicated but no customer PII is written.

## Matching rules

- OA must exist in `oa_integrations` with `environment='STAGING'`. Production OAs are not reachable through this staging endpoint.
- The vault row must exist and decrypt for the exact workspace/OA pair. A secret copied from another OA fails verification and never marks the channel verified.
- `workspace_oa_channels` needs `messaging_channel_id` and `line_provider_id` (set by the OA connect flow) before it can transition to `VERIFIED`.
- `VERIFIED` is terminal from this path; later invalid signatures do not downgrade it.

## Admin UI

`ConnectLineOa` now labels the channel state:
- `VERIFY_PENDING` → "รอ signed webhook แรก"
- `VERIFIED` → "ยืนยัน signed webhook แล้ว" with the verification time
- otherwise the raw status or `LIVE DISABLED`

`GET /api/workspace/oa-connect/status` returns `verifiedAt` next to `channelStatus`. No secret is returned.

## Migration

No new migration. The phase uses existing `oa_credential_vault` (009), `workspace_oa_channels` (008), `webhook_events` (001), and `customers` (001). Migration `012_account_invites.sql` from Phase 5A remains unapplied.

## Verification performed

- `npm run typecheck`
- `npm run build` (Admin Vite + API `tsc`)
- `node --test tests/core.test.mjs tests/phase1.test.mjs tests/security.test.mjs tests/phase5a.test.mjs tests/phase5b.test.mjs tests/phase5c.test.mjs` — 34/34
- `node --test tests/campaign-mock.test.mjs tests/line-login.test.mjs tests/oa-live-connect.test.mjs tests/live-push-payload.test.mjs` — 20/20
- `node --test tests/multitenant-login.test.mjs tests/tenant-admin-api.test.mjs tests/multitenant-foundation.integration.test.mjs` — 11 passed, 1 skipped
- `tests/tenant-admin.ui.test.mjs` — workspace browser flow passed
- `tests/integration.test.mjs` signs staging webhooks with `STAGING_WEBHOOK_SECRET` (the OA vault secret) and skips that case unless `STAGING_WEBHOOK_SECRET` and `LINE_CREDENTIAL_ENCRYPTION_KEY` are set
- `tests/line-login-postgres.integration.test.mjs` — migration shape passed; database suite skipped
- `tests/referral-postgres.integration.test.mjs` — skipped without `REFERRAL_TEST_DATABASE_URL`
- `tests/webhook-postgres.integration.test.mjs` — skipped without `WEBHOOK_TEST_DATABASE_URL`

The guarded webhook suite requires a fresh disposable loopback database named `line_ccc_webhook_qa_*`. It covers valid/invalid signatures, the wrong-OA secret, replay, malformed events, oversized bodies, follow/unfollow consent, kill-switch independence, `VERIFIED` transition, and the absence of environment fallback. It was not run here because no local PostgreSQL is available.

## Known limits

- Rate limits are in-process; multi-instance deployments need a shared limiter.
- The endpoint returns generic 400/401/503 errors and does not log payloads; operational monitoring still relies on the platform's request logs plus audit entries for verification and follows.
- `customers.line_user_key` remains the raw provider-scoped ID because Phase 5D delivery needs it; attribution and login identity tables remain HMAC-only.
- Rejected signatures are not written to `audit_log` to avoid an unauthenticated audit-filling vector.
- No migration was applied, no live LINE call was made, and nothing was deployed.
