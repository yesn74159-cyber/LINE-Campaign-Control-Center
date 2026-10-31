import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { readDeliveryHealth, opsThresholds } from './opsHealth.js';
import { alertWebhookUrl, opsAlertFormat, sendOpsAlert } from './opsNotify.js';
import { rotationKeys, rotateVault } from './vaultRotate.js';
import { seedStaging } from './seed.js';

const database = createDatabase();
if (!database.pool) throw new Error('DATABASE_URL is required for database commands');
const command = process.argv[2] || 'setup';
try {
  if (command === 'migrate') console.log(JSON.stringify({ migrated: await runMigrations(database.pool) }));
  else if (command === 'seed') console.log(JSON.stringify(await seedStaging(database.pool)));
  else if (command === 'setup') { const migrated = await runMigrations(database.pool); const seeded = await seedStaging(database.pool); console.log(JSON.stringify({ migrated, seeded })); }
  else if (command === 'ops') {
    const health = await readDeliveryHealth(database.pool, { thresholds: opsThresholds() });
    console.log(JSON.stringify(health));
    if (process.argv.includes('--notify')) {
      const webhookUrl = alertWebhookUrl();
      if (!webhookUrl) throw new Error('OPS_ALERT_WEBHOOK_URL is required for ops --notify');
      if (health.alerts.length) {
        const delivery = await sendOpsAlert(webhookUrl, health, { format: opsAlertFormat() });
        console.error(JSON.stringify({ notified: delivery.delivered, status: delivery.status }));
        if (!delivery.delivered) process.exitCode = 1;
      } else {
        console.error(JSON.stringify({ notified: false, reason: 'no alerts' }));
      }
    }
    if (!health.ok) process.exitCode = 1;
  }
  else if (command === 'rotate-vault') {
    const dryRun = !process.argv.includes('--confirm');
    const keys = rotationKeys();
    console.log(JSON.stringify(await rotateVault(database.pool, { ...keys, dryRun })));
  }
  else throw new Error(`unknown database command: ${command}`);
} finally { await database.close(); }
