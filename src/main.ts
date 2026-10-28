import '../design/components/bundle.css';
import '../design/tokens.css';
import './app.css';
import { icon, logo, type IconName } from './icons';
import {
  clone, defaultProps, isVisual, loadPresets, loadScene, needsMedia, OUTPUT_SIZE, OVERLAY_FX, saveScene, savePresets, uid,
  type Kind, type OverlayFx, type Props, type Resolution, type Scene, type Source, type TextStyle,
} from './scene';
import { fetchRows, REFRESH_MS } from './data';
import { getFiles, pruneFiles, putFiles, type StoredFile } from './filestore';
import {
  attachElementAudio, attachStreamAudio, bar, canPickOutput, dropMixMinus, ensureAudio, limiterReduction, loudness, masterMeter, meter,
  mixMinus, outputDevices, releaseStrip, resetLoudness, setOutputDevice, updateAudio,
} from './audio';
import qrcode from 'qrcode-generator';
import { createLivePanel } from './livepanel';
import { signalFromGateway, signalFromLocation, Studio, type Caller, type RemoteKind } from './remote';
import type { Platform } from './stream';
import { Recorder } from './recorder';
import {
  audioForUrl, drawBus, drawSource, imageFor,
  media, release, tk, videoForStream, videoForUrl,
  fmtClock, timerValue, transitionProgress, type Layer, type Media, type TransitionState,
} from './engine';
import { multiviewOpen, openMultiview, openOutput, outputOpen, paintWindows } from './windows';

/* ================= state ================= */

type Cat = 'source' | 'audio' | 'graphic' | 'text' | 'comment' | 'effect' | 'live';
type Target = 'pvw' | 'pgm' | 'strip';

const CATS: { id: Cat; label: string; icon: IconName; search: string; filters: string[]; add: string }[] = [
  { id: 'source', label: 'แหล่งภาพ', icon: 'source', search: 'ค้นหากล้อง, หน้าจอ, ไฟล์', filters: ['ทั้งหมด', 'กล้อง', 'หน้าจอ', 'ไฟล์', 'สัญญาณ'], add: 'เพิ่มแหล่งภาพ' },
  { id: 'audio', label: 'เสียง', icon: 'audio', search: 'ค้นหาไมค์, ไฟล์เสียง', filters: ['ทั้งหมด', 'ไมค์', 'ไฟล์'], add: 'เพิ่มเสียง' },
  { id: 'graphic', label: 'กราฟิก', icon: 'graphic', search: 'ค้นหากราฟิก', filters: ['ทั้งหมด', 'ข้อความ', 'รูป', 'ข้อมูล'], add: 'เพิ่มรูปซ้อน' },
  { id: 'text', label: 'ข้อความ', icon: 'text', search: 'ค้นหาแบบข้อความ', filters: ['ทั้งหมด'], add: 'เพิ่มข้อความ' },
  { id: 'comment', label: 'คอมเมนต์', icon: 'comment', search: 'ค้นหาแบบคอมเมนต์', filters: ['ทั้งหมด'], add: 'เพิ่มคอมเมนต์' },
  { id: 'effect', label: 'เอฟเฟกต์', icon: 'effect', search: 'ค้นหาเอฟเฟกต์', filters: ['ทั้งหมด', 'สี', 'ภาพ'], add: 'ล้างเอฟเฟกต์' },
  { id: 'live', label: 'ไลฟ์', icon: 'live', search: 'ค้นหาปลายทาง', filters: ['ทั้งหมด'], add: 'ตั้งค่าปลายทาง' },
];

let scene: Scene = loadScene();
const ui = {
  cat: 'source' as Cat,
  filter: {} as Partial<Record<Cat, string>>,
  query: '',
  selected: null as string | null,
  tab: '',
  advanced: false,
  galleryOpen: false,
  inspOpen: false,
  recorder: null as Recorder | null,
  cameras: [] as MediaDeviceInfo[],
  mics: [] as MediaDeviceInfo[],
  outputs: [] as MediaDeviceInfo[],
};
let trans: TransitionState | null = null;
/** fade to black: target 0/1, level eases towards it */
const ftb = { target: 0, level: 0 };
/** T-Bar rests at 0 or 100; the next pull travels to the other end */
let tbarBase = 0;
/** overlay channel animations in flight */
const ovlAnim: ({ start: number; dir: 'in' | 'out' } | null)[] = Array(8).fill(null);
/** rows fetched for sources with a data link */
const dataState = new Map<string, { rows: string[][]; error: string; at: number; loading: boolean; url: string }>();

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const byId = (id: string | null) => (id ? scene.sources.find((s) => s.id === id) : undefined);
const visuals = () => scene.sources.filter((s) => isVisual(s.kind));
const cutSources = () => visuals();
/** overlay channel a source sits on, or -1 */
const chOf = (id: string | null) => (id ? scene.overlays.findIndex((o) => o.src === id) : -1);
const isGraphic = (id: string | null) => chOf(id) >= 0;
const ovlOn = (id: string | null) => {
  const i = chOf(id);
  return i >= 0 && scene.overlays[i].on;
};

/** channel for a new graphic: its own, else the first free, else the last */
function freeChannel(sc: Scene, id?: string): number {
  const own = id ? sc.overlays.findIndex((o) => o.src === id) : -1;
  if (own >= 0) return own;
  const free = sc.overlays.findIndex((o) => !o.src);
  return free >= 0 ? free : sc.overlays.length - 1;
}

function setOverlay(i: number, on: boolean): void {
  const o = scene.overlays[i];
  if (!o?.src || o.on === on) return;
  o.on = on;
  ovlAnim[i] = o.fx === 'cut' || o.dur <= 0 ? null : { start: performance.now(), dir: on ? 'in' : 'out' };
  changed(false);
  renderOverlayRow();
  if (ui.selected === o.src) renderInspector();
}

/** what Preview shows: everything on air plus channels cued for checking */
function previewLayers(onAir: Layer[]): Layer[] {
  const out: Layer[] = [];
  for (const o of scene.overlays) {
    const source = byId(o.src);
    if (!source) continue;
    const live = onAir.find((l) => l.source.id === source.id);
    if (live) out.push(live);
    else if (o.cue) out.push({ source, fx: 'cut', e: 1 });
  }
  return out;
}

function layers(now: number): Layer[] {
  const out: Layer[] = [];
  scene.overlays.forEach((o, i) => {
    const source = byId(o.src);
    if (!source) return;
    let e = o.on ? 1 : 0;
    const a = ovlAnim[i];
    if (a) {
      const t = Math.min(1, (now - a.start) / Math.max(1, o.dur));
      e = a.dir === 'in' ? t : 1 - t;
      if (t >= 1) ovlAnim[i] = null;
    }
    if (e > 0) out.push({ source, fx: o.fx, e });
  });
  return out;
}

/* ================= undo / persistence ================= */

const undoStack: string[] = [];
const redoStack: string[] = [];
let lastCoalesce = { key: '', t: 0 };

interface MutateOpts { coalesce?: string; silent?: boolean; toast?: string }

function mutate(fn: (s: Scene) => void, opts: MutateOpts = {}): void {
  const now = Date.now();
  const merge = opts.coalesce && lastCoalesce.key === opts.coalesce && now - lastCoalesce.t < 1500;
  if (!merge) {
    undoStack.push(JSON.stringify(scene));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }
  lastCoalesce = { key: opts.coalesce ?? '', t: now };
  fn(scene);
  changed(!opts.silent);
  if (opts.toast) toast(opts.toast, { label: 'ย้อนกลับ', run: undo });
}

function restore(raw: string): void {
  const next = JSON.parse(raw) as Scene;
  // switching is live: keep what is on air unless that source no longer exists
  const ids = new Set(next.sources.map((s) => s.id));
  if (scene.pgm && ids.has(scene.pgm)) next.pgm = scene.pgm;
  if (scene.pvw && ids.has(scene.pvw)) next.pvw = scene.pvw;
  if (next.pgm && !ids.has(next.pgm)) next.pgm = null;
  if (next.pvw && !ids.has(next.pvw)) next.pvw = null;
  // overlays that are on air stay on air across undo
  next.overlays.forEach((o, i) => {
    const cur = scene.overlays[i];
    o.on = !!(o.src && cur?.src === o.src && cur.on);
  });
  scene = next;
  if (ui.selected && !ids.has(ui.selected)) ui.selected = null;
  trans = null;
  for (const s of scene.sources) ensureMedia(s, false);
  lastCoalesce = { key: '', t: 0 };
  changed(true);
}

function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return toast('ไม่มีอะไรให้ย้อนกลับ');
  redoStack.push(JSON.stringify(scene));
  restore(prev);
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return toast('ไม่มีอะไรให้ทำซ้ำ');
  undoStack.push(JSON.stringify(scene));
  restore(next);
}

let saveTimer = 0;
function changed(full: boolean): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (!saveScene(scene)) toast('บันทึกฉากไม่ได้ พื้นที่เบราว์เซอร์เต็ม ลองลบรูปขนาดใหญ่ออก');
  }, 300);
  if (full) renderAll();
  else {
    renderStrip();
    renderTally();
    renderUndo();
  }
  resizeOutput();
}

/* ================= media acquisition ================= */

function mediaError(err: unknown, what: string): void {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'AbortError') return;
  if (name === 'NotAllowedError') toast(`เบราว์เซอร์ไม่ได้อนุญาต${what} เปิดสิทธิ์ที่ไอคอนข้างแถบที่อยู่ แล้วลองอีกครั้ง`);
  else if (name === 'NotFoundError' || name === 'OverconstrainedError') toast(`ไม่พบ${what} ต่ออุปกรณ์แล้วลองอีกครั้ง`);
  else if (name === 'NotReadableError') toast(`${what}ถูกโปรแกรมอื่นใช้อยู่ ปิดโปรแกรมนั้นแล้วลองอีกครั้ง`);
  else toast(`เปิด${what}ไม่ได้ ลองใช้ Chrome หรือ Edge รุ่นล่าสุดผ่าน https`);
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

const readDataUrl = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});

async function refreshDevices(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    ui.cameras = all.filter((d) => d.kind === 'videoinput' && d.label);
    ui.mics = all.filter((d) => d.kind === 'audioinput' && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications');
    ui.outputs = (await outputDevices()).filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
    if (ui.cat === 'source' || ui.cat === 'audio') renderGalleryGrid();
  } catch { /* enumerateDevices unavailable */ }
}

interface Acquired { m: Media; meta: string; name?: string; dataUrl?: string; files?: File[] }

const ext = (name: string, fallback: string) => name.split('.').pop()?.toUpperCase() ?? fallback;

/** players for picked or stored files: one video / audio element, or a playlist over several files */
function fileMedia(kind: Kind, files: { name: string; blob: Blob }[]): Media {
  if (kind === 'playlist') {
    const list = files.map((f) => ({ url: URL.createObjectURL(f.blob), name: f.name }));
    const el = videoForUrl(list[0].url);
    const m: Media = { el, list, index: 0 };
    attachElementAudio(m, el);
    return m;
  }
  const url = URL.createObjectURL(files[0].blob);
  if (kind === 'image') return { el: imageFor(url), url };
  const el = kind === 'audio' ? audioForUrl(url) : videoForUrl(url);
  const m: Media = { el, url };
  attachElementAudio(m, el);
  return m;
}

const CAPTURE: Record<Resolution, { width: { ideal: number }; height: { ideal: number } }> = {
  '720p': { width: { ideal: 1280 }, height: { ideal: 720 } },
  '1080p': { width: { ideal: 1920 }, height: { ideal: 1080 } },
  '2160p': { width: { ideal: 3840 }, height: { ideal: 2160 } },
};

async function acquire(kind: Kind, deviceId?: string, res: Resolution = '1080p'): Promise<Acquired | null> {
  const md = navigator.mediaDevices;
  switch (kind) {
    case 'camera': {
      if (!md?.getUserMedia) throw new DOMException('', 'NotSupportedError');
      const size = CAPTURE[res];
      const stream = await md.getUserMedia({ video: deviceId ? { ...size, deviceId: { exact: deviceId } } : size, audio: false });
      const st = stream.getVideoTracks()[0]?.getSettings() ?? {};
      void refreshDevices();
      return { m: { stream, el: videoForStream(stream) }, meta: st.width ? `${st.width}×${st.height}` : 'กล้อง' };
    }
    case 'screen': {
      if (!md?.getDisplayMedia) throw new DOMException('', 'NotSupportedError');
      const stream = await md.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      const m: Media = { stream, el: videoForStream(stream) };
      attachStreamAudio(m, stream);
      const st = stream.getVideoTracks()[0]?.getSettings() ?? {};
      return { m, meta: st.width ? `${st.width}×${st.height}` : 'หน้าจอ' };
    }
    case 'mic': {
      if (!md?.getUserMedia) throw new DOMException('', 'NotSupportedError');
      const stream = await md.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : { echoCancellation: true }, video: false });
      const m: Media = { stream };
      attachStreamAudio(m, stream);
      void refreshDevices();
      return { m, meta: stream.getAudioTracks()[0]?.label || 'ไมโครโฟน' };
    }
    case 'video': {
      const f = await pickFile('video/*');
      if (!f) return null;
      return { m: fileMedia('video', [{ name: f.name, blob: f }]), meta: ext(f.name, 'VIDEO'), name: f.name, files: [f] };
    }
    case 'playlist': {
      const files = await pickFiles('video/*');
      if (!files.length) return null;
      return { m: fileMedia('playlist', files.map((f) => ({ name: f.name, blob: f }))), meta: `${files.length} ไฟล์`, files };
    }
    case 'audio': {
      const f = await pickFile('audio/*');
      if (!f) return null;
      return { m: fileMedia('audio', [{ name: f.name, blob: f }]), meta: ext(f.name, 'AUDIO'), name: f.name, files: [f] };
    }
    case 'image': {
      const f = await pickFile('image/*');
      if (!f) return null;
      const dataUrl = await readDataUrl(f);
      // small pictures ride inside the saved show; big ones are kept as file copies
      return { m: { el: imageFor(dataUrl) }, meta: ext(f.name, 'IMG'), name: f.name, dataUrl, files: dataUrl.length >= 1_500_000 ? [f] : undefined };
    }
    default:
      return null;
  }
}

const WHAT: Partial<Record<Kind, string>> = { camera: 'กล้อง', screen: 'การแชร์หน้าจอ', mic: 'ไมโครโฟน', video: 'ไฟล์วิดีโอ', playlist: 'เพลย์ลิสต์', audio: 'ไฟล์เสียง', image: 'รูปภาพ' };

/** Wire file playback: loop flag, playlists advancing, and a clear message when a file will not play. */
function wirePlayback(id: string, m: Media): void {
  const el = m.el;
  if (!(el instanceof HTMLMediaElement)) return;
  const s = byId(id);
  el.loop = !m.list && (s?.props.loop ?? false);
  el.addEventListener('ended', () => {
    const src = byId(id);
    if (!m.list || !src) return;
    const next = (m.index ?? 0) + 1;
    if (next >= m.list.length && !src.props.loop) return;
    playlistGo(id, next % m.list.length);
  });
  el.addEventListener('timeupdate', () => {
    if (ui.selected === id && ui.tab === 'เล่น') renderTransport();
  });
  el.addEventListener('error', () => {
    const src = byId(id);
    const name = m.list?.[m.index ?? 0]?.name ?? src?.name ?? 'ไฟล์นี้';
    toast(`เล่น ${name} ไม่ได้ เบราว์เซอร์อาจไม่รองรับรูปแบบไฟล์ ลองแปลงเป็น MP4 (H.264) หรือ WebM`);
    if (src) {
      src.meta = 'เล่นไม่ได้';
      renderStrip();
    }
  });
}

/** rebuild a file source from the browser's stored copy after a reload or an undo */
async function restoreFiles(s: Source): Promise<boolean> {
  const files: StoredFile[] | null = await getFiles(s.id);
  if (!files?.length || media.has(s.id) || !byId(s.id)) return false;
  const m = fileMedia(s.kind, files);
  media.set(s.id, m);
  wirePlayback(s.id, m);
  renderStrip();
  if (ui.selected === s.id) renderInspector();
  return true;
}

