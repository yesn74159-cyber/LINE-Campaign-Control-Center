export type ProviderStatus = 400 | 401 | 403 | 409 | 429 | 500 | 502 | 503 | 504;

export type PolicySnapshot = {
  appMode: string;
  systemKillSwitch: boolean;
  oaKillSwitch: boolean;
  campaignKillSwitch: boolean;
  approvalStatus: 'DRAFT' | 'VALIDATED' | 'APPROVED';
  consentedRecipients: number;
  quotaRemaining: number;
  quotaPerMinute: number;
  requestedRecipients: number;
};

export class OaPolicyError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'OaPolicyError';
  }
}

export function validateDispatchPolicy(snapshot: PolicySnapshot, options: { allowLive?: boolean } = {}) {
  if (options.allowLive ? snapshot.appMode !== 'LIVE' : snapshot.appMode !== 'DRY_RUN') throw new OaPolicyError('LIVE_MODE_LOCKED', 'LINE live mode is disabled outside an approved rollout');
  if (snapshot.systemKillSwitch || snapshot.oaKillSwitch || snapshot.campaignKillSwitch) throw new OaPolicyError('KILL_SWITCH_ACTIVE', 'LINE delivery is blocked by an emergency kill switch');
  if (snapshot.approvalStatus !== 'APPROVED') throw new OaPolicyError('APPROVAL_REQUIRED', 'Campaign must be validated and approved before scheduling');
  if (snapshot.requestedRecipients > snapshot.consentedRecipients) throw new OaPolicyError('CONSENT_REQUIRED', 'Target audience contains recipients without active consent');
  if (snapshot.requestedRecipients > snapshot.quotaRemaining) throw new OaPolicyError('QUOTA_EXCEEDED', 'Requested audience exceeds the remaining OA quota');
  if (snapshot.requestedRecipients > snapshot.quotaPerMinute) throw new OaPolicyError('RATE_LIMITED', 'Requested audience exceeds the staging OA rate limit', true);
  return { allowed: true as const, outbound: Boolean(options.allowLive), dryRun: !options.allowLive };
}

export function classifyProviderError(status: number): { code: string; retryable: boolean; retryAfterMs?: number } {
  if (status === 400) return { code: 'PROVIDER_BAD_REQUEST', retryable: false };
  if (status === 401) return { code: 'PROVIDER_UNAUTHORIZED', retryable: false };
  if (status === 403) return { code: 'PROVIDER_FORBIDDEN', retryable: false };
  if (status === 409) return { code: 'PROVIDER_RETRY_KEY_ACCEPTED', retryable: false };
  if (status === 429) return { code: 'PROVIDER_RATE_LIMITED', retryable: true, retryAfterMs: 60_000 };
  if (status >= 500 && status <= 599) return { code: 'PROVIDER_SERVER_ERROR', retryable: true };
  return { code: 'PROVIDER_UNKNOWN_ERROR', retryable: false };
}

export function retryDelayMs(attempt: number, baseMs = 1000, retryAfterMs?: number) {
  if (retryAfterMs !== undefined) return Math.max(retryAfterMs, baseMs);
  return Math.min(baseMs * (2 ** Math.max(0, attempt - 1)), 15 * 60_000);
}
