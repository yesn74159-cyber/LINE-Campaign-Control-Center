import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

function serviceBlock(compose, name) {
  const marker = `\n  ${name}:`;
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, `compose service ${name} must exist`);
  const rest = compose.slice(start + 1);
  const end = rest.search(/\n  [a-zA-Z0-9_-]+:\n|\nvolumes:/);
  return end === -1 ? rest : rest.slice(0, end);
}

test('CI runs every guarded PostgreSQL suite against a disposable database', () => {
  const workflow = read('.github/workflows/staging-ci.yml');
  assert.match(workflow, /^on:\n  pull_request:/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group: staging-ci-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /NODE_VERSION: '22'/);
  assert.match(workflow, /APP_MODE: DRY_RUN/);
  assert.match(workflow, /LINE_LIVE_ENABLED: 'false'/);
  assert.match(workflow, /LINE_WEBHOOK_ENABLED: 'false'/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);

  const serviceDbs = [...workflow.matchAll(/POSTGRES_DB: (line_ccc_[a-z0-9_]+)/g)].map((match) => match[1]);
  assert.equal(serviceDbs.length, 8, 'eight disposable PostgreSQL services are expected');
  assert.equal(new Set(serviceDbs).size, serviceDbs.length, 'service databases must be unique per job');
  assert.ok(serviceDbs.every((name) => name.endsWith('_qa_ci')), 'every CI database must end with _qa_ci');

  for (const match of workflow.matchAll(/--health-cmd "pg_isready -U line_ccc -d ([a-z0-9_]+)"/g)) {
    assert.ok(serviceDbs.includes(match[1]), `health check database ${match[1]} must match a service database`);
  }
  assert.equal([...workflow.matchAll(/--health-cmd "pg_isready/g)].length, serviceDbs.length, 'each service must have a matching health check');
  assert.doesNotMatch(workflow, /line_campaign_ccc/, 'the old health-check database name must be gone');

  for (const target of ['test:line-login:postgres', 'test:referral:postgres', 'test:webhook:postgres', 'test:delivery:postgres', 'phase4a.integration.test.mjs', 'phase4b.integration.test.mjs', 'integration.test.mjs']) {
    assert.ok(workflow.includes(target), `CI must run ${target}`);
  }
  const tenantJob = workflow.slice(workflow.indexOf('  postgres-tenant:'), workflow.indexOf('  postgres-phase4a:'));
  assert.match(tenantJob, /npm run db:migrate/, 'migrations must replay from an empty database');
  assert.ok(tenantJob.indexOf('npm run db:migrate') < tenantJob.indexOf('multitenant-foundation.integration.test.mjs'));

  const e2eJob = workflow.slice(workflow.indexOf('  admin-e2e:'));
  assert.match(e2eJob, /npx playwright install --with-deps chromium/);
  assert.match(e2eJob, /npm run dev:api/);
  assert.match(e2eJob, /npm run dev:admin/);
  assert.match(e2eJob, /npm run test:e2e/);
  assert.match(e2eJob, /actions\/upload-artifact@v4/);
  assert.match(e2eJob, /qa-screenshots/);
});

test('Compose keeps only Caddy public and the worker private', () => {
  const compose = read('docker-compose.staging.yml');
  const caddy = serviceBlock(compose, 'caddy');
  const api = serviceBlock(compose, 'api');
  const worker = serviceBlock(compose, 'worker');
  const admin = serviceBlock(compose, 'admin');
  const postgres = serviceBlock(compose, 'postgres');

  assert.match(caddy, /"80:80"/);
  assert.match(caddy, /"443:443"/);
  assert.match(caddy, /deploy\/Caddyfile/);
  assert.match(caddy, /caddy:2\.8-alpine/);
  assert.doesNotMatch(api, /^\s+ports:/m, 'the API must not publish ports');
  assert.doesNotMatch(worker, /^\s+ports:/m, 'the worker must not publish ports');
  assert.doesNotMatch(admin, /^\s+ports:/m, 'admin is reached through Caddy only');
  assert.match(postgres, /127\.0\.0\.1:55433:5432/, 'PostgreSQL is loopback-only');
  assert.match(worker, /command: \["node", "dist\/api\/worker\.js"\]/);
  assert.match(worker, /APP_MODE: DRY_RUN/);
  assert.match(worker, /LINE_LIVE_ENABLED: "false"/);
  assert.match(worker, /LINE_WEBHOOK_ENABLED: "false"/);
  assert.match(compose, /env_file:\n\s+- \.env\.staging/);
  assert.match(compose, /read_only: true/);
  assert.match(worker, /stop_grace_period: 30s/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /tmpfs:\n\s+- \/tmp/);
  assert.match(compose, /condition: service_healthy/);
  assert.ok(!/DATABASE_URL:.*REPLACE_ME/.test(compose), 'compose must not embed database credentials');
});

test('Deployment assets keep secrets out of build layers and add edge protection', () => {
  const dockerfile = read('deploy/Dockerfile');
  const nginx = read('deploy/nginx.conf');
  const caddy = read('deploy/Caddyfile');
  const dockerignore = read('.dockerignore');
  const envExample = read('deploy/staging.env.example');

  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/);
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS api/);
  assert.match(dockerfile, /FROM nginx:1\.27-alpine AS admin/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /COPY db \.\/db/);
  assert.doesNotMatch(dockerfile, /LINE_CHANNEL_SECRET|ACCESS_TOKEN|ENCRYPTION_KEY|PASSWORD=/);

  assert.match(nginx, /limit_req_zone .* rate=15r\/s/);
  assert.match(nginx, /limit_req zone=api_rate burst=30 nodelay/);
  assert.match(nginx, /Content-Security-Policy/);
  assert.match(nginx, /X-Frame-Options "DENY"/);
  assert.match(nginx, /X-Content-Type-Options "nosniff"/);
  assert.match(nginx, /proxy_pass http:\/\/api:8787/);
  assert.match(nginx, /location ~ \/\\\. \{\n\s+deny all;/);
  assert.doesNotMatch(nginx, /proxy_pass https:\/\/api/);

  assert.match(caddy, /reverse_proxy admin:8080/);
  assert.match(caddy, /tls \{\$CADDY_TLS:internal\}/);
  assert.match(caddy, /Strict-Transport-Security/);
  assert.doesNotMatch(caddy, /reverse_proxy (api|worker):/, 'Caddy must not expose the API or worker directly');

  for (const entry of ['.env', 'node_modules', 'staging-backups', 'qa-screenshots']) {
    assert.ok(dockerignore.split('\n').includes(entry), `.dockerignore must exclude ${entry}`);
  }

  for (const line of ['LINE_LIVE_ENABLED=false', 'LINE_WEBHOOK_ENABLED=false', 'LINE_LOGIN_ENABLED=false']) {
    assert.ok(envExample.includes(line), `staging env example must keep ${line}`);
  }
  assert.match(envExample, /TRUST_PROXY=true/);
  for (const secret of ['POSTGRES_PASSWORD=', 'STAGING_ADMIN_PASSWORD=', 'LINE_CREDENTIAL_ENCRYPTION_KEY=', 'LINE_LOGIN_CHANNEL_SECRET=']) {
    const line = envExample.split('\n').find((value) => value.startsWith(secret));
    assert.ok(line, `missing ${secret}`);
    assert.equal(line, secret, `${secret} must stay blank in the example`);
  }
});

test('Fastify trusts forwarded client addresses only when explicitly enabled', () => {
  const server = read('apps/api/src/server.ts');
  assert.match(server, /trustProxy: process\.env\.TRUST_PROXY === 'true'/);
  assert.match(server, /app\.get\('\/api\/ops\/delivery-health', \{ preHandler: authorize\('read'\) \}/);
});

test('fresh database setup creates a login-ready workspace', () => {
  const migration = read('db/migrations/010_referral_reporting_indexes.sql');
  const unique = migration.indexOf('staff_invite_links_id_workspace_uq');
  const compositeFk = migration.indexOf('references staff_invite_links(id, workspace_id)');
  assert.notEqual(unique, -1, '010 must create the composite unique index');
  assert.notEqual(compositeFk, -1, '010 must keep the composite foreign key');
  assert.ok(unique < compositeFk, 'unique index must precede the foreign key that depends on it');

  const seed = read('apps/api/src/seed.ts');
  const memberships = seed.match(/insert into workspace_memberships/g) || [];
  assert.ok(memberships.length >= 2, 'seed must activate membership for admin and viewer');
  assert.match(seed, /returning id`, \[workspaceId, email/);
  assert.match(seed, /returning id`, \[workspaceId, viewerEmail/);
});

test('delivery health reports alerts without leaking recipient data', async () => {
  const { readDeliveryHealth, opsThresholds } = await import('../dist/api/opsHealth.js');
  assert.throws(() => opsThresholds({ OPS_STUCK_MINUTES: '0' }), /OPS_STUCK_MINUTES/);
  assert.throws(() => opsThresholds({ OPS_QUOTA_WARN_PERCENT: '101' }), /OPS_QUOTA_WARN_PERCENT/);
  assert.deepEqual(opsThresholds({}), { stuckMinutes: 15, workerStaleMinutes: 10, quotaWarnPercent: 80 });

  const stale = new Date(Date.now() - 60 * 60 * 1000);
  const unhealthyPool = {
    async query(sql) {
      if (sql.includes('from outbox_deliveries')) {
        return { rows: [{ pending: 2, sending: 1, retryable: 0, unknown: 1, sent: 4, failed: 0, skipped: 0, stuck: 2, oldest_pending_seconds: 3600, last_worker_activity: stale }] };
      }
      return { rows: [{ id: 'oa-1', display_name: 'QA OA', quota_per_minute: 10, monthly_quota: 1000, monthly_used: 850, used_this_minute: 10 }] };
    }
  };
  const unhealthy = await readDeliveryHealth(unhealthyPool, { thresholds: opsThresholds({}) });
  assert.equal(unhealthy.ok, false);
  assert.deepEqual(unhealthy.alerts.sort(), ['OA_RATE_LIMIT_REACHED', 'QUOTA_NEAR_LIMIT', 'STUCK_DELIVERIES', 'UNKNOWN_DELIVERIES', 'WORKER_STALE']);
  assert.equal(unhealthy.counts.stuck, 2);
  assert.equal(unhealthy.oldestPendingSeconds, 3600);
  assert.equal(unhealthy.workerStale, true);
  assert.equal(unhealthy.quota[0].monthlyPercent, 85);
  assert.ok(!JSON.stringify(unhealthy).includes('U'.repeat(32)), 'health payloads must not contain recipient identifiers');

  const healthyPool = {
    async query(sql) {
      if (sql.includes('from outbox_deliveries')) {
        return { rows: [{ pending: 0, sending: 0, retryable: 0, unknown: 0, sent: 1, failed: 0, skipped: 0, stuck: 0, oldest_pending_seconds: null, last_worker_activity: new Date() }] };
      }
      return { rows: [] };
    }
  };
  const healthy = await readDeliveryHealth(healthyPool, { workspaceId: '00000000-0000-0000-0000-000000000000', thresholds: opsThresholds({}) });
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.alerts, []);
  assert.equal(healthy.workerStale, false);
});

test('staging smoke passes against a local memory API and stays secret-free', async () => {
  const password = randomBytes(18).toString('base64url');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ['dist/api/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PERSISTENCE: 'memory',
      APP_MODE: 'DRY_RUN',
      HOST: '127.0.0.1',
      PORT: String(port),
      MEMORY_ADMIN_EMAIL: 'smoke@local.test',
      MEMORY_ADMIN_PASSWORD: password,
      LINE_LIVE_ENABLED: 'false',
      LINE_WEBHOOK_ENABLED: 'false',
      LINE_LOGIN_ENABLED: 'false',
      CORS_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(ready, true, `memory API did not start: ${serverLog}`);

    const run = spawnSync(process.execPath, ['scripts/staging-smoke.mjs'], {
      cwd: root,
      env: { ...process.env, SMOKE_BASE_URL: `http://127.0.0.1:${port}`, SMOKE_ADMIN_EMAIL: '', SMOKE_ADMIN_PASSWORD: '' },
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS health responds/);
    assert.match(run.stdout, /PASS APP_MODE is DRY_RUN/);
    assert.match(run.stdout, /PASS LINE Login stays disabled/);
    assert.match(run.stdout, /PASS dashboard requires a session/);
    assert.match(run.stdout, /skipped \(SMOKE_ADMIN_EMAIL\/PASSWORD not set\)/);
    assert.ok(!run.stdout.includes(password), 'smoke output must never print the memory password');
    assert.ok(!run.stdout.includes('ccc_session='), 'smoke output must never print session cookies');
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
});

test('backup, restore and cloud audit scripts refuse unsafe invocations', () => {
  const baseEnv = { ...process.env };
  delete baseEnv.BACKUP_DATABASE_URL;
  delete baseEnv.DATABASE_URL;
  delete baseEnv.RESTORE_DATABASE_URL;
  delete baseEnv.AUDIT_DATABASE_URL;

  const backupNoConfirm = spawnSync(process.execPath, ['scripts/db-backup.mjs'], { cwd: root, env: baseEnv, encoding: 'utf8' });
  assert.equal(backupNoConfirm.status, 2);
  assert.match(backupNoConfirm.stderr, /without --confirm/);

  const backupNoUrl = spawnSync(process.execPath, ['scripts/db-backup.mjs', '--confirm'], { cwd: root, env: baseEnv, encoding: 'utf8' });
  assert.equal(backupNoUrl.status, 2);
  assert.match(backupNoUrl.stderr, /BACKUP_DATABASE_URL|DATABASE_URL/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-ccc-phase5e-'));
  const dump = path.join(tempDir, 'scratch.dump');
  fs.writeFileSync(dump, 'not-a-real-dump');

  const restoreNoConfirm = spawnSync(process.execPath, ['scripts/db-restore.mjs', '--file', dump], { cwd: root, env: baseEnv, encoding: 'utf8' });
  assert.equal(restoreNoConfirm.status, 2);
  assert.match(restoreNoConfirm.stderr, /--confirm-restore/);

  const restoreSameUrl = spawnSync(process.execPath, ['scripts/db-restore.mjs', '--file', dump, '--confirm-restore'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...baseEnv, BACKUP_DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/line_ccc_restore_drill', RESTORE_DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/line_ccc_restore_drill' }
  });
  assert.equal(restoreSameUrl.status, 2);
  assert.match(restoreSameUrl.stderr, /source database/);

  const restoreProdName = spawnSync(process.execPath, ['scripts/db-restore.mjs', '--file', dump, '--confirm-restore'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...baseEnv, RESTORE_DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/line_campaign_ccc' }
  });
  assert.equal(restoreProdName.status, 2);
  assert.match(restoreProdName.stderr, /must contain restore, drill or scratch/);
  fs.rmSync(tempDir, { recursive: true, force: true });

  const auditNoConfirm = spawnSync(process.execPath, ['scripts/cloud-audit.mjs'], { cwd: root, env: baseEnv, encoding: 'utf8' });
  assert.equal(auditNoConfirm.status, 2);
  assert.match(auditNoConfirm.stderr, /without --confirm/);

  const auditNoUrl = spawnSync(process.execPath, ['scripts/cloud-audit.mjs', '--confirm'], { cwd: root, env: baseEnv, encoding: 'utf8' });
  assert.equal(auditNoUrl.status, 2);
  assert.match(auditNoUrl.stderr, /AUDIT_DATABASE_URL/);
});

test('cloud audit SQL is read-only and checks ledger, RLS, grants, indexes and parity', () => {
  const sql = read('db/audit/read-only-audit.sql');
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--') && !line.trimStart().startsWith('\\'))
    .join('\n')
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  assert.ok(statements.length >= 8);
  for (const statement of statements) {
    assert.match(statement, /^(select|with)\b/i, `read-only audit contains a non-SELECT statement: ${statement.slice(0, 60)}`);
  }
  assert.match(sql, /012_account_invites\.sql/);
  assert.match(sql, /relrowsecurity/);
  assert.match(sql, /pg_policies/);
  assert.match(sql, /role_table_grants/);
  assert.match(sql, /indkey\[0\] = con\.conkey\[1\]/);
  assert.match(sql, /MISSING/);
  assert.doesNotMatch(sql, /token_sealed|secret_sealed/);
});
