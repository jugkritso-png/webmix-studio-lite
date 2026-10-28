import { expect, test, type Page } from '@playwright/test';
import { addTile, cards, pgmName, pvwName } from './helpers';

const menu = (page: Page) => page.locator('#card-menu');
const ovlBtn = (page: Page, n: number) => page.locator(`#ovl-row [data-i="${n - 1}"]`);

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop flow');

  test('right click a card to put it on an overlay channel', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'bars');
    await addTile(page, 'source', 'cam');
    await addTile(page, 'text', 't-l3');
    await expect(cards(page)).toHaveCount(3);

    // the camera: right click → Overlay 3 → it goes up as a PIP, Program stays on the bars
    await cards(page).nth(1).click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('.ovl-pick')).toHaveCount(8);
    await expect(menu(page).locator('[data-i="0"]')).toContainText('หัวข้อวันนี้');
    await menu(page).locator('[data-i="2"]').click();
    await expect(menu(page)).toHaveCount(0);
    await expect(ovlBtn(page, 3)).toHaveAttribute('aria-pressed', 'true');
    await expect(cards(page).nth(1)).toContainText('Overlay 3 · ออนแอร์');
    await expect(pgmName(page)).toHaveText('Color Bars');

    // its menu now offers take off / remove
    await cards(page).nth(1).click({ button: 'right' });
    await expect(menu(page).locator('[data-i="2"]')).toHaveAttribute('aria-pressed', 'true');
    await menu(page).locator('[data-menu="toggle"]').click();
    await expect(ovlBtn(page, 3)).toHaveAttribute('aria-pressed', 'false');
    await cards(page).nth(1).click({ button: 'right' });
    await menu(page).locator('[data-menu="unassign"]').click();
    await expect(ovlBtn(page, 3)).toHaveClass(/is-empty/);

    // Escape closes, and so does a click elsewhere
    await cards(page).nth(0).click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await cards(page).nth(0).click({ button: 'right' });
    await page.locator('#stage').click({ position: { x: 5, y: 5 } });
    await expect(menu(page)).toHaveCount(0);
  });

  test('holding the mouse on a card opens the menu without switching', async ({ page }) => {
    await page.goto('/');
    await addTile(page, 'source', 'bars');
    await addTile(page, 'source', 'color');
    await expect(pvwName(page)).toHaveText('พื้นสี 1');
    const box = (await cards(page).nth(0).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    await expect(menu(page)).toBeVisible();
    // the press did not send Color Bars to Preview
    await expect(pvwName(page)).toHaveText('พื้นสี 1');
    await menu(page).locator('[data-menu="pvw"]').click();
    await expect(pvwName(page)).toHaveText('พื้นสี 1');
    await page.screenshot({ path: 'docs/screenshots/card-menu.png' });
  });
});

test.describe('touch', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch flow');

  test('long press a card on a phone opens the overlay sheet', async ({ page }) => {
    await page.goto('/');
    await page.locator('#rail [data-cat="text"]').tap();
    await page.locator('[data-tile="t-l3"]').tap();
    await page.locator('#rail [data-cat="source"]').tap();
    await page.locator('[data-tile="bars"]').tap();
    await page.locator('#gallery .g-close').tap();
    await expect(cards(page)).toHaveCount(2);
    await expect(page.locator('#gallery')).toBeHidden();
    await page.waitForTimeout(300); // the sheet finishes sliding away
    // a real touch held for 700 ms (card scrolled clear of the bottom bar first)
    await cards(page).nth(0).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = (await cards(page).nth(0).boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(menu(page)).toBeVisible();
    const m = (await menu(page).boundingBox())!;
    expect(m.y + m.height).toBeGreaterThan(page.viewportSize()!.height - 4);
    const small = await menu(page).evaluate((el) => [...el.querySelectorAll<HTMLElement>('button')]
      .filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent?.trim()));
    expect(small).toEqual([]);
    await page.screenshot({ path: 'docs/screenshots/card-menu-mobile.png' });
    await menu(page).locator('[data-i="1"]').tap();
    await expect(menu(page)).toHaveCount(0);
    await expect(cards(page).nth(0)).toContainText('Overlay 2 · ออนแอร์');
  });
});
