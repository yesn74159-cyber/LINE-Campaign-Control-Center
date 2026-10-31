import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Repository } from './repository.js';
import { openOaSecret, vaultKey } from './lineOaConnect.js';
import { payloadHash, verifyLineSignature } from './webhook.js';
import { verifyReferralFollow } from './referralStore.js';
import { createFixedWindowLimiter } from './security.js';

export const MAX_WEBHOOK_BODY_BYTES = 100 * 1024;
export const MAX_WEBHOOK_EVENTS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export type ValidatedLineEvent = {
  webhookEventId: string;
  type: string;
  timestamp?: number;
  userId?: string;
};

export class LineWebhookError extends Error {
  constructor(message: string, readonly statusCode: 400 | 413 = 400) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLineWebhookBody(rawBody: string, body: unknown): ValidatedLineEvent[] {
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BODY_BYTES) throw new LineWebhookError('webhook payload is too large', 413);
  if (!isRecord(body) || !Array.isArray(body.events)) throw new LineWebhookError('invalid webhook body');
  if (body.events.length > MAX_WEBHOOK_EVENTS) throw new LineWebhookError('too many webhook events');
  return body.events.map((raw) => {
    if (!isRecord(raw)) throw new LineWebhookError('invalid webhook event');
    const webhookEventId = raw.webhookEventId;
    const type = raw.type;
    if (typeof webhookEventId !== 'string' || !EVENT_ID_PATTERN.test(webhookEventId)) throw new LineWebhookError('invalid webhook event id');
    if (typeof type !== 'string' || !EVENT_TYPE_PATTERN.test(type)) throw new LineWebhookError('invalid webhook event type');
    if (raw.timestamp !== undefined && (typeof raw.timestamp !== 'number' || !Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0)) {
      throw new LineWebhookError('invalid webhook event timestamp');
    }
    let userId: string | undefined;
    if (raw.source !== undefined) {
      if (!isRecord(raw.source)) throw new LineWebhookError('invalid webhook event source');
      if (raw.source.userId !== undefined) {
        if (typeof raw.source.userId !== 'string' || !SOURCE_ID_PATTERN.test(raw.source.userId)) throw new LineWebhookError('invalid webhook event source');
        userId = raw.source.userId;
      }
    }
    if ((type === 'follow' || type === 'unfollow') && !userId) throw new LineWebhookError('webhook follow event is missing a source');
    const event: ValidatedLineEvent = { webhookEventId, type };
    if (typeof raw.timestamp === 'number') event.timestamp = raw.timestamp;
    if (userId) event.userId = userId;
    return event;
  });
}

