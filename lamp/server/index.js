// HTTP + WebSocket host for the brain. Serves the browser "body/senses" app and
// the URDF/mesh, and relays JSON messages to/from the Character.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Character } from './character.js';
import { LLM } from './llm.js';
import { Memory } from './memory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.stl': 'model/stl', '.urdf': 'application/xml', '.task': 'application/octet-stream', '.png': 'image/png' };
const MOUNTS = { '/robot/': path.join(ROOT, 'robot'), '/shared/': path.join(ROOT, 'server'), '/': path.join(ROOT, 'web') };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/metrics') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(currentMetrics(), null, 2));
  }
  const mount = Object.keys(MOUNTS).find((m) => url.startsWith(m) && m !== '/') || '/';
  const rel = url === '/' ? 'index.html' : url.slice(mount.length);
  const file = path.normalize(path.join(MOUNTS[mount], rel));
  if (!file.startsWith(MOUNTS[mount])) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
});

const memory = new Memory(path.join(ROOT, 'data', 'memory.json'));
const llm = new LLM();
let character = null;
let sock = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function currentMetrics() {
  const cpu = process.cpuUsage(); const mem = process.memoryUsage();
  return {
    llm: { mode: llm.mock ? 'mock' : 'cloud', ...llm.stats },
    brainProcess: { cpuUserSec: cpu.user / 1e6, cpuSysSec: cpu.system / 1e6, rssMB: +(mem.rss / 1048576).toFixed(1), uptimeSec: Math.round(process.uptime()) },
    perception: character?.metrics.perception, turns: character?.metrics.turns, engagement: character?.metrics.engage,
  };
}

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  if (sock && sock.readyState === 1) sock.close(1000, 'replaced');
  character?.dispose();
  sock = ws;
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  character = new Character({ send, llm, memory, log });
  log('page connected; LLM mode:', llm.mock ? 'MOCK (no ANTHROPIC_API_KEY)' : 'cloud');
  send({ type: 'ui.state', state: 'ABSENT', attn: 0, busy: false, llm: llm.mock ? 'MOCK' : 'cloud' });
  send({ type: 'ui.memory', objects: Object.values(memory.objects) });
  ws.on('message', (d) => { try { character.onMessage(JSON.parse(d.toString())); } catch (e) { log('bad message', e.message); } });
  ws.on('close', () => { log('page disconnected'); });
});

server.listen(PORT, HOST, () => log(`Lumi brain listening on http://${HOST}:${PORT}  (LLM: ${llm.mock ? 'MOCK' : 'cloud'})`));
