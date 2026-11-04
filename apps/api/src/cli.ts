import fs from 'node:fs';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { readDeliveryHealth, opsThresholds } from './opsHealth.js';
import {
  alertWebhookUrl,
  opsAlertFormatFor,
  opsAlertSignature,
  opsTelegramChatId,
  sendOpsAlert,
  shouldSendOpsAlert,
  type OpsAlertState
} from './opsNotify.js';
import { rotationKeys, rotateVault } from './vaultRotate.js';
import { recheckOaAccessToken, vaultKey } from './lineOaConnect.js';
import { seedStaging } from './seed.js';
import { pruneHistory } from './retention.js';

function readAlertState(file: string): OpsAlertState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OpsAlertState>;
    if (typeof parsed.signature === 'string' && typeof parsed.notifiedAt === 'string') {
      return { signature: parsed.signature, notifiedAt: parsed.notifiedAt };
    }
  } catch {
    // Missing or corrupt state means "nothing notified yet"; the next send rewrites it.
  }
  return null;
}

function writeAlertState(file: string, state: OpsAlertState) {
  try {
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    // Dedupe is best effort: losing the file only costs a repeated message.
  }
}

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
      // The cron runs this every five minutes, so a missing webhook is a report, not a
      // crash: the operator sees it in the log and the alert state stays untouched.
      const statePath = (process.env.OPS_ALERT_STATE_FILE || '').trim();
      const webhookUrl = alertWebhookUrl();
      const decision = shouldSendOpsAlert(health, statePath ? readAlertState(statePath) : null);
      if (!decision.send) console.error(JSON.stringify({ notified: false, reason: decision.reason }));
      else if (!webhookUrl) { console.error(JSON.stringify({ notified: false, reason: 'OPS_ALERT_WEBHOOK_URL is not set' })); process.exitCode = 1; }
      else {
        const format = opsAlertFormatFor(webhookUrl);
        const chatId = format === 'telegram' ? opsTelegramChatId() : null;
        if (format === 'telegram' && !chatId) { console.error(JSON.stringify({ notified: false, reason: 'OPS_TELEGRAM_CHAT_ID is not set' })); process.exitCode = 1; }
        else {
          const delivery = await sendOpsAlert(webhookUrl, health, { format, chatId });
          console.error(JSON.stringify({ notified: delivery.delivered, status: delivery.status }));
          if (delivery.delivered && statePath) writeAlertState(statePath, { signature: opsAlertSignature(health), notifiedAt: new Date().toISOString() });
          if (!delivery.delivered) process.exitCode = 1;
        }
      }
    }
    if (!health.ok) process.exitCode = 1;
  }
  else if (command === 'oa-token-check') {
    // Read-only: bot info GET per enabled staging OA. It updates the check timestamps but never
    // `enabled` or the connection status, and it never sends a message.
    const key = vaultKey();
    const oas = await database.pool.query<{ workspace_id: string; id: string; display_name: string }>(
      "select workspace_id, id, display_name from oa_integrations where environment='STAGING' and enabled order by created_at"
    );
    const results = [];
    for (const oa of oas.rows) {
      try {
        const checked = await recheckOaAccessToken(database.pool, { workspaceId: oa.workspace_id, oaId: oa.id, key, actor: 'ops:cli' });
        results.push({ oaId: checked.oaId, displayName: checked.displayName, ok: true, basicId: checked.basicId, checkedAt: checked.checkedAt });
      } catch (error) {
        results.push({ oaId: oa.id, displayName: oa.display_name, ok: false, error: error instanceof Error ? error.message : 'check failed' });
      }
    }
    console.log(JSON.stringify({ checked: results }));
    if (results.some((item) => !item.ok)) process.exitCode = 1;
  }
  else if (command === 'rotate-vault') {
    const dryRun = !process.argv.includes('--confirm');
    const keys = rotationKeys();
    console.log(JSON.stringify(await rotateVault(database.pool, { ...keys, dryRun })));
  }
  else if (command === 'prune') {
    // There is no default window: deleting history is only ever done with a stated number of days.
    const daysAt = process.argv.indexOf('--days');
    if (daysAt === -1 || process.argv[daysAt + 1] === undefined) throw new Error('prune requires --days N (for example: prune --days 90 --dry-run)');
    const days = Number(process.argv[daysAt + 1]);
    console.log(JSON.stringify(await pruneHistory(database.pool, { days, dryRun: process.argv.includes('--dry-run') })));
  }
  else throw new Error(`unknown database command: ${command}`);
} finally { await database.close(); }
