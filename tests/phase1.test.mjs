import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('phase 1 project bootstrap has runnable scripts and staging defaults', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true);
  assert.match(pkg.scripts.dev, /concurrently/);
  assert.match(pkg.scripts.build, /typecheck/);
  assert.match(read('.env.example'), /APP_MODE=DRY_RUN/);
});

test('admin PWA shell and responsive entrypoint exist', () => {
  assert.match(read('apps/admin/index.html'), /manifest\.webmanifest/);
  assert.match(read('apps/admin/src/main.tsx'), /Flex Studio/);
  assert.match(read('apps/admin/src/styles.css'), /max-width: 680px/);
});

test('API exposes dry-run scheduler safeguards', () => {
  const source = read('apps/api/src/server.ts') + read('apps/api/src/store.ts');
  assert.match(source, /DRY_RUN/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /No LINE Messaging API request was made/);
  assert.doesNotMatch(source, /channelAccessToken|Channel Secret|Bearer [A-Za-z0-9]/i);
});

test('PostgreSQL schema keeps provider-scoped identity and durable job keys', () => {
  const schema = read('db/migrations/001_control_center.sql');
  assert.match(schema, /provider_id text not null/);
  assert.match(schema, /unique \(workspace_id, provider_id, line_user_key\)/);
  assert.match(schema, /idempotency_key uuid not null unique/);
  const claimQuery = read('db/queries/claim_job.sql');
  assert.match(claimQuery, /for update skip locked/i);
});

test('all seven baseline templates remain present', () => {
  const manifest = JSON.parse(read('campaigns.json'));
  assert.equal(manifest.campaigns.length, 7);
  for (const campaign of manifest.campaigns) assert.ok(fs.existsSync(path.join(root, campaign.flexFile)));
});