/** play / pause file sources as they go on and off air */
const wasOnAir = new Map<string, boolean>();
function followAir(): void {
  for (const s of scene.sources) {
    if (s.kind !== 'video' && s.kind !== 'playlist') continue;
    const el = media.get(s.id)?.el;
    if (!(el instanceof HTMLVideoElement)) continue;
    const air = onAir(s.id);
    if (wasOnAir.get(s.id) === air) continue;
    wasOnAir.set(s.id, air);
    if (!s.props.autoPlay) continue;
    if (air) {
      if (s.props.restartOnAir || el.ended) {
        if (s.kind === 'playlist' && s.props.restartOnAir) playlistGo(s.id, 0);
        el.currentTime = 0;
      }
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
    if (ui.selected === s.id && ui.tab === 'เล่น') renderInspector();
  }
}

const fmtShort = (sec: number) => fmtTime(Math.max(0, sec) * 1000).replace(/^00:/, '');

/** what a file card says under its name: playing / paused, time left */
function playbackLine(s: Source): string {
  const el = media.get(s.id)?.el;
  if (!(el instanceof HTMLMediaElement)) return s.meta;
  const d = Number.isFinite(el.duration) ? el.duration : 0;
  if (el.error) return 'เล่นไม่ได้';
  if (el.ended || (d && el.currentTime >= d - 0.05 && el.paused)) return 'จบแล้ว';
  const left = d ? ` −${fmtShort(d - el.currentTime)}` : '';
  const pl = media.get(s.id)?.list ? ` · ${(media.get(s.id)?.index ?? 0) + 1}/${media.get(s.id)!.list!.length}` : '';
  return `${el.paused ? 'หยุด' : 'เล่น'}${left}${pl}`;
}

function playlistGo(id: string, index: number): void {
  const m = media.get(id);
  if (!m?.list || !(m.el instanceof HTMLVideoElement)) return;
  m.index = (index + m.list.length) % m.list.length;
  m.el.src = m.list[m.index].url;
  void m.el.play().catch(() => undefined);
  if (ui.selected === id) renderInspector();
}

function ensureMedia(s: Source, auto: boolean): void {
  if (media.has(s.id)) return;
  if (s.kind === 'image' && s.dataUrl) media.set(s.id, { el: imageFor(s.dataUrl) });
  else if (['video', 'playlist', 'audio', 'image'].includes(s.kind)) void restoreFiles(s);
  else if (auto && (s.kind === 'camera' || s.kind === 'mic')) void autoReconnect(s);
}

async function autoReconnect(s: Source): Promise<void> {
  try {
    const perm = await navigator.permissions?.query({ name: (s.kind === 'camera' ? 'camera' : 'microphone') as PermissionName });
    if (perm?.state !== 'granted') return;
    const got = await acquire(s.kind, s.deviceId, s.props.res).catch(() => acquire(s.kind, undefined, s.props.res));
    if (got && byId(s.id)) media.set(s.id, got.m);
  } catch { /* stays as a placeholder until the user reconnects */ }
}

async function reconnect(id: string): Promise<void> {
  const s = byId(id);
  if (!s) return;
  if (s.kind === 'remote') return openRemote(s.meta === 'แขกทางไกล' ? 'guest' : 'phone', s.name);
  try {
    const got = await acquire(s.kind, s.deviceId, s.props.res).catch((e) => (s.deviceId ? acquire(s.kind, undefined, s.props.res) : Promise.reject(e)));
    if (!got) return;
    free(id);
    media.set(id, got.m);
    wirePlayback(id, got.m);
    if (got.files) void putFiles(id, got.files);
    mutate((sc) => {
      const t = sc.sources.find((x) => x.id === id);
      if (t) {
        t.meta = got.meta;
        if (got.dataUrl) t.dataUrl = got.dataUrl;
      }
    });
    toast(`เชื่อมต่อ ${s.name} แล้ว`);
  } catch (e) {
    mediaError(e, WHAT[s.kind] ?? 'อุปกรณ์');
  }
}

function countOf(kind: Kind): number {
  return scene.sources.filter((s) => s.kind === kind).length + 1;
}

function newSource(kind: Kind, name: string, meta: string, props: Partial<Props> = {}): Source {
  return { id: uid(), kind, name, meta, props: { ...defaultProps(), ...props } };
}

async function addMedia(kind: Kind, label: string, target?: Target, deviceId?: string, extra: Partial<Props> = {}, overlay = false): Promise<void> {
  try {
    if (kind === 'video' || kind === 'audio' || kind === 'screen' || kind === 'mic') ensureAudio();
    const got = await acquire(kind, deviceId);
    if (!got) return;
    const clip = kind === 'video' || kind === 'playlist';
    const s = newSource(kind, got.name ?? `${label} ${countOf(kind)}`, got.meta, { afv: clip, loop: kind === 'audio', ...extra });
    wirePlayback(s.id, got.m);
    if (deviceId) s.deviceId = deviceId;
    if (got.dataUrl) s.dataUrl = got.dataUrl;
    if (got.files) void putFiles(s.id, got.files).then((ok) => !ok && toast('เก็บสำเนาไฟล์ในเบราว์เซอร์ไม่ได้ (พื้นที่เต็ม) หลังเปิดหน้าใหม่ต้องเลือกไฟล์อีกครั้ง'));
    if (kind === 'screen') {
      got.m.stream?.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (byId(s.id)) toast(`หยุดแชร์หน้าจอ ${s.name} แล้ว กดเชื่อมต่อใหม่เพื่อแชร์อีกครั้ง`);
      });
    }
    addSource(s, got.m, target, overlay);
  } catch (e) {
    mediaError(e, WHAT[kind] ?? 'อุปกรณ์');
  }
}

function addSource(s: Source, m: Media | null, target?: Target, overlay = false): void {
  if (m) media.set(s.id, m);
  const ch = overlay ? freeChannel(scene) : -1;
  mutate((sc) => {
    sc.sources.push(s);
    if (overlay) {
      sc.overlays[ch] = { ...sc.overlays[ch], src: s.id, on: false, fx: s.props.style === 'lower' ? 'slide-left' : 'fade' };
      return;
    }
    if (!isVisual(s.kind)) return;
    if (target === 'pgm') sc.pgm = s.id;
    else if (target === 'pvw') sc.pvw = s.id;
    else if (!sc.pgm) sc.pgm = s.id;
    else sc.pvw = s.id;
  }, { toast: overlay ? `เพิ่ม ${s.name} ที่ Overlay ${ch + 1} แล้ว` : `เพิ่ม ${s.name} แล้ว` });
  // a new graphic goes on air straight away, unless it was dropped on Preview
  if (overlay && target !== 'pvw') setOverlay(ch, true);
  select(s.id);
  renderInspector();
  if (dataState.size || s.props.dataUrl) pollData(true);
}

function removeSource(id: string): void {
  const s = byId(id);
  if (!s) return;
  mutate((sc) => {
    sc.sources = sc.sources.filter((x) => x.id !== id);
    sc.overlays.forEach((o) => {
      if (o.src === id) Object.assign(o, { src: null, on: false });
    });
    const rest = sc.sources.filter((x) => isVisual(x.kind) && !sc.overlays.some((o) => o.src === x.id));
    if (sc.pgm === id) sc.pgm = sc.pvw && sc.pvw !== id ? sc.pvw : rest[0]?.id ?? null;
    if (sc.pvw === id || sc.pvw === sc.pgm) sc.pvw = rest.find((x) => x.id !== sc.pgm)?.id ?? null;
  }, { toast: `ลบ ${s.name} แล้ว` });
  if (ui.selected === id) ui.selected = null;
  renderInspector();
  // keep the live media around while undo is likely, then let it go
  window.setTimeout(() => {
    if (!byId(id)) free(id);
  }, 8000);
}

/** let go of a source's live media, audio strip and any guest return feed */
function free(id: string): void {
  const m = media.get(id);
  if (m) releaseStrip(m);
  release(id);
  dropMixMinus(id);
  const s = scene.sources.find((x) => x.id === id);
  if (s?.kind === 'remote' && s.deviceId) studio?.hangUp(s.deviceId);
}

/* ================= switching ================= */

function finishTransition(): void {
  if (!trans) return;
  scene.pgm = trans.to;
  scene.pvw = trans.from ?? trans.to;
  trans = null;
  tbarBase = tbarValue() >= 50 ? 100 : 0;
  changed(false);
  renderTbar();
}

function cut(): void {
  finishTransition();
  if (!scene.pvw || scene.pvw === scene.pgm) return;
  const old = scene.pgm;
  scene.pgm = scene.pvw;
  scene.pvw = old ?? scene.pvw;
  changed(false);
}

function auto(): void {
  const now = performance.now();
  if (trans?.manual !== undefined) {
    // AUTO while the T-Bar is half way: finish the move from where it is
    trans.start = now - trans.manual * trans.dur;
    trans.manual = undefined;
    return;
  }
  if (trans) return finishTransition();
  if (!scene.pvw || scene.pvw === scene.pgm) return;
  trans = { from: scene.pgm, to: scene.pvw, start: now, dur: scene.duration, type: scene.transition };
  renderTally();
}

const tbarValue = () => Number(document.querySelector<HTMLInputElement>('#tbar')?.value ?? 0);

function onTbar(value: number): void {
  const pos = Math.abs(value - tbarBase) / 100;
  if (!trans) {
    if (pos === 0 || !scene.pvw || scene.pvw === scene.pgm) return;
      trans = { from: scene.pgm, to: scene.pvw, start: performance.now(), dur: scene.duration, type: scene.transition, manual: pos };
    renderTally();
  } else if (trans.manual !== undefined) {
    trans.manual = pos;
  }
  if (pos >= 1) {
    finishTransition();
  } else if (pos <= 0 && trans?.manual !== undefined) {
    trans = null; // pulled back to where it started: nothing changes
    renderTally();
  }
}

function renderOverlayRow(): void {
  const row = document.getElementById('ovl-row');
  if (!row) return;
  row.innerHTML = `<span class="tag">OVL</span>${scene.overlays.map((o, i) => {
    const src = byId(o.src);
    return `<button type="button" class="ovl-btn${src ? '' : ' is-empty'}${o.cue && !o.on ? ' is-cued' : ''}" data-act="ovl" data-i="${i}" aria-pressed="${o.on}"
      title="${src ? `${esc(src.name)} · Shift+${i + 1}` : `Overlay ${i + 1} ว่าง แตะเพื่อเลือก`}" aria-label="Overlay ${i + 1}${src ? ` ${esc(src.name)}` : ' ว่าง เลือกสิ่งที่จะซ้อน'}">${i + 1}</button>`;
  }).join('')}`;
}

function renderTbar(): void {
  const t = document.querySelector<HTMLInputElement>('#tbar');
  if (t && trans?.manual === undefined) t.value = String(tbarBase);
}

function toggleFtb(): void {
  ftb.target = ftb.target ? 0 : 1;
  renderChips();
  renderTrans();
  if (!ui.selected) renderInspector();
}

function toPreview(id: string): void {
  const s = byId(id);
  if (!s) return;
  if (isGraphic(id)) {
    select(id);
    renderInspector();
    renderStrip();
    return;
  }
  if (scene.pgm !== id) scene.pvw = id;
  select(id);
  changed(false);
  renderInspector();
}

function select(id: string | null): void {
  if (ui.selected === id) return;
  ui.selected = id;
  ui.tab = '';
  ui.advanced = false;
}

function toggleOverlay(id: string): void {
  const i = chOf(id);
  if (i >= 0) setOverlay(i, !scene.overlays[i].on);
}

/** put a source on an overlay channel (and off the PVW / PGM buses) */
function assignOverlay(id: string, ch?: number): void {
  const s = byId(id);
  if (!s) return;
  const target = ch ?? freeChannel(scene, id);
  mutate((sc) => {
    // the effect settings travel with the graphic
    const old = sc.overlays.find((o) => o.src === id);
    const look = old ? { fx: old.fx, dur: old.dur, cue: old.cue } : {};
    sc.overlays.forEach((o) => {
      if (o.src === id) Object.assign(o, { src: null, on: false });
    });
    sc.overlays[target] = { ...sc.overlays[target], ...look, src: id, on: false };
    // a full-frame camera / video / image becomes a picture-in-picture instead of covering Program
    const t = sc.sources.find((x) => x.id === id);
    const p = t?.props;
    if (t && p && !old && needsMedia(t.kind) && p.scale === 1 && p.x === 0 && p.y === 0 && !p.cropL && !p.cropR && !p.cropT && !p.cropB) {
      Object.assign(p, { scale: 0.32, x: 0.58, y: 0.5, border: p.border || 4 });
    }
  }, { toast: `ย้าย ${s.name} ไป Overlay ${target + 1} แล้ว` });
  mutateBusAfterOverlay(id);
}

function unassignOverlay(id: string): void {
  const s = byId(id);
  if (!s) return;
  mutate((sc) => {
    sc.overlays.forEach((o) => {
      if (o.src === id) Object.assign(o, { src: null, on: false });
    });
  }, { toast: `เอา ${s.name} ออกจาก Overlay แล้ว` });
}

function cutTo(id: string): void {
  const s = byId(id);
  if (!s) return;
  if (isGraphic(id)) return toggleOverlay(id);
  if (scene.pgm === id) return;
  trans = null;
  scene.pvw = id;
  cut();
}

const onAir = (id: string) => scene.pgm === id || trans?.to === id || trans?.from === id || ovlOn(id);

/* ================= gallery catalog ================= */

interface Tile {
  id: string;
  name: string;
  badge: string;
  filter: string;
  ph: 'a' | 'b' | 'c';
  run: (target?: Target) => void | Promise<void>;
  fx?: string;
}

const STYLE_META: Record<TextStyle, string> = { lower: 'Lower third', title: 'หัวเรื่อง', corner: 'ป้ายมุมจอ', comment: 'คอมเมนต์', slate: 'Slate', ticker: 'ตัววิ่ง' };

const textSource = (style: TextStyle, title: string, sub: string, extra: Partial<Props> = {}) =>
  newSource('text', title, STYLE_META[style], { style, title, sub, ...extra });

/** graphics (everything but a full-screen slate) land on an overlay channel */
const addText = (s: Source) => (target?: Target) =>
  addSource({ ...s, id: uid(), props: { ...s.props } }, null, target, s.kind !== 'text' || s.props.style !== 'slate');

const EFFECTS: { id: string; name: string; fx: string; filter: string }[] = [
  { id: 'fx-gray', name: 'ขาวดำ', fx: 'grayscale(1)', filter: 'สี' },
  { id: 'fx-sepia', name: 'ซีเปีย', fx: 'sepia(0.9)', filter: 'สี' },
  { id: 'fx-sat', name: 'สีจัด', fx: 'saturate(1.8)', filter: 'สี' },
  { id: 'fx-bright', name: 'สว่างขึ้น', fx: 'brightness(1.3)', filter: 'ภาพ' },
  { id: 'fx-contrast', name: 'คอนทราสต์', fx: 'contrast(1.4)', filter: 'ภาพ' },
  { id: 'fx-blur', name: 'เบลอ', fx: 'blur(6px)', filter: 'ภาพ' },
];

