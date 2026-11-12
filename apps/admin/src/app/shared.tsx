import { type Section } from './types.js';

export function Tabs({ items, value, onChange }: { items: [Section, string][]; value: Section; onChange: (section: Section) => void }) {
  return <div className="tab-strip" role="tablist">{items.map(([id, label]) => <button key={id} role="tab" aria-selected={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>{label}</button>)}</div>;
}

export function Empty({ text }: { text: string }) { return <div className="empty-inline">{text}</div>; }
