import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDatabase } from './db.js';
import { createPostgresRepository } from './repository.js';
import { createMessagingAdapter, ProviderTransportError, type MessagingAdapter } from './lineAdapter.js';
import { OaPolicyError, validateDispatchPolicy } from './oaPolicy.js';
import { buildDeliveryPayload } from './livePushPayload.js';
import type { QuotaReservation } from './types.js';
import type { Repository } from './repository.js';

export async function runWorkerOnce(repository: Repository, adapter: MessagingAdapter, options: { workerId?: string; jobId?: string; now?: Date; leaseMs?: number; maxAttempts?: number; retryBaseMs?: number } = {}) {
  const now = options.now || new Date();
  const workerId = options.workerId || `worker-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 250;
  await repository.recoverStaleJobs(new Date(now.getTime() - leaseMs), now);
  const job = await repository.claimDueJob(workerId, now, options.jobId);
  if (!job) return { status: 'idle' as const, workerId };
  let activeOutboxId: string | undefined;
  let slot: QuotaReservation | null = null;
  try {
    const readDispatchPolicy = async () => {
      const readiness = job.workspaceId ? await repository.getCampaignReadiness(job.campaignId, job.workspaceId, job.oaId) : null;
      if (readiness && !readiness.canSchedule) throw new OaPolicyError('CAMPAIGN_NOT_READY', readiness.blockers.join('; ') || 'campaign is not ready for delivery');
      const policy = readiness ? { appMode: job.mode, systemKillSwitch: readiness.systemKillSwitch, oaKillSwitch: readiness.oaKillSwitch, campaignKillSwitch: readiness.campaignKillSwitch, approvalStatus: readiness.approvalStatus, consentedRecipients: readiness.audience.eligible, quotaRemaining: readiness.quota.remaining, quotaPerMinute: readiness.quota.limitPerMinute, requestedRecipients: readiness.audience.eligible } : undefined;
      if (policy) validateDispatchPolicy(policy, { allowLive: job.mode === 'LIVE' });
      return policy;
    };
    await readDispatchPolicy();
    await repository.markJobSending(job.id, workerId);
    const deliveries = await repository.prepareOutbox(job.id, workerId);
    for (const delivery of deliveries) {
      if (delivery.status === 'SENT') continue;
      if (!job.workspaceId) throw new Error('scheduler job is missing a workspace');
      // Kill switches and approval are re-read for every recipient.
      const policy = await readDispatchPolicy();
      const context = await repository.getDeliveryContext(delivery.id, job.workspaceId);
      let payload;
      try { payload = buildDeliveryPayload({ recipientKey: context.recipientKey, flexMessage: context.flexJson }); }
      catch (error) { throw new OaPolicyError('PAYLOAD_INVALID', error instanceof Error ? error.message : 'delivery payload is invalid'); }
      activeOutboxId = delivery.id;
      await repository.markOutboxSending(delivery.id, workerId);
      slot = await repository.reserveDeliverySlot({ workspaceId: job.workspaceId, oaId: job.oaId, count: job.mode === 'LIVE', now });
      try {
        const result = await adapter.send({ job, policy, delivery, payload });
        await repository.markOutboxCompleted(delivery.id, workerId, result);
      } catch (error) {
        if (!(error instanceof ProviderTransportError && error.uncertain)) {
          await repository.releaseDeliverySlot({ workspaceId: job.workspaceId, oaId: job.oaId, windowStartedAt: slot.windowStartedAt }).catch(() => undefined);
        }
        slot = null;
        throw error;
      }
      slot = null;
      activeOutboxId = undefined;
    }
    const completed = await repository.markJobCompleted(job.id, workerId);
    return { status: 'completed' as const, workerId, job: completed };
  } catch (error) {
    const providerError = error instanceof ProviderTransportError ? error : undefined;
    const policyError = error instanceof OaPolicyError ? error : undefined;
    const rateLimited = policyError?.code === 'RATE_LIMITED';
    const retryable = Boolean((providerError?.retryable && !providerError.uncertain) || rateLimited);
    const retryDelayMs = providerError?.retryAfterMs ?? (rateLimited ? 60_000 : retryBaseMs * (2 ** Math.max(0, job.attempts - 1)));
    const retryAt = retryable && job.attempts < maxAttempts
      ? new Date(now.getTime() + retryDelayMs)
      : (!providerError && !policyError && job.attempts < maxAttempts ? new Date(now.getTime() + retryBaseMs * (2 ** Math.max(0, job.attempts - 1))) : null);
    const errorMessage = error instanceof Error ? error.message : 'worker send failed';
    if (activeOutboxId) await repository.markOutboxFailure(activeOutboxId, workerId, errorMessage, providerError?.uncertain ? 'UNKNOWN' : retryAt ? 'RETRYABLE' : 'FAILED', { providerStatus: providerError?.status, providerRequestId: providerError?.requestId });
    const failed = await repository.markJobFailure(job.id, workerId, errorMessage, retryAt);
    return { status: retryAt ? 'retryable' as const : 'failed' as const, workerId, job: failed };
  }
}

export async function startWorker() {
  const mode = (process.env.APP_MODE || 'DRY_RUN').trim().toUpperCase();
  if (mode !== 'DRY_RUN' && mode !== 'LIVE') throw new Error('worker requires APP_MODE=DRY_RUN or APP_MODE=LIVE');
  if (process.env.PERSISTENCE !== 'postgres') throw new Error('worker requires PERSISTENCE=postgres');
  const database = createDatabase();
  if (!database.pool) throw new Error('worker requires DATABASE_URL');
  const repository = createPostgresRepository(database.pool);
  const adapter = createMessagingAdapter({ pool: database.pool });
  const once = process.argv.includes('--once');
  const pollMs = Number(process.env.WORKER_POLL_MS || 1000);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      await runWorkerOnce(repository, adapter);
      if (!once && !stopped) await new Promise((resolve) => setTimeout(resolve, pollMs));
    } while (!once && !stopped);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startWorker().catch((error) => { console.error(error); process.exit(1); });
