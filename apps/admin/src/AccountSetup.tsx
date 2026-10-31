import { useState, type FormEvent } from 'react';
import { apiUrl } from './apiClient.js';

export default function AccountSetup() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirm) { setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน'); return; }
    setBusy(true);
    try {
      const response = await fetch(apiUrl('/api/account/setup'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || 'ตั้งรหัสผ่านไม่สำเร็จ');
      setDone(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ตั้งรหัสผ่านไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <div className="auth-screen"><div className="auth-card">
    <div className="logo"><span>●</span><div><strong>LINE Campaign</strong><small>Control Center</small></div></div>
    <p className="eyebrow green">STAGING ACCOUNT</p>
    <h1>ตั้งรหัสผ่าน</h1>
    {!token ? <p className="auth-error">ลิงก์นี้ไม่สมบูรณ์ กรุณาขอลิงก์ใหม่จาก Owner หรือ Admin</p>
      : done ? <>
          <p className="auth-copy">ตั้งรหัสผ่านเรียบร้อย บัญชีพร้อมใช้งานแล้ว</p>
          <a className="primary full" href="/">ไปหน้าเข้าสู่ระบบ</a>
        </> : <>
          <p className="auth-copy">ลิงก์นี้ใช้ได้ครั้งเดียวและมีอายุจำกัด หลังตั้งรหัสผ่านแล้ว session เดิมทั้งหมดจะถูกยกเลิก</p>
          <form onSubmit={submit}>
            <label htmlFor="setup-password">รหัสผ่านใหม่</label>
            <input id="setup-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={200} required />
            <label htmlFor="setup-confirm">ยืนยันรหัสผ่าน</label>
            <input id="setup-confirm" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" minLength={12} maxLength={200} required />
            {error && <p className="auth-error">{error}</p>}
            <button className="primary full" disabled={busy}>{busy ? 'กำลังบันทึก...' : 'ตั้งรหัสผ่าน'}</button>
          </form>
          <small className="auth-foot">อย่างน้อย 12 ตัวอักษร · DRY RUN · ไม่ส่งรหัสผ่านไป LINE</small>
        </>}
  </div></div>;
}
