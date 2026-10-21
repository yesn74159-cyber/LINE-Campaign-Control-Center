import { useEffect, useState, type FormEvent } from 'react';
import ConnectLineOa from './ConnectLineOa.js';
import { apiUrl } from './apiClient.js';

type Workspace = { id: string; name: string; slug: string; mode: string };
type Member = { id: string; email: string; displayName: string; role: string; status: string };
type Channel = {
  oaId: string; displayName: string;
  messagingChannelId: string | null; loginChannelId: string | null;
  lineProviderId: string | null; status: string;
};
type Session = { role: string; email: string };

async function workspaceRequest<T>(url: string, method = 'GET', body?: object): Promise<T> {
  const csrf = document.cookie.split('; ').find(item => item.startsWith('ccc_csrf='))?.slice('ccc_csrf='.length);
  const headers = new Headers();
  if (body) headers.set('content-type', 'application/json');
  if (csrf && method !== 'GET') headers.set('x-csrf-token', decodeURIComponent(csrf));
  const response = await fetch(apiUrl(url), {
    method, credentials: 'include', headers, body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || 'Request failed: ' + response.status);
  }
  return response.json() as Promise<T>;
}

export default function WorkspaceSettings({ session }: { session: Session }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [messaging, setMessaging] = useState('');
  const [login, setLogin] = useState('');
  const [provider, setProvider] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const isOwner = session.role === 'owner';

  async function load() {
    try {
      const [w, m, c] = await Promise.all([
        workspaceRequest<{ workspace: Workspace }>('/api/workspace/settings'),
        workspaceRequest<{ members: Member[] }>('/api/workspace/members'),
        workspaceRequest<{ channels: Channel[] }>('/api/workspace/oa-channels')
      ]);
      setWorkspace(w.workspace);
      setName(w.workspace.name);
      setMembers(m.members);
      setChannels(c.channels);
      setSelected(previous => c.channels.some(x => x.oaId === previous) ? previous : (c.channels[0]?.oaId || ''));
      setMessage('');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to load workspace'); }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const item = channels.find(x => x.oaId === selected);
    setMessaging(item?.messagingChannelId || '');
    setLogin(item?.loginChannelId || '');
    setProvider(item?.lineProviderId || '');
  }, [selected, channels]);

  async function saveWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!isOwner) return;
    setSaving(true);
    try {
      const result = await workspaceRequest<{ workspace: Workspace }>('/api/workspace/settings', 'PATCH', { name });
      setWorkspace(result.workspace);
      setMessage('บันทึกชื่อ Workspace เรียบร้อย');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ'); }
    finally { setSaving(false); }
  }

  async function saveChannel(event: FormEvent) {
    event.preventDefault();
    if (!isOwner || !selected) return;
    setSaving(true);
    try {
      const result = await workspaceRequest<{ status: string }>('/api/workspace/oa-channels/' + encodeURIComponent(selected), 'PUT', {
        messagingChannelId: messaging || null,
        loginChannelId: login || null,
        lineProviderId: provider || null
      });
      setMessage('บันทึกข้อมูล Channel แล้ว — สถานะ ' + result.status + ' (ยังไม่ได้เชื่อม LINE จริง)');
      const resultChannels = await workspaceRequest<{ channels: Channel[] }>('/api/workspace/oa-channels');
      setChannels(resultChannels.channels);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ'); }
    finally { setSaving(false); }
  }

  async function inviteMember(event: FormEvent) {
    event.preventDefault();
    if (!isOwner && session.role !== 'admin') return;
    setSaving(true);
    try {
      await workspaceRequest('/api/workspace/members', 'POST', { email: inviteEmail, displayName: inviteName, role: inviteRole });
      setInviteEmail(''); setInviteName(''); setInviteRole('viewer');
      setMessage('เชิญสมาชิกแล้ว — ส่งลิงก์ LINE Login Mock ให้สมาชิกได้จาก Referral Dashboard');
      const result = await workspaceRequest<{ members: Member[] }>('/api/workspace/members');
      setMembers(result.members);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'เชิญสมาชิกไม่สำเร็จ'); }
    finally { setSaving(false); }
  }

  async function updateMember(member: Member, change: { role?: string; status?: string }) {
    if (member.id === (session as Session & { id?: string }).id && (change.status === 'SUSPENDED' || change.role !== undefined)) {
      setMessage('ไม่อนุญาตให้ลดสิทธิ์หรือระงับบัญชีตัวเอง');
      return;
    }
    if (change.status === 'SUSPENDED' && !window.confirm(`ยืนยันระงับสมาชิก ${member.displayName}?`)) return;
    setSaving(true);
    try {
      await workspaceRequest(`/api/workspace/members/${encodeURIComponent(member.id)}`, 'PATCH', change);
      setMessage(change.status === 'SUSPENDED' ? 'ระงับสมาชิกแล้ว' : change.status === 'ACTIVE' ? 'เปิดใช้งานสมาชิกแล้ว' : 'ปรับ Role แล้ว');
      const result = await workspaceRequest<{ members: Member[] }>('/api/workspace/members');
      setMembers(result.members);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'ปรับสมาชิกไม่สำเร็จ'); }
    finally { setSaving(false); }
  }

  if (!workspace && !message) return <section className="panel"><h2>กำลังโหลด Workspace...</h2></section>;

  return <section className="stack">
    <div className="section-intro"><div>
      <p className="eyebrow green">MULTI-WORKSPACE / DRY RUN</p>
      <h2>Workspace &amp; LINE OA Settings</h2>
      <p>จัดการข้อมูลบริษัท ทีมงาน และ Channel ของ LINE OA โดยแยกตาม Workspace</p>
    </div><span className="tag dry">LINE SEND DISABLED</span></div>
    {message && <section className="panel" role="status">{message}</section>}
    <ConnectLineOa isOwner={isOwner} />
    <section className="panel">
      <p className="eyebrow green">WORKSPACE</p><h3>ตั้งค่าบริษัท</h3>
      <p>Workspace ID: <code>{workspace?.id || '-'}</code></p>
      <p>Slug: <code>{workspace?.slug || '-'}</code> | Mode: {workspace?.mode || 'DRY_RUN'}</p>
      <form className="tenant-form" onSubmit={saveWorkspace}>
        <label htmlFor="workspace-name">ชื่อบริษัท / Workspace</label>
        <input id="workspace-name" value={name} onChange={e => setName(e.target.value)}
          minLength={3} maxLength={100} required disabled={!isOwner || saving}/>
        <button className="primary" disabled={!isOwner || saving}>บันทึกชื่อบริษัท</button>
      </form>
    </section>
    <section className="panel">
      <p className="eyebrow green">STAFF ACCESS</p><h3>สมาชิก Workspace</h3>
       <p>บัญชีใน Workspace นี้เท่านั้น · LINE Login เป็น Mock และ Live ถูกปิด</p>
       <form className="tenant-form member-invite-form" onSubmit={inviteMember}>
         <label htmlFor="member-name">ชื่อสมาชิก</label>
         <input id="member-name" value={inviteName} onChange={e => setInviteName(e.target.value)} required maxLength={120} disabled={saving}/>
         <label htmlFor="member-email">Email สมาชิก</label>
         <input id="member-email" type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} required maxLength={320} disabled={saving}/>
         <label htmlFor="member-role">Role</label>
         <select id="member-role" value={inviteRole} onChange={e => setInviteRole(e.target.value)} disabled={saving}>
           {['owner','admin','editor','reviewer','viewer'].map(role => <option value={role} key={role}>{role}</option>)}
         </select>
         <button className="primary" disabled={saving}>เชิญสมาชิก</button>
       </form>
       <div className="tenant-table-wrap"><table className="tenant-table">
         <thead><tr><th>ชื่อ</th><th>Email</th><th>สิทธิ์</th><th>สถานะ</th><th>การจัดการ</th></tr></thead>
         <tbody>{members.map(member =>
           <tr key={member.id}><td>{member.displayName}</td><td>{member.email}</td>
             <td><select aria-label={`Role ${member.email}`} value={member.role} disabled={saving || member.id === (session as Session & { id?: string }).id} onChange={e => void updateMember(member, { role: e.target.value })}>{['owner','admin','editor','reviewer','viewer'].map(role => <option value={role} key={role}>{role}</option>)}</select></td>
             <td><span className={`tag ${member.status === 'ACTIVE' ? 'success' : member.status === 'SUSPENDED' ? 'paused' : 'dry'}`}>{member.status}</span></td>
             <td>{member.status === 'SUSPENDED' ? <button className="mini-btn" disabled={saving} onClick={() => void updateMember(member, { status: 'ACTIVE' })}>Reactivate</button> : member.status !== 'ACTIVE' ? <button className="mini-btn" disabled={saving} onClick={() => void updateMember(member, { status: 'ACTIVE' })}>Activate</button> : <button className="danger-btn" disabled={saving || member.id === (session as Session & { id?: string }).id} onClick={() => void updateMember(member, { status: 'SUSPENDED' })}>Suspend</button>}</td></tr>
         )}</tbody>
       </table></div>
    </section>
    <section className="panel">
      <p className="eyebrow green">CHANNEL METADATA</p><h3>LINE OA Connections</h3>
      <p>เลือก OA ที่เพิ่มไว้ในเมนู LINE OA เพื่อบันทึก Channel ID และ Provider ID</p>
      <p><strong>ยังไม่รับ Token / Secret ในหน้านี้</strong> และไม่มีการเรียก API ของ LINE</p>
      <form className="tenant-form" onSubmit={saveChannel}>
        <label htmlFor="oa-pick">LINE OA ของ Workspace</label>
        <select id="oa-pick" value={selected} onChange={e => setSelected(e.target.value)} required disabled={!isOwner || saving}>
          {!channels.length && <option value="">ไม่มี OA</option>}
          {channels.map(item => <option value={item.oaId} key={item.oaId}>{item.displayName} — {item.status}</option>)}
        </select>
        <label htmlFor="oa-message-id">Messaging API Channel ID</label>
        <input id="oa-message-id" value={messaging} onChange={e => setMessaging(e.target.value)}
          inputMode="numeric" pattern="[0-9]{5,30}" placeholder="1234567890" disabled={!isOwner || saving}/>
        <label htmlFor="oa-login-id">LINE Login Channel ID (ยังไม่เปิด OAuth)</label>
        <input id="oa-login-id" value={login} onChange={e => setLogin(e.target.value)}
          inputMode="numeric" pattern="[0-9]{5,30}" placeholder="1234567890" disabled={!isOwner || saving}/>
        <label htmlFor="oa-provider-id">LINE Provider ID</label>
        <input id="oa-provider-id" value={provider} onChange={e => setProvider(e.target.value)}
          pattern="[A-Za-z0-9_-]+" placeholder="provider-id" maxLength={120} disabled={!isOwner || saving}/>
        <button className="primary" disabled={!isOwner || saving || !selected || !messaging || !provider}>
          บันทึกข้อมูล Channel (ยังไม่เชื่อมจริง)
        </button>
      </form>
    </section>
  </section>;
}