function tilesFor(cat: Cat): Tile[] {
  switch (cat) {
    case 'source':
      return [
        { id: 'cam', name: 'กล้อง', badge: 'CAM', filter: 'กล้อง', ph: 'a', run: (t) => addMedia('camera', 'กล้อง', t) },
        ...ui.cameras.map((d, i): Tile => ({
          id: `cam-${d.deviceId}`, name: d.label || `กล้อง ${i + 1}`, badge: 'USB', filter: 'กล้อง', ph: 'a',
          run: (t) => addMedia('camera', d.label || 'กล้อง', t, d.deviceId),
        })),
        { id: 'screen', name: 'แชร์หน้าจอ', badge: 'SCR', filter: 'หน้าจอ', ph: 'b', run: (t) => addMedia('screen', 'หน้าจอ', t) },
        { id: 'phone', name: 'กล้องมือถือ (QR)', badge: 'QR', filter: 'กล้อง', ph: 'a', run: () => openRemote('phone') },
        { id: 'guest', name: 'แขกรับเชิญทางไกล', badge: 'CALL', filter: 'กล้อง', ph: 'b', run: () => openRemote('guest') },
        { id: 'video', name: 'ไฟล์วิดีโอ', badge: 'MP4', filter: 'ไฟล์', ph: 'c', run: (t) => addMedia('video', 'วิดีโอ', t) },
        { id: 'playlist', name: 'เพลย์ลิสต์วิดีโอ', badge: 'LIST', filter: 'ไฟล์', ph: 'c', run: (t) => addMedia('playlist', 'เพลย์ลิสต์', t) },
        { id: 'image', name: 'รูปภาพ', badge: 'IMG', filter: 'ไฟล์', ph: 'b', run: (t) => addMedia('image', 'รูปภาพ', t) },
        {
          id: 'color', name: 'พื้นสี', badge: 'CLR', filter: 'ไฟล์', ph: 'c',
          run: (t) => addSource(newSource('color', `พื้นสี ${countOf('color')}`, 'สีพื้น', { color: tk('accent-soft') }), null, t),
        },
        { id: 'bars', name: 'Color Bars', badge: 'BARS', filter: 'สัญญาณ', ph: 'c', run: (t) => addSource(newSource('bars', 'Color Bars', 'สัญญาณทดสอบ'), null, t) },
        { id: 'slate', name: 'Slate ข้อความ', badge: 'SLT', filter: 'สัญญาณ', ph: 'b', run: (t) => addSource(textSource('slate', 'เริ่มรายการเร็ว ๆ นี้', 'โปรดรอสักครู่', { tone: 'panel' }), null, t) },
        { id: 'clock', name: 'นาฬิกา', badge: 'CLK', filter: 'สัญญาณ', ph: 'a', run: (t) => addSource(newSource('clock', 'นาฬิกา', 'เวลาเครื่องนี้'), null, t) },
        {
          id: 'black', name: 'จอดำ', badge: 'BLK', filter: 'สัญญาณ', ph: 'a',
          run: (t) => addSource(newSource('color', 'จอดำ', 'Black', { color: tk('card-ground') }), null, t),
        },
      ];
    case 'audio':
      return [
        { id: 'mic', name: 'ไมโครโฟน', badge: 'MIC', filter: 'ไมค์', ph: 'a', run: () => addMedia('mic', 'ไมค์') },
        ...ui.mics.map((d, i): Tile => ({
          id: `mic-${d.deviceId}`, name: d.label || `ไมค์ ${i + 1}`, badge: 'MIC', filter: 'ไมค์', ph: 'a',
          run: () => addMedia('mic', d.label || 'ไมค์', undefined, d.deviceId),
        })),
        { id: 'audiofile', name: 'ไฟล์เสียง', badge: 'MP3', filter: 'ไฟล์', ph: 'c', run: () => addMedia('audio', 'เพลง') },
      ];
    case 'graphic':
      return [
        { id: 'g-l3', name: 'ชื่อผู้พูด', badge: 'L3', filter: 'ข้อความ', ph: 'c', run: addText(textSource('lower', 'ชื่อ นามสกุล', 'ตำแหน่ง · องค์กร')) },
        { id: 'g-badge', name: 'ป้ายมุมจอ', badge: 'TAG', filter: 'ข้อความ', ph: 'b', run: addText(textSource('corner', 'LIVE', '', { tone: 'amber' })) },
        {
          id: 'g-logo', name: 'โลโก้มุมจอ', badge: 'PNG', filter: 'รูป', ph: 'b',
          run: (t) => addMedia('image', 'โลโก้', t, undefined, { fit: 'contain', scale: 0.18, x: 0.82, y: -0.78 }, true),
        },
        {
          id: 'g-full', name: 'รูปเต็มจอ', badge: 'IMG', filter: 'รูป', ph: 'a',
          run: (t) => addMedia('image', 'รูปภาพ', t),
        },
        { id: 'g-pip', name: 'ภาพซ้อน (PIP)', badge: 'PIP', filter: 'รูป', ph: 'a', run: () => openPipChooser() },
        { id: 'g-score', name: 'ป้ายคะแนน', badge: 'SCORE', filter: 'ข้อมูล', ph: 'c', run: addText(newSource('score', 'ป้ายคะแนน', 'Scoreboard', { period: 'ครึ่งแรก' })) },
        { id: 'g-timer', name: 'นับถอยหลัง', badge: 'TIMER', filter: 'ข้อมูล', ph: 'b', run: addText(newSource('timer', 'นับถอยหลัง', 'Timer', { style: 'corner', title: 'เริ่มใน', tone: 'panel' })) },
        { id: 'g-stopwatch', name: 'จับเวลา', badge: 'TIMER', filter: 'ข้อมูล', ph: 'b', run: addText(newSource('timer', 'จับเวลา', 'Timer', { style: 'corner', timerMode: 'up', tone: 'panel' })) },
        { id: 'g-ticker', name: 'ตัววิ่งข่าว', badge: 'TICKER', filter: 'ข้อความ', ph: 'c', run: addText(textSource('ticker', 'ตัววิ่งข่าว', 'ข่าวด่วน', { items: 'พิมพ์ข่าวบรรทัดละเรื่อง\nข้อความจะวิ่งต่อกันไปเรื่อย ๆ', tone: 'amber' })) },
      ];
    case 'text':
      return [
        { id: 't-l3', name: 'Lower third', badge: 'L3', filter: '', ph: 'c', run: addText(textSource('lower', 'หัวข้อวันนี้', 'บรรทัดรอง')) },
        { id: 't-title', name: 'หัวเรื่องกลางจอ', badge: 'TTL', filter: '', ph: 'b', run: addText(textSource('title', 'เริ่มในอีกสักครู่', 'ขอบคุณที่รอชม', { tone: 'panel' })) },
        { id: 't-corner', name: 'ข้อความมุมจอ', badge: 'TXT', filter: '', ph: 'a', run: addText(textSource('corner', 'ช่วงถาม-ตอบ', '', { tone: 'panel' })) },
        { id: 't-ticker', name: 'ตัววิ่งข่าว', badge: 'TICKER', filter: '', ph: 'c', run: addText(textSource('ticker', 'ตัววิ่งข่าว', 'ข่าวด่วน', { items: 'พิมพ์ข่าวบรรทัดละเรื่อง\nข้อความจะวิ่งต่อกันไปเรื่อย ๆ', tone: 'amber' })) },
      ];
    case 'comment':
      return [
        { id: 'c-card', name: 'การ์ดคอมเมนต์', badge: 'CMT', filter: '', ph: 'c', run: addText(textSource('comment', 'พิมพ์คอมเมนต์ของผู้ชมที่นี่', 'ชื่อผู้ชม', { tone: 'panel' })) },
        { id: 'c-qa', name: 'คำถามจากผู้ชม', badge: 'Q&A', filter: '', ph: 'b', run: addText(textSource('comment', 'คำถามจากผู้ชม', 'ถาม-ตอบ', { tone: 'accent' })) },
      ];
    case 'effect':
      return EFFECTS.map((e): Tile => ({ id: e.id, name: e.name, badge: 'FX', filter: e.filter, ph: 'a', fx: e.fx, run: (t) => applyEffect(e.fx, t) }));
    case 'live':
      return [
        { id: 'l-yt', name: 'YouTube', badge: 'RTMP', filter: '', ph: 'a', run: () => openLive('youtube') },
        { id: 'l-fb', name: 'Facebook', badge: 'RTMPS', filter: '', ph: 'b', run: () => openLive('facebook') },
        { id: 'l-tw', name: 'Twitch', badge: 'RTMP', filter: '', ph: 'a', run: () => openLive('twitch') },
        { id: 'l-rtmp', name: 'RTMP อื่น ๆ', badge: 'RTMP', filter: '', ph: 'c', run: () => openLive('rtmp') },
        { id: 'l-srt', name: 'SRT', badge: 'SRT', filter: '', ph: 'c', run: () => openLive('srt') },
      ];
  }
}

function newTileAction(cat: Cat): void {
  if (cat === 'effect') return applyEffect('');
  if (cat === 'live') return openLive();
  if (cat === 'text') return void tilesFor('text')[0].run();
  if (cat === 'comment') return void tilesFor('comment')[0].run();
  if (cat === 'graphic') return void tilesFor('graphic')[2].run();
  openChooser(cat);
}

function effectTarget(target?: Target): Source | undefined {
  if (target === 'pvw') return byId(scene.pvw);
  if (target === 'pgm') return byId(scene.pgm);
  const sel = byId(ui.selected);
  return sel && isVisual(sel.kind) ? sel : byId(scene.pvw) ?? byId(scene.pgm);
}

function applyEffect(fx: string, target?: Target): void {
  const s = effectTarget(target);
  if (!s) return toast('เลือกแหล่งภาพในแถบล่างก่อน แล้วกดเอฟเฟกต์อีกครั้ง');
  const name = EFFECTS.find((e) => e.fx === fx)?.name;
  mutate((sc) => {
    const t = sc.sources.find((x) => x.id === s.id);
    if (t) t.props.filter = fx;
  }, { toast: fx ? `ใส่เอฟเฟกต์${name}ให้ ${s.name} แล้ว` : `ล้างเอฟเฟกต์ของ ${s.name} แล้ว` });
}

/* ================= rendering ================= */

function renderTop(): void {
  $('#top').innerHTML = `
    <div class="brand">${logo()}<b>WebMix</b><span class="brand__lite tag">LITE</span>
      <input class="brand__name" id="proj-name" value="${esc(scene.projectName)}" aria-label="ชื่อโปรเจกต์" data-prop="g:projectName"></div>
    <div class="wm-row top__history">
      <button class="wm-btn wm-btn--icon wm-btn--ghost" data-act="undo" id="btn-undo" aria-label="ย้อนกลับ" title="ย้อนกลับ ⌘Z">${icon('undo')}</button>
      <button class="wm-btn wm-btn--icon wm-btn--ghost" data-act="redo" id="btn-redo" aria-label="ทำซ้ำ" title="ทำซ้ำ ⇧⌘Z">${icon('redo')}</button>
    </div>
    <div class="grow"></div>
    <div class="chips" id="chips"></div>
    <button class="wm-btn wm-btn--icon wm-btn--ghost" data-act="settings" aria-label="ตั้งค่า" title="ตั้งค่า">${icon('gear')}</button>
    <div class="actions" id="actions">
      <button class="wm-btn" data-act="record" id="btn-rec">${icon('rec')}<span>บันทึก</span></button>
      <button class="wm-btn wm-btn--primary" data-act="live" id="btn-live">${icon('live')}<span>ไลฟ์</span></button>
    </div>`;
  renderChips();
  renderUndo();
}

