import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AdminUser } from './types.js';
import { createFixedWindowLimiter } from './security.js';

type BotInfo = { basicId: string; displayName: string };
type Caller = FastifyRequest & { user?: AdminUser };
type FetchFn = typeof fetch;

export function vaultKey(encoded = process.env.LINE_CREDENTIAL_ENCRYPTION_KEY): Buffer {
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('OA credential vault is not configured');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('invalid OA credential vault configuration');
  return key;
}

export function sealOaSecret(value: string, workspaceId: string, oaId: string, kind: string, key: Buffer): string {
  if (key.length !== 32 || !['token','secret'].includes(kind) || !value) throw new Error('invalid sealed credential input');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('lineccc:v1:' + workspaceId + ':' + oaId + ':' + kind, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}

export function openOaSecret(sealed: string, workspaceId: string, oaId: string, kind: string, key: Buffer): string {
  if (key.length !== 32 || !['token','secret'].includes(kind)) throw new Error('invalid sealed credential context');
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unrecognized credential envelope');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid credential envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from('lineccc:v1:' + workspaceId + ':' + oaId + ':' + kind, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decrypts the OA access token at send time. The lookup is bound to the exact
 * workspace/OA pair; there is no environment or cross-OA fallback.
 */
export async function resolveOaAccessToken(pool: Pool, input: { workspaceId: string; oaId: string; key: Buffer }): Promise<Buffer | null> {
  if (!UUID_PATTERN.test(input.workspaceId) || !UUID_PATTERN.test(input.oaId)) return null;
  const result = await pool.query<{ token_sealed: string | null }>(
    'select v.token_sealed from oa_credential_vault v ' +
    'join oa_integrations oa on oa.id=v.oa_integration_id and oa.workspace_id=v.workspace_id ' +
    "where v.workspace_id=$1 and v.oa_integration_id=$2 and oa.environment='STAGING'",
    [input.workspaceId, input.oaId]
  );
  const sealed = result.rows[0]?.token_sealed;
  if (!sealed) return null;
  const token = openOaSecret(sealed, input.workspaceId, input.oaId, 'token', input.key);
  return Buffer.from(token, 'utf8');
}

// Fixed read-only endpoint: never sends a LINE message or activates a webhook.
export async function checkLineBotToken(token: string, transport: FetchFn = fetch): Promise<BotInfo> {
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('invalid access token');
  let response: Response;
  try {
    response = await transport('https://api.line.me/v2/bot/info', {
      method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000), redirect: 'error', cache: 'no-store'
    });
  } catch {
    throw new Error('LINE API unreachable; credentials were not saved');
  }
  if (response.status === 401 || response.status === 403) throw new Error('LINE rejected the channel access token');
  if (!response.ok) throw new Error('LINE bot info check failed; credentials were not saved');
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error('invalid LINE bot info response');
  const data = body as Partial<BotInfo>;
  if (typeof data.basicId !== 'string' || !/^@[A-Za-z0-9._-]{2,50}$/.test(data.basicId) ||
      typeof data.displayName !== 'string' || data.displayName.length < 1 || data.displayName.length > 160) {
    throw new Error('invalid LINE bot info response');
  }
  return { basicId: data.basicId, displayName: data.displayName };
}

export type LineProfileResult = { reachable: boolean; displayName?: string };

/**
 * Fixed read-only profile lookup used before a manual live push. LINE returns
 * 404 for a user who blocked the OA or was never a friend, which is ambiguous
 * but is the only pre-send signal available; any other failure is surfaced so
 * the caller can refuse to send rather than guess.
 */
export async function checkLineProfile(token: string, userId: string, transport: FetchFn = fetch): Promise<LineProfileResult> {
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('invalid access token');
  if (!/^U[0-9a-f]{32}$/i.test(userId)) throw new Error('invalid LINE userId');
  let response: Response;
  try {
    response = await transport(`https://api.line.me/v2/bot/profile/${userId}`, {
      method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000), redirect: 'error', cache: 'no-store'
    });
  } catch {
    throw new Error('LINE API unreachable');
  }
  if (response.status === 404) return { reachable: false };
  if (response.status === 401 || response.status === 403) throw new Error('LINE rejected the channel access token');
  if (!response.ok) throw new Error('LINE profile check failed');
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error('invalid LINE profile response');
  const name = (body as { displayName?: unknown }).displayName;
  if (typeof name !== 'string' || name.length < 1 || name.length > 160) throw new Error('invalid LINE profile response');
  return { reachable: true, displayName: name };
}

