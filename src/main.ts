import '../design/components/bundle.css';
import '../design/tokens.css';
import './app.css';
import { icon, logo, type IconName } from './icons';
import {
  clone, defaultProps, isVisual, loadScene, needsMedia, OUTPUT_SIZE, saveScene, uid,
  type Kind, type Props, type Resolution, type Scene, type Source, type TextStyle,
} from './scene';
import {
  attachElementAudio, attachStreamAudio, audioForUrl, drawBus, drawSource, ensureAudio, imageFor,
  level, masterLevel, media, Recorder, release, tk, updateGains, videoForStream, videoForUrl,
  transitionProgress, type Media, type TransitionState,
} from './engine';
import { multiviewOpen, openMultiview, openOutput, outputOpen, paintWindows } from './windows';

/* ================= state ================= */

type Cat = 'source' | 'audio' | 'graphic' | 'text' | 'comment' | 'effect' | 'live';
type Target = 'pvw' | 'pgm' | 'strip';

const CATS: { id: Cat; label: string; icon: IconName; search: string; filters: string[]; add: string }[] = [
  { id: 'source', label: 'แหล่งภาพ', icon: 'source', search: 'ค้นหากล้อง, หน้าจอ, ไฟล์', filters: ['ทั้งหมด', 'กล้อง', 'หน้าจอ', 'ไฟล์', 'สัญญาณ'], add: 'เพิ่มแหล่งภาพ' },
  { id: 'audio', label: 'เสียง', icon: 'audio', search: 'ค้นหาไมค์, ไฟล์เสียง', filters: ['ทั้งหมด', 'ไมค์', 'ไฟล์'], add: 'เพิ่มเสียง' },
  { id: 'graphic', label: 'กราฟิก', icon: 'graphic', search: 'ค้นหากราฟิก', filters: ['ทั้งหมด', 'ข้อความ', 'รูป'], add: 'เพิ่มรูปซ้อน' },
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
};
let trans: TransitionState | null = null;
/** fade to black: target 0/1, level eases towards it */
const ftb = { target: 0, level: 0 };
/** T-Bar rests at 0 or 100; the next pull travels to the other end */
let tbarBase = 0;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const byId = (id: string | null) => (id ? scene.sources.find((s) => s.id === id) : undefined);
const visuals = () => scene.sources.filter((s) => isVisual(s.kind));
const cutSources = () => visuals();

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
    if (ui.cat === 'source' || ui.cat === 'audio') renderGalleryGrid();
  } catch { /* enumerateDevices unavailable */ }
}

interface Acquired { m: Media; meta: string; name?: string; dataUrl?: string }

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
      const url = URL.createObjectURL(f);
      const el = videoForUrl(url);
      const m: Media = { el, url };
      attachElementAudio(m, el);
      return { m, meta: f.name.split('.').pop()?.toUpperCase() ?? 'VIDEO', name: f.name };
    }
    case 'playlist': {
      const files = await pickFiles('video/*');
      if (!files.length) return null;
      const list = files.map((f) => ({ url: URL.createObjectURL(f), name: f.name }));
      const el = videoForUrl(list[0].url);
      el.loop = false;
      const m: Media = { el, list, index: 0 };
      attachElementAudio(m, el);
      return { m, meta: `${list.length} ไฟล์` };
    }
    case 'audio': {
      const f = await pickFile('audio/*');
      if (!f) return null;
      const url = URL.createObjectURL(f);
      const el = audioForUrl(url);
      const m: Media = { el, url };
      attachElementAudio(m, el);
      return { m, meta: f.name.split('.').pop()?.toUpperCase() ?? 'AUDIO', name: f.name };
    }
    case 'image': {
      const f = await pickFile('image/*');
      if (!f) return null;
      const dataUrl = await readDataUrl(f);
      return { m: { el: imageFor(dataUrl) }, meta: f.name.split('.').pop()?.toUpperCase() ?? 'IMG', name: f.name, dataUrl };
    }
    default:
      return null;
  }
}

const WHAT: Partial<Record<Kind, string>> = { camera: 'กล้อง', screen: 'การแชร์หน้าจอ', mic: 'ไมโครโฟน', video: 'ไฟล์วิดีโอ', playlist: 'เพลย์ลิสต์', audio: 'ไฟล์เสียง', image: 'รูปภาพ' };

