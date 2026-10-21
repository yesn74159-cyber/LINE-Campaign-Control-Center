import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { seedStaging } from './seed.js';

const database = createDatabase();
if (!database.pool) throw new Error('DATABASE_URL is required for database commands');
const command = process.argv[2] || 'setup';
try {
  if (command === 'migrate') console.log(JSON.stringify({ migrated: await runMigrations(database.pool) }));
  else if (command === 'seed') console.log(JSON.stringify(await seedStaging(database.pool)));
  else if (command === 'setup') { const migrated = await runMigrations(database.pool); const seeded = await seedStaging(database.pool); console.log(JSON.stringify({ migrated, seeded })); }
  else throw new Error(`unknown database command: ${command}`);
} finally { await database.close(); }