function renderUndo(): void {
  const u = document.getElementById('btn-undo') as HTMLButtonElement | null;
  const r = document.getElementById('btn-redo') as HTMLButtonElement | null;
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

const RES_LABEL: Record<Resolution, string> = { '720p': '720p', '1080p': '1080p', '2160p': '4K' };

function renderChips(): void {
  const rec = ui.recorder;
  $('#chips').innerHTML = `
    ${ftb.target ? '<span class="wm-chip wm-chip--warn" id="chip-ftb"><span class="wm-dot"></span>FTB จอดำ</span>'
      : `<span class="wm-chip chip-res">${RES_LABEL[scene.resolution]} <b>${scene.fps}</b></span>`}
    ${livePanel.live ? `<span class="wm-chip wm-chip--live" id="chip-live"><span class="wm-dot"></span>LIVE <b>${livePanel.liveCount()}</b> ปลายทาง</span>`
      : '<span class="wm-chip chip-audio" title="ความดังระยะสั้น (LUFS)">เสียง <b id="chip-lufs">−∞</b><span class="mini-meter"><i id="meter-master"></i></span></span>'}
    ${rec ? `<span class="wm-chip wm-chip--warn" id="chip-rec"><span class="wm-dot"></span>REC <b id="rec-time">${fmtTime(performance.now() - rec.started)}</b></span>` : ''}`;
  const btn = $('#btn-rec');
  btn.innerHTML = rec ? `${icon('stop')}<span>หยุดบันทึก</span>` : `${icon('rec')}<span>บันทึก</span>`;
  btn.setAttribute('aria-pressed', String(!!rec));
  const live = $('#btn-live');
  const on = livePanel.live;
  live.className = `wm-btn ${on ? 'wm-btn--live' : 'wm-btn--primary'}`;
  const since = livePanel.streamer?.startedAt;
  live.innerHTML = on ? `<span class="wm-dot"></span><span>LIVE <span id="live-time">${since ? fmtTime(Date.now() - since) : '00:00:00'}</span></span>` : `${icon('live')}<span>ไลฟ์</span>`;
}

function renderRail(): void {
  $('#rail').innerHTML = CATS.map((c) => `
    <button type="button" data-act="cat" data-cat="${c.id}" aria-current="${c.id === ui.cat}">${icon(c.icon)}<span>${c.label}</span></button>`).join('');
}

function renderGallery(): void {
  const c = CATS.find((x) => x.id === ui.cat)!;
  const f = ui.filter[ui.cat] ?? c.filters[0];
  $('#gallery').innerHTML = `
    <div class="g-head">
      <div class="g-title"><span class="title">${c.label}</span>
        <button class="wm-btn wm-btn--icon wm-btn--ghost g-close" data-act="close-sheets" aria-label="ปิดแกลเลอรี">${icon('close')}</button></div>
      <label class="search">${icon('search')}<input id="q" type="search" placeholder="${c.search}" value="${esc(ui.query)}" aria-label="${c.search}"></label>
    </div>
    ${c.filters.length > 1 ? `<div class="wm-row g-filters">${c.filters.map((x) => `<button type="button" class="wm-chip wm-chip--filter" data-act="filter" data-val="${x}" aria-pressed="${x === f}">${x}</button>`).join('')}</div>` : ''}
    <div class="g-scroll"><div class="grid" id="g-grid"></div><div id="g-extra"></div></div>`;
  renderGalleryGrid();
  renderGalleryExtra();
}

function renderGalleryGrid(): void {
  const grid = document.getElementById('g-grid');
  if (!grid) return;
  const c = CATS.find((x) => x.id === ui.cat)!;
  const f = ui.filter[ui.cat] ?? c.filters[0];
  const q = ui.query.trim().toLowerCase();
  const tiles = tilesFor(ui.cat).filter((t) => (f === c.filters[0] || t.filter === f) && (!q || t.name.toLowerCase().includes(q)));
  grid.innerHTML = `
    <button type="button" class="wm-tile wm-tile--new" data-act="new-tile">${icon(ui.cat === 'effect' ? 'refresh' : 'plus')}${c.add}</button>
    ${tiles.map((t) => `
      <div class="wm-tile" draggable="true" data-act="tile" data-tile="${esc(t.id)}" role="button" tabindex="0" aria-label="เพิ่ม ${esc(t.name)}">
        <div class="wm-tile__pic"><div class="wm-ph wm-ph--${t.ph}"><i></i><i></i></div><span class="wm-tile__badge">${esc(t.badge)}</span>
          <span class="wm-tile__add" aria-hidden="true">${icon('plus')}</span></div>
        <div class="wm-tile__name">${esc(t.name)}</div>
      </div>`).join('')}
    ${tiles.length ? '' : '<p class="wm-note g-empty">ไม่พบรายการที่ค้นหา ลองคำอื่น</p>'}`;
}

function renderGalleryExtra(): void {
  const box = document.getElementById('g-extra');
  if (!box) return;
  if (ui.cat === 'audio') {
    const list = scene.sources.filter((s) => media.get(s.id)?.strip || s.kind === 'mic' || s.kind === 'audio');
    box.innerHTML = `<h3 class="g-sub">มิกเซอร์</h3>
      <div class="mix-row mix-row--master">
        <button type="button" class="lim-btn" data-act="limiter" aria-pressed="${scene.limiter}" title="ลิมิตเตอร์ที่ Master กันเสียงแตกในไฟล์บันทึกและสตรีม">LIM</button>
        <div class="mix-row__main">
          <div class="mix-row__top"><span class="mix-row__name">MASTER</span><output class="db" id="db-master">${fmtDb(scene.master)}</output></div>
          <input type="range" class="wm-slider" min="0" max="150" value="${Math.round(scene.master * 100)}" data-prop="g:master" data-div="100" data-unit="dB" aria-label="ระดับเสียง Master">
          ${meterHtml('master')}
          <div class="lufs" id="lufs">M <b data-lufs="m">−∞</b> · S <b data-lufs="s">−∞</b> · I <b data-lufs="i">−∞</b> LUFS
            <button type="button" class="lufs__reset" data-act="lufs-reset" title="เริ่มวัดค่า Integrated ใหม่">รีเซ็ต</button></div>
        </div>
      </div>
      ${list.length ? list.map((s) => `
      <div class="mix-row">
        <div class="mix-row__btns">
          <button class="wm-btn wm-btn--icon wm-btn--ghost" data-act="mute" data-id="${s.id}" aria-pressed="${s.props.muted}" aria-label="${s.props.muted ? 'เปิดเสียง' : 'ปิดเสียง'} ${esc(s.name)}">${icon(s.props.muted ? 'mute' : 'speaker')}</button>
          <button type="button" class="mon-btn" data-act="mon" data-id="${s.id}" aria-pressed="${s.props.mon}" aria-label="ฟัง ${esc(s.name)} ในหูฟัง" title="ฟังช่องนี้ในหูฟัง (MON)">MON</button>
        </div>
        <div class="mix-row__main">
          <div class="mix-row__top"><button type="button" class="mix-row__name" data-act="select" data-id="${s.id}">${esc(s.name)}</button><output class="db" data-db="${s.id}">${fmtDb(s.props.volume)}</output></div>
          <input type="range" class="wm-slider" min="0" max="150" value="${Math.round(s.props.volume * 100)}" data-mix="${s.id}" aria-label="ระดับเสียง ${esc(s.name)}">
          ${meterHtml(s.id)}
        </div>
      </div>`).join('') : '<p class="wm-note">ยังไม่มีแหล่งเสียง เพิ่มไมค์หรือไฟล์วิดีโอที่มีเสียง</p>'}
      <p class="wm-note">มิเตอร์เป็น dBFS: เขียว = ปกติ, อำพัน = สูงกว่า −6, แดง = ใกล้แตก · MON ฟังเฉพาะช่องที่เลือกในหูฟัง</p>`;
  } else if (ui.cat === 'comment') {
    box.innerHTML = '<p class="wm-note g-note">รุ่น Lite พิมพ์คอมเมนต์เองได้ การดึงคอมเมนต์จาก YouTube หรือ Facebook อัตโนมัติต้องเชื่อมบัญชีผ่าน gateway</p>';
  } else if (ui.cat === 'effect') {
    box.innerHTML = '<p class="wm-note g-note">แตะเพื่อใส่ให้แหล่งภาพที่เลือก หรือลากไปวางบนจอ PVW / PGM</p>';
  } else if (ui.cat === 'live') {
    box.innerHTML = '<p class="wm-note g-note">ส่งพร้อมกันได้สูงสุด 6 ปลายทางผ่าน Stream Gateway ตัวเดียวกับ WebMix Pro (YouTube, Facebook, Twitch, RTMP, SRT)</p>';
  } else box.innerHTML = '';
}

const fmtDb = (v: number) => (v <= 0.0001 ? '−∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`);
const fmtLufs = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '−∞');

function meterHtml(id: string, wide = false): string {
  return `<span class="meter${wide ? ' meter--wide' : ''}" data-meterbox="${id}"><i data-meter="${id}"></i><b class="meter__peak" data-peak="${id}"></b></span>`;
}

const coarse = () => matchMedia('(pointer: coarse)').matches;

function cardHtml(s: Source, i: number): string {
  const isPgm = ovlOn(s.id) || scene.pgm === s.id || trans?.to === s.id;
  const isPvw = !isPgm && scene.pvw === s.id;
  const word = isPgm ? 'PGM' : isPvw ? 'PVW' : '';
  const ch = chOf(s.id);
  const sub = ch >= 0 ? `Overlay ${ch + 1} · ${scene.overlays[ch].on ? 'ออนแอร์' : 'ซ่อนอยู่'}` : s.kind === 'video' || s.kind === 'playlist' ? playbackLine(s) : s.meta;
  return `
    <div class="wm-card ${isPgm ? 'is-pgm' : isPvw ? 'is-pvw' : ''} ${ui.selected === s.id ? 'is-selected' : ''}" role="button" tabindex="0" draggable="${!coarse()}"
      data-act="card" data-id="${s.id}" aria-haspopup="menu" aria-label="${i < 9 ? `${i + 1} ` : ''}${esc(s.name)}${word ? ` ${word}` : ''}">
      <div class="wm-card__pic"><canvas data-thumb="${s.id}" width="${THUMB_W}" height="${THUMB_H}"></canvas>
        ${i < 9 ? `<span class="wm-card__num">${i + 1}</span>` : ''}${word ? `<span class="wm-card__tally">${word}</span>` : ''}</div>
      <div class="wm-card__foot"><div class="wm-card__name">${esc(s.name)}</div><div class="wm-card__sub">${esc(sub)}</div></div>
    </div>`;
}

// thumbnails at the card's real pixel size (sharp on phones), kept across re-renders so a cut never flashes them blank
const THUMB_W = 336, THUMB_H = 189;
const thumbs = new Map<string, HTMLCanvasElement>();

function renderStrip(): void {
  const vis = cutSources();
  $('#strip').innerHTML = `${vis.map(cardHtml).join('')}
    <div class="drop">${vis.length ? `${coarse() ? 'กดค้างที่การ์ด' : 'คลิกขวาที่การ์ด'}เพื่อซ้อนบนจอหรือดูคำสั่งอื่น` : 'ยังไม่มีแหล่งภาพ แตะ + ในแกลเลอรีเพื่อเพิ่ม'}</div>`;
  document.querySelectorAll<HTMLCanvasElement>('#strip canvas[data-thumb]').forEach((fresh) => {
    const id = fresh.dataset.thumb!;
    const kept = thumbs.get(id);
    if (kept) fresh.replaceWith(kept);
    else thumbs.set(id, fresh);
  });
  for (const id of thumbs.keys()) if (!byId(id)) thumbs.delete(id);
  lastThumb = 0;
}

function renderTally(): void {
  const pvw = byId(scene.pvw);
  const pgm = byId(trans?.to ?? scene.pgm);
  // the tally word sits under the picture, never over it, so graphics in the corners stay visible
  $('#cap-pvw').innerHTML = `<span class="tag mon__tag mon__tag--pvw">PVW</span><span class="mon__name" data-testid="pvw-name">${pvw ? esc(pvw.name) : 'ว่าง'}</span>`;
  $('#cap-pgm').innerHTML = `<span class="tag mon__tag mon__tag--pgm">PGM</span><span class="mon__name" data-testid="pgm-name">${pgm ? esc(pgm.name) : 'ว่าง'}</span>`;
  $('#mon-pgm').dataset.source = scene.pgm ?? '';
  $('#mon-pvw').dataset.source = scene.pvw ?? '';
  document.querySelectorAll<HTMLElement>('#strip .wm-card').forEach((el) => {
    const s = byId(el.dataset.id!);
    if (!s) return;
    const isPgm = ovlOn(s.id) || scene.pgm === s.id || trans?.to === s.id;
    const isPvw = !isPgm && scene.pvw === s.id;
    el.classList.toggle('is-pgm', isPgm);
    el.classList.toggle('is-pvw', isPvw);
    el.classList.toggle('is-selected', ui.selected === s.id);
    const pic = el.querySelector('.wm-card__pic')!;
    pic.querySelector('.wm-card__tally')?.remove();
    if (isPgm || isPvw) pic.insertAdjacentHTML('beforeend', `<span class="wm-card__tally">${isPgm ? 'PGM' : 'PVW'}</span>`);
  });
  const chip = document.getElementById('insp-chip');
  if (chip) chip.outerHTML = tallyChip(byId(ui.selected));
}

function renderTrans(): void {
  $('#trans').innerHTML = `
    <div class="trans__seg">
      <div class="wm-seg" role="group" aria-label="ทรานซิชัน">
        ${(['mix', 'dip', 'wipe'] as const).map((t) => `<button type="button" data-act="trans" data-val="${t}" aria-pressed="${scene.transition === t}">${t.toUpperCase()}</button>`).join('')}
      </div>
      <button type="button" class="wm-btn wm-btn--ghost ftb-btn" data-act="ftb" id="btn-ftb" aria-pressed="${!!ftb.target}" title="จอดำ (B)">FTB</button>
      <button type="button" class="wm-btn wm-btn--ghost insp-open" data-act="open-insp">${icon('sliders')}<span>ปรับค่า</span></button>
    </div>
    <div class="wm-keys">
      <button type="button" class="wm-key wm-key--cut" data-act="cut" id="btn-cut">CUT<small>SPACE</small></button>
      <button type="button" class="wm-key wm-key--auto" data-act="auto" id="btn-auto">AUTO<small>${scene.transition.toUpperCase()} ${(scene.duration / 1000).toFixed(1)}s · ENTER</small></button>
    </div>
    <div class="ovl-row" id="ovl-row" role="group" aria-label="Overlay 1–8"></div>
    <label class="tbar"><span class="tag">T-BAR</span>
      <input type="range" class="wm-slider" id="tbar" min="0" max="100" step="1" value="${trans?.manual !== undefined ? tbarValue() : tbarBase}" aria-label="T-Bar เลื่อนเพื่อเปลี่ยนภาพเอง"></label>`;
  renderOverlayRow();
}

/* ---------- inspector ---------- */

function tallyChip(s?: Source): string {
  if (!s) return '<span id="insp-chip"></span>';
  if (ovlOn(s.id) || scene.pgm === s.id) return '<span class="wm-chip wm-chip--live" id="insp-chip"><span class="wm-dot"></span>PGM</span>';
  if (scene.pvw === s.id) return '<span class="wm-chip wm-chip--ok" id="insp-chip"><span class="wm-dot"></span>PVW</span>';
  return '<span id="insp-chip"></span>';
}

const fmt = (v: number, unit: string) => (unit === 's' ? `${(v / 1000).toFixed(1)}s` : unit === 'dB' ? fmtDb(v / 100) : `${Math.round(v)}${unit}`);

function rangeField(prop: string, label: string, value: number, min: number, max: number, div = 100, unit = '%', step = 1): string {
  const v = Math.round(value * div);
  return `<label class="wm-field"><span>${label}</span><div class="wm-range">
    <input type="range" class="wm-slider" data-prop="${prop}" data-div="${div}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${v}">
    <output class="wm-range__val">${fmt(v, unit)}</output></div></label>`;
}

function switchRow(prop: string, label: string, on: boolean): string {
  return `<button type="button" class="wm-insp__row sw-row" role="switch" aria-checked="${on}" data-act="switch" data-prop="${prop}">
    <span>${label}</span><span class="wm-toggle ${on ? 'is-on' : ''}" aria-hidden="true"></span></button>`;
}

function segField(prop: string, label: string, opts: [string, string][], cur: string, numeric = false): string {
  return `<div class="wm-field"><span>${label}</span><div class="wm-seg" role="group" aria-label="${label}">${opts.map(([v, l]) =>
    `<button type="button" data-act="seg" data-prop="${prop}" data-val="${v}"${numeric ? ' data-num="1"' : ''} aria-pressed="${v === cur}">${l}</button>`).join('')}</div></div>`;
}

function textField(prop: string, label: string, value: string, ph = ''): string {
  return `<label class="wm-field"><span>${label}</span><input class="wm-input" data-prop="${prop}" value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off"></label>`;
}

function advanced(inner: string): string {
  return `<button type="button" class="wm-disclose" data-act="advanced" aria-expanded="${ui.advanced}">ตั้งค่าขั้นสูง${icon(ui.advanced ? 'down' : 'chevron')}</button>
    ${ui.advanced ? `<div class="adv">${inner}</div>` : ''}`;
}

function tabsFor(s: Source): string[] {
  if (s.kind === 'mic') return ['เสียง'];
  if (s.kind === 'audio') return ['เล่น', 'เสียง'];
  if (s.kind === 'text') return ['ข้อความ', 'ภาพ', 'ข้อมูล'];
  if (s.kind === 'timer') return ['เวลา', 'ภาพ'];
  if (s.kind === 'score') return ['คะแนน', 'ภาพ', 'ข้อมูล'];
  const t = s.kind === 'video' || s.kind === 'playlist' ? ['เล่น', 'ภาพ'] : ['ภาพ'];
  if (media.get(s.id)?.strip) t.push('เสียง');
  t.push('เอฟเฟกต์');
  return t;
}

function textArea(prop: string, label: string, value: string, rows = 4): string {
  return `<label class="wm-field"><span>${label}</span><textarea class="wm-input wm-textarea" data-prop="${prop}" rows="${rows}">${esc(value)}</textarea></label>`;
}

function numberField(prop: string, label: string, value: number, mul = 1): string {
  return `<label class="wm-field"><span>${label}</span><input class="wm-input" type="number" min="0" step="1" data-prop="${prop}" data-mul="${mul}" value="${Math.round(value / mul)}"></label>`;
}

function overlaySection(s: Source): string {
  const ch = chOf(s.id);
  if (ch < 0) {
    return `<div class="wm-field"><span>Overlay</span><button type="button" class="wm-btn" data-act="ovl-assign">${icon('plus')}ซ้อนบน Program</button></div>`;
  }
  return switchRow('ovl', `แสดงบนจอ · Overlay ${ch + 1}`, scene.overlays[ch].on);
}

function overlayAdvanced(s: Source): string {
  const ch = chOf(s.id);
  if (ch < 0) return '';
  const o = scene.overlays[ch];
  return `
    <label class="wm-field"><span>ช่อง Overlay</span><select class="wm-input" data-ovl="ch">${scene.overlays.map((x, i) =>
      `<option value="${i}" ${i === ch ? 'selected' : ''}>Overlay ${i + 1}${x.src && i !== ch ? ` · ${esc(byId(x.src)?.name ?? '')}` : ''}</option>`).join('')}</select></label>
    <label class="wm-field"><span>เอฟเฟกต์เข้า-ออก</span><select class="wm-input" data-ovl="fx">${OVERLAY_FX.map(([v, l]) =>
      `<option value="${v}" ${v === o.fx ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${rangeField('o:dur', 'ระยะเวลาเข้า-ออก', o.dur, 0, 2000, 1, 's', 100)}
    ${switchRow('o:cue', 'แสดงบน PVW ก่อน (ยังไม่ออกอากาศ)', o.cue)}
    <button type="button" class="wm-btn wm-btn--sm" data-act="ovl-remove">เอาออกจาก Overlay</button>`;
}

function presetsField(): string {
  const list = loadPresets();
  return `<div class="wm-field"><span>ป้ายที่บันทึกไว้</span><div class="wm-row presets">
    ${list.map((x, i) => `<span class="preset"><button type="button" class="wm-chip wm-chip--filter" data-act="preset" data-i="${i}">${esc(x.title)}</button><button type="button" class="preset__del" data-act="preset-del" data-i="${i}" aria-label="ลบป้าย ${esc(x.title)}">${icon('close')}</button></span>`).join('')}
    <button type="button" class="wm-btn wm-btn--sm" data-act="preset-save">${icon('plus')}บันทึกป้ายนี้</button></div></div>`;
}

function dataStatus(s: Source): string {
  const st = dataState.get(s.id);
  if (!s.props.dataUrl) return 'ยังไม่ได้ใส่ลิงก์';
  if (!st || (st.loading && !st.rows.length)) return 'กำลังโหลด…';
  if (st.error) return st.error;
  const n = st.rows.length;
  return s.kind === 'text' && s.props.style !== 'ticker' ? `แถว ${Math.min(s.props.dataRow, Math.max(0, n - 1)) + 1} / ${n} · อัปเดตทุก 10 วินาที` : `${n} แถว · อัปเดตทุก 10 วินาที`;
}

function renderDataStatus(): void {
  const s = byId(ui.selected);
  const el = document.getElementById('data-status');
  if (s && el) {
    el.textContent = dataStatus(s);
    el.classList.toggle('wm-help--err', !!dataState.get(s.id)?.error);
  }
}

function inspectorBody(s: Source): string {
  const p = s.props;
  const tab = ui.tab;
  if (tab === 'ข้อความ') {
    const comment = p.style === 'comment', ticker = p.style === 'ticker';
    return `
      ${ticker ? textArea('p:items', 'ข้อความวิ่ง (บรรทัดละเรื่อง)', p.items) : textField('p:title', comment ? 'ข้อความคอมเมนต์' : 'หัวเรื่อง', p.title)}
      ${textField('p:sub', comment ? 'ชื่อผู้ชม' : ticker ? 'ป้ายหัว' : 'บรรทัดรอง', p.sub)}
      ${p.style === 'slate' ? '' : overlaySection(s)}
      ${segField('p:tone', 'สีแถบ', [['accent', 'น้ำเงิน'], ['panel', 'เข้ม'], ['amber', 'อำพัน']], p.tone)}
      ${['lower', 'title', 'corner'].includes(p.style) ? presetsField() : ''}
      ${advanced(`
        ${segField('p:style', 'รูปแบบ', [['lower', 'แถบล่าง'], ['title', 'กลางจอ'], ['corner', 'มุมจอ'], ['comment', 'คอมเมนต์'], ['ticker', 'ตัววิ่ง']], p.style)}
        ${ticker ? segField('p:speed', 'ความเร็ว', [['60', 'ช้า'], ['90', 'ปกติ'], ['130', 'เร็ว'], ['180', 'เร็วมาก']], String(p.speed), true) : ''}
        ${textField('n:name', 'ชื่อในแถบการ์ด', s.name)}
        ${overlayAdvanced(s)}`)}`;
  }
  if (tab === 'เวลา') {
    const running = !!p.timerStart;
    return `
      <div class="timer-big" id="timer-val">${fmtClock(timerValue(s))}</div>
      <div class="wm-row">
        <button type="button" class="wm-btn wm-btn--primary" data-act="timer-run">${icon(running ? 'pause' : 'play')}${running ? 'หยุด' : 'เริ่ม'}</button>
        <button type="button" class="wm-btn" data-act="timer-reset">${icon('refresh')}เริ่มใหม่</button>
      </div>
      ${segField('p:timerMode', 'โหมด', [['down', 'นับถอยหลัง'], ['up', 'จับเวลา']], p.timerMode)}
      ${p.timerMode === 'down' ? numberField('p:timerDur', 'ระยะเวลา (นาที)', p.timerDur, 60_000) : ''}
      ${textField('p:title', 'ป้ายกำกับ', p.title, 'เช่น เริ่มใน')}
      ${overlaySection(s)}
      ${advanced(`
        ${segField('p:style', 'ตำแหน่ง', [['corner', 'มุมจอ'], ['title', 'กลางจอ']], p.style === 'title' ? 'title' : 'corner')}
        ${segField('p:tone', 'สีพื้น', [['panel', 'เข้ม'], ['accent', 'น้ำเงิน'], ['amber', 'อำพัน']], p.tone)}
        ${textField('n:name', 'ชื่อ', s.name)}
        ${overlayAdvanced(s)}`)}`;
  }
  if (tab === 'คะแนน') {
    const team = (k: 'A' | 'B') => `
      <div class="score-row">
        <input class="wm-input" data-prop="p:team${k}" value="${esc(k === 'A' ? p.teamA : p.teamB)}" aria-label="ชื่อทีม ${k}">
        <button type="button" class="wm-btn wm-btn--icon" data-act="score" data-team="${k}" data-d="-1" aria-label="ลดคะแนนทีม ${k}">−</button>
        <output class="score-val">${k === 'A' ? p.scoreA : p.scoreB}</output>
        <button type="button" class="wm-btn wm-btn--icon wm-btn--primary" data-act="score" data-team="${k}" data-d="1" aria-label="เพิ่มคะแนนทีม ${k}">+</button>
      </div>`;
    return `
      <div class="wm-field"><span>ทีมและคะแนน</span>${team('A')}${team('B')}</div>
      ${textField('p:period', 'ช่วงเวลา', p.period, 'เช่น ครึ่งแรก, Q3')}
      ${overlaySection(s)}
      ${advanced(`
        <div class="wm-row">
          <label class="wm-field grow"><span>สีทีม A</span><input type="color" class="wm-color" data-prop="p:colorA" value="${esc(p.colorA || tk('accent'))}"></label>
          <label class="wm-field grow"><span>สีทีม B</span><input type="color" class="wm-color" data-prop="p:colorB" value="${esc(p.colorB || tk('pgm-fill'))}"></label>
        </div>
        <button type="button" class="wm-btn wm-btn--sm" data-act="score-reset">${icon('refresh')}ล้างคะแนน</button>
        ${textField('n:name', 'ชื่อ', s.name)}
        ${overlayAdvanced(s)}`)}`;
  }
  if (tab === 'ข้อมูล') {
    const rowNav = s.kind === 'text' && p.style !== 'ticker';
    return `
      ${textField('p:dataUrl', 'ลิงก์ Google Sheets หรือ CSV', p.dataUrl, 'https://docs.google.com/spreadsheets/d/…')}
      ${switchRow('p:dataHeader', 'แถวแรกเป็นหัวตาราง (ไม่นำมาแสดง)', p.dataHeader)}
      <p class="wm-help" id="data-status">${esc(dataStatus(s))}</p>
      ${rowNav ? `<div class="wm-row">
        <button type="button" class="wm-btn" data-act="data-row" data-d="-1">${icon('prev')}แถวก่อน</button>
        <button type="button" class="wm-btn" data-act="data-row" data-d="1">แถวถัดไป${icon('next')}</button></div>` : ''}
      <button type="button" class="wm-btn wm-btn--sm" data-act="data-refresh">${icon('refresh')}โหลดเดี๋ยวนี้</button>
      <p class="wm-note">${s.kind === 'score' ? 'แถวแรก: ชื่อทีม A, คะแนน A, ชื่อทีม B, คะแนน B, ช่วงเวลา'
        : p.style === 'ticker' ? 'คอลัมน์ A ของทุกแถว = ข้อความที่วิ่ง' : 'คอลัมน์ A = หัวเรื่อง, B = บรรทัดรอง · เลื่อนแถวเพื่อเปลี่ยนชื่อบนจอ'}
        · ชีตต้องแชร์แบบ "ทุกคนที่มีลิงก์ดูได้"</p>`;
  }
  if (tab === 'เสียง') {
    return `
      ${switchRow('p:muted', 'ปิดเสียง', p.muted)}
      ${rangeField('p:volume', 'ระดับเสียง', p.volume, 0, 150, 100, 'dB')}
      <div class="wm-field"><span>ระดับสัญญาณ (dBFS)</span>${meterHtml(s.id, true)}</div>
      ${switchRow('p:mon', 'ฟังในหูฟัง (MON)', p.mon)}
      ${switchRow('p:gate', 'Noise gate ตัดเสียงรบกวนตอนไม่พูด', p.gate)}
      ${p.gate ? rangeField('p:gateDb', 'ระดับเปิด gate', p.gateDb, -80, -10, 1, ' dB') : ''}
      ${advanced(`
        ${isVisual(s.kind) ? switchRow('p:afv', 'เปิดเสียงเฉพาะตอนออกอากาศ (AFV)', p.afv) : ''}
        ${rangeField('p:pan', 'ซ้าย / ขวา', p.pan, -100, 100, 100, '')}
        ${switchRow('p:lowcut', 'ตัดเสียงทุ้มต่ำกว่า 80 Hz', p.lowcut)}
        ${rangeField('p:eqLow', 'EQ ทุ้ม (120 Hz)', p.eqLow, -12, 12, 1, ' dB')}
        ${rangeField('p:eqMid', 'EQ กลาง (1 kHz)', p.eqMid, -12, 12, 1, ' dB')}
        ${rangeField('p:eqHigh', 'EQ แหลม (8 kHz)', p.eqHigh, -12, 12, 1, ' dB')}
        ${switchRow('p:comp', 'คอมเพรสเซอร์ (4:1)', p.comp)}
        ${p.comp ? rangeField('p:compDb', 'ระดับเริ่มบีบ', p.compDb, -50, 0, 1, ' dB') : ''}
        ${rangeField('p:delay', 'หน่วงเสียงให้ตรงปาก', p.delay, 0, 1000, 1, ' ms', 10)}
        ${textField('n:name', 'ชื่อ', s.name)}`)}`;
  }
  if (tab === 'เล่น') {
    const m = media.get(s.id);
    const playing = m?.el instanceof HTMLMediaElement && !m.el.paused;
    const clip = s.kind !== 'audio';
    return `
      <div class="wm-row transport">
        <button type="button" class="wm-btn wm-btn--primary" data-act="play" aria-label="${playing ? 'หยุดชั่วคราว' : 'เล่น'}">${icon(playing ? 'pause' : 'play')}${playing ? 'หยุด' : 'เล่น'}</button>
        <button type="button" class="wm-btn wm-btn--icon" data-act="restart" aria-label="เริ่มใหม่จากต้น" title="เริ่มใหม่จากต้น">${icon('refresh')}</button>
        ${m?.list ? `<button type="button" class="wm-btn wm-btn--icon" data-act="pl-prev" aria-label="ไฟล์ก่อนหน้า">${icon('prev')}</button>
          <button type="button" class="wm-btn wm-btn--icon" data-act="pl-next" aria-label="ไฟล์ถัดไป">${icon('next')}</button>` : ''}
      </div>
      <label class="wm-field"><span>ตำแหน่ง <output class="timecode" id="tp-time">00:00:00 / 00:00:00</output></span>
        <input type="range" class="wm-slider" id="seek" min="0" max="1000" value="0" aria-label="เลื่อนตำแหน่งวิดีโอ"></label>
      ${switchRow('p:loop', s.kind === 'playlist' ? 'วนทั้งเพลย์ลิสต์' : 'เล่นวนซ้ำ', p.loop)}
      ${clip ? switchRow('p:autoPlay', 'เล่นเองเมื่อขึ้น PGM · หยุดเมื่อลง', p.autoPlay) : ''}
      ${clip ? switchRow('p:restartOnAir', 'เริ่มจากต้นทุกครั้งที่ขึ้น PGM', p.restartOnAir) : ''}
      ${m?.list ? `<div class="wm-field"><span>ไฟล์ในเพลย์ลิสต์</span><ol class="pl-list">${m.list.map((f, i) =>
        `<li><button type="button" class="pl-item" data-act="pl-go" data-i="${i}" aria-current="${i === m.index}">${esc(f.name)}</button></li>`).join('')}</ol>
        <button type="button" class="wm-btn wm-btn--sm" data-act="pl-add">${icon('plus')}เพิ่มไฟล์</button></div>` : ''}`;
  }
  if (tab === 'เอฟเฟกต์') {
    return `
      <div class="wm-field"><span>เอฟเฟกต์</span><div class="wm-row">
        <button type="button" class="wm-chip wm-chip--filter" data-act="seg" data-prop="p:filter" data-val="" aria-pressed="${!p.filter}">ไม่มี</button>
        ${EFFECTS.map((e) => `<button type="button" class="wm-chip wm-chip--filter" data-act="seg" data-prop="p:filter" data-val="${e.fx}" aria-pressed="${p.filter === e.fx}">${e.name}</button>`).join('')}
      </div></div>
      ${needsMedia(s.kind) ? `
        ${segField('p:key', 'คีย์ฉาก (Chroma key)', [['off', 'ปิด'], ['green', 'ฉากเขียว'], ['blue', 'ฉากฟ้า']], p.key)}
        ${p.key !== 'off' ? rangeField('p:keyTol', 'ความไวของคีย์', p.keyTol, 10, 200, 1, '') : ''}` : ''}`;
  }
  // ภาพ
  const pic = needsMedia(s.kind);
  return `
    ${rangeField('p:scale', 'ขนาด', p.scale, 10, 300)}
    ${rangeField('p:opacity', 'ความโปร่งใส', p.opacity, 0, 100)}
    ${switchRow('p:flip', 'กลับด้านภาพ', p.flip)}
    ${s.kind === 'text' && p.style === 'slate' ? '' : overlaySection(s)}
    ${s.kind === 'color' ? `<label class="wm-field"><span>สีพื้น</span><input type="color" class="wm-color" data-prop="p:color" value="${esc(p.color)}"></label>` : ''}
    ${advanced(`
      ${pic ? segField('p:fit', 'การจัดภาพ', [['cover', 'เต็มจอ'], ['contain', 'พอดีจอ']], p.fit) : ''}
      ${s.kind === 'camera' ? segField('p:res', 'ความละเอียดกล้อง', [['720p', '720p'], ['1080p', '1080p'], ['2160p', '4K']], p.res) : ''}
      ${rangeField('p:x', 'ตำแหน่งแนวนอน', p.x, -100, 100, 100, '')}
      ${rangeField('p:y', 'ตำแหน่งแนวตั้ง', p.y, -100, 100, 100, '')}
      ${pic ? `
        ${rangeField('p:cropL', 'ครอปซ้าย', p.cropL, 0, 45)}
        ${rangeField('p:cropR', 'ครอปขวา', p.cropR, 0, 45)}
        ${rangeField('p:cropT', 'ครอปบน', p.cropT, 0, 45)}
        ${rangeField('p:cropB', 'ครอปล่าง', p.cropB, 0, 45)}
        ${rangeField('p:border', 'ขอบ', p.border, 0, 16, 1, 'px')}
        ${p.border ? segField('p:borderTone', 'สีขอบ', [['accent', 'น้ำเงิน'], ['text', 'ขาว'], ['amber', 'อำพัน']], p.borderTone) : ''}` : ''}
      ${textField('n:name', 'ชื่อ', s.name)}
      ${overlayAdvanced(s)}
      <button type="button" class="wm-btn wm-btn--sm" data-act="reset-props">${icon('refresh')}คืนค่าเริ่มต้น</button>`)}`;
}

function renderInspector(): void {
  const box = $('#insp');
  const s = byId(ui.selected);
  const close = `<button class="wm-btn wm-btn--icon wm-btn--ghost insp-close" data-act="close-sheets" aria-label="ปิดแผงปรับค่า">${icon('close')}</button>`;
  if (!s) {
    box.innerHTML = `
      <div class="wm-insp__head"><span class="wm-insp__title">เอาต์พุต</span><span class="wm-chip">PGM</span>${close}</div>
      <div class="wm-insp__body">
        ${textField('g:projectName', 'ชื่อโปรเจกต์', scene.projectName)}
        ${rangeField('g:duration', 'ระยะเวลา AUTO', scene.duration, 200, 3000, 1, 's', 100)}
        ${rangeField('g:master', 'ระดับเสียงรวม', scene.master, 0, 150, 100, 'dB')}
        ${segField('g:resolution', 'ความละเอียดเอาต์พุต', [['720p', '720p'], ['1080p', '1080p'], ['2160p', '4K']], scene.resolution)}
        ${segField('g:fps', 'เฟรมเรต', [['30', '30 fps'], ['60', '60 fps']], String(scene.fps), true)}
        ${switchRow('ftb', 'จอดำ (FTB)', !!ftb.target)}
        <div class="wm-field"><span>จอเอาต์พุต</span><div class="wm-row">
          <button type="button" class="wm-btn" data-act="out-window" aria-pressed="${outputOpen()}">${icon('screen')}หน้าต่าง Program</button>
          <button type="button" class="wm-btn" data-act="multiview" aria-pressed="${multiviewOpen()}">${icon('grid')}Multiview</button>
          <button type="button" class="wm-btn" data-act="fullscreen">${icon('expand')}เต็มจอ</button>
          <button type="button" class="wm-btn" data-act="snapshot">${icon('camera')}ภาพนิ่ง</button>
        </div></div>
        ${advanced(`
          ${switchRow('g:monitor', 'ฟังเสียงมอนิเตอร์ที่เครื่องนี้', scene.monitor)}
          ${switchRow('g:limiter', 'ลิมิตเตอร์ที่ Master (กันเสียงแตก)', scene.limiter)}
          <label class="wm-field"><span>ลำโพง / หูฟังสำหรับฟังเสียง</span><select class="wm-input" data-sink="1" ${canPickOutput() ? '' : 'disabled'}>
            <option value="">${canPickOutput() ? 'ค่าเริ่มต้นของเครื่อง' : 'เบราว์เซอร์นี้เลือกไม่ได้'}</option>
            ${ui.outputs.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === scene.sinkId ? 'selected' : ''}>${esc(d.label || 'อุปกรณ์เสียง')}</option>`).join('')}</select></label>
          <p class="wm-note">เปิดเมื่อใส่หูฟังเท่านั้น เพื่อไม่ให้เสียงหอน</p>`)}
        ${scene.resolution === '2160p' ? '<p class="wm-note">4K ต้องใช้เครื่องแรง (CPU 8 คอร์หรือการ์ดจอแยก) ถ้าภาพกระตุกให้ลดเป็น 1080p</p>' : ''}
        <p class="wm-note">แตะการ์ดในแถบล่างเพื่อปรับค่าแหล่งภาพนั้น</p>
      </div>`;
    return;
  }
  const tabs = tabsFor(s);
  if (!tabs.includes(ui.tab)) ui.tab = tabs[0];
  const missing = needsMedia(s.kind) && !media.has(s.id);
  box.innerHTML = `
    <div class="wm-insp__head"><span class="wm-insp__title">${esc(s.name)}</span>${tallyChip(s)}${close}</div>
    ${tabs.length > 1 ? `<div class="wm-tabs" role="tablist">${tabs.map((t) => `<button type="button" role="tab" data-act="tab" data-val="${t}" aria-selected="${t === ui.tab}">${t}</button>`).join('')}</div>` : ''}
    <div class="wm-insp__body">
      ${missing ? `<div class="notice"><p>${esc(s.name)} ยังไม่มีสัญญาณ</p><button type="button" class="wm-btn wm-btn--primary" data-act="reconnect">${icon('refresh')}เชื่อมต่อใหม่</button></div>` : ''}
      ${inspectorBody(s)}
      <div class="wm-row insp-actions">
        ${isVisual(s.kind) && !isGraphic(s.id) ? `<button type="button" class="wm-btn" data-act="send-pvw">ส่งไป PVW</button>` : ''}
        <button type="button" class="wm-btn" data-act="delete">${icon('trash')}ลบ</button>
        <button type="button" class="wm-btn wm-btn--ghost" data-act="deselect">ปรับเอาต์พุต</button>
      </div>
    </div>`;
}

function renderAll(): void {
  renderOverlayRow();
  renderRail();
  renderGallery();
  renderStrip();
  renderTally();
  renderTrans();
  renderInspector();
  renderChips();
  renderUndo();
  const name = document.getElementById('proj-name') as HTMLInputElement | null;
  if (name && document.activeElement !== name) name.value = scene.projectName;
  document.body.classList.toggle('gallery-open', ui.galleryOpen);
  document.body.classList.toggle('insp-open', ui.inspOpen);
}

/* ================= live data (Sheets / CSV) ================= */

function pollData(force = false): void {
  const now = Date.now();
  for (const s of scene.sources) {
    const url = s.props.dataUrl.trim();
    if (!url) {
      dataState.delete(s.id);
      continue;
    }
    let st = dataState.get(s.id);
    if (!st || st.url !== url) {
      st = { rows: [], error: '', at: 0, loading: false, url };
      dataState.set(s.id, st);
    }
    if (st.loading || (!force && now - st.at < REFRESH_MS)) continue;
    st.at = now;
    if (!/^https?:\/\/\S+\.\S+/i.test(url)) {
      st.error = 'ลิงก์ต้องขึ้นต้นด้วย https://';
      renderDataStatus();
      continue;
    }
    const state = st;
    state.loading = true;
    fetchRows(url, s.props.dataHeader)
      .then((rows) => {
        state.rows = rows;
        state.error = '';
        applyData(s.id);
      })
      .catch((e: unknown) => {
        state.error = e instanceof Error && e.message !== 'Failed to fetch' ? e.message : 'ดึงข้อมูลไม่ได้ ตรวจลิงก์และการแชร์ชีต';
      })
      .finally(() => {
        state.loading = false;
        renderDataStatus();
      });
  }
}

function applyData(id: string): void {
  const s = byId(id);
  const rows = dataState.get(id)?.rows ?? [];
  if (!s || !rows.length) return;
  const p = s.props;
  if (s.kind === 'score') {
    const r = rows[0];
    const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Math.max(0, parseInt(v, 10) || 0));
    Object.assign(p, { teamA: r[0] || p.teamA, scoreA: num(r[1], p.scoreA), teamB: r[2] || p.teamB, scoreB: num(r[3], p.scoreB), period: r[4] ?? p.period });
  } else if (s.kind === 'text' && p.style === 'ticker') {
    p.items = rows.map((r) => r[0]).filter(Boolean).slice(0, 100).join('\n');
  } else if (s.kind === 'text') {
    p.dataRow = Math.min(Math.max(0, p.dataRow), rows.length - 1);
    const r = rows[p.dataRow];
    p.title = r[0] ?? '';
    p.sub = r[1] ?? '';
    if (p.title) s.name = p.title;
  }
  changed(false);
  // refresh the inspector only when nobody is typing in it
  if (ui.selected === id && !$('#insp').contains(document.activeElement)) renderInspector();
}

