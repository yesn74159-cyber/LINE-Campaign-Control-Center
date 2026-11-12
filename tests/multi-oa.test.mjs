import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.PERSISTENCE = 'memory';
process.env.APP_MODE = 'DRY_RUN';
process.env.LINE_WEBHOOK_ENABLED = 'false';
process.env.MEMORY_ADMIN_EMAIL = 'owner@multi-oa.test';
process.env.MEMORY_ADMIN_PASSWORD = 'multi-oa-password-2026';
process.env.PUBLIC_APP_ORIGIN = 'https://staging.example.test';

const { buildApp } = await import('../dist/api/server.js');
const { createMemoryRepository } = await import('../dist/api/repository.js');
const { resolveOa, resolveShareOa, OA_REQUIRED_BLOCKER, OA_TIER_SQL } = await import('../dist/api/oaScope.js');

const OA_A = { id: 'oa-a', displayName: 'OA A', basicId: '@oa-a' };
const OA_B = { id: 'oa-b', displayName: 'OA B', basicId: '@oa-b' };
/** The resolver only reads rows, so a two-line fake is enough to enumerate every answer. */
const stubRows = (...rows) => ({ query: async () => ({ rows }) });

let csrf = '';
let cookie = '';
const app = buildApp(createMemoryRepository());

async function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (csrf && (options.method || 'GET') !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await app.inject({ ...options, url, headers });
  const setCookies = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [response.headers['set-cookie']].filter(Boolean);
  for (const value of setCookies) {
    const nextCsrf = String(value).match(/^ccc_csrf=([^;]+)/)?.[1];
    if (nextCsrf) csrf = nextCsrf;
  }
  const session = setCookies.map((value) => String(value).match(/^ccc_session=([^;]+)/)?.[1]).find(Boolean);
  if (session) cookie = `ccc_session=${session}; ccc_csrf=${csrf}`;
  return { response, body: response.json() };
}

before(async () => {
  await app.ready();
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: process.env.MEMORY_ADMIN_EMAIL, password: process.env.MEMORY_ADMIN_PASSWORD })
  });
  assert.equal(login.response.statusCode, 200, 'the memory owner must be able to sign in');
});

after(async () => { await app.close(); });

test('the OA tier is one constant and never a query parameter', () => {
  assert.equal(OA_TIER_SQL, "oa.environment='STAGING'");
  assert.match(OA_TIER_SQL, /^oa\.environment='/);
});

test('resolveOa answers NONE, AMBIGUOUS, RESOLVED and NOT_FOUND instead of picking a row', async () => {
  assert.equal((await resolveOa(stubRows(), { workspaceId: 'w' })).status, 'NONE');

  const ambiguous = await resolveOa(stubRows(OA_A, OA_B), { workspaceId: 'w' });
  assert.equal(ambiguous.status, 'AMBIGUOUS');
  assert.deepEqual(ambiguous.candidates.map((item) => item.basicId), ['@oa-a', '@oa-b']);

  const byId = await resolveOa(stubRows(OA_A, OA_B), { workspaceId: 'w', oaId: 'oa-b' });
  assert.equal(byId.status, 'RESOLVED');
  assert.equal(byId.oa.id, 'oa-b');

  const byBasicId = await resolveOa(stubRows(OA_A, OA_B), { workspaceId: 'w', oaId: '@oa-a' });
  assert.equal(byBasicId.status, 'RESOLVED');
  assert.equal(byBasicId.oa.id, 'oa-a');

  const unknown = await resolveOa(stubRows(OA_A, OA_B), { workspaceId: 'w', oaId: 'oa-z' });
  assert.equal(unknown.status, 'NOT_FOUND');
  assert.deepEqual(unknown.candidates.map((item) => item.id), ['oa-a', 'oa-b']);

  const single = await resolveOa(stubRows(OA_A), { workspaceId: 'w' });
  assert.equal(single.status, 'RESOLVED');
  assert.equal(single.oa.id, 'oa-a');
});

test('the public share landing carries the per-OA LIFF id it will use', async () => {
  const resolved = await resolveShareOa(stubRows({ ...OA_A, liffId: '2000000000-AbCdEfGh' }), '@oa-a');
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.oa.liffId, '2000000000-AbCdEfGh');

  const ambiguous = await resolveShareOa(stubRows({ ...OA_A, liffId: null }, { ...OA_B, liffId: null }), null);
  assert.equal(ambiguous.status, 'AMBIGUOUS');
  assert.equal(ambiguous.candidates.length, 2);
});

