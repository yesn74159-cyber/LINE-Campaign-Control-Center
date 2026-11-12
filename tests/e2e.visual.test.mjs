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

const navTo = (page, label) => page.locator('aside nav button').filter({ hasText: label }).click();
/** Scheduler, LINE OA and Workspace now live behind tabs inside the six menus. */
const openTab = (page, name) => page.getByRole('tab', { name, exact: true }).click();

test('Admin desktop E2E at 1280x720 covers Dashboard, Flex Studio, Scheduler and safe preview', async (t) => {
  if (!password) return t.skip('STAGING_ADMIN_PASSWORD is required for authenticated E2E');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  try {
    await login(page);
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 });
    await page.screenshot({ path: 'qa-screenshots/phase35-e2e-desktop-1280x720.png' });
    await navTo(page, 'Flex Studio');
    await page.getByText('Flex Studio', { exact: true }).first().waitFor();
    assert.equal(await page.locator('.editor-panel select').first().locator('option').count(), 7);
    await navTo(page, 'ส่งข้อความตรง');
    await openTab(page, 'ตั้งเวลาส่ง (Scheduler)');
    await page.getByText('CAMPAIGN AUTOMATION STUDIO').waitFor();
    await page.getByText('Campaign Preview').waitFor();
    assert.equal(await page.locator('#schedule-zone').inputValue(), 'Asia/Bangkok');
    assert.equal(await page.getByText('ไม่มี LINE request').count(), 1);
    await page.screenshot({ path: 'qa-screenshots/phase35-e2e-scheduler-desktop-1280x720.png' });
    await navTo(page, 'ตั้งค่า');
    await openTab(page, 'LINE OA');
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
    await navTo(page, 'ส่งข้อความตรง');
    await openTab(page, 'ตั้งเวลาส่ง (Scheduler)');
    await page.getByText('ตั้งเวลาส่งแคมเปญ').waitFor();
    await page.screenshot({ path: 'qa-screenshots/phase35-e2e-mobile-scheduler-390x844.png' });
    await navTo(page, 'Flex Studio');
    await page.getByText('Flex Studio', { exact: true }).first().waitFor();
    assert.equal(await page.locator('.editor-panel select').first().locator('option').count(), 7);
    assert.equal(await page.locator('body').evaluate((element) => element.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: 'qa-screenshots/phase35-e2e-mobile-flex-390x844.png' });
    await navTo(page, 'ตั้งค่า');
    await openTab(page, 'LINE OA');
    await page.getByText('เพิ่มบัญชีสำหรับ Staging').waitFor();
    assert.equal(await page.locator('body').evaluate((element) => element.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: 'qa-screenshots/phase4a-e2e-oa-mobile-390x844.png' });
  } finally { await page.close(); }
});

test('Local Mock referral path at 360x800 records Click and renders portal plus offline QR', async (t) => {
  if (!password) return t.skip('STAGING_ADMIN_PASSWORD is required for authenticated E2E');
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 1 });
  try {
    await login(page);
    await navTo(page, 'ตั้งค่า');
    await openTab(page, 'ทีมงาน & การเชื่อมต่อ (Workspace)');
    await page.locator('#member-name').fill('E2E Staff');
    await page.locator('#member-email').fill(`e2e-${Date.now()}@mock.local`);
    await page.locator('#member-role').selectOption('editor');
    await page.getByRole('button', { name: 'เชิญสมาชิก' }).click();
    await page.getByText('เชิญสมาชิกแล้ว', { exact: false }).waitFor();
    await navTo(page, 'ลูกค้า');
    await openTab(page, 'ลิงก์แนะนำ (Referral)');
    await page.getByRole('heading', { name: 'Referral Dashboard', level: 2 }).waitFor();
    const staffOption = await page.locator('#referral-staff option').nth(1).getAttribute('value');
    assert.ok(staffOption);
    await page.locator('#referral-staff').selectOption(staffOption);
    // The referral form takes its OA from the top-bar picker; there is no second select.
    assert.match(await page.locator('.referral-oa-note').innerText(), /ใช้บัญชี/);
    await page.getByRole('button', { name: 'สร้างลิงก์' }).click();
    await page.getByText('Plain Token แสดงครั้งนี้ครั้งเดียว', { exact: false }).waitFor();
    assert.equal(await page.locator('.qr-wrap svg[aria-label="Offline QR code"]').count(), 1);
    const referralUrl = await page.getByLabel('Referral URL').inputValue();
    await page.goto(referralUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'เข้าร่วมแคมเปญ' }).waitFor();
    await page.getByText('ลิงก์นี้เชื่อมกับสมาชิก', { exact: false }).waitFor();
    const lineLoginButton = page.getByRole('button', { name: 'เข้าสู่ระบบด้วย LINE' });
    await lineLoginButton.waitFor();
    assert.equal(await lineLoginButton.count(), 1);
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: 'qa-screenshots/referral-staff-portal-mobile-360x800.png' });
  } finally { await page.close(); }
});
