import { expect, test, type Page } from '@playwright/test';
import { addTile, cards, pgmName, pgmPixel } from './helpers';

test.skip(({ isMobile }) => isMobile, 'desktop-only flow');

const insp = (page: Page) => page.locator('#insp');
const ovlBtn = (page: Page, n: number) => page.locator(`#ovl-row [data-i="${n - 1}"]`);

/** A PNG made in the page: green background with a red square in the middle. */
async function greenPng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(110, 40, 100, 100);
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

async function addImage(page: Page) {
  const png = await greenPng(page);
  await page.locator('#rail [data-cat="source"]').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-tile="image"]').click()]);
  await chooser.setFiles({ name: 'green.png', mimeType: 'image/png', buffer: png });
}

test('graphics land on overlay channels with in / out effects', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'source', 'bars');
  const bare = await pgmPixel(page, 0.2, 0.8);
  await addTile(page, 'text', 't-l3');
  await expect(cards(page).nth(1)).toContainText('Overlay 1 · ออนแอร์');
  await expect(ovlBtn(page, 1)).toHaveAttribute('aria-pressed', 'true');
  await expect(ovlBtn(page, 2)).toHaveClass(/is-empty/);
  await expect.poll(() => pgmPixel(page, 0.2, 0.8)).not.toEqual(bare);

  // Shift+1 takes it off, the bus stays on Color Bars
  await page.locator('#stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+Digit1');
  await expect(ovlBtn(page, 1)).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => pgmPixel(page, 0.2, 0.8)).toEqual(bare);
  await expect(pgmName(page)).toHaveText('Color Bars');

  // the number key of a graphic toggles it too
  await page.keyboard.press('2');
  await expect(ovlBtn(page, 1)).toHaveAttribute('aria-pressed', 'true');

  // move it to channel 3 with a wipe
  await cards(page).nth(1).click();
  await insp(page).locator('[data-act="advanced"]').click();
  await insp(page).locator('select[data-ovl="fx"]').selectOption('wipe');
  await insp(page).locator('select[data-ovl="ch"]').selectOption('2');
  await expect(ovlBtn(page, 3)).not.toHaveClass(/is-empty/);
  await expect(ovlBtn(page, 1)).toHaveClass(/is-empty/);
  await ovlBtn(page, 3).click();
  await expect(ovlBtn(page, 3)).toHaveAttribute('aria-pressed', 'true');
  const sceneOverlay = await page.evaluate(() => (window as unknown as { __webmix: { scene: { overlays: { fx: string; on: boolean }[] } } }).__webmix.scene.overlays[2]);
  expect(sceneOverlay).toMatchObject({ fx: 'wipe', on: true });

  // after a reload the graphic keeps its channel but stays off air
  await page.waitForTimeout(500);
  await page.reload();
  await expect(ovlBtn(page, 3)).not.toHaveClass(/is-empty/);
  await expect(ovlBtn(page, 3)).toHaveAttribute('aria-pressed', 'false');
});

test('empty overlay button picks a source; a camera becomes a PIP; cue shows on PVW only', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'source', 'cam');
  await addTile(page, 'source', 'bars');
  await expect(pgmName(page)).toHaveText('กล้อง 1');
  const pvwPixel = (fx: number, fy: number) => page.evaluate(([fx, fy]) => {
    const c = document.querySelector<HTMLCanvasElement>('#cv-pvw')!;
    return [...c.getContext('2d')!.getImageData(c.width * fx, c.height * fy, 1, 1).data.slice(0, 3)];
  }, [fx, fy]);

  // tap the empty Overlay 4 and choose the camera: it shrinks to a PIP, the buses move on
  await ovlBtn(page, 4).click();
  await expect(page.locator('#dlg')).toContainText('Overlay 4');
  await page.locator('#dlg [data-pick]').filter({ hasText: 'กล้อง 1' }).click();
  await expect(ovlBtn(page, 4)).toHaveAttribute('aria-pressed', 'true');
  await expect(pgmName(page)).toHaveText('Color Bars');
  await expect(page.getByTestId('pvw-name')).toHaveText('ว่าง');
  const props = await page.evaluate(() => (window as unknown as { __webmix: { scene: { sources: { props: { scale: number; x: number } }[] } } }).__webmix.scene.sources[0].props);
  expect(props).toMatchObject({ scale: 0.32, x: 0.58 });
  // the bars still show around the PIP
  await expect.poll(() => pgmPixel(page, 0.05, 0.3)).toEqual([191, 191, 191]);

  // a lower third cued on PVW: visible in Preview, not on Program
  await addTile(page, 'text', 't-l3');
  await ovlBtn(page, 1).click();
  await expect(ovlBtn(page, 1)).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(700); // let the slide-out finish
  const before = await pgmPixel(page, 0.12, 0.82);
  await insp(page).locator('[data-act="advanced"]').click();
  await insp(page).locator('[data-prop="o:cue"]').click();
  await expect(ovlBtn(page, 1)).toHaveClass(/is-cued/);
  await expect.poll(() => pvwPixel(0.12, 0.82)).not.toEqual([5, 7, 10]);
  expect(await pgmPixel(page, 0.12, 0.82)).toEqual(before);
});

