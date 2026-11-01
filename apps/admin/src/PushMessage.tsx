import { useEffect, useMemo, useState } from 'react';
import { apiUrl } from './apiClient.js';
import FlexPreview from './FlexPreview.js';

type OaOption = { id: string; displayName: string; basicId: string; enabled: boolean; environment: string; killSwitch: boolean };
type CustomerOption = { lineUserKey: string; providerId: string; displayName?: string; optIn: boolean; blockedAt?: string };
type Preview = {
  previewId: string; oaDisplayName: string; recipient: string; text: string; mode: string; expiresAt: string;
  recipientName: string | null; messageType: 'text' | 'flex'; flex: Record<string, unknown> | null;
};
type PushRow = {
  id: string; recipient: string; text: string; messageType: string; mode: string; status: string; providerStatus: number | null;
  providerMessageId: string | null; recipientName: string | null; error: string | null; createdAt: string;
};
type FlexSeed = { flex: Record<string, unknown>; label?: string } | null;

const MAX_CHARS = 5000;
const RECIPIENT_PATTERN = /^U[0-9a-f]{32}$/i;
const MANUAL_RECIPIENT = '__manual__';

/** The strings a card will show, flattened for the preview bubble and the length counter. */
function collectFlexTexts(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) { for (const item of value) collectFlexTexts(item, out); return out; }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Flex puts the visible words in different keys depending on the element type.
    for (const key of ['text', 'title', 'subtitle', 'label']) if (typeof record[key] === 'string') out.push(record[key] as string);
    for (const [key, child] of Object.entries(record)) if (!['text', 'title', 'subtitle', 'label'].includes(key)) collectFlexTexts(child, out);
  }
  return out;
}

const statusLabel: Record<string, string> = {
  PREVIEW: 'รอตรวจข้อความ', SENDING: 'กำลังส่ง', SENT: 'ส่งแล้ว', FAILED: 'ส่งไม่สำเร็จ',
  UNKNOWN: 'LINE ยังไม่ยืนยัน', EXPIRED: 'หมดเวลา', BLOCKED: 'ระบบบล็อกไว้'
};

class PushApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

