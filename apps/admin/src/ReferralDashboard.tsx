import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { referralQrSvg } from './qr.js';
import { apiUrl } from './apiClient.js';

type Staff = { id: string; displayName: string; email: string; active: boolean };
type Oa = { id: string; displayName: string; environment: string; enabled: boolean };
type Channel = { oaId: string; displayName: string; environment: string; enabled: boolean };
type Referral = { id: string; staffId: string; oaId: string; status: string; expiresAt?: string; createdAt: string };
type Row = { staffId: string; staffName: string; email: string; activeLinks: number; clicks: number; logins: number; followVerified: number; conversionRate: number; latestActivity: string | null };
type Created = { referral: Referral; plainToken: string; url: string };

async function request<T>(url: string, method = 'GET', body?: object): Promise<T> {
  const csrf = document.cookie.split('; ').find(item => item.startsWith('ccc_csrf='))?.slice(9);
  const headers = new Headers({ ...(body ? { 'content-type': 'application/json' } : {}) });
  if (csrf && method !== 'GET') headers.set('x-csrf-token', decodeURIComponent(csrf));
  const response = await fetch(apiUrl(url), { method, credentials: 'include', headers, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error || `Request failed (${response.status})`); }
  return response.json() as Promise<T>;
}

function bangkokRange(value: string, endOfDay: boolean) {
  if (!value) return '';
  return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+07:00`).toISOString();
}

export default function ReferralDashboard({ canManage = false }: { canManage?: boolean }) {
  const [staff, setStaff] = useState<Staff[]>([]); const [channels, setChannels] = useState<Channel[]>([]); const [rows, setRows] = useState<Row[]>([]); const [referrals, setReferrals] = useState<Referral[]>([]);
  const [staffId, setStaffId] = useState(''); const [oaId, setOaId] = useState(''); const [filterStaffId, setFilterStaffId] = useState(''); const [filterOaId, setFilterOaId] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [expiresAt, setExpiresAt] = useState(''); const [created, setCreated] = useState<Created | null>(null); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [creating, setCreating] = useState(false);
  const activeStaff = useMemo(() => staff.filter(item => item.active), [staff]);
  const usableChannels = useMemo(() => channels.filter(item => item.enabled), [channels]);

  async function load(filters: { staffId?: string; oaId?: string; from?: string; to?: string } = {}) {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      const query = params.toString() ? `?${params}` : '';
      const [s, o, d, r] = await Promise.all([
        request<{ staff: Staff[] }>('/api/referrals/staff'),
        request<{ oas: Oa[] }>('/api/oas'),
        request<{ rows: Row[] }>(`/api/referral-dashboard${query}`),
        request<{ referrals: Referral[] }>('/api/referrals')
      ]);
      const nextChannels = o.oas.map(item => ({ oaId: item.id, displayName: item.displayName, environment: item.environment, enabled: item.enabled }));
      setStaff(s.staff); setChannels(nextChannels); setRows(d.rows); setReferrals(r.referrals);
      setStaffId(previous => s.staff.some(item => item.id === previous && item.active) ? previous : (s.staff.find(item => item.active)?.id || ''));
      setOaId(previous => nextChannels.some(item => item.oaId === previous && item.enabled) ? previous : (nextChannels.find(item => item.enabled)?.oaId || ''));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'โหลด Referral Dashboard ไม่สำเร็จ'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    setMessage(''); setCreated(null); setCreating(true);
    try {
      const result = await request<Created>('/api/referrals', 'POST', { staffId, oaId, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) });
      setCreated(result); setMessage('สร้างลิงก์แล้ว — Plain Token แสดงครั้งนี้ครั้งเดียว');
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'สร้างลิงก์ไม่สำเร็จ'); }
    finally { setCreating(false); }
  }

  async function changeStatus(item: Referral, status: 'ACTIVE' | 'PAUSED' | 'REVOKED') {
    if ((status === 'REVOKED' || status === 'PAUSED') && !window.confirm(`ยืนยัน ${status === 'REVOKED' ? 'Revoke' : 'Pause'} ลิงก์นี้?`)) return;
    try { await request(`/api/referrals/${encodeURIComponent(item.id)}/status`, 'POST', { status }); setMessage(`เปลี่ยนสถานะลิงก์เป็น ${status} แล้ว`); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'เปลี่ยนสถานะลิงก์ไม่สำเร็จ'); }
  }

  const qr = created ? referralQrSvg(created.url) : '';
  return <section className="stack"><div className="section-intro"><div><p className="eyebrow green">STAFF ATTRIBUTION</p><h2>Referral Dashboard</h2><p>แยก CLICK · LOGIN · FOLLOW_VERIFIED ชัดเจน โดยไม่เก็บ Raw LINE identity</p></div><span className="tag dry">STAGING · DRY RUN</span></div>
    {message && <section className="panel" role="status">{message}</section>}
    {canManage ? <section className="panel"><div className="panel-head"><div><p className="eyebrow">CREATE STAFF LINK</p><h3>สร้างลิงก์รายพนักงาน</h3></div><span className="tag success">ONE-TIME TOKEN</span></div><form className="referral-form" onSubmit={create}><label htmlFor="referral-staff">พนักงาน<select id="referral-staff" value={staffId} onChange={e => setStaffId(e.target.value)} required><option value="">เลือกพนักงาน</option>{activeStaff.map(item => <option value={item.id} key={item.id}>{item.displayName} · {item.email}</option>)}</select></label><label htmlFor="referral-oa">LINE OA<select id="referral-oa" value={oaId} onChange={e => setOaId(e.target.value)} required><option value="">เลือก OA ที่เปิดใช้งาน</option>{usableChannels.map(item => <option value={item.oaId} key={item.oaId}>{item.displayName} · {item.environment}</option>)}</select></label><label htmlFor="referral-expiry">หมดอายุ (ถ้ามี)<input id="referral-expiry" type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></label><button className="primary" disabled={!staffId || !oaId || creating}>{creating ? 'กำลังสร้าง...' : 'สร้างลิงก์'}</button></form>{(!activeStaff.length || !usableChannels.length) && <p className="form-note">ต้องมีสมาชิกที่ ACTIVE และ OA ที่ enabled ใน Staging ก่อนสร้างลิงก์</p>}</section> : <section className="panel"><p className="eyebrow">READ ONLY</p><h3>โหมดอ่านรายงาน</h3><p>การสร้างหรือเปลี่ยนสถานะลิงก์ต้องใช้สิทธิ์ owner หรือ admin</p></section>}
    {created && <section className="panel created-referral"><div><p className="eyebrow green">SHOW ONCE</p><h3>ลิงก์พร้อมแชร์</h3><p>Plain Token จะไม่ถูกเก็บและจะไม่แสดงซ้ำหลังออกจากหน้านี้</p><div className="copy-row"><input readOnly value={created.url} aria-label="Referral URL"/><button className="secondary" onClick={() => void navigator.clipboard?.writeText(created.url)}>คัดลอก</button></div><code className="token-once">Token: {created.plainToken}</code></div><div className="qr-wrap" dangerouslySetInnerHTML={{ __html: qr }} /><small className="form-note">QR สร้างในเครื่อง · ไม่มีบริการภายนอก</small></section>}
    <section className="panel table-panel"><div className="table-head"><strong>รายงานรายพนักงาน</strong><span>{loading ? 'กำลังโหลด...' : `${rows.length} staff rows`}</span></div><div className="filter-row"><label>กรองพนักงาน<select value={filterStaffId} onChange={e => setFilterStaffId(e.target.value)}><option value="">ทั้งหมด</option>{activeStaff.map(item => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><label>กรอง OA<select value={filterOaId} onChange={e => setFilterOaId(e.target.value)}><option value="">ทั้งหมด</option>{channels.map(item => <option value={item.oaId} key={item.oaId}>{item.displayName}</option>)}</select></label><label>จากวันที่<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>ถึงวันที่<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><button className="secondary" onClick={() => void load({ staffId: filterStaffId, oaId: filterOaId, from: bangkokRange(from, false), to: bangkokRange(to, true) })}>ใช้ตัวกรอง</button></div>{loading ? <Empty text="กำลังโหลดรายงาน..." /> : <div className="tenant-table-wrap"><table className="tenant-table"><thead><tr><th>พนักงาน</th><th>Active links</th><th>Click</th><th>Login</th><th>Follow Verified</th><th>Conversion</th><th>ล่าสุด</th></tr></thead><tbody>{rows.map(item => <tr key={item.staffId}><td><strong>{item.staffName}</strong><small>{item.email}</small></td><td>{item.activeLinks}</td><td>{item.clicks}</td><td>{item.logins}</td><td>{item.followVerified}</td><td>{item.conversionRate}%</td><td>{item.latestActivity ? new Date(item.latestActivity).toLocaleString('th-TH') : '—'}</td></tr>)}{!rows.length && <tr><td colSpan={7}>ยังไม่มีข้อมูล Attribution</td></tr>}</tbody></table></div>}</section>
    <section className="panel table-panel"><div className="table-head"><strong>ลิงก์ที่สร้าง</strong><span>Token แสดงเฉพาะตอนสร้าง</span></div>{referrals.map(item => <div className="audit-row" key={item.id}><span className="audit-dot" /><div><strong><span className={`tag ${item.status === 'ACTIVE' ? 'success' : item.status === 'PAUSED' ? 'paused' : 'dry'}`}>{item.status}</span> · {staff.find(member => member.id === item.staffId)?.displayName || 'Staff'}</strong><small>OA {item.oaId} · สร้าง {new Date(item.createdAt).toLocaleString('th-TH')}{item.expiresAt ? ` · หมดอายุ ${new Date(item.expiresAt).toLocaleString('th-TH')}` : ' · ไม่มีวันหมดอายุ'}</small></div>{canManage && item.status === 'ACTIVE' && <><button className="mini-btn" onClick={() => void changeStatus(item, 'PAUSED')}>Pause</button><button className="danger-btn" onClick={() => void changeStatus(item, 'REVOKED')}>Revoke</button></>}{canManage && item.status === 'PAUSED' && <><button className="mini-btn" onClick={() => void changeStatus(item, 'ACTIVE')}>Resume</button><button className="danger-btn" onClick={() => void changeStatus(item, 'REVOKED')}>Revoke</button></>}</div>)}{!referrals.length && <Empty text="ยังไม่มี referral link" />}</section>
  </section>;
}

function Empty({ text }: { text: string }) { return <div className="empty-inline">{text}</div>; }
