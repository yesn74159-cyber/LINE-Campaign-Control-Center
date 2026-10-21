const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const ALLOWED_REFS = new Set(['IMAGE_URL','LIFF_URL','TITLE','DESCRIPTION','CTA','OA_URL']);

export function validateCampaigns(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.campaigns) || !data.campaigns.length) throw new Error('campaigns.json ต้องมี version 1 และ campaigns อย่างน้อยหนึ่งรายการ');
  const seen = new Set();
  for (const c of data.campaigns) {
    if (!c || !idPattern.test(c.id || '') || seen.has(c.id)) throw new Error('Campaign ID ไม่ถูกต้องหรือซ้ำกัน');
    seen.add(c.id);
    for (const key of ['name','title','description','image','cta','flexFile']) {
      if (typeof c[key] !== 'string' || !c[key].trim()) throw new Error(`${c.id}: ขาด ${key}`);
    }
    if (!/^(assets|flex)\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|json)$/i.test(c.image) || !c.image.startsWith('assets/')) throw new Error(`${c.id}: image ต้องอยู่ภายใน assets/`);
    if (!/^flex\/[a-zA-Z0-9_-]+\.json$/.test(c.flexFile)) throw new Error(`${c.id}: flexFile ต้องอยู่ภายใน flex/`);
    if (c.active !== true && c.active !== false) throw new Error(`${c.id}: active ต้องเป็น true/false`);
  }
  if (!seen.has(data.defaultCampaign)) throw new Error('defaultCampaign ไม่ตรง Campaign ID');
  return data;
}

export function campaignLink(config, campaignId, source = 'share') {
  const u = new URL(config.miniAppUrl);
  if (u.protocol !== 'https:') throw new Error('LIFF URL ต้องใช้ HTTPS');
  u.searchParams.set('campaign', campaignId);
  u.searchParams.set('utm_source', source);
  return u.toString();
}

export function replaceFlexVars(value, vars) {
  if (Array.isArray(value)) return value.map(v => replaceFlexVars(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceFlexVars(v, vars)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!ALLOWED_REFS.has(key)) throw new Error(`Placeholder ไม่รองรับ: ${key}`);
    return String(vars[key] ?? '');
  });
}

export function prepareFlex(flex, config, campaign, baseUrl, source='share') {
  if (!flex || flex.type !== 'flex' || typeof flex.altText !== 'string' || !flex.altText || !flex.contents || !['bubble','carousel'].includes(flex.contents.type)) {
    throw new Error('Flex JSON ต้องมี type=flex, altText และ contents.type=bubble/carousel');
  }
  const out=replaceFlexVars(flex, {
    IMAGE_URL:new URL(campaign.image,baseUrl).href,
    LIFF_URL:campaignLink(config,campaign.id,source),
    TITLE:campaign.title, DESCRIPTION:campaign.description, CTA:campaign.cta,
    OA_URL:config.oaAddFriendUrl
  });
  if (out.altText.length>400) throw new Error('altText ต้องไม่เกิน 400 ตัวอักษร');
  if (JSON.stringify(out).length>45000) throw new Error('Flex JSON มีขนาดใหญ่เกินไป โปรดลดเนื้อหา');
  return out;
}

export function chooseCampaign(data,query) {
  const desired = new URLSearchParams(query).get('campaign') || data.defaultCampaign;
  return data.campaigns.find(c=>c.id===desired && c.active) || data.campaigns.find(c=>c.id===data.defaultCampaign && c.active) || data.campaigns.find(c=>c.active) || null;
}
