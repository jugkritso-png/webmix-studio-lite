import { expect, test, type Page } from '@playwright/test';
import { addTile, cards, makeWebm, pgmName } from './helpers';

test.skip(({ isMobile }) => isMobile, 'desktop-only flow');

const video = (page: Page) => page.evaluate(() => {
  const v = document.querySelector<HTMLVideoElement>('.media-pool video');
  return v ? { t: v.currentTime, paused: v.paused, dur: v.duration, ready: v.readyState } : null;
});

async function addClip(page: Page, buffer: Buffer, name = 'clip.webm') {
  await page.locator('#rail [data-cat="source"]').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-tile="video"]').click()]);
  await chooser.setFiles({ name, mimeType: 'video/webm', buffer });
}

test('a clip waits in Preview, rolls on air and pauses when taken off', async ({ page }) => {
  await page.goto('/');
  const clip = await makeWebm(page, 2500);
  await addTile(page, 'source', 'bars');
  await addClip(page, clip);
  await expect(page.getByTestId('pvw-name')).toHaveText('clip.webm');
  // sitting in Preview: paused on its first frame
  await page.waitForTimeout(800);
  expect(await video(page)).toMatchObject({ paused: true, t: 0 });
  await expect(cards(page).nth(1).locator('.wm-card__sub')).toHaveText(/^หยุด/);
  // the inspector opens on the transport tab
  await expect(page.locator('#insp [data-act="tab"][data-val="เล่น"]')).toHaveAttribute('aria-selected', 'true');

  await page.locator('#stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await expect(pgmName(page)).toHaveText('clip.webm');
  await expect.poll(async () => (await video(page))?.paused).toBe(false);
  await expect(cards(page).nth(1).locator('.wm-card__sub')).toHaveText(/^เล่น −/);
  await page.waitForTimeout(600);
  const playedTo = (await video(page))!.t;
  expect(playedTo).toBeGreaterThan(0.2);

  // off air: it pauses where it is
  await page.keyboard.press('Space');
  await expect(pgmName(page)).toHaveText('Color Bars');
  await expect.poll(async () => (await video(page))?.paused).toBe(true);

  // with "restart on air" it starts from the top next time
  await cards(page).nth(1).click();
  await page.locator('#insp [data-prop="p:restartOnAir"]').click();
  await page.keyboard.press('Space');
  await expect(pgmName(page)).toHaveText('clip.webm');
  await expect.poll(async () => (await video(page))!.t).toBeLessThan(playedTo);

  // played to the end without loop: it holds and says so
  await expect(cards(page).nth(1).locator('.wm-card__sub')).toHaveText('จบแล้ว', { timeout: 8000 });
});

test('clips come back after a reload without picking the file again', async ({ page }) => {
  await page.goto('/');
  const clip = await makeWebm(page, 1500);
  await addClip(page, clip, 'intro.webm');
  await expect(cards(page)).toHaveCount(1);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect.poll(async () => (await video(page))?.ready ?? 0, { timeout: 8000 }).toBeGreaterThan(1);
  expect((await video(page))!.dur).toBeGreaterThan(1);
  await expect(cards(page).first()).not.toContainText('ไม่มีสัญญาณ');
});

test('a file the browser cannot play says what to do', async ({ page }) => {
  await page.goto('/');
  await addClip(page, Buffer.from('this is not a video'), 'broken.mov');
  await expect(page.locator('.wm-toast')).toContainText('เล่น broken.mov ไม่ได้', { timeout: 8000 });
  await expect(page.locator('.wm-toast')).toContainText('MP4 (H.264)');
});
