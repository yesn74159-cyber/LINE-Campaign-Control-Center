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

export type OpsAlertFormat = 'generic' | 'slack' | 'discord';

export function opsAlertFormat(raw = process.env.OPS_ALERT_FORMAT): OpsAlertFormat {
  const value = (raw || 'generic').trim().toLowerCase();
  if (value !== 'generic' && value !== 'slack' && value !== 'discord') {
    throw new Error('OPS_ALERT_FORMAT must be generic, slack or discord');
  }
  return value;
}

export function opsAlertMessage(health: DeliveryHealth): string {
  const counts = health.counts;
  return [
    'LINE Campaign Control Center',
    health.alerts.join(', '),
    `pending=${counts.pending} sending=${counts.sending} retryable=${counts.retryable} unknown=${counts.unknown} stuck=${counts.stuck} failed=${counts.failed}`,
    `workerStale=${health.workerStale} oldestPendingSeconds=${health.oldestPendingSeconds ?? 'n/a'}`
  ].join(' | ');
}

export function buildOpsAlertBody(format: OpsAlertFormat, health: DeliveryHealth): unknown {
  if (format === 'slack') return { text: opsAlertMessage(health) };
  if (format === 'discord') return { content: opsAlertMessage(health) };
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

export async function sendOpsAlert(
  webhookUrl: string,
  health: DeliveryHealth,
  options: { transport?: typeof fetch; format?: OpsAlertFormat } = {}
): Promise<{ delivered: boolean; status: number | null }> {
  const transport = options.transport || fetch;
  const format = options.format || 'generic';
  try {
    const response = await transport(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'line-ccc-ops/1' },
      body: JSON.stringify(buildOpsAlertBody(format, health)),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000)
    });
    return { delivered: response.ok, status: response.status };
  } catch {
    return { delivered: false, status: null };
  }
}
