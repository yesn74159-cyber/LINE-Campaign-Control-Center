import { type Oa } from './app/types.js';

/** The single OA selector for the whole app: every screen reads the same choice. */
export default function OaPicker({ oas, value, onChange, onOpenSettings }: { oas: Oa[]; value: string; onChange: (id: string) => void; onOpenSettings: () => void }) {
  return <>
    <label className="oa-pick-label" htmlFor="oa-picker">LINE OA</label>
    <select id="oa-picker" className="oa-picker" value={value} onChange={(event) => onChange(event.target.value)} disabled={!oas.length}>{oas.map((oa) => <option value={oa.id} key={oa.id}>{oa.displayName} · {oa.basicId}</option>)}{!oas.length && <option value="">ยังไม่มี OA ที่เปิดใช้งาน</option>}</select>
    {!oas.length && <button className="mini-btn" onClick={onOpenSettings}>เปิดใช้งาน OA</button>}
  </>;
}