/** Wire file playback: loop flag, and playlists advancing to the next file. */
function wirePlayback(id: string, m: Media): void {
  const el = m.el;
  if (!(el instanceof HTMLVideoElement)) return;
  const s = byId(id);
  el.loop = !m.list && (s?.props.loop ?? true);
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
}

function playlistGo(id: string, index: number): void {
  const m = media.get(id);
  if (!m?.list || !(m.el instanceof HTMLVideoElement)) return;
  m.index = (index + m.list.length) % m.list.length;
  m.el.src = m.list[m.index].url;
  void m.el.play().catch(() => undefined);
  if (ui.selected === id) renderInspector();
}

/** A file source that should start from the top when it is taken to air. */
function goingOnAir(id: string | null): void {
  const s = byId(id);
  const el = id ? media.get(id)?.el : undefined;
  if (!s?.props.restartOnAir || !(el instanceof HTMLVideoElement)) return;
  if (s.kind === 'playlist') playlistGo(s.id, 0);
  el.currentTime = 0;
  void el.play().catch(() => undefined);
}

function ensureMedia(s: Source, auto: boolean): void {
  if (media.has(s.id)) return;
  if (s.kind === 'image' && s.dataUrl) media.set(s.id, { el: imageFor(s.dataUrl) });
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
  try {
    const got = await acquire(s.kind, s.deviceId, s.props.res).catch((e) => (s.deviceId ? acquire(s.kind, undefined, s.props.res) : Promise.reject(e)));
    if (!got) return;
    release(id);
    media.set(id, got.m);
    wirePlayback(id, got.m);
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

async function addMedia(kind: Kind, label: string, target?: Target, deviceId?: string, extra: Partial<Props> = {}): Promise<void> {
  try {
    if (kind === 'video' || kind === 'audio' || kind === 'screen' || kind === 'mic') ensureAudio();
    const got = await acquire(kind, deviceId);
    if (!got) return;
    const s = newSource(kind, got.name ?? `${label} ${countOf(kind)}`, got.meta, { afv: kind === 'video' || kind === 'playlist', ...extra });
    wirePlayback(s.id, got.m);
    if (deviceId) s.deviceId = deviceId;
    if (got.dataUrl) s.dataUrl = got.dataUrl;
    if (kind === 'screen') {
      got.m.stream?.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (byId(s.id)) toast(`หยุดแชร์หน้าจอ ${s.name} แล้ว กดเชื่อมต่อใหม่เพื่อแชร์อีกครั้ง`);
      });
    }
    addSource(s, got.m, target);
  } catch (e) {
    mediaError(e, WHAT[kind] ?? 'อุปกรณ์');
  }
}

function addSource(s: Source, m: Media | null, target?: Target): void {
  if (m) media.set(s.id, m);
  mutate((sc) => {
    sc.sources.push(s);
    if (!isVisual(s.kind) || s.props.overlay) return;
    if (target === 'pgm') sc.pgm = s.id;
    else if (target === 'pvw') sc.pvw = s.id;
    else if (!sc.pgm) sc.pgm = s.id;
    else sc.pvw = s.id;
  }, { toast: `เพิ่ม ${s.name} แล้ว` });
  select(s.id);
  renderInspector();
}

function removeSource(id: string): void {
  const s = byId(id);
  if (!s) return;
  mutate((sc) => {
    sc.sources = sc.sources.filter((x) => x.id !== id);
    const rest = sc.sources.filter((x) => isVisual(x.kind) && !x.props.overlay);
    if (sc.pgm === id) sc.pgm = sc.pvw && sc.pvw !== id ? sc.pvw : rest[0]?.id ?? null;
    if (sc.pvw === id || sc.pvw === sc.pgm) sc.pvw = rest.find((x) => x.id !== sc.pgm)?.id ?? null;
  }, { toast: `ลบ ${s.name} แล้ว` });
  if (ui.selected === id) ui.selected = null;
  renderInspector();
  // keep the live media around while undo is likely, then let it go
  window.setTimeout(() => {
    if (!byId(id)) release(id);
  }, 8000);
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
  goingOnAir(scene.pvw);
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
  goingOnAir(scene.pvw);
  trans = { from: scene.pgm, to: scene.pvw, start: now, dur: scene.duration, type: scene.transition };
  renderTally();
}

