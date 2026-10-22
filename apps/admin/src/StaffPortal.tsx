import { useEffect, useState } from 'react';
import { apiUrl } from './apiClient.js';

type ClickResult = { referral: { id: string; oaId: string; status: string }; staffName: string; oaId: string; next: string };
type LineMember = { id: string; displayName: string; role: string };

async function request<T>(url: string, method = 'POST', body?: object): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(apiUrl(url), { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error || `Request failed (${response.status})`); }
  return response.json() as Promise<T>;
}

export default function StaffPortal({ token }: { token: string }) {
  const [click, setClick] = useState<ClickResult | null>(null); const [member, setMember] = useState<LineMember | null>(null); const [message, setMessage] = useState('กำลังตรวจสอบลิงก์...'); const [loginEnabled, setLoginEnabled] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('lineLogin');
    if (result === 'success') setMessage('ยืนยัน LINE Login แล้ว');
    if (result === 'error') setMessage('LINE Login ไม่สำเร็จ กรุณาลองอีกครั้ง');
    const clickKey = `line-referral-click:${token}`;
    let previousClick: ClickResult | null = null;
    try { previousClick = JSON.parse(sessionStorage.getItem(clickKey) || 'null') as ClickResult | null; } catch { sessionStorage.removeItem(clickKey); }
    if (previousClick) {
      setClick(previousClick);
      if (result === null) setMessage(`ลิงก์ของ ${previousClick.staffName} · OA ${previousClick.oaId}`);
    } else {
      void request<ClickResult>(`/api/referrals/${encodeURIComponent(token)}/click`).then(value => { setClick(value); sessionStorage.setItem(clickKey, JSON.stringify(value)); if (result === null) setMessage(`ลิงก์ของ ${value.staffName} · OA ${value.oaId}`); }).catch(error => setMessage(error instanceof Error ? error.message : 'เปิดลิงก์ไม่สำเร็จ'));
    }
    void request<{ enabled: boolean }>('/api/line-login/config', 'GET').then(value => setLoginEnabled(value.enabled)).catch(() => setLoginEnabled(false));
    void request<{ member: LineMember }>('/api/line-login/session', 'GET').then(value => setMember(value.member)).catch(() => setMember(null));
  }, [token]);
  function startLineLogin() { window.location.assign(apiUrl(`/api/line-login/start?referralToken=${encodeURIComponent(token)}`)); }
  async function logout() { setBusy(true); try { await request('/api/line-login/logout'); setMember(null); setMessage('ออกจากระบบ LINE แล้ว'); } finally { setBusy(false); } }
  return <main className="staff-portal"><div className="staff-card"><div className="logo"><span>●</span><div><strong>LINE Campaign</strong><small>Member Portal</small></div></div><span className="mode-pill">● LOCAL · DRY RUN</span><p className="eyebrow green">LINE LOGIN v2.1</p><h1>เข้าร่วมแคมเปญ</h1><p className="auth-copy">ลิงก์นี้เชื่อมกับสมาชิก <strong>{click?.staffName || 'กำลังตรวจสอบ...'}</strong> และ OA ใน Workspace เดียวกัน</p><p className="portal-status" role="status">{message}</p><div className="portal-steps"><span className={click ? 'done' : ''}>1. LINK</span><span className={member ? 'done' : ''}>2. LINE LOGIN</span><span className={member ? 'done' : ''}>3. MEMBER</span></div>{member ? <><p className="member-session">เข้าสู่ระบบในชื่อ <strong>{member.displayName}</strong></p><button className="secondary full" onClick={() => void logout()} disabled={busy}>ออกจากระบบ LINE</button></> : <button className="line-login-button full" onClick={startLineLogin} disabled={!click || !loginEnabled || busy}>เข้าสู่ระบบด้วย LINE</button>}<small className="auth-foot">LINE user ID ถูกผูกกับสมาชิกฝั่ง Server · Admin ใช้บัญชีเดิม</small></div></main>;
}
