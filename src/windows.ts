// Pop-out windows: a clean Program Output (for a second screen or projector)
// and a Multiview of every input. Both are painted from the main render loop.
import type { Scene, Source } from './scene';
import { isVisual } from './scene';
import { drawSource, tk } from './engine';

interface Popup {
  win: Window;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  last: number;
}

let output: Popup | null = null;
let multiview: Popup | null = null;

function open(name: string, title: string, w: number, h: number, size: [number, number]): Popup | null {
  const win = window.open('', name, `popup,width=${w},height=${h}`);
  if (!win) return null;
  const doc = win.document;
  doc.title = title;
  doc.body.innerHTML = '';
  // The popup has no stylesheet of its own: copy the design tokens it needs.
  const style = doc.createElement('style');
  style.textContent = `html,body{margin:0;height:100%;background:${tk('card-ground')};overflow:hidden}
    canvas{display:block;width:100%;height:100%;object-fit:contain}`;
  doc.head.append(style);
  const canvas = doc.createElement('canvas');
  [canvas.width, canvas.height] = size;
  doc.body.append(canvas);
  canvas.addEventListener('dblclick', () => void doc.documentElement.requestFullscreen?.().catch(() => undefined));
  return { win, canvas, ctx: canvas.getContext('2d')!, last: 0 };
}

const alive = (p: Popup | null): p is Popup => !!p && !p.win.closed;

export function openOutput(size: [number, number]): boolean {
  if (alive(output)) {
    output.win.focus();
    return true;
  }
  output = open('webmix-output', 'WebMix — Program Output', 960, 540, size);
  return !!output;
}

export function openMultiview(): boolean {
  if (alive(multiview)) {
    multiview.win.focus();
    return true;
  }
  multiview = open('webmix-multiview', 'WebMix — Multiview', 1280, 720, [1920, 1080]);
  return !!multiview;
}

export const outputOpen = () => alive(output);
export const multiviewOpen = () => alive(multiview);

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, tone: 'pgm' | 'pvw' | null): void {
  const h = 34;
  ctx.fillStyle = tone === 'pgm' ? tk('pgm-fill') : tone === 'pvw' ? tk('pvw-fill') : tk('panel');
  ctx.globalAlpha = tone ? 1 : 0.85;
  ctx.fillRect(x, y - h, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = tone ? tk('on-accent') : tk('text');
  ctx.font = `600 20px ${tk('font-sans')}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 12, y - h / 2, w - 24);
}

function frame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tone: 'pgm' | 'pvw' | null): void {
  ctx.strokeStyle = tone === 'pgm' ? tk('pgm') : tone === 'pvw' ? tk('pvw') : tk('line-2');
  ctx.lineWidth = tone ? 6 : 2;
  ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
}

/** Called once per animation frame from the main loop. */
export function paintWindows(pgm: HTMLCanvasElement, pvw: HTMLCanvasElement, scene: Scene, now: number): void {
  if (alive(output)) {
    const { canvas, ctx } = output;
    if (canvas.width !== pgm.width || canvas.height !== pgm.height) {
      canvas.width = pgm.width;
      canvas.height = pgm.height;
    }
    ctx.drawImage(pgm, 0, 0);
  } else output = null;

  if (alive(multiview)) {
    const mv = multiview;
    const { ctx } = mv;
    const W = 1920, H = 1080, g = 8;
    // top row: PVW | PGM, every frame
    const bw = (W - g * 3) / 2, bh = bw * 9 / 16;
    ctx.fillStyle = tk('bg');
    ctx.fillRect(0, 0, W, g * 2 + bh);
    ctx.drawImage(pvw, g, g, bw, bh);
    frame(ctx, g, g, bw, bh, 'pvw');
    label(ctx, 'PREVIEW', g, g + bh, bw, 'pvw');
    ctx.drawImage(pgm, g * 2 + bw, g, bw, bh);
    frame(ctx, g * 2 + bw, g, bw, bh, 'pgm');
    label(ctx, 'PROGRAM', g * 2 + bw, g + bh, bw, 'pgm');
    // bottom: up to 8 inputs, refreshed ~12 fps
    if (now - mv.last > 80) {
      mv.last = now;
      const inputs: Source[] = scene.sources.filter((s) => isVisual(s.kind)).slice(0, 8);
      const top = g * 2 + bh;
      const ch = Math.min(((W - g * 5) / 4) * 9 / 16, (H - top - g * 2) / 2), cw = ch * 16 / 9;
      ctx.fillStyle = tk('bg');
      ctx.fillRect(0, top, W, H - top);
      for (let i = 0; i < 8; i++) {
        const x = (W - cw * 4 - g * 3) / 2 + (i % 4) * (cw + g), y = top + Math.floor(i / 4) * (ch + g);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cw, ch);
        ctx.clip();
        ctx.fillStyle = tk('card-ground');
        ctx.fillRect(x, y, cw, ch);
        const s = inputs[i];
        if (s) {
          ctx.translate(x, y);
          drawSource(ctx, s, cw, ch);
        }
        ctx.restore();
        const tone = s && (scene.pgm === s.id || scene.overlays.some((o) => o.on && o.src === s.id)) ? 'pgm' : s && scene.pvw === s.id ? 'pvw' : null;
        frame(ctx, x, y, cw, ch, tone);
        if (s) label(ctx, `${i + 1}  ${s.name}`, x, y + ch, cw, tone);
      }
    }
  } else multiview = null;
}

export function closeWindows(): void {
  output?.win.close();
  multiview?.win.close();
}
