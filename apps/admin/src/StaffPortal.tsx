import { useEffect, useState } from 'react';
import { apiUrl } from './apiClient.js';

type ClickResult = { referral: { id: string; oaId: string; status: string }; staffName: string; oaId: string; next: string };
type LoginStart = { state: string; nonce: string; issuer: string; audience: string; expiresInSeconds: number };

async function request<T>(url: string, method = 'POST', body?: object, signature?: string): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (signature) headers.set('x-mock-signature', signature);
  const response = await fetch(apiUrl(url), { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error || `Request failed (${response.status})`); }
  return response.json() as Promise<T>;
}

async function signMockWebhook(rawBody: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('line-ccc-local-dry-run-webhook-key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  let binary = ''; for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export default function StaffPortal({ token }: { token: string }) {
  const [click, setClick] = useState<ClickResult | null>(null); const [login, setLogin] = useState<LoginStart | null>(null); const [subject, setSubject] = useState('mock-follower-001'); const [message, setMessage] = useState('กำลังบันทึก Click...'); const [busy, setBusy] = useState(false); const [followed, setFollowed] = useState(false);
  useEffect(() => { void request<ClickResult>(`/api/referrals/${encodeURIComponent(token)}/click`).then(result => { setClick(result); setMessage(`ลิงก์ของ ${result.staffName} · OA ${result.oaId}`); }).catch(error => setMessage(error instanceof Error ? error.message : 'เปิดลิงก์ไม่สำเร็จ')); }, [token]);
  async function lineLogin() { if (!click) return; setBusy(true); try { const start = await request<LoginStart>('/api/line-login/mock/start', 'POST', { referralToken: token }); const callback = await request<{ ok: boolean }>('/api/line-login/mock/callback', 'POST', { state: start.state, nonce: start.nonce, idToken: { iss: start.issuer, aud: start.audience, exp: Math.floor(Date.now() / 1000) + 300, nonce: start.nonce, sub: subject, signature: 'MOCK_VALID' } }); setLogin(start); setMessage(callback.ok ? 'LINE Login Mock ผ่าน · identity เก็บเป็น HMAC เท่านั้น' : 'LINE Login Mock ไม่ผ่าน'); } catch (error) { setMessage(error instanceof Error ? error.message : 'LINE Login Mock ไม่สำเร็จ'); } finally { setBusy(false); } }
  async function verifyFollow() { if (!click || !login) return; setBusy(true); try { const payload = { referralId: click.referral.id, eventId: `mock-webhook-${Date.now()}`, followerSubject: subject, evidenceRef: `mock-evidence-${Date.now()}`, eventType: 'follow' }; const raw = JSON.stringify(payload); const result = await request<{ duplicate: boolean }>('/api/mock/webhook/follow', 'POST', payload, await signMockWebhook(raw)); setFollowed(true); setMessage(result.duplicate ? 'Follow นี้ถูก deduplicate แล้ว' : 'FOLLOW_VERIFIED แล้วจาก signed mock webhook'); } catch (error) { setMessage(error instanceof Error ? error.message : 'ยืนยัน Follow ไม่สำเร็จ'); } finally { setBusy(false); } }
  return <main className="staff-portal"><div className="staff-card"><div className="logo"><span>●</span><div><strong>LINE Campaign</strong><small>Staff Portal</small></div></div><span className="mode-pill">● STAGING · DRY RUN</span><p className="eyebrow green">LINE LOGIN MOCK / LIVE DISABLED</p><h1>เข้าร่วมแคมเปญ</h1><p className="auth-copy">ลิงก์นี้เป็นของพนักงาน <strong>{click?.staffName || 'กำลังตรวจสอบ...'}</strong> และ OA ใน Workspace เดียวกัน</p><p className="portal-status" role="status">{message}</p><label htmlFor="mock-subject">Mock LINE subject (ไม่ใช่ LINE ID จริง)</label><input id="mock-subject" value={subject} onChange={e => setSubject(e.target.value)} disabled={busy || Boolean(login)} /><div className="portal-steps"><span className={click ? 'done' : ''}>1. CLICK</span><span className={login ? 'done' : ''}>2. LOGIN</span><span className={followed ? 'done' : ''}>3. FOLLOW VERIFIED</span></div><button className="primary full" onClick={() => void lineLogin()} disabled={!click || busy || Boolean(login)}>{login ? 'LINE Login Mock สำเร็จ' : 'เริ่ม LINE Login Mock'}</button><button className="secondary full" onClick={() => void verifyFollow()} disabled={!login || busy || followed}>จำลอง Signed Webhook Follow</button><small className="auth-foot">ไม่มี OAuth จริง · ไม่มีการส่งข้อมูลไป LINE · ไม่มี Raw LINE identity</small></div></main>;
}