test('readiness never guesses an OA: a disabled or unknown OA is a blocker, not a silent default', async () => {
  const repo = createMemoryRepository();
  const auto = await repo.getCampaignReadiness('welcome', 'memory-workspace');
  assert.equal(auto.blockers.includes(OA_REQUIRED_BLOCKER), false, 'the single enabled OA resolves without a question');
  assert.equal(auto.canSchedule, true);
  assert.equal(auto.oa?.basicId, '@453yfyvc');

  const disabled = await repo.getCampaignReadiness('welcome', 'memory-workspace', 'oa-staging-mock');
  assert.equal(disabled.canSchedule, false);
  assert.ok(disabled.blockers.includes('Selected OA is not an enabled staging OA'));
  assert.deepEqual(disabled.candidateOas.map((item) => item.basicId), ['@453yfyvc'], 'a disabled OA is never offered as a candidate');

  const missing = await repo.getCampaignReadiness('welcome', 'memory-workspace', 'oa-does-not-exist');
  assert.equal(missing.canSchedule, false);
  assert.ok(missing.blockers.includes(OA_REQUIRED_BLOCKER));
  assert.equal(missing.oa, null);
  assert.deepEqual(missing.candidateOas.map((item) => item.basicId), ['@453yfyvc']);
});

test('a scheduler job without an OA id is rejected instead of scheduled against whichever row exists', async () => {
  const body = { campaignId: 'welcome', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'Asia/Bangkok', status: 'SCHEDULED' };
  const missing = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  assert.equal(missing.response.statusCode, 400, 'the OA is part of the contract, not guessed by the server');

  const named = await request('/api/scheduler/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'multi-oa-test-1' }, payload: JSON.stringify({ ...body, oaId: 'oa-staging-primary' }) });
  assert.equal(named.response.statusCode, 201);
  assert.equal(named.body.oaId, 'oa-staging-primary');
});

test('/api/oa-links reports readiness as booleans and counts, never a token or LINE user id', async () => {
  const { response, body } = await request('/api/oa-links');
  assert.equal(response.statusCode, 200);
  assert.equal(body.shareBase, 'https://staging.example.test');
  const link = body.links.find((item) => item.basicId === '@453yfyvc');
  assert.ok(link, 'the enabled staging OA appears in the list');
  assert.equal(link.shareUrl, 'https://staging.example.test/share?oa=@453yfyvc');
  assert.equal(typeof link.webhookVerified, 'boolean');
  assert.equal(link.clicks7d, 0);
  const visible = JSON.stringify(body);
  assert.ok(!/secret|token_sealed|U[0-9a-f]{32}/i.test(visible), 'no credential or LINE user id is serialised');
});

test('/api/config is public, uncached and names the OA it was asked about', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/config?oa=@453yfyvc' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = response.json();
  assert.equal(Array.isArray(body.candidates), true);
  assert.equal(typeof body.loginEnabled, 'boolean');
  assert.equal(body.oaId, 'oa-staging-primary');
  assert.equal(body.oaUrl, 'https://line.me/R/ti/p/@453yfyvc');
  assert.equal(body.ambiguous, false);

  const unknown = await app.inject({ method: 'GET', url: '/api/config?oa=@not-an-oa' });
  const unknownBody = unknown.json();
  assert.equal(unknownBody.oaUrl, null, 'a link naming an unknown OA must never fall back to another OA');
  assert.equal(unknownBody.oaId, null);
  assert.deepEqual(unknownBody.candidates.map((item) => item.basicId), ['@453yfyvc']);
});

