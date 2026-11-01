import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const staticRoot = path.resolve('dist/admin');
const html = readFileSync(path.join(staticRoot, 'index.html'));
const RECIPIENT = 'U' + 'a'.repeat(32);
const PREVIEW_ID = '33333333-3333-4333-8333-333333333333';
const FLEX_CARD = { type: 'flex', altText: 'โปรโมชั่นส่งต่อถึงเพื่อน', contents: { type: 'bubble', body: { type: 'box', contents: [{ type: 'text', text: 'ลด 20% วันนี้' }, { type: 'button', action: { type: 'uri', uri: 'https://example.test' }, style: 'primary', label: 'กดรับสิทธิ์' }] } } };

function responseJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A static Admin bundle served against an in-memory API, so the browser test sees the
 * real screens while every guard (CSRF, consent, mode) stays on the server side.
 */
function harness({ liveSendEnabled = false } = {}) {
  const requests = [];
  const bodies = { preview: null, send: null, job: null };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, path: pathname, csrf: req.headers['x-csrf-token'], body: raw });
        if (pathname === '/api/auth/me') return responseJson(res, { user: { id: 'owner-a', displayName: 'Test Owner', role: 'owner', email: 'owner@example.test' } });
        if (pathname === '/api/dashboard') return responseJson(res, { mode: liveSendEnabled ? 'LIVE' : 'DRY_RUN', persistence: 'postgres', appMode: liveSendEnabled ? 'LIVE' : 'DRY_RUN', liveSendEnabled, counts: {}, nextJob: null });
        if (pathname === '/api/scheduler/jobs' && req.method === 'POST') { bodies.job = JSON.parse(raw); return responseJson(res, { job: { id: 'job-1', ...bodies.job } }, 201); }
        if (pathname === '/api/scheduler/jobs') return responseJson(res, { jobs: bodies.job ? [{ id: 'job-1', campaignId: bodies.job.campaignId, oaId: bodies.job.oaId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'Asia/Bangkok', mode: bodies.job.mode || 'DRY_RUN', status: 'SCHEDULED', attempts: 0, idempotencyKey: 'k-1' }] : [] });
        if (pathname === '/api/campaigns') return responseJson(res, { campaigns: [{ id: 'welcome', name: 'ต้อนรับ', title: 'ยินดีต้อนรับ', description: 'สวัสดีครับ', cta: 'ดูโปรโมชั่น' }] });
        if (pathname === '/api/oas') return responseJson(res, { oas: [{ id: 'oa-1', displayName: 'Heekoom QA', basicId: '@heekoomqa', providerId: 'p-qa', environment: 'STAGING', enabled: true, secretConfigured: true, connectionStatus: 'VERIFIED', credentialStatus: 'NONE', quotaPerMinute: 500, killSwitch: false }] });
        if (pathname === '/api/customers') return responseJson(res, { customers: [{ id: 'c-1', providerId: 'p-qa', lineUserKey: RECIPIENT, displayName: 'ลูกค้า QA', optIn: true }, { id: 'c-2', providerId: 'p-qa', lineUserKey: 'U' + 'b'.repeat(32), displayName: 'คนบล็อก', optIn: true, blockedAt: '2026-11-01T00:00:00Z' }] });
        if (pathname === '/api/messages/push/history') return responseJson(res, { pushes: [{ id: PREVIEW_ID, recipient: RECIPIENT, text: 'ส่งรอบก่อน', messageType: 'text', mode: 'DRY_RUN', status: 'SENT', providerStatus: 200, providerRequestId: 'mock-request', providerMessageId: null, recipientName: 'ลูกค้า QA', error: null, oaId: 'oa-1', createdAt: new Date().toISOString(), confirmedAt: null }] });
        if (pathname === '/api/messages/push/preview' && req.method === 'POST') {
          if (req.headers['x-csrf-token'] !== 'qa-token') return responseJson(res, { error: 'CSRF' }, 403);
          const body = JSON.parse(raw);
          bodies.preview = body;
          const isFlex = body.flex !== undefined;
          return responseJson(res, {
            previewId: PREVIEW_ID, oaDisplayName: 'Heekoom QA', recipient: body.recipient,
            text: isFlex ? body.flex.altText : body.text, messageType: isFlex ? 'flex' : 'text', flex: isFlex ? body.flex : null,
            mode: body.mode || 'DRY_RUN', expiresAt: new Date(Date.now() + 600_000).toISOString(), recipientName: null
          }, 201);
        }
        if (pathname === '/api/messages/push/send' && req.method === 'POST') {
          if (req.headers['x-csrf-token'] !== 'qa-token') return responseJson(res, { error: 'CSRF' }, 403);
          const body = JSON.parse(raw);
          bodies.send = body;
          if (body.confirm !== 'SEND') return responseJson(res, { error: 'type SEND to confirm a real send', code: 'CONFIRMATION_REQUIRED' }, 400);
          return responseJson(res, { status: 'SENT', mode: bodies.preview?.mode || 'DRY_RUN', outbound: false, providerStatus: 200, providerRequestId: 'mock-request', providerMessageId: null, oaDisplayName: 'Heekoom QA', recipient: RECIPIENT });
        }
        return responseJson(res, { error: 'not found' }, 404);
      });
      return;
    }
    const decoded = decodeURIComponent(url.pathname);
    const target = path.resolve(staticRoot, '.' + decoded);
    if (decoded.includes('..') || !target.startsWith(staticRoot)) { res.writeHead(403).end(); return; }
    const file = existsSync(target) && statSync(target).isFile() ? target : null;
    const data = file ? readFileSync(file) : html;
    const mime = !file ? 'text/html' : target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime }); res.end(data);
  });
  return { server, requests, bodies };
}

