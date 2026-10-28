// Phone cameras and remote guests over WebRTC (PeerJS), like WebMix Pro.
// The studio owns one PeerJS id; cam.html on a phone or laptop calls it with its camera.
// Guests also get the Program picture back with a mix-minus of the audio (they do not hear themselves).
// Without a Stream Gateway this uses the public PeerJS broker (works on most Wi-Fi; mobile data
// behind strict NAT needs the TURN server that a gateway provides).
import type { DataConnection, MediaConnection, Peer as PeerT, PeerOptions } from 'peerjs';

export type RemoteKind = 'phone' | 'guest';
export type Tally = 'pgm' | 'pvw' | 'off';

export interface Signal {
  /** PeerJS server */
  h?: string;
  p?: number;
  s?: 0 | 1;
  pa?: string;
  /** TURN server and short-lived credentials from a gateway */
  th?: string;
  tp?: number;
  u?: string;
  c?: string;
}

export interface Caller {
  peerId: string;
  clientId: string;
  kind: RemoteKind;
  name: string;
}

let PeerClass: typeof PeerT | null = null;
async function loadPeer(): Promise<typeof PeerT> {
  if (!PeerClass) PeerClass = (await import('peerjs')).Peer;
  return PeerClass;
}

export const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

/** ?peer=host:port[/path] on the studio page points at a self-hosted PeerJS server */
export function signalFromLocation(): Signal | null {
  const q = new URLSearchParams(location.search);
  const sig = q.get('sig');
  if (sig) {
    try {
      return JSON.parse(unb64url(sig)) as Signal;
    } catch { /* ignore a broken link */ }
  }
  const peer = q.get('peer');
  if (!peer) return null;
  const m = /^([^:/]+)(?::(\d+))?(\/.*)?$/.exec(peer);
  if (!m) return null;
  const local = ['localhost', '127.0.0.1'].includes(m[1]);
  return { h: m[1], p: Number(m[2] ?? (local ? 9000 : 443)), s: local ? 0 : 1, pa: m[3] ?? '/' };
}

export function peerOptions(sig: Signal | null): PeerOptions {
  const o: PeerOptions = { debug: 0 };
  if (sig?.h) Object.assign(o, { host: sig.h, port: sig.p ?? 443, secure: sig.s !== 0, path: sig.pa ?? '/' });
  const ice: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (sig?.th && sig.u && sig.c) {
    const port = sig.tp ?? 3478;
    ice.push({ urls: [`turn:${sig.th}:${port}?transport=udp`, `turn:${sig.th}:${port}?transport=tcp`], username: sig.u, credential: sig.c });
  }
  o.config = { iceServers: ice };
  return o;
}

