// A stand-in for the WebMix Stream Gateway used by the end-to-end tests.
// It speaks the same WebSocket protocol (start / add / stop / probe → status / probe),
// checks the token and URLs, and reports the bytes it receives instead of running FFmpeg.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_GATEWAY_PORT || 8090);
const TOKEN = 'test-token';
const OUTPUT_RE = (u) => /^rtmps?:\/\/[^\s]+$/i.test(u) || /^srt:\/\/[^\s/?#]+:\d+(\?[^\s]*)?$/i.test(u);
const stats = { connections: 0, bytes: 0, starts: [], stops: [], params: null };

const server = http.createServer((req, res) => {
  if (req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(stats));
  }
  if (req.url === '/reset') {
    Object.assign(stats, { connections: 0, bytes: 0, starts: [], stops: [], params: null });
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    return res.end('ok');
  }
  res.writeHead(200);
  res.end('WebMix Stream Gateway: OK (mock)');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('token') !== TOKEN) return ws.close(1008, 'invalid token');
  stats.connections++;
  stats.params = Object.fromEntries(url.searchParams);
  const dests = new Map();
  let rx = 0;
  const send = (o) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
  const report = () => send({ type: 'status', rx: Math.round((rx * 8) / 1000), destinations: [...dests.values()] });
  const add = (d) => {
    const ok = OUTPUT_RE(String(d.url || ''));
    dests.set(d.id, { id: d.id, name: d.name, state: ok ? 'connecting' : 'error', message: ok ? '' : 'URL ต้องเป็น rtmp://, rtmps:// หรือ srt://host:port', kbps: 0 });
    if (ok) {
      stats.starts.push(d.url);
      setTimeout(() => { const x = dests.get(d.id); if (x && x.state === 'connecting') x.state = 'live'; report(); }, 300);
    }
    report();
  };
  const timer = setInterval(() => {
    for (const d of dests.values()) if (d.state === 'live') d.kbps = Math.round((rx * 8) / 1000);
    report();
    rx = 0;
  }, 1000);
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      rx += data.length;
      stats.bytes += data.length;
      return;
    }
    const msg = JSON.parse(String(data));
    if (msg.type === 'start') (msg.destinations || []).forEach(add);
    else if (msg.type === 'add') add(msg.destination);
    else if (msg.type === 'stop') {
      stats.stops.push(msg.id);
      const d = dests.get(msg.id);
      if (d) Object.assign(d, { state: 'stopped', kbps: 0 });
      report();
    } else if (msg.type === 'probe') {
      const key = String(msg.destination?.url || '').split('/').pop();
      const ok = OUTPUT_RE(String(msg.destination?.url || '')) && key !== 'bad-key';
      setTimeout(() => send({ type: 'probe', id: msg.destination.id, ok, message: ok ? '' : 'เซิร์ฟเวอร์ปฏิเสธคีย์สตรีม' }), 200);
    }
  });
  ws.on('close', () => clearInterval(timer));
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock gateway on ${PORT}`));