const tbarValue = () => Number(document.querySelector<HTMLInputElement>('#tbar')?.value ?? 0);

function onTbar(value: number): void {
  const pos = Math.abs(value - tbarBase) / 100;
  if (!trans) {
    if (pos === 0 || !scene.pvw || scene.pvw === scene.pgm) return;
    goingOnAir(scene.pvw);
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
  if (s.props.overlay) {
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
  const s = byId(id);
  if (!s) return;
  mutate((sc) => {
    const t = sc.sources.find((x) => x.id === id);
    if (t) t.props.overlay = !t.props.overlay;
  }, { toast: s.props.overlay ? `ซ่อน ${s.name} แล้ว` : `แสดง ${s.name} บนจอแล้ว` });
}

function cutTo(id: string): void {
  const s = byId(id);
  if (!s) return;
  if (s.props.overlay) return toggleOverlay(id);
  if (scene.pgm === id) return;
  trans = null;
  scene.pvw = id;
  cut();
}

const onAir = (id: string) => scene.pgm === id || trans?.to === id || trans?.from === id || !!byId(id)?.props.overlay;

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

const textSource = (style: TextStyle, title: string, sub: string, extra: Partial<Props> = {}) =>
  newSource('text', title, { lower: 'Lower third', title: 'หัวเรื่อง', corner: 'ป้ายมุมจอ', comment: 'คอมเมนต์', slate: 'Slate' }[style], { style, title, sub, overlay: true, ...extra });

const addText = (s: Source) => (target?: Target) => addSource({ ...s, id: uid(), props: { ...s.props } }, null, target);

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
        { id: 'video', name: 'ไฟล์วิดีโอ', badge: 'MP4', filter: 'ไฟล์', ph: 'c', run: (t) => addMedia('video', 'วิดีโอ', t) },
        { id: 'playlist', name: 'เพลย์ลิสต์วิดีโอ', badge: 'LIST', filter: 'ไฟล์', ph: 'c', run: (t) => addMedia('playlist', 'เพลย์ลิสต์', t) },
        { id: 'image', name: 'รูปภาพ', badge: 'IMG', filter: 'ไฟล์', ph: 'b', run: (t) => addMedia('image', 'รูปภาพ', t) },
        {
          id: 'color', name: 'พื้นสี', badge: 'CLR', filter: 'ไฟล์', ph: 'c',
          run: (t) => addSource(newSource('color', `พื้นสี ${countOf('color')}`, 'สีพื้น', { color: tk('accent-soft') }), null, t),
        },
        { id: 'bars', name: 'Color Bars', badge: 'BARS', filter: 'สัญญาณ', ph: 'c', run: (t) => addSource(newSource('bars', 'Color Bars', 'สัญญาณทดสอบ'), null, t) },
        { id: 'slate', name: 'Slate ข้อความ', badge: 'SLT', filter: 'สัญญาณ', ph: 'b', run: (t) => addSource(textSource('slate', 'เริ่มรายการเร็ว ๆ นี้', 'โปรดรอสักครู่', { overlay: false, tone: 'panel' }), null, t) },
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
          run: (t) => addMedia('image', 'โลโก้', t, undefined, { overlay: true, fit: 'contain', scale: 0.18, x: 0.82, y: -0.78 }),
        },
        {
          id: 'g-full', name: 'รูปเต็มจอ', badge: 'IMG', filter: 'รูป', ph: 'a',
          run: (t) => addMedia('image', 'รูปภาพ', t),
        },
      ];
    case 'text':
      return [
        { id: 't-l3', name: 'Lower third', badge: 'L3', filter: '', ph: 'c', run: addText(textSource('lower', 'หัวข้อวันนี้', 'บรรทัดรอง')) },
        { id: 't-title', name: 'หัวเรื่องกลางจอ', badge: 'TTL', filter: '', ph: 'b', run: addText(textSource('title', 'เริ่มในอีกสักครู่', 'ขอบคุณที่รอชม', { tone: 'panel' })) },
        { id: 't-corner', name: 'ข้อความมุมจอ', badge: 'TXT', filter: '', ph: 'a', run: addText(textSource('corner', 'ช่วงถาม-ตอบ', '', { tone: 'panel' })) },
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
        { id: 'l-rtmp', name: 'RTMP อื่น ๆ', badge: 'RTMP', filter: '', ph: 'c', run: () => openLive('rtmp') },
        { id: 'l-srt', name: 'SRT', badge: 'SRT', filter: '', ph: 'c', run: () => openLive('srt') },
      ];
  }
}

