// The ไลฟ์ dialog: Stream Gateway address, up to six destinations, start / stop / check each one.
// Stream keys live only in memory; the gateway address (it carries a token) only for this tab.
import { icon } from './icons';
import { destinationUrl, gatewayProblem, PLATFORMS, Streamer, type Destination, type Platform } from './stream';

const DEST_KEY = 'webmix-lite.destinations.v1';
const GATEWAY_KEY = 'webmix-lite.gateway';
const MAX_DEST = 6;

export interface LiveContext {
  openDialog(title: string, body: string, foot: string): HTMLDialogElement;
  closeDialog(): void;
  toast(msg: string): void;
  esc(s: string): string;
  canvas(): HTMLCanvasElement;
  output(): { fps: number; height: number };
  /** live state changed: refresh the top bar */
  onChange(): void;
}

const STATE_LABEL: Record<Destination['state'], [string, string]> = {
  idle: ['พร้อม', ''],
  connecting: ['กำลังเชื่อมต่อ', 'wm-chip--warn'],
  live: ['LIVE', 'wm-chip--live'],
  error: ['ผิดพลาด', 'wm-chip--warn'],
  stopped: ['หยุดแล้ว', ''],
};

const KBPS_FOR: Record<number, number> = { 720: 4500, 1080: 6000, 2160: 20000 };

function loadDests(): Destination[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DEST_KEY) ?? '[]') as Partial<Destination>[];
    return raw.slice(0, MAX_DEST).map((d, i) => blank(d.platform ?? 'youtube', {
      id: d.id ?? `d${i}`, name: d.name ?? '', enabled: d.enabled ?? true,
      // SRT URLs can carry a passphrase: those are never kept
      server: d.platform === 'srt' ? '' : d.server ?? PLATFORMS[d.platform ?? 'youtube'].server,
    }));
  } catch {
    return [];
  }
}

function saveDests(list: Destination[]): void {
  try {
    localStorage.setItem(DEST_KEY, JSON.stringify(list.map((d) => ({
      id: d.id, platform: d.platform, name: d.name, enabled: d.enabled, server: d.platform === 'srt' ? '' : d.server,
    }))));
  } catch { /* storage full: destinations are re-entered */ }
}

function blank(platform: Platform, extra: Partial<Destination> = {}): Destination {
  return {
    id: `d${Math.random().toString(36).slice(2, 8)}`, platform, name: '', server: PLATFORMS[platform].server, key: '',
    enabled: true, state: 'idle', message: '', kbps: 0, ...extra,
  };
}

