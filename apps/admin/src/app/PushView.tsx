import { useState } from 'react';
import DeliveryLedger from '../DeliveryLedger.js';
import PushMessage from '../PushMessage.js';
import { bangkokDateTimeValue, formatBangkok, parseBangkokInput } from './api.js';
import { imageById } from './data.js';
import { JobRow } from './DashboardView.js';
import { jobStatusLabel } from './labels.js';
import { Empty, Tabs } from './shared.js';
import { type Campaign, type Customer, type Job, type JobAction, type Oa, type PushSeed, type ScheduleInput, type Section } from './types.js';

export default function PushView({ section, onNavigate, oas, oaId, customers, liveSendEnabled, pushSeed, onSeedUsed, jobs, campaigns, canWrite, onCreate, onAction }: {
  section: Section; onNavigate: (section: Section) => void; oas: Oa[]; oaId: string; customers: Customer[]; liveSendEnabled: boolean;
  pushSeed: PushSeed | null; onSeedUsed: () => void; jobs: Job[]; campaigns: Campaign[]; canWrite: boolean;
  onCreate: (input: ScheduleInput) => Promise<void>; onAction: (id: string, action: JobAction) => void;
}) {
  return <>
    <Tabs items={[['push', 'ส่งเดี่ยว'], ['scheduler', 'ตั้งเวลาส่ง (Scheduler)']]} value={section} onChange={onNavigate} />
    {section === 'push' && <PushMessage oas={oas} oaId={oaId} customers={customers} liveSendEnabled={liveSendEnabled} seed={pushSeed} onSeedUsed={onSeedUsed} />}
    {section === 'scheduler' && <SchedulerView jobs={jobs} campaigns={campaigns} oas={oas} oaId={oaId} canWrite={canWrite} liveSendEnabled={liveSendEnabled} onCreate={onCreate} onAction={onAction} />}
  </>;
}

