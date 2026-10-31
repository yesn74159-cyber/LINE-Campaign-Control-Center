#!/usr/bin/env node
// Logical backup of the staging database before any migration. The connection
// string is passed through the environment, never on the command line, and is
// never printed.
//   BACKUP_DATABASE_URL=... npm run db:backup -- --out staging-backups --confirm
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const confirmed = args.includes('--confirm');
const outDir = path.resolve(valueOf('--out', 'staging-backups'));
const url = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;

if (!confirmed) {
  console.error('Refusing to run without --confirm (this writes a database dump).');
  process.exit(2);
}
if (!url) {
  console.error('BACKUP_DATABASE_URL or DATABASE_URL must be set.');
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error('Backup URL must be a postgres:// connection string.');
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(outDir, `${stamp}.dump`);
const result = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file], {
  env: { ...process.env, PGDATABASE: url },
  stdio: ['ignore', 'inherit', 'inherit']
});

if (result.error?.code === 'ENOENT') {
  console.error('pg_dump was not found on PATH. Install the PostgreSQL client tools and retry.');
  process.exit(2);
}
if (result.status !== 0) {
  fs.rmSync(file, { force: true });
  console.error(`pg_dump failed with exit code ${result.status}.`);
  process.exit(1);
}

const buffer = fs.readFileSync(file);
if (buffer.length < 64 || buffer.subarray(0, 5).toString() !== 'PGDMP') {
  fs.rmSync(file, { force: true });
  console.error('Dump does not look like a PostgreSQL custom-format archive.');
  process.exit(1);
}
const digest = crypto.createHash('sha256').update(buffer).digest('hex');
fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`);
console.log(`backup written: ${file}`);
console.log(`bytes=${buffer.length} sha256=${digest}`);