/* ================= card menu (long press / right click) ================= */

let menuFor: string | null = null;
/** a long press just opened the menu: swallow the click that follows */
let menuSwallowClick = false;

function closeCardMenu(): void {
  document.getElementById('card-menu')?.remove();
  document.body.classList.remove('menu-open');
  const was = menuFor;
  menuFor = null;
  if (was) document.querySelector<HTMLElement>(`#strip .wm-card[data-id="${was}"]`)?.classList.remove('is-held');
}

function openCardMenu(id: string): void {
  const s = byId(id);
  const card = document.querySelector<HTMLElement>(`#strip .wm-card[data-id="${id}"]`);
  if (!s || !card) return;
  closeCardMenu();
  menuFor = id;
  card.classList.add('is-held');
  const ch = chOf(id);
  const on = ch >= 0 && scene.overlays[ch].on;
  const slate = s.kind === 'text' && s.props.style === 'slate';
  const el = document.createElement('div');
  el.id = 'card-menu';
  el.className = 'card-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', `คำสั่งของ ${s.name}`);
  el.innerHTML = `
    <div class="card-menu__head"><b>${esc(s.name)}</b>${tallyChip(s).replace(' id="insp-chip"', '')}
      <button type="button" class="wm-btn wm-btn--icon wm-btn--ghost" data-menu="close" aria-label="ปิด">${icon('close')}</button></div>
    ${slate ? '' : `<p class="card-menu__label">${ch >= 0 ? `อยู่ที่ Overlay ${ch + 1} · แตะช่องอื่นเพื่อย้าย` : 'ซ้อนบน Program ที่ช่อง'}</p>
    <div class="card-menu__grid">${scene.overlays.map((o, i) => {
      const who = byId(o.src);
      const mine = o.src === id;
      return `<button type="button" role="menuitem" class="ovl-pick${mine ? ' is-mine' : ''}${o.on ? ' is-on' : ''}" data-menu="ch" data-i="${i}" aria-pressed="${mine}"
        aria-label="Overlay ${i + 1}${who ? ` (ตอนนี้ ${esc(who.name)})` : ' ว่าง'}"><b>${i + 1}</b><span>${mine ? (o.on ? 'ออนแอร์' : 'ซ่อนอยู่') : who ? esc(who.name) : 'ว่าง'}</span></button>`;
    }).join('')}</div>`}
    <div class="card-menu__actions">
      ${ch >= 0 ? `<button type="button" role="menuitem" class="wm-btn ${on ? 'wm-btn--live' : 'wm-btn--primary'}" data-menu="toggle">${on ? 'เอาลงจากจอ' : 'ขึ้นจอ'}</button>
        <button type="button" role="menuitem" class="wm-btn" data-menu="unassign">เอาออกจาก Overlay</button>`
      : `<button type="button" role="menuitem" class="wm-btn" data-menu="pvw">ส่งไป PVW</button>
        <button type="button" role="menuitem" class="wm-btn" data-menu="cut">CUT ขึ้น PGM</button>`}
      <button type="button" role="menuitem" class="wm-btn" data-menu="edit">${icon('sliders')}ปรับค่า</button>
      <button type="button" role="menuitem" class="wm-btn" data-menu="delete">${icon('trash')}ลบ</button>
    </div>`;
  document.body.append(el);
  document.body.classList.add('menu-open');
  // float above the card on wide screens; on phones the CSS turns it into a bottom sheet
  if (!matchMedia('(max-width: 767px)').matches) {
    const r = card.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    el.style.top = `${Math.max(8, r.top - h - 8)}px`;
  }
  el.querySelector<HTMLElement>('[aria-pressed="true"], [role="menuitem"]')?.focus();
  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-menu]');
    if (!b) return;
    const act = b.dataset.menu;
    closeCardMenu();
    if (act === 'ch') {
      const i = Number(b.dataset.i);
      if (scene.overlays[i].src === id) return setOverlay(i, !scene.overlays[i].on);
      assignOverlay(id, i);
      setOverlay(i, true);
      select(id);
      renderInspector();
    } else if (act === 'toggle') toggleOverlay(id);
    else if (act === 'unassign') unassignOverlay(id);
    else if (act === 'pvw') toPreview(id);
    else if (act === 'cut') cutTo(id);
    else if (act === 'edit') {
      select(id);
      ui.inspOpen = true;
      renderInspector();
      renderStrip();
      document.body.classList.add('insp-open');
    } else if (act === 'delete') removeSource(id);
  });
}

