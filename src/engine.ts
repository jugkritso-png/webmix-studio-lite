// Media, canvas compositing, audio mixing and recording.
// Every colour drawn on a canvas is read from the design tokens (tokens.css).
import type { Scene, Source, Tone } from './scene';

export interface Media {
  el?: HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
  stream?: MediaStream;
  url?: string;
  input?: AudioNode;
  gain?: GainNode;
  analyser?: AnalyserNode;
  lastGain?: number;
  /** playlist files and the one now loaded */
  list?: { url: string; name: string }[];
  index?: number;
}

export const media = new Map<string, Media>();

/* ---------- tokens ---------- */

const tokenCache = new Map<string, string>();
export function tk(name: string): string {
  let v = tokenCache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    tokenCache.set(name, v);
  }
  return v;
}

const font = (weight: number, px: number, family = 'font-sans') => `${weight} ${Math.round(px)}px ${tk(family)}`;

const TONES: Record<Tone, [bg: string, fg: string]> = {
  accent: ['accent', 'on-accent'],
  panel: ['panel', 'text'],
  amber: ['amber', 'on-amber'],
};

/* ---------- media elements ---------- */

let pool: HTMLElement | null = null;
function mediaPool(): HTMLElement {
  if (!pool) {
    pool = document.createElement('div');
    pool.className = 'media-pool';
    pool.setAttribute('aria-hidden', 'true');
    document.body.append(pool);
  }
  return pool;
}

export function videoForStream(stream: MediaStream): HTMLVideoElement {
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.autoplay = true;
  el.srcObject = stream;
  mediaPool().append(el);
  void el.play().catch(() => undefined);
  return el;
}

export function videoForUrl(url: string): HTMLVideoElement {
  const el = document.createElement('video');
  el.src = url;
  el.loop = true;
  el.playsInline = true;
  el.crossOrigin = 'anonymous';
  mediaPool().append(el);
  void el.play().catch(() => undefined);
  return el;
}

export function audioForUrl(url: string): HTMLAudioElement {
  const el = document.createElement('audio');
  el.src = url;
  el.loop = true;
  mediaPool().append(el);
  void el.play().catch(() => undefined);
  return el;
}

export function imageFor(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  return img;
}

export function release(id: string): void {
  const m = media.get(id);
  if (!m) return;
  m.stream?.getTracks().forEach((t) => t.stop());
  if (m.el instanceof HTMLMediaElement) {
    m.el.pause();
    m.el.srcObject = null;
    m.el.removeAttribute('src');
    m.el.remove();
  }
  if (m.url) URL.revokeObjectURL(m.url);
  m.list?.forEach((f) => URL.revokeObjectURL(f.url));
  try {
    m.input?.disconnect();
    m.gain?.disconnect();
  } catch { /* already disconnected */ }
  media.delete(id);
}

function ready(el: Media['el']): el is HTMLVideoElement | HTMLImageElement {
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 && el.videoWidth > 0;
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0;
  return false;
}

/* ---------- audio ---------- */

let ac: AudioContext | null = null;
let masterGain: GainNode;
let monitorGain: GainNode;
let masterAnalyser: AnalyserNode;
let recDest: MediaStreamAudioDestinationNode;

export function ensureAudio(): AudioContext {
  if (!ac) {
    ac = new AudioContext();
    masterGain = ac.createGain();
    monitorGain = ac.createGain();
    monitorGain.gain.value = 0;
    masterAnalyser = ac.createAnalyser();
    masterAnalyser.fftSize = 1024;
    recDest = ac.createMediaStreamDestination();
    masterGain.connect(masterAnalyser);
    masterGain.connect(recDest);
    masterGain.connect(monitorGain).connect(ac.destination);
  }
  if (ac.state === 'suspended') void ac.resume();
  return ac;
}

function wire(m: Media, node: AudioNode): void {
  const ctx = ensureAudio();
  const g = ctx.createGain();
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  node.connect(g);
  g.connect(an);
  g.connect(masterGain);
  m.input = node;
  m.gain = g;
  m.analyser = an;
}

export function attachStreamAudio(m: Media, stream: MediaStream): void {
  if (!stream.getAudioTracks().length) return;
  wire(m, ensureAudio().createMediaStreamSource(stream));
}