/** Serves the harness and opens a logged-in Admin page in a fresh browser context. */
async function openApp(t, fixture) {
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'ccc_csrf', value: 'qa-token', domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + fixture.server.address().port, { waitUntil: 'networkidle' });
  for (const group of ['ทำงานประจำวัน', 'ออกแบบข้อความ', 'ตั้งค่าระบบ']) await page.getByText(group).waitFor({ timeout: 10_000 });
  return { page, errors };
}

const navTo = (page, icon, label) => page.getByRole('button', { name: `${icon} ${label}`, exact: true }).click();

test('manual push page previews first and sends only after typing SEND', async (t) => {
  const fixture = harness();
  const { page, errors } = await openApp(t, fixture);

  await navTo(page, '✉', 'ส่งข้อความตรง');
  await page.getByRole('heading', { name: 'ส่งข้อความตรงถึงลูกค้า 1 คน' }).waitFor();

  await page.locator('#push-recipient').waitFor();
  assert.equal(await page.locator('#push-recipient').inputValue(), RECIPIENT, 'only the consented customer is preselected');
  assert.equal((await page.locator('#push-recipient option').allTextContents()).some((text) => text.includes('คนบล็อก')), false, 'blocked customers are not offered');
  const sendButton = page.getByRole('button', { name: 'ส่งข้อความจริง' });
  await page.locator('#push-text').fill('สวัสดีครับ มีโปรโมชั่นพิเศษสำหรับคุณ 🎁');
  assert.equal(await sendButton.count(), 0, 'there is no send control until a preview exists');
  assert.equal(await page.getByRole('button', { name: 'ดูตัวอย่างก่อน (Preview)' }).isDisabled(), false);
  assert.equal(await page.locator('input[name="push-mode"]').count(), 0, 'a DRY_RUN host does not offer a live push');

  await page.getByRole('button', { name: 'ดูตัวอย่างก่อน (Preview)' }).click();
  await page.locator('.push-bubble p').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.push-bubble p').innerText(), 'สวัสดีครับ มีโปรโมชั่นพิเศษสำหรับคุณ 🎁');
  assert.equal(await sendButton.isDisabled(), true, 'the typed confirmation is required');
  await page.locator('#push-confirm').fill('send');
  assert.equal(await sendButton.isDisabled(), true, 'the confirmation word is case sensitive');
  await page.locator('#push-confirm').fill('SEND');
  assert.equal(await sendButton.isDisabled(), false);

  await sendButton.click();
  await page.getByText('ส่งแล้ว (200)', { exact: false }).waitFor({ timeout: 10_000 });
  assert.equal(fixture.bodies.preview.recipient, RECIPIENT);
  assert.equal(fixture.bodies.preview.oaId, 'oa-1');
  assert.equal(fixture.bodies.preview.mode, 'DRY_RUN');
  assert.ok(fixture.requests.some((item) => item.path === '/api/messages/push/send' && item.csrf === 'qa-token'));
  assert.equal(await page.locator('#push-text').inputValue(), '', 'the composer resets after a send');
  await page.getByText('ส่งแล้ว · DRY_RUN').waitFor();
  const visible = await page.locator('body').innerText();
  assert.ok(!/channel access token|Bearer /.test(visible), 'no credential text is rendered');
  assert.deepEqual(errors, []);
  console.log('PUSH_BROWSER_UI_PASS');
});

test('a Flex card can be composed, previewed and sent from the push screen', async (t) => {
  const fixture = harness();
  const { page, errors } = await openApp(t, fixture);

  await navTo(page, '✉', 'ส่งข้อความตรง');
  await page.locator('label.choice').filter({ hasText: 'การ์ดสวย (Flex)' }).click();
  await page.locator('#push-flex-json').waitFor();
  assert.equal(await page.getByRole('button', { name: 'ดูตัวอย่างก่อน (Preview)' }).isDisabled(), true, 'an empty card cannot be previewed');

  await page.locator('#push-flex-json').fill('{ "type": "flex", ');
  assert.equal(await page.getByRole('button', { name: 'ดูตัวอย่างก่อน (Preview)' }).isDisabled(), true, 'broken JSON is not offered to the server');
  assert.ok((await page.locator('.push-form .form-note').innerText()).includes('JSON ยังไม่ถูกต้อง'));

  await page.locator('#push-flex-json').fill(JSON.stringify(FLEX_CARD, null, 2));
  assert.equal(await page.locator('#push-flex-alt').inputValue(), FLEX_CARD.altText, 'the altText comes from the card itself');
  await page.getByRole('button', { name: 'ดูตัวอย่างก่อน (Preview)' }).click();
  await page.locator('.push-flex-preview').waitFor({ timeout: 10_000 });
  assert.deepEqual(fixture.bodies.preview.flex, FLEX_CARD);
  assert.equal(fixture.bodies.preview.text, undefined, 'a flex request carries no text field');
  const bubble = await page.locator('.push-flex-preview').innerText();
  assert.ok(bubble.includes('ลด 20% วันนี้') && bubble.includes('กดรับสิทธิ์'), 'the card content is shown before sending');
  assert.ok(bubble.includes(FLEX_CARD.altText), 'the notification line is visible in the preview');

  await page.locator('#push-confirm').fill('SEND');
  await page.getByRole('button', { name: 'ส่งข้อความจริง' }).click();
  await page.getByText('ส่งแล้ว (200)', { exact: false }).waitFor({ timeout: 10_000 });
  assert.equal(fixture.bodies.send.confirm, 'SEND');
  assert.deepEqual(errors, []);
  console.log('PUSH_FLEX_UI_PASS');
});

