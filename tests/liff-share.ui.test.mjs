import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const staticRoot = path.resolve('dist/admin');
const html = readFileSync(path.join(staticRoot, 'index.html'));
const LIFF_ID = '12345678-AbCdEf';
const CARD = { type: 'flex', altText: 'ลด 20% วันนี้', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'ใส่โค้ด HEKO20 ก่อนสองทุ่ม' }, { type: 'button', style: 'primary', action: { type: 'uri', label: 'เพิ่มเพื่อน', uri: 'https://line.me/R/ti/p/@heekoom' } }] } } };

function toBase64Url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  return JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function firstFlexText(node) {
  if (Array.isArray(node)) return node.map(firstFlexText).find(Boolean) || '';
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string' && node.text.trim()) return node.text.trim();
  return Object.values(node).map(firstFlexText).find(Boolean) || '';
}

/** The Admin bundle against a stubbed API; /share is exercised outside LINE on purpose. */
function harness({ liffId = LIFF_ID } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (pathname.startsWith('/api/') || pathname === '/health') {
      if (pathname === '/health') return send({ ok: true, mode: 'DRY_RUN', liveSendEnabled: false, persistence: 'postgres' });
      if (pathname === '/api/config') return send({ liffId });
      if (pathname === '/api/auth/me') return send({ user: { id: 'owner-a', displayName: 'Test Owner', role: 'owner', email: 'owner@example.test' } });
      if (pathname === '/api/dashboard') return send({ mode: 'DRY_RUN', persistence: 'postgres', appMode: 'DRY_RUN', liveSendEnabled: false, counts: {}, nextJob: null });
      if (pathname === '/api/campaigns') return send({ campaigns: [{ id: 'welcome', name: 'ต้อนรับ', title: 'ยินดีต้อนรับ', description: 'สวัสดีครับ', cta: 'ดูโปรโมชั่น' }] });
      if (pathname === '/api/oas') return send({ oas: [] });
      if (pathname === '/api/customers') return send({ customers: [] });
      if (pathname === '/api/scheduler/jobs') return send({ jobs: [] });
      return send({ error: 'not found' }, 404);
    }
    const decoded = decodeURIComponent(pathname);
    const target = path.resolve(staticRoot, '.' + decoded);
    if (decoded.includes('..') || !target.startsWith(staticRoot)) { res.writeHead(403).end(); return; }
    const file = existsSync(target) && statSync(target).isFile() ? target : null;
    const data = file ? readFileSync(file) : html;
    const mime = !file ? 'text/html' : target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime }); res.end(data);
  });
  return { server };
}

async function openPage(t, fixture, routePath = '/') {
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'ccc_csrf', value: 'qa-token', domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${fixture.server.address().port}${routePath}`, { waitUntil: 'domcontentloaded' });
  const origin = `http://127.0.0.1:${fixture.server.address().port}`;
  return { page, errors, origin };
}

test('Flex Studio turns the card into a LIFF link the operator opens on the phone', async (t) => {
  const fixture = harness();
  const { page, errors } = await openPage(t, fixture);
  for (const group of ['ทำงานประจำวัน', 'ออกแบบข้อความ', 'ตั้งค่าระบบ']) await page.getByText(group).waitFor({ timeout: 10_000 });

  await page.getByRole('button', { name: '✦ สร้างข้อความ (Flex Studio)', exact: true }).click();
  await page.getByRole('button', { name: 'แชร์จากมือถือ (LIFF)' }).click();

  // The stub hands back the raw {{...}} template, so the panel must refuse to offer a link
  // that the server validator and LINE would both reject, instead of sending the operator to the phone.
  assert.match(await page.locator('.share-panel').innerText(), /ตัวยึดที่ยังไม่แทนค่า/);
  assert.equal(await page.locator('.share-link-row').count(), 0, 'no link is offered while the card still holds placeholders');

  await page.locator('.editor-panel textarea').fill(JSON.stringify(CARD));
  assert.equal(await page.locator('.share-panel .auth-error').count(), 0, 'a clean card no longer trips the placeholder warning');
  const link = await page.locator('.share-link-row input').inputValue();
  assert.ok(link.startsWith(`https://liff.line.me/${LIFF_ID}?c=`), 'the link is the LIFF URL, not the endpoint URL');
  assert.deepEqual(fromBase64Url(new URL(link).searchParams.get('c')), CARD, 'the link carries the edited card');
  assert.deepEqual(errors, []);
});

test('the share page renders the card and refuses to pretend it can send outside LINE', async (t) => {
  const fixture = harness();
  const { page, errors } = await openPage(t, fixture, `/share?c=${toBase64Url(CARD)}`);
  await page.locator('.share-screen').waitFor({ timeout: 10_000 });
  await page.locator('.flex-render').filter({ hasText: firstFlexText(CARD.contents) }).waitFor({ timeout: 10_000 });
  await page.locator('a[href^="https://line.me/R/msg/text/?"]').waitFor({ timeout: 20_000 });
  assert.equal(await page.getByRole('button', { name: 'เลือกเพื่อนแล้วส่ง' }).count(), 0, 'no share button is offered when LIFF cannot answer');
  assert.deepEqual(errors, []);
});

test('a broken or unconfigured share link explains itself instead of hanging', async (t) => {
  const broken = await openPage(t, harness(), '/share?c=not-a-card');
  await broken.page.getByRole('heading', { name: 'ไม่พบการ์ดในลิงก์' }).waitFor({ timeout: 10_000 });

  const unconfigured = await openPage(t, harness({ liffId: null }), `/share?c=${toBase64Url(CARD)}`);
  await unconfigured.page.getByRole('heading', { name: 'ยังไม่ตั้งค่า LIFF บนเซิร์ฟเวอร์' }).waitFor({ timeout: 10_000 });
});
