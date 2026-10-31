import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from './apiClient.js';

type Delivery = {
  id: string;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'RETRYABLE' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';
  attempts: number;
  recipientKey: string;
  providerStatus?: number;
  providerRequestId?: string;
  lastError?: string;
  updatedAt: string;
};

function csrfToken() {
  return document.cookie.split('; ').find((item) => item.startsWith('ccc_csrf='))?.slice('ccc_csrf='.length) || '';
}

function recipientLabel(key: string) {
  if (key === '__campaign__') return 'PREVIEW · no recipient';
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : key;
}

const statusClass = (status: Delivery['status']) =>
  status === 'SENT' ? 'success' : status === 'UNKNOWN' || status === 'FAILED' ? 'status-error' : status === 'RETRYABLE' || status === 'PENDING' ? 'paused' : 'dry';

export default function DeliveryLedger({ jobId, canWrite }: { jobId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/outbox`), { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error(`โหลด delivery ledger ไม่สำเร็จ (${response.status})`);
      const result = await response.json() as { deliveries: Delivery[] };
      setRows(result.deliveries);
      setError('');
    } catch (reason) {
      setRows([]);
      setError(reason instanceof Error ? reason.message : 'โหลด delivery ledger ไม่สำเร็จ');
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  const reconcile = async (deliveryId: string, status: 'SENT' | 'FAILED') => {
    setBusy(true);
    try {
      const response = await fetch(apiUrl(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/outbox/${encodeURIComponent(deliveryId)}/reconcile`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrfToken()) },
        body: JSON.stringify({ status })
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(failure?.error || `Reconcile ไม่สำเร็จ (${response.status})`);
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reconcile ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return <section className="panel table-panel">
    <div className="panel-head"><div><p className="eyebrow">OUTBOX · PER RECIPIENT</p><h3>Delivery ledger</h3></div><button className="text-btn" onClick={() => void load()}>↻ Refresh</button></div>
    <p className="form-note">บันทึกสถานะต่อผู้รับ พร้อม retry key · ไม่มีChannel Secret หรือ Access Token ใน ledger</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {rows.length > 0 ? <div className="tenant-table-wrap"><table className="tenant-table">
      <thead><tr><th>ผู้รับ</th><th>สถานะ</th><th>Attempts</th><th>LINE</th><th>อัปเดต</th><th /></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td>{recipientLabel(row.recipientKey)}</td>
        <td><span className={`tag ${statusClass(row.status)}`}>{row.status}</span>{row.lastError && <small>{row.lastError}</small>}</td>
        <td>{row.attempts}</td>
        <td>{row.providerStatus ? `${row.providerStatus}${row.providerRequestId ? ` · ${row.providerRequestId}` : ''}` : '—'}</td>
        <td>{new Date(row.updatedAt).toLocaleString('th-TH')}</td>
        <td>{row.status === 'UNKNOWN' && canWrite && <div className="row-actions"><button disabled={busy} onClick={() => void reconcile(row.id, 'SENT')}>ยืนยันว่าส่งแล้ว</button><button disabled={busy} onClick={() => void reconcile(row.id, 'FAILED')}>ทำเครื่องหมายล้มเหลว</button></div>}</td>
      </tr>)}</tbody>
    </table></div> : <div className="empty-inline">ยังไม่มี delivery ในงานนี้ · รัน DRY RUN เพื่อสร้าง ledger</div>}
  </section>;
}
