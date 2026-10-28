import { expect, test, type Page } from '@playwright/test';
import { statSync } from 'node:fs';

const pgmName = (page: Page) => page.getByTestId('pgm-name');
const pvwName = (page: Page) => page.getByTestId('pvw-name');
const cards = (page: Page) => page.locator('#strip .wm-card');

async function addTile(page: Page, cat: string, tile: string) {
  const rail = page.locator(`#rail [data-cat="${cat}"]`);
  if ((await rail.getAttribute('aria-current')) !== 'true' || !(await page.locator(`[data-tile="${tile}"]`).isVisible())) await rail.click();
  await page.locator(`[data-tile="${tile}"]`).click();
}

/** Average RGB of the PGM canvas centre. */
const pgmPixel = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>('#cv-pgm')!;
  const d = c.getContext('2d')!.getImageData(c.width / 2 - 5, c.height / 2 - 5, 10, 10).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return [r / n, g / n, b / n].map(Math.round);
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop-only flow');

  test('shows the shell with seven categories', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#rail button')).toHaveText(['แหล่งภาพ', 'เสียง', 'กราฟิก', 'ข้อความ', 'คอมเมนต์', 'เอฟเฟกต์', 'ไลฟ์']);
    await expect(page.locator('#btn-rec')).toContainText('บันทึก');
    await expect(page.locator('#btn-live')).toContainText('ไลฟ์');
    await expect(page.locator('.wm-tile--new')).toContainText('เพิ่มแหล่งภาพ');
    await expect(page.locator('#chips .wm-chip')).toHaveCount(2);
  });

  test('adds sources and switches with CUT and AUTO', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'cam');
    await expect(cards(page)).toHaveCount(1);
    await expect(pgmName(page)).toHaveText('กล้อง 1');

    await addTile(page, 'source', 'color');
    await expect(cards(page)).toHaveCount(2);
    await expect(pvwName(page)).toHaveText('พื้นสี 1');
    const before = await pgmPixel(page);

    await page.keyboard.press('Space');
    await expect(pgmName(page)).toHaveText('พื้นสี 1');
    await expect(pvwName(page)).toHaveText('กล้อง 1');
    await expect(cards(page).nth(1)).toHaveClass(/is-pgm/);
    await expect(cards(page).nth(0)).toHaveClass(/is-pvw/);
    await expect.poll(() => pgmPixel(page)).not.toEqual(before);

    await page.keyboard.press('Enter');
    await expect(page.locator('#mon-pgm')).toHaveAttribute('data-source', await cards(page).nth(0).getAttribute('data-id') ?? '');
    await expect(pgmName(page)).toHaveText('กล้อง 1');

    // WIPE + the on-screen keys
    await page.locator('[data-act="trans"][data-val="wipe"]').click();
    await expect(page.locator('#btn-auto')).toContainText('WIPE');
    await page.locator('#btn-auto').click();
    await expect(pgmName(page)).toHaveText('พื้นสี 1');
    await page.locator('#btn-cut').click();
    await expect(pgmName(page)).toHaveText('กล้อง 1');

    // number key twice: first to PVW, again to CUT
    await page.keyboard.press('2');
    await expect(pvwName(page)).toHaveText('พื้นสี 1');
    await page.keyboard.press('2');
    await expect(pgmName(page)).toHaveText('พื้นสี 1');
  });

  test('double-tap on a card cuts it to program', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'color');
    await addTile(page, 'source', 'color');
    await expect(pgmName(page)).toHaveText('พื้นสี 1');
    await cards(page).nth(1).dblclick();
    await expect(pgmName(page)).toHaveText('พื้นสี 2');
  });

  test('delete shows an undo toast and undo restores the source', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'cam');
    await addTile(page, 'text', 't-l3');
    await expect(cards(page)).toHaveCount(2);

    await cards(page).nth(0).click();
    await page.locator('#insp [data-act="delete"]').click();
    await expect(cards(page)).toHaveCount(1);
    const toast = page.locator('.wm-toast');
    await expect(toast).toContainText('ลบ กล้อง 1 แล้ว');
    await toast.getByRole('button', { name: 'ย้อนกลับ' }).click();
    await expect(cards(page)).toHaveCount(2);
    await expect(pgmName(page)).toHaveText('กล้อง 1');

    // keyboard undo / redo of an inspector change
    await cards(page).nth(1).click();
    await page.locator('#insp [data-prop="p:title"]').fill('คุณสมชาย');
    await expect(cards(page).nth(1)).toContainText('คุณสมชาย');
    await page.locator('#stage').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect(cards(page).nth(1)).not.toContainText('คุณสมชาย');
    await page.keyboard.press('Control+Shift+z');
    await expect(cards(page).nth(1)).toContainText('คุณสมชาย');
  });

  test('inspector edits size, opacity and flip with advanced settings', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'cam');
    await cards(page).first().click();
    const insp = page.locator('#insp');
    await expect(insp.locator('.wm-insp__title')).toHaveText('กล้อง 1');
    await insp.locator('[data-prop="p:scale"]').fill('150');
    await insp.locator('[data-prop="p:opacity"]').fill('50');
    await insp.locator('[data-prop="p:flip"]').click();
    await expect(insp.locator('[data-prop="p:flip"]')).toHaveAttribute('aria-checked', 'true');
    await insp.locator('[data-act="advanced"]').click();
    await expect(insp.locator('[data-prop="p:x"]')).toBeVisible();
    const props = await page.evaluate(() => (window as unknown as { __webmix: { scene: { sources: { props: { scale: number; opacity: number; flip: boolean } }[] } } }).__webmix.scene.sources[0].props);
    expect(props).toMatchObject({ scale: 1.5, opacity: 0.5, flip: true });
  });

  test('records the program output to a file', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'cam');
    await addTile(page, 'text', 't-l3');
    await page.locator('#btn-rec').click();
    await expect(page.locator('#chip-rec')).toBeVisible();
    await page.waitForTimeout(2500);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-rec').click()]);
    expect(download.suggestedFilename()).toMatch(/^webmix-\d+\.(webm|mp4)$/);
    const file = await download.path();
    expect(statSync(file).size).toBeGreaterThan(0);
    await expect(page.locator('.wm-toast')).toContainText('บันทึกไฟล์');
  });

  test('saves the scene to localStorage and restores it', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'text', 't-l3');
    await addTile(page, 'source', 'color');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(cards(page)).toHaveCount(2);
    await expect(cards(page).nth(0)).toContainText('หัวข้อวันนี้');
    await expect(pgmName(page)).toHaveText('พื้นสี 1');
  });

  test('drag a tile onto the PVW monitor', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'color');
    await page.locator('[data-tile="color"]').dragTo(page.locator('#mon-pvw'));
    await expect(cards(page)).toHaveCount(2);
    await expect(pvwName(page)).toHaveText('พื้นสี 2');
  });

  test('live settings never keep the stream key', async ({ page }) => {
    await page.goto('/');
    await page.locator('#btn-live').click();
    const dlg = page.locator('#dlg');
    await expect(dlg).toContainText('ต้องใช้ gateway');
    await dlg.locator('#live-url').fill('http://wrong');
    await dlg.locator('#live-check').click();
    await expect(dlg.locator('#live-help')).toContainText('rtmp://');
    await dlg.locator('#live-url').fill('rtmp://a.rtmp.youtube.com/live2');
    await dlg.locator('#live-key').fill('secret-key-123');
    await dlg.locator('#live-check').click();
    await expect(dlg.locator('#live-help')).toContainText('ต่อ gateway');
    await dlg.getByRole('button', { name: 'ปิด' }).last().click();
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    expect(stored).not.toContain('secret-key-123');
  });

  test('Thai text is never below 12px', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'cam');
    await cards(page).first().click();
    const small = await page.evaluate(() => {
      const out: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (!/[฀-๿]/.test(n.textContent ?? '')) continue;
        const el = n.parentElement!;
        if (!el.checkVisibility()) continue;
        if (parseFloat(getComputedStyle(el).fontSize) < 12) out.push(n.textContent!.trim());
      }
      return out;
    });
    expect(small).toEqual([]);
  });

  test('desktop screenshot', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'cam');
    await addTile(page, 'source', 'color');
    await addTile(page, 'text', 't-l3');
    await cards(page).first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'docs/screenshots/desktop.png' });
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile-only flow');

  test('rail becomes a bottom tab bar with sheets', async ({ page }) => {
    await page.goto('/');
    const vp = page.viewportSize()!;
    const rail = await page.locator('#rail').boundingBox();
    expect(rail!.y + rail!.height).toBeGreaterThan(vp.height - 2);
    await expect(page.locator('#gallery')).toBeHidden();

    await page.locator('#rail [data-cat="source"]').tap();
    await expect(page.locator('#gallery')).toBeVisible();
    await page.locator('[data-tile="cam"]').tap();
    await expect(cards(page)).toHaveCount(1);
    await page.locator('#rail [data-cat="text"]').tap();
    await page.locator('[data-tile="t-l3"]').tap();
    await expect(cards(page)).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.locator('#gallery .g-close').tap();
    await expect(page.locator('#gallery')).toBeHidden();

    await page.locator('[data-act="open-insp"]').tap();
    await expect(page.locator('#insp')).toBeVisible();
    await page.waitForTimeout(400); // let the sheet finish sliding in
    await page.locator('#insp .insp-close').tap();
    await expect(page.locator('#insp')).toBeHidden();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'docs/screenshots/mobile.png' });
  });

  test('touch targets are at least 44px', async ({ page }) => {
    await page.goto('/');
    await page.locator('#rail [data-cat="source"]').tap();
    await page.locator('[data-tile="color"]').tap();
    await page.locator('#gallery .g-close').tap();
    const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, [role="button"], input:not([type="range"])')]
      .filter((el) => el.checkVisibility() && !el.closest('.gallery, .insp'))
      .map((el) => ({ el: el.textContent?.trim() || el.getAttribute('aria-label') || el.className, h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 44));
    expect(small).toEqual([]);
  });
});