// long press on touch (and pen / mouse held), right click with a mouse, the menu key on a focused card
{
  let timer = 0;
  let start: { x: number; y: number; id: string } | null = null;
  const strip = $('#strip');
  strip.addEventListener('pointerdown', (e) => {
    menuSwallowClick = false;
    const card = (e.target as Element).closest<HTMLElement>('.wm-card[data-id]');
    if (!card || e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, id: card.dataset.id! };
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!start) return;
      menuSwallowClick = true;
      navigator.vibrate?.(15);
      openCardMenu(start.id);
      start = null;
    }, 500);
  });
  const cancel = () => {
    window.clearTimeout(timer);
    start = null;
  };
  strip.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  strip.addEventListener('pointerup', cancel);
  strip.addEventListener('pointercancel', cancel);
  strip.addEventListener('dragstart', cancel);
  strip.addEventListener('contextmenu', (e) => {
    const card = (e.target as Element).closest<HTMLElement>('.wm-card[data-id]');
    if (!card) return;
    e.preventDefault();
    cancel();
    if (menuFor !== card.dataset.id) openCardMenu(card.dataset.id!);
  });
  strip.addEventListener('keydown', (e) => {
    const card = (e.target as Element).closest<HTMLElement>('.wm-card[data-id]');
    if (card && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      e.preventDefault();
      openCardMenu(card.dataset.id!);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (menuFor && !(e.target as Element).closest('#card-menu, #strip .wm-card.is-held')) closeCardMenu();
  }, true);
}

/* ================= toast & dialogs ================= */

let toastTimer = 0;
function toast(msg: string, action?: { label: string; run: () => void }): void {
  const host = $('#toasts');
  host.innerHTML = `<div class="wm-toast" role="status"><span class="wm-toast__msg">${esc(msg)}</span>
    ${action ? `<button type="button" class="wm-btn" data-act="toast-action">${action.label}</button>` : ''}</div>`;
  const el = host.firstElementChild as HTMLElement;
  const arm = () => {
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.remove(), 5000);
  };
  el.addEventListener('mouseenter', () => window.clearTimeout(toastTimer));
  el.addEventListener('mouseleave', arm);
  el.querySelector('[data-act="toast-action"]')?.addEventListener('click', () => {
    el.remove();
    action?.run();
  });
  arm();
}

const dlg = () => $<HTMLDialogElement>('#dlg');

function openDialog(title: string, body: string, foot: string): HTMLDialogElement {
  const d = dlg();
  d.oninput = d.onchange = d.onclick = null;
  d.innerHTML = `<form method="dialog" class="dlg__box">
    <div class="dlg__head"><h2 class="title">${title}</h2><button class="wm-btn wm-btn--icon wm-btn--ghost" value="close" aria-label="ปิด">${icon('close')}</button></div>
    <div class="dlg__body">${body}</div>
    <div class="dlg__foot">${foot}</div></form>`;
  if (!d.open) d.showModal();
  return d;
}

function openChooser(cat: Cat): void {
  const c = CATS.find((x) => x.id === cat)!;
  const tiles = tilesFor(cat);
  const d = openDialog(c.add, `<div class="chooser">${tiles.map((t) =>
    `<button type="button" class="wm-btn wm-btn--lg" data-choose="${esc(t.id)}">${icon(c.icon)}${esc(t.name)}<span class="tag">${esc(t.badge)}</span></button>`).join('')}</div>`,
  '<button class="wm-btn" value="close">ปิด</button>');
  d.querySelectorAll<HTMLElement>('[data-choose]').forEach((b) => b.addEventListener('click', () => {
    d.close();
    void tiles.find((t) => t.id === b.dataset.choose)?.run();
  }));
}

/** an empty overlay button: pick what goes on that channel, then take it */
function openChannelChooser(ch: number): void {
  const list = visuals().filter((s) => chOf(s.id) !== ch && !(s.kind === 'text' && s.props.style === 'slate'));
  if (!list.length) return toast('เพิ่มกราฟิก ข้อความ หรือแหล่งภาพก่อน แล้วเลือกใส่ Overlay นี้');
  const d = openDialog(`เลือกสิ่งที่จะซ้อนใน Overlay ${ch + 1}`, `<p class="wm-note">เลือกแล้วจะขึ้นจอทันที กดปุ่ม ${ch + 1} อีกครั้งเพื่อเอาลง · กล้องหรือวิดีโอเต็มจอจะย่อเป็นภาพซ้อนให้</p>
    <div class="chooser">${list.map((s) => {
      const cur = chOf(s.id);
      return `<button type="button" class="wm-btn wm-btn--lg" data-pick="${s.id}">${icon(s.kind === 'text' ? 'text' : needsMedia(s.kind) ? 'source' : 'graphic')}${esc(s.name)}${cur >= 0 ? `<span class="tag">OVL ${cur + 1}</span>` : ''}</button>`;
    }).join('')}</div>`,
  '<button class="wm-btn" value="close">ปิด</button>');
  d.querySelectorAll<HTMLElement>('[data-pick]').forEach((b) => b.addEventListener('click', () => {
    d.close();
    const id = b.dataset.pick!;
    assignOverlay(id, ch);
    setOverlay(ch, true);
    select(id);
    renderInspector();
  }));
}

function openPipChooser(): void {
  const list = visuals().filter((s) => !isGraphic(s.id) && needsMedia(s.kind));
  if (!list.length) return toast('เพิ่มกล้อง หน้าจอ หรือวิดีโอก่อน แล้วเลือกเป็นภาพซ้อน');
  const d = openDialog('เลือกภาพซ้อน (PIP)', `<p class="wm-note">ภาพที่เลือกจะย่อลงมุมขวาล่างและขึ้นเป็น Overlay ปรับตำแหน่ง ครอป และขอบได้ในแผงขวา</p>
    <div class="chooser">${list.map((s) => `<button type="button" class="wm-btn wm-btn--lg" data-pip="${s.id}">${icon('source')}${esc(s.name)}</button>`).join('')}</div>`,
  '<button class="wm-btn" value="close">ปิด</button>');
  d.querySelectorAll<HTMLElement>('[data-pip]').forEach((b) => b.addEventListener('click', () => {
    d.close();
    const id = b.dataset.pip!;
    mutate((sc) => {
      const t = sc.sources.find((x) => x.id === id);
      if (t) Object.assign(t.props, { scale: 0.32, x: 0.58, y: 0.5, border: 4, fit: 'cover' });
    });
    assignOverlay(id);
    const ch = chOf(id);
    if (ch >= 0) setOverlay(ch, true);
    select(id);
    renderInspector();
  }));
}

const livePanel = createLivePanel({
  openDialog,
  closeDialog: () => dlg().close(),
  toast: (m) => toast(m),
  esc,
  canvas: () => pgmCtx.canvas,
  output: () => ({ fps: scene.fps, height: OUTPUT_SIZE[scene.resolution][1] }),
  onChange: () => {
    renderChips();
    if (livePanel.gateway && studio && !studio.sig) void refreshStudioSignal();
  },
});

function openLive(platform?: Platform): void {
  livePanel.open(platform);
}

/* ================= phone cameras and remote guests ================= */

let studio: Studio | null = null;
/** clientId → PeerJS id of the device, for tally */
const callers = new Map<string, Caller>();

async function refreshStudioSignal(): Promise<void> {
  if (!studio || !livePanel.gateway) return;
  const sig = await signalFromGateway(livePanel.gateway);
  if (sig && JSON.stringify(sig) !== JSON.stringify(studio.sig)) {
    studio.destroy();
    studio.sig = sig;
    await studio.start();
  }
}

function ensureStudio(): Studio {
  if (studio) return studio;
  studio = new Studio({
    onStatus: () => renderRemoteDialog(),
    returnFeed: (clientId) => {
      const video = pgmCtx.canvas.captureStream(30).getVideoTracks();
      const id = scene.sources.find((x) => x.kind === 'remote' && x.deviceId === clientId)?.id ?? `guest:${clientId}`;
      return new MediaStream([...video, ...mixMinus(id).getAudioTracks()]);
    },
    onStream: (caller, stream) => {
      callers.set(caller.clientId, caller);
      const existing = scene.sources.find((x) => x.kind === 'remote' && x.deviceId === caller.clientId);
      const m: Media = { stream, el: videoForStream(stream) };
      if (existing) {
        // the same phone / guest coming back: keep its card, position and settings
        free(existing.id);
        attachStreamAudio(m, stream, existing.id);
        media.set(existing.id, m);
        if (caller.name && caller.name !== existing.name) {
          existing.name = caller.name;
          changed(false);
        }
        toast(`${existing.name} เชื่อมต่อกลับมาแล้ว`);
      } else {
        const label = caller.kind === 'guest' ? 'แขก' : 'มือถือ';
        const s = newSource('remote', caller.name || `${label} ${scene.sources.filter((x) => x.kind === 'remote').length + 1}`, caller.kind === 'guest' ? 'แขกทางไกล' : 'มือถือ');
        s.deviceId = caller.clientId;
        // a guest's return feed was built before the card existed: rebuild it under the card's id
        dropMixMinus(`guest:${caller.clientId}`);
        attachStreamAudio(m, stream, s.id);
        addSource(s, m);
      }
      sendTally();
      if (dlg().open && document.getElementById('remote-qr')) dlg().close();
      renderStrip();
    },
    onLeave: (caller) => {
      const s = scene.sources.find((x) => x.kind === 'remote' && x.deviceId === caller.clientId);
      if (s) {
        const m = media.get(s.id);
        if (m) releaseStrip(m);
        release(s.id);
        toast(`${s.name} วางสายแล้ว การ์ดยังอยู่ ให้เปิดลิงก์เดิมเพื่อกลับเข้ามา`);
        renderInspector();
      }
    },
  }, signalFromLocation());
  void studio.start();
  if (livePanel.gateway) void refreshStudioSignal();
  return studio;
}

