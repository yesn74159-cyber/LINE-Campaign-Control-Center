import { useEffect, useId, useState } from 'react';
import { sanitizeFlexCard } from './flexSanitize.js';

declare global {
  interface Window { flex2html?: (elementId: string, card: Record<string, unknown>) => string }
}

export default function FlexPreview({ card, fallback }: { card: unknown; fallback: string }) {
  const hostId = 'flex' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = '';
    const safe = sanitizeFlexCard(card);
    if (!safe || typeof window.flex2html !== 'function') { setBroken(true); return; }
    try { window.flex2html(hostId, safe); setBroken(false); } catch { setBroken(true); host.innerHTML = ''; }
  }, [card, hostId]);
  return <div className="chatbox flex-render">{broken ? <p className="flex-render-fallback">{fallback}</p> : <div id={hostId} />}</div>;
}
