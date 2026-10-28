// The page a phone or a remote guest opens from the studio's QR code / link (cam.html?call=<studio id>).
// It sends its camera and microphone to the studio over WebRTC, shows the tally (ON AIR / PREVIEW),
// and for guests plays the Program feed coming back (without their own voice).
import '../design/components/bundle.css';
import '../design/tokens.css';
import './cam.css';
import type { DataConnection, MediaConnection, Peer as PeerT } from 'peerjs';
import { icon, logo } from './icons';
import { peerOptions, signalFromLocation, type Tally } from './remote';

const q = new URLSearchParams(location.search);
const studio = q.get('call') ?? '';
const guest = q.get('guest') === '1';
const sig = signalFromLocation();
const root = document.getElementById('cam')!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const QUALITY = { hd: [1280, 720], fhd: [1920, 1080], uhd: [3840, 2160] } as const;
type Quality = keyof typeof QUALITY;

const state = {
  name: q.get('name') ?? '',
  facing: (guest ? 'user' : 'environment') as 'user' | 'environment',
  quality: 'fhd' as Quality,
  mic: true,
  wanted: false,
  tally: 'off' as Tally,
  status: '',
  error: false,
};

let clientId = '';
try {
  clientId = localStorage.getItem('webmix-lite.client-id') ?? '';
  if (!clientId) {
    clientId = Math.random().toString(36).slice(2, 10);
    localStorage.setItem('webmix-lite.client-id', clientId);
  }
} catch {
  clientId = Math.random().toString(36).slice(2, 10);
}

let stream: MediaStream | null = null;
let peer: PeerT | null = null;
let call: MediaConnection | null = null;
let conn: DataConnection | null = null;
let retry = 0;
let wake: { release(): Promise<void> } | null = null;

function render(): void {
  const live = !!call;
  root.innerHTML = `
    <header class="cam__top">${logo()}<b>WebMix</b><span class="wm-note">${guest ? 'แขกรับเชิญ' : 'กล้องมือถือ'}</span><span class="grow"></span>
      <span class="wm-chip ${live ? 'wm-chip--ok' : ''}" id="cam-chip">${live ? '<span class="wm-dot"></span>เชื่อมต่อแล้ว' : 'ยังไม่เชื่อมต่อ'}</span></header>
    <section class="cam__stage ${state.tally === 'pgm' ? 'is-pgm' : state.tally === 'pvw' ? 'is-pvw' : ''}" id="stage">
      <video class="cam__self ${state.facing === 'user' ? 'is-mirror' : ''} ${guest && live ? 'cam__pip' : ''}" id="self" muted playsinline autoplay></video>
      ${guest ? '<video id="ret" playsinline autoplay></video>' : ''}
      <span class="cam__tally" id="tally">${state.tally === 'pgm' ? 'ON AIR' : state.tally === 'pvw' ? 'PREVIEW' : ''}</span>
      ${!stream ? `<div class="cam__empty"><p class="display">${guest ? 'เข้าร่วมรายการ' : 'ส่งภาพเข้าสตูดิโอ'}</p>
        <p class="body">${studio ? 'ใส่ชื่อแล้วกดเชื่อมต่อ เบราว์เซอร์จะขอใช้กล้องและไมโครโฟน' : 'ลิงก์นี้ไม่สมบูรณ์ ขอลิงก์หรือ QR ใหม่จากสตูดิโอ'}</p></div>` : ''}
    </section>
    <footer class="cam__bar">
      <div class="cam__row">
        <input class="wm-input" id="name" maxlength="40" placeholder="${guest ? 'ชื่อที่จะแสดงในสตูดิโอ' : 'ชื่อกล้อง เช่น กล้องเวที'}" value="${esc(state.name)}" aria-label="ชื่อ">
        <button type="button" class="wm-btn ${live ? '' : 'wm-btn--primary'}" id="go" ${studio ? '' : 'disabled'}>${live ? `${icon('close')}วางสาย` : `${icon('live')}เชื่อมต่อ`}</button>
      </div>
      <div class="cam__row">
        <button type="button" class="wm-btn" id="flip">${icon('refresh')}${state.facing === 'user' ? 'กล้องหน้า' : 'กล้องหลัง'}</button>
        <button type="button" class="wm-btn" id="mic" aria-pressed="${!state.mic}">${icon(state.mic ? 'speaker' : 'mute')}${state.mic ? 'ไมค์เปิด' : 'ไมค์ปิด'}</button>
        <div class="wm-seg" role="group" aria-label="คุณภาพภาพ">${(Object.keys(QUALITY) as Quality[]).map((k) =>
          `<button type="button" data-q="${k}" aria-pressed="${k === state.quality}">${k === 'hd' ? 'HD' : k === 'fhd' ? 'FHD' : '4K'}</button>`).join('')}</div>
      </div>
      <p class="cam__status ${state.error ? 'is-err' : ''}" id="status" role="status">${esc(state.status)}</p>
    </footer>`;
  const self = document.getElementById('self') as HTMLVideoElement;
  if (stream) self.srcObject = stream;
  const ret = document.getElementById('ret') as HTMLVideoElement | null;
  const remote = call?.remoteStream;
  if (ret && remote) ret.srcObject = remote;
}

