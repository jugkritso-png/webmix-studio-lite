// Live streaming through a WebMix Stream Gateway — the same protocol as WebMix Pro:
//   wss://gateway/?token=…&fps=30&vb=4500&res=1080   (one WebSocket per show)
//   client → { type: 'start', destinations: [{ id, name, url }] }  then WebM chunks as binary frames
//   client → { type: 'add', destination } · { type: 'stop', id } · { type: 'probe', destination }
//   server → { type: 'status', destinations: [{ id, name, state, message, kbps, lag }], rx }
//   server → { type: 'probe', id, ok, message } · { type: 'error', message }
// The gateway encodes once with FFmpeg and fans out to every RTMP / RTMPS / SRT destination.
import { recordAudioTracks } from './audio';

export type DestState = 'idle' | 'connecting' | 'live' | 'error' | 'stopped';
export type Platform = 'youtube' | 'facebook' | 'twitch' | 'rtmp' | 'srt';

export interface Destination {
  id: string;
  platform: Platform;
  name: string;
  server: string;
  /** stream key: kept in memory only, never stored */
  key: string;
  enabled: boolean;
  state: DestState;
  message: string;
  kbps: number;
}

export const PLATFORMS: Record<Platform, { label: string; server: string; hint: string }> = {
  youtube: { label: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2', hint: 'YouTube Studio → ถ่ายทอดสด → คีย์สตรีม' },
  facebook: { label: 'Facebook', server: 'rtmps://live-api-s.facebook.com:443/rtmp/', hint: 'Facebook Live Producer → คีย์สตรีม' },
  twitch: { label: 'Twitch', server: 'rtmp://live.twitch.tv/app', hint: 'Twitch Creator Dashboard → Stream key' },
  rtmp: { label: 'RTMP อื่น ๆ', server: '', hint: 'URL เซิร์ฟเวอร์ที่ขึ้นต้นด้วย rtmp:// หรือ rtmps://' },
  srt: { label: 'SRT', server: '', hint: 'srt://host:port?streamid=…&passphrase=… (ไม่ต้องใส่คีย์)' },
};

const RTMP_RE = /^rtmps?:\/\/[^\s]+$/i;
const SRT_RE = /^srt:\/\/[^\s/?#]+:\d+(\?[^\s]*)?$/i;

/** the full URL the gateway publishes to, or an error that says how to fix it */
export function destinationUrl(d: Destination): { url: string } | { error: string } {
  const server = d.server.trim();
  if (d.platform === 'srt') {
    return SRT_RE.test(server) ? { url: server } : { error: 'ใส่ URL ที่ขึ้นต้นด้วย srt:// และมีพอร์ต เช่น srt://host:9000' };
  }
  if (!RTMP_RE.test(server)) return { error: 'ใส่ URL ที่ขึ้นต้นด้วย rtmp:// หรือ rtmps://' };
  const key = d.key.trim();
  if (!key) return { error: `วางคีย์สตรีมจาก ${PLATFORMS[d.platform].label} ก่อน` };
  return { url: `${server.replace(/\/+$/, '')}/${key}` };
}

export function gatewayProblem(raw: string): string {
  const v = raw.trim();
  if (!v) return 'ใส่ที่อยู่ Stream Gateway ก่อน เช่น wss://live.example.com/?token=…';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'ที่อยู่ Gateway ต้องขึ้นต้นด้วย wss:// หรือ ws://';
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return 'ที่อยู่ Gateway ต้องขึ้นต้นด้วย wss:// หรือ ws://';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (location.protocol === 'https:' && u.protocol === 'ws:' && !local) return 'หน้าเว็บที่เปิดผ่าน https ต้องใช้ wss:// (Gateway ต้องมี HTTPS)';
  return '';
}

export interface StreamOptions {
  canvas: HTMLCanvasElement;
  fps: number;
  kbps: number;
  height: number;
  onStatus: () => void;
  onError: (message: string) => void;
}

const pickMime = () => ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']
  .find((m) => MediaRecorder.isTypeSupported(m)) ?? '';

export class Streamer {
  ws: WebSocket | null = null;
  private rec: MediaRecorder | null = null;
  private retry = 0;
  private wanted = new Map<string, Destination>();
  startedAt = 0;
  rxKbps = 0;
  /** the gateway connection dropped and we are trying again */
  reconnecting = false;

  constructor(private gateway: string, private opts: StreamOptions, readonly dests: Destination[]) {}

  get live(): boolean {
    return this.dests.some((d) => d.state === 'live' || d.state === 'connecting');
  }

  private url(): string {
    const u = new URL(this.gateway.trim());
    u.searchParams.set('fps', String(this.opts.fps));
    u.searchParams.set('vb', String(this.opts.kbps));
    u.searchParams.set('res', String(this.opts.height));
    return u.toString();
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(record = true): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url());
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.reconnecting = false;
        if (record) this.startRecorder();
        resolve();
      };
      ws.onmessage = (e) => this.onMessage(e.data);
      ws.onerror = () => {
        if (!opened) reject(new Error('เชื่อมต่อ Gateway ไม่ได้ ตรวจที่อยู่ token และว่า Gateway เปิดอยู่'));
      };
      ws.onclose = (e) => {
        this.stopRecorder();
        if (this.ws !== ws) return;
        this.ws = null;
        if (!opened) return;
        if (e.code === 1008) {
          // rejected by the gateway (token, quota): retrying will not help
          this.wanted.clear();
          const why = /token|auth/i.test(e.reason) ? 'Gateway ไม่รับ token นี้ ตรวจค่า ?token= ในที่อยู่ Gateway'
            : /limit|busy/i.test(e.reason) ? 'Gateway เต็มหรือเกินโควตา ลองใหม่ภายหลังหรือติดต่อผู้ดูแล' : 'Gateway ปฏิเสธการเชื่อมต่อ';
          this.dests.forEach((d) => { if (d.state !== 'idle') Object.assign(d, { state: 'error', message: why }); });
          this.opts.onStatus();
          return;
        }
        if (this.wanted.size) this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect(): void {
    this.reconnecting = true;
    this.dests.forEach((d) => { if (this.wanted.has(d.id)) Object.assign(d, { state: 'connecting', message: 'Gateway หลุด กำลังเชื่อมต่อใหม่' }); });
    this.opts.onStatus();
    window.clearTimeout(this.retry);
    this.retry = window.setTimeout(() => {
      if (!this.wanted.size) return;
      this.connect()
        .then(() => this.send({ type: 'start', destinations: [...this.wanted.values()].map(wire) }))
        .catch(() => this.scheduleReconnect());
    }, 3000);
  }

  private startRecorder(): void {
    const video = this.opts.canvas.captureStream(this.opts.fps);
    const stream = new MediaStream([...video.getVideoTracks(), ...recordAudioTracks()]);
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: this.opts.kbps * 1000 * 1.5, audioBitsPerSecond: 160_000 });
    rec.ondataavailable = async (e) => {
      if (!e.data.size || this.ws?.readyState !== WebSocket.OPEN) return;
      // a very full send buffer means the uplink cannot keep up; say so rather than freeze
      if (this.ws.bufferedAmount > 16e6) this.opts.onError('อินเทอร์เน็ตขาขึ้นไม่พอ ลดความละเอียดหรือบิตเรตลง');
      this.ws.send(await e.data.arrayBuffer());
    };
    rec.start(500);
    this.rec = rec;
  }

  private stopRecorder(): void {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.rec = null;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: { type?: string; destinations?: { id: string; state: DestState; message?: string; kbps?: number }[]; rx?: number; id?: string; ok?: boolean; message?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'status') {
      for (const s of msg.destinations ?? []) {
        const d = this.dests.find((x) => x.id === s.id);
        if (d && (this.wanted.has(d.id) || s.state !== 'stopped')) Object.assign(d, { state: s.state, message: s.message ?? '', kbps: s.kbps ?? 0 });
        if (d && s.state === 'live' && !this.startedAt) this.startedAt = Date.now();
      }
      this.rxKbps = msg.rx ?? 0;
      this.opts.onStatus();
    } else if (msg.type === 'probe') {
      const d = this.dests.find((x) => x.id === msg.id);
      if (d) Object.assign(d, { state: msg.ok ? 'idle' : 'error', message: msg.ok ? 'ตรวจแล้ว ใช้ได้' : msg.message ?? 'ตรวจไม่ผ่าน' });
      this.opts.onStatus();
      if (!this.wanted.size) this.close();
    } else if (msg.type === 'error' && msg.message) {
      this.opts.onError(msg.message);
    }
  }

  async start(ids: string[]): Promise<void> {
    const list = this.dests.filter((d) => ids.includes(d.id));
    for (const d of list) {
      const r = destinationUrl(d);
      if ('error' in r) {
        Object.assign(d, { state: 'error', message: r.error });
        continue;
      }
      this.wanted.set(d.id, d);
      Object.assign(d, { state: 'connecting', message: '' });
    }
    this.opts.onStatus();
    const ready = list.filter((d) => this.wanted.has(d.id));
    if (!ready.length) return;
    if (!this.ws) {
      await this.connect();
      this.send({ type: 'start', destinations: ready.map(wire) });
    } else if (!this.rec) {
      // the socket was opened for a check only: start sending pictures now
      this.startRecorder();
      this.send({ type: 'start', destinations: ready.map(wire) });
    } else {
      for (const d of ready) this.send({ type: 'add', destination: wire(d) });
    }
  }

  stop(id: string): void {
    this.wanted.delete(id);
    this.send({ type: 'stop', id });
    const d = this.dests.find((x) => x.id === id);
    if (d) Object.assign(d, { state: 'stopped', kbps: 0, message: '' });
    if (!this.wanted.size) this.close();
    this.opts.onStatus();
  }

  stopAll(): void {
    [...this.wanted.keys()].forEach((id) => this.stop(id));
    this.close();
  }

  async probe(id: string): Promise<void> {
    const d = this.dests.find((x) => x.id === id);
    if (!d) return;
    const r = destinationUrl(d);
    if ('error' in r) {
      Object.assign(d, { state: 'error', message: r.error });
      this.opts.onStatus();
      return;
    }
    Object.assign(d, { state: 'idle', message: 'กำลังตรวจ…' });
    this.opts.onStatus();
    if (!this.ws) await this.connect(false);
    this.send({ type: 'probe', destination: { id: d.id, name: d.name, url: r.url } });
  }

  close(): void {
    window.clearTimeout(this.retry);
    this.reconnecting = false;
    this.wanted.clear();
    this.stopRecorder();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'stop');
    this.startedAt = 0;
    this.rxKbps = 0;
  }
}

function wire(d: Destination): { id: string; name: string; url: string } {
  const r = destinationUrl(d);
  return { id: d.id, name: d.name || PLATFORMS[d.platform].label, url: 'url' in r ? r.url : '' };
}