export function createLivePanel(ctx: LiveContext) {
  const dests = loadDests();
  if (!dests.length) dests.push(blank('youtube'));
  let gateway = '';
  try {
    gateway = sessionStorage.getItem(GATEWAY_KEY) ?? '';
  } catch { /* private mode */ }
  let kbps = 0;
  let streamer: Streamer | null = null;
  let error = '';
  const { esc } = ctx;

  const isOpen = () => !!document.querySelector('#dlg[open] .live-panel');
  const bitrate = () => kbps || KBPS_FOR[ctx.output().height] || 6000;

  function ensureStreamer(): Streamer | null {
    const problem = gatewayProblem(gateway);
    if (problem) {
      error = problem;
      renderStatus();
      return null;
    }
    // an idle connection object is rebuilt so a new gateway, bitrate or output size applies
    if (streamer && !streamer.live && !streamer.ws) streamer = null;
    if (!streamer) {
      const out = ctx.output();
      streamer = new Streamer(gateway, {
        canvas: ctx.canvas(), fps: out.fps, kbps: bitrate(), height: out.height,
        onStatus: () => {
          renderStatus();
          ctx.onChange();
        },
        onError: (m) => {
          error = m;
          renderStatus();
          ctx.toast(m);
        },
      }, dests);
    }
    return streamer;
  }

  /** forget the connection once nothing is live, so new settings apply next time */
  function settle(): void {
    if (streamer && !streamer.ws && !streamer.live) streamer = null;
    ctx.onChange();
  }

  function destCard(d: Destination): string {
    const [label, tone] = STATE_LABEL[d.state];
    const busy = d.state === 'live' || d.state === 'connecting';
    const p = PLATFORMS[d.platform];
    return `
      <div class="dest" data-dest="${d.id}">
        <div class="dest__head">
          <select class="wm-input dest__platform" data-f="platform" aria-label="แพลตฟอร์ม" ${busy ? 'disabled' : ''}>
            ${(Object.keys(PLATFORMS) as Platform[]).map((k) => `<option value="${k}" ${k === d.platform ? 'selected' : ''}>${PLATFORMS[k].label}</option>`).join('')}
          </select>
          <span class="wm-chip ${tone}" data-state>${d.state === 'live' ? '<span class="wm-dot"></span>' : ''}${label}</span>
          <b class="dest__kbps timecode" data-kbps>${d.state === 'live' ? `${d.kbps} kbps` : ''}</b>
          <button type="button" class="wm-btn wm-btn--icon wm-btn--ghost" data-live="remove" aria-label="ลบปลายทาง" ${busy ? 'disabled' : ''}>${icon('trash')}</button>
        </div>
        <label class="wm-field"><span>ชื่อ (ไม่บังคับ)</span><input class="wm-input" data-f="name" value="${esc(d.name)}" placeholder="${p.label}" autocomplete="off"></label>
        <label class="wm-field"><span>URL เซิร์ฟเวอร์</span><input class="wm-input" data-f="server" value="${esc(d.server)}" placeholder="${d.platform === 'srt' ? 'srt://host:9000?streamid=…' : 'rtmp://'}" autocomplete="off" spellcheck="false" ${busy ? 'disabled' : ''}></label>
        ${d.platform === 'srt' ? '' : `<label class="wm-field"><span>คีย์สตรีม</span><span class="key-row">
          <input class="wm-input" data-f="key" type="password" value="${esc(d.key)}" placeholder="วางคีย์ที่นี่" autocomplete="off" spellcheck="false" ${busy ? 'disabled' : ''}>
          <button type="button" class="wm-btn" data-live="show">${icon('eye')}แสดง</button></span></label>`}
        <p class="wm-help ${d.state === 'error' ? 'wm-help--err' : ''}" data-msg>${esc(d.message || p.hint)}</p>
        <div class="wm-row">
          <button type="button" class="wm-btn" data-live="probe" ${busy ? 'disabled' : ''}>ตรวจคีย์</button>
          ${busy ? `<button type="button" class="wm-btn" data-live="stop">${icon('stop')}หยุด</button>`
            : `<button type="button" class="wm-btn" data-live="start">${icon('live')}เริ่มช่องนี้</button>`}
          <label class="dest__on"><input type="checkbox" data-f="enabled" ${d.enabled ? 'checked' : ''}> รวมใน "เริ่มทั้งหมด"</label>
        </div>
      </div>`;
  }

  function body(): string {
    const out = ctx.output();
    return `<div class="live-panel">
      <label class="wm-field"><span>Stream Gateway</span>
        <input class="wm-input" id="gw" value="${esc(gateway)}" placeholder="wss://live.example.com/?token=…" autocomplete="off" spellcheck="false" ${streamer?.ws ? 'disabled' : ''}>
        <span class="wm-help ${error ? 'wm-help--err' : ''}" id="gw-msg">${esc(error || 'เบราว์เซอร์ส่ง RTMP / SRT เองไม่ได้ ต้องผ่าน Stream Gateway ของ WebMix (ตัวเดียวกับ WebMix Pro) จำไว้เฉพาะแท็บนี้')}</span>
        <a class="wm-help live-panel__link" href="https://github.com/jugkritso-png/webmix-studio-lite#stream-gateway" target="_blank" rel="noopener">วิธีติดตั้ง Gateway ด้วยคำสั่งเดียว</a></label>
      <label class="wm-field"><span>บิตเรตวิดีโอ (${out.height}p${out.fps})</span><select class="wm-input" id="kbps" ${streamer?.ws ? 'disabled' : ''}>
        <option value="0" ${kbps === 0 ? 'selected' : ''}>อัตโนมัติ (${KBPS_FOR[out.height] ?? 6000} kbps)</option>
        ${[2500, 4500, 6000, 9000, 12000, 20000, 35000].map((v) => `<option value="${v}" ${kbps === v ? 'selected' : ''}>${v} kbps</option>`).join('')}
      </select></label>
      <div class="live-panel__list" id="dests">${dests.map(destCard).join('')}</div>
      ${dests.length < MAX_DEST ? `<button type="button" class="wm-btn" data-live="add">${icon('plus')}เพิ่มปลายทาง</button>` : ''}
      <p class="wm-note">ส่งพร้อมกันได้สูงสุด ${MAX_DEST} ปลายทาง ใช้อินเทอร์เน็ตขาขึ้นของเครื่องนี้เท่ากับสตรีมเดียว · คีย์สตรีมไม่ถูกบันทึกที่ใด</p>
    </div>`;
  }

  function foot(): string {
    const live = streamer?.live;
    return `<button class="wm-btn" value="close">ปิด</button>
      ${live ? `<button type="button" class="wm-btn wm-btn--live" data-live="stop-all">${icon('stop')}หยุดไลฟ์ทั้งหมด</button>` : ''}
      <button type="button" class="wm-btn wm-btn--primary" data-live="start-all">${icon('live')}เริ่มทั้งหมด</button>`;
  }

  function open(platform?: Platform): void {
    if (platform && !streamer?.live) {
      const idle = dests.find((d) => d.state !== 'live' && d.state !== 'connecting' && !d.key && d.platform !== platform);
      if (dests.length === 1 && idle) Object.assign(idle, { platform, server: PLATFORMS[platform].server });
      else if (!dests.some((d) => d.platform === platform) && dests.length < MAX_DEST) dests.push(blank(platform));
      saveDests(dests);
    }
    const d = ctx.openDialog('ไลฟ์', body(), foot());
    d.querySelector('.dlg__box')?.classList.add('dlg__box--wide');
    wire(d);
  }

  function rerender(): void {
    if (!isOpen()) return;
    const d = document.getElementById('dlg') as HTMLDialogElement;
    const scroll = d.querySelector('.dlg__body')?.scrollTop ?? 0;
    d.querySelector('.dlg__body')!.innerHTML = body();
    d.querySelector('.dlg__foot')!.innerHTML = foot();
    d.querySelector('.dlg__body')!.scrollTop = scroll;
  }

  /** status only: never touches inputs the operator may be typing in */
  function renderStatus(): void {
    if (!isOpen()) return;
    for (const d of dests) {
      const card = document.querySelector<HTMLElement>(`.dest[data-dest="${d.id}"]`);
      if (!card) continue;
      const busy = d.state === 'live' || d.state === 'connecting';
      const wasBusy = !!card.querySelector('[data-live="stop"]');
      if (busy !== wasBusy) return rerender();
      const [label, tone] = STATE_LABEL[d.state];
      const chip = card.querySelector('[data-state]')!;
      chip.className = `wm-chip ${tone}`;
      chip.innerHTML = `${d.state === 'live' ? '<span class="wm-dot"></span>' : ''}${label}`;
      card.querySelector('[data-kbps]')!.textContent = d.state === 'live' ? `${d.kbps} kbps` : '';
      const msg = card.querySelector('[data-msg]')!;
      msg.textContent = d.message || PLATFORMS[d.platform].hint;
      msg.classList.toggle('wm-help--err', d.state === 'error');
    }
    const gm = document.getElementById('gw-msg');
    if (gm && error) {
      gm.textContent = error;
      gm.classList.add('wm-help--err');
    }
    const f = document.querySelector('#dlg .dlg__foot');
    if (f && !!f.querySelector('[data-live="stop-all"]') !== !!streamer?.live) f.innerHTML = foot();
  }

  function confirmStopAll(): void {
    const live = dests.filter((d) => d.state === 'live' || d.state === 'connecting').length;
    const d = ctx.openDialog('หยุดไลฟ์ทั้งหมด', `<p class="body">ปลายทาง ${live} ช่องจะหยุดออกอากาศทันที ผู้ชมจะเห็นว่าไลฟ์จบแล้ว</p>`,
      `<button type="button" class="wm-btn" data-live="back">ไลฟ์ต่อ</button><button type="button" class="wm-btn wm-btn--live" data-live="confirm-stop">${icon('stop')}หยุดไลฟ์</button>`);
    d.querySelector('[data-live="back"]')?.addEventListener('click', () => open());
    d.querySelector('[data-live="confirm-stop"]')?.addEventListener('click', () => {
      streamer?.stopAll();
      settle();
      ctx.toast('หยุดไลฟ์ทุกปลายทางแล้ว');
      open();
    });
  }

  function wire(d: HTMLDialogElement): void {
    d.oninput = (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'gw') {
        gateway = t.value.trim();
        error = '';
        try {
          sessionStorage.setItem(GATEWAY_KEY, gateway);
        } catch { /* private mode */ }
        return;
      }
      const card = t.closest<HTMLElement>('.dest');
      const dest = dests.find((x) => x.id === card?.dataset.dest);
      if (!dest || !t.dataset.f || t.dataset.f === 'platform' || t.dataset.f === 'enabled') return;
      (dest as unknown as Record<string, string>)[t.dataset.f] = t.value;
      if (t.dataset.f !== 'key') saveDests(dests);
    };
    d.onchange = (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'kbps') {
        kbps = Number(t.value);
        return;
      }
      const card = t.closest<HTMLElement>('.dest');
      const dest = dests.find((x) => x.id === card?.dataset.dest);
      if (!dest) return;
      if (t.dataset.f === 'platform') {
        const platform = t.value as Platform;
        Object.assign(dest, { platform, server: PLATFORMS[platform].server, message: '', state: 'idle' });
        saveDests(dests);
        rerender();
      } else if (t.dataset.f === 'enabled') {
        dest.enabled = t.checked;
        saveDests(dests);
      }
    };
    d.onclick = (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-live]');
      if (!b) return;
      const card = b.closest<HTMLElement>('.dest');
      const dest = dests.find((x) => x.id === card?.dataset.dest);
      const act = b.dataset.live;
      if (act === 'add') {
        dests.push(blank('youtube'));
        saveDests(dests);
        rerender();
      } else if (act === 'remove' && dest) {
        dests.splice(dests.indexOf(dest), 1);
        saveDests(dests);
        rerender();
      } else if (act === 'show' && card) {
        const k = card.querySelector<HTMLInputElement>('[data-f="key"]')!;
        k.type = k.type === 'password' ? 'text' : 'password';
        b.lastChild!.textContent = k.type === 'password' ? 'แสดง' : 'ซ่อน';
      } else if (act === 'probe' && dest) {
        const s = ensureStreamer();
        s?.probe(dest.id).catch((err: Error) => { error = err.message; renderStatus(); settle(); });
      } else if (act === 'start' && dest) {
        const s = ensureStreamer();
        s?.start([dest.id]).catch((err: Error) => { error = err.message; dest.state = 'error'; dest.message = err.message; rerender(); settle(); });
      } else if (act === 'stop' && dest) {
        streamer?.stop(dest.id);
        settle();
        rerender();
      } else if (act === 'start-all') {
        const ids = dests.filter((x) => x.enabled && x.state !== 'live' && x.state !== 'connecting').map((x) => x.id);
        if (!ids.length) return ctx.toast('ติ๊ก "รวมใน เริ่มทั้งหมด" ให้อย่างน้อยหนึ่งปลายทาง');
        const bad = dests.filter((x) => ids.includes(x.id)).map((x) => [x, destinationUrl(x)] as const).find(([, r]) => 'error' in r);
        if (bad) {
          const [x, r] = bad;
          Object.assign(x, { state: 'error', message: (r as { error: string }).error });
          return renderStatus();
        }
        const s = ensureStreamer();
        s?.start(ids).catch((err: Error) => { error = err.message; rerender(); settle(); });
      } else if (act === 'stop-all') {
        confirmStopAll();
      }
    };
  }

  return {
    open,
    get streamer() { return streamer; },
    get live() { return !!streamer?.live; },
    get gateway() { return gateway; },
    liveCount: () => dests.filter((d) => d.state === 'live').length,
  };
}
