import { expect, test, type Page } from '@playwright/test';
import { addTile, cards, pgmName } from './helpers';

test.skip(({ isMobile }) => isMobile, 'desktop-only flow');

const GATEWAY = 'ws://localhost:8090/?token=test-token';
const stats = async (page: Page) => (await page.request.get('http://localhost:8090/stats')).json();
const dlg = (page: Page) => page.locator('#dlg');

test.beforeEach(async ({ page }) => {
  await page.request.get('http://localhost:8090/reset');
});

async function openLivePanel(page: Page) {
  await page.locator('#btn-live').click();
  await expect(dlg(page).locator('.live-panel')).toBeVisible();
  await dlg(page).locator('#gw').fill(GATEWAY);
}

test('streams Program to several destinations through the gateway', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'source', 'bars');
  await openLivePanel(page);
  const first = dlg(page).locator('.dest').first();
  await first.locator('[data-f="key"]').fill('abc-123');
  await first.locator('[data-live="start"]').click();
  await expect(first.locator('[data-state]')).toHaveText('LIVE');
  await expect(page.locator('#btn-live')).toContainText('LIVE');
  await expect(page.locator('#chip-live')).toContainText('1');
  await expect.poll(async () => (await stats(page)).bytes, { timeout: 8000 }).toBeGreaterThan(10_000);
  const s1 = await stats(page);
  expect(s1.starts).toEqual(['rtmp://a.rtmp.youtube.com/live2/abc-123']);
  expect(s1.params).toMatchObject({ token: 'test-token', fps: '30', vb: '4500', res: '720' });
  await expect(first.locator('[data-kbps]')).toHaveText(/\d+ kbps/);

  // add Twitch while live: it joins the same connection
  await dlg(page).locator('[data-live="add"]').click();
  const second = dlg(page).locator('.dest').nth(1);
  await second.locator('[data-f="platform"]').selectOption('twitch');
  await second.locator('[data-f="key"]').fill('live_xyz');
  await second.locator('[data-live="start"]').click();
  await expect(second.locator('[data-state]')).toHaveText('LIVE');
  expect((await stats(page)).connections).toBe(1);
  expect((await stats(page)).starts).toContain('rtmp://live.twitch.tv/app/live_xyz');
  await expect(page.locator('#chip-live')).toContainText('2');

  // stopping everything asks first
  await dlg(page).locator('[data-live="stop-all"]').click();
  await expect(dlg(page)).toContainText('หยุดไลฟ์ทั้งหมด');
  await dlg(page).locator('[data-live="confirm-stop"]').click();
  await expect(page.locator('#btn-live')).not.toContainText('LIVE');
  await expect(dlg(page).locator('.dest').first().locator('[data-state]')).toHaveText('หยุดแล้ว');
  expect((await stats(page)).stops.sort()).toHaveLength(2);

  // keys and the gateway token never reach localStorage
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain('abc-123');
  expect(stored).not.toContain('live_xyz');
  expect(stored).not.toContain('test-token');
});

test('checks a stream key without going live, and explains bad settings', async ({ page }) => {
  await page.goto('/');
  await openLivePanel(page);
  const d = dlg(page).locator('.dest').first();
  await d.locator('[data-f="key"]').fill('bad-key');
  await d.locator('[data-live="probe"]').click();
  await expect(d.locator('[data-msg]')).toHaveText('เซิร์ฟเวอร์ปฏิเสธคีย์สตรีม');
  await d.locator('[data-f="key"]').fill('good-key');
  await d.locator('[data-live="probe"]').click();
  await expect(d.locator('[data-msg]')).toHaveText('ตรวจแล้ว ใช้ได้');
  expect((await stats(page)).bytes).toBe(0);

  // missing key and a wrong SRT URL are caught before connecting
  await d.locator('[data-f="key"]').fill('');
  await dlg(page).locator('[data-live="start-all"]').click();
  await expect(d.locator('[data-msg]')).toContainText('วางคีย์สตรีม');
  await d.locator('[data-f="platform"]').selectOption('srt');
  await dlg(page).locator('.dest').first().locator('[data-f="server"]').fill('srt://host-without-port');
  await dlg(page).locator('[data-live="start-all"]').click();
  await expect(dlg(page).locator('.dest').first().locator('[data-msg]')).toContainText('srt://');

  // a wrong token is reported, not retried forever
  await dlg(page).locator('#gw').fill('ws://localhost:8090/?token=nope');
  await dlg(page).locator('.dest').first().locator('[data-f="server"]').fill('srt://example.com:9000?streamid=x');
  await dlg(page).locator('.dest').first().locator('[data-live="start"]').click();
  await expect(dlg(page).locator('.dest').first().locator('[data-state]')).toHaveText('ผิดพลาด');
  await expect(dlg(page).locator('.dest').first().locator('[data-msg]')).toContainText('token');
  await page.screenshot({ path: 'docs/screenshots/live.png' });
});

