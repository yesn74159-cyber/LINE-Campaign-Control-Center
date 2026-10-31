# Phase 5D — Per-Recipient Delivery Pipeline and Outbox Ledger

Status: implemented locally, PostgreSQL integration validation pending.
Mode: `APP_MODE=DRY_RUN`, `LINE_LIVE_ENABLED=false`, `LINE_WEBHOOK_ENABLED=false` by default. Live sending is deliberately not enabled.

## Goal

Make DRY_RUN and LIVE run the same outbox pipeline. DRY_RUN uses the mock transport and does not consume quota; LIVE would decrypt the OA token, reserve quota, and push one message per consented recipient. The worker no longer bypasses per-recipient deliveries.

## Adapter selection

`createMessagingAdapter({ pool })` in `apps/api/src/lineAdapter.ts` selects the transport from the runtime mode:

- `APP_MODE=DRY_RUN` → `MockLineMessagingAdapter` (in-memory `mock://line-messaging` transport, no network).
- `APP_MODE=LIVE` requires all of the following, otherwise it throws `OaPolicyError`:
  - `LINE_LIVE_ENABLED=true`
  - a PostgreSQL pool (`DATABASE_REQUIRED`)
  - a valid 32-byte `LINE_CREDENTIAL_ENCRYPTION_KEY`
  - the `LiveLineMessagingAdapter` built on `HttpTransport` (`https://api.line.me/v2/bot/message/push`)
- Any other `APP_MODE` throws `LIVE_MODE_LOCKED`.

`startWorker` accepts only `DRY_RUN` or `LIVE`, and requires `PERSISTENCE=postgres`. `.env.example` keeps `LINE_LIVE_ENABLED=false` with a note that turning it on needs APP_MODE, the flag, and the vault key together.

## Worker pipeline

`runWorkerOnce` in `apps/api/src/worker.ts`:

1. `recoverStaleJobs` releases claims older than the 60s lease and returns their outbox rows to `RETRYABLE`.
2. `claimDueJob` claims one due job (`SCHEDULED`, `RETRYABLE`, `QUEUED`) with `for update skip locked`, incrementing attempts.
3. `getCampaignReadiness` validates approval, kill switches, OA state, consent count, and quota; `validateDispatchPolicy` runs with `allowLive` only for LIVE jobs.
4. `markJobSending`, then `prepareOutbox` inserts one delivery per opted-in, unblocked customer scoped to the job's OA provider. Duplicate recipients are deduplicated by `(scheduler_job_id, recipient_key)`; when no eligible recipient exists it inserts a single `__campaign__` preview row.
5. For every delivery not already `SENT`:
   - re-read readiness (kill switch / approval / quota) immediately before the send;
   - `getDeliveryContext` loads the frozen `scheduler_jobs.campaign_revision_id` row, so later campaign edits do not change the payload;
   - `buildDeliveryPayload` produces the exact transport body (or throws `PAYLOAD_INVALID` before `markOutboxSending`);
   - `markOutboxSending`, then `reserveDeliverySlot` with `count: job.mode === 'LIVE'`;
   - `adapter.send`; on success `markOutboxCompleted` with provider status and request ID.
6. On failure the slot is released unless the error is a `ProviderTransportError` marked `uncertain`. The job becomes `RETRYABLE` with a delay or `FAILED`; the delivery becomes `RETRYABLE`, `FAILED`, or `UNKNOWN` (see below). `markJobCompleted` closes the job with `WORKER_COMPLETED`.

The outbox `line_retry_key` (generated once per delivery) is sent as `X-Line-Retry-Key`, so a retry is idempotent at the provider.

## Access-token handling

`resolveOaAccessToken(pool, { workspaceId, oaId, key })` in `apps/api/src/lineOaConnect.ts`:

- queries `oa_credential_vault` joined to `oa_integrations` on both `workspace_id` and OA ID, restricted to `environment='STAGING'`;
- requires valid UUIDs and returns `null` when no sealed token exists (`CREDENTIAL_REFERENCE_MISSING`);
- decrypts AES-256-GCM with AAD `lineccc:v1:<workspaceId>:<oaId>:token`;
- returns a `Buffer` that the live adapter zeroizes with `tokenBuffer.fill(0)` in a `finally` block.

The vault key comes only from the process environment. Tokens are never cached, logged, or placed in API responses; they exist only in the authorization header of the outbound request.

## Payload

`buildDeliveryPayload` in `apps/api/src/livePushPayload.ts` is shared by both adapters:

- `__campaign__` → `{ preview: true, messages: [flex] }`; the live adapter rejects preview payloads.
- A real recipient → `buildLivePushBody`, which requires an OA-scoped LINE userId matching `^U[0-9a-f]{32}$` and a non-empty `altText`, then returns `{ to, messages: [structuredClone(flex)] }`.
- The Flex JSON is validated by `assertFlexJson` and cloned so an approved revision cannot be mutated.

## Quota and rate limits

`reserveDeliverySlot` in `apps/api/src/repository.ts` runs in one transaction:

