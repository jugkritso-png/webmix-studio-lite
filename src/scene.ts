// The serialisable show: sources, bus assignment and output settings.
// Live media (streams, elements, audio nodes) live in engine.ts, keyed by source id.

export type Kind = 'camera' | 'screen' | 'video' | 'playlist' | 'image' | 'color' | 'bars' | 'clock' | 'text' | 'mic' | 'audio';
export type TextStyle = 'lower' | 'title' | 'corner' | 'comment' | 'slate';
export type Tone = 'accent' | 'panel' | 'amber';
export type Transition = 'mix' | 'dip' | 'wipe';
export type Resolution = '720p' | '1080p' | '2160p';

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
  overlay: boolean;
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
}

export const STORAGE_KEY = 'webmix-lite.scene.v1';
const MAX_INLINE_IMAGE = 1_500_000;

export function defaultProps(): Props {
  return {
    scale: 1, opacity: 1, flip: false, x: 0, y: 0, fit: 'cover',
    volume: 1, muted: false, afv: false, filter: '', overlay: false,
    title: '', sub: '', style: 'lower', tone: 'accent', color: '',
    res: '1080p', loop: true, restartOnAir: false,
  };
}

export function defaultScene(): Scene {
  return {
    v: 1, projectName: 'โชว์ใหม่', sources: [], pvw: null, pgm: null,
    transition: 'mix', duration: 500, resolution: '720p', fps: 30, monitor: false, master: 1,
  };
}

export const isVisual = (k: Kind) => k !== 'mic' && k !== 'audio';
export const needsMedia = (k: Kind) => !['text', 'color', 'bars', 'clock'].includes(k);

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
    return {
      ...defaultScene(), ...s, sources,
      pvw: s.pvw && ids.has(s.pvw) ? s.pvw : null,
      pgm: s.pgm && ids.has(s.pgm) ? s.pgm : null,
    };
  } catch {
    return defaultScene();
  }
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
