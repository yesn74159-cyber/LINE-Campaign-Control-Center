export type FlexCard = { type: 'flex'; altText: string; contents: Record<string, unknown> };

const PLACEHOLDER = /\{\{[^{}]*\}\}/;
const MAX_ENCODED_LENGTH = 20_000;

function toBase64Url(json: string) {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/** Placeholders survive copy-paste from the shipped templates, so the operator is warned before LINE rejects the card. */
export function findPlaceholders(card: unknown) {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') { if (typeof value === 'string') for (const hit of value.match(new RegExp(PLACEHOLDER, 'g')) || []) found.add(hit); return; }
    for (const child of Object.values(value as Record<string, unknown>)) walk(child);
  };
  walk(card);
  return [...found];
}

function isFlexCard(value: unknown): value is FlexCard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  const contents = card.contents as Record<string, unknown> | undefined;
  return card.type === 'flex' && typeof card.altText === 'string' && card.altText.length > 0 && card.altText.length <= 400
    && Boolean(contents) && ['bubble', 'carousel'].includes(String(contents!.type));
}

export function encodeShareCard(card: FlexCard) {
  return toBase64Url(JSON.stringify(card));
}

export function decodeShareCard(raw: string): FlexCard | null {
  if (!raw || raw.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as unknown;
    if (!isFlexCard(parsed)) return null;
    if (findPlaceholders(parsed).length > 0) return null;
    return parsed;
  } catch { return null; }
}

export function decodeShareLink(url: string): FlexCard | null {
  return decodeShareCard(new URL(url).searchParams.get('c') || '');
}

/**
 * A LIFF API only answers when the page is loaded through https://liff.line.me/<liffId>,
 * so the link handed to the operator is the LIFF URL, not the endpoint URL.
 */
export function buildShareLink(liffId: string, card: FlexCard) {
  return `https://liff.line.me/${encodeURIComponent(liffId)}?c=${encodeShareCard(card)}`;
}

export function textShareLink(card: FlexCard) {
  return `https://line.me/R/msg/text/?${encodeURIComponent(card.altText)}`;
}