test('Flex Studio hands its card to the push screen instead of a share link', async (t) => {
  const fixture = harness();
  const { page, errors } = await openApp(t, fixture);

  await navTo(page, '✦', 'สร้างข้อความ (Flex Studio)');
  await page.getByRole('heading', { name: 'สร้างข้อความที่คนอยากเปิด' }).waitFor();
  await page.getByRole('button', { name: 'แชร์เข้าแชท' }).click();

  await page.getByRole('heading', { name: 'ส่งข้อความตรงถึงลูกค้า 1 คน' }).waitFor();
  assert.ok((await page.locator('.notice-bar').innerText()).includes('การ์ดถูกส่งไปที่หน้า'), 'the hand-off is announced');
  const editor = await page.locator('#push-flex-json').inputValue();
  assert.equal(JSON.parse(editor).type, 'flex', 'the studio JSON arrived intact');
  assert.deepEqual(errors, []);
  console.log('PUSH_SHARE_FROM_STUDIO_PASS');
});

test('a live scheduler job needs the release gate, the LIVE choice and a typed confirmation', async (t) => {
  const locked = harness();
  const lockedApp = await openApp(t, locked);
  await navTo(lockedApp.page, '◷', 'ตั้งเวลาส่ง (Scheduler)');
  await lockedApp.page.getByRole('heading', { name: 'ตั้งเวลาส่งแคมเปญ' }).waitFor();
  const liveChoice = lockedApp.page.locator('label.choice').filter({ hasText: 'ส่งจริง (LIVE)' });
  assert.equal(await liveChoice.locator('input').isDisabled(), true, 'the LIVE choice is unavailable while the gate is off');
  assert.ok((await liveChoice.innerText()).includes('ยังปิดประตูส่งจริง'));
  assert.ok((await lockedApp.page.locator('.sidebar .mode-pill').innerText()).includes('โหมดทดสอบ'));
  assert.deepEqual(lockedApp.errors, []);

  const open = harness({ liveSendEnabled: true });
  const { page, errors } = await openApp(t, open);
  await navTo(page, '◷', 'ตั้งเวลาส่ง (Scheduler)');
  await page.getByRole('heading', { name: 'ตั้งเวลาส่งแคมเปญ' }).waitFor();
  assert.ok((await page.locator('.sidebar .mode-pill').innerText()).includes('ส่งจริงได้'), 'the sidebar reports the opened gate');

  const submitButton = page.getByRole('button', { name: 'ตั้งเวลาส่งจริง (LIVE)' });
  assert.equal(await submitButton.count(), 0, 'the default job stays a dry run');
  await page.locator('label.choice').filter({ hasText: 'ส่งจริง (LIVE)' }).click();
  assert.equal(await submitButton.count(), 1);
  assert.equal(await submitButton.isDisabled(), true, 'typing LIVE is required before the button works');
  await page.locator('input[aria-label="พิมพ์ LIVE เพื่อยืนยันการส่งจริง"]').fill('LIV');
  assert.equal(await submitButton.isDisabled(), true);
  await page.locator('input[aria-label="พิมพ์ LIVE เพื่อยืนยันการส่งจริง"]').fill('LIVE');
  assert.equal(await submitButton.isDisabled(), false);

  await submitButton.click();
  await page.locator('.notice-bar').filter({ hasText: 'LINE จะได้รับข้อความเมื่อถึงเวลา' }).waitFor({ timeout: 10_000 });
  assert.equal(open.bodies.job.mode, 'LIVE');
  assert.equal(open.bodies.job.confirm, 'LIVE');
  assert.equal(open.bodies.job.status, 'SCHEDULED');
  // The reloaded list must warn that this job will really reach LINE.
  await page.getByRole('heading', { name: 'ตั้งเวลาส่งแคมเปญ' }).waitFor();
  assert.ok((await page.locator('.job-row').first().innerText()).includes('ส่งจริง (LIVE)'), 'the job row labels a live send');
  assert.deepEqual(errors, []);
  console.log('SCHEDULER_LIVE_UI_PASS');
});
