import { createHash } from 'node:crypto';
import type { DeliveryHealth } from './opsHealth.js';

export type OpsAlertEnvelope = {
  source: 'line-campaign-control-center';
  generatedAt: string;
  alerts: string[];
  counts: DeliveryHealth['counts'];
  workerStale: boolean;
  oldestPendingSeconds: number | null;
  quota: Array<{ monthlyPercent: number; usedThisMinute: number; limitPerMinute: number }>;
};

export type OpsAlertFormat = 'generic' | 'slack' | 'discord' | 'telegram';

export function opsAlertFormat(raw = process.env.OPS_ALERT_FORMAT || process.env.OPS_ALERT_CHANNEL): OpsAlertFormat {
  const value = (raw || 'generic').trim().toLowerCase();
  if (value !== 'generic' && value !== 'slack' && value !== 'discord' && value !== 'telegram') {
    throw new Error('OPS_ALERT_FORMAT must be generic, slack, discord or telegram');
  }
  return value;
}

/**
 * A Telegram webhook cannot take the generic JSON envelope, and getting the format
 * wrong is a 400 at 3am. When the operator did not pin a format, the URL host decides.
 */
export function opsAlertFormatFor(url: string, raw = process.env.OPS_ALERT_FORMAT || process.env.OPS_ALERT_CHANNEL): OpsAlertFormat {
  if ((raw || '').trim()) return opsAlertFormat(raw);
  try {
    if (new URL(url).hostname === 'api.telegram.org') return 'telegram';
  } catch {
    // alertWebhookUrl already validated the URL; fall through to the envelope.
  }
  return 'generic';
}

export function opsTelegramChatId(raw = process.env.OPS_TELEGRAM_CHAT_ID): string | null {
  const value = (raw || '').trim();
  if (!value) return null;
  if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/.test(value)) throw new Error('OPS_TELEGRAM_CHAT_ID is not a valid chat id');
  return value;
}

export function opsAlertMessage(health: DeliveryHealth): string {
  const counts = health.counts;
  return [
    'LINE Campaign Control Center',
    health.alerts.join(', '),
    `pending=${counts.pending} sending=${counts.sending} retryable=${counts.retryable} unknown=${counts.unknown} stuck=${counts.stuck} failed=${counts.failed}`,
    `dueJobs=${health.dueJobs || 0} workerStale=${health.workerStale} oldestPendingSeconds=${health.oldestPendingSeconds ?? 'n/a'}`
  ].join(' | ');
}

export function buildOpsAlertBody(format: OpsAlertFormat, health: DeliveryHealth, chatId: string | null = null): unknown {
  if (format === 'slack') return { text: opsAlertMessage(health) };
  if (format === 'discord') return { content: opsAlertMessage(health) };
  if (format === 'telegram') {
    if (!chatId) throw new Error('OPS_TELEGRAM_CHAT_ID is required for telegram alerts');
    return { chat_id: chatId, text: opsAlertMessage(health), disable_web_page_preview: true };
  }
  return buildOpsAlert(health);
}

/**
 * Alert payload carries aggregate counters only: no workspace/OA identifiers,
 * recipient keys, payload bodies, cookies, or secrets.
 */
export function buildOpsAlert(health: DeliveryHealth): OpsAlertEnvelope {
  return {
    source: 'line-campaign-control-center',
    generatedAt: health.generatedAt,
    alerts: [...health.alerts],
    counts: { ...health.counts },
    workerStale: health.workerStale,
    oldestPendingSeconds: health.oldestPendingSeconds,
    quota: health.quota.map((item) => ({
      monthlyPercent: item.monthlyPercent,
      usedThisMinute: item.usedThisMinute,
      limitPerMinute: item.limitPerMinute
    }))
  };
}

export type OpsAlertState = { signature: string; notifiedAt: string };

export function opsAlertSignature(health: DeliveryHealth): string {
  return createHash('sha256').update([...health.alerts].sort().join(',')).digest('hex').slice(0, 16);
}

