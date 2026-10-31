import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { hashPasswordSync } from './auth.js';

export async function seedStaging(pool: Pool) {
  const email = (process.env.STAGING_ADMIN_EMAIL || 'admin@staging.local').trim().toLowerCase();
  const password = process.env.STAGING_ADMIN_PASSWORD;
  if (!password || password.length < 12) throw new Error('STAGING_ADMIN_PASSWORD must be set and at least 12 characters for database seed');
  const root = path.resolve(process.cwd());
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'campaigns.json'), 'utf8')) as { campaigns: Array<Record<string, unknown>> };
  const client = await pool.connect();
  try {
    await client.query('begin');
    const workspace = await client.query<{ id: string }>(`insert into workspaces(name, mode) values ('LINE Campaign Control Center Staging', 'DRY_RUN') on conflict (name) do update set mode='DRY_RUN' returning id`);
    const workspaceId = workspace.rows[0].id;
    const adminUser = await client.query<{ id: string }>(`insert into admin_users(workspace_id,email,display_name,role,password_hash) values ($1,$2,'Staging Owner','owner',$3) on conflict (workspace_id,email) do update set password_hash=excluded.password_hash, active=true returning id`, [workspaceId, email, hashPasswordSync(password)]);
    await client.query(`insert into workspace_memberships(workspace_id,admin_user_id,status) values ($1,$2,'ACTIVE') on conflict (workspace_id,admin_user_id) do update set status='ACTIVE'`, [workspaceId, adminUser.rows[0].id]);
    const oa = await client.query<{ id: string }>(`insert into oa_integrations(workspace_id,provider_id,basic_id,display_name,environment,enabled) values ($1,'staging-provider','@453yfyvc','LINE OA หลัก (Staging)','STAGING',true) on conflict (workspace_id,provider_id,basic_id) do update set enabled=true returning id`, [workspaceId]);
    await client.query(`insert into oa_integrations(workspace_id,provider_id,basic_id,display_name,environment,enabled) values ($1,'mock-provider','@mock-campaign','LINE OA สำรอง (Mock)','STAGING',false) on conflict (workspace_id,provider_id,basic_id) do update set enabled=false`, [workspaceId]);
    const viewerEmail = process.env.STAGING_VIEWER_EMAIL?.trim().toLowerCase();
    const viewerPassword = process.env.STAGING_VIEWER_PASSWORD;
    if (viewerEmail && viewerPassword) {
      const viewer = await client.query<{ id: string }>(`insert into admin_users(workspace_id,email,display_name,role,password_hash) values ($1,$2,'Staging Viewer','viewer',$3) on conflict (workspace_id,email) do update set password_hash=excluded.password_hash, active=true returning id`, [workspaceId, viewerEmail, hashPasswordSync(viewerPassword)]);
      await client.query(`insert into workspace_memberships(workspace_id,admin_user_id,status) values ($1,$2,'ACTIVE') on conflict (workspace_id,admin_user_id) do update set status='ACTIVE'`, [workspaceId, viewer.rows[0].id]);
    }
    for (const item of manifest.campaigns) {
      const campaign = await client.query<{ id: string }>(`insert into campaigns(workspace_id,slug,name,title,description,image,cta,flex_file,active) values ($1,$2,$3,$4,$5,$6,$7,$8,true) on conflict (workspace_id,slug) do update set name=excluded.name,title=excluded.title,description=excluded.description,image=excluded.image,cta=excluded.cta,flex_file=excluded.flex_file,active=true returning id`, [workspaceId, item.id, item.name, item.title, item.description, item.image, item.cta, item.flexFile]);
      const flex = JSON.parse(await fs.readFile(path.join(root, String(item.flexFile)), 'utf8'));
      await client.query(`insert into campaign_revisions(campaign_id,revision,flex_json,state,created_by) values ($1,1,$2::jsonb,'PUBLISHED','seed') on conflict (campaign_id,revision) do update set flex_json=excluded.flex_json,state='PUBLISHED'`, [campaign.rows[0].id, JSON.stringify(flex)]);
    }
    const welcome = await client.query<{ id: string }>(`select r.id from campaign_revisions r join campaigns c on c.id=r.campaign_id where c.slug='welcome' order by r.revision desc limit 1`);
    await client.query(`insert into scheduler_jobs(workspace_id,campaign_revision_id,oa_integration_id,mode,status,scheduled_at,available_at,time_zone,idempotency_key)
      select $1,$2,$3,'DRY_RUN','SCHEDULED',now()+interval '75 minutes',now()+interval '75 minutes','Asia/Bangkok',gen_random_uuid()
      where not exists (select 1 from scheduler_jobs j join campaign_revisions existing_revision on existing_revision.id=j.campaign_revision_id where existing_revision.campaign_id=(select campaign_id from campaign_revisions where id=$2) and j.status in ('QUEUED','SCHEDULED'))`, [workspaceId, welcome.rows[0].id, oa.rows[0].id]);
    await client.query(`insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) values ($1,'seed','STAGING_SEEDED','workspace',$2,'{"detail":"Phase 2 staging seed completed"}'::jsonb)`, [workspaceId, String(workspaceId)]);
    await client.query('commit');
    return { workspaceId, adminEmail: email, campaigns: manifest.campaigns.length };
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