let lastTally = '';
function sendTally(): void {
  if (!studio) return;
  const key = JSON.stringify([scene.pgm, scene.pvw, scene.overlays.map((o) => o.on && o.src)]);
  if (key === lastTally) return;
  lastTally = key;
  for (const s of scene.sources) {
    if (s.kind !== 'remote' || !s.deviceId) continue;
    const c = callers.get(s.deviceId);
    if (c) studio.tally(c.peerId, onAir(s.id) ? 'pgm' : scene.pvw === s.id ? 'pvw' : 'off');
  }
}

let remoteKind: RemoteKind = 'phone';
let remoteName = '';

function openRemote(kind: RemoteKind, name = ''): void {
  remoteKind = kind;
  remoteName = name;
  ensureStudio();
  renderRemoteDialog(true);
}

function remoteState(): { link: string; qr: string; status: string; error: boolean } {
  const st = studio;
  const link = st?.status === 'ready' ? st.link(remoteKind, remoteName) : '';
  let qr = '';
  if (link) {
    const q = qrcode(0, 'M');
    q.addData(link);
    q.make();
    qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }
  const guest = remoteKind === 'guest';
  const status = !st || st.status === 'connecting' ? 'กำลังเตรียมสตูดิโอ…'
    : st.status === 'unavailable' ? 'โหลดระบบเชื่อมต่อไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง'
      : st.status === 'offline' ? 'เชื่อมต่อเซิร์ฟเวอร์จับคู่ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง'
        : guest ? 'ส่งลิงก์ให้แขกทาง LINE หรืออีเมล แขกจะเห็นและได้ยินรายการ (ไม่ได้ยินเสียงตัวเอง)' : 'สแกน QR ด้วยมือถือ แล้วกดเชื่อมต่อ ภาพจะขึ้นเป็นการ์ดใหม่';
  return { link, qr, status, error: !!st && ['offline', 'unavailable'].includes(st.status) };
}

/** refresh the QR, link and status in place: never rebuilds the name field someone may be typing in */
function renderRemoteDialog(force = false): void {
  const box = document.getElementById('remote-qr');
  if (!force && !box) return;
  const r = remoteState();
  if (box && !force) {
    box.querySelector('.remote__qr')!.innerHTML = r.qr || '<span class="wm-note">รอสักครู่…</span>';
    (box.querySelector('#remote-link') as HTMLInputElement).value = r.link;
    (box.querySelector('#remote-copy') as HTMLButtonElement).disabled = !r.link;
    const st = box.querySelector('#remote-status')!;
    st.textContent = r.status;
    st.classList.toggle('wm-help--err', r.error);
    return;
  }
  const guest = remoteKind === 'guest';
  const body = `<div class="remote" id="remote-qr">
      ${guest ? `<label class="wm-field"><span>ชื่อแขก</span><input class="wm-input" id="guest-name" value="${esc(remoteName)}" placeholder="เช่น คุณสมชาย" autocomplete="off"></label>` : ''}
      <div class="remote__qr" aria-label="QR Code สำหรับเชื่อมต่อ">${r.qr || '<span class="wm-note">รอสักครู่…</span>'}</div>
      <div class="key-row"><input class="wm-input" id="remote-link" readonly value="${esc(r.link)}" aria-label="ลิงก์เชื่อมต่อ">
        <button type="button" class="wm-btn" id="remote-copy" ${r.link ? '' : 'disabled'}>คัดลอก</button></div>
      <p class="wm-help ${r.error ? 'wm-help--err' : ''}" id="remote-status">${r.status}</p>
      <p class="wm-note">ไม่มี Stream Gateway ใช้ระบบจับคู่สาธารณะของ PeerJS ได้กับ Wi-Fi ส่วนใหญ่ ถ้ามือถือใช้ 4G / 5G แล้วต่อไม่ติด ให้ตั้ง Gateway (มี TURN) ในหน้าไลฟ์</p>
    </div>`;
  const d = openDialog(guest ? 'เชิญแขกทางไกล' : 'เพิ่มกล้องมือถือ', body, '<button class="wm-btn" value="close">ปิด</button>');
  d.querySelector('#remote-copy')?.addEventListener('click', () => {
    const v = (d.querySelector('#remote-link') as HTMLInputElement).value;
    void navigator.clipboard?.writeText(v).then(() => toast('คัดลอกลิงก์แล้ว'), () => toast('คัดลอกไม่ได้ กดค้างที่ลิงก์เพื่อคัดลอกเอง'));
  });
  d.querySelector('#guest-name')?.addEventListener('input', (e) => {
    remoteName = (e.target as HTMLInputElement).value.trim();
    renderRemoteDialog();
  });
}

function openSettings(): void {
  openDialog('ตั้งค่า', `
    <section class="set-sec"><h3 class="label">คีย์ลัด</h3>
      <dl class="keys-list">
        <dt><kbd class="wm-kbd">SPACE</kbd></dt><dd>CUT ตัดภาพทันที</dd>
        <dt><kbd class="wm-kbd">ENTER</kbd></dt><dd>AUTO เปลี่ยนภาพตามทรานซิชัน (MIX, DIP, WIPE)</dd>
        <dt><kbd class="wm-kbd">B</kbd></dt><dd>FTB จอดำ เปิด / ปิด</dd>
        <dt><kbd class="wm-kbd">1–9</kbd></dt><dd>ส่งแหล่งภาพไป PVW · กดเลขเดิมอีกครั้งเพื่อ CUT</dd>
        <dt><kbd class="wm-kbd">⌘Z</kbd> <kbd class="wm-kbd">⇧⌘Z</kbd></dt><dd>ย้อนกลับ / ทำซ้ำ</dd>
        <dt><kbd class="wm-kbd">DEL</kbd></dt><dd>ลบแหล่งภาพที่เลือก</dd>
      </dl></section>
    <section class="set-sec"><h3 class="label">ฉาก</h3>
      <p class="wm-note">ฉากบันทึกในเบราว์เซอร์นี้อัตโนมัติ กล้องและหน้าจอต้องเชื่อมต่อใหม่หลังเปิดหน้าอีกครั้ง ไฟล์วิดีโอต้องเลือกใหม่</p>
      <button type="button" class="wm-btn" id="clear-scene">${icon('trash')}ล้างฉากทั้งหมด</button></section>`,
  '<button class="wm-btn wm-btn--primary" value="close">เสร็จ</button>');
  $('#clear-scene', dlg()).addEventListener('click', () => {
    dlg().close();
    if (!scene.sources.length) return toast('ฉากว่างอยู่แล้ว');
    const ids = scene.sources.map((s) => s.id);
    mutate((sc) => {
      sc.sources = [];
      sc.pgm = null;
      sc.pvw = null;
    }, { toast: 'ล้างฉากแล้ว' });
    ui.selected = null;
    renderInspector();
    window.setTimeout(() => ids.forEach((id) => !byId(id) && free(id)), 8000);
  });
}

/* ================= recording ================= */

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function toggleRecord(): Promise<void> {
  if (ui.recorder) {
    const rec = ui.recorder;
    ui.recorder = null;
    renderChips();
    const blob = await rec.stop();
    const ext = rec.mime.includes('mp4') ? 'mp4' : 'webm';
    const name = `webmix-${stamp()}.${ext}`;
    download(blob, name);
    toast(`บันทึกไฟล์ ${name} แล้ว (${(blob.size / 1e6).toFixed(1)} MB)`);
    return;
  }
  if (typeof MediaRecorder === 'undefined') return toast('เบราว์เซอร์นี้บันทึกวิดีโอไม่ได้ ลองใช้ Chrome หรือ Edge');
  try {
    ui.recorder = new Recorder($<HTMLCanvasElement>('#cv-pgm'), scene.fps);
    renderChips();
  } catch {
    toast('เริ่มบันทึกไม่ได้ ลองลดความละเอียดเป็น 720p แล้วลองอีกครั้ง');
  }
}

/* ================= render loop ================= */

const pvwCtx = $<HTMLCanvasElement>('#cv-pvw').getContext('2d')!;
const pgmCtx = $<HTMLCanvasElement>('#cv-pgm').getContext('2d')!;
let lastThumb = 0;
let lastChip = 0;
let lastFrame = performance.now();
let lastPoll = 0;
let lastLufs = 0;
let lastLiveTick = 0;

const peakHold = new Map<string, { db: number; t: number }>();

function paintMeters(now: number): void {
  const mm = masterMeter();
  const chip = document.getElementById('meter-master');
  if (chip) chip.style.width = `${bar(mm.rms) * 100}%`;
  const read = (id: string) => (id === 'master' ? mm : meter(media.get(id)?.strip?.analyser));
  document.querySelectorAll<HTMLElement>('[data-meterbox]').forEach((box) => {
    const id = box.dataset.meterbox!;
    const { peak, rms } = read(id);
    const hold = peakHold.get(id);
    // hold the peak 1.5 s, then let it fall 20 dB/s
    const held = !hold || peak >= hold.db ? { db: peak, t: now } : now - hold.t < 1500 ? hold : { db: Math.max(peak, hold.db - ((now - hold.t - 1500) / 1000) * 20), t: hold.t };
    peakHold.set(id, held);
    (box.firstElementChild as HTMLElement).style.width = `${bar(rms) * 100}%`;
    (box.lastElementChild as HTMLElement).style.left = `${bar(held.db) * 100}%`;
    box.classList.toggle('is-hot', held.db > -6);
    box.classList.toggle('is-clip', held.db > -0.5);
    box.dataset.db = Number.isFinite(peak) ? peak.toFixed(1) : '-inf';
  });
  if (now - lastLufs > 250) {
    lastLufs = now;
    const l = loudness();
    const chipL = document.getElementById('chip-lufs');
    if (chipL) chipL.textContent = `${fmtLufs(l.s)} LUFS`;
    document.querySelectorAll<HTMLElement>('[data-lufs]').forEach((el) => {
      el.textContent = fmtLufs(l[el.dataset.lufs as 'm' | 's' | 'i']);
    });
    const lim = document.querySelector<HTMLElement>('.lim-btn');
    lim?.classList.toggle('is-active', limiterReduction() < -0.5);
  }
}

function renderTransport(): void {
  const el = media.get(ui.selected ?? '')?.el;
  const out = document.getElementById('tp-time');
  const seek = document.querySelector<HTMLInputElement>('#seek');
  if (!(el instanceof HTMLMediaElement) || !out || !seek) return;
  const d = Number.isFinite(el.duration) ? el.duration : 0;
  out.textContent = `${fmtTime(el.currentTime * 1000)} / ${fmtTime(d * 1000)}`;
  if (document.activeElement !== seek) seek.value = String(d ? Math.round((el.currentTime / d) * 1000) : 0);
}

function resizeOutput(): void {
  const c = pgmCtx.canvas;
  const [w, h] = OUTPUT_SIZE[scene.resolution] ?? OUTPUT_SIZE['720p'];
  if (c.width !== w) {
    if (ui.recorder) return; // never resize mid-recording
    c.width = w;
    c.height = h;
  }
}

function frame(now: number): void {
  if (trans && trans.manual === undefined && transitionProgress(trans, now) >= 1) finishTransition();
  if (ftb.level !== ftb.target) {
    const step = (now - lastFrame) / Math.max(100, scene.duration);
    ftb.level = ftb.target > ftb.level ? Math.min(1, ftb.level + step) : Math.max(0, ftb.level - step);
  }
  lastFrame = now;
  const ls = layers(now);
  drawBus(pgmCtx, scene, scene.pgm, trans, now, ftb.level, ls);
  drawBus(pvwCtx, scene, scene.pvw, null, now, 0, previewLayers(ls));
  updateAudio(scene, onAir);
  followAir();
  paintWindows(pgmCtx.canvas, pvwCtx.canvas, scene, now);

  // live thumbnails at ~30 fps (15 fps once there are many cards)
  if (now - lastThumb > (thumbs.size > 8 ? 66 : 33)) {
    lastThumb = now;
    document.querySelectorAll<HTMLCanvasElement>('#strip canvas[data-thumb]').forEach((cv) => {
      const s = byId(cv.dataset.thumb!);
      const ctx = cv.getContext('2d');
      if (!s || !ctx) return;
      ctx.fillStyle = tk('card-ground');
      ctx.fillRect(0, 0, cv.width, cv.height);
      drawSource(ctx, s, cv.width, cv.height);
      if ((s.kind === 'video' || s.kind === 'playlist') && !isGraphic(s.id)) {
        const sub = cv.closest('.wm-card')?.querySelector('.wm-card__sub');
        const line = playbackLine(s);
        if (sub && sub.textContent !== line) sub.textContent = line;
      }
    });
  }
  paintMeters(now);
  if (now - lastPoll > 1000) {
    lastPoll = now;
    pollData();
    const tv = document.getElementById('timer-val');
    const ts = byId(ui.selected);
    if (tv && ts?.kind === 'timer') tv.textContent = fmtClock(timerValue(ts));
  }
  if (now - lastLiveTick > 1000) {
    lastLiveTick = now;
    const t = document.getElementById('live-time');
    const since = livePanel.streamer?.startedAt;
    if (t && since) t.textContent = fmtTime(Date.now() - since);
    sendTally();
  }
  if (ui.recorder && now - lastChip > 500) {
    lastChip = now;
    const t = document.getElementById('rec-time');
    if (t) t.textContent = fmtTime(now - ui.recorder.started);
  }
  requestAnimationFrame(frame);
}

/* ================= events ================= */

function setProp(path: string, value: unknown, live: boolean): void {
  const [scope, key] = path.split(':');
  mutate((sc) => {
    if (scope === 'g') {
      (sc as unknown as Record<string, unknown>)[key] = value;
      return;
    }
    if (scope === 'o') {
      const ch = sc.overlays.findIndex((o) => o.src === ui.selected);
      if (ch >= 0) (sc.overlays[ch] as unknown as Record<string, unknown>)[key] = value;
      return;
    }
    const s = sc.sources.find((x) => x.id === ui.selected);
    if (!s) return;
    if (scope === 'n') s.name = String(value) || s.name;
    else {
      (s.props as unknown as Record<string, unknown>)[key] = value;
      if (s.kind === 'text' && key === 'title' && String(value)) s.name = String(value);
    }
  }, { coalesce: live ? `${path}@${ui.selected}` : undefined, silent: live });
  if (path === 'g:transition' || path === 'g:duration') renderTrans();
  if (path === 'g:resolution') renderChips();
}

let lastTap = { id: '', t: 0 };
let lastKey = { key: '', t: 0 };

