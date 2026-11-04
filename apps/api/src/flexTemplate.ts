import type { Campaign } from './types.js';

/**
 * The shipped templates are written with {{VARIABLE}} slots for the older single-file prototype.
 * Nothing in this app substitutes them, so an untouched template used to reach LINE with the
 * braces still in it and the send failed. The slots this app can fill from its own configuration
 * are filled at read time; any other {{...}} is left alone so the Flex validator can reject it.
 */
function templateVars(campaign: Campaign) {
  const origin = (process.env.PUBLIC_APP_ORIGIN || 'http://127.0.0.1:5173').replace(/\/$/, '');
  const image = campaign.image.split('/').pop() || 'coupon.png';
  const liffId = process.env.LINE_LIFF_CHANNEL_ID || '';
  return {
    TITLE: campaign.title,
    DESCRIPTION: campaign.description,
    CTA: campaign.cta,
    IMAGE_URL: `${origin}/flex/${image}`,
    LIFF_URL: liffId ? `https://liff.line.me/${liffId}` : `${origin}/share`,
    OA_URL: process.env.LINE_OA_FRIEND_URL || origin
  } as Record<string, string>;
}

function mapStrings(flex: Record<string, unknown>, map: (value: string) => string): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'string') return map(node);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, child]) => [key, walk(child)]));
    return node;
  };
  return walk(flex) as Record<string, unknown>;
}

export function fillFlexTemplate(campaign: Campaign, flex: Record<string, unknown>): Record<string, unknown> {
  const vars = templateVars(campaign);
  return mapStrings(flex, (value) => value.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => vars[key] ?? match));
}

/**
 * Flex Studio edits the *filled* card, so saving it verbatim freezes this host's origin into the
 * revision — a domain change then leaves every stored card pointing at a dead name. The URL slots
 * are mapped back before storing; a link the operator typed himself is not a filler value and stays.
 */
export function canonicalizeFlexTemplate(campaign: Campaign, flex: Record<string, unknown>): Record<string, unknown> {
  const vars = templateVars(campaign);
  const slots = ['IMAGE_URL', 'LIFF_URL', 'OA_URL']
    .map((key) => ({ token: `{{${key}}}`, value: vars[key] }))
    .filter((slot) => slot.value.startsWith('https://'))
    .sort((a, b) => b.value.length - a.value.length);
  return mapStrings(flex, (value) => slots.reduce((out, slot) => out.split(slot.value).join(slot.token), value));
}
