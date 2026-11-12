import { useEffect, useState } from 'react';
import { apiUrl } from './apiClient.js';
import { referralQrSvg } from './qr.js';

type OaLinkHealth = {
  oaId: string; displayName: string; basicId: string;
  friendUrl: string | null; shareUrl: string | null;
  liffId: string | null; liffSource: 'OA' | 'SERVER' | 'NONE';
  webhookVerified: boolean; credentialReady: boolean; credentialStatus: string;
  tokenCheckedAt: string | null;
  clicks7d: number; logins7d: number; follows7d: number; activeReferralLinks: number;
};
type LinksPayload = { loginEnabled: boolean; shareBase: string; links: OaLinkHealth[] };

async function loadLinks(): Promise<LinksPayload> {
  const response = await fetch(apiUrl('/api/oa-links'), { credentials: 'include' });
  if (!response.ok) throw new Error(`โหลดสถานะลิงก์ไม่สำเร็จ (${response.status})`);
  return response.json() as Promise<LinksPayload>;
}

const LABELS = {
  oas: 'ไปที่ตั้งค่า LINE OA',
  flex: 'ไปที่สร้างข้อความ'
};

export default function PublicLinks({ oaId, oaName, onNavigate }: { oaId: string | null; oaName?: string | null; onNavigate: (section: 'oas' | 'flex' | 'referrals') => void }) {
  const [payload, setPayload] = useState<LinksPayload | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let alive = true;
    void loadLinks().then((value) => { if (alive) { setPayload(value); setError(''); } })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : 'โหลดไม่สำเร็จ'); });
    return () => { alive = false; };
  }, [oaId]);

  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(`คัดลอก${label}แล้ว`); }
    catch { setCopied('เบราว์เซอร์ไม่อนุญาตให้คัดลอก · แตะในช่องแล้วคัดลอกเอง'); }
  };

  if (!oaId) {
    return <section className="stack"><div className="section-intro"><div><p className="eyebrow green">ลิงก์สำหรับลูกค้า</p><h2>แจกลิงก์</h2><p>เลือกลูกค้าปลายทางก่อน ระบบจึงจะสร้างลิงก์ที่ถูก OA</p></div></div>
      <section className="panel"><p className="auth-copy">ยังไม่ได้เลือก LINE OA · เลือกบัญชีที่แถบด้านบน หรือเปิดใช้งานบัญชีในหน้าตั้งค่า</p><button className="secondary" onClick={() => onNavigate('oas')}>{LABELS.oas}</button></section></section>;
  }

  if (error) return <section className="panel" role="alert"><p className="auth-error">{error}</p></section>;
  if (!payload) return <section className="panel"><p className="form-note">กำลังตรวจสถานะลิงก์…</p></section>;

  const link = payload.links.find((item) => item.oaId === oaId) || null;
  if (!link) {
    return <section className="panel"><p className="auth-copy">OA นี้ยังไม่เปิดใช้งาน หรือยังไม่ได้บันทึกบนเซิร์ฟเวอร์</p><button className="secondary" onClick={() => onNavigate('oas')}>{LABELS.oas}</button></section>;
  }

  const qr = link.shareUrl ? referralQrSvg(link.shareUrl) : '';
  const checks: { label: string; ok: boolean; hint: string; target?: 'oas' | 'flex' }[] = [
    { label: 'OA เปิดใช้งาน', ok: true, hint: 'บัญชีนี้พร้อมรับลูกค้า' },
    { label: 'Credential พร้อม', ok: link.credentialReady, hint: 'เก็บ token/secret ฝั่งเซิร์ฟเวอร์แล้ว', target: 'oas' },
    { label: 'Webhook ยืนยันแล้ว', ok: link.webhookVerified, hint: 'รับ event จาก LINE ได้', target: 'oas' },
    { label: 'LIFF ตั้งค่าแล้ว', ok: link.liffSource !== 'NONE', hint: 'ใช้แชร์การ์ดจากมือถือได้', target: 'oas' },
    { label: 'LINE Login เปิดอยู่', ok: payload.loginEnabled, hint: 'ลูกค้าผูกบัญชี LINE กับลิงก์พนักงานได้', target: 'oas' }
  ];
  const missing = checks.filter((item) => !item.ok);

  return <section className="stack">
    <div className="section-intro"><div><p className="eyebrow green">ลิงก์สำหรับลูกค้า</p><h2>แจกลิงก์</h2><p>ทุกอย่างในหน้านี้เป็นของ OA <strong>{oaName || link.displayName}</strong> ({link.basicId})</p></div><span className={`tag ${missing.length ? 'dry' : 'success'}`}>{missing.length ? `ยังไม่พร้อม ${missing.length} ข้อ` : 'พร้อมแจก'}</span></div>

    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">ลิงก์หน้าเว็บให้ลูกค้า</p><h3>ส่งลิงก์นี้ให้ลูกค้าเพิ่มเพื่อน</h3></div><span className="tag success">ใช้แจกได้</span></div>
      {link.shareUrl ? <>
        <div className="copy-row"><input readOnly value={link.shareUrl} aria-label="ลิงก์หน้าเว็บสำหรับลูกค้า" onFocus={(event) => event.currentTarget.select()} /><button className="secondary" onClick={() => void copy('ลิงก์', link.shareUrl!)}>คัดลอก</button></div>
        <ol className="share-steps"><li>ลูกค้าเปิดลิงก์ แล้วกด “เพิ่มเพื่อนที่ LINE OA”</li><li>LINE เปิดหน้าเพิ่มเพื่อนของ OA นี้โดยตรง</li><li>เมื่อกดเพิ่มเพื่อน ลูกค้าจะปรากฏในหน้า “ลูกค้า” ของ OA นี้</li></ol>
        <div className="qr-wrap" dangerouslySetInnerHTML={{ __html: qr }} />
        <small className="form-note">QR สร้างในเครื่อง · ลิงก์ผูกกับ OA นี้ จึงใช้แทนกันระหว่าง OA ไม่ได้</small>
      </> : <p className="auth-error">OA นี้ยังไม่มี basic id ที่ใช้สร้างลิงก์เพิ่มเพื่อนได้ · ตั้งค่า basic id ในหน้าตั้งค่า</p>}
    </section>

    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">ลิงก์เพิ่มเพื่อนตรง</p><h3>เปิดแชท OA ทันที</h3></div></div>
      {link.friendUrl ? <div className="copy-row"><input readOnly value={link.friendUrl} aria-label="ลิงก์เพิ่มเพื่อน LINE OA" onFocus={(event) => event.currentTarget.select()} /><button className="secondary" onClick={() => void copy('ลิงก์', link.friendUrl!)}>คัดลอก</button></div>
        : <p className="form-note">ยังไม่มีลิงก์เพิ่มเพื่อนของ OA นี้</p>}
      {copied && <p className="form-note">{copied}</p>}
    </section>

    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">ลิงก์ของทีมงาน</p><h3>ลิงก์แนะนำรายพนักงาน</h3></div><span className="tag dry">แสดงครั้งเดียวตอนสร้าง</span></div>
      <p className="form-note">ลิงก์แนะนำแบบ <code>/r/&lt;token&gt;</code> ใช้ติดตามว่าลูกค้ามาจากพนักงานคนไหน · ระบบเก็บเฉพาะ hash จึงต้องสร้างใหม่ถ้าทำหาย — สร้างได้ที่แท็บ “ลิงก์แนะนำ (Referral)” ในหน้า “ลูกค้า”</p>
      <p className="form-note">ลิงก์ที่ใช้ได้อยู่ตอนนี้: <strong>{link.activeReferralLinks}</strong> ลิงก์</p>
      <button className="secondary" onClick={() => onNavigate('referrals')}>ไปที่ลิงก์แนะนำ (Referral)</button>
    </section>

    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">เช็กลิสต์ความพร้อม</p><h3>ลิงก์นี้พร้อมแจกหรือยัง</h3></div><span className={`tag ${missing.length ? 'dry' : 'success'}`}>{missing.length ? 'ยังไม่ครบ' : 'ครบทุกข้อ'}</span></div>
      <div className="quest-list">{checks.map((item) => <div className="audit-row" key={item.label}><span className="audit-dot" /><div><strong><span className={`tag ${item.ok ? 'success' : 'dry'}`}>{item.ok ? 'พร้อม' : 'ยังไม่พร้อม'}</span> · {item.label}</strong><small>{item.hint}</small></div>{!item.ok && item.target && <button className="mini-btn" onClick={() => onNavigate(item.target!)}>{LABELS[item.target]}</button>}</div>)}</div>
      <div className="filter-row"><span>7 วันล่าสุด: คลิก <strong>{link.clicks7d}</strong> · เข้าสู่ระบบ <strong>{link.logins7d}</strong> · ติดตาม OA <strong>{link.follows7d}</strong></span></div>
      {link.tokenCheckedAt && <small className="form-note">ตรวจ token ล่าสุด {new Date(link.tokenCheckedAt).toLocaleString('th-TH')}</small>}
    </section>
  </section>;
}
