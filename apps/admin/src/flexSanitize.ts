// The vendored flex2html library builds HTML by string interpolation and never
// escapes, so an operator who types `<img src=x onerror=...>` into a Flex field
// would run code inside the admin origin. Everything the preview renders goes
// through this pass first; the card that is stored and sent to LINE is untouched.

const URL_KEYS = new Set(['url', 'uri', 'linkUri', 'previewUrl']);
const CLASS_TOKEN_KEYS = new Set([
  'type', 'layout', 'size', 'weight', 'style', 'decoration', 'align', 'gravity', 'position',
  'aspectMode', 'aspectRatio', 'imageSize', 'scale', 'wrap', 'maxLines', 'adjustMode', 'direction',
  'height', 'margin', 'spacing', 'flex', 'rotation', 'offsetTop', 'offsetBottom', 'offsetStart', 'offsetEnd', 'lineSpacing', 'action'
]);
const COLOR_KEYS = new Set(['color', 'backgroundColor', 'borderColor']);
const ACTION_TYPES = new Set(['message', 'postback', 'uri', 'datetimepicker', 'camera', 'cameraRoll', 'richmenuswitch']);
const TOKEN_PATTERN = /^[A-Za-z0-9_.,:%-]{1,32}$/;
const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|extension:[a-z0-9_-]{1,32})$/;
const MAX_DEPTH = 16;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string);
}

// Strings that the library drops straight into an HTML attribute are escaped twice
// over by the browser, so entities are not enough there — the characters go away.
function attributeSafe(value: string) {
  return value.replace(/["'<>&;\\]/g, '').replace(/[\u0000-\u001f]/g, '').slice(0, 300);
}

function sanitizeValue(key: string, value: unknown, insideAction: boolean, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === 'string') {
    if (URL_KEYS.has(key)) return /^https:\/\/[^\s"'<>\\]{1,2048}$/.test(value) ? value : key === 'uri' ? '#' : undefined;
    if (insideAction) return attributeSafe(value);
    if (CLASS_TOKEN_KEYS.has(key) && !TOKEN_PATTERN.test(value)) return undefined;
    if (COLOR_KEYS.has(key) && !COLOR_PATTERN.test(value)) return undefined;
    return escapeHtml(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(key, item, insideAction, depth + 1)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') return sanitizeNode(value as Record<string, unknown>, depth + 1);
  return undefined;
}

function sanitizeNode(node: Record<string, unknown>, depth: number): Record<string, unknown> {
  const insideAction = ACTION_TYPES.has(String(node.type));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const clean = sanitizeValue(key, value, insideAction, depth);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export function sanitizeFlexCard(card: unknown): Record<string, unknown> | null {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const node = card as Record<string, unknown>;
  if (node.type !== 'flex') return null;
  return sanitizeNode(node, 0);
}
