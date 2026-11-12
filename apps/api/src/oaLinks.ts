import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AdminUser } from './types.js';
import type { Repository } from './repository.js';
import { OA_TIER, OA_TIER_SQL } from './oaScope.js';
import { oaFriendUrl } from './oaFriendUrl.js';

type AdminRequest = FastifyRequest & { user?: AdminUser };

type LinkRow = {
  id: string; display_name: string; basic_id: string;
  credential_status: string | null; has_secret: boolean | null;
  token_checked_at: Date | null;
  channel_status: string | null; verified_at: Date | null; liff_id: string | null;
  clicks7d: number; logins7d: number; follows7d: number; active_links: number;
};

/** Booleans, counts and timestamps only: the checklist must never expose a credential. */
export type OaLinkHealth = {
  oaId: string; displayName: string; basicId: string;
  friendUrl: string | null; shareUrl: string | null;
  liffId: string | null; liffSource: 'OA' | 'SERVER' | 'NONE';
  webhookVerified: boolean; credentialReady: boolean; credentialStatus: string;
  tokenCheckedAt: string | null;
  clicks7d: number; logins7d: number; follows7d: number; activeReferralLinks: number;
};

function shareBase() {
  return (process.env.PUBLIC_APP_ORIGIN || 'http://127.0.0.1:5173').replace(/\/$/, '');
}

/** `@` is legal in a query string, so the link the operator copies reads like the basic id itself. */
const basicIdQuery = (basicId: string) => encodeURIComponent(basicId).replace(/%40/gi, '@');

function describe(input: {
  oaId: string; displayName: string; basicId: string;
  liffId: string | null; credentialStatus: string; credentialReady: boolean;
  webhookVerified: boolean; tokenCheckedAt: string | null;
  clicks7d: number; logins7d: number; follows7d: number; activeReferralLinks: number;
}): OaLinkHealth {
  const envLiffId = process.env.LINE_LIFF_CHANNEL_ID || null;
  const liffId = input.liffId || envLiffId;
  const friendUrl = oaFriendUrl(input.basicId);
  return {
    ...input,
    friendUrl,
    shareUrl: friendUrl ? `${shareBase()}/share?oa=${basicIdQuery(input.basicId)}` : null,
    liffId,
    liffSource: input.liffId ? 'OA' : envLiffId ? 'SERVER' : 'NONE'
  };
}

export function registerOaLinksRoutes(
  app: FastifyInstance, pool: Pool | null, repo: Repository,
  requireRead: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
) {
  app.get('/api/oa-links', { preHandler: requireRead }, async (request) => {
    const user = (request as AdminRequest).user!;
    const loginEnabled = process.env.LINE_LOGIN_ENABLED === 'true' && Boolean(process.env.LINE_LOGIN_CHANNEL_ID);
    if (!pool) {
      const oas = (await repo.listOas(user.workspaceId)).filter((oa) => oa.enabled && oa.environment === OA_TIER);
      return {
        loginEnabled, shareBase: shareBase(),
        links: oas.map((oa) => describe({
          oaId: oa.id, displayName: oa.displayName, basicId: oa.basicId, liffId: null,
          credentialStatus: oa.credentialStatus, credentialReady: oa.secretConfigured,
          webhookVerified: false, tokenCheckedAt: null,
          clicks7d: 0, logins7d: 0, follows7d: 0, activeReferralLinks: 0
        }))
      };
    }
    const result = await pool.query<LinkRow>(
      'select oa.id, oa.display_name, oa.basic_id, oa.credential_status, ' +
      '(v.secret_sealed is not null) as has_secret, v.access_token_checked_at as token_checked_at, ' +
      'c.status as channel_status, c.verified_at, c.liff_id, ' +
      'coalesce(ev.clicks,0)::int as clicks7d, coalesce(ev.logins,0)::int as logins7d, coalesce(ev.follows,0)::int as follows7d, ' +
      'coalesce(links.active_links,0)::int as active_links ' +
      'from oa_integrations oa ' +
      'left join oa_credential_vault v on v.workspace_id=oa.workspace_id and v.oa_integration_id=oa.id ' +
      'left join workspace_oa_channels c on c.workspace_id=oa.workspace_id and c.oa_integration_id=oa.id ' +
      'left join lateral (select count(*) filter (where e.event_type=\'CLICK\') as clicks, ' +
      'count(*) filter (where e.event_type=\'LOGIN\') as logins, ' +
      'count(*) filter (where e.event_type=\'FOLLOW_VERIFIED\') as follows ' +
      "from referral_attribution_events e where e.workspace_id=oa.workspace_id and e.oa_integration_id=oa.id and e.occurred_at > now() - interval '7 days') ev on true " +
      'left join lateral (select count(*) as active_links from staff_invite_links l ' +
      "where l.workspace_id=oa.workspace_id and l.oa_integration_id=oa.id and l.status='ACTIVE' and (l.expires_at is null or l.expires_at > now())) links on true " +
      `where oa.workspace_id=$1 and oa.enabled=true and ${OA_TIER_SQL} order by oa.created_at`,
      [user.workspaceId]
    );
    return {
      loginEnabled, shareBase: shareBase(),
      links: result.rows.map((row) => describe({
        oaId: String(row.id), displayName: String(row.display_name), basicId: String(row.basic_id),
        liffId: row.liff_id || null,
        credentialStatus: row.has_secret ? String(row.credential_status || 'REFERENCE_CONFIGURED') : 'NOT_CONFIGURED',
        credentialReady: Boolean(row.has_secret),
        webhookVerified: row.channel_status === 'VERIFIED' && Boolean(row.verified_at) && Boolean(row.has_secret),
        tokenCheckedAt: row.token_checked_at ? new Date(row.token_checked_at).toISOString() : null,
        clicks7d: Number(row.clicks7d), logins7d: Number(row.logins7d), follows7d: Number(row.follows7d),
        activeReferralLinks: Number(row.active_links)
      }))
    };
  });
}