async function pushRequest<T>(url: string, method: 'GET' | 'POST' = 'GET', body?: object): Promise<T> {
  const csrf = document.cookie.split('; ').find((item) => item.startsWith('ccc_csrf='))?.slice('ccc_csrf='.length);
  const headers = new Headers();
  if (body) headers.set('content-type', 'application/json');
  if (csrf && method !== 'GET') headers.set('x-csrf-token', decodeURIComponent(csrf));
  const response = await fetch(apiUrl(url), { method, credentials: 'include', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null) as ({ error?: string; code?: string } & T) | null;
  if (!response.ok) throw new PushApiError(data?.error || `Request failed (${response.status})`, data?.code);
  return data as T;
}

export default function PushMessage({ oas, customers, liveSendEnabled, seed, onSeedUsed }: { oas: OaOption[]; customers: CustomerOption[]; liveSendEnabled: boolean; seed: FlexSeed; onSeedUsed: () => void }) {
  const enabledOas = useMemo(() => oas.filter((oa) => oa.enabled && oa.environment === 'STAGING'), [oas]);
  const consented = useMemo(() => customers.filter((item) => item.optIn && !item.blockedAt && RECIPIENT_PATTERN.test(item.lineUserKey)), [customers]);
  const [oaId, setOaId] = useState(enabledOas[0]?.id || '');
  const [recipientSelect, setRecipientSelect] = useState(consented[0]?.lineUserKey || MANUAL_RECIPIENT);
  const [manualRecipient, setManualRecipient] = useState('');
  const [kind, setKind] = useState<'text' | 'flex'>('text');
  const [text, setText] = useState('');
  const [flexText, setFlexText] = useState('');
  const [live, setLive] = useState(false);
  const [confirmWord, setConfirmWord] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<PushRow[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { if (!enabledOas.some((oa) => oa.id === oaId)) setOaId(enabledOas[0]?.id || ''); }, [enabledOas, oaId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 20_000); return () => clearInterval(timer); }, []);
  const loadHistory = () => { void pushRequest<{ pushes: PushRow[] }>('/api/messages/push/history').then((data) => setHistory(data.pushes)).catch(() => undefined); };
  useEffect(loadHistory, []);
  useEffect(() => {
    if (recipientSelect !== MANUAL_RECIPIENT && !consented.some((item) => item.lineUserKey === recipientSelect)) {
      setRecipientSelect(consented[0]?.lineUserKey || MANUAL_RECIPIENT);
      setPreview(null); setResult(''); setConfirmWord('');
    }
  }, [consented, recipientSelect]);
  // Flex Studio hands the card over here, so the operator never re-types JSON.
  useEffect(() => {
    if (!seed) return;
    setKind('flex'); setFlexText(JSON.stringify(seed.flex, null, 2)); setPreview(null); setResult(''); setConfirmWord('');
    onSeedUsed();
    // Only a new hand-off should reset the editor; onSeedUsed changes identity on every parent render.
  }, [seed]);

  const selectedOa = enabledOas.find((oa) => oa.id === oaId);
  const recipient = recipientSelect === MANUAL_RECIPIENT ? manualRecipient.trim() : recipientSelect;
  const customer = consented.find((item) => item.lineUserKey.toLowerCase() === recipient.toLowerCase());
  const flexDoc = useMemo(() => {
    if (kind !== 'flex') return null;
    try { return JSON.parse(flexText) as Record<string, unknown>; } catch { return undefined; }
  }, [kind, flexText]);
  const charCount = kind === 'flex' ? [...(typeof flexDoc?.altText === 'string' ? flexDoc.altText : '')].length : [...text.trim()].length;
  const minutesLeft = preview ? Math.ceil((new Date(preview.expiresAt).getTime() - now) / 60_000) : 0;
  const previewAlive = Boolean(preview && minutesLeft > 0);
  const isLive = preview?.mode === 'LIVE';
  const canPreview = Boolean(
    selectedOa && !selectedOa.killSwitch && RECIPIENT_PATTERN.test(recipient) &&
    (kind === 'flex' ? flexDoc !== null && flexDoc !== undefined : charCount > 0 && charCount <= MAX_CHARS)
  );

  const resetFlow = () => { setPreview(null); setResult(''); setConfirmWord(''); };

  const createPreview = async () => {
    setBusy(true); setError(''); setResult('');
    const body = { oaId, recipient, mode: liveSendEnabled && live ? 'LIVE' as const : 'DRY_RUN' as const, ...(kind === 'flex' ? { flex: flexDoc } : { text }) };
    try {
      setPreview(await pushRequest<Preview>('/api/messages/push/preview', 'POST', body));
      setConfirmWord('');
    } catch (reason) { setPreview(null); setError(reason instanceof Error ? reason.message : 'สร้าง Preview ไม่สำเร็จ'); }
    finally { setBusy(false); }
  };

  const sendMessage = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const sent = await pushRequest<{ status: string; providerStatus?: number; providerMessageId?: string | null }>('/api/messages/push/send', 'POST', { previewId: preview.previewId, confirm: confirmWord });
      setResult(sent.status === 'SENT'
        ? `ส่งแล้ว (${sent.providerStatus || 'OK'})${sent.providerMessageId ? ' · หลักฐาน ' + sent.providerMessageId : ''} · โหมด ${preview.mode}`
        : 'ระบบรับเรื่องแล้ว แต่ยังไม่ยืนยันจาก LINE');
      setPreview(null); setConfirmWord(''); setText(''); loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ส่งไม่สำเร็จ');
      if (reason instanceof PushApiError && ['PREVIEW_STALE', 'PREVIEW_BLOCKED', 'CONSENT_REQUIRED', 'KILL_SWITCH_ACTIVE', 'OA_DISABLED'].includes(reason.code || '')) setPreview(null);
      loadHistory();
    } finally { setBusy(false); }
  };

  return <section className="stack">
    <div className="section-intro"><div>
      <p className="eyebrow green">SEND TO ONE PERSON</p>
      <h2>ส่งข้อความตรงถึงลูกค้า 1 คน</h2>
      <p>เขียนข้อความ → กด "ดูตัวอย่างก่อน" → พิมพ์ SEND → ส่งเข้า LINE ของผู้รับ</p>
    </div><span className={`mode-pill ${isLive ? 'live' : ''}`}>{preview ? `โหมด ${preview.mode}` : liveSendEnabled ? 'เลือกโหมดได้ในขั้นที่ 2' : 'โหมดทดสอบ (DRY RUN)'}</span></div>

    {enabledOas.length === 0 && <section className="panel"><h3>ยังไม่มี LINE OA ที่เปิดใช้งาน</h3><p>ไปหน้า "LINE OA" แล้วเปิดใช้งานบัญชีที่ต้องการก่อน</p></section>}

    <div className="push-layout">
      <section className="panel push-form">
        <div className="panel-head"><div><p className="eyebrow">ขั้นที่ 1</p><h3>เลือกผู้รับ</h3></div></div>
        <label htmlFor="push-oa">บัญชี LINE OA ที่ใช้ส่ง</label>
        <select id="push-oa" value={oaId} onChange={(event) => { setOaId(event.target.value); resetFlow(); }}>
          {enabledOas.map((oa) => <option value={oa.id} key={oa.id}>{oa.displayName} · {oa.basicId}</option>)}
        </select>
        <label htmlFor="push-recipient">ลูกค้า (เฉพาะคนที่อนุญาตให้ส่ง)</label>
        <select id="push-recipient" value={recipientSelect} onChange={(event) => { setRecipientSelect(event.target.value); resetFlow(); }}>
          {consented.map((item) => <option value={item.lineUserKey} key={item.lineUserKey}>{item.displayName || 'ลูกค้า'} · {item.lineUserKey}</option>)}
          <option value={MANUAL_RECIPIENT}>กรอก LINE User ID เอง</option>
        </select>
        {recipientSelect === MANUAL_RECIPIENT && <>
          <label htmlFor="push-recipient-manual">LINE User ID (ขึ้นต้นด้วย U ตามด้วยตัวอักษร 32 ตัว)</label>
          <input id="push-recipient-manual" value={manualRecipient} onChange={(event) => { setManualRecipient(event.target.value); resetFlow(); }} placeholder="U87cf..." spellCheck={false} />
          <p className="form-note">ต้องเป็นผู้ใช้ที่กดเพิ่มเพื่อน OA นี้ และยังไม่บล็อก · ระบบตรวจสิทธิ์ก่อนส่งทุกครั้ง</p>
        </>}
        {customer?.displayName && <p className="push-hint">ผู้รับ: {customer.displayName}</p>}
      </section>

      <section className="panel push-form">
        <div className="panel-head"><div><p className="eyebrow">ขั้นที่ 2</p><h3>{kind === 'flex' ? 'เลือกการ์ดที่จะส่ง' : 'เขียนข้อความ'}</h3></div><span className={`tag ${kind === 'flex' ? 'purple-tag' : charCount > MAX_CHARS ? 'status-error' : 'dry'}`}>{kind === 'flex' ? 'FLEX CARD' : `${charCount} / ${MAX_CHARS}`}</span></div>
        <div className="mode-choice">
          <label className={kind === 'flex' ? 'choice' : 'choice selected'}><input type="radio" name="push-kind" checked={kind === 'text'} onChange={() => { setKind('text'); resetFlow(); }} /><span>ข้อความธรรมดา</span><small>พิมพ์แล้วส่ง เหมาะกับคำถาม-ตอบสั้น ๆ</small></label>
          <label className={kind === 'text' ? 'choice' : 'choice selected'}><input type="radio" name="push-kind" checked={kind === 'flex'} onChange={() => { setKind('flex'); resetFlow(); }} /><span>การ์ดสวย (Flex)</span><small>ส่งรูป + ปุ่ม เหมือนใน Flex Studio</small></label>
        </div>
        {kind === 'flex' && <>
          <label htmlFor="push-flex-alt">บรรทัดที่ LINE แสดงใน 알림 (altText)</label>
          <input id="push-flex-alt" value={typeof flexDoc?.altText === 'string' ? flexDoc.altText : ''} readOnly placeholder="มาจาก JSON ด้านล่าง" />
          <label htmlFor="push-flex-json">Flex JSON</label>
          <textarea id="push-flex-json" value={flexText} onChange={(event) => { setFlexText(event.target.value); resetFlow(); }} rows={10} spellCheck={false} placeholder='{ "type": "flex", "altText": "...", "contents": { "type": "bubble" } }' />
          <p className="form-note">{flexText.trim() === '' ? 'เปิดหน้า “สร้างข้อความ (Flex Studio)” แล้วกด “แชร์เข้าแชท” เพื่อเอาการ์ดมาวางที่นี่'
            : flexDoc === undefined ? 'JSON ยังไม่ถูกต้อง · ตรวจอีกครั้งก่อนกดดูตัวอย่าง'
            : collectFlexTexts(flexDoc).length ? `ในการ์ดมี ${collectFlexTexts(flexDoc).length} ข้อความ · ${JSON.stringify(flexDoc).length.toLocaleString('th-TH')} ตัวอักษร`
            : 'การ์ดนี้ยังไม่มีข้อความ'} · ขนาดที่ LINE รับได้: บับเบิลเดียวไม่เกิน 30KB · แครูเซลไม่เกิน 50KB และ 12 บับเบิล</p>
        </>}
        {kind === 'text' && <textarea id="push-text" value={text} onChange={(event) => { setText(event.target.value); resetFlow(); }} rows={9} spellCheck={false} placeholder="เช่น สวัสดีครับ มีโปรโมชั่นพิเศษสำหรับคุณ 🎁" />}
        {liveSendEnabled && <div className="push-mode-choice"><label className={live ? 'choice' : 'choice selected'}><input type="radio" name="push-mode" checked={!live} onChange={() => { setLive(false); resetFlow(); }} /><span>ทดสอบ (DRY RUN)</span><small>บันทึกหลักฐานจำลอง ไม่ยิง LINE</small></label><label className={live ? 'choice selected' : 'choice'}><input type="radio" name="push-mode" checked={live} onChange={() => { setLive(true); resetFlow(); }} /><span>ส่งเข้า LINE จริง (LIVE)</span><small>ถึงผู้รับทันทีที่กด SEND ยืนยัน</small></label></div>}
        {!liveSendEnabled && <p className="push-hint">เซิร์ฟเวอร์อยู่โหมดทดสอบ (DRY RUN) · กดดูตัวอย่างแล้วระบบจะไม่ยิง LINE จริง</p>}
        <div className="form-actions">
          <button className="primary" disabled={!canPreview || busy} onClick={() => void createPreview()}>{busy ? 'กำลังทำงาน...' : 'ดูตัวอย่างก่อน (Preview)'}</button>
        </div>
        {selectedOa?.killSwitch && <p className="auth-error">OA นี้กำลังเปิด Kill Switch อยู่ ระบบจะไม่ส่งข้อความ</p>}
      </section>
    </div>

    {preview && <section className="panel push-preview">
      <div className="panel-head"><div><p className="eyebrow purple-text">ขั้นที่ 3 · ยังไม่ได้ส่ง</p><h3>ตรวจข้อความก่อนยืนยัน</h3></div>
        <span className={`tag ${preview.mode === 'LIVE' ? 'success' : 'dry'}`}>{preview.mode === 'LIVE' ? 'ส่งเข้า LINE จริง' : 'DRY RUN · ไม่ยิง LINE'}</span></div>
      <div className="push-bubble"><strong>{preview.oaDisplayName}</strong>{preview.messageType === 'flex'
        ? <div className="push-flex-preview"><FlexPreview card={preview.flex ?? null} fallback="การ์ดนี้แสดงผลไม่ได้ · กลับไปตรวจ JSON ใน Flex Studio" /><small>การ์ด Flex · altText (สิ่งที่ขึ้นในแจ้งเตือน): {preview.text}</small></div>
        : <p>{preview.text}</p>}</div>
      <p className="push-meta">ผู้รับ: {preview.recipient}{preview.recipientName ? ` (${preview.recipientName})` : ''} · {preview.messageType === 'flex' ? 'การ์ด Flex' : 'ข้อความ'} · อยู่ได้อีก {minutesLeft} นาที</p>
      {preview.mode === 'LIVE' && <p className="push-meta">LINE ยืนยันว่าผู้รับรายนี้ยังเปิดรับข้อความ (ตรวจจากโปรไฟล์ก่อนส่ง)</p>}
      {preview.mode === 'DRY_RUN' && <p className="form-note">โหมดทดสอบ: ระบบจะบันทึกหลักฐานจำลองเท่านั้น ไม่มีการส่งเข้า LINE</p>}
      {preview.messageType === 'flex' && <p className="form-note">อยากโชว์ให้เพื่อนดูในแชท: ส่งการ์ดนี้เข้า LINE ของคุณก่อน แล้วในแอป LINE ให้กดค้างที่ข้อความ → “ส่งต่อ” เลือกห้องเพื่อน (LINE ไม่มีปุ่มแชร์การ์ดจากหน้าเว็บ)</p>}
      <div className="form-actions">
        <input id="push-confirm" className="send-word" value={confirmWord} onChange={(event) => setConfirmWord(event.target.value)} placeholder="พิมพ์ SEND" disabled={!previewAlive} spellCheck={false} />
        <button className="danger-btn" disabled={!previewAlive || confirmWord !== 'SEND' || busy} onClick={() => void sendMessage()}>ส่งข้อความจริง</button>
        <button className="secondary" disabled={busy} onClick={resetFlow}>ยกเลิก</button>
      </div>
      {!previewAlive && <p className="auth-error">Preview หมดเวลาแล้ว · กด "ดูตัวอย่างก่อน" ใหม่</p>}
    </section>}

    {result && <section className="panel push-result success"><strong>● {result}</strong><p>HTTP 200 ไม่ได้แปลว่าลูกค้าเห็นข้อความเสมอไป ให้ดูประวัติด้านล่างและถามลูกค้าประกอบ</p></section>}
    {error && <section className="panel push-result failure"><strong>✕ {error}</strong></section>}

    <section className="panel table-panel">
      <div className="table-head"><strong>ประวัติการส่งตรง</strong><span>{history.length} รายการล่าสุด</span></div>
      {history.length ? history.map((row) => <div className="audit-row" key={row.id}>
        <span className={`audit-dot ${row.status === 'SENT' ? 'green-dot' : ''}`} />
        <div><strong>{statusLabel[row.status] || row.status} · {row.mode}</strong><small>{row.recipientName || row.recipient} · {row.messageType === 'flex' ? '[การ์ด Flex] ' : ''}"{row.text.slice(0, 60)}{row.text.length > 60 ? '…' : ''}"{row.error ? ` · ${row.error}` : ''}</small></div>
        <time>{new Date(row.createdAt).toLocaleString('th-TH')}</time>
      </div>) : <div className="empty-inline">ยังไม่มีการส่งข้อความตรง</div>}
    </section>
  </section>;
}
