import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import AccountSetup from './AccountSetup.js';
import LiffSharePage from './LiffSharePage.js';
import PublicLinks from './PublicLinks.js';
import StaffPortal from './StaffPortal.js';
import { api } from './app/api.js';
import CampaignsView from './app/CampaignsView.js';
import CustomersPage from './app/CustomersView.js';
import DashboardView from './app/DashboardView.js';
import { campaignSeed, flexById } from './app/data.js';
import PushView from './app/PushView.js';
import SettingsPage from './app/SettingsView.js';
import Shell from './app/Shell.js';
import { type Campaign, type Customer, type Dashboard, type Job, type JobAction, type Oa, type PushSeed, type Readiness, type ScheduleInput, type Section, type User } from './app/types.js';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [section, setSection] = useState<Section>('dashboard');
  const [dashboard, setDashboard] = useState<Dashboard>({ mode: 'DRY_RUN', counts: {}, nextJob: null });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [oas, setOas] = useState<Oa[]>([]);
  const [oasLoaded, setOasLoaded] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>(campaignSeed);
  const [selected, setSelected] = useState('welcome');
  const [editor, setEditor] = useState(JSON.stringify(flexById.welcome, null, 2));
  const [notice, setNotice] = useState('กำลังโหลดข้อมูล...');
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [pushSeed, setPushSeed] = useState<PushSeed | null>(null);
  const [liffId, setLiffId] = useState<string | null>(null);
  const [selectedOaId, setSelectedOaId] = useState<string>(() => localStorage.getItem('lineccc.oa') || '');
  const scheduleKey = useRef(crypto.randomUUID());
  const announced = useRef(false);
  const campaign = campaigns.find((item) => item.id === selected) || campaigns[0]!;
  // One filter for the whole app: the operator picks the OA once and every screen uses it.
  const usableOas = oas.filter((item) => item.enabled && item.environment === 'STAGING');
  const selectedOa = usableOas.find((item) => item.id === selectedOaId) || usableOas[0] || null;
  const chooseOa = (id: string) => { setSelectedOaId(id); localStorage.setItem('lineccc.oa', id); };

  const refresh = async () => {
    try {
      const [d, j, o, c, customerResult] = await Promise.all([api<Dashboard>('/api/dashboard'), api<{ jobs: Job[] }>('/api/scheduler/jobs'), api<{ oas: Oa[] }>('/api/oas'), api<{ campaigns: Campaign[] }>('/api/campaigns'), api<{ customers: Customer[] }>('/api/customers')]);
      setDashboard(d); setJobs(j.jobs); setOas(o.oas); setCampaigns(c.campaigns); setCustomers(customerResult.customers); setOasLoaded(true);
      // Only the first load claims the banner; later refreshes must not erase the
      // message that explains what the operator just did.
      if (!announced.current) { announced.current = true; setNotice(`เชื่อมต่อ ${user?.email || 'ระบบ'} แล้ว • ${d.liveSendEnabled ? 'ส่งจริงได้ (ต้องยืนยันทุกครั้ง)' : 'โหมดทดสอบ · ยังไม่ส่งออก LINE'}`); }
    } catch (error) { if (String(error).includes('401') || String(error).includes('authentication')) setUser(null); else setNotice(error instanceof Error ? error.message : 'API unavailable'); }
  };
  useEffect(() => { void api<{ user: User }>('/api/auth/me').then((result) => { setUser(result.user); }).catch(() => setUser(null)).finally(() => setBooting(false)); if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js'); }, []);
  useEffect(() => { if (user) void refresh(); }, [user]);
  // The LIFF id is per OA, so it is fetched for the selected one; without a selection the
  // endpoint still answers with the server-wide fallback instead of leaving the operator stuck.
  // Both effects wait for the OA list: a request sent before it resolves cannot name an OA,
  // and a readiness answer for "whichever OA came first" is exactly the guess this round removes.
  useEffect(() => {
    if (!oasLoaded) return;
    const query = selectedOa ? `?oa=${encodeURIComponent(selectedOa.basicId)}` : '';
    void api<{ liffId: string | null }>(`/api/config${query}`).then((result) => setLiffId(result.liffId)).catch(() => setLiffId(null));
  }, [selectedOa?.basicId, oasLoaded]);
  useEffect(() => { if (campaign) setEditor(JSON.stringify(campaign.flexJson || flexById[selected], null, 2)); }, [selected, campaign?.latestRevision]);
  useEffect(() => { if (!user || !oasLoaded) return; const query = selectedOa ? `?oaId=${encodeURIComponent(selectedOa.id)}` : ''; void api<Readiness>(`/api/campaigns/${selected}/readiness${query}`).then(setReadiness).catch(() => setReadiness(null)); }, [user, selected, selectedOa?.id, oasLoaded]);

  const createSchedule = async (input: ScheduleInput) => {
    try { await api('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': scheduleKey.current }, body: JSON.stringify(input) }); scheduleKey.current = crypto.randomUUID(); setNotice(input.status === 'DRAFT' ? 'บันทึกแบบร่างแล้ว' : input.mode === 'LIVE' ? 'ตั้งเวลาส่งจริงแล้ว · LINE จะได้รับข้อความเมื่อถึงเวลา' : 'สร้างงานทดสอบแล้ว · จะไม่มีการส่งออก LINE'); await refresh(); setSection('scheduler'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'สร้างงานไม่สำเร็จ'); throw error; }
  };
  const submitJob = async (campaignId = selected) => {
    if (!selectedOa) { setNotice('ยังไม่ได้เลือก LINE OA · เลือกบัญชีที่ header หรือเปิดใช้งานในหน้าตั้งค่าก่อน'); return; }
    await createSchedule({ campaignId, oaId: selectedOa.id, scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(), timeZone: 'Asia/Bangkok', status: 'SCHEDULED' }).catch(() => undefined);
  };
  const jobAction = async (id: string, action: JobAction) => { try { await api(`/api/scheduler/jobs/${id}/${action}`, { method: 'POST' }); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'ทำรายการไม่สำเร็จ'); } };
  const saveRevision = async () => { try { const flexJson = JSON.parse(editor) as Record<string, unknown>; await api(`/api/campaigns/${selected}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flexJson }) }); setNotice('บันทึกเวอร์ชันใหม่ของการ์ดแล้ว'); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'บันทึก revision ไม่สำเร็จ'); } };
  /** LINE has no share button for Flex cards, so the card is handed to the manual push screen instead. */
  const shareFlexToChat = () => { try { setPushSeed({ flex: JSON.parse(editor) as Record<string, unknown> }); setNotice('การ์ดถูกส่งไปที่หน้า “ส่งข้อความตรง” แล้ว · เลือกผู้รับ (ใส่ LINE ID ตัวเองได้) แล้วกดดูตัวอย่าง'); setSection('push'); } catch { setNotice('JSON ใน Flex Studio ยังไม่ถูกต้อง · แก้ก่อนแชร์'); } };
  const validateCampaign = async () => { try { setReadiness(await api<Readiness>(`/api/campaigns/${selected}/validate`, { method: 'POST' })); setNotice('ผ่านการ Validate แล้ว · ยังไม่เปลี่ยนเป็น LIVE'); } catch (error) { setNotice(error instanceof Error ? error.message : 'Validate ไม่สำเร็จ'); } };
  const approveCampaign = async () => { try { setReadiness(await api<Readiness>(`/api/campaigns/${selected}/approve`, { method: 'POST' })); setNotice('อนุมัติ Campaign สำหรับ Staging DRY RUN แล้ว'); } catch (error) { setNotice(error instanceof Error ? error.message : 'Approve ไม่สำเร็จ'); } };
  const createOa = async (input: { providerId: string; basicId: string; displayName: string }) => { try { await api('/api/oas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); setNotice('เพิ่มบัญชี OA แล้ว · ยังไม่เชื่อมต่อ credential และยังไม่เปิดส่ง'); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'เพิ่ม OA ไม่สำเร็จ'); } };
  const validateOa = async (id: string) => { try { await api(`/api/oas/${id}/validate`, { method: 'POST' }); setNotice('ตรวจ secret reference ฝั่ง Server แล้ว · ไม่มีการเรียก LINE'); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'ตรวจ OA ไม่สำเร็จ'); } };
  const setOaEnabled = async (id: string, enabled: boolean) => { try { await api(`/api/oas/${id}/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }); setNotice(enabled ? 'เปิดใช้งาน OA ใน Staging แล้ว' : 'ปิดใช้งาน OA ใน Staging แล้ว'); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'เปลี่ยนสถานะ OA ไม่สำเร็จ'); } };
  const setOaKillSwitch = async (id: string, enabled: boolean) => { try { await api(`/api/oas/${id}/kill-switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, reason: enabled ? 'Manual Staging safety stop' : 'Manual Staging resume' }) }); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'เปลี่ยน OA kill switch ไม่สำเร็จ'); } };
  const setOaLimits = async (id: string, limits: { quotaPerMinute?: number; monthlyQuota?: number }) => { try { await api(`/api/oas/${id}/limits`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(limits) }); setNotice('บันทึกเพดานการส่งของ OA แล้ว'); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'บันทึกเพดาน OA ไม่สำเร็จ'); } };
  const setCampaignKillSwitch = async (id: string, enabled: boolean) => { try { await api(`/api/campaigns/${id}/kill-switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, reason: enabled ? 'Manual Staging safety stop' : 'Manual Staging resume' }) }); setNotice(enabled ? 'หยุดแคมเปญนี้แล้ว · ตั้งเวลาส่งจะถูกบล็อกจนกว่าจะปิด switch' : 'เปิดแคมเปญนี้กลับมาแล้ว'); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'เปลี่ยน campaign kill switch ไม่สำเร็จ'); } };
  const setSystemKillSwitch = async (enabled: boolean) => { try { await api('/api/workspace/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, reason: enabled ? 'Manual Staging safety stop' : 'Manual Staging resume' }) }); setReadiness((current) => { if (!current) return current; const blockers = enabled ? [...new Set([...current.blockers, 'System kill switch is active'])] : current.blockers.filter((item) => item !== 'System kill switch is active'); return { ...current, systemKillSwitch: enabled, blockers, canSchedule: blockers.length === 0 }; }); setNotice(enabled ? 'หยุดระบบฉุกเฉินแล้ว · งานใหม่จะถูกบล็อกจนกว่าจะเปิดกลับ' : 'เปิดระบบกลับแล้ว'); } catch (error) { setNotice(error instanceof Error ? error.message : 'เปลี่ยน System kill switch ไม่สำเร็จ'); } };
  const optOutCustomer = async (id: string) => { try { await api(`/api/customers/${id}/opt-out`, { method: 'POST' }); setNotice('บันทึกการยกเลิกความยินยอมแล้ว · ลูกค้าคนนี้จะไม่ถูกส่งข้อความจาก OA นี้อีกจนกว่าจะติดตาม OA ใหม่'); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : 'บันทึก opt-out ไม่สำเร็จ'); } };
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); setUser(null); };

  if (booting) return <div className="auth-screen"><div className="auth-card"><div className="logo"><span>●</span><div><strong>LINE Campaign</strong><small>Control Center</small></div></div><p>กำลังตรวจสอบ Staging session...</p></div></div>;
  if (!user) return <LoginView onLogin={setUser} />;
  const canWrite = ['owner', 'admin', 'editor'].includes(user.role);
  const canApprove = ['owner', 'admin', 'reviewer'].includes(user.role);
  const canManage = ['owner', 'admin'].includes(user.role);

  return <Shell user={user} section={section} onNavigate={setSection} dashboard={dashboard} notice={notice} selectedOa={selectedOa} usableOas={usableOas} onChooseOa={chooseOa} onRefresh={() => void refresh()} onLogout={() => void logout()}>
    {section === 'dashboard' && <DashboardView dashboard={dashboard} jobs={jobs} customers={customers} campaigns={campaigns} oas={oas} onNavigate={setSection} onAction={jobAction} />}
    {(section === 'push' || section === 'scheduler') && <PushView section={section} onNavigate={setSection} oas={oas} oaId={selectedOa?.id || ''} customers={customers} liveSendEnabled={Boolean(dashboard.liveSendEnabled)} pushSeed={pushSeed} onSeedUsed={() => setPushSeed(null)} jobs={jobs} campaigns={campaigns} canWrite={canWrite} onCreate={createSchedule} onAction={jobAction} />}
    {section === 'flex' && <CampaignsView campaigns={campaigns} campaign={campaign} selected={selected} setSelected={setSelected} editor={editor} setEditor={setEditor} onSave={saveRevision} onSchedule={() => submitJob()} readiness={readiness} onValidate={validateCampaign} onApprove={approveCampaign} canWrite={canWrite} canApprove={canApprove} canManage={canManage} onKillSwitch={setCampaignKillSwitch} onShareToChat={shareFlexToChat} liffId={liffId} oaBasicId={selectedOa?.basicId ?? null} />}
    {(section === 'customers' || section === 'referrals') && <CustomersPage section={section} onNavigate={setSection} customers={customers} canWrite={canWrite} canManage={canManage} oaId={selectedOa?.id || ''} onOptOut={optOutCustomer} />}
    {section === 'links' && <PublicLinks oaId={selectedOa?.id || null} oaName={selectedOa?.displayName} onNavigate={setSection} />}
    {(section === 'oas' || section === 'workspace' || section === 'audit') && <SettingsPage section={section} onNavigate={setSection} oas={oas} user={user} systemKillSwitch={Boolean(readiness?.systemKillSwitch)} canManage={canManage} onCreate={createOa} onValidate={validateOa} onEnabled={setOaEnabled} onKillSwitch={setOaKillSwitch} onLimits={setOaLimits} onSystemKillSwitch={setSystemKillSwitch} />}
  </Shell>;
}