1. `select ... from oa_integrations where id=$1 and workspace_id=$2 and environment='STAGING' and enabled for update` — serializes concurrent reservations for the same OA.
2. Reads `oa_rate_limit_windows` for the current minute and rejects with retryable `RATE_LIMITED` when `used_count >= quota_per_minute`.
3. Rejects with `QUOTA_EXCEEDED` when `monthly_quota > 0` and `monthly_used >= monthly_quota`.
4. Only when `count` is true (LIVE) increments the minute window and `monthly_used` in the same transaction.
5. `releaseDeliverySlot` decrements both with `greatest(..., 0)` when a send fails without uncertainty.

DRY_RUN still calls `reserveDeliverySlot` with `count=false`, so it enforces availability and quota state without consuming quota. Readiness exposes `quota.limitPerMinute`, `quota.usedInWindow`, and `quota.remaining`.

## Retry and uncertainty

`assertProviderResponse` classifies non-2xx responses:

- `400/401/403/409` → non-retryable, certain.
- `429` and `5xx` → classified retryable but marked `uncertain: true`, because LINE may have accepted the push.

Uncertain responses make the outbox `UNKNOWN` and the job `FAILED`; the pipeline never auto-retries them, because a duplicate push is worse than a missed one. Certain retryable failures (synthetic transport errors or `RATE_LIMITED`) schedule `RETRYABLE` with the provider `retry-after` or exponential backoff, up to 3 attempts.

An operator resolves `UNKNOWN` through:

- `GET /api/scheduler/jobs/:id/outbox` — workspace-scoped delivery list (read).
- `POST /api/scheduler/jobs/:id/outbox/:deliveryId/reconcile` with `{ status: 'SENT' | 'FAILED' }` — write role, only rows still `UNKNOWN`, writes `OUTBOX_RECONCILED` to the audit log.

## Kill switches

Campaign readiness (system, campaign, and OA kill switches, approval, consent, quota) is re-read before every recipient. If it stops passing mid-run, the current recipient fails with `CAMPAIGN_NOT_READY`, the job becomes `FAILED`, and remaining deliveries stay `PENDING` — no further send happens in that run. The webhook consent path is unaffected and keeps processing opt-outs.

## DRY_RUN parity

`POST /api/scheduler/jobs/:id/dry-run` queues the job through `runDryRun` and immediately calls `runWorkerOnce` with the mock adapter and `maxAttempts: 1`. The mock path therefore exercises outbox preparation, per-delivery context, payload building, status transitions, and audit entries. A DRY_RUN job ends `COMPLETED` with a `SENT` delivery (`__campaign__` preview, provider status 200, `mock-request`) and writes both `DRY_RUN_ENQUEUED` and `WORKER_COMPLETED`.

## Admin UI

`SchedulerView` now shows automation history, a job selector, and the `DeliveryLedger` component (`apps/admin/src/DeliveryLedger.tsx`):

- per-recipient status, attempts, provider status/request ID, last error, and update time;
- `__campaign__` is displayed as `PREVIEW · no recipient`; other keys are masked;
- writes `x-csrf-token` from the `ccc_csrf` cookie for reconcile;
- `ยืนยันว่าส่งแล้ว` / `ทำเครื่องหมายล้มเหลว` appear only for `UNKNOWN` rows and write-capable roles;
- the ledger remounts on job status/attempt change, so a Run refreshes it without a manual reload.

## Migration

No new migration. The phase reuses `outbox_deliveries` and `scheduler_jobs` (005/006) plus the existing quota tables. Migration `012_account_invites.sql` from Phase 5A remains unapplied.

## Verification performed

- `npm run typecheck`
- `npm run build` (Admin Vite + API `tsc`)
- `node --test tests/phase5d.test.mjs` — 13/13
- Regression: `core`, `phase1`, `security`, `phase5a`, `phase5b`, `phase5c`, `campaign-mock`, `line-login`, `oa-live-connect`, `live-push-payload`, `multitenant-login`, `tenant-admin-api`
- `tests/delivery-postgres.integration.test.mjs` — skipped without `DELIVERY_TEST_DATABASE_URL`; the guarded suite covers frozen revisions, three-recipient delivery, uncertain UNKNOWN + reconcile scoping, retry sending only pending rows, concurrent quota reservation, release clamping, and the live adapter with a fake HTTP transport.
- Browser check in memory mode: login → Scheduler → schedule → Run → job `COMPLETED`; ledger shows `PREVIEW · no recipient`, `SENT`, attempts 1, `200 · mock-request` without a reload.
- No live LINE call, no secret printed, no migration applied, nothing committed or deployed.

## Known limits

- The worker still processes one job per poll; concurrency is bounded by `for update skip locked`, not by parallel senders.
- Recovery is lease-based. A crash after the provider accepts a push but before `markOutboxCompleted` leaves the delivery `UNKNOWN` and requires manual reconciliation.
- Per-minute quota uses the database minute window, not LINE's own response headers; provider-side throttling still surfaces as 429/UNKNOWN.
- The ledger shows one job at a time and is not real-time; it refreshes on remount or the Refresh button.
- LIVE remains disabled in this phase; enabling it needs an explicit decision, `LINE_LIVE_ENABLED=true`, a populated vault, and an approved live test plan.
