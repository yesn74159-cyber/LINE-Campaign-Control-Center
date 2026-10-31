#!/usr/bin/env node
// Runs db/audit/read-only-audit.sql inside a READ ONLY transaction. Refuses any
// statement that is not a SELECT/WITH. The connection string is never printed.
//   AUDIT_DATABASE_URL=... npm run audit:cloud -- --confirm --role line_ccc
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (!args.includes('--confirm')) {
  console.error('Refusing to connect without --confirm (read-only queries only).');
  process.exit(2);
}
const url = process.env.AUDIT_DATABASE_URL;
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error('AUDIT_DATABASE_URL must be set to a postgres:// read-only connection.');
  process.exit(2);
}
const role = valueOf('--role', 'line_ccc');
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role)) {
  console.error('--role must be a plain PostgreSQL identifier.');
  process.exit(2);
}
const sqlFile = path.resolve(valueOf('--file', 'db/audit/read-only-audit.sql'));
const raw = fs.readFileSync(sqlFile, 'utf8');

const statements = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('\\'))
  .join('\n')
  .split(';')
  .map((chunk) => chunk.replace(/:role/g, `'${role}'`).replace(/:'?audit_role'?/g, `'${role}'`).trim())
  .filter(Boolean);

const forbidden = statements.filter((statement) => {
  const head = statement.replace(/^(--[^\n]*\n|\s)+/g, '').toLowerCase();
  return !head.startsWith('select') && !head.startsWith('with');
});
if (forbidden.length) {
  console.error(`Refusing to run ${forbidden.length} non-SELECT statement(s) from ${path.basename(sqlFile)}.`);
  process.exit(2);
}

const pool = new Pool({ connectionString: url, max: 1, statement_timeout: 20000, application_name: 'line-ccc-read-only-audit' });
const client = await pool.connect().catch((error) => {
  console.error(`could not connect: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
const output = {};
try {
  await client.query('begin read only');
  await client.query('set local statement_timeout = 20000');
  for (const [index, statement] of statements.entries()) {
    const label = (statement.match(/^\s*select\s+([a-z_]+)/i)?.[1] || `query_${index + 1}`).toLowerCase();
    const key = output[label] ? `${label}_${index + 1}` : label;
    const result = await client.query(statement);
    output[key] = result.rows;
  }
  await client.query('rollback');
} catch (error) {
  output.error = error instanceof Error ? error.message : 'audit query failed';
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
console.log(JSON.stringify(output, null, 2));