const actions: Record<string, (el: HTMLElement, e: MouseEvent) => void> = {
  undo,
  redo,
  settings: openSettings,
  record: () => void toggleRecord(),
  live: () => openLive(),
  cut,
  auto,
  cat: (el) => {
    const cat = el.dataset.cat as Cat;
    const sheet = matchMedia('(max-width: 1199px)').matches;
    if (sheet && ui.cat === cat && ui.galleryOpen) ui.galleryOpen = false;
    else ui.galleryOpen = true;
    if (ui.cat !== cat) ui.query = '';
    ui.cat = cat;
    ui.inspOpen = false;
    renderRail();
    renderGallery();
    document.body.classList.toggle('gallery-open', ui.galleryOpen);
    document.body.classList.remove('insp-open');
  },
  filter: (el) => {
    ui.filter[ui.cat] = el.dataset.val;
    el.parentElement!.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
    renderGalleryGrid();
  },
  'new-tile': () => newTileAction(ui.cat),
  tile: (el) => void tilesFor(ui.cat).find((t) => t.id === el.dataset.tile)?.run(),
  card: (el) => {
    const id = el.dataset.id!;
    if (menuSwallowClick) {
      menuSwallowClick = false;
      return;
    }
    const now = performance.now();
    if (lastTap.id === id && now - lastTap.t < 350) {
      lastTap = { id: '', t: 0 };
      cutTo(id);
    } else {
      lastTap = { id, t: now };
      toPreview(id);
    }
  },
  trans: (el) => {
    scene.transition = el.dataset.val as Scene['transition'];
    changed(false);
    renderTrans();
  },
  tab: (el) => {
    ui.tab = el.dataset.val!;
    renderInspector();
  },
  advanced: () => {
    ui.advanced = !ui.advanced;
    renderInspector();
  },
  switch: (el) => {
    const prop = el.dataset.prop!;
    const on = el.getAttribute('aria-checked') !== 'true';
    if (prop === 'ftb') return toggleFtb();
    if (prop === 'ovl') return ui.selected ? toggleOverlay(ui.selected) : undefined;
    setProp(prop, on, false);
    if (prop === 'p:loop' && ui.selected) {
      const m = media.get(ui.selected);
      if (m?.el instanceof HTMLMediaElement && !m.list) m.el.loop = on;
    }
  },
  seg: (el) => {
    const prop = el.dataset.prop!;
    setProp(prop, el.dataset.num ? Number(el.dataset.val) : el.dataset.val, false);
    if (prop === 'p:res' && ui.selected) void reconnect(ui.selected);
  },
  ftb: toggleFtb,
  ovl: (el) => {
    const i = Number(el.dataset.i);
    if (!scene.overlays[i].src) return openChannelChooser(i);
    setOverlay(i, !scene.overlays[i].on);
  },
  'ovl-assign': () => {
    if (!ui.selected) return;
    assignOverlay(ui.selected);
    renderInspector();
  },
  'ovl-remove': () => {
    if (!ui.selected) return;
    unassignOverlay(ui.selected);
    renderInspector();
  },
  'timer-run': () => {
    const t = byId(ui.selected);
    if (!t) return;
    const p = t.props;
    if (p.timerStart) {
      p.timerAcc += Date.now() - p.timerStart;
      p.timerStart = 0;
    } else {
      if (p.timerMode === 'down' && timerValue(t) <= 0) p.timerAcc = 0;
      p.timerStart = Date.now();
    }
    changed(false);
    renderInspector();
  },
  'timer-reset': () => {
    const t = byId(ui.selected);
    if (!t) return;
    t.props.timerAcc = 0;
    if (t.props.timerStart) t.props.timerStart = Date.now();
    changed(false);
    renderInspector();
  },
  score: (el) => {
    const t = byId(ui.selected);
    if (!t) return;
    const key = el.dataset.team === 'B' ? 'scoreB' : 'scoreA';
    t.props[key] = Math.max(0, t.props[key] + Number(el.dataset.d));
    changed(false);
    renderInspector();
  },
  'score-reset': () => {
    const t = byId(ui.selected);
    if (!t) return;
    mutate((sc) => {
      const x = sc.sources.find((y) => y.id === t.id);
      if (x) Object.assign(x.props, { scoreA: 0, scoreB: 0 });
    }, { toast: 'ล้างคะแนนแล้ว' });
  },
  'preset-save': () => {
    const t = byId(ui.selected);
    if (!t || !t.props.title.trim()) return toast('พิมพ์หัวเรื่องก่อน แล้วบันทึกป้าย');
    const list = loadPresets().filter((x) => x.title !== t.props.title || x.sub !== t.props.sub);
    savePresets([{ title: t.props.title, sub: t.props.sub, tone: t.props.tone }, ...list]);
    toast(`บันทึกป้าย ${t.props.title} แล้ว`);
    renderInspector();
  },
  preset: (el) => {
    const x = loadPresets()[Number(el.dataset.i)];
    const id = ui.selected;
    if (!x || !id) return;
    mutate((sc) => {
      const t = sc.sources.find((y) => y.id === id);
      if (t) {
        Object.assign(t.props, { title: x.title, sub: x.sub, tone: x.tone });
        t.name = x.title;
      }
    }, { toast: `เปลี่ยนเป็น ${x.title} แล้ว` });
  },
  'preset-del': (el) => {
    const list = loadPresets();
    const [gone] = list.splice(Number(el.dataset.i), 1);
    savePresets(list);
    renderInspector();
    if (gone) toast(`ลบป้าย ${gone.title} แล้ว`, { label: 'ย้อนกลับ', run: () => { savePresets([gone, ...loadPresets()]); renderInspector(); } });
  },
  'data-refresh': () => pollData(true),
  'data-row': (el) => {
    const t = byId(ui.selected);
    const rows = t ? dataState.get(t.id)?.rows ?? [] : [];
    if (!t || !rows.length) return toast('ยังไม่มีข้อมูลจากชีต ตรวจลิงก์ก่อน');
    t.props.dataRow = (t.props.dataRow + Number(el.dataset.d) + rows.length) % rows.length;
    applyData(t.id);
    renderInspector();
  },
  play: () => {
    const el = media.get(ui.selected ?? '')?.el;
    if (!(el instanceof HTMLMediaElement)) return;
    if (el.paused) void el.play().catch(() => toast('เล่นไฟล์นี้ไม่ได้ ลองเลือกไฟล์ใหม่'));
    else el.pause();
    renderInspector();
  },
  restart: () => {
    const el = media.get(ui.selected ?? '')?.el;
    if (el instanceof HTMLMediaElement) {
      el.currentTime = 0;
      void el.play().catch(() => undefined);
      renderInspector();
    }
  },
  'pl-prev': () => ui.selected && playlistGo(ui.selected, (media.get(ui.selected)?.index ?? 0) - 1),
  'pl-next': () => ui.selected && playlistGo(ui.selected, (media.get(ui.selected)?.index ?? 0) + 1),
  'pl-go': (el) => ui.selected && playlistGo(ui.selected, Number(el.dataset.i)),
  'pl-add': () => void (async () => {
    const id = ui.selected;
    const m = id ? media.get(id) : undefined;
    if (!id || !m?.list) return;
    const files = await pickFiles('video/*');
    if (!files.length) return;
    m.list.push(...files.map((f) => ({ url: URL.createObjectURL(f), name: f.name })));
    void getFiles(id).then((old) => putFiles(id, [...(old ?? []), ...files.map((f) => ({ name: f.name, type: f.type, blob: f as Blob }))]));
    mutate((sc) => {
      const t = sc.sources.find((x) => x.id === id);
      if (t) t.meta = `${m.list!.length} ไฟล์`;
    }, { toast: `เพิ่ม ${files.length} ไฟล์ในเพลย์ลิสต์แล้ว` });
  })(),
  'out-window': () => {
    if (!openOutput(OUTPUT_SIZE[scene.resolution])) toast('เบราว์เซอร์บล็อกหน้าต่างใหม่ อนุญาตป๊อปอัปสำหรับเว็บนี้แล้วลองอีกครั้ง');
    renderInspector();
  },
  multiview: () => {
    if (!openMultiview()) toast('เบราว์เซอร์บล็อกหน้าต่างใหม่ อนุญาตป๊อปอัปสำหรับเว็บนี้แล้วลองอีกครั้ง');
    renderInspector();
  },
  fullscreen: () => void $('#mon-pgm').requestFullscreen?.().catch(() => toast('เบราว์เซอร์นี้เปิดเต็มจอไม่ได้')),
  snapshot: () => {
    pgmCtx.canvas.toBlob((blob) => {
      if (!blob) return toast('ถ่ายภาพนิ่งไม่ได้ ลองอีกครั้ง');
      download(blob, `webmix-${stamp()}.png`);
      toast('บันทึกภาพนิ่งแล้ว');
    }, 'image/png');
  },
  'reset-props': () => {
    const s = byId(ui.selected);
    if (!s) return;
    mutate((sc) => {
      const t = sc.sources.find((x) => x.id === s.id);
      if (t) Object.assign(t.props, { scale: 1, opacity: 1, flip: false, x: 0, y: 0, filter: '', cropL: 0, cropR: 0, cropT: 0, cropB: 0, border: 0, key: 'off' });
    }, { toast: `คืนค่าเริ่มต้นของ ${s.name} แล้ว` });
  },
  delete: () => ui.selected && removeSource(ui.selected),
  deselect: () => {
    select(null);
    renderInspector();
    renderTally();
  },
  'send-pvw': () => ui.selected && toPreview(ui.selected),
  reconnect: () => ui.selected && void reconnect(ui.selected),
  select: (el) => {
    select(el.dataset.id!);
    ui.tab = 'เสียง';
    ui.inspOpen = true;
    renderInspector();
    document.body.classList.add('insp-open');
  },
  mon: (el) => {
    const t = byId(el.dataset.id!);
    if (!t) return;
    ensureAudio();
    t.props.mon = !t.props.mon;
    changed(false);
    renderGalleryExtra();
    if (t.props.mon) toast(`ฟัง ${t.name} ในหูฟังแล้ว ใส่หูฟังเพื่อไม่ให้เสียงหอน`);
  },
  limiter: () => {
    setProp('g:limiter', !scene.limiter, false);
    toast(scene.limiter ? 'เปิดลิมิตเตอร์ที่ Master' : 'ปิดลิมิตเตอร์ ระวังเสียงแตกเมื่อเกิน 0 dB');
  },
  'lufs-reset': () => {
    resetLoudness();
    toast('เริ่มวัดความดัง Integrated ใหม่');
  },
  mute: (el) => {
    const id = el.dataset.id!;
    mutate((sc) => {
      const t = sc.sources.find((x) => x.id === id);
      if (t) t.props.muted = !t.props.muted;
    });
  },
  'open-insp': () => {
    ui.inspOpen = true;
    ui.galleryOpen = false;
    document.body.classList.add('insp-open');
    document.body.classList.remove('gallery-open');
  },
  'close-sheets': closeSheets,
};

function mutateBusAfterOverlay(id: string): void {
  // an overlay is not a bus source: hand its bus slot to something else
  if (scene.pgm === id || scene.pvw === id) {
    const rest = visuals().filter((x) => !isGraphic(x.id));
    if (scene.pgm === id) scene.pgm = rest[0]?.id ?? null;
    if (scene.pvw === id || scene.pvw === scene.pgm) scene.pvw = rest.find((x) => x.id !== scene.pgm)?.id ?? null;
    changed(false);
  }
}

function closeSheets(): void {
  ui.galleryOpen = false;
  ui.inspOpen = false;
  document.body.classList.remove('gallery-open', 'insp-open');
}

document.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el || el.closest('dialog')) return;
  const fn = actions[el.dataset.act!];
  if (!fn) return;
  fn(el, e);
  // pointer clicks should not leave focus on a control, so Space / Enter stay CUT / AUTO
  if (e.detail > 0 && document.activeElement instanceof HTMLElement && document.activeElement.matches('button, [role="button"]')) {
    document.activeElement.blur();
  }
});

$('#scrim').addEventListener('click', () => {
  closeCardMenu();
  closeSheets();
});

document.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'tbar') return onTbar(Number(t.value));
  if (t.id === 'seek') {
    const el = media.get(ui.selected ?? '')?.el;
    if (el instanceof HTMLMediaElement && Number.isFinite(el.duration)) el.currentTime = (Number(t.value) / 1000) * el.duration;
    return;
  }
  if (t.id === 'q') {
    ui.query = t.value;
    renderGalleryGrid();
    return;
  }
  if (t.dataset.mix) {
    const id = t.dataset.mix;
    mutate((sc) => {
      const s = sc.sources.find((x) => x.id === id);
      if (s) s.props.volume = Number(t.value) / 100;
    }, { coalesce: `mix@${id}`, silent: true });
    const out = document.querySelector(`[data-db="${id}"]`);
    if (out) out.textContent = fmtDb(Number(t.value) / 100);
    return;
  }
  const prop = t.dataset.prop;
  if (!prop || t.closest('dialog')) return;
  if (t.type === 'number') {
    setProp(prop, Math.max(0, Number(t.value) || 0) * Number(t.dataset.mul ?? 1), true);
    return;
  }
  if (t.type === 'range') {
    const div = Number(t.dataset.div ?? 1);
    setProp(prop, Number(t.value) / div, true);
    const out = t.parentElement?.querySelector('output');
    if (out) out.textContent = fmt(Number(t.value), t.dataset.unit ?? '%');
    if (prop === 'g:master') {
      const db = document.getElementById('db-master');
      if (db) db.textContent = fmtDb(Number(t.value) / 100);
    }
  } else {
    setProp(prop, t.value, true);
    if (prop.startsWith('n:') || prop === 'p:title') {
      const title = document.querySelector('.wm-insp__title');
      const s = byId(ui.selected);
      if (title && s) title.textContent = s.name;
    }
  }
});

document.addEventListener('change', (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.dataset.sink) {
    void setOutputDevice(t.value).then((ok) => {
      if (!ok) return toast('เปลี่ยนลำโพงไม่ได้ ใช้ค่าเริ่มต้นของเครื่อง');
      setProp('g:sinkId', t.value, false);
      toast('เปลี่ยนอุปกรณ์ฟังเสียงแล้ว');
    });
    return;
  }
  const id = ui.selected;
  if (!t.dataset.ovl || !id) return;
  if (t.dataset.ovl === 'ch') {
    assignOverlay(id, Number(t.value));
  } else {
    mutate((sc) => {
      const o = sc.overlays.find((x) => x.src === id);
      if (o) o.fx = t.value as OverlayFx;
    });
  }
  renderInspector();
});

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (dlg().open) return;
  const typing = t.matches('input:not([type="range"]), textarea, select, [contenteditable="true"]');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    if (typing) return;
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && e.key === 'y') {
    if (typing) return;
    e.preventDefault();
    return redo();
  }
  if (typing || mod || e.altKey) return;
  const onControl = t.matches('button, [role="button"], a, input');
  if (e.key === 'Escape') {
    if (menuFor) return closeCardMenu();
    return closeSheets();
  }
  if (e.code === 'Space' && !onControl) {
    e.preventDefault();
    return cut();
  }
  if (e.key === 'Enter') {
    if (onControl) {
      if (t.dataset.act === 'card' || t.dataset.act === 'tile') {
        e.preventDefault();
        t.click();
      }
      return;
    }
    e.preventDefault();
    return auto();
  }
  if (e.key === 'b' || e.key === 'B') return toggleFtb();
  const digit = /^Digit([1-8])$/.exec(e.code);
  if (digit && e.shiftKey) {
    e.preventDefault();
    const i = Number(digit[1]) - 1;
    if (!scene.overlays[i].src) return openChannelChooser(i);
    return setOverlay(i, !scene.overlays[i].on);
  }
  if (/^[1-9]$/.test(e.key)) {
    const s = cutSources()[Number(e.key) - 1];
    if (!s) return;
    if (isGraphic(s.id)) return toggleOverlay(s.id);
    const now = performance.now();
    const again = lastKey.key === e.key && now - lastKey.t < 1000;
    lastKey = { key: again ? '' : e.key, t: now };
    if (again) cutTo(s.id);
    else toPreview(s.id);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selected) {
    e.preventDefault();
    removeSource(ui.selected);
  }
});

/* ---------- drag and drop ---------- */

const TILE_MIME = 'application/x-wm-tile';
const CARD_MIME = 'application/x-wm-card';

document.addEventListener('dragstart', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-tile], .wm-card[data-id]');
  if (!el || !e.dataTransfer) return;
  if (el.dataset.tile) e.dataTransfer.setData(TILE_MIME, `${ui.cat}|${el.dataset.tile}`);
  else e.dataTransfer.setData(CARD_MIME, el.dataset.id!);
  e.dataTransfer.effectAllowed = 'copyMove';
  el.classList.add('is-dragging');
});
document.addEventListener('dragend', (e) => (e.target as Element).closest?.('.is-dragging')?.classList.remove('is-dragging'));

document.querySelectorAll<HTMLElement>('[data-drop]').forEach((zone) => {
  zone.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes(TILE_MIME) && !types.includes(CARD_MIME)) return;
    e.preventDefault();
    zone.classList.add('is-drop');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-drop'));
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('is-drop');
    const target = zone.dataset.drop as Target;
    const tile = e.dataTransfer?.getData(TILE_MIME);
    const card = e.dataTransfer?.getData(CARD_MIME);
    if (!tile && !card) return;
    e.preventDefault();
    if (tile) {
      const [cat, id] = tile.split('|');
      void tilesFor(cat as Cat).find((t) => t.id === id)?.run(target);
    } else if (card) {
      if (target === 'pvw') toPreview(card);
      else if (target === 'pgm') cutTo(card);
    }
  });
});

/* ================= boot ================= */

renderTop();
renderAll();
for (const s of scene.sources) ensureMedia(s, true);
if (scene.sinkId) void setOutputDevice(scene.sinkId);
void pruneFiles(new Set(scene.sources.map((s) => s.id)));
// restored clips build their audio before any click; wake the audio engine on the first one
document.addEventListener('pointerdown', () => ensureAudio(), { once: true, capture: true });
if (scene.sources.some((s) => s.kind === 'remote')) ensureStudio();
window.addEventListener('beforeunload', (e) => {
  if (livePanel.live || ui.recorder) e.preventDefault();
});
void refreshDevices();
navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());
requestAnimationFrame(frame);

// small read-only handle for diagnostics and end-to-end tests
Object.defineProperty(window, '__webmix', {
  value: { get scene() { return clone(scene); }, undoDepth: () => undoStack.length },
});
