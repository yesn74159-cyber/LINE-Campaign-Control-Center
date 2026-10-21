import { useEffect, useState } from 'react';
import { apiUrl } from './apiClient.js';

type Connection = {
  oaId: string; displayName: string; basicId: string;
  accessTokenCheckedAt: string | null; storedEncrypted: boolean; channelStatus: string | null;
};
async function request<T>(url: string): Promise<T> {
  const response = await fetch(apiUrl(url), { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(failure?.error || 'Request failed (' + response.status + ')');
  }
  return response.json() as Promise<T>;
}

export default function ConnectLineOa({ isOwner }: { isOwner: boolean }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState('');

  async function load() {
    try {
      const result = await request<{ connections: Connection[] }>('/api/workspace/oa-connect/status');
      setConnections(result.connections);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load OA status'); }
  }
  useEffect(() => { if (isOwner) void load(); }, [isOwner]);

  return <section className="panel">
    <p className="eyebrow green">LINE LOGIN MOCK / LIVE DISABLED</p>
    <h3>LINE OA connection status</h3>
    <p>รอบ Local Development นี้ไม่รับ ไม่แสดง และไม่ส่งต่อ Channel Access Token หรือ Channel Secret จากหน้าเว็บ</p>
    <p className="form-note"><strong>NO SECRET INPUT</strong> · OAuth จริง, LINE API จริง และ Live Webhook ถูกปิด</p>
    {!isOwner && <p>เฉพาะ Owner ของ Workspace เท่านั้นที่ดูสถานะ connection ได้</p>}
    {error && <p role="alert" className="auth-error">{error}</p>}
    <h4>LINE OA ใน Workspace นี้</h4>
    <div className="tenant-table-wrap"><table className="tenant-table">
      <thead><tr><th>LINE OA</th><th>Credential</th><th>Webhook</th><th>ส่งข้อความ</th></tr></thead>
      <tbody>{connections.map(row=><tr key={row.oaId}>
        <td>{row.displayName} ({row.basicId})</td>
        <td>{row.storedEncrypted && row.accessTokenCheckedAt ? 'มี reference ฝั่ง server' : 'Mock / ไม่ตั้งค่า'}</td>
        <td>{row.channelStatus || 'LIVE DISABLED'}</td><td>ปิด</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