test('chroma key removes the green screen', async ({ page }) => {
  await page.goto('/');
  await addImage(page);
  await expect(cards(page)).toHaveCount(1);
  await expect.poll(() => pgmPixel(page, 0.1, 0.1)).toEqual([0, 255, 0]);
  await cards(page).first().click();
  await insp(page).locator('[data-act="tab"][data-val="เอฟเฟกต์"]').click();
  await insp(page).locator('[data-prop="p:key"][data-val="green"]').click();
  await expect(insp(page).locator('[data-prop="p:keyTol"]')).toBeVisible();
  // green is keyed out to the ground behind it; the red square stays
  await expect.poll(() => pgmPixel(page, 0.1, 0.1)).toEqual([5, 7, 10]);
  await expect.poll(() => pgmPixel(page, 0.5, 0.5)).toEqual([255, 0, 0]);
});

test('picture-in-picture with crop and border over the program', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'source', 'bars');
  await addImage(page);
  await page.locator('#rail [data-cat="graphic"]').click();
  await page.locator('[data-tile="g-pip"]').click();
  await page.locator('#dlg [data-pip]').first().click();
  await expect(pgmName(page)).toHaveText('Color Bars');
  // the PIP sits right of centre, the bars stay visible on the left
  await expect.poll(() => pgmPixel(page, 0.05, 0.3)).toEqual([191, 191, 191]);
  await expect.poll(async () => (await pgmPixel(page, 0.66, 0.75))[1]).toBeGreaterThan(200);
  await insp(page).locator('[data-act="advanced"]').click();
  await insp(page).locator('[data-prop="p:cropL"]').fill('40');
  await expect(insp(page).locator('[data-prop="p:border"]')).toBeVisible();
  const props = await page.evaluate(() => (window as unknown as { __webmix: { scene: { sources: { props: { cropL: number; border: number; scale: number } }[] } } }).__webmix.scene.sources[1].props);
  expect(props).toMatchObject({ cropL: 0.4, border: 4, scale: 0.32 });
});

test('countdown timer runs, pauses and resets', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'graphic', 'g-timer');
  await expect(insp(page).locator('#timer-val')).toHaveText('05:00');
  await insp(page).locator('[data-prop="p:timerDur"]').fill('1');
  await insp(page).locator('[data-act="timer-run"]').click();
  await expect(insp(page).locator('#timer-val')).toHaveText(/00:5\d/, { timeout: 4000 });
  await insp(page).locator('[data-act="timer-run"]').click();
  const paused = await insp(page).locator('#timer-val').textContent();
  await page.waitForTimeout(1300);
  await expect(insp(page).locator('#timer-val')).toHaveText(paused!);
  await insp(page).locator('[data-act="timer-reset"]').click();
  await expect(insp(page).locator('#timer-val')).toHaveText('01:00');
});

test('scoreboard buttons and title presets', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'graphic', 'g-score');
  const plusA = insp(page).locator('[data-act="score"][data-team="A"][data-d="1"]');
  await plusA.click();
  await plusA.click();
  await insp(page).locator('[data-act="score"][data-team="B"][data-d="1"]').click();
  await expect(insp(page).locator('.score-val')).toHaveText(['2', '1']);
  await insp(page).locator('[data-act="score"][data-team="A"][data-d="-1"]').click();
  await expect(insp(page).locator('.score-val')).toHaveText(['1', '1']);

  await addTile(page, 'text', 't-l3');
  await insp(page).locator('[data-prop="p:title"]').fill('สมชาย ใจดี');
  await insp(page).locator('[data-prop="p:sub"]').fill('ผู้ดำเนินรายการ');
  await insp(page).locator('[data-act="preset-save"]').click();
  await insp(page).locator('[data-prop="p:title"]').fill('คนอื่น');
  await insp(page).locator('[data-act="preset"]').first().click();
  await expect(insp(page).locator('[data-prop="p:title"]')).toHaveValue('สมชาย ใจดี');
  await expect(cards(page).nth(1)).toContainText('สมชาย ใจดี');
});

test('ticker items and live data from a Google Sheet', async ({ page }) => {
  await page.route('https://docs.google.com/**', (route) => route.fulfill({
    status: 200, contentType: 'text/csv',
    body: 'ชื่อ,ตำแหน่ง\nสมชาย ใจดี,ผู้ดำเนินรายการ\nสมหญิง รักงาน,วิทยากร\n',
  }));
  await page.goto('/');
  await addTile(page, 'text', 't-l3');
  await insp(page).locator('[data-act="tab"][data-val="ข้อมูล"]').click();
  await insp(page).locator('[data-prop="p:dataUrl"]').fill('https://docs.google.com/spreadsheets/d/abc123/edit#gid=0');
  await insp(page).locator('[data-act="data-refresh"]').click();
  await expect(insp(page).locator('#data-status')).toContainText('แถว 1 / 2');
  await expect(cards(page).first()).toContainText('สมชาย ใจดี');
  await insp(page).locator('[data-act="data-row"][data-d="1"]').click();
  await expect(cards(page).first()).toContainText('สมหญิง รักงาน');
  await expect(insp(page).locator('#data-status')).toContainText('แถว 2 / 2');

  await addTile(page, 'text', 't-ticker');
  await expect(insp(page).locator('[data-prop="p:items"]')).toBeVisible();
  await insp(page).locator('[data-prop="p:items"]').fill('ข่าวแรก\nข่าวสอง');
  const items = await page.evaluate(() => (window as unknown as { __webmix: { scene: { sources: { props: { items: string } }[] } } }).__webmix.scene.sources[1].props.items);
  expect(items).toBe('ข่าวแรก\nข่าวสอง');
  await page.screenshot({ path: 'docs/screenshots/graphics.png' });
});
