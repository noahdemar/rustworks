// Rustworks dedicated server: authoritative lockstep sim + static files + WebSocket (no deps).
// Usage: node server.js [port]       Then open http://<this-machine>:<port>/ on every player's browser.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const Sim = require('./sim.js');

const PORT = +process.argv[2] || +process.env.PORT || 8080;
const ROOT = __dirname, SAVE = process.env.SAVE_PATH || path.join(ROOT, 'save.json');   // point SAVE_PATH at a mounted disk to keep the world across deploys
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC = new Set(['/index.html', '/sim.js', '/client.js']);

// ---------------------------------------------------------------- load save
let loaded = false;
if (fs.existsSync(SAVE)) {
  try { const snap = JSON.parse(fs.readFileSync(SAVE, 'utf8')); if (snap.v !== 6) throw new Error('old save format (v' + snap.v + ')'); Sim.load(snap); Sim.releaseAll(); loaded = true; console.log(`Loaded save at tick ${Sim.tick} (world seed ${Sim.seed})`); }
  catch (e) { console.warn('Save unreadable, starting fresh:', e.message); }
}
if (!loaded) {   // brand-new procedurally generated world (set WORLD_SEED to replay a particular map)
  const seed = process.env.WORLD_SEED ? +process.env.WORLD_SEED : (Math.random() * 2 ** 31) | 0;
  Sim.newWorld(seed); console.log(`New world, seed ${seed}, landing site (${Sim.SPAWN.x}, ${Sim.SPAWN.y})`);
}
if (!Sim.ents.length) Sim.place('substation', Sim.SPAWN.x - 4, Sim.SPAWN.y - 4, 0, true);
function save() { try { fs.writeFileSync(SAVE + '.tmp', JSON.stringify(Sim.serialize())); fs.renameSync(SAVE + '.tmp', SAVE); } catch (e) { console.warn('save failed', e.message); } }

// ---------------------------------------------------------------- http
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  if (!PUBLIC.has(p)) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// ---------------------------------------------------------------- minimal RFC 6455
const clients = new Set();
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), frag: [], id: 0, name: '', col: '#f0c419', x: 60, y: 60, alive: true, joined: false, lastPos: 0 };
  clients.add(c);
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parseFrames(c); });
  sock.on('close', () => drop(c));
  sock.on('error', () => drop(c));
});
function parseFrames(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 4 * 1024 * 1024) { c.sock.destroy(); return; }
    const mo = off; if (masked) off += 4;
    if (b.length < off + len) return;
    const data = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) data[i] ^= b[mo + (i & 3)];
    c.buf = b.subarray(off + len);
    if (op === 8) { c.sock.end(); drop(c); return; }
    if (op === 9) { sendFrame(c, data, 10); continue; }
    if (op === 10) continue;
    if (op === 0 || op === 1 || op === 2) {
      c.frag.push(data);
      if (fin) { const msg = Buffer.concat(c.frag).toString('utf8'); c.frag = []; try { onMsg(c, JSON.parse(msg)); } catch (e) { /* ignore bad json */ } }
    }
  }
}
function sendFrame(c, payload, op = 1) {
  if (!c.alive) return;
  const n = payload.length; let h;
  if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
  else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  h[0] = 0x80 | op;
  try { c.sock.write(Buffer.concat([h, payload])); } catch (e) { drop(c); }
}
const send = (c, o) => sendFrame(c, Buffer.from(JSON.stringify(o)));
const bcast = (o, except) => { const p = Buffer.from(JSON.stringify(o)); for (const c of clients) if (c.joined && c !== except) sendFrame(c, p); };