export function attachElementAudio(m: Media, el: HTMLMediaElement): void {
  wire(m, ensureAudio().createMediaElementSource(el));
}

const buf = new Float32Array(1024);
export function level(an?: AnalyserNode): number {
  if (!an) return 0;
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

export const masterLevel = () => (ac ? level(masterAnalyser) : 0);

export function updateGains(scene: Scene, onAir: (id: string) => boolean): void {
  if (!ac) return;
  const now = ac.currentTime;
  for (const s of scene.sources) {
    const m = media.get(s.id);
    if (!m?.gain) continue;
    const p = s.props;
    const target = p.muted ? 0 : p.volume * (p.afv && !onAir(s.id) ? 0 : 1);
    if (m.lastGain !== target) {
      m.gain.gain.setTargetAtTime(target, now, 0.03);
      m.lastGain = target;
    }
  }
  masterGain.gain.setTargetAtTime(scene.master, now, 0.03);
  monitorGain.gain.setTargetAtTime(scene.monitor ? 1 : 0, now, 0.03);
}

/* ---------- drawing ---------- */

function placeholder(ctx: CanvasRenderingContext2D, s: Source, W: number, H: number): void {
  const u = H / 720;
  ctx.fillStyle = tk('panel-2');
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = tk('muted');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(700, 40 * u);
  ctx.fillText(s.name, W / 2, H / 2 - 28 * u);
  ctx.font = font(500, 28 * u);
  ctx.fillText('ไม่มีสัญญาณ · กดเชื่อมต่อใหม่ในแผงปรับค่า', W / 2, H / 2 + 28 * u);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  // Thai has no spaces between words, so fall back to per-character breaking.
  const parts = text.includes(' ') ? text.split(/(\s+)/) : Array.from(text);
  const lines: string[] = [];
  let line = '';
  for (const p of parts) {
    const next = line + p;
    if (ctx.measureText(next).width > maxW && line.trim()) {
      lines.push(line.trim());
      line = p.trimStart();
    } else line = next;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 3);
}

function drawText(ctx: CanvasRenderingContext2D, s: Source, W: number, H: number): void {
  const p = s.props;
  const u = H / 720;
  const [bgTok, fgTok] = TONES[p.tone] ?? TONES.accent;
  const title = p.title || s.name;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  if (p.style === 'lower') {
    const pad = 24 * u, ts = 40 * u, ss = 26 * u;
    ctx.font = font(700, ts);
    const tw = ctx.measureText(title).width;
    ctx.font = font(500, ss);
    const sw = p.sub ? ctx.measureText(p.sub).width : 0;
    const bw = Math.min(W - 128 * u, Math.max(tw, sw) + pad * 2);
    const bh = pad * 2 + ts * 1.2 + (p.sub ? ss * 1.4 : 0);
    const x = 64 * u, y = H - 64 * u - bh;
    ctx.fillStyle = tk(bgTok);
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 8 * u);
    ctx.fill();
    ctx.fillStyle = tk(fgTok);
    ctx.font = font(700, ts);
    ctx.fillText(title, x + pad, y + pad, bw - pad * 2);
    if (p.sub) {
      ctx.font = font(500, ss);
      ctx.fillText(p.sub, x + pad, y + pad + ts * 1.3, bw - pad * 2);
    }
  } else if (p.style === 'title') {
    const ts = 72 * u, ss = 32 * u, pad = 32 * u;
    ctx.font = font(700, ts);
    const tw = ctx.measureText(title).width;
    ctx.font = font(500, ss);
    const sw = p.sub ? ctx.measureText(p.sub).width : 0;
    const bw = Math.min(W - 96 * u, Math.max(tw, sw) + pad * 2);
    const bh = pad * 2 + ts * 1.2 + (p.sub ? ss * 1.5 : 0);
    const x = (W - bw) / 2, y = (H - bh) / 2;
    ctx.fillStyle = tk(bgTok);
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 12 * u);
    ctx.fill();
    ctx.fillStyle = tk(fgTok);
    ctx.textAlign = 'center';
    ctx.font = font(700, ts);
    ctx.fillText(title, W / 2, y + pad, bw - pad * 2);
    if (p.sub) {
      ctx.font = font(500, ss);
      ctx.fillText(p.sub, W / 2, y + pad + ts * 1.3, bw - pad * 2);
    }
  } else if (p.style === 'slate') {
    ctx.fillStyle = tk(p.tone === 'panel' ? 'card-ground' : bgTok);
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = tk(p.tone === 'panel' ? 'text' : fgTok);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(700, 84 * u);
    ctx.fillText(title, W / 2, H / 2 - (p.sub ? 40 * u : 0), W - 128 * u);
    if (p.sub) {
      ctx.fillStyle = tk(p.tone === 'panel' ? 'muted' : fgTok);
      ctx.font = font(500, 40 * u);
      ctx.fillText(p.sub, W / 2, H / 2 + 60 * u, W - 128 * u);
    }
  } else if (p.style === 'corner') {
    const ts = 28 * u, padX = 20 * u, padY = 10 * u;
    ctx.font = font(700, ts);
    const bw = ctx.measureText(title).width + padX * 2;
    const bh = ts * 1.2 + padY * 2;
    const x = W - 40 * u - bw, y = 40 * u;
    ctx.fillStyle = tk(bgTok);
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, bh / 2);
    ctx.fill();
    ctx.fillStyle = tk(fgTok);
    ctx.fillText(title, x + padX, y + padY);
  } else {
    // comment card: author (sub) over the message (title)
    const pad = 24 * u, as = 26 * u, ms = 32 * u, bw = Math.min(W - 128 * u, 720 * u);
    ctx.font = font(500, ms);
    const lines = wrap(ctx, title, bw - pad * 2);
    const bh = pad * 2 + (p.sub ? as * 1.5 : 0) + lines.length * ms * 1.35;
    const x = 64 * u, y = H - 64 * u - bh;
    ctx.fillStyle = tk(p.tone === 'panel' ? 'panel-2' : bgTok);
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 12 * u);
    ctx.fill();
    let ty = y + pad;
    if (p.sub) {
      ctx.fillStyle = tk(p.tone === 'panel' ? 'accent-text' : fgTok);
      ctx.font = font(700, as);
      ctx.fillText(p.sub, x + pad, ty, bw - pad * 2);
      ty += as * 1.5;
    }
    ctx.fillStyle = tk(fgTok);
    ctx.font = font(500, ms);
    for (const l of lines) {
      ctx.fillText(l, x + pad, ty, bw - pad * 2);
      ty += ms * 1.35;
    }
  }
}