function newTileAction(cat: Cat): void {
  if (cat === 'effect') return applyEffect('');
  if (cat === 'live') return openLive('youtube');
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
    <span class="wm-chip chip-audio" title="ระดับเสียงรวม">เสียง<span class="mini-meter"><i id="meter-master"></i></span></span>
    ${rec ? `<span class="wm-chip wm-chip--warn" id="chip-rec"><span class="wm-dot"></span>REC <b id="rec-time">${fmtTime(performance.now() - rec.started)}</b></span>` : ''}`;
  const btn = $('#btn-rec');
  btn.innerHTML = rec ? `${icon('stop')}<span>หยุดบันทึก</span>` : `${icon('rec')}<span>บันทึก</span>`;
  btn.setAttribute('aria-pressed', String(!!rec));
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
    const list = scene.sources.filter((s) => media.get(s.id)?.gain || s.kind === 'mic' || s.kind === 'audio');
    box.innerHTML = `<h3 class="g-sub">มิกเซอร์</h3>${list.length ? list.map((s) => `
      <div class="mix-row">
        <button class="wm-btn wm-btn--icon wm-btn--ghost" data-act="mute" data-id="${s.id}" aria-pressed="${s.props.muted}" aria-label="${s.props.muted ? 'เปิดเสียง' : 'ปิดเสียง'} ${esc(s.name)}">${icon(s.props.muted ? 'mute' : 'speaker')}</button>
        <div class="mix-row__main">
          <button type="button" class="mix-row__name" data-act="select" data-id="${s.id}">${esc(s.name)}</button>
          <input type="range" class="wm-slider" min="0" max="150" value="${Math.round(s.props.volume * 100)}" data-mix="${s.id}" aria-label="ระดับเสียง ${esc(s.name)}">
          <span class="meter"><i data-meter="${s.id}"></i></span>
        </div>
      </div>`).join('') : '<p class="wm-note">ยังไม่มีแหล่งเสียง เพิ่มไมค์หรือไฟล์วิดีโอที่มีเสียง</p>'}`;
  } else if (ui.cat === 'comment') {
    box.innerHTML = '<p class="wm-note g-note">รุ่น Lite พิมพ์คอมเมนต์เองได้ การดึงคอมเมนต์จาก YouTube หรือ Facebook อัตโนมัติต้องเชื่อมบัญชีผ่าน gateway</p>';
  } else if (ui.cat === 'effect') {
    box.innerHTML = '<p class="wm-note g-note">แตะเพื่อใส่ให้แหล่งภาพที่เลือก หรือลากไปวางบนจอ PVW / PGM</p>';
  } else if (ui.cat === 'live') {
    box.innerHTML = '<p class="wm-note g-note">เบราว์เซอร์ส่ง RTMP หรือ SRT เองไม่ได้ ต้องต่อผ่าน gateway ระหว่างนี้ใช้ปุ่มบันทึกเก็บไฟล์ได้</p>';
  } else box.innerHTML = '';
}

function cardHtml(s: Source, i: number): string {
  const isPgm = s.props.overlay || scene.pgm === s.id || trans?.to === s.id;
  const isPvw = !isPgm && scene.pvw === s.id;
  const word = isPgm ? 'PGM' : isPvw ? 'PVW' : '';
  const sub = s.props.overlay ? 'ซ้อนบนจอ' : s.kind === 'text' && !s.props.overlay ? `${s.meta} · ซ่อนอยู่` : s.meta;
  return `
    <div class="wm-card ${isPgm ? 'is-pgm' : isPvw ? 'is-pvw' : ''} ${ui.selected === s.id ? 'is-selected' : ''}" role="button" tabindex="0" draggable="true"
      data-act="card" data-id="${s.id}" aria-label="${i < 9 ? `${i + 1} ` : ''}${esc(s.name)}${word ? ` ${word}` : ''}">
      <div class="wm-card__pic"><canvas data-thumb="${s.id}" width="192" height="108"></canvas>
        ${i < 9 ? `<span class="wm-card__num">${i + 1}</span>` : ''}${word ? `<span class="wm-card__tally">${word}</span>` : ''}</div>
      <div class="wm-card__foot"><div class="wm-card__name">${esc(s.name)}</div><div class="wm-card__sub">${esc(sub)}</div></div>
    </div>`;
}

function renderStrip(): void {
  const vis = cutSources();
  $('#strip').innerHTML = `${vis.map(cardHtml).join('')}
    <div class="drop">${vis.length ? 'ลากจากแกลเลอรีมาวางที่นี่' : 'ยังไม่มีแหล่งภาพ แตะ + ในแกลเลอรีเพื่อเพิ่ม'}</div>`;
  lastThumb = 0;
}

function renderTally(): void {
  const pvw = byId(scene.pvw);
  const pgm = byId(trans?.to ?? scene.pgm);
  $('#cap-pvw').innerHTML = `<span class="tag">PVW</span><span class="mon__name" data-testid="pvw-name">${pvw ? esc(pvw.name) : 'ว่าง'}</span>`;
  $('#cap-pgm').innerHTML = `<span class="tag">PGM</span><span class="mon__name" data-testid="pgm-name">${pgm ? esc(pgm.name) : 'ว่าง'}</span>`;
  $('#mon-pgm').dataset.source = scene.pgm ?? '';
  $('#mon-pvw').dataset.source = scene.pvw ?? '';
  document.querySelectorAll<HTMLElement>('#strip .wm-card').forEach((el) => {
    const s = byId(el.dataset.id!);
    if (!s) return;
    const isPgm = s.props.overlay || scene.pgm === s.id || trans?.to === s.id;
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
    <label class="tbar"><span class="tag">T-BAR</span>
      <input type="range" class="wm-slider" id="tbar" min="0" max="100" step="1" value="${trans?.manual !== undefined ? tbarValue() : tbarBase}" aria-label="T-Bar เลื่อนเพื่อเปลี่ยนภาพเอง"></label>`;
}

