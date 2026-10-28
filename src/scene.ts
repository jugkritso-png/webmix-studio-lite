// The serialisable show: sources, bus assignment and output settings.
// Live media (streams, elements, audio nodes) live in engine.ts, keyed by source id.

export type Kind = 'camera' | 'remote' | 'screen' | 'video' | 'playlist' | 'image' | 'color' | 'bars' | 'clock' | 'text' | 'timer' | 'score' | 'mic' | 'audio';
export type TextStyle = 'lower' | 'title' | 'corner' | 'comment' | 'slate' | 'ticker';
export type Tone = 'accent' | 'panel' | 'amber';
export type Transition = 'mix' | 'dip' | 'wipe';
export type Resolution = '720p' | '1080p' | '2160p';
export type OverlayFx = 'cut' | 'fade' | 'zoom' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down' | 'wipe';
export const OVERLAY_FX: [OverlayFx, string][] = [
  ['cut', 'Cut'], ['fade', 'Fade'], ['zoom', 'Zoom'], ['slide-left', 'Slide ←'], ['slide-right', 'Slide →'],
  ['slide-up', 'Slide ↑'], ['slide-down', 'Slide ↓'], ['wipe', 'Wipe'],
];
export const OVERLAY_COUNT = 8;

/** One of the eight overlay channels layered over Program. */
export interface Overlay {
  src: string | null;
  on: boolean;
  fx: OverlayFx;
  dur: number;
  /** show it on Preview while it is off air, to check it before taking it */
  cue: boolean;
}

export interface Props {
  scale: number;
  opacity: number;
  flip: boolean;
  x: number;
  y: number;
  fit: 'cover' | 'contain';
  volume: number;
  muted: boolean;
  afv: boolean;
  filter: string;
  title: string;
  sub: string;
  style: TextStyle;
  tone: Tone;
  color: string;
  /** requested camera capture size */
  res: Resolution;
  /** video / playlist: loop the file or the list */
  loop: boolean;
  /** video / playlist: restart from the top each time it goes on air */
  restartOnAir: boolean;
  /** crop as fractions of each edge */
  cropL: number;
  cropR: number;
  cropT: number;
  cropB: number;
  border: number;
  borderTone: 'accent' | 'text' | 'amber';
  key: 'off' | 'green' | 'blue';
  keyTol: number;
  /** ticker lines, one item per line */
  items: string;
  speed: number;
  /** timer */
  timerMode: 'down' | 'up';
  timerDur: number;
  timerStart: number;
  timerAcc: number;
  /** scoreboard */
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
  period: string;
  colorA: string;
  colorB: string;
  /** Google Sheets / CSV link and the row shown */
  dataUrl: string;
  dataHeader: boolean;
  dataRow: number;
  /** audio strip */
  pan: number;
  gate: boolean;
  gateDb: number;
  lowcut: boolean;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  comp: boolean;
  compDb: number;
  delay: number;
  mon: boolean;
}

export interface Source {
  id: string;
  kind: Kind;
  name: string;
  meta: string;
  props: Props;
  deviceId?: string;
  dataUrl?: string;
}

export interface Scene {
  v: 1;
  projectName: string;
  sources: Source[];
  pvw: string | null;
  pgm: string | null;
  transition: Transition;
  duration: number;
  resolution: Resolution;
  fps: 30 | 60;
  monitor: boolean;
  master: number;
  limiter: boolean;
  /** headphone / speaker output for monitoring ('' = system default) */
  sinkId: string;
  overlays: Overlay[];
}

export interface TitlePreset {
  title: string;
  sub: string;
  tone: Tone;
}

export const STORAGE_KEY = 'webmix-lite.scene.v1';
const MAX_INLINE_IMAGE = 1_500_000;

export function defaultProps(): Props {
  return {
    scale: 1, opacity: 1, flip: false, x: 0, y: 0, fit: 'cover',
    volume: 1, muted: false, afv: false, filter: '',
    title: '', sub: '', style: 'lower', tone: 'accent', color: '',
    res: '1080p', loop: true, restartOnAir: false,
    cropL: 0, cropR: 0, cropT: 0, cropB: 0, border: 0, borderTone: 'accent', key: 'off', keyTol: 80,
    items: '', speed: 90,
    timerMode: 'down', timerDur: 300_000, timerStart: 0, timerAcc: 0,
    teamA: 'ทีม A', teamB: 'ทีม B', scoreA: 0, scoreB: 0, period: '', colorA: '', colorB: '',
    dataUrl: '', dataHeader: true, dataRow: 0,
    pan: 0, gate: false, gateDb: -50, lowcut: false, eqLow: 0, eqMid: 0, eqHigh: 0, comp: false, compDb: -24, delay: 0, mon: false,
  };
}

export function emptyOverlays(): Overlay[] {
  return Array.from({ length: OVERLAY_COUNT }, () => ({ src: null, on: false, fx: 'fade' as OverlayFx, dur: 400, cue: false }));
}

export function defaultScene(): Scene {
  return {
    v: 1, projectName: 'โชว์ใหม่', sources: [], pvw: null, pgm: null,
    transition: 'mix', duration: 500, resolution: '720p', fps: 30, monitor: false, master: 1, limiter: true, sinkId: '',
    overlays: emptyOverlays(),
  };
}

export const isVisual = (k: Kind) => k !== 'mic' && k !== 'audio';
export const needsMedia = (k: Kind) => !['text', 'color', 'bars', 'clock', 'timer', 'score'].includes(k);

export const OUTPUT_SIZE: Record<Resolution, [number, number]> = { '720p': [1280, 720], '1080p': [1920, 1080], '2160p': [3840, 2160] };

export function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function loadScene(): Scene {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultScene();
    const s = JSON.parse(raw) as Partial<Scene>;
    if (s.v !== 1 || !Array.isArray(s.sources)) return defaultScene();
    const sources = s.sources.map((x) => ({ ...x, props: { ...defaultProps(), ...x.props } }));
    const ids = new Set(sources.map((x) => x.id));
    const overlays = emptyOverlays().map((o, i) => {
      const old = s.overlays?.[i];
      // graphics never come back on air by themselves after a reload
      return old ? { ...o, ...old, on: false, src: old.src && ids.has(old.src) ? old.src : null } : o;
    });
    // v1 scenes flagged graphics with props.overlay: give each a channel
    for (const x of sources as (Source & { props: { overlay?: boolean } })[]) {
      if (x.props.overlay && !overlays.some((o) => o.src === x.id)) {
        const free = overlays.find((o) => !o.src);
        if (free) free.src = x.id;
      }
      delete x.props.overlay;
    }
    return {
      ...defaultScene(), ...s, sources, overlays,
      pvw: s.pvw && ids.has(s.pvw) ? s.pvw : null,
      pgm: s.pgm && ids.has(s.pgm) ? s.pgm : null,
    };
  } catch {
    return defaultScene();
  }
}

const PRESETS_KEY = 'webmix-lite.title-presets.v1';

export function loadPresets(): TitlePreset[] {
  try {
    const v = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]') as TitlePreset[];
    return Array.isArray(v) ? v.slice(0, 30) : [];
  } catch {
    return [];
  }
}

export function savePresets(list: TitlePreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list.slice(0, 30)));
  } catch { /* storage full: presets are a convenience */ }
}

export function saveScene(s: Scene): boolean {
  try {
    const out: Scene = {
      ...s,
      sources: s.sources.map((x) => ({
        ...x,
        dataUrl: x.dataUrl && x.dataUrl.length < MAX_INLINE_IMAGE ? x.dataUrl : undefined,
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    return true;
  } catch {
    return false;
  }
}
