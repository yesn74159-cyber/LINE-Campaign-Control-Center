import { useState } from 'react';
import ReferralDashboard from '../ReferralDashboard.js';
import { maskLineKey } from './labels.js';
import { Tabs } from './shared.js';
import { type Customer, type Section } from './types.js';

export default function CustomersPage({ section, onNavigate, customers, canWrite, canManage, oaId, onOptOut }: { section: Section; onNavigate: (section: Section) => void; customers: Customer[]; canWrite: boolean; canManage: boolean; oaId: string; onOptOut: (id: string) => Promise<void> }) {
  return <>
    <Tabs items={[['customers', 'รายชื่อ'], ['referrals', 'ลิงก์แนะนำ (Referral)']]} value={section} onChange={onNavigate} />
    {section === 'customers' && <CustomersView customers={customers} canWrite={canWrite} onOptOut={onOptOut} />}
    {section === 'referrals' && <ReferralDashboard canManage={canManage} oaId={oaId} />}
  </>;
}

export function CustomersView({ customers, canWrite, onOptOut }: { customers: Customer[]; canWrite: boolean; onOptOut: (id: string) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState('');
  const needle = query.trim().toLowerCase();
  const filtered = customers.filter((customer) => !needle || [customer.displayName, customer.lineUserKey, customer.providerId].filter(Boolean).join(' ').toLowerCase().includes(needle));
  const exportCsv = () => {
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const header = ['id', 'providerId', 'lineUserKey', 'displayName', 'optIn', 'blockedAt', 'optOutAt', 'optOutSource'];
    const rows = filtered.map((customer) => [customer.id, customer.providerId, customer.lineUserKey, customer.displayName || '', String(customer.optIn), customer.blockedAt || '', customer.optOutAt || '', customer.optOutSource || '']);
    // The BOM keeps Thai names readable when the file is opened in Excel.
    const blob = new Blob([`\uFEFF${[header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    URL.revokeObjectURL(url);
  };
  const optOut = async (id: string) => { setBusyId(id); try { await onOptOut(id); } finally { setBusyId(''); } };
  return <section className="stack"><div className="section-intro"><div><p className="eyebrow green">ฐานข้อมูลลูกค้า</p><h2>ลูกค้าในระบบ</h2><p>รายชื่อลูกค้าที่ติดตาม LINE OA · เมื่อยกเลิกความยินยอม ระบบจะหยุดส่งทันทีจนกว่าลูกค้าจะติดตาม OA ใหม่</p></div><span className="tag dry">{customers.length} คน</span></div>{customers.length ? <section className="panel table-panel"><div className="table-head"><label htmlFor="customer-search">ค้นหา<input id="customer-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ชื่อ หรือ LINE ID" /></label><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span>{filtered.length} / {customers.length}</span><button className="secondary" onClick={exportCsv} disabled={!filtered.length}>⬇ ดาวน์โหลด CSV</button></div></div>{filtered.map((customer) => <div className="audit-row" key={customer.id}><span className="audit-dot" /><div><strong>{customer.displayName || 'ลูกค้า LINE'}</strong><small>LINE ID {maskLineKey(customer.lineUserKey)}{customer.optOutAt ? ` · ยกเลิกความยินยอม ${new Date(customer.optOutAt).toLocaleString('th-TH')}${customer.optOutSource === 'line_unfollow' ? ' (เลิกติดตาม OA)' : customer.optOutSource === 'operator' ? ' (เจ้าหน้าที่บันทึก)' : ''}` : ''}</small></div><span className={`tag ${customer.blockedAt ? 'paused' : customer.optIn ? 'success' : 'dry'}`}>{customer.blockedAt ? 'บล็อกอยู่' : customer.optIn ? 'ยินยอมรับข้อความ' : 'ยังไม่ยินยอม'}</span><button className="mini-btn" disabled={!canWrite || busyId === customer.id || (!customer.optIn && Boolean(customer.blockedAt))} onClick={() => void optOut(customer.id)}>{busyId === customer.id ? 'กำลังบันทึก...' : 'ยกเลิกความยินยอม'}</button></div>)}{!filtered.length && <div className="empty-inline">ไม่พบลูกค้าที่ตรงกับคำค้น</div>}</section> : <div className="empty-state"><span>♧</span><h3>ยังไม่มีลูกค้าในระบบ</h3><p>ลูกค้าจะปรากฏที่นี่เมื่อกดติดตาม LINE OA</p></div>}</section>;
}