test('the admin has one OA picker and the referral and scheduler screens read it', async () => {
  const fs = await import('node:fs');
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const picker = read('apps/admin/src/OaPicker.tsx');
  assert.match(picker, /id="oa-picker"/);
  assert.match(picker, /ยังไม่มี OA ที่เปิดใช้งาน/);

  const referral = read('apps/admin/src/ReferralDashboard.tsx');
  assert.match(referral, /oaId\?: string/);
  assert.match(referral, /item\.enabled && item\.environment === 'STAGING'/);
  assert.doesNotMatch(referral, /id="referral-oa"/, 'the referral screen must not offer a second OA select');
  assert.doesNotMatch(referral, /nextChannels\.find\(/, 'it must not guess an OA when none is selected');

  const scheduler = read('apps/admin/src/app/PushView.tsx');
  assert.match(scheduler, /เปลี่ยนได้ที่ตัวเลือก OA ด้านบน/);
  assert.doesNotMatch(scheduler, /<select[^>]*(schedule-oa|oa-picker)/, 'the scheduler must not render a second OA select');

  const main = read('apps/admin/src/main.tsx');
  assert.match(main, /oas\.filter\(\(item\) => item\.enabled && item\.environment === 'STAGING'\)/);
  assert.match(main, /oaId=\{selectedOa\?\.id \|\| ''\}/);
  // Readiness and /api/config must not fire before the OA list resolves: the first render has
  // no OA to name, and the server would answer for whichever row it found.
  assert.match(main, /setOasLoaded\(true\)/);
  assert.match(main, /if \(!user \|\| !oasLoaded\) return/);
  assert.match(main, /if \(!oasLoaded\) return/);
  assert.doesNotMatch(main, /readiness\$\{query\}`\)\.then\(setReadiness\)\.catch\(\(\) => setReadiness\(null\)\); \}, \[user, selected, selectedOa\?\.id\]\)/, 'the readiness effect must depend on oasLoaded');

  const e2e = read('tests/e2e.visual.test.mjs');
  assert.doesNotMatch(e2e, /#referral-oa/, 'the e2e suite must drive the shared picker, not a removed select');
});

test('the customer list is scoped by the picked OA instead of mixing every provider', async () => {
  const fs = await import('node:fs');
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const view = read('apps/admin/src/app/CustomersView.tsx');
  // A customer row carries the provider it followed, so the picker's OA is the filter.
  assert.match(view, /providerId \? customers\.filter\(\(customer\) => customer\.providerId === providerId\) : customers/);
  assert.match(view, /oaName\?: string \| null/);
  assert.match(view, /providerId\?: string \| null/);

  const main = read('apps/admin/src/main.tsx');
  assert.match(main, /oaName=\{selectedOa\?\.displayName \|\| null\}/);
  assert.match(main, /providerId=\{selectedOa\?\.providerId \|\| null\}/);

  // The direct-send picker has the same rule: offering another OA's customer only
  // ends in the server's CONSENT_REQUIRED refusal after the operator typed a message.
  const push = read('apps/admin/src/PushMessage.tsx');
  assert.match(push, /customers\.filter\(\(item\) => item\.providerId === selectedOa\.providerId\)/);
  assert.match(push, /ยังไม่มีลูกค้าที่ติดตาม OA นี้/);
  assert.match(push, /history\.filter\(\(row\) => row\.oaId === selectedOa\.id\)/);
});

test('the shared add-friend page speaks to the customer, not the operator', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../apps/admin/src/LiffSharePage.tsx', import.meta.url), 'utf8');
  // A link from แจกลิงก์ carries no card, so whoever opens it is a customer. Flex Studio
  // instructions belong on the operator's screen, never on the page handed to a customer.
  assert.doesNotMatch(page, /การ์ดที่เพื่อนส่งให้พาเข้ามาถึงหน้าแชร์โดยไม่มีการ์ดแนบมา/);
  assert.doesNotMatch(page, /ให้กลับไปกด “แชร์จากมือถือ \(LIFF\)” ใน Flex Studio/);
  assert.match(page, /<ol className="share-steps">/);
  assert.match(page, /กลับมาที่แชทเพื่อรับโปรโมชั่น/);
});
