import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { CompleteLineLoginInput, LineLoginContext, LineLoginSession, LineLoginStore, StoredLineLoginFlow } from './lineLoginStore.js';

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class PostgresLineLoginStore implements LineLoginStore {
  constructor(private readonly pool: Pool) {}

  async resolveLineLoginMember(referralToken: string): Promise<LineLoginContext> {
    if (typeof referralToken !== 'string' || referralToken.length < 20 || referralToken.length > 200) throw new Error('invalid referral token');
    const result = await this.pool.query<{ workspace_id: string; oa_integration_id: string; invite_link_id: string }>(
      `select il.workspace_id, il.oa_integration_id, il.id as invite_link_id
       from staff_invite_links il
       join admin_users u on u.id=il.admin_user_id and u.workspace_id=il.workspace_id and u.active=true
       join workspace_memberships m on m.admin_user_id=u.id and m.workspace_id=u.workspace_id and m.status='ACTIVE'
       join oa_integrations oa on oa.id=il.oa_integration_id and oa.workspace_id=il.workspace_id and oa.enabled=true and oa.environment='STAGING'
       where il.token_hash=$1 and il.status='ACTIVE' and (il.expires_at is null or il.expires_at>now())
       limit 2`,
      [sha256(referralToken)]
    );
    if (result.rows.length !== 1) throw new Error('referral token is invalid or inactive');
    return {
      workspaceId: String(result.rows[0].workspace_id),
      oaId: String(result.rows[0].oa_integration_id),
      referralId: String(result.rows[0].invite_link_id),
      referralToken
    };
  }

  async saveLineLoginFlow(flow: StoredLineLoginFlow) {
    await this.pool.query(
      `insert into line_customer_login_states
       (state_hash,workspace_id,oa_integration_id,invite_link_id,browser_binding_hash,referral_token_sealed,nonce_hash,nonce_sealed,code_verifier_sealed,expires_at)
       select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
       where exists (
         select 1 from staff_invite_links il
         join oa_integrations oa on oa.id=il.oa_integration_id and oa.workspace_id=il.workspace_id
         join admin_users u on u.id=il.admin_user_id and u.workspace_id=il.workspace_id and u.active=true
         join workspace_memberships m on m.admin_user_id=u.id and m.workspace_id=u.workspace_id and m.status='ACTIVE'
         where il.id=$4 and il.workspace_id=$2 and il.oa_integration_id=$3
           and il.status='ACTIVE' and (il.expires_at is null or il.expires_at>now())
           and oa.enabled=true and oa.environment='STAGING'
       )`,
      [flow.stateHash, flow.workspaceId, flow.oaId, flow.referralId, flow.browserBindingHash, flow.referralTokenSealed, flow.nonceHash, flow.nonceSealed, flow.codeVerifierSealed, flow.expiresAt]
    ).then(result => {
      if (result.rowCount !== 1) throw new Error('referral became inactive before login state was saved');
    });
  }

  async getLineLoginFlow(stateHash: string, browserBindingHash: string) {
    const result = await this.pool.query(
      `select state_hash as "stateHash", workspace_id as "workspaceId", oa_integration_id as "oaId",
              invite_link_id as "referralId", browser_binding_hash as "browserBindingHash",
              referral_token_sealed as "referralTokenSealed", nonce_hash as "nonceHash",
              nonce_sealed as "nonceSealed", code_verifier_sealed as "codeVerifierSealed",
              expires_at as "expiresAt"
       from line_customer_login_states
       where state_hash=$1 and browser_binding_hash=$2 and expires_at>now() and claimed_at is null`,
      [stateHash, browserBindingHash]
    );
    return (result.rows[0] as StoredLineLoginFlow | undefined) || null;
  }

  async discardLineLoginState(stateHash: string, browserBindingHash: string) {
    await this.pool.query('delete from line_customer_login_states where state_hash=$1 and browser_binding_hash=$2', [stateHash, browserBindingHash]);
  }

  async completeLineLogin(input: CompleteLineLoginInput): Promise<LineLoginSession | null> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const flow = await client.query<{
        workspace_id: string;
        oa_integration_id: string;
        invite_link_id: string;
      }>(
        `select s.workspace_id, s.oa_integration_id, s.invite_link_id
         from line_customer_login_states s
         join staff_invite_links il on il.id=s.invite_link_id and il.workspace_id=s.workspace_id and il.oa_integration_id=s.oa_integration_id
         join admin_users u on u.id=il.admin_user_id and u.workspace_id=il.workspace_id and u.active=true
         join workspace_memberships m on m.admin_user_id=u.id and m.workspace_id=u.workspace_id and m.status='ACTIVE'
         join oa_integrations oa on oa.id=s.oa_integration_id and oa.workspace_id=s.workspace_id and oa.enabled=true and oa.environment='STAGING'
         where s.state_hash=$1 and s.browser_binding_hash=$2 and s.expires_at>now() and s.claimed_at is null
           and il.status='ACTIVE' and (il.expires_at is null or il.expires_at>now())
         for update of s,il,oa`,
        [input.stateHash, input.browserBindingHash]
      );
      if (!flow.rows[0]) {
        await client.query('rollback');
        return null;
      }
      const context = flow.rows[0];
      const customer = await client.query<{ id: string }>(
        `insert into line_customers(workspace_id,oa_integration_id,attributed_invite_link_id,line_subject_hmac,display_name)
         values ($1,$2,$3,$4,$5)
         on conflict (workspace_id,oa_integration_id,line_subject_hmac)
         do update set display_name=excluded.display_name, updated_at=now()
         returning id`,
        [context.workspace_id, context.oa_integration_id, context.invite_link_id, input.subjectHmac, input.displayName]
      );
      const customerId = String(customer.rows[0].id);
      await client.query(
        `update line_customer_login_states set claimed_at=now(), completed_at=now()
         where state_hash=$1 and claimed_at is null`,
        [input.stateHash]
      );
      await client.query(
        `insert into line_customer_sessions(token_hash,customer_id,workspace_id,oa_integration_id,invite_link_id,expires_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [sha256(input.sessionToken), customerId, context.workspace_id, context.oa_integration_id, context.invite_link_id, input.expiresAt]
      );
      await client.query(
        `insert into referral_attribution_events(workspace_id,invite_link_id,oa_integration_id,event_type,customer_id)
         values ($1,$2,$3,'LOGIN',$4)`,
        [context.workspace_id, context.invite_link_id, context.oa_integration_id, customerId]
      );
      await client.query('commit');
      return {
        token: input.sessionToken,
        expiresAt: input.expiresAt,
        customer: { id: customerId, displayName: input.displayName, role: 'customer' }
      };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getLineMemberSession(token: string) {
    const result = await this.pool.query<{ id: string; display_name: string }>(
      `select c.id,c.display_name
       from line_customer_sessions s
       join line_customers c on c.id=s.customer_id and c.workspace_id=s.workspace_id and c.oa_integration_id=s.oa_integration_id
       where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now()`,
      [sha256(token)]
    );
    const row = result.rows[0];
    return row ? { id: String(row.id), displayName: String(row.display_name), role: 'customer' as const } : null;
  }

  async revokeLineMemberSession(token: string) {
    await this.pool.query('update line_customer_sessions set revoked_at=coalesce(revoked_at,now()) where token_hash=$1', [sha256(token)]);
  }

  async cleanupExpiredLineLoginData() {
    await this.pool.query('delete from line_customer_login_states where expires_at<=now() or claimed_at<now()-interval \'1 day\'');
    await this.pool.query('delete from line_customer_sessions where expires_at<=now() or revoked_at<now()-interval \'30 days\'');
  }
}
