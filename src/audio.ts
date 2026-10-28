// Audio mixer: one processing strip per source and a master bus, as in WebMix Pro.
//   input → gate → low-cut → EQ (low / mid / high) → compressor → delay → pan → fader → master
//   fader → MON send → headphone bus
//   master → limiter → post → recording, loudness (LUFS), monitor
import type { Scene } from './scene';
import { media, type Media } from './engine';

export interface Strip {
  input: AudioNode;
  pre: GainNode;
  gate: AudioWorkletNode | null;
  hpf: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  delay: DelayNode;
  pan: StereoPannerNode;
  fader: GainNode;
  analyser: AnalyserNode;
  mon: GainNode;
  /** last values sent to each AudioParam, so unchanged ones are not re-scheduled */
  last: Record<string, number>;
}

let ac: AudioContext | null = null;
let master: GainNode;
let limiter: DynamicsCompressorNode;
let post: GainNode;
let masterAnalyser: AnalyserNode;
let monMaster: GainNode;
let monBus: GainNode;
let recDest: MediaStreamAudioDestinationNode;
let limiterOn: boolean | null = null;
let worklets: Promise<boolean> | null = null;
let gateReady = false;

/* ---------- loudness (EBU R128) ---------- */

const blocks: number[] = [];
const momentary: number[] = [];
const toLufs = (ms: number) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

function onBlock(ms: number): void {
  blocks.push(ms);
  if (blocks.length > 30) blocks.shift();
  if (blocks.length >= 4) momentary.push(mean(blocks.slice(-4)));
  if (momentary.length > 36_000) momentary.shift();
}

export function loudness(): { m: number; s: number; i: number } {
  const m = blocks.length >= 4 ? toLufs(mean(blocks.slice(-4))) : -Infinity;
  const s = blocks.length ? toLufs(mean(blocks)) : -Infinity;
  // integrated: absolute gate at -70 LUFS, then relative gate 10 LU under that mean
  const abs = momentary.filter((x) => toLufs(x) > -70);
  const rel = toLufs(mean(abs)) - 10;
  const gated = abs.filter((x) => toLufs(x) > rel);
  return { m, s, i: gated.length ? toLufs(mean(gated)) : -Infinity };
}

export function resetLoudness(): void {
  blocks.length = 0;
  momentary.length = 0;
}

/* ---------- graph ---------- */

const base = () => new URL('worklets/', document.baseURI).href;

function loadWorklets(ctx: AudioContext): Promise<boolean> {
  return Promise.all([ctx.audioWorklet.addModule(`${base()}gate.js`), ctx.audioWorklet.addModule(`${base()}lufs.js`)])
    .then(() => {
      gateReady = true;
      const lufs = new AudioWorkletNode(ctx, 'webmix-lufs');
      lufs.port.onmessage = (e: MessageEvent<number>) => onBlock(e.data);
      post.connect(lufs);
      // strips made before the worklets loaded get their gate now
      for (const m of media.values()) if (m.strip && !m.strip.gate) insertGate(ctx, m.strip);
      return true;
    })
    .catch(() => false);
}

export function ensureAudio(): AudioContext {
  if (!ac) {
    ac = new AudioContext({ latencyHint: 'interactive' });
    master = ac.createGain();
    limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    post = ac.createGain();
    masterAnalyser = ac.createAnalyser();
    masterAnalyser.fftSize = 2048;
    recDest = ac.createMediaStreamDestination();
    monMaster = ac.createGain();
    monMaster.gain.value = 0;
    monBus = ac.createGain();
    limiter.connect(post);
    post.connect(masterAnalyser);
    post.connect(recDest);
    post.connect(monMaster).connect(ac.destination);
    monBus.connect(ac.destination);
    setLimiter(true);
    worklets = loadWorklets(ac);
  }
  if (ac.state === 'suspended') void ac.resume();
  return ac;
}

export const audioReady = () => worklets ?? Promise.resolve(false);

function setLimiter(on: boolean): void {
  if (limiterOn === on) return;
  limiterOn = on;
  master.disconnect();
  master.connect(on ? limiter : post);
}

function insertGate(ctx: AudioContext, s: Strip): void {
  if (!gateReady) return;
  s.gate = new AudioWorkletNode(ctx, 'webmix-gate', { channelCountMode: 'max' });
  s.pre.disconnect();
  s.pre.connect(s.gate).connect(s.hpf);
}

