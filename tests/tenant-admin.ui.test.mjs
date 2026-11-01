import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const staticRoot = path.resolve('dist/admin');
const html = readFileSync(path.join(staticRoot, 'index.html'));
function responseJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('Workspace page renders, loads members, and updates workspace via API', async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: req.method, path: url.pathname, csrf: req.headers['x-csrf-token'] });
      if (url.pathname === '/api/auth/me') return responseJson(res, { user: { id:'owner-a', displayName:'Test Owner', role:'owner', email:'owner@example.test' } });
      if (url.pathname === '/api/dashboard') return responseJson(res, { mode:'DRY_RUN', persistence:'postgres', counts:{}, nextJob:null });
      if (url.pathname === '/api/scheduler/jobs') return responseJson(res, { jobs:[] });
      if (url.pathname === '/api/oas') return responseJson(res, { oas:[] });
      if (url.pathname === '/api/campaigns') return responseJson(res, { campaigns:[] });
      if (url.pathname === '/api/customers') return responseJson(res, { customers:[] });
      if (url.pathname === '/api/workspace/oa-connect/status') return responseJson(res,{ connections:[] });
      if (url.pathname === '/api/workspace/oa-connect' && req.method === 'POST') {
        if (req.headers['x-csrf-token'] !== 'qa-token') return responseJson(res,{error:'csrf'},403);
        return responseJson(res,{ oaId:'sample-oa',displayName:'Verified Sample LINE OA',
          basicId:'@sample123',accessTokenValidated:true,webhookSecretValidated:false,
          sendingEnabled:false,status:'VERIFY_PENDING' },201);
      }      if (url.pathname === '/api/workspace/settings' && req.method === 'PATCH') {
        if (req.headers['x-csrf-token'] !== 'qa-token') return responseJson(res, { error:'CSRF' }, 403);
        return responseJson(res, { workspace: { id:'ws-a', slug:'ws-qa', mode:'DRY_RUN', name:'Updated Tenant Name' } });
      }
      if (url.pathname === '/api/workspace/settings') return responseJson(res, { workspace: { id:'ws-a', slug:'ws-qa', mode:'DRY_RUN', name:'Existing Tenant' } });
      if (url.pathname === '/api/workspace/members') return responseJson(res, { members: [{ id:'owner-a', email:'owner@example.test', displayName:'Test Owner', role:'owner', status:'ACTIVE' }] });
      if (url.pathname === '/api/workspace/oa-channels') return responseJson(res, { channels:[] });
      return responseJson(res, { error:'not found' }, 404);
    }
    const decoded = decodeURIComponent(url.pathname);
    const target = path.resolve(staticRoot, '.' + decoded);
    if (decoded.includes('..') || !target.startsWith(staticRoot)) { res.writeHead(403).end(); return; }
    const file = existsSync(target) && statSync(target).isFile() ? target : null;
    const data = file ? readFileSync(file) : html;
    const mime = !file ? 'text/html' : target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime }); res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width:1280, height:720 } });
    await context.addCookies([{ name:'ccc_csrf',value:'qa-token',domain:'127.0.0.1',path:'/' }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + port, { waitUntil:'networkidle' });
    await page.getByRole('button', { name:'Workspace' }).click();
    await page.getByRole('heading', { name:'Workspace & LINE OA Settings' }).waitFor({ timeout:10000 });
    await page.getByRole('cell', { name:'owner@example.test' }).waitFor();
    assert.equal(await page.locator('#workspace-name').inputValue(), 'Existing Tenant');
    await page.locator('#workspace-name').fill('Updated Tenant Name');
    await page.getByRole('button', { name:'บันทึกชื่อบริษัท' }).click();
    await page.getByText('บันทึกชื่อ Workspace เรียบร้อย').waitFor();
    assert.equal(requests.filter(x => x.path === '/api/workspace/settings' && x.method === 'PATCH').length, 1);
    assert.ok(requests.some(x => x.path === '/api/workspace/settings' && x.method === 'PATCH' && x.csrf === 'qa-token'));
    await page.getByText('OWNER ONLY · ENCRYPTED IN SERVER VAULT').waitFor();
    assert.equal(await page.locator('#live-oa-token').count(), 1);
    assert.equal(await page.locator('#live-oa-secret').count(), 1);
    await page.locator('#oa-provider-id').fill('line-oa-qa');
    await page.locator('#oa-channel-id').fill('12345678901');
    await page.locator('#live-oa-token').fill('qa-channel-access-token-value');
    await page.locator('#live-oa-secret').fill('qa-channel-secret-value');
    await page.getByRole('button', { name:'เชื่อมต่อ LINE OA' }).click();
    await page.getByRole('button', { name:'คัดลอก Webhook URL' }).waitFor({ timeout:10000 });
    assert.equal(await page.locator('input[aria-label="LINE webhook URL"]').inputValue(), 'http://127.0.0.1:' + port + '/api/webhooks/line/sample-oa');
    const visible = await page.locator('body').innerText();
    assert.ok(!visible.includes('qa-channel-access-token-value'), 'channel access token must never be rendered back');
    assert.ok(!visible.includes('qa-channel-secret-value'), 'channel secret must never be rendered back');
    assert.ok(requests.some(x => x.path === '/api/workspace/oa-connect' && x.method === 'POST' && x.csrf === 'qa-token'));
    assert.deepEqual(errors, []);
    console.log('WORKSPACE_BROWSER_UI_PASS');
  } finally { if (browser) await browser.close(); }
});