// ---------------------------------------------------------------- players & lockstep
let nextPid = 1, pending = [], sums = [], hist = [];   // hist: recent snapshots at checksum ticks, for desync diagnosis
const players = () => [...clients].filter(c => c.joined).map(c => ({ id: c.id, name: c.name, col: c.col }));
function drop(c) {
  if (!c.alive) return; c.alive = false; clients.delete(c);
  try { c.sock.destroy(); } catch (e) {}
  if (c.joined) { if ([...clients].some(o => o.joined && o !== c)) pending.push([c.id, { k: 'exit' }]); else Sim.applyCmd(c.id, { k: 'exit' });
    bcast({ t: 'leave', id: c.id }); bcast({ t: 'pl', list: players() }); log(`${c.name} left`); }
}
function onMsg(c, m) {
  switch (m.t) {
    case 'hello': {
      if (c.joined) return;
      c.id = nextPid++; c.name = String(m.name || 'Engineer').replace(/[<>]/g, '').slice(0, 16) || 'Engineer';
      c.col = /^#[0-9a-f]{6}$/i.test(m.col) ? m.col : '#f0c419'; c.joined = true;
      c.x = Sim.SPAWN.x + .5 + (c.id % 4) * 1.2; c.y = Sim.SPAWN.y + .5;
      send(c, { t: 'welcome', id: c.id, snap: Sim.serialize(), players: players(), pos: [...clients].filter(o => o.joined && o !== c).map(o => [o.id, o.x, o.y, o.dir || 0]), you: [c.x, c.y] });
      bcast({ t: 'pl', list: players() }); bcast({ t: 'chat', id: 0, text: `${c.name} joined` });
      log(`${c.name} joined (${clients.size} online)`);
      break;
    }
    case 'cmd': if (c.joined && m.c && typeof m.c === 'object') pending.push([c.id, m.c]); break;
    case 'pos': {
      if (!c.joined) return;
      const x = +m.x, y = +m.y; if (!isFinite(x) || !isFinite(y)) return;
      c.x = x; c.y = y; c.dir = m.d | 0;
      bcast({ t: 'pos', id: c.id, x, y, d: c.dir, m: !!m.m, cx: m.cx, cy: m.cy, b: m.b || 0 }, c);
      break;
    }
    case 'chat': if (c.joined) bcast({ t: 'chat', id: c.id, text: String(m.text || '').slice(0, 200) }); break;
    case 'resync': if (c.joined) {
      const h = hist.find(q => q[0] === (m.at | 0));
      send(c, { t: 'snap', snap: Sim.serialize(), dbgAt: h ? h[0] : 0, dbg: h ? h[1] : null });
      log(`resync requested by ${c.name} (mismatch at tick ${m.at})`);
    } break;
  }
}

// ---------------------------------------------------------------- loop: 60 Hz sim, ~30 Hz batches
const TICK_MS = 1000 / 60;
let last = Date.now(), acc = 0, batchCmds = [];
Sim.hooks.onEvent = () => {}; Sim.hooks.onCmd = () => {};
setInterval(() => {
  const now = Date.now(); acc += now - last; last = now;
  if (![...clients].some(c => c.joined)) { acc = 0; pending = []; return; }   // pause with nobody online
  if (acc > 250) acc = 250;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    const tk = Sim.tick + 1;
    for (const [pid, cmd] of pending) { Sim.applyCmd(pid, cmd); batchCmds.push([tk, pid, cmd]); }
    pending = [];
    Sim.step();
    if (Sim.tick % 120 === 0) { sums.push([Sim.tick, Sim.checksum()]); hist.push([Sim.tick, JSON.stringify(Sim.serialize())]); if (hist.length > 4) hist.shift(); }
  }
}, 4);
setInterval(() => {
  if (![...clients].some(c => c.joined)) return;
  bcast({ t: 'b', upto: Sim.tick, cmds: batchCmds, sums });
  batchCmds = []; sums = [];
}, 33);
setInterval(() => { if ([...clients].some(c => c.joined)) save(); }, 60000);
process.on('SIGINT', () => { save(); console.log('\nSaved. Bye.'); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });

const log = s => console.log(new Date().toISOString().slice(11, 19), s);
server.listen(PORT, () => {
  console.log(`Rustworks server on port ${PORT}`);
  console.log(`  local:  http://localhost:${PORT}/`);
  for (const ifs of Object.values(os.networkInterfaces())) for (const a of ifs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  LAN:    http://${a.address}:${PORT}/`);
});