export function registerOaConnectRoutes(
  app: FastifyInstance, pool: Pool | null,
  requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => unknown,
  checkToken: (token: string) => Promise<BotInfo> = checkLineBotToken
) {
  const connectLimiter = createFixedWindowLimiter(10, 60 * 60 * 1000);
  async function authorizeOwner(request: FastifyRequest, reply: FastifyReply) {
    if (!pool) return reply.code(503).send({ error: 'PostgreSQL is required' });
    const auth = await requireUser(request, reply);
    if (auth) return auth;
    const user = (request as Caller).user;
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (user.role !== 'owner') return reply.code(403).send({ error: 'owner role required' });
    const membership = await pool.query(
      "select 1 from workspace_memberships where workspace_id=$1 and admin_user_id=$2 and status='ACTIVE'",
      [user.workspaceId, user.id]
    );
    if (!membership.rowCount) return reply.code(403).send({ error: 'inactive membership' });
    if (request.method !== 'GET') return requireCsrf(request, reply);
    return undefined;
  }

  app.post<{ Body: { providerId: string; messagingChannelId: string; channelAccessToken: string; channelSecret: string } }>(
    '/api/workspace/oa-connect',
    {
      preHandler: authorizeOwner,
      schema: { body: { type: 'object', additionalProperties: false,
        required: ['providerId','messagingChannelId','channelAccessToken','channelSecret'],
        properties: {
          providerId: { type: 'string', minLength: 2, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$' },
          messagingChannelId: { type: 'string', pattern: '^[0-9]{5,30}$' },
          channelAccessToken: { type: 'string', minLength: 20, maxLength: 4096, pattern: '^[^\\r\\n]+$' },
          channelSecret: { type: 'string', minLength: 16, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' }
        }
      }}
    },
    async (request, reply) => {
      let key: Buffer;
      try { key = vaultKey(); }
      catch { return reply.code(503).send({ error: 'secure credential storage is not configured' }); }
      const user = (request as Caller).user!;
      if (!connectLimiter.take(user.workspaceId)) return reply.code(429).send({ error: 'too many LINE OA connection attempts; try again later' });
      const { providerId, messagingChannelId, channelAccessToken, channelSecret } = request.body;
      let info: BotInfo;
      try { info = await checkToken(channelAccessToken); }
      catch (error) {
        return reply.code(422).send({ error: error instanceof Error ? error.message : 'LINE verification failed' });
      }
      const client = await pool!.connect();
      try {
        await client.query('begin');
        const conflicting = await client.query(
          'select 1 from oa_integrations where basic_id=$1 and workspace_id<>$2 limit 1',
          [info.basicId, user.workspaceId]
        );
        if (conflicting.rowCount) {
          await client.query('rollback');
          return reply.code(409).send({ error: 'LINE OA is already registered in another workspace' });
        }
        const inserted = await client.query(
          "insert into oa_integrations (workspace_id,provider_id,basic_id,display_name,environment,enabled,connection_status,credential_status) " +
          "values ($1,$2,$3,$4,'STAGING',false,'LIVE_LOCKED','REFERENCE_CONFIGURED') " +
          "on conflict (workspace_id,provider_id,basic_id) do update " +
          "set display_name=excluded.display_name,enabled=false,connection_status='LIVE_LOCKED',credential_status='REFERENCE_CONFIGURED' returning id",
          [user.workspaceId,providerId,info.basicId,info.displayName]
        );
        const oaId = String(inserted.rows[0].id);
        const tokenSealed = sealOaSecret(channelAccessToken,user.workspaceId,oaId,'token',key);
        const secretSealed = sealOaSecret(channelSecret,user.workspaceId,oaId,'secret',key);
        await client.query(
          'insert into oa_credential_vault (workspace_id,oa_integration_id,token_sealed,secret_sealed,bot_basic_id,access_token_checked_at) ' +
          'values ($1,$2,$3,$4,$5,now()) on conflict (workspace_id,oa_integration_id) ' +
          'do update set token_sealed=excluded.token_sealed,secret_sealed=excluded.secret_sealed,' +
          'bot_basic_id=excluded.bot_basic_id,access_token_checked_at=now(),updated_at=now()',
          [user.workspaceId,oaId,tokenSealed,secretSealed,info.basicId]
        );
        await client.query(
          'insert into workspace_oa_channels (workspace_id,oa_integration_id,messaging_channel_id,line_provider_id,status,verified_at) ' +
          "values ($1,$2,$3,$4,'VERIFY_PENDING',null) on conflict (workspace_id,oa_integration_id) " +
          "do update set messaging_channel_id=excluded.messaging_channel_id,line_provider_id=excluded.line_provider_id,status='VERIFY_PENDING',verified_at=null",
          [user.workspaceId,oaId,messagingChannelId,providerId]
        );
        await client.query(
          "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,$2,'OA_TOKEN_VERIFIED','oa',$3,$4::jsonb)",
          [user.workspaceId,user.email,oaId,JSON.stringify({detail:'LINE bot info GET succeeded; channel secret not yet confirmed via signed webhook'})]
        );
        await client.query('commit');
        return reply.code(201).send({
          oaId, displayName: info.displayName,basicId: info.basicId,
          accessTokenValidated: true, webhookSecretValidated: false,
          sendingEnabled: false, status:'VERIFY_PENDING'
        });
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if ((error as { code?: string })?.code === '23505') return reply.code(409).send({ error: 'OA or messaging channel already registered' });
        return reply.code(500).send({ error: 'could not securely store LINE OA configuration' });
      } finally { client.release(); }
    }
  );

  app.get('/api/workspace/oa-connect/status', { preHandler: authorizeOwner }, async (request) => {
    const user = (request as Caller).user!;
    const result = await pool!.query(
      'select oa.id as "oaId",oa.display_name as "displayName",oa.basic_id as "basicId", ' +
      'v.access_token_checked_at as "accessTokenCheckedAt", (v.oa_integration_id is not null) as "storedEncrypted", ' +
      'c.status as "channelStatus", c.verified_at as "verifiedAt" from oa_integrations oa ' +
      'left join oa_credential_vault v on v.workspace_id=oa.workspace_id and v.oa_integration_id=oa.id ' +
      'left join workspace_oa_channels c on c.workspace_id=oa.workspace_id and c.oa_integration_id=oa.id ' +
      'where oa.workspace_id=$1 order by oa.created_at',
      [user.workspaceId]
    );
    return { connections: result.rows };
  });
}