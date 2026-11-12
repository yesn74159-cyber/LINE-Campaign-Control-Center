import { type ReactNode } from 'react';
import { type Dashboard, type Oa, type Section, type User } from './types.js';
import OaPicker from '../OaPicker.js';

const navItems: { id: Section; label: string; icon: string; group: Section[] }[] = [
  { id: 'dashboard', label: 'ภาพรวม', icon: '⌂', group: ['dashboard'] },
  { id: 'push', label: 'ส่งข้อความตรง', icon: '✉', group: ['push', 'scheduler'] },
  { id: 'flex', label: 'สร้างข้อความ (Flex Studio)', icon: '✦', group: ['flex'] },
  { id: 'customers', label: 'ลูกค้า', icon: '♧', group: ['customers', 'referrals'] },
  { id: 'links', label: 'แจกลิงก์', icon: '↗', group: ['links'] },
  { id: 'oas', label: 'ตั้งค่า', icon: '⚙', group: ['oas', 'workspace', 'audit'] }
];

export default function Shell({ user, section, onNavigate, dashboard, notice, selectedOa, usableOas, onChooseOa, onRefresh, onLogout, children }: {
  user: User; section: Section; onNavigate: (section: Section) => void; dashboard: Dashboard; notice: string;
  selectedOa: Oa | null; usableOas: Oa[]; onChooseOa: (id: string) => void; onRefresh: () => void; onLogout: () => void; children: ReactNode;
}) {
  const activeNav = navItems.find((item) => item.group.includes(section)) || navItems[0]!;
  return <div className="shell">
    <aside className="sidebar"><div className="logo"><span>●</span><div><strong>LINE Campaign</strong><small>Control Center</small></div></div><div className={`mode-pill${dashboard.liveSendEnabled ? ' live' : ''}`}>● {dashboard.liveSendEnabled ? 'ส่งจริงได้ · LIVE' : 'โหมดทดสอบ · DRY RUN'}</div><nav>{navItems.map((item) => <button className={activeNav.id === item.id ? 'active' : ''} onClick={() => onNavigate(item.id)} key={item.id}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-foot">{dashboard.liveSendEnabled ? 'เซิร์ฟเวอร์เปิดประตูส่งจริง · ต้องพิมพ์คำยืนยันทุกครั้ง' : 'โหมดทดสอบ · ข้อความยังไม่ถึงลูกค้าจริง'}</div></aside>
    <main className="content"><header className="topbar"><div><p className="eyebrow">ศูนย์ควบคุมแคมเปญ LINE</p><h1>{section === 'dashboard' ? `สวัสดีครับ, ${user.displayName}` : (section === 'flex' ? 'Flex Studio' : activeNav.label)}</h1></div><div className="top-actions"><OaPicker oas={usableOas} value={selectedOa?.id || ''} onChange={onChooseOa} onOpenSettings={() => onNavigate('oas')} /><button className="icon-btn" onClick={onRefresh} aria-label="Refresh">↻</button><span className="role-label">{user.role}</span><div className="avatar">AD</div><button className="text-btn" onClick={onLogout}>ออกจากระบบ</button></div></header><div className="notice-bar"><span className="pulse" />{notice}<strong className={dashboard.liveSendEnabled ? 'live' : undefined}>{dashboard.liveSendEnabled ? 'โหมด LIVE · ต้องพิมพ์ LIVE หรือ SEND เพื่อยืนยัน' : 'ไม่มีการส่งออก LINE'}</strong></div>{children}</main>
  </div>;
}
