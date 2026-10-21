import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

export async function runMigrations(pool: Pool) {
  const root = path.resolve(process.cwd(), 'db', 'migrations');
  const files = (await fs.readdir(root)).filter((file) => file.endsWith('.sql')).sort();
  await pool.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
  for (const file of files) {
    const already = await pool.query('select 1 from schema_migrations where version=$1', [file]);
    if (already.rowCount) continue;
    const sql = await fs.readFile(path.join(root, file), 'utf8');
    const client = await pool.connect();
    try { await client.query('begin'); await client.query(sql); await client.query('insert into schema_migrations(version) values ($1)', [file]); await client.query('commit'); }
    catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  return files;
}
