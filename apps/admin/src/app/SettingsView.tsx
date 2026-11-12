import { useEffect, useState, type FormEvent } from 'react';
import WorkspaceSettings from '../WorkspaceSettings.js';
import { api } from './api.js';
import { auditActionLabel, auditDetailText, connectionLabel } from './labels.js';
import { Empty, Tabs } from './shared.js';
import { type Oa, type Section, type User } from './types.js';

export default function SettingsPage({ section, onNavigate, oas, user, systemKillSwitch, canManage, onCreate, onValidate, onEnabled, onKillSwitch, onLimits, onSystemKillSwitch }: {
  section: Section; onNavigate: (section: Section) => void; oas: Oa[]; user: User; systemKillSwitch: boolean; canManage: boolean;
  onCreate: (input: { providerId: string; basicId: string; displayName: string }) => Promise<void>; onValidate: (id: string) => Promise<void>;
  onEnabled: (id: string, enabled: boolean) => Promise<void>; onKillSwitch: (id: string, enabled: boolean) => Promise<void>;
  onLimits: (id: string, limits: { quotaPerMinute?: number; monthlyQuota?: number }) => Promise<void>; onSystemKillSwitch: (enabled: boolean) => Promise<void>;
}) {
  return <>
    <Tabs items={[['oas', 'LINE OA'], ['workspace', 'ทีมงาน & การเชื่อมต่อ (Workspace)'], ['audit', 'บันทึกการใช้งาน (Audit)']]} value={section} onChange={onNavigate} />
    {section === 'oas' && <OasView oas={oas} systemKillSwitch={systemKillSwitch} canManage={canManage} onCreate={onCreate} onValidate={onValidate} onEnabled={onEnabled} onKillSwitch={onKillSwitch} onLimits={onLimits} onSystemKillSwitch={onSystemKillSwitch} />}
    {section === 'workspace' && <WorkspaceSettings session={user} />}
    {section === 'audit' && <AuditView />}
  </>;
}