/* ---------- inspector ---------- */

function tallyChip(s?: Source): string {
  if (!s) return '<span id="insp-chip"></span>';
  if (s.props.overlay || scene.pgm === s.id) return '<span class="wm-chip wm-chip--live" id="insp-chip"><span class="wm-dot"></span>PGM</span>';
  if (scene.pvw === s.id) return '<span class="wm-chip wm-chip--ok" id="insp-chip"><span class="wm-dot"></span>PVW</span>';
  return '<span id="insp-chip"></span>';
}

const fmt = (v: number, unit: string) => (unit === 's' ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}${unit}`);

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
  if (s.kind === 'mic' || s.kind === 'audio') return ['เสียง'];
  if (s.kind === 'text') return ['ข้อความ', 'ภาพ'];
  const t = ['ภาพ'];
  if (s.kind === 'video' || s.kind === 'playlist') t.push('เล่น');
  if (media.get(s.id)?.gain) t.push('เสียง');
  t.push('เอฟเฟกต์');
  return t;
}

function inspectorBody(s: Source): string {
  const p = s.props;
  const tab = ui.tab;
  if (tab === 'ข้อความ') {
    return `
      ${textField('p:title', s.props.style === 'comment' ? 'ข้อความคอมเมนต์' : 'หัวเรื่อง', p.title)}
      ${textField('p:sub', s.props.style === 'comment' ? 'ชื่อผู้ชม' : 'บรรทัดรอง', p.sub)}
      ${switchRow('p:overlay', 'แสดงซ้อนบนจอ', p.overlay)}
      ${segField('p:tone', 'สีแถบ', [['accent', 'น้ำเงิน'], ['panel', 'เข้ม'], ['amber', 'อำพัน']], p.tone)}
      ${advanced(`
        ${segField('p:style', 'รูปแบบ', [['lower', 'แถบล่าง'], ['title', 'กลางจอ'], ['corner', 'มุมจอ'], ['comment', 'คอมเมนต์']], p.style)}
        ${textField('n:name', 'ชื่อในแถบการ์ด', s.name)}`)}`;
  }
  if (tab === 'เสียง') {
    return `
      ${switchRow('p:muted', 'ปิดเสียง', p.muted)}
      ${rangeField('p:volume', 'ระดับเสียง', p.volume, 0, 150)}
      <div class="wm-field"><span>ระดับสัญญาณ</span><span class="meter meter--wide"><i data-meter="${s.id}"></i></span></div>
      ${advanced(`
        ${isVisual(s.kind) ? switchRow('p:afv', 'เปิดเสียงเฉพาะตอนออกอากาศ (AFV)', p.afv) : ''}
        ${textField('n:name', 'ชื่อ', s.name)}`)}`;
  }
  if (tab === 'เล่น') {
    const m = media.get(s.id);
    const playing = m?.el instanceof HTMLVideoElement && !m.el.paused;
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
      ${switchRow('p:restartOnAir', 'เริ่มจากต้นเมื่อขึ้น PGM', p.restartOnAir)}
      ${m?.list ? `<div class="wm-field"><span>ไฟล์ในเพลย์ลิสต์</span><ol class="pl-list">${m.list.map((f, i) =>
        `<li><button type="button" class="pl-item" data-act="pl-go" data-i="${i}" aria-current="${i === m.index}">${esc(f.name)}</button></li>`).join('')}</ol>
        <button type="button" class="wm-btn wm-btn--sm" data-act="pl-add">${icon('plus')}เพิ่มไฟล์</button></div>` : ''}`;
  }
  if (tab === 'เอฟเฟกต์') {
    return `
      <div class="wm-field"><span>เอฟเฟกต์</span><div class="wm-row">
        <button type="button" class="wm-chip wm-chip--filter" data-act="seg" data-prop="p:filter" data-val="" aria-pressed="${!p.filter}">ไม่มี</button>
        ${EFFECTS.map((e) => `<button type="button" class="wm-chip wm-chip--filter" data-act="seg" data-prop="p:filter" data-val="${e.fx}" aria-pressed="${p.filter === e.fx}">${e.name}</button>`).join('')}
      </div></div>`;
  }
  // ภาพ
  return `
    ${rangeField('p:scale', 'ขนาด', p.scale, 10, 300)}
    ${rangeField('p:opacity', 'ความโปร่งใส', p.opacity, 0, 100)}
    ${switchRow('p:flip', 'กลับด้านภาพ', p.flip)}
    ${switchRow('p:overlay', 'แสดงซ้อนบนจอ', p.overlay)}
    ${s.kind === 'color' ? `<label class="wm-field"><span>สีพื้น</span><input type="color" class="wm-color" data-prop="p:color" value="${esc(p.color)}"></label>` : ''}
    ${advanced(`
      ${needsMedia(s.kind) ? segField('p:fit', 'การจัดภาพ', [['cover', 'เต็มจอ'], ['contain', 'พอดีจอ']], p.fit) : ''}
      ${s.kind === 'camera' ? segField('p:res', 'ความละเอียดกล้อง', [['720p', '720p'], ['1080p', '1080p'], ['2160p', '4K']], p.res) : ''}
      ${rangeField('p:x', 'ตำแหน่งแนวนอน', p.x, -100, 100, 100, '')}
      ${rangeField('p:y', 'ตำแหน่งแนวตั้ง', p.y, -100, 100, 100, '')}
      ${textField('n:name', 'ชื่อ', s.name)}
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
        ${rangeField('g:master', 'ระดับเสียงรวม', scene.master, 0, 150)}
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
        ${isVisual(s.kind) && !s.props.overlay ? `<button type="button" class="wm-btn" data-act="send-pvw">ส่งไป PVW</button>` : ''}
        <button type="button" class="wm-btn" data-act="delete">${icon('trash')}ลบ</button>
        <button type="button" class="wm-btn wm-btn--ghost" data-act="deselect">ปรับเอาต์พุต</button>
      </div>
    </div>`;
}

function renderAll(): void {
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

const DESTS: Record<string, { label: string; url: string; hint: string }> = {
  youtube: { label: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2', hint: 'คัดลอก Stream key จาก YouTube Studio → ถ่ายทอดสด' },
  facebook: { label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', hint: 'คัดลอก Stream key จาก Facebook Live Producer' },
  rtmp: { label: 'RTMP', url: '', hint: 'ใส่ URL ของเซิร์ฟเวอร์ที่ขึ้นต้นด้วย rtmp:// หรือ rtmps://' },
  srt: { label: 'SRT', url: '', hint: 'ใส่ URL ที่ขึ้นต้นด้วย srt:// พร้อมพอร์ต' },
};

function openLive(dest: string): void {
  const draw = (cur: string) => {
    const info = DESTS[cur];
    const d = openDialog('ตั้งค่าปลายทางไลฟ์', `
      <div class="wm-seg" role="group" aria-label="ปลายทาง">${Object.entries(DESTS).map(([k, v]) =>
        `<button type="button" data-dest="${k}" aria-pressed="${k === cur}">${v.label}</button>`).join('')}</div>
      <label class="wm-field"><span>URL เซิร์ฟเวอร์</span><input class="wm-input" id="live-url" value="${esc(info.url)}" placeholder="${cur === 'srt' ? 'srt://' : 'rtmp://'}" autocomplete="off" spellcheck="false"></label>
      <label class="wm-field"><span>Stream key</span><span class="key-row">
        <input class="wm-input" id="live-key" type="password" autocomplete="off" spellcheck="false" placeholder="วางคีย์ที่นี่">
        <button type="button" class="wm-btn" id="live-show">${icon('eye')}แสดง</button></span>
        <span class="wm-help" id="live-help">${info.hint} คีย์ไม่ถูกบันทึกในเครื่องหรือไฟล์ใด ๆ</span></label>
      <div class="notice notice--warn"><p><b>ต้องใช้ gateway</b> เบราว์เซอร์ส่งสัญญาณ RTMP หรือ SRT ตรงไม่ได้ ต้องมีเซิร์ฟเวอร์กลางที่รับภาพจากเบราว์เซอร์ (เช่น WHIP หรือ WebSocket) แล้วส่งต่อไปยัง ${info.label} รุ่น Lite ยังไม่ส่งสัญญาณจริง ระหว่างนี้ใช้ปุ่มบันทึกเก็บไฟล์ได้</p></div>`,
    `<button class="wm-btn" value="close">ปิด</button><button type="button" class="wm-btn wm-btn--primary" id="live-check">ตรวจการตั้งค่า</button>`);
    d.querySelectorAll<HTMLElement>('[data-dest]').forEach((b) => b.addEventListener('click', () => draw(b.dataset.dest!)));
    const key = $<HTMLInputElement>('#live-key', d);
    $('#live-show', d).addEventListener('click', (e) => {
      key.type = key.type === 'password' ? 'text' : 'password';
      (e.currentTarget as HTMLElement).lastChild!.textContent = key.type === 'password' ? 'แสดง' : 'ซ่อน';
    });
    $('#live-check', d).addEventListener('click', () => {
      const url = $<HTMLInputElement>('#live-url', d).value.trim();
      const help = $('#live-help', d);
      const ok = cur === 'srt' ? /^srt:\/\/[^/\s]+:\d+/.test(url) : /^rtmps?:\/\/\S+/.test(url);
      help.classList.toggle('wm-help--err', !ok || (!key.value && cur !== 'srt'));
      if (!ok) help.textContent = cur === 'srt' ? 'ใส่ URL ที่ขึ้นต้นด้วย srt:// และมีพอร์ต เช่น srt://host:9000' : 'ใส่ URL ที่ขึ้นต้นด้วย rtmp:// หรือ rtmps://';
      else if (!key.value && cur !== 'srt') help.textContent = 'วาง Stream key จากแพลตฟอร์มก่อน';
      else help.textContent = 'การตั้งค่าถูกรูปแบบแล้ว ต่อ gateway ก่อนจึงจะเริ่มไลฟ์ได้';
    });
  };
  draw(DESTS[dest] ? dest : 'youtube');
  // never keep a stream key around after the dialog closes
  dlg().addEventListener('close', () => {
    const key = document.getElementById('live-key') as HTMLInputElement | null;
    if (key) key.value = '';
  }, { once: true });
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
    window.setTimeout(() => ids.forEach((id) => !byId(id) && release(id)), 8000);
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

function renderTransport(): void {
  const el = media.get(ui.selected ?? '')?.el;
  const out = document.getElementById('tp-time');
  const seek = document.querySelector<HTMLInputElement>('#seek');
  if (!(el instanceof HTMLVideoElement) || !out || !seek) return;
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
  drawBus(pgmCtx, scene, scene.pgm, trans, now, ftb.level);
  drawBus(pvwCtx, scene, scene.pvw, null, now);
  updateGains(scene, onAir);
  paintWindows(pgmCtx.canvas, pvwCtx.canvas, scene, now);

  if (now - lastThumb > 200) {
    lastThumb = now;
    document.querySelectorAll<HTMLCanvasElement>('canvas[data-thumb]').forEach((cv) => {
      const s = byId(cv.dataset.thumb!);
      const ctx = cv.getContext('2d');
      if (!s || !ctx) return;
      ctx.fillStyle = tk('card-ground');
      ctx.fillRect(0, 0, cv.width, cv.height);
      drawSource(ctx, s, cv.width, cv.height);
    });
  }
  const m = document.getElementById('meter-master');
  if (m) m.style.width = `${masterLevel() * 100}%`;
  document.querySelectorAll<HTMLElement>('[data-meter]').forEach((el) => {
    el.style.width = `${level(media.get(el.dataset.meter!)?.analyser) * 100}%`;
  });
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
  live: () => openLive('youtube'),
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
    setProp(prop, on, false);
    if (prop === 'p:loop' && ui.selected) {
      const m = media.get(ui.selected);
      if (m?.el instanceof HTMLVideoElement && !m.list) m.el.loop = on;
    }
    if (prop === 'p:overlay') {
      const s = byId(ui.selected);
      if (s && on) mutateBusAfterOverlay(s.id);
    }
  },
  seg: (el) => {
    const prop = el.dataset.prop!;
    setProp(prop, el.dataset.num ? Number(el.dataset.val) : el.dataset.val, false);
    if (prop === 'p:res' && ui.selected) void reconnect(ui.selected);
  },
  ftb: toggleFtb,
  play: () => {
    const el = media.get(ui.selected ?? '')?.el;
    if (!(el instanceof HTMLVideoElement)) return;
    if (el.paused) void el.play().catch(() => toast('เล่นไฟล์นี้ไม่ได้ ลองเลือกไฟล์ใหม่'));
    else el.pause();
    renderInspector();
  },
  restart: () => {
    const el = media.get(ui.selected ?? '')?.el;
    if (el instanceof HTMLVideoElement) {
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
      if (t) Object.assign(t.props, { scale: 1, opacity: 1, flip: false, x: 0, y: 0, filter: '' });
    }, { toast: `คืนค่าเริ่มต้นของ ${s.name} แล้ว` });
  },
  delete: () => ui.selected && removeSource(ui.selected),
  deselect: () => {
    ui.selected = null;
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
    const rest = visuals().filter((x) => !x.props.overlay);
    if (scene.pgm === id) scene.pgm = rest[0]?.id ?? null;
    if (scene.pvw === id) scene.pvw = rest.find((x) => x.id !== scene.pgm)?.id ?? null;
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

$('#scrim').addEventListener('click', closeSheets);

document.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'tbar') return onTbar(Number(t.value));
  if (t.id === 'seek') {
    const el = media.get(ui.selected ?? '')?.el;
    if (el instanceof HTMLVideoElement && Number.isFinite(el.duration)) el.currentTime = (Number(t.value) / 1000) * el.duration;
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
    return;
  }
  const prop = t.dataset.prop;
  if (!prop || t.closest('dialog')) return;
  if (t.type === 'range') {
    const div = Number(t.dataset.div ?? 1);
    setProp(prop, Number(t.value) / div, true);
    const out = t.parentElement?.querySelector('output');
    if (out) out.textContent = fmt(Number(t.value), t.dataset.unit ?? '%');
  } else {
    setProp(prop, t.value, true);
    if (prop.startsWith('n:') || prop === 'p:title') {
      const title = document.querySelector('.wm-insp__title');
      const s = byId(ui.selected);
      if (title && s) title.textContent = s.name;
    }
  }
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
  if (e.key === 'Escape') return closeSheets();
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
  if (/^[1-9]$/.test(e.key)) {
    const s = cutSources()[Number(e.key) - 1];
    if (!s) return;
    if (s.props.overlay) return toggleOverlay(s.id);
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
void refreshDevices();
navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());
requestAnimationFrame(frame);

// small read-only handle for diagnostics and end-to-end tests
Object.defineProperty(window, '__webmix', {
  value: { get scene() { return clone(scene); }, undoDepth: () => undoStack.length },
});