function say(msg: string, error = false): void {
  state.status = msg;
  state.error = error;
  const el = document.getElementById('status');
  if (el) {
    el.textContent = msg;
    el.classList.toggle('is-err', error);
  }
}

async function openCamera(): Promise<void> {
  const [width, height] = QUALITY[state.quality];
  const next = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: state.facing, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  next.getAudioTracks().forEach((t) => { t.enabled = state.mic; });
  // swap tracks inside a running call so the studio keeps the same input
  const pc = call?.peerConnection;
  if (pc) {
    for (const t of next.getTracks()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === t.kind);
      await sender?.replaceTrack(t);
    }
  }
  stream?.getTracks().forEach((t) => t.stop());
  stream = next;
}

async function connect(): Promise<void> {
  state.wanted = true;
  say('กำลังเปิดกล้อง…');
  try {
    if (!stream) await openCamera();
  } catch (e) {
    state.wanted = false;
    const name = e instanceof DOMException ? e.name : '';
    say(name === 'NotAllowedError' ? 'เบราว์เซอร์ไม่ได้อนุญาตกล้อง เปิดสิทธิ์ที่แถบที่อยู่แล้วลองอีกครั้ง' : 'เปิดกล้องไม่ได้ ลองปิดแอปอื่นที่ใช้กล้องอยู่', true);
    render();
    return;
  }
  render();
  say('กำลังเชื่อมต่อสตูดิโอ…');
  const { Peer } = await import('peerjs');
  peer?.destroy();
  const p = new Peer(peerOptions(sig));
  peer = p;
  p.on('open', () => {
    const metadata = { kind: guest ? 'guest' : 'phone', name: state.name, clientId };
    conn = p.connect(studio, { metadata, reliable: true });
    conn.on('data', (d) => {
      const msg = d as { type?: string; state?: Tally };
      if (msg.type === 'tally' && msg.state) {
        state.tally = msg.state;
        const stage = document.getElementById('stage');
        stage?.classList.toggle('is-pgm', msg.state === 'pgm');
        stage?.classList.toggle('is-pvw', msg.state === 'pvw');
        const t = document.getElementById('tally');
        if (t) t.textContent = msg.state === 'pgm' ? 'ON AIR' : msg.state === 'pvw' ? 'PREVIEW' : '';
      }
    });
    const c = p.call(studio, stream!, { metadata });
    call = c;
    c.on('stream', (remote) => {
      const ret = document.getElementById('ret') as HTMLVideoElement | null;
      if (ret) ret.srcObject = remote;
    });
    c.on('close', () => dropped());
    c.on('error', () => dropped());
    c.peerConnection?.addEventListener('connectionstatechange', () => {
      const st = c.peerConnection.connectionState;
      if (st === 'connected') {
        say(guest ? 'อยู่ในสตูดิโอแล้ว' : 'ส่งภาพเข้าสตูดิโออยู่');
        render();
      } else if (st === 'failed') dropped();
    });
    void navigator.wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => undefined);
  });
  p.on('error', (err: { type: string }) => {
    if (err.type === 'peer-unavailable') say('ไม่พบสตูดิโอ ให้สตูดิโอเปิดหน้า WebMix ค้างไว้แล้วลองอีกครั้ง', true);
    else if (err.type === 'network' || err.type === 'server-error') say('เชื่อมต่อเครือข่ายไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง', true);
    dropped();
  });
}

function dropped(): void {
  if (!call && !peer) return;
  call = null;
  conn = null;
  state.tally = 'off';
  render();
  if (!state.wanted) return;
  // keep trying while the person still wants to be connected (studio reloads, Wi-Fi blips)
  window.clearTimeout(retry);
  say('สายหลุด กำลังเชื่อมต่อใหม่…', true);
  retry = window.setTimeout(() => state.wanted && void connect(), 3000);
}

function hangUp(): void {
  state.wanted = false;
  window.clearTimeout(retry);
  call?.close();
  conn?.close();
  peer?.destroy();
  call = null;
  conn = null;
  peer = null;
  state.tally = 'off';
  void wake?.release().catch(() => undefined);
  say('วางสายแล้ว');
  render();
}

root.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('button');
  if (!el) return;
  if (el.id === 'go') {
    if (call || state.wanted) hangUp();
    else void connect();
  } else if (el.id === 'flip') {
    state.facing = state.facing === 'user' ? 'environment' : 'user';
    void openCamera().then(render).catch(() => say('สลับกล้องไม่ได้ เครื่องนี้อาจมีกล้องเดียว', true));
  } else if (el.id === 'mic') {
    state.mic = !state.mic;
    stream?.getAudioTracks().forEach((t) => { t.enabled = state.mic; });
    render();
  } else if (el.dataset.q) {
    state.quality = el.dataset.q as Quality;
    if (stream) void openCamera().then(render).catch(() => say('กล้องนี้ไม่รองรับความละเอียดนี้', true));
    else render();
  }
});

root.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'name') state.name = t.value;
});

render();
if (!studio) say('ลิงก์นี้ไม่มีรหัสสตูดิโอ', true);