// SMPTE-style 75% colour bars: a broadcast test signal, not a design colour. test-signal
const BARS = ['rgb(191,191,191)', 'rgb(191,191,0)', 'rgb(0,191,191)', 'rgb(0,191,0)', 'rgb(191,0,191)', 'rgb(191,0,0)', 'rgb(0,0,191)']; // test-signal
const BARS_LOW = ['rgb(0,0,191)', 'rgb(19,19,19)', 'rgb(191,0,191)', 'rgb(19,19,19)', 'rgb(0,191,191)', 'rgb(19,19,19)', 'rgb(191,191,191)']; // test-signal

function drawBars(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const bw = W / 7;
  BARS.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.floor(i * bw), 0, Math.ceil(bw), H * 0.67);
    ctx.fillStyle = BARS_LOW[i];
    ctx.fillRect(Math.floor(i * bw), H * 0.67, Math.ceil(bw), H * 0.08);
  });
  ctx.fillStyle = tk('card-ground');
  ctx.fillRect(0, H * 0.75, W, H * 0.25);
  ctx.fillStyle = tk('text');
  ctx.fillRect(W * 0.14, H * 0.75, W * 0.14, H * 0.25);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function drawClock(ctx: CanvasRenderingContext2D, s: Source, W: number, H: number): void {
  const u = H / 720;
  const d = new Date();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  ctx.fillStyle = tk('card-ground');
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = tk('text');
  ctx.font = font(700, 160 * u, 'font-mono');
  ctx.fillText(time, W / 2, H / 2 - 20 * u);
  ctx.fillStyle = tk('muted');
  ctx.font = font(500, 40 * u);
  ctx.fillText(s.props.sub || d.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), W / 2, H / 2 + 110 * u);
}

