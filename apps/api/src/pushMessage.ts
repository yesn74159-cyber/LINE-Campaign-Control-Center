import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AdminUser, SchedulerJob } from './types.js';
import type { Repository } from './repository.js';
import { createFixedWindowLimiter } from './security.js';
import { buildManualFlexPushBody, buildManualTextPushBody, MANUAL_PUSH_TEXT_MAX_CHARS } from './livePushPayload.js';
import { HttpTransport, createMessagingAdapter, ProviderTransportError, type MessagingAdapter } from './lineAdapter.js';
import { OaPolicyError, isLiveSendEnabled } from './oaPolicy.js';
import { resolveOaAccessToken, vaultKey, checkLineProfile } from './lineOaConnect.js';

type Caller = FastifyRequest & { user?: AdminUser };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_TTL_MINUTES = 10;

type OaState = { id: string; display_name: string; provider_id: string; enabled: boolean; kill_switch: boolean; system_kill_switch: boolean };
type PreviewRow = {
  id: string; workspace_id: string; oa_integration_id: string; recipient_key: string;
  message_text: string; message_type: 'text' | 'flex'; flex_json: Record<string, unknown> | null;
  mode: 'DRY_RUN' | 'LIVE'; line_retry_key: string; expires_at: string;
};

/** The adapter body is rebuilt from the stored preview, never from the browser. */
function storedMessages(row: PreviewRow): Array<Record<string, unknown>> {
  if (row.message_type === 'flex') {
    if (!row.flex_json) throw new Error('the stored flex card is missing from this preview');
    return [row.flex_json];
  }
  return [{ type: 'text', text: row.message_text }];
}

function sendFailure(code: string, message: string) { return { code, message }; }

/**
 * Manual single-recipient push. The channel access token is never accepted from
 * the browser: it is unsealed from oa_credential_vault at send time, and the
 * buffer is zeroed by the live adapter. DRY_RUN records the request and returns
 * a mock receipt instead of calling LINE.
 */