/** ask a gateway for its PeerJS + TURN details (GET /ice?token=…), as Pro does */
export async function signalFromGateway(gateway: string): Promise<Signal | null> {
  try {
    const u = new URL(gateway);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/ice';
    const res = await fetch(u.toString(), { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json() as { peer?: { host: string; port: number; secure: boolean; path: string }; turn?: { host: string; port: number; username: string; credential: string } };
    const sig: Signal = {};
    if (j.peer) Object.assign(sig, { h: j.peer.host, p: j.peer.port, s: j.peer.secure ? 1 : 0, pa: j.peer.path });
    if (j.turn) Object.assign(sig, { th: j.turn.host, tp: j.turn.port, u: j.turn.username, c: j.turn.credential });
    return Object.keys(sig).length ? sig : null;
  } catch {
    return null;
  }
}

export interface StudioHandlers {
  /** a phone or guest started sending; return the source id to show it under */
  onStream(caller: Caller, stream: MediaStream): void;
  onLeave(caller: Caller): void;
  onStatus(): void;
  /** Program picture + mix-minus audio for a guest identified by clientId */
  returnFeed(clientId: string): MediaStream;
}

const ID_KEY = 'webmix-lite.studio-id';

export class Studio {
  peer: PeerT | null = null;
  id = '';
  status: 'offline' | 'connecting' | 'ready' | 'unavailable' = 'offline';
  private conns = new Map<string, DataConnection>();
  private calls = new Map<string, MediaConnection>();
  private tallies = new Map<string, Tally>();
  sig: Signal | null;

  constructor(private h: StudioHandlers, sig: Signal | null) {
    this.sig = sig;
  }

  async start(): Promise<void> {
    if (this.peer && !this.peer.destroyed) return;
    let id = '';
    try {
      id = localStorage.getItem(ID_KEY) ?? '';
      if (!id) {
        id = `webmix-lite-${Math.random().toString(36).slice(2, 8)}`;
        localStorage.setItem(ID_KEY, id);
      }
    } catch {
      id = `webmix-lite-${Math.random().toString(36).slice(2, 8)}`;
    }
    this.create(await loadPeer().catch(() => null), id, 0);
  }

  private create(Peer: typeof PeerT | null, id: string, attempt: number): void {
    if (!Peer) {
      this.status = 'unavailable';
      this.h.onStatus();
      return;
    }
    const peer = new Peer(id, peerOptions(this.sig));
    this.peer = peer;
    this.status = 'connecting';
    this.h.onStatus();
    peer.on('open', (openId) => {
      this.id = openId;
      this.status = 'ready';
      this.h.onStatus();
    });
    peer.on('disconnected', () => {
      this.status = 'connecting';
      this.h.onStatus();
      window.setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 2000);
    });
    peer.on('error', (err: { type: string }) => {
      if (err.type === 'unavailable-id') {
        // after a reload the broker may still hold our id for a moment; then fall back to a fresh one
        peer.destroy();
        window.setTimeout(() => this.create(Peer, attempt < 3 ? id : `webmix-lite-${Math.random().toString(36).slice(2, 8)}`, attempt + 1), 2000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(err.type)) {
        this.status = 'offline';
        this.h.onStatus();
      }
    });
    peer.on('connection', (conn) => {
      this.conns.set(conn.peer, conn);
      conn.on('open', () => {
        const t = this.tallies.get(conn.peer);
        if (t) void conn.send({ type: 'tally', state: t });
      });
      conn.on('close', () => this.conns.delete(conn.peer));
    });
    peer.on('call', (call) => this.onCall(call));
  }

  private onCall(call: MediaConnection): void {
    const md = (call.metadata ?? {}) as { kind?: string; name?: string; clientId?: string };
    const caller: Caller = {
      peerId: call.peer,
      clientId: String(md.clientId || call.peer).slice(0, 64),
      kind: md.kind === 'guest' ? 'guest' : 'phone',
      name: String(md.name || '').slice(0, 40),
    };
    this.calls.get(caller.clientId)?.close();
    this.calls.set(caller.clientId, call);
    if (caller.kind === 'guest') call.answer(this.h.returnFeed(caller.clientId));
    else call.answer();
    let got = false;
    call.on('stream', (stream) => {
      if (got) return; // PeerJS can fire once per track
      got = true;
      this.h.onStream(caller, stream);
    });
    call.on('close', () => {
      if (this.calls.get(caller.clientId) === call) {
        this.calls.delete(caller.clientId);
        this.h.onLeave(caller);
      }
    });
  }

  link(kind: RemoteKind, name = ''): string {
    const u = new URL('cam.html', document.baseURI);
    u.searchParams.set('call', this.id);
    if (kind === 'guest') {
      u.searchParams.set('guest', '1');
      if (name) u.searchParams.set('name', name);
    }
    if (this.sig) u.searchParams.set('sig', b64url(JSON.stringify(this.sig)));
    return u.toString();
  }

  /** tell a phone / guest whether it is on air (red), in preview (green) or neither */
  tally(peerId: string, state: Tally): void {
    if (this.tallies.get(peerId) === state) return;
    this.tallies.set(peerId, state);
    const conn = this.conns.get(peerId);
    if (conn?.open) void conn.send({ type: 'tally', state });
  }

  hangUp(clientId: string): void {
    this.calls.get(clientId)?.close();
  }

  destroy(): void {
    this.peer?.destroy();
    this.peer = null;
    this.status = 'offline';
  }
}
