import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

const migrationSql = fs.readFileSync(new URL('../db/migrations/008_multitenant_foundation.sql', import.meta.url), 'utf8');
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const digestC = 'c'.repeat(64);

test('tenant migration never persists access tokens or raw LINE identities', () => {
  assert.match(migrationSql, /workspace_memberships/);
  assert.match(migrationSql, /workspace_oa_channels/);
  assert.match(migrationSql, /workspace_line_identities/);
  assert.match(migrationSql, /staff_invite_links/);
  assert.match(migrationSql, /referral_attribution_events/);
  assert.match(migrationSql, /follower_subject_hmac/);
  assert.doesNotMatch(migrationSql, /\b(?:channel_access_token|channel_secret|raw_line_user_id)\b/i);
});

test('database refuses workspace mixing and false follow attribution', async (t) => {
  const url = process.env.TENANT_TEST_DATABASE_URL;
  if (!url) {
    t.skip('TENANT_TEST_DATABASE_URL not set (no test database touched)');
    return;
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const { rows } = await client.query('select current_database() as name');
    assert.match(rows[0].name, /^line_ccc_tenant_qa_[a-z0-9_]+$/);
    await client.query('begin');
    let sp = 0;
    async function rejectsQuery(sql, values = []) {
      const name = 'isolated_savepoint_' + (++sp);
      await client.query('savepoint ' + name);
      try {
        await assert.rejects(() => client.query(sql, values));
      } finally {
        await client.query('rollback to savepoint ' + name);
        await client.query('release savepoint ' + name);
      }
    }
    const workspaceA = (await client.query("insert into workspaces(name,mode) values ('Tenant Test A','DRY_RUN') returning id")).rows[0].id;
    const workspaceB = (await client.query("insert into workspaces(name,mode) values ('Tenant Test B','DRY_RUN') returning id")).rows[0].id;
    const userA = (await client.query("insert into admin_users(workspace_id,email,display_name,role,password_hash) values ($1,'a@example.test','A','owner','hash-test') returning id",[workspaceA])).rows[0].id;
    const userB = (await client.query("insert into admin_users(workspace_id,email,display_name,role,password_hash) values ($1,'b@example.test','B','owner','hash-test') returning id",[workspaceB])).rows[0].id;
    const oaA = (await client.query("insert into oa_integrations(workspace_id,provider_id,basic_id,display_name) values ($1,'providerA','@tenant-a','OA A') returning id",[workspaceA])).rows[0].id;
    const oaB = (await client.query("insert into oa_integrations(workspace_id,provider_id,basic_id,display_name) values ($1,'providerB','@tenant-b','OA B') returning id",[workspaceB])).rows[0].id;

    await client.query("insert into workspace_memberships(workspace_id,admin_user_id) values ($1,$2)",[workspaceA,userA]);
    await rejectsQuery("insert into workspace_memberships(workspace_id,admin_user_id) values ($1,$2)",[workspaceA,userB]);

    await client.query("insert into workspace_oa_channels(workspace_id,oa_integration_id,messaging_channel_id) values ($1,$2,'1234567890')",[workspaceA,oaA]);
    await rejectsQuery("insert into workspace_oa_channels(workspace_id,oa_integration_id,messaging_channel_id) values ($1,$2,'1234567891')",[workspaceA,oaB]);
    await rejectsQuery("insert into workspace_oa_channels(workspace_id,oa_integration_id,messaging_channel_id) values ($1,$2,'1234567890')",[workspaceB,oaB]);

    await client.query("insert into workspace_line_identities(workspace_id,admin_user_id,provider_id,subject_hmac) values ($1,$2,'providerA',$3)",[workspaceA,userA,digestA]);
    await rejectsQuery("insert into workspace_line_identities(workspace_id,admin_user_id,provider_id,subject_hmac) values ($1,$2,'providerA',$3)",[workspaceA,userB,digestB]);
    await rejectsQuery("insert into workspace_line_identities(workspace_id,admin_user_id,provider_id,subject_hmac) values ($1,$2,'providerA','Uraw-line-user-id')",[workspaceA,userA]);

    await rejectsQuery("insert into staff_invite_links(workspace_id,admin_user_id,oa_integration_id,token_hash) values ($1,$2,$3,$4)",[workspaceA,userB,oaA,digestB]);
    await rejectsQuery("insert into staff_invite_links(workspace_id,admin_user_id,oa_integration_id,token_hash) values ($1,$2,$3,$4)",[workspaceA,userA,oaB,digestB]);
    const inviteId = (await client.query("insert into staff_invite_links(workspace_id,admin_user_id,oa_integration_id,token_hash) values ($1,$2,$3,$4) returning id",[workspaceA,userA,oaA,digestB])).rows[0].id;

    await rejectsQuery("insert into referral_attribution_events(workspace_id,invite_link_id,oa_integration_id,event_type) values ($1,$2,$3,'CLICK')",[workspaceB,inviteId,oaA]);
    await rejectsQuery("insert into referral_attribution_events(workspace_id,invite_link_id,oa_integration_id,event_type) values ($1,$2,$3,'CLICK')",[workspaceA,inviteId,oaB]);
    await client.query("insert into referral_attribution_events(workspace_id,invite_link_id,oa_integration_id,event_type) values ($1,$2,$3,'CLICK')",[workspaceA,inviteId,oaA]);
    await rejectsQuery("insert into referral_attribution_events(workspace_id,invite_link_id,oa_integration_id,event_type,follower_subject_hmac) values ($1,$2,$3,'FOLLOW_VERIFIED',$4)",[workspaceA,inviteId,oaA,digestC]);
    await client.query("insert into referral_attribution_events(workspace_id,invite_link_id,oa_integration_id,event_type,follower_subject_hmac,evidence_ref) values ($1,$2,$3,'FOLLOW_VERIFIED',$4,'webhook-event-123')",[workspaceA,inviteId,oaA,digestC]);
    await rejectsQuery("insert into referral_attribution_events(workspace_id,invite_link_id,oa_integration_id,event_type,follower_subject_hmac,evidence_ref) values ($1,$2,$3,'FOLLOW_VERIFIED',$4,'different-evidence')",[workspaceA,inviteId,oaA,digestC]);
    const result = await client.query("select count(*)::int as n from referral_attribution_events where event_type='FOLLOW_VERIFIED' and workspace_id=$1",[workspaceA]);
    assert.equal(result.rows[0].n, 1);
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }
});