export function registerPushMessageRoutes(
  app: FastifyInstance, pool: Pool | null, repo: Repository,
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => unknown,
  env: NodeJS.ProcessEnv = process.env,
  profileCheck: typeof checkLineProfile = checkLineProfile
) {
  const previewLimiter = createFixedWindowLimiter(20, 60 * 60 * 1000);
  const sendLimiter = createFixedWindowLimiter(5, 60 * 60 * 1000);

  async function authorize(request: FastifyRequest, reply: FastifyReply) {
    if (!pool) return reply.code(503).send({ error: 'PostgreSQL is required' });
    const auth = await requireUser(request, reply);
    if (auth) return auth;
    const user = (request as Caller).user;
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (user.role !== 'owner' && user.role !== 'admin') return reply.code(403).send({ error: 'owner or admin role required', code: 'ROLE_REQUIRED' });
    const membership = await pool.query(
      "select 1 from workspace_memberships where workspace_id=$1 and admin_user_id=$2 and status='ACTIVE'",
      [user.workspaceId, user.id]
    );
    if (!membership.rowCount) return reply.code(403).send({ error: 'inactive membership', code: 'MEMBERSHIP_INACTIVE' });
    if (request.method !== 'GET') return requireCsrf(request, reply);
    return undefined;
  }

  async function audit(user: AdminUser, action: string, targetId: string, detail: string) {
    await pool!.query(
      "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,$3,'manual_push',$4,$5::jsonb)",
      [user.workspaceId, user.email, action, targetId, JSON.stringify({ detail })]
    );
  }

  async function loadOaState(oaId: string, workspaceId: string): Promise<OaState | null> {
    const result = await pool!.query<OaState>(
      'select oa.id, oa.display_name, oa.provider_id, oa.enabled, oa.kill_switch, coalesce(wc.system_kill_switch,false) as system_kill_switch ' +
      'from oa_integrations oa left join workspace_controls wc on wc.workspace_id=oa.workspace_id ' +
      "where oa.id=$1 and oa.workspace_id=$2 and oa.environment='STAGING'",
      [oaId, workspaceId]
    );
    return result.rows[0] || null;
  }

  async function hasConsent(workspaceId: string, providerId: string, recipientKey: string) {
    const result = await pool!.query(
      'select 1 from customers where workspace_id=$1 and provider_id=$2 and line_user_key=$3 and opt_in=true and blocked_at is null',
      [workspaceId, providerId, recipientKey]
    );
    return Boolean(result.rowCount);
  }

  /**
   * The transport follows the mode stored on the request, never the host's
   * APP_MODE alone: a DRY_RUN request stays on the mock adapter even while the
   * server is LIVE, and only the release gate can produce a LIVE transport.
   */
  function selectAdapter(mode: 'DRY_RUN' | 'LIVE'): { adapter: MessagingAdapter; mode: 'DRY_RUN' | 'LIVE' } | { error: ReturnType<typeof sendFailure> } {
    if (mode === 'LIVE' && !isLiveSendEnabled(env)) return { error: sendFailure('LIVE_GATE_OFF', 'LIVE mode requires the explicit live release gate') };
    try {
      return { adapter: createMessagingAdapter({ pool, env, jobMode: mode }), mode };
    } catch (reason) {
      return { error: sendFailure(reason instanceof OaPolicyError ? reason.code : 'ADAPTER_UNAVAILABLE', reason instanceof Error ? reason.message : 'LINE transport is unavailable') };
    }
  }

  /**
   * A live push to a recipient LINE does not recognise is a silent no-op on
   * LINE's side, so the profile is checked before the preview is stored. The
   * unsealed token lives only in this scope and is zeroed afterwards.
   */
  async function checkLiveRecipient(oaId: string, workspaceId: string, recipientKey: string):
    Promise<{ name: string } | { error: { message: string; code: string; statusCode: number } }> {
    let tokenBuffer: Buffer | null;
    try {
      tokenBuffer = await resolveOaAccessToken(pool!, { workspaceId, oaId, key: vaultKey(env.LINE_CREDENTIAL_ENCRYPTION_KEY) });
    } catch {
      return { error: { message: 'the OA credential cannot be read', code: 'CREDENTIAL_REFERENCE_MISSING', statusCode: 409 } };
    }
    if (!tokenBuffer) return { error: { message: 'no channel access token is stored for this OA', code: 'CREDENTIAL_REFERENCE_MISSING', statusCode: 409 } };
    try {
      const profile = await profileCheck(tokenBuffer.toString('utf8'), recipientKey);
      if (!profile.reachable) {
        return { error: { message: 'LINE does not see this recipient as reachable; no message was sent', code: 'RECIPIENT_UNREACHABLE', statusCode: 409 } };
      }
      return { name: profile.displayName || '' };
    } catch {
      return { error: { message: 'LINE profile check failed; no message was sent', code: 'PROFILE_CHECK_FAILED', statusCode: 502 } };
    } finally {
      tokenBuffer.fill(0);
    }
  }

  app.post<{ Body: { oaId?: string; recipient?: string; text?: string; flex?: unknown; mode?: 'DRY_RUN' | 'LIVE' } }>(
    '/api/messages/push/preview',
    { preHandler: authorize, schema: { body: { type: 'object', required: ['oaId', 'recipient'], additionalProperties: false, properties: { oaId: { type: 'string', minLength: 1, maxLength: 100 }, recipient: { type: 'string', minLength: 33, maxLength: 33 }, text: { type: 'string', minLength: 1, maxLength: MANUAL_PUSH_TEXT_MAX_CHARS * 4 }, flex: { type: 'object', additionalProperties: true }, mode: { type: 'string', enum: ['DRY_RUN', 'LIVE'] } } } } },
    async (request, reply) => {
      const user = (request as Caller).user!;
      if (!previewLimiter.take(user.id)) return reply.code(429).send({ error: 'preview limit reached', code: 'RATE_LIMITED' });
      const oaId = String(request.body.oaId || '');
      if (!UUID_PATTERN.test(oaId)) return reply.code(400).send({ error: 'unknown OA', code: 'OA_NOT_FOUND' });
      // Exactly one of the two kinds is accepted, so a stored preview always has
      // the document the operator actually saw.
      const hasFlex = request.body.flex !== undefined && request.body.flex !== null;
      const hasText = typeof request.body.text === 'string' && request.body.text.trim() !== '';
      if (hasFlex === hasText) {
        return reply.code(400).send({ error: 'send either text or a flex card, not both', code: 'MESSAGE_INVALID' });
      }
      let body: { to: string; messages: Array<Record<string, unknown>> };
      try {
        body = hasFlex
          ? buildManualFlexPushBody({ lineUserId: request.body.recipient, flexMessage: request.body.flex })
          : buildManualTextPushBody({ lineUserId: request.body.recipient, text: request.body.text });
      }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid message', code: 'MESSAGE_INVALID' }); }
      const messageType: 'text' | 'flex' = hasFlex ? 'flex' : 'text';
      const altText = messageType === 'flex' ? String(body.messages[0]!.altText) : String(body.messages[0]!.text);

      const oa = await loadOaState(oaId, user.workspaceId);
      if (!oa) return reply.code(404).send({ error: 'staging OA not found in this workspace', code: 'OA_NOT_FOUND' });
      if (oa.system_kill_switch || oa.kill_switch) return reply.code(409).send({ error: 'a kill switch blocks delivery', code: 'KILL_SWITCH_ACTIVE' });
      if (!oa.enabled) return reply.code(409).send({ error: 'the selected OA is disabled', code: 'OA_DISABLED' });
      if (!(await hasConsent(user.workspaceId, oa.provider_id, body.to))) {
        return reply.code(409).send({ error: 'recipient has no active consent for this OA', code: 'CONSENT_REQUIRED' });
      }

      // The request may force a mock dry-run; the default follows the host's
      // APP_MODE, and a LIVE request without the release gate is refused.
      const requestedMode: 'DRY_RUN' | 'LIVE' = request.body.mode ?? ((env.APP_MODE || 'DRY_RUN').toUpperCase() === 'LIVE' ? 'LIVE' : 'DRY_RUN');
      const selected = selectAdapter(requestedMode);
      if ('error' in selected) return reply.code(409).send({ error: selected.error.message, code: selected.error.code });
      let recipientName = '';
      if (selected.mode === 'LIVE') {
        const profile = await checkLiveRecipient(oa.id, user.workspaceId, body.to);
        if ('error' in profile) return reply.code(profile.error.statusCode).send({ error: profile.error.message, code: profile.error.code });
        recipientName = profile.name;
      }
      const inserted = await pool!.query<{ id: string; expires_at: string }>(
        'insert into manual_push_requests(workspace_id,oa_integration_id,requested_by,recipient_key,message_text,message_type,flex_json,mode,status,line_retry_key,recipient_display_name,expires_at) ' +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,'PREVIEW',$9,$10,now() + interval '" + PREVIEW_TTL_MINUTES + " minutes') returning id, expires_at",
        [user.workspaceId, oa.id, user.email, body.to, altText, messageType, hasFlex ? JSON.stringify(body.messages[0]) : null, selected.mode, randomUUID(), recipientName || null]
      );
      const previewId = String(inserted.rows[0]!.id);
      await audit(user, 'MANUAL_PUSH_PREVIEWED', previewId, `${oa.display_name} -> ${body.to} · ${messageType} (${selected.mode})`);
      return reply.code(201).send({
        previewId, oaDisplayName: oa.display_name, recipient: body.to, text: altText,
        messageType, flex: hasFlex ? body.messages[0] : null,
        mode: selected.mode, expiresAt: inserted.rows[0]!.expires_at, confirmWord: 'SEND',
        recipientName: recipientName || null
      });
    }
  );

  app.post<{ Body: { previewId?: string; confirm?: string } }>(
    '/api/messages/push/send',
    { preHandler: authorize, schema: { body: { type: 'object', required: ['previewId', 'confirm'], additionalProperties: false, properties: { previewId: { type: 'string', minLength: 1, maxLength: 100 }, confirm: { type: 'string', minLength: 1, maxLength: 20 } } } } },
    async (request, reply) => {
      const user = (request as Caller).user!;
      if (request.body.confirm !== 'SEND') return reply.code(400).send({ error: 'type SEND to confirm a real send', code: 'CONFIRMATION_REQUIRED' });
      if (!sendLimiter.take(user.id)) return reply.code(429).send({ error: 'send limit reached', code: 'RATE_LIMITED' });
      const previewId = String(request.body.previewId || '');
      if (!UUID_PATTERN.test(previewId)) return reply.code(400).send({ error: 'unknown preview', code: 'PREVIEW_NOT_FOUND' });

      // A preview row is single-use: only the owner of the preview, still inside its
      // TTL and still in PREVIEW may claim it, so a double click cannot send twice.
      const claimed = await pool!.query<PreviewRow>(
        "update manual_push_requests set status='SENDING', confirmed_at=now(), updated_at=now() " +
        "where id=$1 and workspace_id=$2 and requested_by=$3 and status='PREVIEW' and expires_at>now() " +
        'returning id, workspace_id, oa_integration_id, recipient_key, message_text, message_type, flex_json, mode, line_retry_key, expires_at',
        [previewId, user.workspaceId, user.email]
      );
      const row = claimed.rows[0];
      if (!row) return reply.code(409).send({ error: 'preview is missing, already used or expired', code: 'PREVIEW_STALE' });

      const oa = await loadOaState(row.oa_integration_id, user.workspaceId);
      if (!oa) return await block(reply, row.id, user, 'staging OA no longer exists');
      if (oa.system_kill_switch || oa.kill_switch) return await block(reply, row.id, user, 'a kill switch blocks delivery', 'KILL_SWITCH_ACTIVE');
      if (!oa.enabled) return await block(reply, row.id, user, 'the selected OA is disabled', 'OA_DISABLED');
      if (!(await hasConsent(user.workspaceId, oa.provider_id, row.recipient_key))) return await block(reply, row.id, user, 'recipient has no active consent for this OA', 'CONSENT_REQUIRED');

      const selected = selectAdapter(row.mode);
      if ('error' in selected) {
        return await block(reply, row.id, user, selected.error.message, selected.error.code);
      }
      const job: SchedulerJob = {
        id: row.id, workspaceId: user.workspaceId, campaignId: 'manual-push', campaignRevisionId: undefined,
        oaId: row.oa_integration_id, scheduledAt: new Date().toISOString(), timeZone: 'Asia/Bangkok',
        mode: row.mode, status: 'CLAIMED', attempts: 1, idempotencyKey: row.line_retry_key, createdAt: new Date().toISOString()
      };
      let slot: Awaited<ReturnType<Repository['reserveDeliverySlot']>> | null = null;
      try {
        slot = await repo.reserveDeliverySlot({ workspaceId: user.workspaceId, oaId: row.oa_integration_id, count: row.mode === 'LIVE' });
        const result = await selected.adapter.send({
          job,
          payload: { preview: false, to: row.recipient_key, messages: storedMessages(row) }
        });
        await pool!.query(
          "update manual_push_requests set status='SENT', provider_status=$2, provider_request_id=$3, provider_message_id=$4, updated_at=now() where id=$1",
          [row.id, result.providerStatus ?? null, result.providerRequestId ?? null, result.providerMessageId ?? null]
        );
        await audit(user, 'MANUAL_PUSH_SENT', row.id, `${oa.display_name} -> ${row.recipient_key} · ${result.providerStatus || ''} ${result.providerRequestId || ''} · ${row.mode}`);
        return { status: 'SENT', mode: row.mode, outbound: result.outbound, providerStatus: result.providerStatus, providerRequestId: result.providerRequestId, providerMessageId: result.providerMessageId ?? null, oaDisplayName: oa.display_name, recipient: row.recipient_key };
      } catch (error) {
        if (slot?.counted) await repo.releaseDeliverySlot({ workspaceId: user.workspaceId, oaId: row.oa_integration_id, windowStartedAt: slot.windowStartedAt }).catch(() => undefined);
        const uncertain = error instanceof ProviderTransportError && error.uncertain;
        const status = uncertain ? 'UNKNOWN' : 'FAILED';
        const reason = error instanceof ProviderTransportError ? `${error.message}:${error.status}` : error instanceof Error ? error.message : 'send failed';
        await pool!.query(
          "update manual_push_requests set status=$2, last_error=$3, provider_status=$4, provider_request_id=$5, updated_at=now() where id=$1",
          [row.id, status, reason.slice(0, 400), error instanceof ProviderTransportError ? error.status : null, error instanceof ProviderTransportError ? error.requestId || null : null]
        );
        await audit(user, status === 'UNKNOWN' ? 'MANUAL_PUSH_UNKNOWN' : 'MANUAL_PUSH_FAILED', row.id, reason.slice(0, 240));
        return reply.code(status === 'UNKNOWN' ? 502 : 500).send({
          error: status === 'UNKNOWN' ? 'LINE did not confirm the request; check the ledger before retrying' : 'LINE rejected the request',
          code: status === 'UNKNOWN' ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_FAILED', status, reason
        });
      }
    }
  );

  async function block(reply: FastifyReply, id: string, user: AdminUser, reason: string, code = 'PREVIEW_BLOCKED') {
    await pool!.query("update manual_push_requests set status='BLOCKED', last_error=$2, updated_at=now() where id=$1", [id, reason.slice(0, 400)]);
    await audit(user, 'MANUAL_PUSH_BLOCKED', id, reason);
    return reply.code(409).send({ error: reason, code });
  }

  app.get('/api/messages/push/history', { preHandler: authorize }, async (request) => {
    const user = (request as Caller).user!;
    const result = await pool!.query(
      'select id, recipient_key, message_text, message_type, mode, status, provider_status, provider_request_id, provider_message_id, recipient_display_name, last_error, oa_integration_id, created_at, confirmed_at ' +
      'from manual_push_requests where workspace_id=$1 order by created_at desc limit 10',
      [user.workspaceId]
    );
    return { pushes: result.rows.map((row) => ({
      id: String(row.id), recipient: String(row.recipient_key), text: String(row.message_text), messageType: String(row.message_type), mode: String(row.mode),
      status: String(row.status), providerStatus: row.provider_status ?? null, providerRequestId: row.provider_request_id ?? null,
      providerMessageId: row.provider_message_id ?? null, recipientName: row.recipient_display_name ?? null,
      error: row.last_error ?? null, oaId: String(row.oa_integration_id), createdAt: String(row.created_at), confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null
    })) };
  });
}
