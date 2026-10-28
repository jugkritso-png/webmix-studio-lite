import { expect, test } from '@playwright/test';
import { statSync } from 'node:fs';
import { addTile, cards, makeWebm, pgmName, pgmPixel, pvwName } from './helpers';

test.skip(({ isMobile }) => isMobile, 'desktop-only flow');

const near = (a: number[], b: number[], tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('signal inputs: colour bars, slate, clock and black', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'source', 'bars');
  await expect(pgmName(page)).toHaveText('Color Bars');
  // first bar is 75% white
  await expect.poll(() => pgmPixel(page, 0.05, 0.3)).toEqual([191, 191, 191]);
  await addTile(page, 'source', 'slate');
  await addTile(page, 'source', 'clock');
  await addTile(page, 'source', 'black');
  await expect(cards(page)).toHaveCount(4);
  await expect(cards(page).nth(1)).toContainText('เริ่มรายการเร็ว ๆ นี้');
  await expect(cards(page).nth(2)).toContainText('นาฬิกา');
  await expect(cards(page).nth(3)).toContainText('จอดำ');
});

test('FTB fades program to black and back', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'source', 'bars');
  await expect.poll(() => pgmPixel(page, 0.05, 0.3)).toEqual([191, 191, 191]);
  await page.keyboard.press('b');
  await expect(page.locator('#chip-ftb')).toBeVisible();
  await expect(page.locator('#btn-ftb')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pgmPixel(page, 0.05, 0.3)).toEqual([5, 7, 10]);
  await page.locator('#btn-ftb').click();
  await expect.poll(() => pgmPixel(page, 0.05, 0.3)).toEqual([191, 191, 191]);
});

test('DIP goes through black, T-Bar switches by hand', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'source', 'bars');
  await addTile(page, 'source', 'color');
  await page.locator('[data-act="trans"][data-val="dip"]').click();
  await expect(page.locator('#btn-auto')).toContainText('DIP');

  // half way on the T-Bar of a DIP is full black
  await page.locator('#tbar').fill('50');
  await expect.poll(() => pgmPixel(page, 0.05, 0.3)).toEqual([5, 7, 10]);
  await page.locator('#tbar').fill('100');
  await expect(pgmName(page)).toHaveText('พื้นสี 1');
  await expect(pvwName(page)).toHaveText('Color Bars');
  // the next pull goes back the other way
  await page.locator('#tbar').fill('0');
  await expect(pgmName(page)).toHaveText('Color Bars');

  // pulling part way then back cancels
  await page.locator('#tbar').fill('30');
  await page.locator('#tbar').fill('0');
  await expect(pgmName(page)).toHaveText('Color Bars');
  await expect.poll(() => pgmPixel(page, 0.05, 0.3)).toEqual([191, 191, 191]);

  // AUTO with DIP
  await page.locator('#stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Enter');
  await expect(pgmName(page)).toHaveText('พื้นสี 1');
  await expect.poll(async () => near(await pgmPixel(page), [27, 42, 74])).toBe(true);
});

test('playlist plays files in order with transport controls', async ({ page }) => {
  await page.goto('/');
  const a = await makeWebm(page, 1000, 120);
  const b = await makeWebm(page, 1000, 0);
  await page.locator('#rail [data-cat="source"]').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-tile="playlist"]').click()]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([
    { name: 'one.webm', mimeType: 'video/webm', buffer: a },
    { name: 'two.webm', mimeType: 'video/webm', buffer: b },
  ]);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('1/2');
  await cards(page).first().click();
  await page.locator('#insp [data-act="tab"][data-val="เล่น"]').click();
  const items = page.locator('#insp .pl-item');
  await expect(items).toHaveText(['one.webm', 'two.webm']);
  await expect(items.first()).toHaveAttribute('aria-current', 'true');
  await page.locator('#insp [data-act="pl-next"]').click();
  await expect(page.locator('#insp .pl-item').nth(1)).toHaveAttribute('aria-current', 'true');
  // pause / play toggles the element
  const paused = () => page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('.media-pool video')].every((v) => v.paused));
  await page.locator('#insp [data-act="play"]').click();
  await expect.poll(paused).toBe(true);
  await page.locator('#insp [data-act="play"]').click();
  await expect.poll(paused).toBe(false);
});

test('single video loop and restart-on-air switches', async ({ page }) => {
  await page.goto('/');
  const a = await makeWebm(page, 800);
  await page.locator('#rail [data-cat="source"]').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-tile="video"]').click()]);
  await chooser.setFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: a });
  await cards(page).first().click();
  await page.locator('#insp [data-act="tab"][data-val="เล่น"]').click();
  // clips play once by default; loop is a switch away
  const loop = page.locator('#insp [data-prop="p:loop"]');
  await expect(loop).toHaveAttribute('aria-checked', 'false');
  await loop.click();
  await expect(page.locator('#insp [data-prop="p:loop"]')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => document.querySelector<HTMLVideoElement>('.media-pool video')!.loop)).toBe(true);
  await page.locator('#insp [data-prop="p:restartOnAir"]').click();
  await expect(page.locator('#insp [data-prop="p:restartOnAir"]')).toHaveAttribute('aria-checked', 'true');
});

test('4K / 60 fps output, snapshot, program window and multiview', async ({ page, context }) => {
  await page.goto('/');
  await addTile(page, 'source', 'bars');
  await addTile(page, 'source', 'color');
  await page.locator('#insp [data-act="deselect"]').click();
  await page.locator('#insp [data-prop="g:resolution"][data-val="2160p"]').click();
  await page.locator('#insp [data-prop="g:fps"][data-val="60"]').click();
  await expect(page.locator('.chip-res')).toHaveText('4K 60');
  expect(await page.locator('#cv-pgm').evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([3840, 2160]);

  const [shot] = await Promise.all([page.waitForEvent('download'), page.locator('#insp [data-act="snapshot"]').click()]);
  expect(shot.suggestedFilename()).toMatch(/\.png$/);
  expect(statSync(await shot.path()).size).toBeGreaterThan(1000);

  const [out] = await Promise.all([context.waitForEvent('page'), page.locator('#insp [data-act="out-window"]').click()]);
  await expect.poll(() => out.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? `${c.width}x${c.height}` : '';
  })).toBe('3840x2160');

  const [mv] = await Promise.all([context.waitForEvent('page'), page.locator('#insp [data-act="multiview"]').click()]);
  await expect.poll(() => mv.evaluate(() => document.querySelector('canvas')?.width ?? 0)).toBe(1920);
  // something got painted into the input grid (not just the empty ground)
  await expect.poll(() => mv.evaluate(() => {
    const c = document.querySelector('canvas')!;
    const d = c.getContext('2d')!.getImageData(60, 700, 1, 1).data;
    return d[0] + d[1] + d[2];
  })).toBeGreaterThan(300);
  await mv.screenshot({ path: 'docs/screenshots/multiview.png' });
});