export function OasView({ oas, systemKillSwitch, canManage, onCreate, onValidate, onEnabled, onKillSwitch, onLimits, onSystemKillSwitch }: { oas: Oa[]; systemKillSwitch: boolean; canManage: boolean; onCreate: (input: { providerId: string; basicId: string; displayName: string }) => Promise<void>; onValidate: (id: string) => Promise<void>; onEnabled: (id: string, enabled: boolean) => Promise<void>; onKillSwitch: (id: string, enabled: boolean) => Promise<void>; onLimits: (id: string, limits: { quotaPerMinute?: number; monthlyQuota?: number }) => Promise<void>; onSystemKillSwitch: (enabled: boolean) => Promise<void> }) {
  const [displayName, setDisplayName] = useState('');
  const [basicId, setBasicId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [systemStopped, setSystemStopped] = useState(systemKillSwitch);
  const [limitsDraft, setLimitsDraft] = useState<Record<string, { perMinute: string; perMonth: string }>>({});
  useEffect(() => setSystemStopped(systemKillSwitch), [systemKillSwitch]);
  const draftFor = (oa: Oa) => limitsDraft[oa.id] ?? { perMinute: String(oa.quotaPerMinute), perMonth: String(oa.monthlyQuota ?? 0) };
  const saveLimits = async (oa: Oa) => { const draft = draftFor(oa); await onLimits(oa.id, { quotaPerMinute: Number(draft.perMinute), monthlyQuota: Number(draft.perMonth) }); setLimitsDraft((current) => { const next = { ...current }; delete next[oa.id]; return next; }); };
  const submit = async (event: FormEvent) => { event.preventDefault(); await onCreate({ displayName, basicId, providerId }); setDisplayName(''); setBasicId(''); setProviderId(''); };
  return <section className="stack"><div className="section-intro"><div><p className="eyebrow green">บัญชี LINE OA</p><h2>LINE OA ของคุณ</h2><p>เชื่อมต่อ LINE OA ได้หลายบัญชี · รหัสลับเก็บไว้ฝั่งเซิร์ฟเวอร์เท่านั้น</p></div><button className={systemStopped ? 'secondary' : 'primary'} onClick={() => { const next = !systemStopped; setSystemStopped(next); void onSystemKillSwitch(next); }}>{systemStopped ? 'เปิดระบบกลับ' : 'หยุดระบบฉุกเฉิน'}</button></div><section className="panel oa-management"><div className="panel-head"><div><p className="eyebrow">ข้อมูลบัญชี LINE OA</p><h3>เพิ่มบัญชีสำหรับ Staging</h3></div><span className="tag dry">NO SECRET INPUT</span></div><form className="oa-form" onSubmit={submit}><label>ชื่อที่แสดงในระบบ<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="เช่น OA Campaign Staging" required /></label><label>Basic ID<input value={basicId} onChange={(event) => setBasicId(event.target.value)} placeholder="@staging-basic-id" required /></label><label>Provider ID<input value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="staging-provider-a" required /></label><button className="primary" type="submit">＋ เพิ่มบัญชี OA</button></form><p className="form-note">Credential จะถูกอ้างอิงจาก Server secret store ในขั้นตอนที่ได้รับอนุมัติเท่านั้น และจะไม่ถูกส่งกลับ Frontend</p></section><div className="oa-grid">{oas.map((oa) => <article className="panel oa-card" key={oa.id}><div className="oa-avatar">◎</div><div><h3>{oa.displayName}</h3><p>{oa.basicId}</p><span className={`tag ${oa.enabled ? 'success' : 'paused'}`}>{oa.enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'}</span><span className="tag dry">{connectionLabel(oa.connectionStatus)}</span><p className="oa-summary">ส่งได้ {oa.quotaPerMinute} ข้อความ/นาที{oa.monthlyQuota ? ` · ใช้ไป ${oa.monthlyUsed ?? 0}/${oa.monthlyQuota} ข้อความเดือนนี้` : ''}{oa.killSwitch ? ' · หยุดฉุกเฉินอยู่' : ''}</p></div><div className="oa-actions"><button className="secondary" onClick={() => void onEnabled(oa.id, !oa.enabled)}>{oa.enabled ? 'ปิดใช้งาน OA' : 'เปิดใช้งาน OA'}</button><button className={oa.killSwitch ? 'secondary' : 'danger-btn'} onClick={() => void onKillSwitch(oa.id, !oa.killSwitch)}>{oa.killSwitch ? 'ปิดการหยุดฉุกเฉิน' : 'หยุด OA ฉุกเฉิน'}</button></div><details className="advanced"><summary>รายละเอียดสำหรับผู้ดูแลระบบ</summary><dl><dt>Provider ID</dt><dd>{oa.providerId}</dd><dt>สภาพแวดล้อม</dt><dd>{oa.environment}</dd><dt>Credential</dt><dd>{oa.secretConfigured ? 'ตั้งค่าแล้ว · ซ่อนค่า' : 'ยังไม่ตั้งค่า'}</dd></dl><button className="secondary" onClick={() => void onValidate(oa.id)}>ตรวจการเชื่อมต่อ (ไม่ส่ง LINE)</button><form className="oa-limits" onSubmit={(event) => { event.preventDefault(); void saveLimits(oa); }}><label>ต่อนาที<input type="number" min="1" max="500" value={draftFor(oa).perMinute} disabled={!canManage} onChange={(event) => setLimitsDraft((current) => ({ ...current, [oa.id]: { ...draftFor(oa), perMinute: event.target.value } }))} /></label><label>ต่อเดือน (0 = ไม่จำกัด)<input type="number" min="0" value={draftFor(oa).perMonth} disabled={!canManage} onChange={(event) => setLimitsDraft((current) => ({ ...current, [oa.id]: { ...draftFor(oa), perMonth: event.target.value } }))} /></label><button className="secondary" type="submit" disabled={!canManage}>บันทึกเพดาน</button></form></details></article>)}</div></section>;
}

export function AuditView() {
  const [events, setEvents] = useState<{ id: string; action: string; actor: string; target: string; detail: string; createdAt: string }[]>([]);
  useEffect(() => { void api<{ events: typeof events }>('/api/audit').then((result) => setEvents(result.events)).catch(() => undefined); }, []);
  const visible = events.filter((event) => event.action !== 'WORKER_HEARTBEAT');
  const hidden = events.length - visible.length;
  return <section className="stack"><div className="section-intro"><div><p className="eyebrow green">ความโปร่งใส</p><h2>ประวัติการใช้งาน</h2><p>เหตุการณ์สำคัญในระบบ · ไม่มีรหัสผ่านหรือข้อมูลลับ</p></div></div><section className="panel table-panel">{visible.map((event) => <div className="audit-row" key={event.id}><span className="audit-dot" /><div><strong>{auditActionLabel(event.action)}</strong><small>{auditDetailText(event.detail)}</small></div><time>{new Date(event.createdAt).toLocaleString('th-TH')}</time></div>)}{!visible.length && <Empty text="ยังไม่มีบันทึกการใช้งาน" />}{hidden > 0 && <p className="form-note">ซ่อน heartbeat ของ worker {hidden} รายการ</p>}</section></section>;
}
