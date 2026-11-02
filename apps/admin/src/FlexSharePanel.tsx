import { useState } from 'react';
import { buildShareLink, findPlaceholders, type FlexCard } from './liffShare.js';

const STEPS = [
  'คัดลอกลิงก์ด้านล่าง แล้วส่งเข้าแชท LINE ของตัวเอง (หรือเก็บไว้ใน Keep)',
  'แตะลิงก์ในแอป LINE — หน้าแชร์จะเปิดพร้อมการ์ดใบนี้',
  'กด “เลือกเพื่อนแล้วส่ง” แล้วเลือกได้หลายแชทในครั้งเดียว',
  'เพื่อนเห็นการ์ดจากชื่อคุณ ไม่ใช่จาก OA · กดปุ่มในการการ์ดจะพาเข้า OA'
];

export default function FlexSharePanel({ card, liffId }: { card: FlexCard; liffId: string }) {
  const [copied, setCopied] = useState('');
  const link = buildShareLink(liffId, card);
  const leftovers = findPlaceholders(card);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied('คัดลอกแล้ว'); }
    catch { setCopied('เบราว์เซอร์ไม่อนุญาตให้คัดลอกอัตโนมัติ · แตะที่ลิงก์แล้วคัดลอกเอง'); }
  };
  return <section className="panel share-panel">
    <div className="panel-head"><div><p className="eyebrow green">SHARE FROM YOUR PHONE · LIFF</p><h3>ส่งการ์ดในชื่อคุณ ให้เพื่อนหลายคนพร้อมกัน</h3></div><span className="tag dry">ไม่ผ่าน LINE OA</span></div>
    {leftovers.length > 0 && <p className="auth-error">การ์ดมีตัวยึดที่ยังไม่แทนค่า: {leftovers.join(', ')} · แก้ก่อนส่ง ไม่งั้น LINE จะตอบ 400</p>}
    <ol className="share-steps">{STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
    <div className="share-link-row">
      <input readOnly value={link} onFocus={(event) => event.currentTarget.select()} aria-label="ลิงก์ LIFF สำหรับแชร์การ์ด" />
      <button className="secondary" onClick={() => void copy()}>คัดลอก</button>
    </div>
    {copied && <p className="form-note">{copied}</p>}
    <p className="form-note">ต้องใช้ได้ก็ต่อเมื่อ LIFF app ของ channel นี้ชี้ endpoint มาที่ /share บนโดเมนเดียวกัน และ OA ถูก link เป็น bot ของ channel แล้ว</p>
  </section>;
}
