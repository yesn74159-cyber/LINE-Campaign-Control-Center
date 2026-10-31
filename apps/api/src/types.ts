export type DeliveryMode = 'DRY_RUN' | 'LIVE';
export type JobStatus = 'DRAFT' | 'SCHEDULED' | 'PAUSED' | 'CLAIMED' | 'SENDING' | 'RETRYABLE' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'QUEUED' | 'CANCELED' | 'FAILED_FINAL';
export type AdminRole = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer';
export type AccountTokenPurpose = 'INVITE' | 'RESET';
export type OaConnectionStatus = 'NOT_CONFIGURED' | 'DRY_RUN_READY' | 'VALIDATION_FAILED' | 'LIVE_LOCKED';
export type CredentialStatus = 'NOT_CONFIGURED' | 'REFERENCE_CONFIGURED' | 'VALIDATION_FAILED';
export type CampaignApprovalStatus = 'DRAFT' | 'VALIDATED' | 'APPROVED';
export type OutboxDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'RETRYABLE' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';

export interface Campaign {
  id: string;
  name: string;
  title: string;
  description: string;
  image: string;
  cta: string;
  flexFile: string;
  active: boolean;
  latestRevision?: number;
  flexJson?: Record<string, unknown>;
}

export interface AdminUser {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: AdminRole;
}

export interface Customer {
  id: string;
  providerId: string;
  lineUserKey: string;
  displayName?: string;
  optIn: boolean;
  blockedAt?: string;
}

export interface OaIntegration {
  id: string;
  displayName: string;
  basicId: string;
  providerId: string;
  environment: 'STAGING' | 'PRODUCTION';
  enabled: boolean;
  secretConfigured: boolean;
  connectionStatus: OaConnectionStatus;
  credentialStatus: CredentialStatus;
  quotaPerMinute: number;
  killSwitch: boolean;
  killSwitchReason?: string;
}

export interface CampaignReadiness {
  campaignId: string;
  approvalStatus: CampaignApprovalStatus;
  approvedBy?: string;
  validatedAt?: string;
  approvedAt?: string;
  systemKillSwitch: boolean;
  oaKillSwitch: boolean;
  campaignKillSwitch: boolean;
  quota: { limitPerMinute: number; usedInWindow: number; remaining: number };
  audience: { eligible: number; optedOut: number; blocked: number };
  canSchedule: boolean;
  blockers: string[];
}

export interface SchedulerJob {
  id: string;
  workspaceId?: string;
  campaignId: string;
  campaignRevisionId?: string;
  oaId: string;
  scheduledAt: string;
  timeZone: string;
  availableAt?: string;
  mode: DeliveryMode;
  status: JobStatus;
  attempts: number;
  idempotencyKey: string;
  lastError?: string;
  createdAt: string;
}

export interface DeliveryContext {
  jobId: string;
  workspaceId: string;
  oaId: string;
  campaignRevisionId: string;
  recipientKey: string;
  flexJson: Record<string, unknown>;
}

export interface QuotaReservation {
  windowStartedAt: string | null;
  counted: boolean;
}

export interface OutboxDelivery {
  id: string;
  workspaceId: string;
  jobId: string;
  oaId: string;
  recipientKey: string;
  idempotencyKey: string;
  lineRetryKey: string;
  status: OutboxDeliveryStatus;
  attempts: number;
  providerStatus?: number;
  providerRequestId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  actor: string;
  target: string;
  detail: string;
  createdAt: string;
}

export interface CampaignRevision {
  id: string;
  campaignId: string;
  revision: number;
  flexJson: Record<string, unknown>;
  state: string;
  createdBy: string;
  createdAt: string;
}