export function drawSource(ctx: CanvasRenderingContext2D, s: Source, W: number, H: number): void {
  const p = s.props;
  ctx.save();
  ctx.globalAlpha *= p.opacity;
  if (p.filter) ctx.filter = p.filter;
  const cx = W / 2 + (p.x * W) / 2;
  const cy = H / 2 + (p.y * H) / 2;

  if (s.kind === 'color') {
    ctx.fillStyle = p.color || tk('accent-soft');
    ctx.fillRect(0, 0, W, H);
  } else if (s.kind === 'bars') {
    drawBars(ctx, W, H);
  } else if (s.kind === 'clock') {
    drawClock(ctx, s, W, H);
  } else if (s.kind === 'text') {
    ctx.translate(cx, cy);
    ctx.scale(p.scale * (p.flip ? -1 : 1), p.scale);
    ctx.translate(-W / 2, -H / 2);
    drawText(ctx, s, W, H);
  } else {
    const el = media.get(s.id)?.el;
    if (!ready(el)) {
      placeholder(ctx, s, W, H);
    } else {
      const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
      const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      const fit = p.fit === 'cover' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
      const dw = w * fit * p.scale;
      const dh = h * fit * p.scale;
      ctx.translate(cx, cy);
      if (p.flip) ctx.scale(-1, 1);
      ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh);
    }
  }
  ctx.restore();
}

export interface TransitionState {
  from: string | null;
  to: string;
  start: number;
  dur: number;
  type: 'mix' | 'dip' | 'wipe';
  /** T-Bar position 0..1 while the operator drives it by hand */
  manual?: number;
}

export function transitionProgress(trans: TransitionState, now: number): number {
  return trans.manual ?? Math.min(1, Math.max(0, (now - trans.start) / trans.dur));
}

function bus(ctx: CanvasRenderingContext2D, scene: Scene, id: string | null, W: number, H: number): void {
  const s = id ? scene.sources.find((x) => x.id === id) : undefined;
  if (s) drawSource(ctx, s, W, H);
}

/** Draws one output bus; `trans` blends PGM towards the incoming source. */
export function drawBus(
  ctx: CanvasRenderingContext2D, scene: Scene, id: string | null,
  trans: TransitionState | null, now: number, fade = 0,
): void {
  const { width: W, height: H } = ctx.canvas;
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = tk('card-ground');
  ctx.fillRect(0, 0, W, H);

  if (trans) {
    const t = transitionProgress(trans, now);
    const e = trans.manual !== undefined ? t : t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    if (trans.type === 'dip') {
      // through black: out over the first half, in over the second
      bus(ctx, scene, e < 0.5 ? trans.from : trans.to, W, H);
      ctx.globalAlpha = 1 - Math.abs(e - 0.5) * 2;
      ctx.fillStyle = tk('card-ground');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    } else if (trans.type === 'mix') {
      bus(ctx, scene, trans.from, W, H);
      ctx.globalAlpha = e;
      bus(ctx, scene, trans.to, W, H);
      ctx.globalAlpha = 1;
    } else {
      bus(ctx, scene, trans.from, W, H);
      const edge = W * e;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, edge, H);
      ctx.clip();
      ctx.fillStyle = tk('card-ground');
      ctx.fillRect(0, 0, edge, H);
      bus(ctx, scene, trans.to, W, H);
      ctx.restore();
    }
  } else {
    bus(ctx, scene, id, W, H);
  }

  const shown = new Set([id, trans?.from, trans?.to]);
  for (const s of scene.sources) {
    if (s.props.overlay && !shown.has(s.id)) drawSource(ctx, s, W, H);
  }

  if (fade > 0) {
    ctx.globalAlpha = fade;
    ctx.fillStyle = tk('card-ground');
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }
}

/* ---------- recording ---------- */

function pickMime(): string {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export class Recorder {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  readonly started = performance.now();

  constructor(canvas: HTMLCanvasElement, fps = 30) {
    ensureAudio();
    const video = canvas.captureStream(fps);
    const px = canvas.width * canvas.height;
    const bitrate = Math.round((px >= 3840 * 2160 ? 35e6 : px >= 1920 * 1080 ? 10e6 : 6e6) * (fps > 30 ? 1.5 : 1));
    const stream = new MediaStream([...video.getVideoTracks(), ...recDest.stream.getAudioTracks()]);
    const mimeType = pickMime();
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: bitrate } : undefined);
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(1000);
  }

  get mime(): string {
    return this.rec.mimeType || 'video/webm';
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.mime }));
      this.rec.stop();
    });
  }
}
