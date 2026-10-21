import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';
const email = process.env.STAGING_ADMIN_EMAIL || 'admin@staging.local';
const password = process.env.STAGING_ADMIN_PASSWORD;
const chromePath = process.env.CHROME_PATH;
let browser;

async function login(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ Staging' }).click();
  await page.locator('.shell').waitFor();
}

before(async () => {
  if (!password) return;
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
});

after(async () => { await browser?.close(); });

test('Admin desktop E2E at 1280x720 covers Dashboard, Flex Studio, Scheduler and safe preview', async (t) => {
  if (!password) return t.skip('STAGING_ADMIN_PASSWORD is required for authenticated E2E');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  try {
    await login(page);
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 });
    await page.screenshot({ path: 'qa-screenshots/phase35-e2e-desktop-1280x720.png' });
    await page.locator('aside nav button').filter({ hasText: 'Flex Studio' }).click();
    await page.getByText('Flex Studio', { exact: true }).first().waitFor();
    assert.equal(await page.locator('select').first().locator('option').count(), 7);
    await page.locator('aside nav button').filter({ hasText: 'Scheduler' }).click();
    await page.getByText('CAMPAIGN AUTOMATION STUDIO').waitFor();
    await page.getByText('Campaign Preview').waitFor();
    assert.equal(await page.locator('#schedule-zone').inputValue(), 'Asia/Bangkok');
    assert.equal(await page.getByText('ไม่มี LINE request').count(), 1);
    await page.screenshot({ path: 'qa-screenshots/phase35-e2e-scheduler-desktop-1280x720.png' });
    await page.locator('aside nav button').filter({ hasText: 'LINE OA' }).click();
    await page.getByText('เพิ่มบัญชีสำหรับ Staging').waitFor();
    assert.equal(await page.getByText('NO SECRET INPUT').count(), 1);
    assert.equal(await page.getByText('Credential จะถูกอ้างอิงจาก Server secret store').count(), 1);
    await page.screenshot({ path: 'qa-screenshots/phase4a-e2e-oa-desktop-1280x720.png' });
  } finally { await page.close(); }
});

test('Admin mobile E2E at 390x844 preserves login session and responsive Scheduler/Flex navigation', async (t) => {
  if (!password) return t.skip('STAGING_ADMIN_PASSWORD is required for authenticated E2E');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  try {
    await login(page);
    assert.deepEqual(page.viewportSize(), { width: 390, height: 844 });
    await page.locator('aside nav button').filter({ hasText: 'Scheduler' }).click();
    await page.getByText('ตั้งเวลาส่งแคมเปญ').waitFor();
    await page.screenshot({ path: 'qa-screenshots/phase35-e2e-mobile-scheduler-390x844.png' });
    await page.locator('aside nav button').filter({ hasText: 'Flex Studio' }).click();
    await page.getByText('Flex Studio', { exact: true }).first().waitFor();
    assert.equal(await page.locator('select').first().locator('option').count(), 7);
    assert.equal(await page.locator('body').evaluate((element) => element.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: 'qa-screenshots/phase35-e2e-mobile-flex-390x844.png' });
    await page.locator('aside nav button').filter({ hasText: 'LINE OA' }).click();
    await page.getByText('เพิ่มบัญชีสำหรับ Staging').waitFor();
    assert.equal(await page.locator('body').evaluate((element) => element.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: 'qa-screenshots/phase4a-e2e-oa-mobile-390x844.png' });
  } finally { await page.close(); }
});