export function opsAlertRepeatMs(raw = process.env.OPS_ALERT_REPEAT_MINUTES): number {
  const value = Number(raw === undefined || raw === '' ? 60 : raw);
  if (!Number.isInteger(value) || value < 1 || value > 10080) throw new Error('OPS_ALERT_REPEAT_MINUTES must be an integer between 1 and 10080');
  return value * 60_000;
}

/**
 * A five-minute cron with a persistent alert would otherwise page the operator every
 * five minutes for the same thing. Send on a new alert set, or when the same set has
 * been standing for OPS_ALERT_REPEAT_MINUTES (default 60).
 */
export function shouldSendOpsAlert(
  health: DeliveryHealth,
  state: OpsAlertState | null,
  input: { now?: Date; repeatMs?: number } = {}
): { send: boolean; reason?: string } {
  if (!health.alerts.length) return { send: false, reason: 'no alerts' };
  if (!state) return { send: true };
  const repeatMs = input.repeatMs ?? opsAlertRepeatMs();
  if (state.signature !== opsAlertSignature(health)) return { send: true };
  const age = (input.now || new Date()).getTime() - Date.parse(state.notifiedAt);
  if (!Number.isFinite(age) || age >= repeatMs) return { send: true };
  return { send: false, reason: 'same alerts already notified' };
}

export function alertWebhookUrl(raw = process.env.OPS_ALERT_WEBHOOK_URL): string | null {
  const value = (raw || '').trim();
  if (!value) return null;
  if (value.length > 2048) throw new Error('OPS_ALERT_WEBHOOK_URL is too long');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OPS_ALERT_WEBHOOK_URL is not a valid URL');
  }
  if (url.username || url.password) throw new Error('OPS_ALERT_WEBHOOK_URL must not embed credentials');
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('OPS_ALERT_WEBHOOK_URL must use HTTPS (HTTP is allowed only for loopback tests)');
  }
  return url.toString();
}

async function postAlert(
  transport: typeof fetch,
  webhookUrl: string,
  buildBody: () => unknown
): Promise<{ delivered: boolean; status: number | null }> {
  try {
    const response = await transport(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'line-ccc-ops/1' },
      body: JSON.stringify(buildBody()),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000)
    });
    return { delivered: response.ok, status: response.status };
  } catch {
    return { delivered: false, status: null };
  }
}

export async function sendOpsAlert(
  webhookUrl: string,
  health: DeliveryHealth,
  options: { transport?: typeof fetch; format?: OpsAlertFormat; chatId?: string | null } = {}
): Promise<{ delivered: boolean; status: number | null }> {
  const format = options.format || 'generic';
  return postAlert(options.transport || fetch, webhookUrl, () => buildOpsAlertBody(format, health, options.chatId ?? null));
}

/**
 * A failure outside delivery health — the nightly dump did not verify — still has to reach
 * the same room. The envelope carries the text and nothing else; the text is written by the
 * caller and must never contain a token, a URL or a customer row.
 */
export function buildAlertTextBody(format: OpsAlertFormat, text: string, chatId: string | null = null): unknown {
  if (format === 'slack') return { text };
  if (format === 'discord') return { content: text };
  if (format === 'telegram') {
    if (!chatId) throw new Error('OPS_TELEGRAM_CHAT_ID is required for telegram alerts');
    return { chat_id: chatId, text, disable_web_page_preview: true };
  }
  return { source: 'line-campaign-control-center', generatedAt: new Date().toISOString(), text };
}

export async function sendOpsText(
  webhookUrl: string,
  text: string,
  options: { transport?: typeof fetch; format?: OpsAlertFormat; chatId?: string | null } = {}
): Promise<{ delivered: boolean; status: number | null }> {
  const format = options.format || 'generic';
  return postAlert(options.transport || fetch, webhookUrl, () => buildAlertTextBody(format, text, options.chatId ?? null));
}