export async function resolveOaWebhookSecret(pool: Pool, oaId: string, key: Buffer): Promise<{ workspaceId: string; secret: string | null } | null> {
  if (!UUID_PATTERN.test(oaId)) return null;
  const result = await pool.query<{ workspace_id: string; secret_sealed: string | null }>(
    'select oa.workspace_id, v.secret_sealed from oa_integrations oa ' +
    'left join oa_credential_vault v on v.workspace_id=oa.workspace_id and v.oa_integration_id=oa.id ' +
    "where oa.id=$1 and oa.environment='STAGING'",
    [oaId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const workspaceId = String(row.workspace_id);
  if (!row.secret_sealed) return { workspaceId, secret: null };
  return { workspaceId, secret: openOaSecret(row.secret_sealed, workspaceId, oaId, 'secret', key) };
}

export async function markOaChannelVerified(pool: Pool, input: { workspaceId: string; oaId: string }): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const updated = await client.query(
      "update workspace_oa_channels set status='VERIFIED', verified_at=now() " +
      "where workspace_id=$1 and oa_integration_id=$2 and status in ('NOT_CONFIGURED','VERIFY_PENDING') " +
      'and messaging_channel_id is not null and line_provider_id is not null returning id',
      [input.workspaceId, input.oaId]
    );
    if (updated.rowCount) {
      await client.query(
        "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,'line-webhook','OA_CHANNEL_VERIFIED','oa',$2,$3::jsonb)",
        [input.workspaceId, input.oaId, JSON.stringify({ via: 'signed_webhook' })]
      );
    }
    await client.query('commit');
    return Boolean(updated.rowCount);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function registerLineWebhookRoutes(app: FastifyInstance, options: {
  repo: Pick<Repository, 'acceptWebhook'>;
  pool: Pool | null;
  enabled: boolean;
  fallbackChannelSecret?: string;
  identityHashKey?: string;
}) {
  const ipLimiter = createFixedWindowLimiter(600, 60_000);
  const oaLimiter = createFixedWindowLimiter(3000, 60_000);

  app.post<{ Params: { oaId: string }; Body: unknown }>(
    '/api/webhooks/line/:oaId',
    { schema: { params: { type: 'object', required: ['oaId'], properties: { oaId: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' } } } } },
    async (request, reply) => {
      if (!options.enabled) return reply.code(503).send({ error: 'staging webhook is disabled' });
      const oaId = request.params.oaId;
      if (!ipLimiter.take(request.ip) || !oaLimiter.take(oaId)) {
        reply.header('retry-after', '60');
        return reply.code(429).send({ error: 'too many webhook requests' });
      }
      const rawBody = (request as typeof request & { raw: { rawBody?: string } }).raw.rawBody || JSON.stringify(request.body ?? {});
      const signatureHeader = request.headers['x-line-signature'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

      let channelSecret = options.fallbackChannelSecret;
      let workspaceId: string | undefined;
      if (options.pool) {
        let key: Buffer;
        try { key = vaultKey(); }
        catch { return reply.code(503).send({ error: 'webhook verification is not configured' }); }
        let resolved: { workspaceId: string; secret: string | null } | null;
        try { resolved = await resolveOaWebhookSecret(options.pool, oaId, key); }
        catch { return reply.code(503).send({ error: 'webhook secret is not configured' }); }
        if (!resolved) return reply.code(404).send({ error: 'staging OA not found' });
        if (!resolved.secret) return reply.code(503).send({ error: 'webhook secret is not configured' });
        channelSecret = resolved.secret;
        workspaceId = resolved.workspaceId;
      }

      if (!verifyLineSignature(rawBody, signature, channelSecret)) return reply.code(401).send({ error: 'invalid LINE signature' });

      let events: ValidatedLineEvent[];
      try { events = parseLineWebhookBody(rawBody, request.body); }
      catch (error) {
        if (error instanceof LineWebhookError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }

      const batchHash = payloadHash(rawBody);
      const identityHashKey = options.identityHashKey || '';
      let duplicates = 0;
      try {
        for (const event of events) {
          const result = await options.repo.acceptWebhook({
            oaId,
            eventId: event.webhookEventId,
            payloadHash: batchHash,
            eventType: event.type,
            lineUserKey: event.type === 'follow' || event.type === 'unfollow' ? event.userId : undefined
          });
          if (result.duplicate) duplicates += 1;
          if (options.pool && workspaceId && identityHashKey.length >= 32 && event.type === 'follow' && event.userId) {
            const followerSubjectHmac = createHmac('sha256', identityHashKey).update(event.userId, 'utf8').digest('hex');
            const occurredAt = event.timestamp === undefined ? undefined : new Date(event.timestamp);
            await verifyReferralFollow(options.pool, {
              oaId,
              eventId: event.webhookEventId,
              followerSubjectHmac,
              evidenceRef: `line-webhook:${event.webhookEventId}`,
              occurredAt
            });
          }
        }
        if (events.length > 0 && options.pool && workspaceId) await markOaChannelVerified(options.pool, { workspaceId, oaId });
      } catch {
        return reply.code(500).send({ error: 'webhook processing failed' });
      }
      return { accepted: true, eventCount: events.length, duplicates };
    }
  );
}
