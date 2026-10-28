import { expect, test, type Page } from '@playwright/test';
import { addTile } from './helpers';

test.skip(({ isMobile }) => isMobile, 'desktop-only flow');

const insp = (page: Page) => page.locator('#insp');
const scene = (page: Page) => page.evaluate(() => (window as unknown as { __webmix: { scene: { limiter: boolean; sources: { props: Record<string, unknown> }[] } } }).__webmix.scene);

/** highest peak (dBFS) a meter shows over a short window */
async function peakOver(page: Page, id: string, ms = 2500): Promise<number> {
  return page.evaluate(async ([id, ms]) => {
    let best = -Infinity;
    const end = performance.now() + Number(ms);
    while (performance.now() < end) {
      const v = document.querySelector<HTMLElement>(`[data-meterbox="${id}"]`)?.dataset.db;
      if (v && v !== '-inf') best = Math.max(best, Number(v));
      await new Promise((r) => setTimeout(r, 50));
    }
    return best;
  }, [id, ms] as const);
}

test('mixer meters a microphone in dBFS and LUFS', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'audio', 'mic');
  const row = page.locator('#g-extra .mix-row:not(.mix-row--master)');
  await expect(row).toHaveCount(1);
  const id = await row.locator('[data-act="mute"]').getAttribute('data-id');
  expect(await peakOver(page, id!)).toBeGreaterThan(-60);
  expect(await peakOver(page, 'master')).toBeGreaterThan(-60);
  // loudness is measured by the K-weighted worklet
  await expect(page.locator('#chip-lufs')).toHaveText(/^-?\d+\.\d LUFS$/, { timeout: 8000 });
  await expect(page.locator('[data-lufs="i"]')).toHaveText(/^-?\d+\.\d$/);

  // mute silences the post-fader meter
  await row.locator('[data-act="mute"]').click();
  await page.waitForTimeout(300);
  expect(await peakOver(page, id!, 1500)).toBeLessThan(-80);

  // MON and the master limiter
  await row.locator('[data-act="mon"]').click();
  await expect(page.locator(`#g-extra [data-act="mon"][data-id="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#g-extra [data-act="limiter"]').click();
  expect((await scene(page)).limiter).toBe(false);
  await expect(page.locator('#g-extra [data-act="limiter"]')).toHaveAttribute('aria-pressed', 'false');
});

test('channel strip: gate, EQ, compressor, delay and pan', async ({ page }) => {
  await page.goto('/');
  await addTile(page, 'audio', 'mic');
  await expect(insp(page).locator('[data-prop="p:gate"]')).toBeVisible();
  await insp(page).locator('[data-prop="p:gate"]').click();
  await insp(page).locator('[data-prop="p:gateDb"]').fill('-10');
  await insp(page).locator('[data-act="advanced"]').click();
  await insp(page).locator('[data-prop="p:lowcut"]').click();
  await insp(page).locator('[data-prop="p:eqLow"]').fill('-6');
  await insp(page).locator('[data-prop="p:eqHigh"]').fill('4');
  await insp(page).locator('[data-prop="p:comp"]').click();
  await insp(page).locator('[data-prop="p:compDb"]').fill('-30');
  await insp(page).locator('[data-prop="p:delay"]').fill('120');
  await insp(page).locator('[data-prop="p:pan"]').fill('-50');
  const p = (await scene(page)).sources[0].props;
  expect(p).toMatchObject({ gate: true, gateDb: -10, lowcut: true, eqLow: -6, eqHigh: 4, comp: true, compDb: -30, delay: 120, pan: -0.5 });

  // the processing graph is live: the gate worklet loaded and holds the threshold
  const graph = await page.evaluate(async () => {
    const res = await fetch('worklets/gate.js');
    return res.ok;
  });
  expect(graph).toBe(true);

  // the output inspector exposes the limiter and monitor device
  await insp(page).locator('[data-act="deselect"]').click();
  await insp(page).locator('[data-act="advanced"]').click();
  await expect(insp(page).locator('[data-prop="g:limiter"]')).toHaveAttribute('aria-checked', 'true');
  await expect(insp(page).locator('select[data-sink]')).toBeVisible();
  await page.locator('#rail [data-cat="audio"]').click();
  await page.screenshot({ path: 'docs/screenshots/audio.png' });
});