function LoginView({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<'unknown' | 'dry' | 'live'>('unknown');
  // The release gate is a server-side switch, so the login screen asks /health
  // instead of claiming "DRY RUN" no matter what the host is actually doing.
  useEffect(() => { let alive = true; fetch('/health').then((r) => r.json()).then((h) => { if (alive) setGate(h.liveSendEnabled ? 'live' : 'dry'); }).catch(() => undefined); return () => { alive = false; }; }, []);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { const result = await api<{ user: User }>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); onLogin(result.user); } catch (reason) { setError(reason instanceof Error ? reason.message : 'เข้าสู่ระบบไม่สำเร็จ'); } finally { setBusy(false); } };
  return <div className="auth-screen"><div className="auth-card"><div className="logo"><span>●</span><div><strong>LINE Campaign</strong><small>Control Center</small></div></div><p className="eyebrow green">ศูนย์ควบคุมแคมเปญ</p><h1>เข้าสู่ระบบ</h1><p className="auth-copy">หน้านี้ปิดไว้จนกว่าจะยืนยันตัวตน Admin สำเร็จ</p><form onSubmit={submit}><label htmlFor="admin-email">Email</label><input id="admin-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /><label htmlFor="admin-password">Password</label><input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" minLength={12} required />{error && <p className="auth-error">{error}</p>}<button className="primary full" disabled={busy}>{busy ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ Staging'}</button></form><small className={gate === 'live' ? 'auth-foot live' : 'auth-foot'}>{gate === 'live' ? 'โหมด LIVE · ข้อความที่ยืนยันแล้วจะส่งถึงลูกค้าจริง' : gate === 'dry' ? 'โหมดทดสอบ · ยังไม่มีข้อความออกจากเครื่องนี้' : 'กำลังตรวจสอบโหมดของเซิร์ฟเวอร์…'} · ไม่เก็บ password ใน Frontend</small></div></div>;
}

function Root() { const setup = window.location.pathname === '/account-setup'; const share = window.location.pathname === '/share'; const match = window.location.pathname.match(/^\/r\/([^/]+)$/); return setup ? <AccountSetup /> : share ? <LiffSharePage /> : match ? <StaffPortal token={decodeURIComponent(match[1])} /> : <App />; }

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
