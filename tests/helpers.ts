import type { Page } from '@playwright/test';

export const pgmName = (page: Page) => page.getByTestId('pgm-name');
export const pvwName = (page: Page) => page.getByTestId('pvw-name');
export const cards = (page: Page) => page.locator('#strip .wm-card');

export async function addTile(page: Page, cat: string, tile: string) {
  const rail = page.locator(`#rail [data-cat="${cat}"]`);
  if ((await rail.getAttribute('aria-current')) !== 'true' || !(await page.locator(`[data-tile="${tile}"]`).isVisible())) await rail.click();
  await page.locator(`[data-tile="${tile}"]`).click();
}

/** Average RGB of a 10×10 patch of the PGM canvas (fractions of width / height). */
export const pgmPixel = (page: Page, fx = 0.5, fy = 0.5) => page.evaluate(([fx, fy]) => {
  const c = document.querySelector<HTMLCanvasElement>('#cv-pgm')!;
  const d = c.getContext('2d')!.getImageData(c.width * fx - 5, c.height * fy - 5, 10, 10).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return [r / n, g / n, b / n].map(Math.round);
}, [fx, fy]);

/** A short WebM made in the page itself, used as a file fixture. */
export async function makeWebm(page: Page, ms = 1200, hue = 120): Promise<Buffer> {
  const b64 = await page.evaluate(async ([ms, hue]) => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const ctx = c.getContext('2d')!;
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const t0 = performance.now();
    const draw = () => {
      ctx.fillStyle = `hsl(${hue} 70% ${30 + ((performance.now() - t0) / ms) * 40}%)`;
      ctx.fillRect(0, 0, 320, 180);
      if (rec.state === 'recording') requestAnimationFrame(draw);
    };
    rec.start();
    draw();
    await new Promise((r) => setTimeout(r, ms));
    await new Promise<void>((r) => { rec.onstop = () => r(); rec.stop(); });
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  }, [ms, hue]);
  return Buffer.from(b64, 'base64');
}
