import campaignsManifest from '../../../../campaigns.json';

export type Section = 'dashboard' | 'push' | 'scheduler' | 'flex' | 'customers' | 'referrals' | 'links' | 'oas' | 'workspace' | 'audit';
export type Job = { id: string; campaignId: string; oaId: string; scheduledAt: string; timeZone: string; mode: string; status: string; attempts: number; idempotencyKey: string; lastError?: string };
export type JobAction = 'schedule' | 'pause' | 'resume' | 'cancel' | 'retry' | 'dry-run';
export type ScheduleInput = { campaignId: string; oaId: string; scheduledAt: string; timeZone: string; status: 'DRAFT' | 'SCHEDULED'; mode?: 'DRY_RUN' | 'LIVE'; confirm?: string };
export type Dashboard = { mode: string; persistence?: string; appMode?: string; liveSendEnabled?: boolean; counts: Record<string, number>; nextJob: Job | null };
export type Oa = { id: string; displayName: string; basicId: string; providerId: string; environment: string; enabled: boolean; secretConfigured: boolean; connectionStatus: string; credentialStatus: string; quotaPerMinute: number; monthlyQuota?: number; monthlyUsed?: number; killSwitch: boolean; killSwitchReason?: string };
export type Readiness = { campaignId: string; approvalStatus: string; systemKillSwitch: boolean; oaKillSwitch: boolean; campaignKillSwitch: boolean; quota: { limitPerMinute: number; usedInWindow: number; remaining: number }; audience: { eligible: number; optedOut: number; blocked: number }; canSchedule: boolean; blockers: string[] };
export type Customer = { id: string; providerId: string; lineUserKey: string; displayName?: string; optIn: boolean; blockedAt?: string; optOutAt?: string; optOutSource?: string };
export type Campaign = typeof campaignsManifest.campaigns[number] & { latestRevision?: number; flexJson?: Record<string, unknown>; killSwitch?: boolean };
export type User = { id: string; email: string; displayName: string; role: string };
export type PushSeed = { flex: Record<string, unknown> };
