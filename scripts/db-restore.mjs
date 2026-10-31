#!/usr/bin/env node
// Restore drill only. Target must be a disposable database whose name contains
// restore, drill or scratch. The source production/staging URL is never a valid
// target, and the connection string is never printed.
//   RESTORE_DATABASE_URL=postgres://.../line_ccc_restore_drill \
//   npm run db:restore -- --file staging-backups/<dump> --confirm-restore
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : '';
};
const confirmed = args.includes('--confirm-restore');
const file = valueOf('--file');
const target = process.env.RESTORE_DATABASE_URL || '';
const source = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL || '';

if (!confirmed) {
  console.error('Refusing to restore without --confirm-restore.');
  process.exit(2);
}
if (!file || !fs.existsSync(file)) {
  console.error('--file must point at an existing custom-format dump.');
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//.test(target)) {
  console.error('RESTORE_DATABASE_URL must be set to a disposable postgres:// database.');
  process.exit(2);
}
if (target === source) {
  console.error('Refusing to restore over the source database.');
  process.exit(2);
}

let targetDb = '';
try {
  targetDb = new URL(target).pathname.replace(/^\//, '');
} catch {
  console.error('RESTORE_DATABASE_URL is not a valid URL.');
  process.exit(2);
}
if (!/restore|drill|scratch/i.test(targetDb)) {
  console.error(`Refusing target database "${targetDb}": the name must contain restore, drill or scratch.`);
  process.exit(2);
}

const checksumFile = `${file}.sha256`;
if (fs.existsSync(checksumFile)) {
  const expected = fs.readFileSync(checksumFile, 'utf8').split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (expected !== actual) {
    console.error('Dump checksum does not match; refusing to restore.');
    process.exit(1);
  }
  console.log('checksum verified');
}

const result = spawnSync('pg_restore', [
  '--clean', '--if-exists', '--no-owner', '--no-privileges',
  '--single-transaction', '--exit-on-error', file
], {
  env: { ...process.env, PGDATABASE: target },
  stdio: ['ignore', 'inherit', 'inherit']
});

if (result.error?.code === 'ENOENT') {
  console.error('pg_restore was not found on PATH. Install the PostgreSQL client tools and retry.');
  process.exit(2);
}
if (result.status !== 0) {
  console.error(`pg_restore failed with exit code ${result.status}.`);
  process.exit(1);
}
console.log(`restore completed into disposable database "${targetDb}"`);
console.log(`verify with: psql ... -c "select count(*) from schema_migrations"`);