export function SchedulerView({ jobs, campaigns, oas, oaId, canWrite, liveSendEnabled, onCreate, onAction }: { jobs: Job[]; campaigns: Campaign[]; oas: Oa[]; oaId: string; canWrite: boolean; liveSendEnabled: boolean; onCreate: (input: ScheduleInput) => Promise<void>; onAction: (id: string, action: JobAction) => void }) {
  const enabledOas = oas.filter((oa) => oa.enabled && oa.environment === 'STAGING');
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id || '');
  const [scheduledAt, setScheduledAt] = useState(() => bangkokDateTimeValue(new Date(Date.now() + 60 * 60_000)));
  const [formError, setFormError] = useState('');
  const [ledgerJobId, setLedgerJobId] = useState('');
  const [live, setLive] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState('');
  const selectedCampaign = campaigns.find((item) => item.id === campaignId) || campaigns[0];
  const selectedOa = enabledOas.find((item) => item.id === oaId) || enabledOas[0];
  const ledgerJob = jobs.find((job) => job.id === ledgerJobId) || jobs[0];
  const submit = async (status: 'DRAFT' | 'SCHEDULED') => {
    setFormError('');
    if (!campaignId || !selectedCampaign) return setFormError('กรุณาเลือกเทมเพลต');
    if (!selectedOa) return setFormError('ยังไม่มี OA Staging ที่เปิดใช้งาน');
    const parsed = parseBangkokInput(scheduledAt);
    if (Number.isNaN(parsed.valueOf()) || (status === 'SCHEDULED' && parsed.getTime() <= Date.now())) return setFormError('กรุณาเลือกวันเวลาในอนาคต');
    const mode: 'DRY_RUN' | 'LIVE' = status === 'SCHEDULED' && live ? 'LIVE' : 'DRY_RUN';
    try { await onCreate({ campaignId, oaId: selectedOa.id, scheduledAt: parsed.toISOString(), timeZone: 'Asia/Bangkok', status, mode, confirm: mode === 'LIVE' ? liveConfirm : undefined }); }
    catch (error) { setFormError(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ'); }
  };
  const summary = jobs.reduce<Record<string, number>>((result, job) => { result[job.status] = (result[job.status] || 0) + 1; return result; }, {});
  return <section className="stack"><div className="section-intro"><div><p className="eyebrow orange-text">CAMPAIGN AUTOMATION STUDIO</p><h2>ตั้งเวลาส่งแคมเปญ</h2><p>เลือก OA และเทมเพลต ตั้งเวลา แล้วเลือกว่าจะทดสอบหรือส่งจริง</p></div><span className={`mode-pill${liveSendEnabled ? ' live' : ''}`}>{liveSendEnabled ? '● ส่งจริงใช้ได้' : '● โหมดทดสอบ'}</span></div><div className="automation-summary">{([['DRAFT','ร่าง'],['SCHEDULED','รอส่ง'],['PAUSED','หยุด'],['COMPLETED','ส่งแล้ว'],['FAILED','ล้มเหลว'],['CANCELLED','ยกเลิก']] as const).map(([status, label]) => <span key={status}><strong>{summary[status] || 0}</strong>{label}</span>)}</div><div className="automation-grid"><section className="panel scheduler-form"><div className="panel-head"><div><p className="eyebrow">ตั้งเวลา</p><h3>สร้างงานใหม่</h3></div><span className={live ? 'tag live' : 'tag dry'}>{live ? 'ส่งจริง' : 'ทดสอบ · ไม่ส่ง LINE'}</span></div><label>LINE OA (Staging)</label><p className="form-note">ใช้บัญชี <strong>{selectedOa ? `${selectedOa.displayName} · ${selectedOa.basicId}` : 'ที่ยังไม่ได้เลือก'}</strong> · เปลี่ยนได้ที่ตัวเลือก OA ด้านบน</p><label htmlFor="schedule-campaign">เทมเพลตข้อความ</label><select id="schedule-campaign" value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>{campaigns.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><div className="form-grid"><div><label htmlFor="schedule-at">วันและเวลา</label><input id="schedule-at" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></div><div><label htmlFor="schedule-zone">เขตเวลา</label><input id="schedule-zone" value="Asia/Bangkok" readOnly /></div></div>{formError && <p className="auth-error">{formError}</p>}<div className="mode-choice"><label className={live ? 'choice' : 'choice selected'}><input type="radio" name="job-mode" checked={!live} onChange={() => setLive(false)} /><span>ทดสอบ (DRY RUN)</span><small>บันทึกงานและเดิน flow จริง แต่ไม่ยิง LINE</small></label><label className={live ? 'choice selected' : 'choice'}><input type="radio" name="job-mode" disabled={!liveSendEnabled || !canWrite} checked={live} onChange={() => setLive(true)} /><span>ส่งจริง (LIVE)</span><small>{liveSendEnabled ? 'เมื่อถึงเวลา ข้อความจะถึงลูกค้าที่ opt-in ทุกคน' : 'ยังส่งจริงไม่ได้ · ผู้ดูแลระบบต้องเปิดสิทธิ์ก่อน'}</small></label></div>{live && <div className="live-confirm"><p className="live-warn"><strong>ส่งจริงผ่าน LINE</strong> · กรุณาตรวจผู้รับและเวลาก่อน แล้วพิมพ์ LIVE เพื่อปลดล็อกปุ่ม</p><input aria-label="พิมพ์ LIVE เพื่อยืนยันการส่งจริง" value={liveConfirm} onChange={(event) => setLiveConfirm(event.target.value.toUpperCase())} placeholder="พิมพ์ LIVE" maxLength={20} /></div>}<div className="form-actions"><button className="secondary" disabled={!canWrite} onClick={() => void submit('DRAFT')}>บันทึกเป็นแบบร่าง</button><button className={live ? 'danger-btn' : 'primary'} disabled={!canWrite || (live && liveConfirm !== 'LIVE')} onClick={() => void submit('SCHEDULED')}>{live ? 'ตั้งเวลาส่งจริง (LIVE)' : 'ตั้งเวลาส่ง (ทดสอบ)'}</button></div></section><section className="panel preview-card"><div className="panel-head"><div><p className="eyebrow purple-text">ตรวจก่อนบันทึก</p><h3>Campaign Preview</h3></div><span className="tag success">ตัวอย่าง</span></div>{selectedCampaign ? <><img src={imageById[selectedCampaign.id]} alt="" /><span className="eyebrow">{selectedOa?.displayName || 'ยังไม่เลือก OA'}</span><h3>{selectedCampaign.title}</h3><p>{selectedCampaign.description}</p><strong>{selectedCampaign.cta}</strong><small>ส่งแบบ {formatBangkok(scheduledAt)} · {live ? 'ยิง LINE จริงเมื่อถึงเวลา' : 'ไม่มี LINE request'}</small></> : <Empty text="เลือก Template เพื่อดู Preview" />}</section></div><section className="panel table-panel"><div className="table-head"><strong>ประวัติการตั้งเวลา</strong><span>{jobs.length} รายการ</span></div>{jobs.map((job) => <JobRow key={job.id} job={job} oas={oas} campaigns={campaigns} onAction={onAction} />)}{!jobs.length && <Empty text="ยังไม่มีงาน" />}</section>{jobs.length > 0 ? <details className="advanced"><summary>รายละเอียดการส่งต่อผู้รับ · สำหรับผู้ดูแลระบบ</summary><section className="panel"><div className="panel-head"><div><p className="eyebrow">ตารางส่งต่อผู้รับ</p><h3>เลือกงานเพื่อดูสถานะผู้รับ</h3></div></div><label htmlFor="ledger-job">งาน</label><select id="ledger-job" value={ledgerJob?.id || ''} onChange={(event) => setLedgerJobId(event.target.value)}>{jobs.map((job) => <option value={job.id} key={job.id}>{campaigns.find((item) => item.id === job.campaignId)?.name || job.campaignId} · {jobStatusLabel(job.status)} · {new Date(job.scheduledAt).toLocaleString('th-TH')}</option>)}</select></section>{ledgerJob && <DeliveryLedger key={`${ledgerJob.id}:${ledgerJob.status}:${ledgerJob.attempts}`} jobId={ledgerJob.id} canWrite={canWrite} />}</details> : <section className="panel table-panel"><div className="panel-head"><div><p className="eyebrow">สถานะส่งต่อผู้รับ</p><h3>รายละเอียดการส่งต่อ</h3></div></div><div className="empty-inline">ยังไม่มีงานในตาราง · ตั้งเวลาหรือทดลองส่งก่อน</div></section>}</section>;
}