test('phone camera joins by QR link and gets tally', async ({ page, browser }) => {
  await page.goto('/?peer=localhost:9000');
  await addTile(page, 'source', 'bars');
  await page.locator('[data-tile="phone"]').click();
  const link = dlg(page).locator('#remote-link');
  await expect(link).toHaveValue(/cam\.html\?call=webmix-lite-/, { timeout: 15000 });
  await expect(dlg(page).locator('.remote__qr svg')).toBeVisible();
  const url = await link.inputValue();
  expect(url).toContain('sig=');

  const phoneCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const phone = await phoneCtx.newPage();
  await phone.goto(url);
  await phone.locator('#name').fill('กล้องเวที');
  await phone.locator('#go').click();
  await expect(cards(page)).toHaveCount(2, { timeout: 20000 });
  await expect(cards(page).nth(1)).toContainText('กล้องเวที');
  await expect(phone.locator('#cam-chip')).toContainText('เชื่อมต่อแล้ว', { timeout: 15000 });

  // the phone sees its tally: preview, then on air
  await page.locator('#stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('2');
  await expect(phone.locator('#tally')).toHaveText('PREVIEW', { timeout: 10000 });
  await page.keyboard.press('Space');
  await expect(pgmName(page)).toHaveText('กล้องเวที');
  await expect(phone.locator('#tally')).toHaveText('ON AIR', { timeout: 10000 });
  // real pictures arrive from the phone
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('.media-pool video')].some((v) => v.videoWidth > 0 && (v.srcObject as MediaStream | null)?.getVideoTracks().length))).toBe(true);
  await phone.screenshot({ path: 'docs/screenshots/phone.png' });
  await phoneCtx.close();
});

test('remote guest hears and sees the programme back', async ({ page, browser }) => {
  await page.goto('/?peer=localhost:9000');
  await addTile(page, 'source', 'bars');
  await page.locator('[data-tile="guest"]').click();
  await dlg(page).locator('#guest-name').fill('คุณสมชาย');
  await dlg(page).locator('#guest-name').press('Tab');
  const link = dlg(page).locator('#remote-link');
  await expect(link).toHaveValue(/guest=1/, { timeout: 15000 });
  const url = await link.inputValue();
  expect(url).toContain('name=');

  const guestCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guest = await guestCtx.newPage();
  await guest.goto(url);
  await expect(guest.locator('#name')).toHaveValue('คุณสมชาย');
  await guest.locator('#go').click();
  await expect(cards(page)).toHaveCount(2, { timeout: 20000 });
  await expect(cards(page).nth(1)).toContainText('คุณสมชาย');
  await expect(cards(page).nth(1)).toContainText('แขกทางไกล');
  // the return feed carries Program video and a mix-minus audio track
  await expect.poll(() => guest.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('#ret');
    const s = v?.srcObject as MediaStream | null;
    return s ? `${s.getVideoTracks().length}v${s.getAudioTracks().length}a` : '';
  }), { timeout: 15000 }).toBe('1v1a');
  await guestCtx.close();
});
