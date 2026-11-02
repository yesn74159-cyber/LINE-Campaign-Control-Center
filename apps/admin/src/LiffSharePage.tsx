import { useEffect, useMemo, useState } from 'react';
import FlexPreview from './FlexPreview.js';
import { buildShareLink, decodeShareLink, textShareLink, type FlexCard } from './liffShare.js';

type ShareResult = { status: 'success' | 'cancel' | 'fail'; errorCode?: string; errorMessage?: string };
type Liff = {
  init: (options: { liffId: string }) => Promise<void>;
  isInClientLINEApp: () => boolean;
  isLoggedIn: () => boolean;
  login: () => void;
  isApiAvailable: (name: string) => boolean;
  getClientVersion: () => string;
  requestPermission: (scopes: string[]) => Promise<{ allGranted?: boolean }>;
  shareTargetPicker: (messages: unknown[], options?: { multiple?: boolean }) => Promise<ShareResult>;
};

declare global { interface Window { liff?: Liff } }

const SDK_SRC = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

const ERROR_HINTS: Record<string, string> = {
  NOT_AVAILABLE_CONTEXT: 'หน้านี้ต้องใช้ LIFF · เปิดจากลิงก์ liff.line.me ในแอป LINE เท่านั้น',
  NOT_AVAILABLE_FOR_USER_ACCOUNT: 'บัญชี LINE นี้ยังไม่เข้าเงื่อนไขการแชร์ผ่าน LIFF · บัญชีทดสอบบางประเภทใช้ฟีเจอร์นี้ไม่ได้',
  NOT_SUPPORTED_BY_CLIENT_VERSION: 'แอป LINE เวอร์ชันเก่า · อัปเดตแอปแล้วเปิดลิงก์ใหม่',
  PERMISSION_NOT_GRANTED: 'ยังไม่ได้อนุญาตให้ส่งข้อความในแชท',
  INVALID_REQUEST: 'LINE ปฏิเสธการ์ดใบนี้ · ตรวจ JSON อีกครั้ง',
  INVALID_STATUS_CODE: 'LIFF เปิดไม่สมบูรณ์ · ลองปิดแล้วเปิดลิงก์ใหม่',
  INTERNAL_ERROR: 'LINE รายงานความผิดพลาดภายใน · ลองอีกครั้ง',
  UNKNOWN_ERROR: 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'
};

function loadLiffSdk() {
  if (window.liff) return Promise.resolve(true);
  const injected = new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.liff));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  // A stalled CDN request would otherwise leave the operator staring at a spinner on their phone.
  const deadline = new Promise<boolean>((resolve) => setTimeout(() => resolve(Boolean(window.liff)), 8_000));
  return Promise.race([injected, deadline]);
}