function makeStrip(m: Media, input: AudioNode): void {
  const ctx = ensureAudio();
  const pre = ctx.createGain();
  const hpf = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' as BiquadFilterType });
  hpf.frequency.value = 10;
  const low = Object.assign(ctx.createBiquadFilter(), { type: 'lowshelf' as BiquadFilterType });
  low.frequency.value = 120;
  const mid = Object.assign(ctx.createBiquadFilter(), { type: 'peaking' as BiquadFilterType });
  mid.frequency.value = 1000;
  mid.Q.value = 1;
  const high = Object.assign(ctx.createBiquadFilter(), { type: 'highshelf' as BiquadFilterType });
  high.frequency.value = 8000;
  const comp = ctx.createDynamicsCompressor();
  comp.ratio.value = 1;
  comp.attack.value = 0.005;
  comp.release.value = 0.2;
  const delay = ctx.createDelay(1);
  const pan = ctx.createStereoPanner();
  const fader = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const mon = ctx.createGain();
  mon.gain.value = 0;
  input.connect(pre);
  pre.connect(hpf).connect(low).connect(mid).connect(high).connect(comp).connect(delay).connect(pan).connect(fader);
  fader.connect(analyser);
  fader.connect(master);
  fader.connect(mon).connect(monBus);
  const strip: Strip = { input, pre, gate: null, hpf, low, mid, high, comp, delay, pan, fader, analyser, mon, last: {} };
  insertGate(ctx, strip);
  m.strip = strip;
}

export function attachStreamAudio(m: Media, stream: MediaStream): void {
  if (!stream.getAudioTracks().length) return;
  makeStrip(m, ensureAudio().createMediaStreamSource(stream));
}

export function attachElementAudio(m: Media, el: HTMLMediaElement): void {
  makeStrip(m, ensureAudio().createMediaElementSource(el));
}

export function releaseStrip(m: Media): void {
  try {
    m.strip?.input.disconnect();
    m.strip?.fader.disconnect();
  } catch { /* already gone */ }
  m.strip = undefined;
}

/* ---------- metering ---------- */

const buf = new Float32Array(2048);

/** peak and RMS of the latest block, in dBFS */
export function meter(an?: AnalyserNode): { peak: number; rms: number } {
  if (!an) return { peak: -Infinity, rms: -Infinity };
  an.getFloatTimeDomainData(buf);
  let sum = 0, peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sum += v * v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  return { peak: 20 * Math.log10(peak || 1e-9), rms: 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-9) };
}

export const masterMeter = () => (ac ? meter(masterAnalyser) : { peak: -Infinity, rms: -Infinity });
export const limiterReduction = () => (ac && limiterOn ? limiter.reduction : 0);

/** level 0..1 for a bar scaled -60..0 dBFS */
export const bar = (db: number) => Math.min(1, Math.max(0, (db + 60) / 60));

/* ---------- live parameters ---------- */

function set(s: Strip, key: string, param: AudioParam, value: number, now: number, tc = 0.03): void {
  if (s.last[key] === value) return;
  s.last[key] = value;
  param.setTargetAtTime(value, now, tc);
}

export function updateAudio(scene: Scene, onAir: (id: string) => boolean): void {
  if (!ac) return;
  const now = ac.currentTime;
  let anyMon = false;
  for (const src of scene.sources) {
    const s = media.get(src.id)?.strip;
    if (!s) continue;
    const p = src.props;
    set(s, 'fader', s.fader.gain, p.muted ? 0 : p.volume * (p.afv && !onAir(src.id) ? 0 : 1), now);
    set(s, 'pan', s.pan.pan, p.pan, now);
    set(s, 'hpf', s.hpf.frequency, p.lowcut ? 80 : 10, now);
    set(s, 'low', s.low.gain, p.eqLow, now);
    set(s, 'mid', s.mid.gain, p.eqMid, now);
    set(s, 'high', s.high.gain, p.eqHigh, now);
    set(s, 'compT', s.comp.threshold, p.comp ? p.compDb : 0, now);
    set(s, 'compR', s.comp.ratio, p.comp ? 4 : 1, now);
    set(s, 'delay', s.delay.delayTime, p.delay / 1000, now, 0.01);
    set(s, 'mon', s.mon.gain, p.mon ? 1 : 0, now);
    const thr = s.gate?.parameters.get('threshold');
    if (thr) set(s, 'gate', thr, p.gate ? p.gateDb : -100, now, 0.001);
    anyMon ||= p.mon;
  }
  master.gain.setTargetAtTime(scene.master, now, 0.03);
  setLimiter(scene.limiter);
  // MON on any channel = listen to those channels only; otherwise the master if monitoring is on
  monMaster.gain.setTargetAtTime(!anyMon && scene.monitor ? 1 : 0, now, 0.03);
}

export function recordAudioTracks(): MediaStreamTrack[] {
  ensureAudio();
  return recDest.stream.getAudioTracks();
}

export async function outputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  } catch {
    return [];
  }
}

export const canPickOutput = () => 'setSinkId' in AudioContext.prototype;

export async function setOutputDevice(id: string): Promise<boolean> {
  const ctx = ensureAudio() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (!ctx.setSinkId) return false;
  try {
    await ctx.setSinkId(id);
    return true;
  } catch {
    return false;
  }
}
