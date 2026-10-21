import type { OutboxDelivery, SchedulerJob } from './types.js';
import { OaPolicyError, type PolicySnapshot, validateDispatchPolicy, classifyProviderError } from './oaPolicy.js';

export type TransportRequest = { endpoint: string; token: string; retryKey: string; body: Record<string, unknown> };
export type TransportResponse = { status: number; requestId?: string; retryAfterMs?: number; body?: unknown };

export interface MessagingTransport {
  readonly kind: 'mock' | 'http';
  send(input: TransportRequest): Promise<TransportResponse>;
}

export class MockTransport implements MessagingTransport {
  readonly kind = 'mock' as const;
  readonly requests: TransportRequest[] = [];
  constructor(private readonly response: TransportResponse = { status: 200, requestId: 'mock-request' }) {}
  async send(input: TransportRequest) { this.requests.push({ ...input, body: { ...input.body } }); return this.response; }
}

type FetchResponse = { status: number; headers: { get(name: string): string | null }; text(): Promise<string> };
type FetchImplementation = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<FetchResponse>;

export class HttpTransport implements MessagingTransport {
  readonly kind = 'http' as const;
  constructor(private readonly fetchImplementation: FetchImplementation = fetch as unknown as FetchImplementation) {}
  async send(input: TransportRequest): Promise<TransportResponse> {
    const response = await this.fetchImplementation(input.endpoint, { method: 'POST', headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json', 'x-line-retry-key': input.retryKey }, body: JSON.stringify(input.body) });
    const requestId = response.headers.get('x-line-request-id') || undefined;
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : undefined;
    const text = await response.text(); let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    return { status: response.status, requestId, retryAfterMs, body };
  }
}

export class ProviderTransportError extends Error {
  constructor(public readonly status: number, public readonly retryable: boolean, public readonly uncertain: boolean, message: string, public readonly requestId?: string, public readonly retryAfterMs?: number) {
    super(message); this.name = 'ProviderTransportError';
  }
}

export type MessagingResult = { dryRun: boolean; outbound: boolean; idempotencyKey: string; providerStatus?: number; providerRequestId?: string };
export type CredentialResolver = (oaId: string) => Promise<string | null>;

export interface MessagingAdapter {
  readonly kind: 'mock' | 'live';
  send(input: { job: SchedulerJob; policy?: PolicySnapshot; delivery?: OutboxDelivery }): Promise<MessagingResult>;
}

function assertProviderResponse(response: TransportResponse) {
  if (response.status >= 200 && response.status < 300) return response;
  const classification = classifyProviderError(response.status);
  const uncertain = response.status >= 500 || response.status === 429;
  throw new ProviderTransportError(response.status, classification.retryable, uncertain, classification.code, response.requestId, response.retryAfterMs || classification.retryAfterMs);
}

export class MockLineMessagingAdapter implements MessagingAdapter {
  readonly kind = 'mock' as const;
  readonly transport: MockTransport;
  constructor(transport = new MockTransport()) { this.transport = transport; }
  async send({ job, policy, delivery }: { job: SchedulerJob; policy?: PolicySnapshot; delivery?: OutboxDelivery }): Promise<MessagingResult> {
    if (job.mode !== 'DRY_RUN') throw new OaPolicyError('LIVE_MODE_LOCKED', 'LINE live adapter is locked in staging');
    if (policy) validateDispatchPolicy(policy);
    const retryKey = delivery?.lineRetryKey || job.idempotencyKey;
    const response = await this.transport.send({ endpoint: 'mock://line-messaging', token: '', retryKey, body: { jobId: job.id, campaignId: job.campaignId, oaId: job.oaId } });
    assertProviderResponse(response);
    return { dryRun: true, outbound: false, idempotencyKey: retryKey, providerStatus: response.status, providerRequestId: response.requestId };
  }
}

export class LiveLineMessagingAdapter implements MessagingAdapter {
  readonly kind = 'live' as const;
  constructor(private readonly transport: MessagingTransport, private readonly resolveCredential: CredentialResolver, private readonly endpoint = 'https://api.line.me/v2/bot/message/push') {
    if (process.env.APP_MODE === 'DRY_RUN' || process.env.LINE_LIVE_ENABLED !== 'true') throw new OaPolicyError('LIVE_MODE_LOCKED', 'Live LINE adapter is disabled by default');
    if (transport.kind !== 'http') throw new OaPolicyError('HTTP_TRANSPORT_REQUIRED', 'Live adapter requires HttpTransport');
  }
  async send({ job, policy, delivery }: { job: SchedulerJob; policy?: PolicySnapshot; delivery?: OutboxDelivery }): Promise<MessagingResult> {
    if (job.mode !== 'LIVE') throw new OaPolicyError('DRY_RUN_ONLY', 'Live adapter cannot process a DRY_RUN job');
    if (policy) validateDispatchPolicy({ ...policy, appMode: 'LIVE' }, { allowLive: true });
    const token = await this.resolveCredential(job.oaId);
    if (!token) throw new OaPolicyError('CREDENTIAL_REFERENCE_MISSING', 'Server-side OA credential reference is not configured');
    const retryKey = delivery?.lineRetryKey || job.idempotencyKey;
    const response = await this.transport.send({ endpoint: this.endpoint, token, retryKey, body: { to: [], messages: [] } });
    assertProviderResponse(response);
    return { dryRun: false, outbound: true, idempotencyKey: retryKey, providerStatus: response.status, providerRequestId: response.requestId };
  }
}