export default function LiffSharePage() {
  const card = useMemo<FlexCard | null>(() => decodeShareLink(window.location.href), []);
  const [liffId, setLiffId] = useState<string | null | undefined>(undefined);
  const [phase, setPhase] = useState<'loading' | 'idle' | 'ready' | 'outside'>('loading');
  const [status, setStatus] = useState('กำลังเชื่อมต่อ LINE…');
  const [result, setResult] = useState('');
  const [needsPermission, setNeedsPermission] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetch('/api/config').then((response) => response.json()).then((config: { liffId?: string | null }) => {
      if (!alive) return;
      setLiffId(config.liffId || null);
    }).catch(() => { if (alive) setLiffId(null); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!card || !liffId) return;
    let alive = true;
    void (async () => {
      if (!(await loadLiffSdk())) {
        if (alive) { setPhase('outside'); setStatus('โหลดไลบรารี LIFF ไม่สำเร็จ · เช็กเน็ตแล้วรีเฟรช'); }
        return;
      }
      try {
        await window.liff!.init({ liffId });
        if (!alive) return;
        if (!window.liff!.isInClientLINEApp()) {
          setPhase('outside');
          setStatus('เปิดหน้านี้ในแอป LINE เท่านั้น (แตะลิงก์ในแชทหรือสแกน QR ด้วยกล้อง LINE)');
          return;
        }
        if (!window.liff!.isLoggedIn()) { window.liff!.login(); return; }
        if (!window.liff!.isApiAvailable('shareTargetPicker')) {
          setPhase('outside');
          setStatus(`แอป LINE ${window.liff!.getClientVersion() || 'เวอร์ชันเก่า'} ไม่รองรับการแชร์การ์ด · อัปเดตแอปแล้วเปิดใหม่`);
          return;
        }
        setPhase('ready');
        setStatus('เลือกเพื่อนหรือกลุ่ม แล้วกดยืนยันเพื่อส่งในชื่อของคุณ');
      } catch {
        if (alive) { setPhase('outside'); setStatus('เชื่อม LIFF ไม่สำเร็จ · น่าจะเปิดหน้านี้นอกแอป LINE'); }
      }
    })();
    return () => { alive = false; };
  }, [card, liffId]);

  if (!card) {
    return <div className="auth-screen"><div className="auth-card"><h1>ไม่พบการ์ดในลิงก์</h1><p className="auth-copy">ลิงก์แชร์ต้องสร้างจากหน้า Flex Studio · กลับไปกดปุ่ม “แชร์จากมือถือ (LIFF)” อีกครั้ง</p></div></div>;
  }

  if (liffId === undefined) {
    return <div className="auth-screen"><div className="auth-card"><h1>กำลังตั้งค่า…</h1><p className="auth-copy">กำลังเช็กว่าเซิร์ฟเวอร์ผูก LIFF app ไว้หรือยัง</p></div></div>;
  }

  if (liffId === null) {
    return <div className="auth-screen"><div className="auth-card"><h1>ยังไม่ตั้งค่า LIFF บนเซิร์ฟเวอร์</h1><p className="auth-copy">ใส่ค่า LINE_LIFF_CHANNEL_ID ใน .env.staging แล้วเริ่มใหม่ container API</p></div></div>;
  }

  const share = async () => {
    setBusy(true); setResult('');
    try {
      const outcome = await window.liff!.shareTargetPicker([card], { multiple: true });
      if (outcome.status === 'success') { setResult('ส่งแล้ว · การ์ดใบนี้จะอยู่ในแชทที่คุณเลือก'); setNeedsPermission(false); }
      else if (outcome.status === 'cancel') setResult('ยกเลิกการส่ง · ยังไม่มีข้อความออกจากเครื่อง');
      else {
        setResult(ERROR_HINTS[outcome.errorCode || 'UNKNOWN_ERROR'] || `LINE แจ้ง: ${outcome.errorMessage || outcome.errorCode || 'ไม่ทราบสาเหตุ'}`);
        setNeedsPermission((outcome.errorCode || '') === 'PERMISSION_NOT_GRANTED');
      }
    } catch (error) {
      const code = error instanceof Error ? error.name : '';
      setResult(ERROR_HINTS[code] || 'ส่งไม่สำเร็จ · ลองอีกครั้ง');
      setNeedsPermission(code === 'PERMISSION_NOT_GRANTED');
    } finally { setBusy(false); }
  };

  const askPermission = async () => {
    setBusy(true);
    try { await window.liff!.requestPermission(['chat_message.write']); window.location.reload(); }
    catch { setResult('ขออนุญาตไม่สำเร็จ · ลองอีกครั้ง'); setBusy(false); }
  };

  return <div className="share-screen">
    <header className="share-head"><p className="eyebrow green">MOBILE SHARE · LIFF</p><h1>ส่งการ์ดนี้จาก LINE ของคุณ</h1><p>{status}</p></header>
    <section className="share-card-wrap">
      <div className="line-card"><div className="line-header"><span className="line-logo">●</span><strong>สิ่งที่เพื่อนจะเห็น</strong></div>
        <FlexPreview card={card} fallback="การ์ดนี้แสดงผลไม่ได้ · กลับไปตรวจ JSON ใน Flex Studio" />
      </div>
    </section>
    <section className="share-actions">
      {phase === 'ready' && <button className="primary full" disabled={busy} onClick={() => void share()}>เลือกเพื่อนแล้วส่ง</button>}
      {(phase === 'loading' || phase === 'idle') && <button className="primary full" disabled>{busy ? 'กำลังส่ง…' : 'กำลังรอการเชื่อมต่อ LINE…'}</button>}
      {phase === 'outside' && <a className="primary full" href={textShareLink(card)}>เปิดใน LINE (ส่งเฉพาะข้อความ)</a>}
      {needsPermission && <button className="secondary full" disabled={busy} onClick={() => void askPermission()}>ขออนุญาตส่งข้อความในแชท</button>}
      {result && <p className="share-result">{result}</p>}
      <p className="form-note">การ์ดที่ส่งจะออกมาในชื่อของคุณ ไม่ใช่จาก OA · เพื่อนที่กดปุ่มในการการ์ดจะกลายเป็นผู้ติดตาม OA</p>
      <p className="share-mini">ลิงก์นี้: <code>{buildShareLink(liffId, card).slice(0, 48)}…</code></p>
    </section>
  </div>;
}
