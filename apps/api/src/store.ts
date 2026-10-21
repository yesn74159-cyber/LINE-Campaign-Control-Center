import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AuditEvent, Campaign, OaIntegration, SchedulerJob } from './types.js';

interface Manifest { campaigns: Campaign[] }

function readManifest(): Manifest {
  const manifestPath = path.resolve(process.cwd(), 'campaigns.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  return { campaigns: manifest.campaigns };
}

export function createStore() {
  const now = new Date();
  const campaigns = readManifest().campaigns;
  const oas: OaIntegration[] = [
    { id: 'oa-staging-primary', displayName: 'LINE OA หลัก (Staging)', basicId: '@453yfyvc', providerId: 'staging-provider', environment: 'STAGING', enabled: true, secretConfigured: false, connectionStatus: 'DRY_RUN_READY', credentialStatus: 'NOT_CONFIGURED', quotaPerMinute: 60, killSwitch: false },
    { id: 'oa-staging-secondary', displayName: 'LINE OA สำรอง (Mock)', basicId: '@mock-campaign', providerId: 'mock-provider', environment: 'STAGING', enabled: false, secretConfigured: false, connectionStatus: 'NOT_CONFIGURED', credentialStatus: 'NOT_CONFIGURED', quotaPerMinute: 60, killSwitch: false }
  ];
  const jobs: SchedulerJob[] = [
    { id: 'job-demo-1', campaignId: 'welcome', oaId: oas[0].id, scheduledAt: new Date(now.getTime() + 75 * 60_000).toISOString(), timeZone: 'Asia/Bangkok', mode: 'DRY_RUN', status: 'SCHEDULED', attempts: 0, idempotencyKey: 'demo-welcome-20261020', createdAt: now.toISOString() },
    { id: 'job-demo-2', campaignId: 'gradient', oaId: oas[0].id, scheduledAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(), timeZone: 'Asia/Bangkok', mode: 'DRY_RUN', status: 'PAUSED', attempts: 0, idempotencyKey: 'demo-gradient-20261020', createdAt: now.toISOString() }
  ];
  const audit: AuditEvent[] = [
    { id: 'audit-bootstrap', action: 'BOOTSTRAP', actor: 'system', target: 'workspace', detail: 'Staging store initialized in DRY_RUN mode', createdAt: now.toISOString() }
  ];

  const addAudit = (action: string, target: string, detail: string) => {
    audit.unshift({ id: randomUUID(), action, actor: 'staging-admin', target, detail, createdAt: new Date().toISOString() });
  };

  return {
    campaigns,
    oas,
    jobs,
    audit,
    addJob(input: Pick<SchedulerJob, 'campaignId' | 'oaId' | 'scheduledAt'> & { mode?: 'DRY_RUN' }) {
      const campaign = campaigns.find((item) => item.id === input.campaignId && item.active);
      const oa = oas.find((item) => item.id === input.oaId && item.enabled);
      if (!campaign) throw new Error('campaignId is not an active staging campaign');
      if (!oa) throw new Error('oaId is not an enabled staging OA');
      const parsed = new Date(input.scheduledAt);
      if (Number.isNaN(parsed.valueOf())) throw new Error('scheduledAt must be a valid ISO date');
      const job: SchedulerJob = { id: randomUUID(), campaignId: campaign.id, oaId: oa.id, scheduledAt: parsed.toISOString(), timeZone: 'Asia/Bangkok', availableAt: parsed.toISOString(), mode: 'DRY_RUN', status: 'SCHEDULED', attempts: 0, idempotencyKey: randomUUID(), createdAt: new Date().toISOString() };
      jobs.unshift(job);
      addAudit('SCHEDULE_CREATED', job.id, `DRY_RUN job for ${campaign.id}`);
      return job;
    },
    pauseJob(id: string) {
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new Error('job not found');
      if (job.status === 'COMPLETED') throw new Error('completed job cannot be paused');
      job.status = 'PAUSED';
      addAudit('SCHEDULE_PAUSED', id, 'Job paused before any outbound send');
      return job;
    },
    retryJob(id: string) {
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new Error('job not found');
      if (job.status === 'COMPLETED') throw new Error('completed job cannot be retried');
      job.status = 'RETRYABLE';
      job.lastError = undefined;
      addAudit('SCHEDULE_RETRY', id, 'Retry queued with the same idempotency key');
      return job;
    },
    runDryRun(id: string) {
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new Error('job not found');
      if (job.mode !== 'DRY_RUN') throw new Error('LIVE mode is disabled in this build');
      if (job.status === 'PAUSED') throw new Error('paused job must be resumed before dry run');
      job.status = 'COMPLETED';
      job.attempts += 1;
      addAudit('DRY_RUN_EXECUTED', id, 'No LINE Messaging API request was made');
      return job;
    }
  };
}
