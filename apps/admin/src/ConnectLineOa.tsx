import { useEffect, useState, type FormEvent } from 'react';
import { apiUrl } from './apiClient.js';

type Connection = {
  oaId: string; displayName: string; basicId: string;
  accessTokenCheckedAt: string | null; storedEncrypted: boolean; channelStatus: string | null; verifiedAt: string | null;
};
type ConnectResponse = {
  oaId: string; displayName: string; basicId: string;
  accessTokenValidated: boolean; webhookSecretValidated: boolean; sendingEnabled: boolean; status: string;
};
function webhookLabel(status: string | null, verifiedAt: string | null) {
  if (status === 'VERIFIED') return verifiedAt ? 'ยืนยัน signed webhook แล้ว · ' + new Date(verifiedAt).toLocaleString('th-TH') : 'ยืนยัน signed webhook แล้ว';
  if (status === 'VERIFY_PENDING') return 'รอ signed webhook แรก';
  return status || 'LIVE DISABLED';
}
async function request<T>(url: string): Promise<T> {
  const response = await fetch(apiUrl(url), { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(failure?.error || 'Request failed (' + response.status + ')');
  }
  return response.json() as Promise<T>;
}
const EMPTY_FORM = { providerId: '', messagingChannelId: '', channelAccessToken: '', channelSecret: '' };

export default function ConnectLineOa({ isOwner }: { isOwner: boolean }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      const result = await request<{ connections: Connection[] }>('/api/workspace/oa-connect/status');
      setConnections(result.connections);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load OA status'); }
  }
  useEffect(() => { if (isOwner) void load(); }, [isOwner]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError(''); setNotice(''); setWebhookUrl('');
    const providerId = form.providerId.trim();
    try {
      const csrf = document.cookie.split('; ').find((item) => item.startsWith('ccc_csrf='))?.slice('ccc_csrf='.length) || '';
      const response = await fetch(apiUrl('/api/workspace/oa-connect'), {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
        body: JSON.stringify({
          providerId,
          messagingChannelId: form.messagingChannelId.trim(),
          channelAccessToken: form.channelAccessToken,
          channelSecret: form.channelSecret,
        }),
      });
      const payload = await response.json().catch(() => null) as (ConnectResponse & { error?: string }) | null;
      if (!response.ok) throw new Error(payload?.error || 'เชื่อมต่อไม่สำเร็จ (' + response.status + ')');
      setForm(EMPTY_FORM);
      setWebhookUrl(`${window.location.origin}/api/webhooks/line/${encodeURIComponent(providerId)}`);
      setNotice(`เชื่อมต่อ ${payload?.displayName || providerId} (${payload?.basicId || ''}) แล้ว — token ผ่านการตรวจจาก LINE, ยังรอ signed webhook แรกเพื่อยืนยัน Channel Secret`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'เชื่อมต่อไม่สำเร็จ'); }
    finally { setSaving(false); }
  }

  async function copyWebhookUrl() {
    try { await navigator.clipboard.writeText(webhookUrl); setNotice('คัดลอก Webhook URL แล้ว — ไปวางใน LINE Developers console แล้วเปิด Use webhook'); }
    catch { setNotice('คัดลอกอัตโนมัติไม่สำเร็จ กรุณาเลือกข้อความในช่องลิงก์แล้วคัดลอกเอง'); }
  }

  return <section className="panel">
    <p className="eyebrow green">LINE OA CONNECT / OWNER ONLY</p>
    <h3>LINE OA connection status</h3>
    <p>กรอก Channel Access Token และ Channel Secret ของ Messaging API channel เพื่อผูก OA จริงกับ Workspace นี้</p>
    <p className="form-note"><strong>OWNER ONLY · ENCRYPTED IN SERVER VAULT</strong> · ค่า secret เข้ารหัสเก็บฝั่ง server, ไม่ถูกแสดงกลับ และยังไม่ส่งข้อความจริงจนกว่าจะเปิดโหมด Live</p>
    {!isOwner && <p>เฉพาะ Owner ของ Workspace เท่านั้นที่ดูสถานะและเชื่อมต่อ LINE OA ได้</p>}
    {notice && <p role="status" className="form-note">{notice}</p>}
    {error && <p role="alert" className="auth-error">{error}</p>}
    {isOwner && <form onSubmit={connect} autoComplete="off" className="stack">
      <label htmlFor="oa-provider-id">Provider ID (ตัวอักษรสำหรับ URL ของ webhook)</label>
      <input id="oa-provider-id" required pattern="[A-Za-z0-9_-]{2,120}" value={form.providerId}
        onChange={(event) => setForm({ ...form, providerId: event.target.value })} placeholder="line-oa-main" />
      <label htmlFor="oa-channel-id">Messaging Channel ID (ตัวเลขจาก LINE Developers console)</label>
      <input id="oa-channel-id" required pattern="[0-9]{5,30}" inputMode="numeric" value={form.messagingChannelId}
        onChange={(event) => setForm({ ...form, messagingChannelId: event.target.value })} placeholder="12345678901" />
      <label htmlFor="live-oa-token">Channel Access Token (ชนิด Long-lived)</label>
      <input id="live-oa-token" type="password" required autoComplete="new-password" value={form.channelAccessToken}
        onChange={(event) => setForm({ ...form, channelAccessToken: event.target.value })} />
      <label htmlFor="live-oa-secret">Channel Secret</label>
      <input id="live-oa-secret" type="password" required autoComplete="new-password" value={form.channelSecret}
        onChange={(event) => setForm({ ...form, channelSecret: event.target.value })} />
      <button type="submit" disabled={saving || !form.providerId || !form.messagingChannelId || !form.channelAccessToken || !form.channelSecret}>
        {saving ? 'กำลังตรวจสอบกับ LINE...' : 'เชื่อมต่อ LINE OA'}
      </button>
    </form>}
    {webhookUrl && <div className="form-note">
      <p>ตั้ง URL นี้เป็น Webhook ใน LINE Developers console ของ channel เดียวกัน แล้วเปิด <strong>Use webhook</strong>:</p>
      <input readOnly value={webhookUrl} onFocus={(event) => event.target.select()} aria-label="LINE webhook URL" />
      <button type="button" onClick={() => void copyWebhookUrl()}>คัดลอก Webhook URL</button>
    </div>}
    <h4>LINE OA ใน Workspace นี้</h4>
    <div className="tenant-table-wrap"><table className="tenant-table">
      <thead><tr><th>LINE OA</th><th>Credential</th><th>Webhook</th><th>ส่งข้อความ</th></tr></thead>
      <tbody>{connections.map(row=><tr key={row.oaId}>
        <td>{row.displayName} ({row.basicId})</td>
        <td>{row.storedEncrypted && row.accessTokenCheckedAt ? 'มี reference ฝั่ง server' : 'Mock / ไม่ตั้งค่า'}</td>
        <td>{webhookLabel(row.channelStatus, row.verifiedAt)}</td><td>ปิด</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
