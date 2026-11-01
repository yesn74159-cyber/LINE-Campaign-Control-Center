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

function responseJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('manual push page previews first and sends only after typing SEND', async (t) => {
  const requests = [];
  let previewBody = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, path: pathname, csrf: req.headers['x-csrf-token'], body: raw });
        if (pathname === '/api/auth/me') return responseJson(res, { user: { id: 'owner-a', displayName: 'Test Owner', role: 'owner', email: 'owner@example.test' } });
        if (pathname === '/api/dashboard') return responseJson(res, { mode: 'DRY_RUN', persistence: 'postgres', counts: {}, nextJob: null });
        if (pathname === '/api/scheduler/jobs') return responseJson(res, { jobs: [] });
        if (pathname === '/api/campaigns') return responseJson(res, { campaigns: [] });
        if (pathname === '/api/oas') return responseJson(res, { oas: [{ id: 'oa-1', displayName: 'Heekoom QA', basicId: '@heekoomqa', providerId: 'p-qa', environment: 'STAGING', enabled: true, secretConfigured: true, connectionStatus: 'VERIFIED', credentialStatus: 'NONE', quotaPerMinute: 500, killSwitch: false }] });
        if (pathname === '/api/customers') return responseJson(res, { customers: [{ id: 'c-1', providerId: 'p-qa', lineUserKey: RECIPIENT, displayName: 'ลูกค้า QA', optIn: true }, { id: 'c-2', providerId: 'p-qa', lineUserKey: 'U' + 'b'.repeat(32), displayName: 'คนบล็อก', optIn: true, blockedAt: '2026-11-01T00:00:00Z' }] });
        if (pathname === '/api/messages/push/history') return responseJson(res, { pushes: [{ id: PREVIEW_ID, recipient: RECIPIENT, text: 'ส่งรอบก่อน', mode: 'DRY_RUN', status: 'SENT', providerStatus: 200, providerRequestId: 'mock-request', providerMessageId: null, recipientName: 'ลูกค้า QA', error: null, oaId: 'oa-1', createdAt: new Date().toISOString(), confirmedAt: null }] });
        if (pathname === '/api/messages/push/preview' && req.method === 'POST') {
          if (req.headers['x-csrf-token'] !== 'qa-token') return responseJson(res, { error: 'CSRF' }, 403);
          previewBody = JSON.parse(raw);
          return responseJson(res, { previewId: PREVIEW_ID, oaDisplayName: 'Heekoom QA', recipient: previewBody.recipient, text: previewBody.text, mode: 'DRY_RUN', expiresAt: new Date(Date.now() + 600_000).toISOString(), recipientName: null }, 201);
        }
        if (pathname === '/api/messages/push/send' && req.method === 'POST') {
          if (req.headers['x-csrf-token'] !== 'qa-token') return responseJson(res, { error: 'CSRF' }, 403);
          const body = JSON.parse(raw);
          if (body.confirm !== 'SEND') return responseJson(res, { error: 'type SEND to confirm a real send', code: 'CONFIRMATION_REQUIRED' }, 400);
          return responseJson(res, { status: 'SENT', mode: 'DRY_RUN', outbound: false, providerStatus: 200, providerRequestId: 'mock-request', providerMessageId: null, oaDisplayName: 'Heekoom QA', recipient: RECIPIENT });
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'ccc_csrf', value: 'qa-token', domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });

    for (const group of ['ทำงานประจำวัน', 'ออกแบบข้อความ', 'ตั้งค่าระบบ']) await page.getByText(group).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: '✉ ส่งข้อความตรง', exact: true }).click();
    await page.getByRole('heading', { name: 'ส่งข้อความตรงถึงลูกค้า 1 คน' }).waitFor();

    await page.locator('#push-recipient').waitFor();
    assert.equal(await page.locator('#push-recipient').inputValue(), RECIPIENT, 'only the consented customer is preselected');
    assert.equal((await page.locator('#push-recipient option').allTextContents()).some((text) => text.includes('คนบล็อก')), false, 'blocked customers are not offered');
    const sendButton = page.getByRole('button', { name: 'ส่งข้อความจริง' });
    await page.locator('#push-text').fill('สวัสดีครับ มีโปรโมชั่นพิเศษสำหรับคุณ 🎁');
    assert.equal(await sendButton.count(), 0, 'there is no send control until a preview exists');
    assert.equal(await page.getByRole('button', { name: 'ดูตัวอย่างก่อน (Preview)' }).isDisabled(), false);

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
    assert.equal(previewBody.recipient, RECIPIENT);
    assert.equal(previewBody.oaId, 'oa-1');
    assert.ok(requests.some((item) => item.path === '/api/messages/push/send' && item.csrf === 'qa-token'));
    assert.equal(await page.locator('#push-text').inputValue(), '', 'the composer resets after a send');
    await page.getByText('ส่งแล้ว · DRY_RUN').waitFor();
    const visible = await page.locator('body').innerText();
    assert.ok(!/channel access token|Bearer /.test(visible), 'no credential text is rendered');
    assert.deepEqual(errors, []);
    console.log('PUSH_BROWSER_UI_PASS');
  } finally { if (browser) await browser.close(); }
});
