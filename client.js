// Rustworks client — renders the shared deterministic sim (sim.js), runs the player, UI and networking.
(function () {
'use strict';
const S = window.Sim;
const { T, W, H, DX, DY, DIRN, DT, ITEMS, FLUIDS, BULK, ALLOC, IMPORTS, MATS, DEFS, stores, costOf, GROUPS, hash, mulberry, vnoise, fbm, waterField, water, isWater,
  oreType, oreAmt, ob, cells, ents, trucks, stats, power, creep, hives, flights, bugs, get, fp, l2w, beltPoint, handPos, excTiles,
  RESIDUE_CAP, BIN_CAP, TRUCK_CAP } = S;
const PI = Math.PI;
const particles = [];

const ORECOL = {
  bauxite:   { base: '#9a4a24', hi: '#d9844f', dark: '#40180a' },
  coal:      { base: '#28282b', hi: '#62636a', dark: '#09090a' },
  limestone: { base: '#b8b2a2', hi: '#ebe6d8', dark: '#6f6a5c' },
};
// =====================================================================
//  terrain rendering
// =====================================================================
// The world is far too big for one canvas, so terrain is drawn lazily in 32x32-tile chunks at half
// resolution (the pixel-art pass never shows more than 16 px per tile anyway) and kept in a small LRU cache.
// Each chunk is a pure function of the world seed plus current mining state.
const CH = 32, CS = .5, MAXC = 64, chunkCache = new Map();
let tg = null;   // the chunk context terrain helpers draw into (world coordinates)
function poly(g, pts, ox, oy) { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x + ox, y + oy) : g.moveTo(x + ox, y + oy)); g.closePath(); }
function rock(g, x, y, rad, col, rnd) {
  const pts = [], k = 6 + (rnd() * 3 | 0);
  for (let i = 0; i < k; i++) { const a = i / k * 2 * PI + rnd() * .5, rr = rad * (.72 + rnd() * .38); pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * .82]); }
  g.fillStyle = 'rgba(0,0,0,.45)'; poly(g, pts, 1.6, 2.2); g.fill();
  g.fillStyle = col.base; poly(g, pts, 0, 0); g.fill();
  g.save(); g.clip();
  g.fillStyle = col.hi; g.globalAlpha = .75;
  g.beginPath(); g.ellipse(x - rad * .35, y - rad * .42, rad * .55, rad * .4, -.5, 0, 2 * PI); g.fill();
  g.globalAlpha = .5; g.fillStyle = col.dark;
  g.beginPath(); g.ellipse(x + rad * .45, y + rad * .5, rad * .7, rad * .45, -.5, 0, 2 * PI); g.fill();
  g.restore();
  g.strokeStyle = col.dark; g.lineWidth = .8; poly(g, pts, 0, 0); g.stroke();
}
function pisolite(g, x, y, r, rnd) {
  const cols = ['#8e3f1d', '#a8552a', '#6e2c12', '#c2703a', '#7c3418'];
  g.fillStyle = 'rgba(0,0,0,.4)'; g.beginPath(); g.arc(x + .8, y + 1, r, 0, 2 * PI); g.fill();
  g.fillStyle = cols[rnd() * cols.length | 0]; g.beginPath(); g.arc(x, y, r, 0, 2 * PI); g.fill();
  g.fillStyle = 'rgba(255,200,160,.35)'; g.beginPath(); g.arc(x - r * .35, y - r * .35, r * .4, 0, 2 * PI); g.fill();
}

function buildChunk(cx, cy) {
  const x0 = cx * CH, y0 = cy * CH, px = CH * T * CS;
  const cv = document.createElement('canvas'); cv.width = cv.height = px;
  const g = cv.getContext('2d'), id = g.createImageData(px, px), d = id.data;
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const wxp = x0 * T + x / CS, wyp = y0 * T + y / CS, sx = wxp / 4, sy = wyp / 4, tx = wxp / T, ty = wyp / T;
    const n = fbm(sx / 55, sy / 55, 1 + S.seed), gv = fbm(sx / 26, sy / 26, 9 + S.seed), f = (hash(sx | 0, sy | 0, 3) - .5) * 10;
    let r = 90 + n * 34, gg = 80 + n * 28, b = 54 + n * 18;
    const gt = Math.max(0, Math.min(1, (gv - .52) * 3.2)) * .85;
    r += (62 - r) * gt; gg += (76 - gg) * gt; b += (42 - b) * gt;
    const wf = waterField(tx, ty);
    if (wf > 0) { const dp = Math.min(1, wf * 2.2); r = 52 + (20 - 52) * dp; gg = 84 + (46 - 84) * dp; b = 88 + (66 - 88) * dp; }
    else if (wf > -.14) { const s2 = 1 + wf / .14; r += (64 - r) * s2 * .8; gg += (60 - gg) * s2 * .8; b += (46 - b) * s2 * .8; }
    const i = (x + y * px) * 4; d[i] = r + f; d[i + 1] = gg + f; d[i + 2] = b + f; d[i + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  g.setTransform(CS, 0, 0, CS, -x0 * T * CS, -y0 * T * CS);
  tg = g;
  const rnd = mulberry((cx * 73856093) ^ (cy * 19349663) ^ S.seed);
  const X0 = x0 * T, Y0 = y0 * T, SZ = CH * T;
  const land = (x, y) => !water[(x / T | 0) + (y / T | 0) * W];
  for (let i = 0; i < CH * CH * 8; i++) {
    const x = X0 + rnd() * SZ, y = Y0 + rnd() * SZ; if (!land(x, y)) continue;
    tg.fillStyle = rnd() < .55 ? 'rgba(20,16,8,.2)' : 'rgba(220,215,180,.06)';
    tg.fillRect(x, y, 2 + rnd() * 2, 2 + rnd() * 2);
  }
  const peb = { base: '#6a604e', hi: '#9a8e76', dark: '#2a2519' };
  for (let i = 0; i < CH * CH * .5; i++) { const x = X0 + rnd() * SZ, y = Y0 + rnd() * SZ; if (land(x, y)) rock(tg, x, y, 1.2 + rnd() * 2.2, peb, rnd); }
  for (let i = 0; i < CH * CH * 1.2; i++) {
    const x = X0 + rnd() * SZ, y = Y0 + rnd() * SZ; if (!land(x, y)) continue;
    const veg = fbm(x / 4 / 26, y / 4 / 26, 9 + S.seed);
    if (veg < .5 && rnd() < .6) continue;
    if (veg > .6 && rnd() < .12) {
      const r0 = 3 + rnd() * 5;
      tg.fillStyle = 'rgba(0,0,0,.3)'; tg.beginPath(); tg.ellipse(x + 2, y + 3, r0 * 1.1, r0 * .8, 0, 0, 2 * PI); tg.fill();
      for (let k = 0; k < 5; k++) { tg.fillStyle = ['#3f5a26', '#4f6d2e', '#5f7f35', '#344d1f'][k % 4]; tg.beginPath(); tg.arc(x + (rnd() - .5) * r0, y + (rnd() - .5) * r0 * .8, r0 * (.45 + rnd() * .3), 0, 2 * PI); tg.fill(); }
      tg.fillStyle = 'rgba(190,220,120,.25)'; tg.beginPath(); tg.arc(x - r0 * .3, y - r0 * .3, r0 * .3, 0, 2 * PI); tg.fill();
    } else {
      tg.strokeStyle = rnd() < .5 ? '#5d7330' : '#46592a'; tg.lineWidth = 1.5;
      for (let k = 0; k < 5; k++) { tg.beginPath(); tg.moveTo(x + k * 1.2, y); tg.lineTo(x + k * 1.2 + (rnd() - .5) * 4, y - 3 - rnd() * 4); tg.stroke(); }
    }
  }
  // ore stains, ore bodies, then whatever mining has already done here
  const stain = { bauxite: 'rgba(110,30,8,.38)', coal: 'rgba(8,8,8,.42)', limestone: 'rgba(225,220,205,.28)', oil: 'rgba(6,5,4,.5)' };
  const ya = Math.max(0, y0 - 1), yb = Math.min(H, y0 + CH + 1), xa = Math.max(0, x0 - 1), xb = Math.min(W, x0 + CH + 1);
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { const t = S.oreInit[x + y * W]; if (t) { tg.fillStyle = stain[t]; tg.beginPath(); tg.ellipse(x * T + 16, y * T + 16, 22, 20, 0, 0, 2 * PI); tg.fill(); } }
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
    const i = x + y * W;
    if (S.oreInit[i] && !oreType[i] && S.oreInit[i] !== 'oil') depleteTile(x, y);
    else if (oreType[i] && S.obInit[i] > 0 && ob[i] <= 0) stripTile(i);
    else if (oreType[i]) drawOreTile(x, y);
  }
  tg = null;
  return cv;
}
let chunkBuilds = 0, chunkFrame = 0;
function getChunk(cx, cy) {
  const k = cx + cy * 4096, hit = chunkCache.get(k);
  if (hit) { hit.used = chunkFrame; return hit.cv; }
  if (chunkBuilds >= 3) return null;   // spread the work over frames
  chunkBuilds++;
  const cv = buildChunk(cx, cy);
  chunkCache.set(k, { cv, used: chunkFrame });
  if (chunkCache.size > MAXC) { let ok = null, ou = 1e18; for (const [kk, v] of chunkCache) if (v.used < ou) { ou = v.used; ok = kk; } chunkCache.delete(ok); }
  return cv;
}
function onChunkOf(tx, ty, fn) {   // live terrain change: patch the cached chunk if there is one
  const hit = chunkCache.get(Math.floor(tx / CH) + Math.floor(ty / CH) * 4096); if (!hit) return;
  const g = hit.cv.getContext('2d'); g.setTransform(CS, 0, 0, CS, -Math.floor(tx / CH) * CH * T * CS, -Math.floor(ty / CH) * CH * T * CS);
  tg = g; fn(); tg = null;
}
function drawOreTile(tx, ty) {
  const i = tx + ty * W, t = oreType[i], rnd = mulberry(tx * 9173 + ty * 331);
  if (t === 'oil') oilSeep(tg, tx, ty, rnd);
  else if (t === 'bauxite') {
    for (let k = 0; k < 16; k++) pisolite(tg, tx * T + 3 + rnd() * 26, ty * T + 3 + rnd() * 26, 1.3 + rnd() * 1.8, rnd);
    for (let k = 0; k < 2; k++) rock(tg, tx * T + 6 + rnd() * 20, ty * T + 6 + rnd() * 20, 3 + rnd() * 3.5, ORECOL.bauxite, rnd);
  } else {
    const n = 3 + Math.min(3, oreAmt[i] / 700 | 0);
    for (let k = 0; k < n; k++) rock(tg, tx * T + 5 + rnd() * 22, ty * T + 5 + rnd() * 22, 3 + rnd() * 4.5, ORECOL[t], rnd);
  }
}
function depleteTile(tx, ty) {
  // stripped pit: overburden removed, terraced floor
  const x = tx * T, y = ty * T;
  tg.fillStyle = 'rgba(52,40,28,.78)'; tg.fillRect(x, y, T, T);
  tg.fillStyle = 'rgba(96,78,56,.35)'; tg.fillRect(x + 3, y + 3, T - 6, T - 6);
  const rnd = mulberry(tx * 31 + ty * 7);
  for (let k = 0; k < 10; k++) { tg.fillStyle = rnd() < .5 ? 'rgba(0,0,0,.25)' : 'rgba(200,140,100,.2)'; tg.fillRect(x + rnd() * 30, y + rnd() * 30, 2, 1.5); }
}

// =====================================================================
//  item sprites
// =====================================================================
function mkS(fn) { const s = document.createElement('canvas'); s.width = s.height = 32; fn(s.getContext('2d')); return s; }
function shadowE(g, cx = 16, cy = 26, rx = 11, ry = 4) { g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 2 * PI); g.fill(); }
function sack(g, body, label, text) {
  shadowE(g, 17, 27, 11, 3.5);
  const gr = g.createLinearGradient(6, 6, 26, 28); gr.addColorStop(0, body); gr.addColorStop(1, '#8b8a86');
  g.fillStyle = gr; g.beginPath(); g.moveTo(9, 9); g.quadraticCurveTo(16, 6, 23, 9); g.lineTo(26, 24); g.quadraticCurveTo(16, 29, 6, 24); g.closePath(); g.fill();
  g.strokeStyle = '#3a3936'; g.lineWidth = 1; g.stroke();
  g.fillStyle = body; g.beginPath(); g.moveTo(12, 9); g.lineTo(14, 4); g.lineTo(18, 4); g.lineTo(20, 9); g.fill(); g.stroke();
  g.fillStyle = label; g.fillRect(8, 14, 16, 7);
  g.fillStyle = '#fff'; g.font = 'bold 6px sans-serif'; g.textAlign = 'center'; g.fillText(text, 16, 19.6);
}
function heap(g, col, shade, spk) {
  shadowE(g, 16, 25, 12, 4);
  const gr = g.createLinearGradient(8, 6, 22, 26); gr.addColorStop(0, col); gr.addColorStop(1, shade);
  g.fillStyle = gr; g.beginPath(); g.moveTo(3, 24); g.quadraticCurveTo(14, 2, 29, 24); g.quadraticCurveTo(16, 28, 3, 24); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = .8; g.stroke();
  const rnd = mulberry(col.length * 7);
  for (let i = 0; i < 22; i++) { g.fillStyle = spk; g.fillRect(6 + rnd() * 20, 12 + rnd() * 12, 1, 1); }
}
function block(g, top, front, side, rod, small) {
  const s = small ? .75 : 1, ox = small ? 4 : 0, oy = small ? 6 : 0;
  g.save(); g.translate(ox, oy); g.scale(s, s);
  shadowE(g, 17, 27, 13, 3.5);
  g.fillStyle = front; g.fillRect(5, 14, 20, 12);
  g.fillStyle = side; g.beginPath(); g.moveTo(25, 14); g.lineTo(29, 10); g.lineTo(29, 22); g.lineTo(25, 26); g.fill();
  g.fillStyle = top; g.beginPath(); g.moveTo(5, 14); g.lineTo(9, 10); g.lineTo(29, 10); g.lineTo(25, 14); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = .8; g.strokeRect(5, 14, 20, 12);
  if (rod) {
    g.fillStyle = '#5d6064'; g.fillRect(11, 8, 12, 3);
    g.fillStyle = '#d3d6da'; g.fillRect(16, -2, 3, 11);
    g.fillStyle = '#fff'; g.fillRect(16, -2, 1, 11);
  }
  g.restore();
}
const SPR = {
  bauxite: mkS(g => { const r = mulberry(3); rock(g, 13, 14, 8, ORECOL.bauxite, r); rock(g, 21, 19, 6.5, ORECOL.bauxite, r); for (let i = 0; i < 6; i++) pisolite(g, 8 + r() * 16, 16 + r() * 8, 1.6, r); }),
  coal: mkS(g => { const r = mulberry(5); rock(g, 13, 14, 8.5, ORECOL.coal, r); rock(g, 21, 18, 7, ORECOL.coal, r); rock(g, 14, 22, 6, ORECOL.coal, r); }),
  limestone: mkS(g => { const r = mulberry(9); rock(g, 13, 14, 8.5, ORECOL.limestone, r); rock(g, 21, 19, 7, ORECOL.limestone, r); }),
  quicklime: mkS(g => sack(g, '#efeee9', '#7a7a7a', 'CaO')),
  caustic: mkS(g => sack(g, '#f2f2f4', '#7b4bb8', 'NaOH')),
  cryolite: mkS(g => sack(g, '#ebe4d0', '#2f8a86', 'Na₃AlF₆')),
  alf3: mkS(g => sack(g, '#e2e6ee', '#2a6a9a', 'AlF₃')),
  flocculant: mkS(g => {
    shadowE(g, 16, 27, 9, 3);
    const gr = g.createLinearGradient(8, 0, 24, 0); gr.addColorStop(0, '#1d4f86'); gr.addColorStop(.4, '#4d8fd0'); gr.addColorStop(1, '#173f6c');
    g.fillStyle = gr; g.fillRect(8, 7, 16, 19); g.fillStyle = '#5f9ee0'; g.beginPath(); g.ellipse(16, 7, 8, 2.5, 0, 0, 2 * PI); g.fill();
    g.fillStyle = '#0e2c4d'; g.fillRect(8, 12, 16, 1.5); g.fillRect(8, 20, 16, 1.5); g.strokeStyle = '#0b2440'; g.strokeRect(8, 7, 16, 19);
  }),
  redmud: mkS(g => {
    shadowE(g, 16, 26, 12, 3.5);
    g.fillStyle = '#7a2414'; rr0(g, 5, 10, 22, 15, 3); g.fill();
    g.fillStyle = '#9a3a20'; rr0(g, 5, 10, 22, 6, 3); g.fill();
    g.strokeStyle = 'rgba(20,0,0,.6)'; g.lineWidth = .8; g.beginPath(); g.moveTo(9, 13); g.lineTo(13, 18); g.lineTo(11, 23); g.moveTo(19, 11); g.lineTo(17, 17); g.lineTo(22, 22); g.stroke();
  }),
  gibbsite: mkS(g => heap(g, '#f1ead8', '#b8ae96', 'rgba(150,130,100,.6)')),
  alumina: mkS(g => heap(g, '#ffffff', '#c8ced6', 'rgba(140,160,190,.5)')),
  coke: mkS(g => { const r = mulberry(11); const c = { base: '#3c3c40', hi: '#9a9aa4', dark: '#111' }; for (let i = 0; i < 8; i++) rock(g, 8 + r() * 16, 9 + r() * 14, 2.5 + r() * 2.5, c, r); }),
  pitch: mkS(g => { const r = mulberry(13); const c = { base: '#141416', hi: '#6a6c78', dark: '#000' }; rock(g, 12, 15, 8, c, r); rock(g, 21, 19, 7, c, r); }),
  green: mkS(g => block(g, '#55565a', '#3c3d40', '#2c2d30', false)),
  anode: mkS(g => block(g, '#3a3a3d', '#26262a', '#1a1a1d', true)),
  butt: mkS(g => block(g, '#3a3a3d', '#26262a', '#1a1a1d', true, true)),
  crucible: mkS(g => {
    shadowE(g, 16, 27, 12, 3.5);
    g.fillStyle = '#4b4f54'; g.beginPath(); g.arc(16, 16, 11, 0, 2 * PI); g.fill(); g.strokeStyle = '#1b1d20'; g.lineWidth = 1.2; g.stroke();
    const gr = g.createRadialGradient(15, 15, 1, 16, 16, 8); gr.addColorStop(0, '#fff4c0'); gr.addColorStop(.5, '#ffae3a'); gr.addColorStop(1, '#c4400f');
    g.fillStyle = gr; g.beginPath(); g.arc(16, 16, 8, 0, 2 * PI); g.fill();
    g.fillStyle = '#4b4f54'; g.fillRect(25, 14, 6, 4); g.strokeStyle = '#7a7f85'; g.beginPath(); g.arc(16, 16, 13, PI * 1.15, PI * 1.85); g.stroke();
  }),
  ingot: mkS(g => {
    shadowE(g, 16, 27, 13, 3.5);
    const bar = (x, y) => {
      const gr = g.createLinearGradient(x, y, x, y + 6); gr.addColorStop(0, '#f4f6f8'); gr.addColorStop(1, '#8c949c');
      g.fillStyle = gr; g.beginPath(); g.moveTo(x + 2, y); g.lineTo(x + 10, y); g.lineTo(x + 12, y + 6); g.lineTo(x, y + 6); g.closePath(); g.fill();
      g.strokeStyle = '#4c5258'; g.lineWidth = .7; g.stroke();
    };
    bar(3, 19); bar(16, 19); bar(9, 13); bar(22, 13); bar(3, 7); bar(15, 7);
    g.fillStyle = '#6f4a2a'; g.fillRect(3, 25, 26, 2);
  }),
};
function rr0(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }
function spawnStacks(e, kind) {
  const d = DEFS[e.type]; if (!d.stacks || particles.length > 700) return;
  e.smokeT = (e.smokeT || 0) + 1; if (e.smokeT % 7) return;
  for (const [lx, ly, k] of d.stacks) {
    const [wx, wy] = l2w(e, lx, ly);
    particles.push({ x: wx, y: wy, vx: .18 + Math.random() * .2, vy: -.3 - Math.random() * .2, life: 0, max: 80 + Math.random() * 60, r: k === 'steam' ? 4 : 3.5, k: kind || k });
  }
}

// =====================================================================
//  drawing helpers
// =====================================================================
function rrect(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }
function circle(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, 2 * PI); }
function line(c, x1, y1, x2, y2) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
function hazard(c, x, y, w, h) {
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.fillStyle = '#d9a514'; c.fillRect(x, y, w, h); c.fillStyle = '#1d1b19';
  for (let i = -h; i < w; i += 8) { c.beginPath(); c.moveTo(x + i, y + h); c.lineTo(x + i + 4, y + h); c.lineTo(x + i + 4 + h, y); c.lineTo(x + i + h, y); c.fill(); }
  c.restore();
}
function body(c, x, y, w, h, r, c1, c2) {
  const g = c.createLinearGradient(x, y, x + w * .4, y + h); g.addColorStop(0, c1); g.addColorStop(1, c2);
  c.fillStyle = g; rrect(c, x, y, w, h, r); c.fill();
  c.strokeStyle = '#14110f'; c.lineWidth = 1.5; c.stroke();
  c.strokeStyle = 'rgba(255,245,230,.16)'; c.lineWidth = 1; rrect(c, x + 2.5, y + 2.5, w - 5, h - 5, Math.max(1, r - 2)); c.stroke();
}
function concrete(c, x, y, w, h) {
  c.fillStyle = '#85817a'; rrect(c, x, y, w, h, 3); c.fill();
  c.strokeStyle = '#46433e'; c.lineWidth = 1.5; c.stroke();
  c.strokeStyle = 'rgba(0,0,0,.13)'; c.lineWidth = 1;
  for (let i = x + 32; i < x + w - 4; i += 32) line(c, i, y + 2, i, y + h - 2);
  for (let j = y + 32; j < y + h - 4; j += 32) line(c, x + 2, j, x + w - 2, j);
  c.fillStyle = 'rgba(60,30,15,.12)'; c.beginPath(); c.ellipse(x + w * .3, y + h * .7, w * .2, h * .12, .4, 0, 2 * PI); c.fill();
}
function corrugated(c, x, y, w, h, c1, c2, vertical = true) {
  const g = c.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, c1); g.addColorStop(1, c2);
  c.fillStyle = g; c.fillRect(x, y, w, h);
  c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 1;
  if (vertical) for (let i = x + 3; i < x + w; i += 4) line(c, i, y, i, y + h); else for (let j = y + 3; j < y + h; j += 4) line(c, x, j, x + w, j);
  c.strokeStyle = '#14110f'; c.lineWidth = 1.5; c.strokeRect(x, y, w, h);
  c.strokeStyle = 'rgba(255,255,255,.18)'; line(c, x + 1, y + 1.5, x + w - 1, y + 1.5);
}
function stack(c, x, y, r, banded) {
  c.fillStyle = 'rgba(0,0,0,.35)'; circle(c, x + r * .6, y + r * .8, r); c.fill();
  if (banded) {
    for (let k = 3; k >= 1; k--) { c.fillStyle = k % 2 ? '#c8382a' : '#ece8e2'; circle(c, x, y, r * k / 3); c.fill(); }
  } else { c.fillStyle = '#7c776f'; circle(c, x, y, r); c.fill(); }
  c.strokeStyle = '#1a1715'; c.lineWidth = 1.2; circle(c, x, y, r); c.stroke();
  c.fillStyle = '#0e0c0b'; circle(c, x, y, r * .55); c.fill();
}
function tankTop(c, cx, cy, r, c1, c2) {
  c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, cx + 4, cy + 5, r); c.fill();
  const g = c.createLinearGradient(cx - r, cy - r, cx + r, cy + r); g.addColorStop(0, c1); g.addColorStop(1, c2);
  c.fillStyle = g; circle(c, cx, cy, r); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 1;
  for (let k = 0; k < 12; k++) { const a = k / 12 * 2 * PI; line(c, cx + Math.cos(a) * r * .25, cy + Math.sin(a) * r * .25, cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
  c.strokeStyle = '#1a1715'; c.lineWidth = 1.5; circle(c, cx, cy, r); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, r - 2, PI * 1.05, PI * 1.6); c.stroke();
}
function thickener(c, cx, cy, r, inner, outer, ang) {
  c.fillStyle = 'rgba(0,0,0,.32)'; circle(c, cx + 4, cy + 5, r + 4); c.fill();
  c.fillStyle = '#7d7972'; circle(c, cx, cy, r + 4); c.fill(); c.strokeStyle = '#3a3733'; c.lineWidth = 1.5; c.stroke();
  const g = c.createRadialGradient(cx, cy, 2, cx, cy, r); g.addColorStop(0, inner); g.addColorStop(.75, outer); g.addColorStop(1, outer);
  c.fillStyle = g; circle(c, cx, cy, r); c.fill();
  c.strokeStyle = 'rgba(255,255,255,.08)'; c.lineWidth = 1;
  for (let k = 1; k < 5; k++) { c.beginPath(); c.arc(cx, cy, r * k / 5, ang * 3 + k, ang * 3 + k + 2.2); c.stroke(); }
  c.strokeStyle = '#5c5953'; c.lineWidth = 3; circle(c, cx, cy, r - 2); c.stroke();
  c.save(); c.translate(cx, cy); c.rotate(ang);
  c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(3, -1, r - 2, 8);
  c.fillStyle = '#cfc8ae'; c.fillRect(0, -4, r - 2, 7);
  c.strokeStyle = '#e1b63a'; c.lineWidth = 1; c.strokeRect(0, -4, r - 2, 7);
  c.restore();
  c.fillStyle = '#3a3a3a'; circle(c, cx, cy, r * .16); c.fill(); c.fillStyle = '#c4661c'; circle(c, cx, cy, r * .07); c.fill();
}
function glowAt(c, x, y, r, col, a) {
  const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col.replace('A', a)); g.addColorStop(1, col.replace('A', 0));
  c.fillStyle = g; circle(c, x, y, r); c.fill();
}
function stencil(c, text, x, y, size = 8, col = 'rgba(20,16,12,.55)') { c.fillStyle = col; c.font = `bold ${size}px 'Arial Narrow','PT Sans Narrow','Roboto Condensed',ui-sans-serif,sans-serif`; c.textAlign = 'center'; c.fillText(text, x, y); }
const working = e => e.status && e.status.startsWith('Working');
const tnow = () => performance.now() / 1000;

// =====================================================================
//  building art (local frame: north-facing, w*T × h*T)
// =====================================================================
const DRAW = {
  chest(c) {
    c.fillStyle = 'rgba(0,0,0,.38)'; rrect(c, 7, 8, 24, 22, 3); c.fill();
    const g = c.createLinearGradient(0, 5, 0, 27); g.addColorStop(0, '#a5733f'); g.addColorStop(1, '#5c3b1e');
    c.fillStyle = g; rrect(c, 4, 5, 24, 22, 3); c.fill(); c.strokeStyle = '#26180b'; c.lineWidth = 1.5; c.stroke();
    c.strokeStyle = 'rgba(0,0,0,.32)'; c.lineWidth = 1; for (const yy of [11.5, 17.5, 22.5]) line(c, 5, yy, 27, yy);
    c.fillStyle = '#d0995d'; c.fillRect(5, 6, 22, 1.5);
    c.fillStyle = '#4f555b'; c.fillRect(7, 5, 3, 22); c.fillRect(22, 5, 3, 22);
    c.fillStyle = '#d6b04a'; c.fillRect(14, 10, 4, 5);
  },
  drill(c, e) {
    const S = 96, cx = 48, cy = 48;
    const g = c.createLinearGradient(0, 0, S, S); g.addColorStop(0, '#8d8375'); g.addColorStop(1, '#3d3731');
    c.fillStyle = g; rrect(c, 3, 3, S - 6, S - 6, 9); c.fill(); c.lineWidth = 2; c.strokeStyle = '#1b1815'; c.stroke();
    c.strokeStyle = 'rgba(255,240,220,.18)'; c.lineWidth = 1; rrect(c, 6, 6, S - 12, S - 12, 7); c.stroke();
    c.fillStyle = 'rgba(120,50,20,.3)'; c.fillRect(14, 60, 3, 20); c.fillRect(70, 64, 2, 16);
    c.fillStyle = '#2a2622'; c.strokeStyle = '#141210'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(35, 8); c.lineTo(61, 8); c.lineTo(56, -5); c.lineTo(40, -5); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#c4661c'; c.fillRect(40, -5, 16, 3);
    hazard(c, 12, S - 15, S - 24, 7);
    c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 2;
    for (let i = 0; i < 4; i++) { line(c, 9, 36 + i * 7, 16, 36 + i * 7); line(c, S - 16, 36 + i * 7, S - 9, 36 + i * 7); }
    c.fillStyle = '#211e1b'; circle(c, cx, cy, 27); c.fill(); c.strokeStyle = '#625a50'; c.lineWidth = 3; c.stroke();
    c.save(); c.translate(cx, cy); c.rotate(e.spin || 0);
    for (let k = 0; k < 3; k++) {
      c.rotate(2 * PI / 3); c.fillStyle = '#a39887'; c.strokeStyle = '#2a2622'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(-5, -4); c.lineTo(5, -4); c.lineTo(7, -23); c.lineTo(-1, -23); c.closePath(); c.fill(); c.stroke();
    }
    c.restore();
    c.fillStyle = '#c4661c'; circle(c, cx, cy, 7); c.fill(); c.strokeStyle = '#3a1e08'; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = '#b8ad9b'; for (const [bx, by] of [[10, 10], [S - 10, 10], [10, S - 10], [S - 10, S - 10]]) { circle(c, bx, by, 2.4); c.fill(); }
    const col = e.status === 'Depleted' || e.status === 'No power' ? '#e2483a' : e.status === 'Output blocked' ? '#f2b431' : '#62e05c';
    c.save(); c.shadowColor = col; c.shadowBlur = 8; c.fillStyle = col; circle(c, 13, 13, 3.2); c.fill(); c.restore();
  },
  pump(c, e) {
    c.fillStyle = '#5e5a53'; c.fillRect(5, 10, 22, 34); c.strokeStyle = '#2a2724'; c.lineWidth = 1.2; c.strokeRect(5, 10, 22, 34);
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; for (let y = 30; y < 44; y += 3) line(c, 6, y, 26, y);
    hazard(c, 5, 40, 22, 4);
    c.fillStyle = '#26221f'; c.fillRect(11, 0, 10, 12);
    c.fillStyle = '#2c6aa0'; circle(c, 16, 20, 8); c.fill(); c.strokeStyle = '#123555'; c.lineWidth = 1.5; c.stroke();
    c.save(); c.translate(16, 20); c.rotate((e.anim || 0) * .2); c.strokeStyle = '#8fc2ea'; c.lineWidth = 1.5; line(c, -5, 0, 5, 0); line(c, 0, -5, 0, 5); c.restore();
  },
  substation(c) {
    c.fillStyle = '#6f6a62'; c.fillRect(2, 2, 60, 60);
    const r = mulberry(4); for (let i = 0; i < 120; i++) { c.fillStyle = r() < .5 ? 'rgba(0,0,0,.2)' : 'rgba(255,255,255,.1)'; c.fillRect(3 + r() * 58, 3 + r() * 58, 1.5, 1.5); }
    for (const x of [8, 34]) {
      c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(x + 3, 13, 22, 26);
      body(c, x, 10, 22, 26, 2, '#9aa1a8', '#5d636a');
      c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; for (let k = 0; k < 6; k++) line(c, x + 3 + k * 3.3, 26, x + 3 + k * 3.3, 34);
      c.fillStyle = '#8a5a2a'; for (let k = 0; k < 3; k++) { circle(c, x + 5 + k * 6, 15, 2.2); c.fill(); }
    }
    c.strokeStyle = '#3b3e41'; c.lineWidth = 3; line(c, 4, 48, 60, 48); line(c, 10, 42, 10, 54); line(c, 54, 42, 54, 54);
    c.strokeStyle = '#d8d8d4'; c.lineWidth = 1; for (const x of [18, 32, 46]) line(c, x, 48, x, 64);
    c.setLineDash([2, 2]); c.strokeStyle = '#d6d6d2'; c.lineWidth = 1; c.strokeRect(2.5, 2.5, 59, 59); c.setLineDash([]);
    stencil(c, '132 kV', 32, 60, 7, '#f2d24a');
  },
  powerplant(c, e) {
    concrete(c, 2, 2, 156, 156);
    // coal gallery
    c.fillStyle = '#6b6660'; c.save(); c.translate(20, 40); c.rotate(-.35); c.fillRect(0, -5, 92, 10); c.strokeStyle = '#2a2724'; c.strokeRect(0, -5, 92, 10); c.restore();
    corrugated(c, 8, 56, 92, 96, '#6d7c89', '#45525d');
    c.fillStyle = 'rgba(255,255,255,.15)'; for (let i = 0; i < 4; i++) c.fillRect(16 + i * 21, 62, 12, 4);
    stencil(c, 'TURBINE HALL', 54, 110, 8, 'rgba(15,20,25,.5)');
    body(c, 100, 8, 54, 104, 3, '#a7a49d', '#67635c');
    for (let i = 0; i < 5; i++) { c.fillStyle = e.status && e.status.startsWith('Running') || e.status === 'Full load' ? `rgba(255,${140 + 40 * Math.sin(tnow() * 3 + i)},40,.85)` : '#2a2622'; c.fillRect(104, 20 + i * 18, 4, 9); }
    stack(c, 126, 28, 12, true); stack(c, 126, 80, 12, true);
    // transformers
    for (const x of [16, 40]) { c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(x + 2, 12, 18, 16); body(c, x, 10, 18, 16, 2, '#9aa1a8', '#5d636a'); }
    // cooling water screen house
    body(c, 104, 120, 50, 32, 2, '#7c8792', '#4d565f');
    c.fillStyle = '#2f6fa8'; c.fillRect(110, 128, 38, 6);
  },
  boiler(c, e) {
    concrete(c, 2, 2, 60, 92);
    body(c, 6, 18, 52, 72, 3, '#a2604a', '#5c3020');
    c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1;
    for (let y = 24; y < 88; y += 5) line(c, 8, y, 56, y);
    const g = c.createLinearGradient(0, 6, 0, 18); g.addColorStop(0, '#e2e5e8'); g.addColorStop(1, '#7e858c');
    c.fillStyle = g; rrect(c, 8, 6, 48, 12, 6); c.fill(); c.strokeStyle = '#2b2e31'; c.stroke();
    stack(c, 46, 66, 7, false);
    if (working(e)) { c.fillStyle = `rgba(255,${120 + 50 * Math.sin(tnow() * 5)},30,.9)`; c.fillRect(12, 74, 14, 5); }
    else { c.fillStyle = '#231e1b'; c.fillRect(12, 74, 14, 5); }
  },
  dissolver(c, e) {
    concrete(c, 2, 2, 60, 60);
    c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, 36, 37, 26); c.fill();
    c.fillStyle = '#c9cbc9'; circle(c, 32, 32, 26); c.fill(); c.strokeStyle = '#2a2a2a'; c.lineWidth = 1.5; c.stroke();
    const g = c.createRadialGradient(32, 32, 2, 32, 32, 22); g.addColorStop(0, '#5f3aa0'); g.addColorStop(1, '#9a76d8');
    c.fillStyle = g; circle(c, 32, 32, 21); c.fill();
    c.save(); c.translate(32, 32); c.rotate((e.anim || 0) * .05);
    c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = 1.2; for (let k = 0; k < 3; k++) { c.rotate(2 * PI / 3); c.beginPath(); c.arc(0, 0, 14, 0, 1.3); c.stroke(); }
    c.restore();
    c.fillStyle = '#d7d7d2'; c.fillRect(8, 29, 48, 6); c.strokeStyle = '#555'; c.lineWidth = 1; c.strokeRect(8, 29, 48, 6);
    body(c, 25, 25, 14, 14, 2, '#3d6d9c', '#1f3d5c');
    hazard(c, 4, 56, 56, 4);
  },
  mill(c, e) {
    concrete(c, 2, 2, 92, 92);
    c.fillStyle = 'rgba(0,0,0,.35)'; rrect(c, 16, 30, 72, 42, 6); c.fill();
    c.fillStyle = '#3a3632'; c.fillRect(4, 36, 12, 22); c.fillRect(80, 36, 12, 22);
    const g = c.createLinearGradient(0, 26, 0, 68); g.addColorStop(0, '#d7d0c3'); g.addColorStop(.35, '#a39b8d'); g.addColorStop(1, '#4f4941');
    c.fillStyle = g; rrect(c, 12, 26, 72, 42, 5); c.fill(); c.strokeStyle = '#1b1815'; c.lineWidth = 1.5; c.stroke();
    // liner bolt rows sliding with rotation
    c.save(); c.beginPath(); c.rect(12, 26, 72, 42); c.clip();
    const off = ((e.anim || 0) * .6) % 8;
    c.fillStyle = 'rgba(30,25,20,.45)';
    for (let y = 26 - 8 + off; y < 70; y += 8) for (let x = 16; x < 64; x += 7) c.fillRect(x, y, 2, 2);
    c.restore();
    c.fillStyle = '#5b554d'; c.fillRect(64, 22, 7, 50);
    c.fillStyle = '#2b2724'; for (let y = 23; y < 72; y += 3) c.fillRect(63, y, 9, 1);
    body(c, 70, 74, 22, 16, 2, '#3f6f9f', '#1f3d5c');
    c.fillStyle = '#2a2622'; c.fillRect(28, 72, 14, 14);
  },
  digester(c, e) {
    concrete(c, 2, 2, 92, 92);
    c.strokeStyle = '#3d3f42'; c.lineWidth = 7; line(c, 26, 28, 70, 28); line(c, 70, 28, 48, 68); line(c, 48, 68, 26, 28);
    c.strokeStyle = '#a4a9ad'; c.lineWidth = 4; line(c, 26, 28, 70, 28); line(c, 70, 28, 48, 68); line(c, 48, 68, 26, 28);
    for (const [x, y] of [[26, 28], [70, 28], [48, 68]]) {
      c.fillStyle = 'rgba(0,0,0,.35)'; circle(c, x + 4, y + 5, 19); c.fill();
      const g = c.createRadialGradient(x - 6, y - 7, 2, x, y, 19); g.addColorStop(0, '#f5f6f7'); g.addColorStop(.6, '#b9bec3'); g.addColorStop(1, '#7c8287');
      c.fillStyle = g; circle(c, x, y, 19); c.fill(); c.strokeStyle = '#2f3336'; c.lineWidth = 1.5; c.stroke();
      c.strokeStyle = 'rgba(0,0,0,.15)'; c.lineWidth = 1; circle(c, x, y, 13); c.stroke();
      c.fillStyle = '#3d4246'; circle(c, x, y, 4.5); c.fill();
      c.fillStyle = '#c8382a'; circle(c, x + 9, y - 9, 2); c.fill();
    }
    if (working(e)) glowAt(c, 48, 42, 30, 'rgba(255,170,80,A)', .12);
    stencil(c, '145 °C · 4 bar', 48, 92, 7, 'rgba(20,16,12,.65)');
  },
  clarifier(c, e) {
    concrete(c, 2, 2, 156, 156);
    c.strokeStyle = '#8b8f2e'; c.lineWidth = 5; circle(c, 80, 80, 74); c.stroke();
    thickener(c, 80, 80, 66, '#5a2212', '#9aa04a', tnow() * .12);
  },
  washer(c, e) {
    concrete(c, 2, 2, 92, 92);
    thickener(c, 48, 46, 36, '#4a160c', '#a0442a', tnow() * .15 + 1);
    c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(72, 78, 20, 12);
    body(c, 70, 76, 20, 12, 2, '#6a6560', '#3a3632');
  },
  precipitator(c, e) {
    concrete(c, 2, 2, 92, 92);
    tankTop(c, 46, 46, 40, '#f2f4f5', '#8d9297');
    c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1; circle(c, 46, 46, 28); c.stroke();
    c.save(); c.translate(46, 46); c.rotate((e.anim || 0) * .04);
    c.fillStyle = 'rgba(40,60,80,.5)'; c.fillRect(-1.5, -22, 3, 44); c.restore();
    body(c, 39, 39, 14, 14, 2, '#3d6d9c', '#1f3d5c');
    c.fillStyle = '#5d636a'; c.fillRect(74, 72, 18, 18);
    c.strokeStyle = '#2f3336'; c.lineWidth = 1; for (let k = 0; k < 6; k++) line(c, 76 + k * 3, 72, 76 + k * 3, 90);
    c.strokeStyle = '#e1b63a'; c.lineWidth = 1; for (let y = 12; y < 30; y += 3) line(c, 6, y, 12, y);
  },
  limekiln(c, e) {
    concrete(c, 2, 2, 60, 92);
    body(c, 8, 6, 48, 48, 3, '#b0aba1', '#6d685f');
    c.fillStyle = '#1a1512'; circle(c, 32, 30, 13); c.fill();
    if (working(e)) glowAt(c, 32, 30, 14, 'rgba(255,140,40,A)', .9);
    c.strokeStyle = '#3a3632'; c.lineWidth = 3; line(c, 26, 54, 26, 92); line(c, 38, 54, 38, 92);
    const sy = 60 + (Math.sin((e.anim || 0) * .03) * .5 + .5) * 24;
    body(c, 24, sy, 16, 9, 1, '#5b7a6c', '#8a6416');
  },
  calciner(c, e) {
    concrete(c, 2, 2, 92, 188);
    body(c, 14, 6, 68, 50, 3, '#a8a49c', '#625e57');
    for (const x of [32, 62]) { c.fillStyle = '#5c5852'; circle(c, x, 26, 11); c.fill(); c.strokeStyle = '#2a2724'; c.lineWidth = 1.5; c.stroke(); c.fillStyle = '#3a3733'; circle(c, x, 26, 4); c.fill(); }
    stack(c, 78, 14, 6, false);
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(36, 60, 34, 120);
    const g = c.createLinearGradient(31, 0, 65, 0); g.addColorStop(0, '#3d3530'); g.addColorStop(.45, '#9a8878'); g.addColorStop(1, '#3a322d');
    c.fillStyle = g; c.fillRect(31, 56, 34, 118); c.strokeStyle = '#1a1715'; c.lineWidth = 1.5; c.strokeRect(31, 56, 34, 118);
    c.save(); c.beginPath(); c.rect(31, 56, 34, 118); c.clip();
    const off = ((e.anim || 0) * .25) % 34;
    c.strokeStyle = 'rgba(0,0,0,.28)'; c.lineWidth = 1;
    for (let x = 31 - 34 + off; x < 66; x += 8.5) line(c, x, 56, x, 174);
    if (working(e) || e.status === 'Output full') { const hg = c.createLinearGradient(0, 120, 0, 174); hg.addColorStop(0, 'rgba(255,120,30,0)'); hg.addColorStop(1, 'rgba(255,120,30,.45)'); c.fillStyle = hg; c.fillRect(31, 120, 34, 54); }
    c.restore();
    for (const y of [80, 140]) { c.fillStyle = '#c0b9ae'; c.fillRect(27, y, 42, 6); c.strokeStyle = '#2a2622'; c.lineWidth = 1; c.strokeRect(27, y, 42, 6); }
    c.fillStyle = '#5d554d'; c.fillRect(27, 108, 42, 8);
    body(c, 24, 170, 48, 16, 2, '#4d4640', '#2a2522');
    if (working(e)) glowAt(c, 48, 172, 18, 'rgba(255,170,60,A)', .8 + .2 * Math.sin(tnow() * 9));
    stencil(c, '1050 °C', 48, 166, 7, 'rgba(255,230,200,.6)');
  },
  paste(c, e) {
    concrete(c, 2, 2, 92, 92);
    corrugated(c, 6, 6, 84, 52, '#83907f', '#4f5a4d');
    c.fillStyle = '#3a4239'; c.fillRect(70, 12, 14, 14);
    for (const x of [24, 62]) {
      c.fillStyle = 'rgba(0,0,0,.35)'; circle(c, x + 3, 79, 14); c.fill();
      const g = c.createRadialGradient(x - 4, 72, 1, x, 76, 14); g.addColorStop(0, '#efe7d0'); g.addColorStop(1, '#8d8470');
      c.fillStyle = g; circle(c, x, 76, 14); c.fill(); c.strokeStyle = '#3a3630'; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = '#5a554c'; circle(c, x, 76, 3); c.fill();
    }
    stencil(c, 'PASTE PLANT', 40, 36, 8, 'rgba(15,20,15,.55)');
  },
  bake(c, e) {
    concrete(c, 2, 2, 92, 188);
    const fire = Math.floor((e.anim || 0) / 30) % 16;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++) {
      const x = 10 + j * 40, y = 18 + i * 20, idx = i * 2 + j;
      c.fillStyle = '#3f3a36'; c.fillRect(x, y, 36, 16);
      c.fillStyle = '#6b5f55'; c.fillRect(x, y + 7, 36, 2);
      const hot = working(e) && (idx === fire || idx === (fire + 1) % 16 || idx === (fire + 2) % 16);
      if (hot) { const g = c.createLinearGradient(x, y, x, y + 16); g.addColorStop(0, '#ffd27a'); g.addColorStop(1, '#d4501a'); c.fillStyle = g; c.globalAlpha = .55 + .3 * Math.sin(tnow() * 6 + idx); c.fillRect(x + 2, y + 2, 32, 12); c.globalAlpha = 1; }
      c.strokeStyle = '#1a1715'; c.lineWidth = 1; c.strokeRect(x, y, 36, 16);
    }
    stack(c, 84, 10, 5, false);
    const cy = 20 + (Math.sin((e.anim || 0) * .01) * .5 + .5) * 150;
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(6, cy + 4, 88, 8);
    c.fillStyle = '#5b7a6c'; c.fillRect(2, cy, 92, 8); hazard(c, 2, cy, 8, 8); hazard(c, 86, cy, 8, 8);
    c.fillStyle = '#4a4540'; c.fillRect(40, cy - 2, 16, 12);
  },
  pot(c, e) {
    const hot = Math.max(0, Math.min(1, ((e.T || 25) - 600) / 360));
    c.fillStyle = '#b9bdc2'; c.fillRect(0, 10, 4, 140); c.fillRect(92, 10, 4, 140);
    body(c, 6, 6, 84, 148, 4, '#4f4944', '#2b2724');
    c.fillStyle = '#1d1a18'; for (let y = 14; y < 150; y += 12) { c.fillRect(2, y, 6, 5); c.fillRect(88, y, 6, 5); }
    // bath glow showing between anodes
    c.fillStyle = e.frozen ? '#6d6f72' : '#2a201a'; c.fillRect(14, 14, 68, 132);
    if (hot > 0 && !e.frozen) {
      const fl = e.ae ? (Math.sin(tnow() * 30) > 0 ? 1 : .4) : .85 + .15 * Math.sin(tnow() * 4 + e.x);
      c.fillStyle = e.ae ? `rgba(255,60,40,${hot * fl})` : `rgba(255,${130 + hot * 80},40,${hot * fl})`;
      c.fillRect(14, 14, 68, 132);
    }
    for (let i = 0; i < 7; i++) for (const x of [17, 53]) {
      const y = 17 + i * 18.5;
      c.fillStyle = e.frozen ? '#8a8c8f' : '#2b2b2e'; c.fillRect(x, y, 26, 15);
      c.fillStyle = 'rgba(255,255,255,.1)'; c.fillRect(x, y, 26, 3);
      c.strokeStyle = '#111'; c.lineWidth = 1; c.strokeRect(x, y, 26, 15);
    }
    c.fillStyle = '#9da2a8'; for (let i = 0; i < 7; i++) { const y = 23 + i * 18.5; c.fillRect(30, y, 12, 3); c.fillRect(54, y, 12, 3); }
    const g = c.createLinearGradient(40, 0, 56, 0); g.addColorStop(0, '#9aa0a6'); g.addColorStop(.4, '#eef0f2'); g.addColorStop(1, '#7d838a');
    c.fillStyle = g; c.fillRect(40, 2, 16, 156); c.strokeStyle = '#3a3e42'; c.lineWidth = 1; c.strokeRect(40, 2, 16, 156);
    for (const y of [44, 80, 116]) {
      c.fillStyle = '#4f6f8f'; circle(c, 48, y, 6); c.fill(); c.strokeStyle = '#1f2f3f'; c.stroke();
      if (e.feedFlash && y === 80) { c.fillStyle = 'rgba(255,255,255,.8)'; circle(c, 48, y, 3); c.fill(); }
    }
    c.fillStyle = '#5a5e62'; c.fillRect(30, 152, 36, 8);
    if (e.ae) { c.strokeStyle = `rgba(255,40,30,${.5 + .5 * Math.sin(tnow() * 20)})`; c.lineWidth = 3; c.strokeRect(5, 5, 86, 150); }
  },
  casthouse(c, e) {
    concrete(c, 2, 2, 124, 124);
    corrugated(c, 6, 6, 116, 64, '#8c5a44', '#5c3626');
    c.fillStyle = 'rgba(255,255,255,.12)'; for (let i = 0; i < 5; i++) c.fillRect(14 + i * 22, 12, 12, 5);
    stencil(c, 'CASTHOUSE', 64, 44, 9, 'rgba(25,10,5,.55)');
    body(c, 8, 76, 52, 44, 3, '#625c56', '#36322e');
    c.fillStyle = working(e) ? `rgba(255,${150 + 40 * Math.sin(tnow() * 4)},50,1)` : '#2a2420'; c.fillRect(12, 92, 12, 16);
    c.fillStyle = '#2b2826'; c.fillRect(64, 80, 58, 24);
    const off = ((e.anim || 0) * .5) % 8;
    for (let x = 64 + off; x < 120; x += 8) for (const y of [83, 93]) {
      c.fillStyle = x > 84 ? '#d8dde2' : x > 72 ? '#ffb24a' : '#4c4f52'; c.fillRect(x, y, 6, 8);
    }
    for (let k = 0; k < 3; k++) { c.drawImage(SPR.ingot, 66 + k * 18, 104, 20, 20); }
  },
  depot(c, e) {
    concrete(c, 2, 2, 92, 92);
    corrugated(c, 6, 6, 84, 34, '#56728c', '#34495c');
    stencil(c, 'IMPORT', 48, 27, 9, 'rgba(10,20,30,.6)');
    for (let k = 0; k < 3; k++) {
      const x = 8 + k * 28;
      c.fillStyle = '#a07a48'; c.fillRect(x, 50, 24, 24); c.strokeStyle = '#4a3218'; c.lineWidth = 1; c.strokeRect(x, 50, 24, 24);
      c.strokeStyle = 'rgba(0,0,0,.3)'; line(c, x, 58, x + 24, 58); line(c, x, 66, x + 24, 66);
    }
    hazard(c, 4, 84, 88, 6);
  },
  residue(c, e) {
    const f = Math.min(1, (e.fill || 0) / RESIDUE_CAP);
    c.fillStyle = 'rgba(0,0,0,.3)'; rrect(c, 6, 8, 154, 154, 20); c.fill();
    c.fillStyle = '#8a5a38'; rrect(c, 2, 2, 156, 156, 20); c.fill(); c.strokeStyle = '#3e2614'; c.lineWidth = 1.5; c.stroke();
    const g = c.createLinearGradient(0, 10, 0, 150); g.addColorStop(0, '#5f3a20'); g.addColorStop(1, '#7c5032');
    c.fillStyle = g; rrect(c, 12, 12, 136, 136, 14); c.fill();
    c.fillStyle = '#2b2b2e'; rrect(c, 20, 20, 120, 120, 8); c.fill();
    if (f > 0) {
      const s = 30 + 90 * Math.sqrt(f);
      const mg = c.createRadialGradient(80, 80, 4, 80, 80, s * .7); mg.addColorStop(0, '#8a2c16'); mg.addColorStop(1, '#6a1e0e');
      c.fillStyle = mg; rrect(c, 80 - s / 2, 80 - s / 2, s, s, 10); c.fill();
      c.strokeStyle = 'rgba(30,5,0,.45)'; c.lineWidth = 1; const r = mulberry(3);
      for (let k = 0; k < 10; k++) { const x = 80 + (r() - .5) * s * .8, y = 80 + (r() - .5) * s * .8; line(c, x, y, x + (r() - .5) * 18, y + (r() - .5) * 18); }
    }
    c.strokeStyle = 'rgba(255,255,255,.08)'; c.lineWidth = 1; rrect(c, 20, 20, 120, 120, 8); c.stroke();
    stencil(c, `${Math.round(f * 100)}%`, 80, 152, 8, 'rgba(255,230,200,.7)');
  },
};
function drawPortStubs(c, d) {
  for (const p of d.ports || []) {
    const cx = (p.x + .5) * T, cy = (p.y + .5) * T, ex = cx + DX[p.d] * 16, ey = cy + DY[p.d] * 16;
    const ix = ex - DX[p.d] * 10, iy = ey - DY[p.d] * 10;
    c.lineCap = 'butt';
    c.strokeStyle = '#2b2d2f'; c.lineWidth = 12; line(c, ix, iy, ex, ey);
    c.strokeStyle = '#8e9396'; c.lineWidth = 9; line(c, ix, iy, ex, ey);
    c.strokeStyle = FLUIDS[p.f].col; c.lineWidth = 9; line(c, ix + DX[p.d] * 3, iy + DY[p.d] * 3, ix + DX[p.d] * 6, iy + DY[p.d] * 6);
    c.fillStyle = '#55595c';
    if (DX[p.d]) c.fillRect(ex - 2, ey - 9, 4, 18); else c.fillRect(ex - 9, ey - 2, 18, 4);
  }
}
const NO_BADGE = new Set(['road', 'pipe', 'ptg', 'belt', 'residue', 'hopper', 'bin', 'pad']);
function star(c, x, y, r, col) {
  c.fillStyle = col; c.beginPath();
  for (let k = 0; k < 10; k++) { const a = -PI / 2 + k * PI / 5, rr = k % 2 ? r * .42 : r; c[k ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  c.closePath(); c.fill();
}
// worn-metal pass over a machine: light from the upper left, grime pooling low, bolted frame
function weather(c, e, fw, fh) {
  const x = e.x * T + 2, y = e.y * T + 2, w = fw * T - 4, h = fh * T - 4;
  c.fillStyle = 'rgba(255,248,225,.13)'; c.fillRect(x, y, w, 2); c.fillRect(x, y, 2, h);
  c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(x, y + h - 2, w, 2); c.fillRect(x + w - 2, y, 2, h);
  const g = c.createLinearGradient(0, y + h * .55, 0, y + h); g.addColorStop(0, 'rgba(30,22,12,0)'); g.addColorStop(1, 'rgba(30,22,12,.22)');
  c.fillStyle = g; c.fillRect(x, y + h * .55, w, h * .45);
  c.fillStyle = '#1b1915'; for (let i = x + 5; i < x + w - 3; i += 10) { c.fillRect(i, y + 3, 2, 2); c.fillRect(i, y + h - 5, 2, 2); }
  for (let j = y + 15; j < y + h - 8; j += 10) { c.fillRect(x + 3, j, 2, 2); c.fillRect(x + w - 5, j, 2, 2); }
  const r = mulberry(e.x * 131 + e.y * 17);   // rust and paint chips
  for (let k = 0; k < fw * fh * 2; k++) { c.fillStyle = r() < .5 ? 'rgba(120,60,24,.35)' : 'rgba(210,205,190,.14)'; c.fillRect(x + r() * (w - 4), y + r() * (h - 4), 2 + r() * 3, 1 + r() * 2); }
}
function sovietBadge(c, e, fw, fh) {
  const x = e.x * T + 7, y = e.y * T + 7;
  c.fillStyle = '#e8e2d0'; c.fillRect(x - 5, y - 5, 10, 10); c.fillStyle = '#1a1712'; c.fillRect(x - 5, y + 5, 10, 1);
  star(c, x, y, 4.2, '#b8262a');
  const n = 10 + (e.x * 37 + e.y * 11) % 89;
  c.save(); c.translate((e.x + fw) * T - 10, (e.y + fh) * T - 6); stencil(c, '№' + n, 0, 0, 7, 'rgba(240,236,224,.8)'); c.restore();
}
function drawMachine(c, e, ghost) {
  const d = DEFS[e.type], [fw, fh] = fp(e.type, e.dir);
  if (!ghost) {
    const sx = e.x * T, sy = e.y * T, L0 = 10 + Math.min(fw, fh) * 9;
    for (const [L, a, g] of [[L0 * 1.25, .12, 3], [L0, .2, 0]]) {   // penumbra, then umbra
      c.fillStyle = `rgba(6,5,2,${a})`; c.beginPath();
      c.moveTo(sx + fw * T - 2, sy + 4 - g); c.lineTo(sx + fw * T - 2 + L + g, sy + 4 + L * .55 - g); c.lineTo(sx + fw * T - 2 + L + g, sy + fh * T + L * .55 + g);
      c.lineTo(sx + 6 + L - g, sy + fh * T + L * .55 + g); c.lineTo(sx + 6 - g, sy + fh * T - 2 + g); c.closePath(); c.fill();
    }
    c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(sx - 1, sy + 1, fw * T + 3, fh * T + 2);   // contact shadow
  }
  c.save();
  c.translate((e.x + fw / 2) * T, (e.y + fh / 2) * T); c.rotate(e.dir * PI / 2); c.translate(-d.w * T / 2, -d.h * T / 2);
  DRAW[e.type](c, e); drawPortStubs(c, d);
  c.restore();
  if (!ghost && fw * fh >= 2 && !NO_BADGE.has(e.type)) weather(c, e, fw, fh);
  if (!ghost && fw * fh >= 4 && !NO_BADGE.has(e.type)) sovietBadge(c, e, fw, fh);
  if (e.type === 'depot') {
    const x = (e.x + fw / 2) * T, y = (e.y + fh / 2) * T;
    for (let k = 0; k < 3; k++) if (k < (e.outb ? (e.outb[e.sel] || 0) : 3)) c.drawImage(SPR[e.sel], x - 42 + k * 28 + (e.dir % 2 ? 0 : 0), y + 2, 24, 24);
    c.fillStyle = 'rgba(0,0,0,.55)'; circle(c, x, y - 26, 13); c.fill();
    c.drawImage(SPR[e.sel], x - 12, y - 38, 24, 24);
  }
}

// belts, pipes, inserters (world frame)
function tracePath(c, b) {
  const cx = b.x * T + 16, cy = b.y * T + 16, ex = cx + DX[b.dir] * 16, ey = cy + DY[b.dir] * 16;
  c.beginPath();
  if (b.curve < 0) { c.moveTo(cx - DX[b.dir] * 16, cy - DY[b.dir] * 16); c.lineTo(ex, ey); }
  else { c.moveTo(cx + DX[b.curve] * 16, cy + DY[b.curve] * 16); c.quadraticCurveTo(cx, cy, ex, ey); }
}
function drawBelts(c, belts, time) {
  c.lineCap = 'butt';
  const pass = (w, col, sh) => { c.lineWidth = w; c.strokeStyle = col; for (const b of belts) { if (sh) { c.save(); c.translate(3, 3); } tracePath(c, b); c.stroke(); if (sh) c.restore(); } };
  pass(28, 'rgba(0,0,0,.32)', true); pass(28, '#1c1916'); pass(26, '#7f7467'); pass(22, '#26221f'); pass(18, '#3c3731');
  c.setLineDash([4, 4]); c.lineDashOffset = -(time * 64) % 8; pass(18, '#5a534b'); c.setLineDash([]);
  for (const b of belts) {
    const n = get(b.x + DX[b.dir], b.y + DY[b.dir]);
    if (n && n.type === 'belt') continue;
    c.save(); c.translate(b.x * T + 16, b.y * T + 16); c.rotate(b.dir * PI / 2);
    c.fillStyle = '#1c1916'; c.fillRect(-14, -17, 28, 4); c.fillStyle = '#c4661c'; c.fillRect(-12, -16.5, 24, 2);
    c.restore();
  }
}
function drawPipe(c, p) {
  const cx = p.x * T + 16, cy = p.y * T + 16, con = p.con || [0, 0, 0, 0];
  let arms = [0, 1, 2, 3].filter(d => con[d]);
  if (p.type === 'ptg') arms = [(p.dir + 2) % 4];
  else if (!arms.length) arms = [1, 3];
  const ends = arms.map(d => [cx + DX[d] * 16, cy + DY[d] * 16, d]);
  const pass = (w, col, ox = 0, oy = 0) => { c.strokeStyle = col; c.lineWidth = w; for (const [x, y] of ends) line(c, cx + ox, cy + oy, x + ox, y + oy); };
  c.lineCap = 'butt';
  pass(12, 'rgba(0,0,0,.28)', 4, 4); pass(12, '#2b2d2f'); pass(9, '#8e9396');
  c.lineCap = 'round'; pass(2, 'rgba(255,255,255,.4)', -1.5, -1.5); c.lineCap = 'butt';
  c.fillStyle = '#55595c';
  for (const [x, y, d] of ends) { if (DX[d]) c.fillRect(x - (DX[d] > 0 ? 3 : 0), y - 8, 3, 16); else c.fillRect(x - 8, y - (DY[d] > 0 ? 3 : 0), 16, 3); }
  const f = p.net && p.net.fluid;
  if (p.type === 'ptg') {
    c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, cx + 3, cy + 3, 10); c.fill();
    c.fillStyle = '#6d6a64'; circle(c, cx, cy, 10); c.fill(); c.strokeStyle = '#2b2926'; c.lineWidth = 1.5; c.stroke();
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; line(c, cx - 6, cy, cx + 6, cy); line(c, cx, cy - 6, cx, cy + 6);
    c.fillStyle = f ? FLUIDS[f].col : '#3a3a3a'; circle(c, cx, cy, 3.5); c.fill();
    c.save(); c.translate(cx, cy); c.rotate(p.dir * PI / 2); c.fillStyle = p.under ? '#e8e0cc' : '#e2483a';
    c.beginPath(); c.moveTo(0, -9); c.lineTo(3, -5); c.lineTo(-3, -5); c.fill(); c.restore();
  } else {
    c.fillStyle = '#2b2d2f'; circle(c, cx, cy, 6.5); c.fill();
    c.fillStyle = '#9a9fa2'; circle(c, cx, cy, 5); c.fill();
    if (f) { c.fillStyle = FLUIDS[f].col; circle(c, cx, cy, 3.5); c.fill(); }
  }
}
function drawInserterBase(c, e) {
  const cx = e.x * T + 16, cy = e.y * T + 16;
  c.fillStyle = 'rgba(0,0,0,.38)'; rrect(c, cx - 8, cy - 7, 21, 21, 3); c.fill();
  const g = c.createLinearGradient(cx - 10, cy - 10, cx + 10, cy + 10); g.addColorStop(0, '#79726a'); g.addColorStop(1, '#3a3632');
  c.fillStyle = g; rrect(c, cx - 10, cy - 10, 20, 20, 3); c.fill(); c.strokeStyle = '#1a1715'; c.lineWidth = 1.5; c.stroke();
  c.save(); c.translate(cx, cy); c.rotate(e.dir * PI / 2);
  c.fillStyle = '#c4661c'; c.beginPath(); c.moveTo(-4, -6); c.lineTo(4, -6); c.lineTo(0, -9.5); c.closePath(); c.fill();
  c.restore();
  c.fillStyle = '#26231f'; circle(c, cx, cy, 6); c.fill(); c.strokeStyle = '#5f574d'; c.lineWidth = 1.5; c.stroke();
}
function drawInserterArm(c, e) {
  const cx = e.x * T + 16, cy = e.y * T + 16;
  const [hx, hy] = handPos(e);
  const mx = (cx + hx) / 2, my = (cy + hy) / 2, ex = mx, ey = my - 10, hy2 = hy - 4;
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 4;
  c.beginPath(); c.moveTo(cx + 4, cy + 4); c.lineTo(mx + 7, my + 7); c.lineTo(hx + 5, hy + 5); c.stroke();
  c.beginPath(); c.moveTo(cx, cy - 2); c.lineTo(ex, ey); c.lineTo(hx, hy2);
  c.strokeStyle = '#173f4c'; c.lineWidth = 6; c.stroke();
  c.strokeStyle = '#3e9fbd'; c.lineWidth = 3.5; c.stroke();
  c.strokeStyle = 'rgba(200,240,255,.45)'; c.lineWidth = 1; c.stroke();
  c.fillStyle = '#26231f'; circle(c, ex, ey, 3.2); c.fill(); c.fillStyle = '#c4661c'; circle(c, ex, ey, 1.6); c.fill();
  c.fillStyle = '#26231f'; circle(c, cx, cy - 2, 3.5); c.fill();
  const a = Math.atan2(hy2 - ey, hx - ex);
  c.save(); c.translate(hx, hy2); c.rotate(a); c.strokeStyle = '#1a1715'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, -3.5); c.lineTo(4, -3.5); c.moveTo(0, 3.5); c.lineTo(4, 3.5); c.moveTo(0, -3.5); c.lineTo(0, 3.5); c.stroke(); c.restore();
  if (e.hand) c.drawImage(SPR[e.hand], hx - 9, hy2 - 9, 18, 18);
}
function drawArrow(c, x, y, dir, len = 9, fill = 'rgba(255,240,210,.85)') {
  c.save(); c.translate(x, y); c.rotate(dir * PI / 2);
  c.fillStyle = fill; c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(0, -len); c.lineTo(len * .8, 0); c.lineTo(len * .3, 0); c.lineTo(len * .3, len); c.lineTo(-len * .3, len); c.lineTo(-len * .3, 0); c.lineTo(-len * .8, 0); c.closePath();
  c.fill(); c.stroke(); c.restore();
}
function drawAny(c, e, time, ghost) {
  if (e.type === 'belt') drawBelts(c, [e], time);
  else if (e.type === 'pipe' || e.type === 'ptg') drawPipe(c, e);
  else if (e.type === 'inserter') { drawInserterBase(c, e); drawInserterArm(c, e); }
  else drawMachine(c, e, ghost);
}
function drawPortArrows(c, e) {
  for (const pt of e.ports || []) {
    const x = pt.tx * T + 16, y = pt.ty * T + 16;
    c.fillStyle = 'rgba(0,0,0,.35)'; rrect(c, x - 12, y - 12, 24, 24, 4); c.fill();
    drawArrow(c, x, y, pt.io === 'in' ? (pt.wd + 2) % 4 : pt.wd, 8, FLUIDS[pt.f].col);
  }
}

// =====================================================================
//  new sprites (rocket chain)
// =====================================================================
function drum(g, c1, c2, band) {
  shadowE(g, 16, 27, 9, 3);
  const gr = g.createLinearGradient(8, 0, 24, 0); gr.addColorStop(0, c2); gr.addColorStop(.4, c1); gr.addColorStop(1, c2);
  g.fillStyle = gr; g.fillRect(8, 7, 16, 19); g.fillStyle = c1; g.beginPath(); g.ellipse(16, 7, 8, 2.5, 0, 0, 2 * PI); g.fill();
  g.fillStyle = band; g.fillRect(8, 12, 16, 1.5); g.fillRect(8, 20, 16, 1.5); g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeRect(8, 7, 16, 19);
}
function bell(g, x, y, s, col) {   // engine nozzle seen at 3/4
  const gr = g.createLinearGradient(x - 8 * s, 0, x + 8 * s, 0); gr.addColorStop(0, '#6d3c1c'); gr.addColorStop(.45, col); gr.addColorStop(1, '#4a2812');
  g.fillStyle = gr; g.beginPath(); g.moveTo(x - 3 * s, y); g.lineTo(x + 3 * s, y); g.quadraticCurveTo(x + 4 * s, y + 6 * s, x + 8 * s, y + 12 * s);
  g.lineTo(x - 8 * s, y + 12 * s); g.quadraticCurveTo(x - 4 * s, y + 6 * s, x - 3 * s, y); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = .8; g.stroke();
  g.fillStyle = '#1a1210'; g.beginPath(); g.ellipse(x, y + 12 * s, 8 * s, 2 * s, 0, 0, 2 * PI); g.fill();
}
Object.assign(SPR, {
  lithium: mkS(g => drum(g, '#c9ced4', '#6f767e', '#d03a2a')),
  copper: mkS(g => { shadowE(g, 16, 26, 12, 3.5); for (let k = 0; k < 3; k++) { const gr = g.createLinearGradient(5, 0, 27, 0); gr.addColorStop(0, '#b0592a'); gr.addColorStop(.5, '#f0a070'); gr.addColorStop(1, '#8a4019'); g.fillStyle = gr; g.fillRect(5, 18 - k * 5, 22, 5); g.strokeStyle = '#4a200a'; g.lineWidth = .7; g.strokeRect(5, 18 - k * 5, 22, 5); } }),
  superalloy: mkS(g => { shadowE(g, 16, 25, 12, 3.5); const gr = g.createLinearGradient(0, 10, 0, 22); gr.addColorStop(0, '#e6e2d6'); gr.addColorStop(1, '#7c7a72'); g.fillStyle = gr; rr0(g, 4, 11, 24, 11, 5); g.fill(); g.strokeStyle = '#3c3a36'; g.lineWidth = .8; g.stroke(); g.fillStyle = '#b8b4a8'; g.beginPath(); g.ellipse(27, 16.5, 2, 5.5, 0, 0, 2 * PI); g.fill(); stencil(g, '718', 15, 19.5, 6, '#3c3a36'); }),
  avionics: mkS(g => { shadowE(g, 16, 26, 12, 3.5); g.fillStyle = '#2b3138'; rr0(g, 5, 8, 22, 17, 2); g.fill(); g.fillStyle = '#1e6a3c'; g.fillRect(8, 11, 16, 11); g.strokeStyle = '#e6c84a'; g.lineWidth = .6; for (let k = 0; k < 4; k++) line(g, 9, 13 + k * 2.5, 23, 13 + k * 2.5); g.fillStyle = '#111'; g.fillRect(13, 14, 6, 5); g.fillStyle = '#62e05c'; g.fillRect(22, 9, 2, 1.5); }),
  paykit: mkS(g => { shadowE(g, 16, 27, 12, 3.5); g.fillStyle = '#5f6a3a'; rr0(g, 4, 8, 24, 18, 2); g.fill(); g.strokeStyle = '#2a2f18'; g.lineWidth = 1; g.stroke(); hazard(g, 4, 14, 24, 5); g.fillStyle = '#ddd'; g.font = 'bold 5px sans-serif'; g.textAlign = 'center'; g.fillText('PAYLOAD', 16, 25); }),
  slab: mkS(g => block(g, '#d8dde2', '#a9b0b8', '#8a9199', false)),
  plate: mkS(g => { shadowE(g, 16, 26, 13, 3); for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? '#c9cfd6' : '#e3e7eb'; g.beginPath(); g.moveTo(4, 21 - k * 3); g.lineTo(24, 21 - k * 3); g.lineTo(29, 17 - k * 3); g.lineTo(9, 17 - k * 3); g.closePath(); g.fill(); g.strokeStyle = '#6a7179'; g.lineWidth = .6; g.stroke(); } }),
  tank: mkS(g => { shadowE(g, 16, 27, 13, 3.5); const gr = g.createLinearGradient(0, 6, 0, 26); gr.addColorStop(0, '#eef1f4'); gr.addColorStop(.5, '#b8c0c8'); gr.addColorStop(1, '#79828c'); g.fillStyle = gr; g.fillRect(6, 7, 20, 19); g.fillStyle = '#d5dade'; g.beginPath(); g.ellipse(6, 16.5, 3, 9.5, 0, 0, 2 * PI); g.fill(); g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = .7; for (let x = 10; x < 26; x += 4) line(g, x, 7, x, 26); g.strokeStyle = '#4a525a'; g.strokeRect(6, 7, 20, 19); }),
  turbopump: mkS(g => { shadowE(g, 16, 27, 11, 3); g.fillStyle = '#8b8d90'; circle(g, 12, 15, 8); g.fill(); g.fillStyle = '#a3a6aa'; circle(g, 21, 17, 6); g.fill(); g.strokeStyle = '#3a3c3e'; g.lineWidth = 1; circle(g, 12, 15, 8); g.stroke(); circle(g, 21, 17, 6); g.stroke(); g.strokeStyle = '#d0d3d6'; for (let k = 0; k < 6; k++) { const a = k / 6 * 2 * PI; line(g, 12, 15, 12 + Math.cos(a) * 6, 15 + Math.sin(a) * 6); } g.fillStyle = '#c86a2a'; g.fillRect(18, 6, 4, 6); }),
  chamber: mkS(g => { shadowE(g, 16, 28, 10, 3); g.fillStyle = '#9aa0a6'; g.fillRect(12, 3, 8, 6); bell(g, 16, 9, 1.05, '#d0844a'); }),
  engine: mkS(g => { shadowE(g, 16, 28, 11, 3); g.fillStyle = '#8b8d90'; circle(g, 9, 8, 4.5); g.fill(); g.fillStyle = '#9aa0a6'; g.fillRect(12, 2, 8, 7); g.strokeStyle = '#c4661c'; g.lineWidth = 1; line(g, 9, 8, 13, 5); bell(g, 16, 9, 1.05, '#c27a44'); }),
  engineok: mkS(g => { shadowE(g, 16, 28, 11, 3); g.fillStyle = '#8b8d90'; circle(g, 9, 8, 4.5); g.fill(); g.fillStyle = '#9aa0a6'; g.fillRect(12, 2, 8, 7); bell(g, 16, 9, 1.05, '#7a4a30'); g.fillStyle = '#62c25a'; g.fillRect(22, 3, 7, 4); g.strokeStyle = '#1b3a18'; g.lineWidth = .6; g.strokeRect(22, 3, 7, 4); }),
  payload: mkS(g => { shadowE(g, 16, 28, 9, 3); const gr = g.createLinearGradient(8, 0, 24, 0); gr.addColorStop(0, '#c8ccd0'); gr.addColorStop(.4, '#ffffff'); gr.addColorStop(1, '#9aa0a6'); g.fillStyle = gr; g.beginPath(); g.moveTo(9, 27); g.lineTo(9, 15); g.quadraticCurveTo(9, 3, 16, 2); g.quadraticCurveTo(23, 3, 23, 15); g.lineTo(23, 27); g.closePath(); g.fill(); g.strokeStyle = '#4a5056'; g.lineWidth = .8; g.stroke(); g.strokeStyle = 'rgba(0,0,0,.35)'; line(g, 16, 3, 16, 27); g.fillStyle = '#c4661c'; g.fillRect(9, 22, 14, 2); }),
  rocket: mkS(g => { g.save(); g.translate(16, 16); g.rotate(PI / 4); g.fillStyle = '#f2f2f0'; g.fillRect(-3.5, -12, 7, 22); g.beginPath(); g.moveTo(-3.5, -12); g.lineTo(0, -16); g.lineTo(3.5, -12); g.fill(); g.fillStyle = '#222'; g.fillRect(-3.5, -3, 7, 2); g.fillStyle = '#c4661c'; g.beginPath(); g.moveTo(-2, 10); g.lineTo(0, 15); g.lineTo(2, 10); g.fill(); g.restore(); }),
});
Object.assign(SPR, {
  concrete: mkS(g => { shadowE(g, 16, 26, 13, 3.5); for (let k = 0; k < 2; k++) { const y = 18 - k * 7; g.fillStyle = '#b4b0a8'; g.fillRect(4, y, 24, 6); g.fillStyle = '#d2cec6'; g.beginPath(); g.moveTo(4, y); g.lineTo(8, y - 3); g.lineTo(28, y - 3); g.lineTo(28, y); g.closePath(); g.fill(); g.strokeStyle = '#6a665e'; g.lineWidth = .7; g.strokeRect(4, y, 24, 6); g.fillStyle = '#7a756c'; g.fillRect(9, y + 2, 2, 2); g.fillRect(21, y + 2, 2, 2); } }),
  alu: mkS(g => { shadowE(g, 16, 26, 13, 3); for (let k = 0; k < 3; k++) { const y = 21 - k * 5; const gr = g.createLinearGradient(0, y - 3, 0, y + 3); gr.addColorStop(0, '#f2f4f6'); gr.addColorStop(1, '#8c949c'); g.fillStyle = gr; g.fillRect(3, y - 2, 26, 4); g.fillStyle = '#5c646c'; g.fillRect(3, y - 2, 2, 4); g.fillRect(27, y - 2, 2, 4); g.strokeStyle = '#4c545c'; g.lineWidth = .5; g.strokeRect(3, y - 2, 26, 4); } }),
  kit: mkS(g => { shadowE(g, 16, 27, 12, 3.5); g.fillStyle = '#3a6a9a'; rr0(g, 5, 9, 22, 17, 2); g.fill(); g.strokeStyle = '#1a3450'; g.lineWidth = 1; g.stroke(); g.fillStyle = '#9aa0a6'; circle(g, 12, 17, 4.5); g.fill(); g.strokeStyle = '#4a4e52'; for (let k = 0; k < 6; k++) { const a = k / 6 * 2 * PI; line(g, 12 + Math.cos(a) * 3, 17 + Math.sin(a) * 3, 12 + Math.cos(a) * 5.5, 17 + Math.sin(a) * 5.5); } g.fillStyle = '#e6c84a'; g.fillRect(19, 12, 6, 3); g.fillStyle = '#62e05c'; g.fillRect(19, 18, 2, 2); }),
  cement: mkS(g => sack(g, '#d6d2c8', '#7a756c', 'CEM')),
  ammo: mkS(g => { shadowE(g, 16, 27, 12, 3.5); g.fillStyle = '#4c5a34'; rr0(g, 4, 10, 24, 16, 2); g.fill(); g.strokeStyle = '#1e2414'; g.lineWidth = 1; g.stroke(); g.fillStyle = '#e6c84a'; g.fillRect(4, 15, 24, 2.5); g.fillStyle = '#222'; g.font = 'bold 5px sans-serif'; g.textAlign = 'center'; g.fillText('30MM', 16, 24); g.fillStyle = '#b08a3a'; for (let k = 0; k < 4; k++) { g.fillRect(8 + k * 5, 5, 3, 6); } }),
});
const MATCOL = { bauxite: '#a8502a', coal: '#2c2c30', limestone: '#cfc9b8', coke: '#4c4c54', gibbsite: '#efe8d6', redmud: '#8a2c16' };
ORECOL.oil = { base: '#1a1512', hi: '#5a5048', dark: '#000' };

// ---------------------------------------------------------------- terrain updates
function oilSeep(g, tx, ty, rnd) {
  for (let k = 0; k < 3; k++) {
    const x = tx * T + 6 + rnd() * 20, y = ty * T + 6 + rnd() * 20, r = 3 + rnd() * 5;
    g.fillStyle = 'rgba(5,4,3,.85)'; g.beginPath(); g.ellipse(x, y, r * 1.3, r, rnd() * 3, 0, 2 * PI); g.fill();
    const s = g.createLinearGradient(x - r, y - r, x + r, y + r); s.addColorStop(0, 'rgba(120,80,200,.25)'); s.addColorStop(.5, 'rgba(80,200,160,.18)'); s.addColorStop(1, 'rgba(220,160,60,.2)');
    g.fillStyle = s; g.beginPath(); g.ellipse(x - r * .2, y - r * .2, r * .8, r * .5, rnd() * 3, 0, 2 * PI); g.fill();
  }
}
function stripTile(i) {
  const tx = i % W, ty = i / W | 0, x = tx * T, y = ty * T, t = oreType[i];
  tg.fillStyle = t === 'coal' ? 'rgba(34,30,28,.85)' : t === 'limestone' ? 'rgba(178,172,156,.85)' : 'rgba(128,52,22,.85)';
  tg.fillRect(x, y, T, T);
  const rnd = mulberry(i * 7 + 3);
  tg.strokeStyle = 'rgba(0,0,0,.22)'; tg.lineWidth = 1;
  for (let k = 0; k < 3; k++) { const yy = y + 6 + k * 9 + rnd() * 3; tg.beginPath(); tg.moveTo(x, yy); tg.lineTo(x + T, yy + (rnd() - .5) * 3); tg.stroke(); }
  if (t) drawOreTile(tx, ty);
}
let terrainSeed = null;
function syncTerrain() {   // after loading a snapshot: chunks are rebuilt from the current state on demand
  chunkCache.clear();
  if (terrainSeed !== S.seed && typeof buildMiniBase === 'function') { terrainSeed = S.seed; buildMiniBase(); }
}

// =====================================================================
//  new building art (local frame, north-facing)
// =====================================================================
function heapFill(c, cx, cy, r, col) {
  if (r < 1) return;
  const g = c.createRadialGradient(cx - r * .3, cy - r * .3, 1, cx, cy, r); g.addColorStop(0, shade(col, 30)); g.addColorStop(1, shade(col, -30));
  c.fillStyle = g; c.beginPath(); c.ellipse(cx, cy, r, r * .85, 0, 0, 2 * PI); c.fill();
  const rnd = mulberry(r * 10 | 0); c.fillStyle = 'rgba(0,0,0,.25)';
  for (let k = 0; k < r; k++) { const a = rnd() * 2 * PI, d = rnd() * r * .8; c.fillRect(cx + Math.cos(a) * d, cy + Math.sin(a) * d * .85, 1.5, 1.5); }
}
function shade(hex, d) { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, v + d)); return `rgb(${f(n >> 16)},${f(n >> 8 & 255)},${f(n & 255)})`; }
function lattice(c, x, y, w, h) {
  c.strokeStyle = '#9a7a3a'; c.lineWidth = 1.2; c.strokeRect(x, y, w, h);
  c.lineWidth = .8; for (let j = y; j < y + h; j += 8) { line(c, x, j, x + w, j + 8 > y + h ? y + h : j + 8); line(c, x + w, j, x, Math.min(y + h, j + 8)); }
}
function plume(c, x, y, len, wid, a) {
  const fl = .85 + .15 * Math.sin(tnow() * 40 + x);
  const g = c.createLinearGradient(x, y, x, y + len * fl); g.addColorStop(0, `rgba(255,255,240,${a})`); g.addColorStop(.15, `rgba(255,220,120,${a})`); g.addColorStop(.6, `rgba(255,120,40,${a * .6})`); g.addColorStop(1, 'rgba(255,80,20,0)');
  c.fillStyle = g; c.beginPath(); c.moveTo(x - wid * .3, y); c.lineTo(x + wid * .3, y); c.lineTo(x + wid, y + len * fl); c.lineTo(x - wid, y + len * fl); c.closePath(); c.fill();
  for (let k = 0; k < 5; k++) { c.fillStyle = `rgba(255,255,255,${a * .5})`; circle(c, x, y + 6 + k * len / 6, wid * .25); c.fill(); }   // shock diamonds
}
function roofPanels(c, x, y, w, h, c1, c2) {
  corrugated(c, x, y, w, h, c1, c2);
  c.fillStyle = 'rgba(200,230,255,.22)'; for (let j = y + 10; j < y + h - 10; j += 26) c.fillRect(x + 8, j, w - 16, 6);
}
Object.assign(DRAW, {
  sentry(c, e) {
    // ring of sandbags
    for (let k = 0; k < 10; k++) {
      const a = k / 10 * 2 * PI, x = 16 + Math.cos(a) * 12, y = 16 + Math.sin(a) * 12;
      c.fillStyle = '#3a3324'; c.beginPath(); c.ellipse(x + .8, y + 1, 4.6, 3.4, a + PI / 2, 0, 2 * PI); c.fill();
      c.fillStyle = k % 2 ? '#8a7d5a' : '#7a6e4e'; c.beginPath(); c.ellipse(x, y, 4.2, 3, a + PI / 2, 0, 2 * PI); c.fill();
      c.fillStyle = 'rgba(255,240,200,.15)'; c.fillRect(x - 2, y - 2, 2, 1);
    }
    c.fillStyle = '#4b4434'; circle(c, 16, 16, 7.5); c.fill();
    // tripod legs
    c.strokeStyle = '#1c1d1a'; c.lineWidth = 2; c.lineCap = 'round';
    for (const a of [-PI / 2, PI / 6, 5 * PI / 6]) line(c, 16, 16, 16 + Math.cos(a) * 9, 16 + Math.sin(a) * 9);
    c.fillStyle = '#3a6a3a'; c.fillRect(20, 20, 5, 4); c.fillStyle = '#26401f'; c.fillRect(20, 20, 5, 1);   // ammo box
  },
  turret(c, e) {
    // octagonal armoured plinth, yellow/black chevrons on every face
    const oct = (r, ox = 32, oy = 32) => { c.beginPath(); for (let k = 0; k < 8; k++) { const a = (k + .5) / 8 * 2 * PI; c[k ? 'lineTo' : 'moveTo'](ox + Math.cos(a) * r, oy + Math.sin(a) * r); } c.closePath(); };
    c.fillStyle = '#17150f'; oct(31, 33, 34); c.fill();
    c.fillStyle = '#d9a514'; oct(29); c.fill();
    c.save(); oct(29); c.clip(); c.fillStyle = '#16140e';
    for (let i = -70; i < 70; i += 12) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 6, 0); c.lineTo(i + 70, 64); c.lineTo(i + 64, 64); c.closePath(); c.fill(); }
    c.restore();
    c.fillStyle = '#2b2a26'; oct(21); c.fill(); c.strokeStyle = '#0c0b08'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#3d3b35'; oct(16); c.fill();
    c.fillStyle = '#5a574e'; for (let k = 0; k < 8; k++) { const a = (k + .5) / 8 * 2 * PI; c.fillRect(32 + Math.cos(a) * 25 - 1.5, 32 + Math.sin(a) * 25 - 1.5, 3, 3); }
  },
  store(c, e) {
    concrete(c, 2, 2, 60, 60);
    corrugated(c, 6, 6, 52, 30, '#5a6e5a', '#3a4a3a'); stencil(c, 'SITE STORES', 32, 25, 6.5, 'rgba(10,20,10,.6)');
    const ks = Object.keys(stores).filter(k => stores[k] > 0 && SPR[k]).slice(0, 4);
    ks.forEach((k, i) => c.drawImage(SPR[k], 6 + i * 13, 38, 18, 18));
    hazard(c, 4, 56, 56, 4);
  },
  cementkiln(c, e) {
    concrete(c, 2, 2, 60, 124);
    c.save(); c.translate(32, 70); c.rotate(.05);
    const g = c.createLinearGradient(-14, 0, 14, 0); g.addColorStop(0, '#5a5048'); g.addColorStop(.5, '#a8988a'); g.addColorStop(1, '#4a4038'); c.fillStyle = g; c.fillRect(-12, -46, 24, 92);
    c.fillStyle = '#2a2420'; for (const yy of [-30, 0, 30]) c.fillRect(-14, yy, 28, 5);
    if (working(e)) { c.fillStyle = `rgba(255,${120 + 40 * Math.sin(tnow() * 4)},40,.9)`; c.fillRect(-8, 40, 16, 6); }
    c.restore();
    body(c, 8, 6, 48, 18, 2, '#7a706a', '#4a4440'); stack(c, 32, 20, 7);
    c.fillStyle = '#6a665e'; circle(c, 50, 112, 8); c.fill(); c.strokeStyle = '#3a3733'; c.stroke();
  },
  batching(c, e) {
    concrete(c, 2, 2, 92, 92);
    for (const x of [22, 48]) { c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, x + 4, 26, 12); c.fill(); tankTop(c, x, 22, 12, '#cfcac0', '#8a857c'); }
    stencil(c, 'CEM', 22, 25, 7, '#4a4640'); stencil(c, 'AGG', 48, 25, 7, '#4a4640');
    c.fillStyle = '#3a3e42'; c.fillRect(14, 44, 64, 10);
    const off = (e.anim || 0) % 20;
    for (let x = 8 + off; x < 88; x += 20) { c.fillStyle = '#b4b0a8'; c.fillRect(x, 64, 16, 22); c.strokeStyle = '#6a665e'; c.lineWidth = .8; c.strokeRect(x, 64, 16, 22); }
    c.save(); c.translate(76, 30); if (working(e)) c.rotate(tnow() * 3); c.fillStyle = '#c4661c'; c.beginPath(); c.ellipse(0, 0, 9, 6, 0, 0, 2 * PI); c.fill(); c.strokeStyle = '#4a2a0a'; c.stroke(); c.restore();
  },
  extrusion(c, e) {
    concrete(c, 2, 2, 92, 124);
    body(c, 10, 8, 26, 30, 3, '#7a6a5c', '#4a4036');
    c.fillStyle = working(e) ? `rgba(255,${150 + 40 * Math.sin(tnow() * 5)},70,1)` : '#2a2420'; c.fillRect(16, 16, 14, 14);
    body(c, 38, 10, 44, 40, 3, '#8a9096', '#4e545a'); stencil(c, '35 MN', 60, 34, 8, 'rgba(255,255,255,.6)');
    c.fillStyle = '#26282b'; c.fillRect(54, 50, 12, 70);
    c.fillStyle = '#5a5e62'; for (let y = 54; y < 118; y += 6) c.fillRect(48, y, 24, 2);
    if (working(e)) { const p = e.prog || 0; c.fillStyle = '#e8ecef'; c.fillRect(57, 50, 6, 70 * p); c.fillStyle = 'rgba(255,170,70,.8)'; c.fillRect(57, 50, 6, 4); }
    c.drawImage(SPR.alu, 10, 88, 30, 30);
  },
  road(c) { c.fillStyle = '#8a7458'; c.fillRect(0, 0, 32, 32); },
  hopper(c, e) {
    concrete(c, 2, 2, 60, 60);
    hazard(c, 4, 0, 56, 5);
    c.fillStyle = '#2b2622'; c.beginPath(); c.moveTo(8, 7); c.lineTo(56, 7); c.lineTo(44, 50); c.lineTo(20, 50); c.closePath(); c.fill();
    const f = Math.min(1, (e.stock || 0) / BIN_CAP);
    if (e.mat && f > 0) heapFill(c, 32, 28, 6 + 18 * Math.sqrt(f), MATCOL[e.mat]);
    c.strokeStyle = '#7a7d80'; c.lineWidth = 2; for (let x = 11; x <= 53; x += 6) line(c, x, 8, x, 30);
    c.strokeStyle = '#4a4d50'; c.lineWidth = 2; line(c, 8, 19, 56, 19);
    c.fillStyle = '#55504a'; c.fillRect(24, 50, 16, 12); c.strokeStyle = '#1b1815'; c.lineWidth = 1; c.strokeRect(24, 50, 16, 12);
    stencil(c, e.mat ? ITEMS[e.mat].n.toUpperCase().slice(0, 10) : 'SET MATERIAL', 32, 47, 6.5, e.mat ? '#f2d24a' : '#ff7a5c');
  },
  bin(c, e) {
    c.fillStyle = 'rgba(0,0,0,.3)'; rrect(c, 8, 12, 52, 50, 6); c.fill();
    body(c, 4, 8, 56, 52, 5, '#8e959c', '#4d5359');
    c.fillStyle = '#26282b'; rrect(c, 11, 15, 42, 38, 3); c.fill();
    const f = Math.min(1, (e.stock || 0) / BIN_CAP);
    if (e.mat && f > 0) heapFill(c, 32, 34, 5 + 16 * Math.sqrt(f), MATCOL[e.mat]);
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; for (let x = 14; x < 54; x += 8) line(c, x, 9, x, 14);
    c.fillStyle = '#5d6268'; c.beginPath(); c.moveTo(22, 9); c.lineTo(42, 9); c.lineTo(38, -4); c.lineTo(26, -4); c.closePath(); c.fill(); c.strokeStyle = '#1b1d20'; c.stroke();
    c.fillStyle = '#c4661c'; c.fillRect(26, -4, 12, 2);
    stencil(c, 'LOAD-OUT', 32, 58, 6.5, '#f2d24a');
  },
  feeder(c, e) {
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(7, 3, 22, 31);
    c.fillStyle = '#26231f'; c.fillRect(5, 0, 22, 32);
    const off = ((e.anim || 0) * .9) % 6;
    for (let y = 32 + 6 - off; y > -6; y -= 6) { c.fillStyle = '#4c4842'; c.fillRect(7, y - 5, 18, 4.5); c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(7, y - 5, 18, 1); }
    if (e.flow > 0) { const m = (e.status || '').replace('Feeding ', ''); const k = Object.keys(ITEMS).find(k => ITEMS[k].n === m); if (k && MATCOL[k]) { c.fillStyle = MATCOL[k]; c.globalAlpha = .85; c.fillRect(9, 2, 14, 28); c.globalAlpha = 1; } }
    c.fillStyle = '#5b7a6c'; c.fillRect(3, 0, 3, 32); c.fillRect(26, 0, 3, 32);
    c.fillStyle = '#1b1815'; for (let y = 4; y < 32; y += 8) { c.fillRect(3, y, 3, 2); c.fillRect(26, y, 3, 2); }
  },
  excavator(c, e) {
    for (const x of [8, 66]) {
      c.fillStyle = 'rgba(0,0,0,.35)'; rrect(c, x + 3, 9, 22, 84, 8); c.fill();
      c.fillStyle = '#26231f'; rrect(c, x, 6, 22, 84, 8); c.fill();
      const off = (e.anim || 0) * .0 % 6;
      c.fillStyle = '#4a4540'; for (let y = 9 + off; y < 87; y += 6) c.fillRect(x + 2, y, 18, 3.5);
      c.fillStyle = '#5c5650'; circle(c, x + 11, 14, 6); c.fill(); circle(c, x + 11, 82, 6); c.fill();
    }
    c.fillStyle = '#3a3632'; c.fillRect(28, 36, 40, 24);
    c.fillStyle = '#5b5650'; circle(c, 48, 48, 17); c.fill(); c.strokeStyle = '#1b1815'; c.lineWidth = 2; c.stroke();
  },
  oilwell(c, e) {
    concrete(c, 4, 4, 56, 56);
    c.fillStyle = '#141210'; circle(c, 32, 50, 5); c.fill();
    c.fillStyle = '#5c5650'; c.fillRect(26, 20, 12, 30);
    const nod = Math.sin((e.anim || 0) * .06);
    c.fillStyle = '#6a6460'; c.fillRect(29, 26, 6, 10);
    c.save(); c.translate(32, 30);
    c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(-2, -20 + nod * 3, 9, 46);
    c.fillStyle = '#5b7a6c'; c.fillRect(-4, -24 + nod * 3, 8, 44 - nod * 3 * 2);
    c.strokeStyle = '#3a2a0a'; c.lineWidth = 1.2; c.strokeRect(-4, -24 + nod * 3, 8, 44 - nod * 3 * 2);
    c.fillStyle = '#b07a1a'; c.beginPath(); c.arc(0, 20 - nod * 3, 7, 0, PI); c.fill();
    c.restore();
    c.fillStyle = '#2b2826'; for (const x of [14, 50]) { c.save(); c.translate(x, 14); c.rotate((e.anim || 0) * .06); c.fillRect(-6, -2, 12, 4); c.restore(); }
    tankTop(c, 50, 50, 9, '#3a3a3a', '#1a1a1a');
  },
  distill(c, e) {
    concrete(c, 2, 2, 92, 156);
    c.fillStyle = '#2b2826'; c.fillRect(8, 104, 40, 42);
    c.fillStyle = working(e) ? `rgba(255,${120 + 40 * Math.sin(tnow() * 3)},40,.9)` : '#3a2a20'; for (let k = 0; k < 4; k++) c.fillRect(12 + k * 9, 132, 5, 8);
    corrugated(c, 8, 104, 40, 24, '#6c625a', '#443e38');
    stack(c, 28, 112, 6, true);
    for (const [x, y, r] of [[64, 40, 20], [30, 50, 14], [68, 104, 13]]) {
      c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, x + 5, y + 6, r); c.fill();
      tankTop(c, x, y, r, '#d4d6d8', '#7a7e82');
      c.strokeStyle = '#5b7a6c'; c.lineWidth = 2; circle(c, x, y, r + 3); c.stroke();
      c.strokeStyle = 'rgba(217,162,43,.6)'; c.lineWidth = 1; for (let k = 0; k < 8; k++) { const a = k / 8 * 2 * PI; line(c, x + Math.cos(a) * r, y + Math.sin(a) * r, x + Math.cos(a) * (r + 3), y + Math.sin(a) * (r + 3)); }
    }
    c.strokeStyle = '#8e9396'; c.lineWidth = 4; line(c, 16, 10, 16, 40); line(c, 48, 10, 48, 30); line(c, 80, 10, 80, 22);
  },
  coker(c, e) {
    concrete(c, 2, 2, 92, 124);
    c.fillStyle = '#3a2f25'; c.fillRect(6, 88, 84, 34);
    heapFill(c, 48, 106, 10 + Math.min(16, (e.outb && e.outb.coke || 0) * 4), '#3a3a40');
    lattice(c, 10, 8, 76, 18);
    for (const x of [28, 68]) { c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, x + 5, 56, 19); c.fill(); tankTop(c, x, 52, 19, '#9a9590', '#55514c'); c.fillStyle = '#2a2826'; circle(c, x, 52, 7); c.fill(); if (working(e)) { c.fillStyle = 'rgba(255,140,40,.5)'; circle(c, x, 52, 4); c.fill(); } }
    hazard(c, 6, 82, 84, 5);
  },
  reformer(c, e) {
    concrete(c, 2, 2, 92, 92);
    body(c, 8, 8, 56, 70, 2, '#76706a', '#45403b');
    for (let k = 0; k < 6; k++) { c.fillStyle = working(e) ? `rgba(255,${100 + 30 * Math.sin(tnow() * 4 + k)},40,.95)` : '#3a2a20'; c.fillRect(14 + k * 8, 16, 4, 54); }
    stack(c, 80, 18, 8, true);
    c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, 82, 66, 10); c.fill(); tankTop(c, 79, 62, 10, '#d4d6d8', '#7a7e82');
    stencil(c, 'H₂', 79, 66, 9, '#e04f9a');
  },
  hydrotreater(c, e) {
    concrete(c, 2, 2, 92, 92);
    c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, 36, 44, 22); c.fill();
    tankTop(c, 32, 40, 22, '#cfd2d4', '#6e7276');
    c.strokeStyle = '#5b7a6c'; c.lineWidth = 2; circle(c, 32, 40, 25); c.stroke();
    body(c, 62, 10, 26, 30, 2, '#6a6460', '#3a3632');
    c.fillStyle = working(e) ? 'rgba(255,130,40,.8)' : '#3a2a20'; c.fillRect(68, 26, 14, 8);
    const g = c.createLinearGradient(0, 64, 0, 82); g.addColorStop(0, '#d4d6d8'); g.addColorStop(1, '#7a7e82'); c.fillStyle = g; rrect(c, 52, 64, 38, 18, 9); c.fill(); c.strokeStyle = '#2a2c2e'; c.stroke();
    stencil(c, 'RP-1', 71, 77, 8, '#f08a24');
  },
  asu(c, e) {
    concrete(c, 2, 2, 124, 124);
    roofPanels(c, 6, 6, 58, 54, '#6f8aa0', '#455a6c'); stencil(c, 'MAC', 35, 38, 9, 'rgba(10,20,30,.5)');
    body(c, 72, 6, 26, 90, 2, '#e6eaee', '#9aa6b2');
    c.strokeStyle = 'rgba(0,0,0,.18)'; for (let y = 14; y < 92; y += 10) line(c, 74, y, 96, y);
    stencil(c, 'COLD BOX', 85, 104, 6, 'rgba(255,255,255,.75)');
    c.fillStyle = 'rgba(0,0,0,.3)'; circle(c, 34, 96, 22); c.fill();
    const g = c.createRadialGradient(26, 84, 2, 30, 92, 22); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#a9c8dc');
    c.fillStyle = g; circle(c, 30, 92, 22); c.fill(); c.strokeStyle = '#4a6a80'; c.lineWidth = 1.5; c.stroke();
    const rnd = mulberry(5); c.fillStyle = 'rgba(255,255,255,.7)'; for (let k = 0; k < 30; k++) c.fillRect(14 + rnd() * 32, 76 + rnd() * 32, 1.5, 1.5);
    stencil(c, 'LOX', 30, 95, 9, '#2a6a9a');
    c.fillStyle = '#3a3e42'; for (let k = 0; k < 3; k++) { circle(c, 108 + 0, 20 + k * 30, 8); c.fill(); }
    if (working(e)) { c.strokeStyle = 'rgba(200,230,255,.5)'; c.lineWidth = 2; for (let k = 0; k < 3; k++) { c.save(); c.translate(108, 20 + k * 30); c.rotate(tnow() * 12); line(c, -6, 0, 6, 0); line(c, 0, -6, 0, 6); c.restore(); } }
  },
  alloy(c, e) {
    concrete(c, 2, 2, 92, 92);
    body(c, 8, 8, 50, 40, 4, '#6a5a50', '#3a302a');
    c.fillStyle = working(e) ? `rgba(255,${160 + 40 * Math.sin(tnow() * 5)},70,1)` : '#2a2420'; c.fillRect(22, 20, 22, 14);
    stack(c, 76, 22, 7);
    c.fillStyle = '#26231f'; c.fillRect(14, 58, 68, 28);
    const p = working(e) ? (e.prog || 0) : 0;
    c.fillStyle = '#c8ccd2'; c.fillRect(20, 80 - p * 18, 56, p * 18);
    if (p > 0) { c.fillStyle = 'rgba(255,170,60,.8)'; c.fillRect(20, 80 - p * 18, 56, 2); }
    stencil(c, 'Al-Li 2195', 48, 72, 7, 'rgba(255,230,200,.6)');
  },
  rolling(c, e) {
    concrete(c, 2, 2, 92, 188);
    roofPanels(c, 8, 6, 80, 40, '#7a6a5c', '#4a4036');
    c.fillStyle = working(e) ? 'rgba(255,140,50,.7)' : '#3a2a20'; c.fillRect(36, 42, 24, 6);
    c.fillStyle = '#2b2826'; c.fillRect(30, 50, 36, 136);
    c.fillStyle = '#5a5e62'; for (let y = 54; y < 184; y += 6) c.fillRect(32, y, 32, 3);
    for (const y of [76, 112]) { c.fillStyle = '#3a3e42'; c.fillRect(14, y - 6, 68, 12); c.fillStyle = '#9aa0a6'; c.fillRect(20, y - 3, 56, 6); c.fillStyle = '#c4661c'; c.fillRect(12, y - 8, 6, 16); c.fillRect(78, y - 8, 6, 16); }
    if (working(e)) { const p = e.prog || 0, y = 54 + p * 120; const h = 12 + p * 30; c.fillStyle = p < .5 ? `rgba(255,${120 + p * 200},60,.95)` : '#d8dde2'; c.fillRect(34, y, 28, h); }
  },
  tankshop(c, e) {
    concrete(c, 2, 2, 124, 124);
    roofPanels(c, 6, 6, 116, 50, '#7c8a96', '#4c5864');
    stencil(c, 'FRICTION-STIR WELD', 64, 34, 7, 'rgba(10,20,30,.55)');
    c.fillStyle = '#3a3e42'; c.fillRect(14, 64, 100, 52);
    for (const x of [24, 104]) { c.fillStyle = '#c4661c'; c.fillRect(x - 4, 66, 8, 48); }
    const p = working(e) ? (e.prog || 0) : 0;
    if (p > 0 || (e.outb && e.outb.tank)) {
      const g = c.createLinearGradient(0, 70, 0, 110); g.addColorStop(0, '#f0f3f6'); g.addColorStop(.5, '#b8c0c8'); g.addColorStop(1, '#7a838c');
      c.fillStyle = g; c.fillRect(30, 70, 68 * Math.max(p, e.outb && e.outb.tank ? 1 : 0), 40);
      c.strokeStyle = 'rgba(0,0,0,.25)'; for (let x = 36; x < 30 + 68 * Math.max(p, .01); x += 8) line(c, x, 70, x, 110);
      if (working(e)) { const x = 30 + 68 * p; c.fillStyle = '#fff'; circle(c, x, 90, 3); c.fill(); glowAt(c, x, 90, 10, 'rgba(255,230,160,A)', .7); }
    }
  },
  turbo(c, e) {
    concrete(c, 2, 2, 92, 92);
    c.fillStyle = '#d8dcdf'; rrect(c, 8, 8, 80, 66, 4); c.fill(); c.strokeStyle = '#3a3e42'; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = 'rgba(100,160,220,.35)'; c.fillRect(14, 14, 68, 40);
    c.save(); c.translate(48, 34); if (working(e)) c.rotate(tnow() * 20); c.fillStyle = '#8b8d90'; circle(c, 0, 0, 12); c.fill(); c.strokeStyle = '#d0d3d6'; c.lineWidth = 1.5; for (let k = 0; k < 7; k++) { const a = k / 7 * 2 * PI; line(c, 0, 0, Math.cos(a) * 11, Math.sin(a) * 11); } c.restore();
    c.fillStyle = '#3a3e42'; c.fillRect(14, 60, 68, 10); c.fillStyle = working(e) ? '#62e05c' : '#e2483a'; circle(c, 76, 65, 2.5); c.fill();
    if (working(e) && Math.random() < .5) { c.fillStyle = '#ffe9a0'; c.fillRect(48 + (Math.random() - .5) * 20, 34 + (Math.random() - .5) * 20, 1.5, 1.5); }
    c.drawImage(SPR.turbopump, 18, 74, 18, 18);
  },
  chamberfab(c, e) {
    concrete(c, 2, 2, 92, 92);
    roofPanels(c, 6, 6, 84, 26, '#8c6a50', '#5c4232');
    c.fillStyle = '#3a3e42'; c.fillRect(20, 40, 56, 46);
    c.save(); c.translate(48, 44); c.scale(2.4, 2.4); c.translate(-16, -3); bell(c, 16, 3, 1, working(e) ? '#e09050' : '#c27a44'); c.restore();
    if (working(e)) for (let k = 0; k < 3; k++) { c.fillStyle = '#ffd070'; const a = Math.random() * 2 * PI; c.fillRect(48 + Math.cos(a) * 14, 52 + Math.sin(a) * 10, 1.5, 1.5); }
  },
  engineasm(c, e) {
    concrete(c, 2, 2, 92, 92);
    c.fillStyle = '#e6e8ea'; c.fillRect(8, 8, 80, 80); c.strokeStyle = '#9aa0a6'; c.lineWidth = 1; c.strokeRect(8, 8, 80, 80);
    c.strokeStyle = '#5b7a6c'; c.setLineDash([4, 3]); c.strokeRect(20, 20, 56, 56); c.setLineDash([]);
    c.drawImage(SPR.engine, 24, 22, 48, 48);
    c.fillStyle = '#3a6a9a'; c.fillRect(8, 8, 80, 5);
  },
  teststand(c, e) {
    concrete(c, 2, 2, 124, 156);
    c.fillStyle = '#4a4640'; c.beginPath(); c.moveTo(44, 70); c.lineTo(84, 70); c.lineTo(100, 156); c.lineTo(28, 156); c.closePath(); c.fill();
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(50, 74, 28, 80);
    body(c, 34, 10, 60, 54, 2, '#8a857e', '#55514b');
    lattice(c, 40, 14, 48, 44);
    c.fillStyle = '#2a2826'; c.fillRect(56, 40, 16, 24);
    if (e.inb && e.inb.engine >= 1 || working(e)) c.drawImage(SPR.engine, 46, 30, 36, 36);
    tankTop(c, 16, 136, 12, '#f08a24', '#8a4a10'); tankTop(c, 112, 136, 12, '#e6f2fa', '#7fa8c4');
    const firing = working(e) && (e.prog || 0) > .25;
    if (firing || e.fire > 0) plume(c, 64, 64, 90, 16, firing ? 1 : (e.fire / 40));
  },
  payloadfab(c, e) {
    concrete(c, 2, 2, 92, 92);
    c.fillStyle = '#f2f4f6'; c.fillRect(8, 8, 80, 80); c.fillStyle = '#3a6a9a'; c.fillRect(8, 40, 80, 4);
    c.drawImage(SPR.payload, 30, 14, 36, 36);
    stencil(c, 'CLASS 100k', 48, 64, 7, 'rgba(40,60,90,.7)');
    c.drawImage(SPR.paykit, 14, 60, 22, 22);
  },
  vab(c, e) {
    concrete(c, 2, 2, 156, 220);
    body(c, 8, 8, 144, 204, 3, '#dcdfe2', '#a6acb2');
    c.strokeStyle = 'rgba(0,0,0,.12)'; c.lineWidth = 1; for (let x = 20; x < 150; x += 12) line(c, x, 10, x, 210);
    c.fillStyle = '#4c5864'; c.fillRect(56, 8, 48, 120);
    c.strokeStyle = 'rgba(255,255,255,.25)'; for (let y = 16; y < 128; y += 10) line(c, 58, y, 102, y);
    c.fillStyle = '#c4362a'; c.fillRect(18, 150, 46, 30); c.fillStyle = '#2a5a9a'; c.fillRect(96, 150, 46, 30);
    stencil(c, 'VAB', 80, 200, 16, 'rgba(40,50,60,.55)');
    if (working(e) || (e.outb && e.outb.rocket)) { const p = e.outb && e.outb.rocket ? 1 : (e.prog || 0); c.fillStyle = 'rgba(255,255,255,.9)'; c.fillRect(74, 128 - 110 * p, 12, 110 * p); c.fillStyle = '#222'; c.fillRect(74, 128 - 60 * p, 12, 3); }
  },
  pad(c, e) {
    concrete(c, 2, 2, 188, 188);
    c.fillStyle = '#6a665e'; circle(c, 96, 80, 54); c.fill(); c.strokeStyle = '#3a3733'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#1a1816'; c.fillRect(82, 80, 28, 110);
    c.fillStyle = '#3a3632'; c.fillRect(76, 66, 40, 28);
    lattice(c, 132, 30, 22, 90);
    for (const [x, y] of [[14, 14], [178, 14], [14, 150], [178, 150]]) { c.fillStyle = '#9aa0a6'; circle(c, x, y, 4); c.fill(); }
    tankTop(c, 26, 166, 16, '#f08a24', '#8a4a10'); stencil(c, 'RP-1', 26, 169, 8, '#2a1a0a');
    const g = c.createRadialGradient(160, 160, 2, 166, 166, 18); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#a9c8dc');
    c.fillStyle = g; circle(c, 166, 166, 18); c.fill(); c.strokeStyle = '#4a6a80'; c.lineWidth = 1.5; c.stroke(); stencil(c, 'LOX', 166, 169, 8, '#2a6a9a');
    if (e.launchT > 0) { const a = e.launchT / 180; c.fillStyle = `rgba(40,30,20,${a * .5})`; c.fillRect(2, 2, 188, 188); }
    hazard(c, 6, 6, 60, 6);
  },
});

// ---------------------------------------------------------------- world-frame overlays
function angLerp(a, b, k) { let d = ((b - a + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI; return a + d * k; }
const smooth01 = x => x * x * (3 - 2 * x);
function drawExcavatorTop(c, e, dt) {
  const cx = (e.x + 1.5) * T, cy = (e.y + 1.5) * T;
  const face = e.dig >= 0 ? [(e.dig % W + .5) * T, ((e.dig / W | 0) + .5) * T] : [cx + DX[e.dir] * 64, cy + DY[e.dir] * 64];
  const bay = [cx + DX[e.dir] * 64, cy + DY[e.dir] * 64];
  const spoil = [cx - DY[e.dir] * 70 - DX[e.dir] * 30, cy + DX[e.dir] * 70 - DY[e.dir] * 30];
  let tgt = face, loaded = false;
  if (e.status === 'Loading truck' || e.status === 'Stripping overburden') {
    const ph = (tnow() * .45 + e.x * .13) % 1, other = e.status === 'Loading truck' ? bay : spoil;
    const s = ph < .35 ? 0 : ph < .5 ? smooth01((ph - .35) / .15) : ph < .85 ? 1 : 1 - smooth01((ph - .85) / .15);
    tgt = [face[0] + (other[0] - face[0]) * s, face[1] + (other[1] - face[1]) * s]; loaded = s > .1 && s < .99 || (ph > .5 && ph < .85);
    e._dig = ph < .35;
  } else e._dig = false;
  const want = Math.atan2(tgt[1] - cy, tgt[0] - cx);
  e._ang = e._ang === undefined ? want : angLerp(e._ang, want, Math.min(1, dt * 6));
  const reach = Math.max(46, Math.min(115, Math.hypot(tgt[0] - cx, tgt[1] - cy)));
  e._reach = e._reach === undefined ? reach : e._reach + (reach - e._reach) * Math.min(1, dt * 5);
  c.save(); c.translate(cx, cy); c.rotate(e._ang);
  c.fillStyle = 'rgba(0,0,0,.3)'; rrect(c, -26, -18, 54, 44, 6); c.fill();
  c.fillStyle = '#2b2826'; rrect(c, -36, -18, 16, 36, 4); c.fill();
  body(c, -30, -20, 50, 40, 5, '#6d8a7b', '#3e574b');
  c.fillStyle = '#3a3632'; c.fillRect(-26, -14, 18, 12); c.fillStyle = 'rgba(0,0,0,.4)'; for (let k = 0; k < 4; k++) c.fillRect(-25, -13 + k * 3, 16, 1);
  c.fillStyle = '#a82a26'; c.fillRect(-30, 12, 50, 4); star(c, -16, 6, 4, '#b8262a'); c.fillStyle = '#e8e2d0'; c.fillRect(-27, 4, 4, 4);
  c.fillStyle = '#26231f'; rrect(c, 4, 6, 16, 14, 2); c.fill(); c.fillStyle = '#7ab4d8'; c.fillRect(14, 8, 5, 10);
  const R = e._reach, ex = R * .55;
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 11; line(c, 14, 4, R + 4, 6);
  c.strokeStyle = '#2f443a'; c.lineWidth = 11; line(c, 12, -2, ex, -2);
  c.strokeStyle = '#6d8a7b'; c.lineWidth = 8; line(c, 12, -2, ex, -2);
  c.strokeStyle = '#4f6c5f'; c.lineWidth = 6; line(c, ex, -2, R - 8, 0);
  c.fillStyle = '#26231f'; circle(c, ex, -2, 4); c.fill();
  c.fillStyle = '#4a4540'; c.beginPath(); c.moveTo(R - 10, -9); c.lineTo(R + 6, -11); c.lineTo(R + 8, 11); c.lineTo(R - 10, 9); c.closePath(); c.fill();
  c.strokeStyle = '#1b1815'; c.lineWidth = 1.2; c.stroke();
  c.fillStyle = '#c8ccd0'; for (let k = -8; k <= 8; k += 4) c.fillRect(R + 6, k - 1, 4, 2);
  if (loaded) heapFill(c, R - 1, 0, 7, e.status === 'Stripping overburden' ? '#7a5a40' : (MATCOL[e.mat] || '#888'));
  c.restore();
  if (e._dig && Math.random() < .3 && particles.length < 700) particles.push({ x: face[0] + (Math.random() - .5) * 16, y: face[1] + (Math.random() - .5) * 16, vx: (Math.random() - .5) * .4, vy: -.2, life: 0, max: 50, r: 4, k: 'dust' });
}
function truckPos(t) {
  if (t.man) return [t.mx * T, t.my * T];
  const a = t.tile, b = t.next >= 0 ? t.next : a, p = t.next >= 0 ? t.p : 0;
  const ax = (a % W + .5) * T, ay = ((a / W | 0) + .5) * T, bx = (b % W + .5) * T, by = ((b / W | 0) + .5) * T;
  const side = t.parked && !t.job ? 11 : 7, h = t.h;
  return [ax + (bx - ax) * p + DX[(h + 1) % 4] * side, ay + (by - ay) * p + DY[(h + 1) % 4] * side];
}
function drawTruck(c, t, dt) {
  const [px, py] = truckPos(t);
  const k = Math.min(1, dt * 14);
  if (t._x === undefined || Math.abs(t._x - px) > 64 || Math.abs(t._y - py) > 64) { t._x = px; t._y = py; }
  t._x += (px - t._x) * k; t._y += (py - t._y) * k;
  const want = t.man ? Math.atan2(t.hx, -t.hy) : t.h * PI / 2; t._a = t._a === undefined ? want : angLerp(t._a, want, Math.min(1, dt * (t.man ? 20 : 8)));
  c.save(); c.translate(t._x, t._y); c.rotate(t._a);
  c.scale(.74, .74);
  drawUral(c, t.load / TRUCK_CAP, t.mat, t.tip || 0, t.drv ? (roster.get(t.drv) || (t.drv === me.id ? me : null)) : null);
  if (t.status === 'Waiting in traffic' || t.next < 0 && t.path && t.path.length || (t.man && t.drv && t.th < 0)) { c.fillStyle = '#ff3a2a'; c.fillRect(-11, 31, 4, 2); c.fillRect(7, 31, 4, 2); }
  c.restore();
  if ((t.tip || 0) > .3 && Math.random() < .4) particles.push({ x: t._x - DX[t.h] * 14, y: t._y - DY[t.h] * 14, vx: (Math.random() - .5) * .3, vy: -.15, life: 0, max: 60, r: 5, k: 'dust' });
  if (t.next >= 0 && t.load > 0 && Math.random() < .08) particles.push({ x: t._x - DX[t.h] * 12, y: t._y - DY[t.h] * 12, vx: 0, vy: -.1, life: 0, max: 40, r: 3, k: 'dust' });
}
function drawRoad(c, r) {
  const i = r.x + r.y * W, x = r.x * T, y = r.y * T;
  const nb = [0, 1, 2, 3].map(d => { const q = get(r.x + DX[d], r.y + DY[d]); return !!q && q.type === 'road'; });
  c.fillStyle = '#8a7458'; c.fillRect(x, y, T, T);
  const h = hash(r.x, r.y, 21); c.fillStyle = `rgba(0,0,0,${.04 + h * .06})`; c.fillRect(x, y, T, T);
  const n = nb.filter(Boolean).length;
  c.strokeStyle = 'rgba(60,44,30,.45)'; c.lineWidth = 3;
  if (n < 3) for (let d = 0; d < 4; d++) if (nb[d]) for (const o of [-7, 7]) { const px = -DY[d] * o, py = DX[d] * o; line(c, x + 16 + px, y + 16 + py, x + 16 + DX[d] * 16 + px, y + 16 + DY[d] * 16 + py); }
  if (n === 0) for (const o of [-7, 7]) line(c, x + 16 + o, y + 4, x + 16 + o, y + 28);
  if (n >= 3) { c.fillStyle = 'rgba(60,44,30,.2)'; circle(c, x + 16, y + 16, 10); c.fill(); }
  const ns = nb[0] || nb[2], ew = nb[1] || nb[3];
  if (n < 3 && ns !== ew || n === 0) {
    // painted lane arrows: traffic keeps right
    const heads = ew && !ns ? [1, 3] : [0, 2];
    for (const h of heads) {
      const ox = DX[(h + 1) % 4] * 7, oy = DY[(h + 1) % 4] * 7;
      c.save(); c.translate(x + 16 + ox, y + 16 + oy); c.rotate(h * PI / 2);
      c.fillStyle = 'rgba(245,238,220,.62)';
      c.beginPath(); c.moveTo(0, -7); c.lineTo(4.5, -1.5); c.lineTo(1.5, -1.5); c.lineTo(1.5, 6); c.lineTo(-1.5, 6); c.lineTo(-1.5, -1.5); c.lineTo(-4.5, -1.5); c.closePath(); c.fill();
      c.restore();
    }
  }
  c.fillStyle = '#6a5640';
  for (let d = 0; d < 4; d++) if (!nb[d]) { if (DX[d]) c.fillRect(x + (DX[d] > 0 ? T - 4 : 0), y, 4, T); else c.fillRect(x, y + (DY[d] > 0 ? T - 4 : 0), T, 4); }
  c.fillStyle = 'rgba(255,230,190,.18)'; for (let k = 0; k < 4; k++) { const hh = hash(r.x * 4 + k, r.y, 22); c.fillRect(x + hh * 30, y + hash(r.x, r.y * 4 + k, 23) * 30, 1.5, 1.5); }
  if (creep[i]) { c.fillStyle = 'rgba(80,30,70,.35)'; c.fillRect(x, y, T, T); }
}
function drawSignal(c, r) {
  const s = r.sig, x = r.x * T, y = r.y * T;
  const lamp = ax => s.allred > 0 ? '#ff3a2a' : s.green === ax ? (s.amber > 0 ? '#ffb020' : '#3aff6a') : '#ff3a2a';
  for (const [px, py] of [[x + 2, y + 2], [x + T - 8, y + T - 8]]) {
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(px + 2, py + 2, 6, 10);
    c.fillStyle = '#1b1d20'; c.fillRect(px, py, 6, 10);
    for (const [ax, yy] of [[0, py + 2.5], [1, py + 7.5]]) { const col = lamp(ax); c.save(); c.shadowColor = col; c.shadowBlur = 6; c.fillStyle = col; circle(c, px + 3, yy, 1.8); c.fill(); c.restore(); }
  }
  c.fillStyle = 'rgba(255,255,255,.55)'; c.font = 'bold 5px sans-serif'; c.textAlign = 'center'; c.fillText('N-S', x + 5, y + 18); c.fillText('E-W', x + T - 5, y + 18 - 16 + 32 - 4);
}
// ---------------------------------------------------------------- bugs
function drawBug(c, b, dt) {
  const px = b.x * T, py = b.y * T;
  if (b._x === undefined || Math.abs(b._x - px) > 40 || Math.abs(b._y - py) > 40) { b._x = px; b._y = py; b._a = 0; }
  const k = Math.min(1, dt * 12); const ox = b._x, oy = b._y; b._x += (px - b._x) * k; b._y += (py - b._y) * k;
  if (Math.abs(b._x - ox) + Math.abs(b._y - oy) > .05) b._a = angLerp(b._a, Math.atan2(b._y - oy, b._x - ox), Math.min(1, dt * 10));
  const t = tnow() * 18 + b.id, biting = b.bite > 0 && (b.bite % 40) < 20;
  c.save(); c.translate(b._x, b._y); c.rotate(b._a);
  c.fillStyle = 'rgba(0,0,0,.3)'; c.beginPath(); c.ellipse(2, 3, 9, 5, 0, 0, 2 * PI); c.fill();
  c.strokeStyle = '#1a0806'; c.lineWidth = 1.3; c.lineCap = 'round';
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) { const sw = Math.sin(t + i * 2 + (s > 0 ? PI : 0)) * 2.5, lx = -4 + i * 4; line(c, lx, s * 2.5, lx + sw - 2, s * 8); line(c, lx + sw - 2, s * 8, lx + sw - 4, s * 10); }
  const g = c.createRadialGradient(-3, -1, 1, -2, 0, 9); g.addColorStop(0, '#a8482a'); g.addColorStop(1, '#4a140a');
  c.fillStyle = g; c.beginPath(); c.ellipse(-4, 0, 6.5, 4.6, 0, 0, 2 * PI); c.fill();
  c.fillStyle = '#5a1a0c'; c.beginPath(); c.ellipse(2.5, 0, 3.4, 3.2, 0, 0, 2 * PI); c.fill();
  c.fillStyle = '#2a0a06'; c.beginPath(); c.ellipse(6, 0, 2.6, 2.4, 0, 0, 2 * PI); c.fill();
  c.strokeStyle = 'rgba(255,190,150,.25)'; c.lineWidth = .8; for (const xx of [-7, -4, -1]) line(c, xx, -4, xx, 4);
  const jaw = biting ? .9 : .35; c.strokeStyle = '#e8d0a0'; c.lineWidth = 1.4;
  for (const s of [-1, 1]) { c.beginPath(); c.moveTo(7.5, s * 1.2); c.quadraticCurveTo(10.5, s * (1.5 + jaw * 3), 11.5, s * jaw * .6); c.stroke(); }
  c.fillStyle = '#ff6a30'; for (const s of [-1, 1]) { circle(c, 7, s * 1.4, .8); c.fill(); }
  c.restore();
  if (b.hp < S.BUG_HP) { c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(b._x - 8, b._y - 13, 16, 3); c.fillStyle = '#e2483a'; c.fillRect(b._x - 8, b._y - 13, 16 * b.hp / 3, 3); }
}
function drawSentryTop(c, e) {
  const cx = (e.x + .5) * T, cy = (e.y + .5) * T, want = Math.atan2(e.aimY * T - cy, e.aimX * T - cx);
  e._a = e._a === undefined ? want : angLerp(e._a, want, .12);
  const firing = S.tick - e.shotT < 5;
  c.save(); c.translate(cx, cy); c.rotate(e._a);
  c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(-3, -1, 22, 4);
  c.fillStyle = '#2a2b27'; c.fillRect(-6, -3, 9, 6);   // receiver
  c.fillStyle = '#4a4c46'; c.fillRect(-5, -2, 6, 2);
  c.fillStyle = '#1c1d1a'; c.fillRect(3 - (firing ? 1 : 0), -1, 15, 2);   // barrel
  c.fillStyle = '#3c3e39'; c.fillRect(15 - (firing ? 1 : 0), -1.5, 3, 3);
  c.fillStyle = '#5c5442'; c.fillRect(-9, -2, 4, 4);   // stock / grips
  if (firing) { c.fillStyle = '#fff2b0'; c.beginPath(); c.moveTo(18, 0); c.lineTo(24, -3); c.lineTo(26, 0); c.lineTo(24, 3); c.closePath(); c.fill(); }
  c.restore();
  if (firing && S.tick - e.shotT < 2 && !e._shot) { e._shot = true; tracers.push({ x0: cx + Math.cos(e._a) * 18, y0: cy + Math.sin(e._a) * 18, x1: e.aimX * T, y1: e.aimY * T, t: .08 }); }
  if (!firing) e._shot = false;
  if (e.rounds < 10) { c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(cx - 10, cy + 12, 20, 3); c.fillStyle = '#f2b431'; c.fillRect(cx - 10, cy + 12, 20 * Math.min(1, e.rounds / 40), 3); }
}
function drawTurretTop(c, e) {
  const cx = (e.x + 1) * T, cy = (e.y + 1) * T, want = Math.atan2(e.aimY * T - cy, e.aimX * T - cx);
  e._a = e._a === undefined ? want : angLerp(e._a, want, .25);
  const firing = S.tick - e.shotT < 4;
  c.save(); c.translate(cx, cy); c.rotate(e._a);
  const rec = firing ? 3 : 0;
  c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(-10, -8, 46, 18);   // gun shadow
  c.fillStyle = '#121212'; rrect(c, -14, -13, 26, 26, 4); c.fill();
  c.fillStyle = '#2e2e2c'; rrect(c, -12, -11, 22, 22, 3); c.fill();
  c.fillStyle = '#4a4a46'; c.fillRect(-10, -9, 18, 4); c.fillStyle = '#1e1e1c'; c.fillRect(-10, 5, 18, 3);
  c.fillStyle = '#d9a514'; c.fillRect(-12, -11, 4, 22); c.fillStyle = '#16140e'; for (let j = -11; j < 11; j += 6) c.fillRect(-12, j, 4, 3);
  c.fillStyle = '#9ea2a4'; c.fillRect(8 - rec, -3, 24, 6); c.fillStyle = '#d4d8da'; c.fillRect(8 - rec, -3, 24, 2);
  c.fillStyle = '#5c6062'; c.fillRect(30 - rec, -4, 4, 8); c.fillStyle = '#1b1d20'; c.fillRect(8 - rec, -5, 7, 10);
  c.fillStyle = '#7d8186'; c.fillRect(-6, -16, 9, 5); c.fillStyle = '#c9ccd0'; c.fillRect(-5, -15, 3, 3);
  if (firing) { c.save(); c.shadowColor = '#ffd070'; c.shadowBlur = 12; c.fillStyle = '#fff2b0'; c.beginPath(); c.moveTo(27, 0); c.lineTo(36, -5); c.lineTo(40, 0); c.lineTo(36, 5); c.closePath(); c.fill(); c.restore(); }
  c.restore();
  if (firing && S.tick - e.shotT < 2 && !e._shot) { e._shot = true; tracers.push({ x0: cx + Math.cos(e._a) * 28, y0: cy + Math.sin(e._a) * 28, x1: e.aimX * T, y1: e.aimY * T, t: .08 }); }
  if (!firing) e._shot = false;
  if (e.rounds < 10) { c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(cx - 14, cy + 16, 28, 3); c.fillStyle = '#f2b431'; c.fillRect(cx - 14, cy + 16, 28 * e.rounds / 40, 3); }
}
function hpBar(c, e) {
  const [fw, fh] = fp(e.type, e.dir), x = e.x * T + 4, y = e.y * T - 6, w = fw * T - 8, f = Math.max(0, e.hp / S.entHpMax(e));
  c.fillStyle = 'rgba(0,0,0,.65)'; c.fillRect(x, y, w, 4); c.fillStyle = f > .5 ? '#62c25a' : f > .25 ? '#f2b431' : '#e2483a'; c.fillRect(x, y, w * f, 4);
}
function drawCreep(c, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!creep[x + y * W]) continue;
    const h = hash(x, y, 31), cx = x * T + 16, cy = y * T + 16;
    c.fillStyle = `rgba(${52 + h * 20},${26 + h * 10},${50 + h * 20},.72)`;
    circle(c, cx + (h - .5) * 6, cy + (hash(x, y, 32) - .5) * 6, 21 + h * 4); c.fill();
  }
  c.strokeStyle = 'rgba(160,60,120,.28)'; c.lineWidth = 1.5;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!creep[x + y * W]) continue;
    const h = hash(x, y, 33), cx = x * T + 16, cy = y * T + 16;
    c.beginPath(); c.moveTo(cx - 14, cy + (h - .5) * 20); c.quadraticCurveTo(cx, cy + (h - .5) * 30, cx + 14, cy - (h - .5) * 20); c.stroke();
    if (h > .7) { c.fillStyle = `rgba(200,${120 + 60 * Math.sin(tnow() * 2 + h * 9)},90,.5)`; circle(c, cx + (h - .8) * 30, cy - (h - .8) * 20, 2.5); c.fill(); }
  }
}
function drawHive(c, hv) {
  const cx = (hv.x + .5) * T, cy = (hv.y + .5) * T, r = 20 + hv.pop * 2.2, t = tnow();
  const pulse = 1 + .04 * Math.sin(t * 2 + hv.id);
  c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.ellipse(cx + 5, cy + 7, r * 1.1, r * .9, 0, 0, 2 * PI); c.fill();
  const g = c.createRadialGradient(cx - r * .3, cy - r * .3, 2, cx, cy, r * pulse);
  g.addColorStop(0, '#9a5a6a'); g.addColorStop(.6, '#5a2a44'); g.addColorStop(1, '#2a1424');
  c.fillStyle = g; c.beginPath();
  for (let k = 0; k <= 14; k++) { const a = k / 14 * 2 * PI, rr = r * pulse * (.82 + .18 * hash(hv.id, k, 40)); k ? c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * .85) : c.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * .85); }
  c.closePath(); c.fill(); c.strokeStyle = '#1a0a14'; c.lineWidth = 1.5; c.stroke();
  for (let k = 0; k < 5; k++) {
    const a = k / 5 * 2 * PI + hv.id, d = r * .45;
    const hx = cx + Math.cos(a) * d, hy = cy + Math.sin(a) * d * .8;
    c.fillStyle = '#12060e'; c.beginPath(); c.ellipse(hx, hy, 4.5, 3.5, a, 0, 2 * PI); c.fill();
    c.fillStyle = `rgba(255,${150 + 80 * Math.sin(t * 3 + k)},80,.35)`; circle(c, hx, hy, 2); c.fill();
  }
  const n = 3 + Math.round(hv.pop);
  for (let k = 0; k < n; k++) {
    const sp = .4 + hash(hv.id, k, 41) * .6, rad = r * (.9 + hash(hv.id, k, 42) * 1.2), a = t * sp * (k % 2 ? 1 : -1) + k;
    const bx = cx + Math.cos(a) * rad, by = cy + Math.sin(a) * rad * .8, dir = a + (k % 2 ? PI / 2 : -PI / 2);
    c.save(); c.translate(bx, by); c.rotate(dir);
    c.strokeStyle = '#1a0a14'; c.lineWidth = .8; const lg = Math.sin(t * 20 + k) * 1.5;
    for (const s of [-1, 1]) for (const o of [-2, 0, 2]) line(c, o, 0, o + lg * s, s * 4);
    c.fillStyle = '#3a1a2a'; c.beginPath(); c.ellipse(0, 0, 4, 2.4, 0, 0, 2 * PI); c.fill();
    c.fillStyle = '#6a3a4a'; circle(c, 3.5, 0, 1.6); c.fill();
    c.restore();
  }
}
// ---------------------------------------------------------------- rockets
function drawRocketStanding(c, p) {
  const cx = (p.x + 3) * T, cy = (p.y + 2.5) * T;
  const lox = (p.fin.lox || 0) / S.PAD_LOX, rp = (p.fin.rp1 || 0) / S.PAD_RP1;
  c.fillStyle = 'rgba(0,0,0,.3)'; c.beginPath(); c.ellipse(cx + 40, cy + 10, 60, 10, -.15, 0, 2 * PI); c.fill();
  const top = cy - 150, w = 22;
  const g = c.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0); g.addColorStop(0, '#bfc4c8'); g.addColorStop(.35, '#ffffff'); g.addColorStop(1, '#9aa0a6');
  c.fillStyle = g; c.fillRect(cx - w / 2, top + 26, w, 150 - 26);
  c.beginPath(); c.moveTo(cx - w / 2, top + 26); c.quadraticCurveTo(cx - w / 2, top, cx, top - 4); c.quadraticCurveTo(cx + w / 2, top, cx + w / 2, top + 26); c.fill();
  c.strokeStyle = '#4a5056'; c.lineWidth = 1; c.strokeRect(cx - w / 2, top + 26, w, 150 - 26);
  c.fillStyle = '#26282b'; c.fillRect(cx - w / 2, top + 60, w, 8);
  if (lox > .05) { c.fillStyle = `rgba(220,240,255,${.6 * lox})`; c.fillRect(cx - w / 2, top + 80, w, 40); const rnd = mulberry(p.x); c.fillStyle = 'rgba(255,255,255,.8)'; for (let k = 0; k < 20 * lox; k++) c.fillRect(cx - w / 2 + rnd() * w, top + 80 + rnd() * 40, 1.5, 1); }
  c.fillStyle = '#3a3e42'; for (const s of [-1, 1]) { c.beginPath(); c.moveTo(cx + s * w / 2, cy - 10); c.lineTo(cx + s * (w / 2 + 8), cy + 4); c.lineTo(cx + s * w / 2, cy + 2); c.fill(); }
  stencil(c, 'R', cx, top + 50, 9, '#c4362a');
  if (lox > .05 && Math.random() < .35 * lox && particles.length < 700) particles.push({ x: cx + w / 2, y: top + 82 + Math.random() * 30, vx: .3 + Math.random() * .3, vy: -.05, life: 0, max: 90, r: 4, k: 'steam' });
  if (rp > 0 || lox > 0) { c.strokeStyle = '#8e9396'; c.lineWidth = 3; line(c, cx + w / 2, top + 90, (p.x + 4.5) * T, top + 90); }
}
const rings = [];
function flightState(f, frac) {
  const p = Math.min(1, (f.t + frac) / f.dur), a = .18;
  const sx = f.x0 * T, sy = (f.y0 - .5) * T, tx = (f.tx + .5) * T, ty = (f.ty + .5) * T;
  const u = p < a ? 0 : smooth01((p - a) / (1 - a));
  const gx = sx + (tx - sx) * u, gy = sy + (ty - sy) * u;
  const hgt = p < a ? 420 * (p / a) * (p / a) : 420 * (1 - u) + 520 * Math.sin(PI * u);
  return [gx, gy, hgt, p];
}
function drawFlight(c, f, frac) {
  const [gx, gy, hgt] = flightState(f, frac), [gx2, gy2, h2] = flightState(f, frac + .5);
  const ang = Math.atan2((gy2 - h2) - (gy - hgt), gx2 - gx) + PI / 2;
  c.fillStyle = `rgba(0,0,0,${Math.max(.05, .35 - hgt / 2000)})`; c.beginPath(); c.ellipse(gx, gy, 10, 4, 0, 0, 2 * PI); c.fill();
  const s = 1 + hgt / 900;
  c.save(); c.translate(gx, gy - hgt); c.rotate(ang); c.scale(s, s);
  plume(c, 0, 26, 50, 9, 1);
  c.fillStyle = '#f4f4f2'; c.fillRect(-5, -26, 10, 52); c.beginPath(); c.moveTo(-5, -26); c.quadraticCurveTo(-5, -36, 0, -38); c.quadraticCurveTo(5, -36, 5, -26); c.fill();
  c.fillStyle = '#26282b'; c.fillRect(-5, -10, 10, 3);
  c.restore();
  if (particles.length < 800) for (let k = 0; k < 2; k++) particles.push({ x: gx - Math.sin(ang) * 0 + (Math.random() - .5) * 6, y: gy - hgt + 30 * s, vx: (Math.random() - .5) * .3, vy: .1, life: 0, max: 120, r: 5 + Math.random() * 4, k: 'steam' });
}

// =====================================================================
//  helpers / DOM
// =====================================================================
const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString('en-US');
const money = n => (n < 0 ? '−$' : '$') + (Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e4 ? (Math.abs(n) / 1e3).toFixed(1) + 'k' : fmt(Math.abs(n)));
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const num = n => Number.isInteger(n) ? n : n.toFixed(1);
const iname = k => ITEMS[k] ? ITEMS[k].n : FLUIDS[k] ? FLUIDS[k].n : k;
const REACH = 10;
const MATN = { concrete: 'concrete', alu: 'extrusions', kit: 'kits' };
const costTxt = t => { const c = costOf(t), ks = Object.keys(c).filter(k => c[k] > 0); return ks.length ? ks.map(k => `<span class="cost"><img src="${sprSrc(k)}">${c[k]}</span>`).join('') : '<span class="dim">free</span>'; };
const shortTxt = sh => sh.map(k => ITEMS[k].n.toLowerCase()).join(', ');
const WALK = new Set(['belt', 'road']);
const cv = $('c'), c = cv.getContext('2d');
let dpr = 1, vw = 0, vh = 0;
function resize() { dpr = devicePixelRatio || 1; vw = innerWidth; vh = innerHeight; cv.width = vw * dpr; cv.height = vh * dpr; cv.style.width = vw + 'px'; cv.style.height = vh + 'px'; }
addEventListener('resize', resize); resize();
const cam = { x: S.SPAWN.x * T, y: S.SPAWN.y * T, z: 1.1 };
const s2w = (sx, sy) => ({ x: (sx - vw / 2) / cam.z + cam.x, y: (sy - vh / 2) / cam.z + cam.y });

// =====================================================================
//  players
// =====================================================================
const me = { id: 0, name: 'Engineer', col: '#f0c419', x: S.SPAWN.x + .5, y: S.SPAWN.y + .5, ang: 0, walk: 0, moving: false, buildT: 0, aim: 0, hp: 100, hurtT: 0 };
const others = new Map();
const roster = new Map();
const SWATCH = ['#f0c419', '#e2483a', '#3e9fbd', '#62c25a', '#c86ad8', '#f08a24', '#e8e8e8', '#4a6ad8'];

// =====================================================================
//  network / lockstep
// =====================================================================
let dbgMine = null, resyncs = [];
let ws = null, online = false, joined = false, upto = 0, queue = [], sumMap = new Map(), simAcc = 0, waitingSnap = false, lastPos = 0;
function cmd(o) {
  if (online) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'cmd', c: o })); }
  else queue.push([S.tick + 1, me.id, o]);
}
function simStep() {
  const tk = S.tick + 1;
  while (queue.length && queue[0][0] <= tk) { const [t, pid, o] = queue.shift(); if (t === tk) S.applyCmd(pid, o); }
  S.step();
  const want = sumMap.get(S.tick);
  if (want !== undefined) {
    sumMap.delete(S.tick);
    if (S.checksum() !== want && !waitingSnap) {
      waitingSnap = true; dbgMine = { at: S.tick, snap: JSON.parse(JSON.stringify(S.serialize())) };
      ws.send(JSON.stringify({ t: 'resync', at: S.tick }));
      const now = performance.now(); resyncs = resyncs.filter(t => now - t < 120000); resyncs.push(now);
      if (resyncs.length >= 3) feed('Network: resynchronising often — check the console for what diverged.', 'sys');   // otherwise silent
    }
  }
}
function loadSnap(snap) {
  S.load(snap); upto = Math.max(upto, S.tick);
  queue = queue.filter(q => q[0] > S.tick);
  for (const k of [...sumMap.keys()]) if (k <= S.tick) sumMap.delete(k);
  syncTerrain(); waitingSnap = false;
}
function connect() {
  if (!/^https?:/.test(location.protocol)) { setNetStatus('offline'); return; }
  let settled = false;
  try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
  catch (e) { setNetStatus('offline'); return; }
  const to = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch (e) {} setNetStatus('offline'); } }, 3000);
  ws.onopen = () => { if (settled) return; settled = true; clearTimeout(to); setNetStatus('online'); };
  ws.onerror = () => { if (!settled) { settled = true; clearTimeout(to); setNetStatus('offline'); } };
  ws.onclose = () => { if (online && joined) { feed('Disconnected from server. Reload to rejoin.', 'bad'); online = false; joined = false; showJoin(true, 'Connection lost. Reload the page to rejoin.'); } };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'welcome':
        me.id = m.id; loadSnap(m.snap); me.x = m.you[0]; me.y = m.you[1]; cam.x = me.x * T; cam.y = me.y * T;
        for (const p of m.players) roster.set(p.id, p);
        for (const [id, x, y, d] of m.pos) others.set(id, { x, y, tx: x, ty: y, ang: d, walk: 0, moving: false, buildT: 0, aim: 0 });
        joined = true; online = true; renderPlayers();
        feed(`Joined as <b style="color:${me.col}">${esc(me.name)}</b>. WASD to walk, build within ${REACH} tiles.`, 'sys');
        break;
      case 'b':
        if (!joined) return;
        for (const q of m.cmds) if (q[0] > S.tick) queue.push(q);
        for (const [tk, h] of m.sums) if (tk > S.tick) sumMap.set(tk, h);
        upto = m.upto; break;
      case 'snap':
        if (m.dbg && dbgMine && dbgMine.at === m.dbgAt) {   // report exactly which state diverged
          const diffs = [], walk = (a, b, p) => { if (diffs.length > 25) return; if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], p + '.' + k); } else if (a !== b) diffs.push(p + ': mine=' + JSON.stringify(a) + ' server=' + JSON.stringify(b)); };
          walk(dbgMine.snap, JSON.parse(m.dbg), 'snap'); console.warn('[desync] tick', m.dbgAt, diffs);
        }
        dbgMine = null; loadSnap(m.snap); break;
      case 'pl':
        roster.clear(); for (const p of m.list) roster.set(p.id, p);
        for (const id of [...others.keys()]) if (!roster.has(id)) others.delete(id);
        renderPlayers(); break;
      case 'pos': {
        if (m.id === me.id) return;
        let o = others.get(m.id); if (!o) { o = { x: m.x, y: m.y, ang: 0, walk: 0, buildT: 0, aim: 0 }; others.set(m.id, o); }
        o.tx = m.x; o.ty = m.y; o.ang = m.d; o.moving = m.m; o.cx = m.cx; o.cy = m.cy; o.tool = m.b; break;
      }
      case 'leave': others.delete(m.id); break;
      case 'chat': {
        const p = roster.get(m.id);
        feed(m.id ? `<b style="color:${p ? p.col : '#ccc'}">${esc(p ? p.name : '?')}:</b> ${esc(m.text)}` : esc(m.text), m.id ? 'chat' : 'sys', m.id ? 15000 : 6000);
        break;
      }
    }
  };
}
let netState = 'connecting';
function setNetStatus(s) {
  netState = s;
  $('joinStatus').innerHTML = s === 'online' ? '<span class="good">●</span> Connected to server — multiplayer' :
    s === 'offline' ? '<span class="warn">●</span> No server — single-player. Host with <code>node server.js</code> to play together.' : 'Connecting…';
  $('joinBtn').disabled = s === 'connecting';
}
function startGame() {
  me.name = ($('joinName').value || 'Engineer').trim().slice(0, 16) || 'Engineer';
  try { localStorage.setItem('rw-name', me.name); localStorage.setItem('rw-col', me.col); } catch (e) {}
  showJoin(false);
  if (netState === 'online') ws.send(JSON.stringify({ t: 'hello', name: me.name, col: me.col }));
  else {
    online = false; joined = true; me.id = 1;
    let loaded = false;
    try { const s = localStorage.getItem('rw-save'); const snap = s && JSON.parse(s); if (snap && snap.v === 6) { loadSnap(snap); loaded = true; } } catch (e) {}
    if (!loaded) { S.newWorld((Math.random() * 2 ** 31) | 0); syncTerrain(); }
    if (!ents.length) S.place('substation', S.SPAWN.x - 4, S.SPAWN.y - 4, 0, true);
    me.x = S.SPAWN.x + .5; me.y = S.SPAWN.y + .5; cam.x = me.x * T; cam.y = me.y * T;
    roster.set(1, { id: 1, name: me.name, col: me.col }); renderPlayers();
    feed('Single-player. Progress autosaves in this browser.', 'sys');
    setInterval(() => { try { localStorage.setItem('rw-save', JSON.stringify(S.serialize())); } catch (e) {} }, 30000);
  }
  setTimeout(() => feed('Press <kbd>H</kbd> for the process guide. Bug colonies are creeping in from the east.', 'sys', 9000), 800);
}
function showJoin(v, msg) { $('join').style.display = v ? 'flex' : 'none'; if (msg) $('joinStatus').textContent = msg; }

// =====================================================================
//  sim hooks → client effects
// =====================================================================
const beams = [];
const avatarOf = pid => pid === me.id ? me : others.get(pid);
S.hooks.onStrip = i => onChunkOf(i % W, i / W | 0, () => stripTile(i));
S.hooks.onDeplete = i => { if (S.oreInit[i] !== 'oil') onChunkOf(i % W, i / W | 0, () => depleteTile(i % W, i / W | 0)); };
S.hooks.onCmd = (pid, o) => {
  if (o.k === 'shoot') { const a = avatarOf(pid); if (a) { a.buildT = .2; const b = bugs.find(b => b.id === o.id); const tx = b ? b.x * T : a.x * T, ty = b ? b.y * T : a.y * T; a.aim = Math.atan2(ty - a.y * T, tx - a.x * T); a.ang = a.aim; tracers.push({ x0: a.x * T, y0: a.y * T, x1: tx, y1: ty, t: .12 }); } return; }
  if (!['place', 'remove', 'rotate', 'truck', 'signal', 'setdir'].includes(o.k)) return;
  const a = avatarOf(pid); if (!a) return;
  const p = roster.get(pid), tx = (o.x + .5) * T, ty = (o.y + .5) * T;
  a.buildT = .35; a.aim = Math.atan2(ty - a.y * T, tx - a.x * T);
  beams.push({ x0: a.x * T, y0: a.y * T, x1: tx, y1: ty, t: .35, col: p ? p.col : '#fff' });
};
let infestCool = 0, raidCool = -1e9;
const splats = [], tracers = [];
S.hooks.onEvent = (k, d) => {
  switch (k) {
    case 'nomats': if (d.pid === me.id) feed(`Not enough ${shortTxt(d.short)} in site stores for ${esc(DEFS[d.type].n)}.`, 'bad'); break;
    case 'truckblock': if (d.pid === me.id) feed('A truck is on that road tile.', 'bad'); break;
    case 'notjunction': if (d.pid === me.id) feed('Signals go on junctions (3+ connecting roads).', 'bad'); break;
    case 'frozen': feed(`A reduction cell <b>froze solid</b> at (${d.x}, ${d.y}). Its cathode is ruined.`, 'bad', 10000); break;
    case 'enginefail': feed('Engine <b>failed hot-fire</b> acceptance and was scrapped.', 'bad'); burst((d.x + 2) * T, (d.y + 3) * T, 30, 'smoke'); break;
    case 'rollout': feed('Launch vehicle rolled out to the pad.', 'good'); break;
    case 'launch': feed(`<b>Liftoff!</b> Rocket away toward (${d.tx}, ${d.ty}).`, 'good', 8000); burst(d.x * T, (d.y - .5) * T, 60, 'steam'); break;
    case 'impact':
      feed(d.kills ? `Impact — <b>${d.kills} hive${d.kills > 1 ? 's' : ''} destroyed</b>. Contract bounty paid.` : 'Impact — no hives in the blast radius.', d.kills ? 'good' : 'warn', 8000);
      burst((d.x + .5) * T, (d.y + .5) * T, 90, 'fire'); rings.push({ x: (d.x + .5) * T, y: (d.y + .5) * T, t: 0 }); break;
    case 'hive': feed(`A new bug colony budded at (${d.x}, ${d.y}).`, 'warn'); break;
    case 'raid': if (performance.now() - raidCool > 20000) { raidCool = performance.now(); feed(`<b>Raid!</b> ${d.n} bugs left a colony at (${d.x}, ${d.y}), heading for (${d.tx}, ${d.ty}).`, 'bad', 9000); } break;
    case 'destroyed': feed(`Bugs destroyed a ${esc(DEFS[d.type] ? DEFS[d.type].n : d.type)} at (${d.x}, ${d.y}).`, 'bad', 8000); burst((d.x + 1) * T, (d.y + 1) * T, 40, 'smoke'); break;
    case 'bugdie': splats.push({ x: d.x * T, y: d.y * T, t: 0, r: hash(d.x * 9 | 0, d.y * 9 | 0, 3) * 6 }); if (splats.length > 200) splats.shift(); break;
    case 'infested': if (infestCool <= 0) { feed(`Bugs have overrun a ${esc(DEFS[d.type] ? DEFS[d.type].n : d.type)} at (${d.x}, ${d.y}).`, 'bad'); infestCool = 10; } break;
  }
};
function burst(x, y, n, k) {
  for (let i = 0; i < n && particles.length < 900; i++) {
    const a = Math.random() * 2 * PI, v = Math.random() * (k === 'fire' ? 3 : 1.2);
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - .2, life: 0, max: 60 + Math.random() * 80, r: 4 + Math.random() * 8, k });
  }
}

// =====================================================================
//  input
// =====================================================================
let mx = vw / 2, my = vh / 2, lmb = false, rmb = false, tool = null, rot = 0, overUI = false, cat = 0, targeting = null;
let dragSent = new Set(), lastDrag = null, sel = null;
const keys = {};
const curTile = () => { const w = s2w(mx, my); return [Math.floor(w.x / T), Math.floor(w.y / T)]; };
function anchorFor(type, tx, ty, dir) { const [fw, fh] = fp(type, dir); return [tx - ((fw - 1) >> 1), ty - ((fh - 1) >> 1)]; }
function inReach(x, y, w = 1, h = 1) {
  const nx = Math.max(x, Math.min(x + w, me.x)), ny = Math.max(y, Math.min(y + h, me.y));
  return Math.hypot(nx - me.x, ny - me.y) <= REACH;
}
const typing = () => document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
function truckAt(wx, wy) { let best = null, bd = 26 * 26; for (const t of trucks) { if (t._x === undefined) continue; const d = (t._x - wx) ** 2 + (t._y - wy) ** 2; if (d < bd) { bd = d; best = t; } } return best; }
function hiveAt(tx, ty) { return hives.find(h => Math.abs(h.x - tx) <= 1 && Math.abs(h.y - ty) <= 1); }

cv.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; if (lmb || rmb) act(); });
document.addEventListener('mousemove', e => { overUI = e.target !== cv; if (overUI) { mx = e.clientX; my = e.clientY; } });
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('mousedown', e => {
  if (!joined) return;
  mx = e.clientX; my = e.clientY; overUI = false;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (e.button === 0) {
    if (targeting) { const [tx, ty] = curTile(); cmd({ k: 'launch', x: targeting.x, y: targeting.y, tx, ty }); targeting = null; return; }
    if (!tool && myExc()) { const [tx, ty] = curTile(); cmd({ k: 'digat', i: tx + ty * W }); return; }
    if (!tool) { inspectAt(); return; }
    lmb = true; dragSent = new Set(); lastDrag = null;
    if (tool === 'truck' || tool === 'signal') { const [tx, ty] = curTile(); if (inReach(tx, ty)) cmd({ k: tool, x: tx, y: ty }); else outOfReach(); lmb = false; return; }
    act();
  } else if (e.button === 2) { if (targeting) { targeting = null; return; } rmb = true; dragSent = new Set(); act(); }
});
addEventListener('mouseup', e => { if (e.button === 0) lmb = false; if (e.button === 2) rmb = false; });
cv.addEventListener('wheel', e => { e.preventDefault(); cam.z = Math.max(.35, Math.min(2.6, cam.z * Math.exp(-e.deltaY * .0015))); }, { passive: false });
let reachWarn = 0;
function outOfReach() { if (performance.now() - reachWarn > 1500) { reachWarn = performance.now(); feed('Too far away — walk closer to build.', 'warn', 2500); } }
function act() {
  const [tx, ty] = curTile();
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return;
  if (rmb) {
    const e = get(tx, ty); if (!e) return;
    const k = e.x + ',' + e.y; if (dragSent.has(k)) return; dragSent.add(k);
    const [fw, fh] = fp(e.type, e.dir);
    if (!inReach(e.x, e.y, fw, fh)) { outOfReach(); return; }
    cmd({ k: 'remove', x: tx, y: ty }); return;
  }
  if (!lmb || !tool) return;
  if (DRAGT.has(tool) && lastDrag && (lastDrag[0] !== tx || lastDrag[1] !== ty)) {
    let [cx, cy] = lastDrag, guard = 0;
    while ((cx !== tx || cy !== ty) && guard++ < 300) {
      if (Math.abs(tx - cx) >= Math.abs(ty - cy)) cx += Math.sign(tx - cx); else cy += Math.sign(ty - cy);
      placeAt(cx, cy);
    }
    return;
  }
  placeAt(tx, ty);
}
const DRAGT = new Set(['belt', 'pipe', 'road']);
function placeAt(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return;
  if (tool === 'belt' && lastDrag && (lastDrag[0] !== tx || lastDrag[1] !== ty)) {
    const dx = tx - lastDrag[0], dy = ty - lastDrag[1];
    if (Math.abs(dx) + Math.abs(dy) === 1) {
      const d = dx === 1 ? 1 : dx === -1 ? 3 : dy === 1 ? 2 : 0;
      rot = d;
      const pb = get(lastDrag[0], lastDrag[1]); if (pb && pb.type === 'belt' && pb.dir !== d) cmd({ k: 'setdir', x: lastDrag[0], y: lastDrag[1], dir: d });
    }
  }
  lastDrag = [tx, ty];
  const [ax, ay] = anchorFor(tool, tx, ty, rot), key = ax + ',' + ay;
  if (dragSent.has(key)) return; dragSent.add(key);
  const [fw, fh] = fp(tool, rot);
  const ex = get(tx, ty);
  if (tool === 'belt' && ex && ex.type === 'belt') { if (ex.dir !== rot) cmd({ k: 'setdir', x: tx, y: ty, dir: rot }); return; }
  if (!S.canPlace(tool, ax, ay, rot)) return;
  if (!inReach(ax, ay, fw, fh)) { outOfReach(); return; }
  if (!S.canAfford(costOf(tool))) { feed(`Not enough ${shortTxt(S.shortOf(costOf(tool)))} for ${DEFS[tool].n}.`, 'bad', 2500); return; }
  cmd({ k: 'place', type: tool, x: ax, y: ay, dir: rot });
}
function bugAt(wx, wy) { let best = null, bd = 18 * 18; for (const b of bugs) { const d = (b.x * T - wx) ** 2 + (b.y * T - wy) ** 2; if (d < bd) { bd = d; best = b; } } return best; }
let shootT = 0;
function shootAt(b) {
  if (performance.now() - shootT < 220) return true; shootT = performance.now();
  if ((b.x - me.x) ** 2 + (b.y - me.y) ** 2 > S.SHOOT_R * S.SHOOT_R) { feed('Out of range — get within 12 tiles.', 'warn', 2000); return true; }
  cmd({ k: 'shoot', id: b.id, px: +me.x.toFixed(2), py: +me.y.toFixed(2) }); return true;
}
function inspectAt() {
  const w = s2w(mx, my), [tx, ty] = curTile();
  const bg = bugAt(w.x, w.y); if (bg && shootAt(bg)) return;
  const t = truckAt(w.x, w.y); if (t) { sel = { kind: 'truck', id: t.id }; refreshInspect(true); return; }
  const h = hiveAt(tx, ty); if (h) { sel = { kind: 'hive', id: h.id }; refreshInspect(true); return; }
  const e = get(tx, ty);
  sel = e ? { kind: 'ent', x: e.x, y: e.y } : null; refreshInspect(true);
}
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (typing()) {
    if (k === 'enter' && document.activeElement === $('chatIn')) { const v = $('chatIn').value.trim(); if (v) { if (online) ws.send(JSON.stringify({ t: 'chat', text: v })); else feed(`<b style="color:${me.col}">${esc(me.name)}:</b> ${esc(v)}`, 'chat', 15000); } $('chatIn').value = ''; $('chatIn').blur(); $('chatWrap').classList.remove('on'); }
    else if (k === 'escape') { document.activeElement.blur(); $('chatWrap').classList.remove('on'); }
    else if (k === 'enter' && document.activeElement === $('joinName') && !$('joinBtn').disabled) startGame();
    return;
  }
  if (!joined) return;
  keys[k] = true;
  if (k === 'tab') { e.preventDefault(); cat = (cat + (e.shiftKey ? GROUPS.length - 1 : 1)) % GROUPS.length; buildBar(); }
  else if (k >= '1' && k <= '9') { const t = GROUPS[cat][1][+k - 1]; if (t) setTool(tool === t ? null : t); }
  else if (k === 'r' && myExc() && !tool) { const ex = myExc(); cmd({ k: 'rotate', x: ex.x, y: ex.y, d: e.shiftKey ? 3 : 1 }); }
  else if (k === 'r') { if (tool) rot = (rot + (e.shiftKey ? 3 : 1)) % 4; else { const [tx, ty] = curTile(); const en = get(tx, ty); if (en) { const [fw, fh] = fp(en.type, en.dir); if (inReach(en.x, en.y, fw, fh)) cmd({ k: 'rotate', x: tx, y: ty, d: e.shiftKey ? 3 : 1 }); else outOfReach(); } } updToolInfo(); }
  else if (k === 'q') { const [tx, ty] = curTile(); const en = get(tx, ty); if (en && DEFS[en.type] && !DEFS[en.type].tool) { const gi = GROUPS.findIndex(g => g[1].includes(en.type)); if (gi >= 0) cat = gi; buildBar(); setTool(en.type); rot = en.dir; } else setTool(null); }
  else if (k === 'escape') { if (targeting) targeting = null; else if (tool) setTool(null); else if (sel) { sel = null; refreshInspect(true); } else if (bp.open) toggleBP(false); else $('guide').classList.remove('on'); }
  else if (k === 'h') toggleGuide();
  else if (k === 'b') toggleBP();
  else if (k === 'e') toggleVehicle();
  else if (k === 'f') { if (myTruck()) cmd({ k: 'act' }); }
  else if (bp.open && (k === 'arrowright' || k === 'arrowleft')) { e.preventDefault(); bpAction(k === 'arrowright' ? 'next' : 'prev'); }
  else if (k === 'm') $('mini').classList.toggle('off');
  else if (k === 'enter') { e.preventDefault(); $('chatWrap').classList.add('on'); $('chatIn').focus(); }
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; lmb = rmb = false; });

// =====================================================================
//  player movement
// =====================================================================
function blockedAt(x, y) { const tx = Math.floor(x), ty = Math.floor(y); if (isWater(tx, ty)) return true; const e = get(tx, ty); return !!e && !WALK.has(e.type); }
function collide(x, y) { const r = .26; return blockedAt(x - r, y - r) || blockedAt(x + r, y - r) || blockedAt(x - r, y + r) || blockedAt(x + r, y + r); }
// ---- driving: E to get in/out, WASD to drive, F to tip/load, click to pick the dig face
const myTruck = () => trucks.find(t => t.drv === me.id), myExc = () => ents.find(e => e.drv === me.id);
const driving = id => trucks.some(t => t.drv === id) || ents.some(e => e.drv === id);
let drvSent = '';
function vehPos(v) { return v.mx !== undefined && v.man ? [v.mx, v.my] : v.type === 'excavator' ? [v.x + 1.5, v.y + 1.5] : [(v._x || 0) / T, (v._y || 0) / T]; }
function toggleVehicle() {
  if (myTruck() || myExc()) { cmd({ k: 'exit' }); return; }
  let best = null, bd = 2.6 * 2.6;
  for (const t of trucks) { if (t.drv) continue; const [x, y] = vehPos(t), d = (x - me.x) ** 2 + (y - me.y) ** 2; if (d < bd) { bd = d; best = { tr: t.id }; } }
  if (!best) for (const e of ents) { if (e.type !== 'excavator' || e.drv) continue; const d = (e.x + 1.5 - me.x) ** 2 + (e.y + 1.5 - me.y) ** 2; if (d < 3.2 * 3.2 && d < bd + 9) { best = { ex: e.x, ey: e.y }; break; } }
  if (best) cmd({ k: 'enter', ...best }); else feed('Walk up to a haul truck or excavator and press <kbd>E</kbd> to get in.', 'sys', 4000);
}
function driveInput() {
  const t = myTruck(), e = myExc();
  const up = keys.w || keys.arrowup, dn = keys.s || keys.arrowdown, lf = keys.a || keys.arrowleft, rt = keys.d || keys.arrowright;
  let o = null;
  if (t) o = { k: 'drive', th: (up ? 1 : 0) - (dn ? 1 : 0), st: (rt ? 1 : 0) - (lf ? 1 : 0) };
  else if (e) o = { k: 'drive', d: up ? 0 : rt ? 1 : dn ? 2 : lf ? 3 : -1 };
  const sig = o ? JSON.stringify(o) : '';
  if (sig && sig !== drvSent) cmd(o);
  drvSent = sig;
  const el = $('drive');
  if (!t && !e) { el.style.display = 'none'; return null; }
  el.style.display = 'block';
  el.innerHTML = t
    ? `<b>Ural-6×6 haul truck</b> · ${esc(t.status)} · ${Math.round(Math.abs(t.v || 0) * 60 * 3.6 * 4)} km/h<br><kbd>W</kbd>/<kbd>S</kbd> throttle · <kbd>A</kbd>/<kbd>D</kbd> steer · stop at a shovel's bay to be loaded · <kbd>F</kbd> tip into a hopper / load from a bin · <kbd>E</kbd> get out`
    : `<b>Excavator</b> · ${esc(e.status)}<br><kbd>WASD</kbd> crawl · click ore within 3 tiles to dig there · <kbd>R</kbd> turn the truck bay · <kbd>E</kbd> get out`;
  return t ? vehPos(t) : [e.x + 1.5, e.y + 1.5];
}
function movePlayer(dt) {
  const vp = driveInput();
  if (vp) { me.x = vp[0]; me.y = vp[1]; me.moving = false; me.hp = Math.min(100, me.hp + 8 * dt); return; }
  let ix = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0), iy = (keys.s || keys.arrowdown ? 1 : 0) - (keys.w || keys.arrowup ? 1 : 0);
  const stuck = collide(me.x, me.y);
  me.moving = !!(ix || iy);
  if (me.moving) {
    const l = Math.hypot(ix, iy); ix /= l; iy /= l;
    const sp = (keys.shift ? 10 : 7) * dt;
    const nx = me.x + ix * sp, ny = me.y + iy * sp;
    if (stuck || !collide(nx, me.y)) me.x = nx;
    if (stuck || !collide(me.x, ny)) me.y = ny;
    me.ang = angLerp(me.ang, Math.atan2(iy, ix), Math.min(1, dt * 14));
    me.walk += dt * 11;
  }
  const b = get(Math.floor(me.x), Math.floor(me.y));
  if (b && b.type === 'belt' && !b.infested) { const nx = me.x + DX[b.dir] * 1.9 * dt, ny = me.y + DY[b.dir] * 1.9 * dt; if (!collide(nx, ny)) { me.x = nx; me.y = ny; } }
  me.x = Math.max(.3, Math.min(W - .3, me.x)); me.y = Math.max(.3, Math.min(H - .3, me.y));
  me.buildT = Math.max(0, me.buildT - dt);
  let bitten = 0; for (const b of bugs) if ((b.x - me.x) ** 2 + (b.y - me.y) ** 2 < .8) bitten++;
  if (bitten) { me.hp -= 18 * bitten * dt; me.hurtT = performance.now(); }
  else if (performance.now() - me.hurtT > 3000) me.hp = Math.min(100, me.hp + 8 * dt);
  if (me.hp <= 0) { me.hp = 100; me.x = S.SPAWN.x + .5; me.y = S.SPAWN.y + .5; feed('You were <b>overrun by bugs</b> and evacuated to base.', 'bad', 8000); burst(me.x * T, me.y * T, 10, 'smoke'); }
  for (const o of others.values()) {
    const k = Math.min(1, dt * 12); o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k;
    if (o.moving) o.walk += dt * 11; o.buildT = Math.max(0, o.buildT - dt);
  }
  const now = performance.now();
  if (online && joined && now - lastPos > 66) {
    lastPos = now; const [cx, cy] = curTile();
    ws.send(JSON.stringify({ t: 'pos', x: +me.x.toFixed(3), y: +me.y.toFixed(3), d: +me.ang.toFixed(2), m: me.moving, cx, cy, b: tool ? 1 : 0 }));
  }
}
function drawPlayer(c, p, col, name) {
  // a slender gray humanoid seen from above; the player colour is a band on the left arm
  const x = p.x * T, y = p.y * T, sw = p.moving ? Math.sin(p.walk) : 0;
  const SK = '#9a9ea3', SKD = '#6e7277', SKL = '#c2c6ca';
  c.fillStyle = 'rgba(0,0,0,.32)'; c.beginPath(); c.ellipse(x + 3, y + 4, 8, 6, 0, 0, 2 * PI); c.fill();
  c.save(); c.translate(x, y); c.rotate(p.ang);
  c.lineCap = 'round';
  // legs
  c.strokeStyle = SKD; c.lineWidth = 2.6;
  for (const s of [-1, 1]) line(c, -1, s * 2.6, sw * 6 * s - 1, s * 3.2);
  c.fillStyle = SKD; for (const s of [-1, 1]) { c.beginPath(); c.ellipse(sw * 6 * s - .5, s * 3.2, 2.2, 1.5, 0, 0, 2 * PI); c.fill(); }
  // arms: long and thin, three-fingered hands
  const build = p.buildT > 0;
  for (const s of [-1, 1]) {
    const ext = build && s === 1, ax = ext ? 13 : -sw * 5 * s + 1, ay = ext ? 6 : s * 9;
    c.strokeStyle = SK; c.lineWidth = 2.4; line(c, 0, s * 5.5, ax, ay);
    if (s === -1) { c.strokeStyle = col; c.lineWidth = 2.8; line(c, 0, s * 5.5, ax * .35, s * 5.5 + (ay - s * 5.5) * .35); }
    c.strokeStyle = SKD; c.lineWidth = 1;
    for (const f of [-1, 0, 1]) line(c, ax, ay, ax + 2.4, ay + f * 1.3);
    if (ext) { c.save(); c.shadowColor = '#9fe8ff'; c.shadowBlur = 6; c.fillStyle = '#c8f4ff'; circle(c, ax + 3.5, ay, 1.6); c.fill(); c.restore(); }
  }
  // torso
  const tg2 = c.createLinearGradient(0, -6, 0, 6); tg2.addColorStop(0, SKL); tg2.addColorStop(1, SKD);
  c.fillStyle = tg2; c.beginPath(); c.ellipse(-1, 0, 4.2, 6.2, 0, 0, 2 * PI); c.fill();
  c.strokeStyle = 'rgba(40,42,46,.6)'; c.lineWidth = .8; c.stroke();
  // big head, leaning forward, with large dark almond eyes on the facing side
  const hg = c.createRadialGradient(1, -2, 1, 2, 0, 7.5); hg.addColorStop(0, SKL); hg.addColorStop(1, SK);
  c.fillStyle = hg; c.beginPath(); c.ellipse(2, 0, 6.6, 6, 0, 0, 2 * PI); c.fill();
  c.strokeStyle = 'rgba(40,42,46,.7)'; c.lineWidth = .9; c.stroke();
  c.fillStyle = '#0c0d10';
  for (const s of [-1, 1]) { c.save(); c.translate(6, s * 2.6); c.rotate(s * .55); c.beginPath(); c.ellipse(0, 0, 2.4, 1.3, 0, 0, 2 * PI); c.fill(); c.restore(); }
  c.fillStyle = 'rgba(255,255,255,.55)'; for (const s of [-1, 1]) { circle(c, 6.9, s * 2.4, .45); c.fill(); }
  // black combat helmet with a headlamp on top
  c.fillStyle = 'rgba(0,0,0,.3)'; c.beginPath(); c.ellipse(.2, .8, 7.4, 7.1, 0, 0, 2 * PI); c.fill();
  c.fillStyle = '#0d0e10'; c.beginPath(); c.ellipse(-.6, 0, 7.4, 7.1, 0, 0, 2 * PI); c.fill();
  const hm = c.createRadialGradient(-2.4, -2.2, .4, -.6, 0, 6.6); hm.addColorStop(0, '#4a4e56'); hm.addColorStop(.45, '#24272c'); hm.addColorStop(1, '#141518');
  c.fillStyle = hm; c.beginPath(); c.ellipse(-.6, 0, 6.4, 6.1, 0, 0, 2 * PI); c.fill();
  c.strokeStyle = '#000'; c.lineWidth = 1.1; c.beginPath(); c.ellipse(-.6, 0, 7.4, 7.1, 0, 0, 2 * PI); c.stroke();
  c.strokeStyle = 'rgba(200,210,230,.22)'; c.lineWidth = 1; c.beginPath(); c.arc(-.6, 0, 5.2, PI * 1.05, PI * 1.55); c.stroke();
  // lamp: strap, housing, lens and a soft beam ahead
  c.fillStyle = '#2a2c30'; c.fillRect(-1, -1.6, 4.5, 3.2);
  c.fillStyle = '#5a5e66'; rrect(c, 2.5, -2.2, 3.4, 4.4, 1); c.fill(); c.strokeStyle = '#000'; c.lineWidth = .6; c.stroke();
  c.save(); c.shadowColor = '#fff6c8'; c.shadowBlur = 6; c.fillStyle = '#fffbe0'; c.fillRect(5.4, -1.5, 1.2, 3); c.restore();
  const bm = c.createLinearGradient(6, 0, 34, 0); bm.addColorStop(0, 'rgba(255,248,200,.32)'); bm.addColorStop(1, 'rgba(255,248,200,0)');
  c.fillStyle = bm; c.beginPath(); c.moveTo(6.5, -1.5); c.lineTo(34, -9); c.lineTo(34, 9); c.lineTo(6.5, 1.5); c.closePath(); c.fill();
  c.restore();
}
function drawNameTag(c, p, col, name) {
  const x = p.x * T, y = p.y * T;
  c.save(); c.translate(x, y - 18); const k = 1 / Math.max(.8, cam.z); c.scale(k, k);
  c.font = '600 11px ui-sans-serif,system-ui,sans-serif'; c.textAlign = 'center';
  const tw = c.measureText(name).width + 10;
  c.fillStyle = 'rgba(14,12,10,.6)'; rrect(c, -tw / 2, -11, tw, 15, 4); c.fill();
  c.fillStyle = col; c.fillRect(-tw / 2, 2, tw, 2);
  c.fillStyle = '#f3e6cf'; c.fillText(name, 0, 0);
  c.restore();
}

// =====================================================================
//  UI: HUD, build bar, inspector, feed, minimap, guide
// =====================================================================
function feed(html, cls = '', ms = 7000) {
  const d = document.createElement('div'); d.className = 'fl ' + cls; d.innerHTML = html; $('feed').appendChild(d);
  while ($('feed').children.length > 7) $('feed').firstChild.remove();
  setTimeout(() => { d.style.opacity = 0; setTimeout(() => d.remove(), 600); }, ms);
}
function renderPlayers() {
  $('players').innerHTML = [...roster.values()].map(p => `<span class="chip" title="${esc(p.name)}"><i style="background:${p.col}"></i>${esc(p.name)}${p.id === me.id ? ' (you)' : ''}</span>`).join('');
}
// ---- icons
const ICONS = {};
function iconFor(type) {
  if (ICONS[type]) return ICONS[type];
  const cnv = document.createElement('canvas'); cnv.width = cnv.height = 72; const g = cnv.getContext('2d'); g.scale(2, 2);
  const d = DEFS[type];
  if (type === 'belt') { g.translate(2, 2); drawBelts(g, [{ x: 0, y: 0, dir: 0, curve: -1, items: [] }], 0); }
  else if (type === 'pipe') { g.translate(2, 2); drawPipe(g, { x: 0, y: 0, type: 'pipe', con: [1, 0, 1, 0] }); }
  else if (type === 'ptg') { g.translate(2, 2); drawPipe(g, { x: 0, y: 0, type: 'ptg', dir: 0, con: [0, 0, 0, 0], under: true }); }
  else if (type === 'inserter') { g.translate(2, 2); const f = { x: 0, y: 0, dir: 0, a: .5, hand: null }; drawInserterBase(g, f); drawInserterArm(g, f); }
  else if (type === 'road') { g.fillStyle = '#8a7458'; g.fillRect(2, 2, 32, 32); g.strokeStyle = 'rgba(60,44,30,.5)'; g.lineWidth = 3; line(g, 11, 2, 11, 34); line(g, 25, 2, 25, 34); g.fillStyle = '#6a5640'; g.fillRect(2, 2, 3, 32); g.fillRect(31, 2, 3, 32); }
  else if (type === 'signal') { g.fillStyle = '#1b1d20'; rrect(g, 12, 4, 12, 28, 3); g.fill(); for (const [yy, col] of [[10, '#ff3a2a'], [18, '#ffb020'], [26, '#3aff6a']]) { g.fillStyle = col; circle(g, 18, yy, 3); g.fill(); } }
  else if (type === 'truck') { g.translate(18, 18); g.rotate(PI / 2); drawTruckShape(g, .5, 'bauxite', 0); }
  else {
    const s = 34 / (Math.max(d.w, d.h) * T); g.translate(18, 18); g.scale(s, s); g.translate(-d.w * T / 2, -d.h * T / 2);
    const f = S.makeEnt(type, 0, 0, 0); f.status = 'Idle'; DRAW[type](g, f); drawPortStubs(g, d);
  }
  return ICONS[type] = cnv;
}
// Soviet 6x6 truck seen from above: long bonnet, flat-glass cab, spare wheel, ribbed tipper body, three axles.
const URAL = { olive: '#56603f', oliveD: '#3b4229', oliveL: '#727d55', steel: '#4a4b45', tyre: '#151513' };
function drawUral(c, load, mat, tip, driver) {
  c.fillStyle = 'rgba(8,6,2,.4)'; c.fillRect(-11, -26, 30, 64);   // cast shadow (light from upper left)
  c.fillStyle = URAL.tyre; for (const y of [-21, 12, 23]) { c.fillRect(-15, y, 6, 10); c.fillRect(9, y, 6, 10); }
  c.fillStyle = '#2a2a26'; for (const y of [-21, 12, 23]) { c.fillRect(-15, y + 2, 6, 1); c.fillRect(-15, y + 6, 6, 1); c.fillRect(9, y + 2, 6, 1); c.fillRect(9, y + 6, 6, 1); }
  c.fillStyle = '#222'; c.fillRect(-8, -24, 16, 58);   // chassis
  // bonnet + grille + bumper
  c.fillStyle = URAL.oliveD; c.fillRect(-10, -30, 20, 3);
  c.fillStyle = URAL.olive; rrect(c, -9, -28, 18, 12, 3); c.fill();
  c.fillStyle = URAL.oliveL; c.fillRect(-7, -27, 14, 2); c.fillStyle = URAL.oliveD; c.fillRect(-1, -27, 2, 10);
  c.fillStyle = '#ffe9a0'; c.fillRect(-9, -30, 3, 2); c.fillRect(6, -30, 3, 2);
  c.fillStyle = '#c2c6be'; c.fillRect(-13, -16, 3, 2); c.fillRect(10, -16, 3, 2);   // mirrors
  // cab
  c.fillStyle = URAL.olive; c.fillRect(-11, -16, 22, 10);
  c.fillStyle = '#7fa4b6'; c.fillRect(-9, -16, 8, 3); c.fillRect(1, -16, 8, 3);
  c.fillStyle = URAL.oliveL; c.fillRect(-9, -12, 18, 5);
  c.fillStyle = '#b8262a'; circle(c, 0, -9.5, 1.6); c.fill();   // red star on the roof
  if (driver) { c.fillStyle = driver.col || '#fff'; c.fillRect(-9, -7, 18, 1.5); }
  c.fillStyle = URAL.tyre; circle(c, 0, -3, 4); c.fill(); c.fillStyle = URAL.steel; circle(c, 0, -3, 1.8); c.fill();   // spare wheel
  // tipper body, hinged at the rear
  c.save(); c.translate(0, 34); c.scale(1, 1 - tip * .18); c.translate(0, -34);
  c.fillStyle = URAL.oliveD; c.fillRect(-12, 1, 24, 34);
  c.fillStyle = tip > 0 ? '#677249' : URAL.olive; c.fillRect(-11, 2, 22, 32);
  c.fillStyle = URAL.oliveD; for (let y = 6; y < 34; y += 6) { c.fillRect(-12, y, 2, 2); c.fillRect(10, y, 2, 2); }
  c.fillStyle = '#2f3423'; c.fillRect(-9, 4, 18, 28);
  if (load > 0 && mat) heapFill(c, 0, 18, 4 + 8 * Math.sqrt(load), MATCOL[mat] || '#888');
  c.fillStyle = URAL.oliveL; c.fillRect(-11, 2, 22, 2); c.fillRect(-11, 2, 2, 32);
  c.restore();
}
function drawTruckShape(c, load, mat, tip) {
  c.scale(.74, .74); drawUral(c, load, mat, tip || 0, null);
}
function fmtRecipe(r) {
  const side = (it, fl) => [...Object.entries(it || {}).map(([k, v]) => `${num(v)}${BULK.has(k) ? ' t' : '×'} ${ITEMS[k].n}`), ...Object.entries(fl || {}).map(([k, v]) => `<span class="sw" style="background:${FLUIDS[k].col}"></span>${v} ${FLUIDS[k].n}`)].join(' + ');
  return `${side(r.i, r.fi) || '—'} → ${side(r.o, r.fo)} <span class="dim">(${r.t}s)</span>`;
}
function defHelp(t) {
  const d = DEFS[t];
  let h = `<b>${d.n}</b> — ${costTxt(t)}${d.power ? ` · ${d.power} MW` : ''}${d.cap ? ` · supplies ${d.cap} MW` : ''}<br><span class="dim">${d.desc}</span>`;
  for (const r of d.recipes || []) h += `<div class="rcp">${fmtRecipe(r)}</div>`;
  return h;
}
function buildBar() {
  $('tabs').innerHTML = GROUPS.map((g, i) => `<span class="tab${i === cat ? ' on' : ''}" data-cat="${i}">${g[0]}</span>`).join('') + '<span class="tabhint"><kbd>Tab</kbd></span>';
  const sl = $('slots'); sl.innerHTML = '';
  GROUPS[cat][1].forEach((t, i) => {
    const d = document.createElement('div'); d.className = 'slot' + (tool === t ? ' sel' : ''); d.dataset.t = t;
    d.appendChild(iconFor(t)); const k = document.createElement('span'); k.className = 'k'; k.textContent = i + 1; d.appendChild(k);
    d.onmouseenter = () => { $('slotTip').innerHTML = defHelp(t); $('slotTip').style.display = 'block'; };
    d.onmouseleave = () => { $('slotTip').style.display = 'none'; };
    d.onclick = () => setTool(tool === t ? null : t);
    sl.appendChild(d);
  });
}
$('tabs').addEventListener('click', e => { const i = e.target.dataset && e.target.dataset.cat; if (i !== undefined) { cat = +i; buildBar(); } });
function setTool(t) { tool = t; if (t) { sel = null; refreshInspect(true); } buildBar(); updToolInfo(); }
function updToolInfo() {
  if (!tool) { $('toolinfo').innerHTML = '<span class="dim">Click a building to inspect · <kbd>1-9</kbd> build · <kbd>H</kbd> guide</span>'; return; }
  const d = DEFS[tool], dirs = d.w > 1 || d.h > 1 || ['belt', 'inserter', 'feeder', 'ptg', 'pump'].includes(tool);
  const hint = ['belt', 'pipe', 'road'].includes(tool) ? 'drag to lay' : tool === 'truck' ? 'click a road' : tool === 'signal' ? 'click a junction' : 'click to place';
  $('toolinfo').innerHTML = `<b>${d.n}</b> ${costTxt(tool)} · ${hint}${dirs ? ` · <kbd>R</kbd> ${DIRN[rot]}` : ''} · <kbd>Esc</kbd>`;
}
// ---- HUD
let statsOpen = false;
$('hudMore').onclick = () => { statsOpen = !statsOpen; $('stats').classList.toggle('on', statsOpen); };
$('objQ').onclick = () => toggleGuide();
function updateHud() {
  for (const k of MATS) { const el = $('hm-' + k); el.textContent = fmt(stores[k] || 0); el.className = 'v' + ((stores[k] || 0) < 10 ? ' bad' : ''); }
  const p = power, short = p.demand > p.cap + 1e-6;
  $('hPow').textContent = `${p.used.toFixed(1)} / ${p.cap.toFixed(0)} MW`;
  $('hPowBar').style.width = (p.cap ? Math.min(100, p.demand / p.cap * 100) : (p.demand ? 100 : 0)) + '%';
  $('hPowBar').style.background = short ? '#e2483a' : p.fromGrid > 0 ? '#f2b431' : '#62c25a';
  if (statsOpen) {
    const st = stats, row = (k, v) => `<div class="row"><span>${k}</span><b>${v}</b></div>`;
    const inStore = Object.keys(stores).filter(k => stores[k] > 0 && ITEMS[k]);
    $('stats').innerHTML = '<div class="sec" style="margin-top:0;border:0">Site stores</div>' + (inStore.length ? inStore.map(k => row(`<img class="si" src="${sprSrc(k)}">${ITEMS[k].n}`, fmt(stores[k]))).join('') : '<div class="dim">empty</div>') + '<div class="sec">Production</div>' +
      row('Diesel burned', fmt(st.diesel || 0) + ' L') + row('Grid energy', fmt((st.gridMWs || 0) / 3600) + ' MWh') +
      row('Material hauled', fmt(st.hauled || 0) + ' t') + row('Alumina calcined', fmt((st.fmade.alumina || 0) / S.ALUMINA_PER_FEED) + ' t') + row('Metal tapped', fmt(st.made.crucible || 0) + ' t') +
      row('Ingots cast', fmt(st.made.ingot || 0)) + row('Crude produced', fmt(st.crude || 0)) + row('Engines passed / failed', `${st.made.engineok || 0} / ${st.enginefail || 0}`) +
      row('Rockets launched', st.launches || 0) + row('Hives destroyed', st.kills || 0) + row('Hives remaining', hives.length) + row('CO₂ emitted', fmt(st.co2) + ' t') +
      row('Pots frozen / AE', `${st.frozen} / ${st.ae}`) + row('Red mud stacked', fmt(st.mud) + ' t') + row('Game time', fmtTime(S.tick / 60));
  }
  const ac = [];
  if (p.demand > p.cap + 1e-6) ac.push(['r', `⚡ Power short ${p.demand.toFixed(1)}/${p.cap.toFixed(0)} MW`]);
  else if (p.fromGrid > 0) ac.push(['y', `⚡ Buying ${p.fromGrid.toFixed(1)} MW from grid`]);
  const fz = ents.filter(e => e.frozen).length; if (fz) ac.push(['r', `❄ ${fz} frozen cell${fz > 1 ? 's' : ''}`]);
  const cool = ents.filter(e => e.type === 'pot' && e.hot && !e.frozen && e.T < 930).length; if (cool) ac.push(['r', `🌡 ${cool} cell${cool > 1 ? 's' : ''} cooling`]);
  const inf = ents.filter(e => e.infested).length; if (inf) ac.push(['r', `🐛 ${inf} building${inf > 1 ? 's' : ''} infested`]);
  const lowM = MATS.filter(k => (stores[k] || 0) < 10); if (lowM.length) ac.push(['y', `▣ Low on ${lowM.map(k => MATN[k]).join(', ')}`]);
  const idle = trucks.filter(t => t.state === 'idle').length; if (idle && trucks.length) ac.push(['y', `🚚 ${idle} truck${idle > 1 ? 's' : ''} idle`]);
  if (bugs.length) ac.push(['r', `🐜 ${bugs.length} raider${bugs.length > 1 ? 's' : ''} on the move`]);
  if (S.tick < S.RAID_START) ac.push(['y', `⏳ Raids begin in ${Math.ceil((S.RAID_START - S.tick) / 3600)} min`]);
  if (hives.length) ac.push(['p', `☣ ${hives.length} hive${hives.length > 1 ? 's' : ''}`]);
  $('alerts').innerHTML = ac.map(([k, t]) => `<span class="al ${k}">${t}</span>`).join('');
  const i = OBJ.findIndex(o => !o[1]());
  $('objT').innerHTML = i < 0 ? '<span class="good">All objectives complete.</span>' : `<span class="dim">${i + 1}/${OBJ.length}</span> ${OBJ[i][0]}`;
}
const fmtTime = s => `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
const OBJ = [
  ['Lay a haul road <span class="dim">(Haulage tab)</span>', () => ents.some(e => e.type === 'road')],
  ['Put up tripod sentries (cheap) or turrets before raids start', () => ents.some(e => (e.type === 'turret' || e.type === 'sentry') && (e.rounds > 0 || (e.inb.ammo || 0) > 0))],
  ['Place an excavator at a bauxite face, arrow toward the road', () => ents.some(e => e.type === 'excavator')],
  ['Put a haul truck on the road', () => trucks.length > 0],
  ['Build a dump hopper and set it to Bauxite', () => ents.some(e => e.type === 'hopper' && e.mat === 'bauxite')],
  ['Haul 300 t', () => (stats.hauled || 0) >= 300],
  ['Requisition machinery kits at a supply depot into site stores', () => (stats.delivered.kit || 0) > 0],
  ['Grind bauxite to slurry (hopper → feeder → ball mill)', () => (stats.fmade.slurry || 0) > 0],
  ['Precipitate alumina hydrate', () => (stats.made.gibbsite || 0) >= 1],
  ['Calcine alumina', () => (stats.fmade.alumina || 0) >= 100],
  ['Tap molten aluminium from a reduction cell', () => (stats.made.crucible || 0) >= 1],
  ['Cast 20 ingot bundles', () => (stats.made.ingot || 0) >= 20],
  ['Press extrusions and cast concrete into site stores', () => (stats.delivered.alu || 0) > 0 && (stats.delivered.concrete || 0) > 0],
  ['Strike oil and run the crude unit', () => (stats.fmade.kerosene || 0) > 0],
  ['Produce RP-1 and liquid oxygen', () => (stats.fmade.rp1 || 0) > 0 && (stats.fmade.lox || 0) > 0],
  ['Weld an Al-Li tank section', () => (stats.made.tank || 0) >= 1],
  ['Pass an engine hot-fire test', () => (stats.made.engineok || 0) >= 1],
  ['Integrate a launch vehicle in the VAB', () => (stats.made.rocket || 0) >= 1],
  ['Launch at a bug colony', () => (stats.launches || 0) >= 1],
  ['Destroy a hive', () => (stats.kills || 0) >= 1],
  ['Eradicate every colony', () => hives.length === 0 && (stats.kills || 0) > 0],
];
// ---- inspector
const bar = (f, col = '#f0a945') => `<div class="prog"><i style="width:${Math.max(0, Math.min(100, f * 100))}%;background:${col}"></i></div>`;
const kv = (k, v, cls = '') => `<div class="row"><span>${k}</span><span class="v ${cls}">${v}</span></div>`;
const statusCls = s => !s ? '' : /^(Working|Operating|Pumping|Full load|Running|Feeding|Loading|GO|Being loaded|Tipping|→)/.test(s) ? 'good' : /(No power|Missing|FROZEN|ANODE|Infested|full|starved|No |exhausted|depleted|Insufficient|failed)/i.test(s) ? 'bad' : 'warn';
let inspHash = '';
function refreshInspect(force) {
  const box = $('inspect');
  if (!sel) { box.classList.remove('on'); inspHash = ''; return; }
  let html = '';
  if (sel.kind === 'truck') {
    const t = trucks.find(t => t.id === sel.id); if (!t) { sel = null; return refreshInspect(true); }
    html = `<h3>Haul truck #${t.id}<span class="x">×</span></h3><div class="b">` + kv('Status', esc(t.status), statusCls(t.status)) +
      kv('Payload', `${Math.round(t.load)} / ${TRUCK_CAP} t${t.mat ? ' ' + ITEMS[t.mat].n : ''}`) + bar(t.load / TRUCK_CAP, '#d9a22b') +
      (t.job ? kv('From', `${DEFS[t.job.src.type].n} (${t.job.src.x},${t.job.src.y})`) + kv('To', `${DEFS[t.job.sink.type].n} (${t.job.sink.x},${t.job.sink.y})`) + kv('Material', ITEMS[t.job.m].n) : kv('Job', 'none — waiting for dispatch', 'warn')) +
      `<div class="desc">Dispatched automatically: excavators, load-out bins and bulk imports → hoppers (matching filter) → residue area → residue area. Burns diesel by the tile.</div>` +
      `<div class="desc">${t.drv ? 'Being driven by ' + esc((roster.get(t.drv) || { name: 'someone' }).name) : 'Walk up to it and press <kbd>E</kbd> to drive it yourself.'}</div><button data-act="rmtruck" data-id="${t.id}">Scrap truck (all materials back)</button></div>`;
  } else if (sel.kind === 'hive') {
    const h = hives.find(h => h.id === sel.id); if (!h) { sel = null; feed('That hive is gone.', 'good'); return refreshInspect(true); }
    html = `<h3>Bug colony<span class="x">×</span></h3><div class="b">` + kv('Location', `${h.x}, ${h.y}`) + kv('Brood', `${h.pop.toFixed(1)} / 10`) + bar(h.pop / 10, '#c86ad8') +
      `<div class="desc">Colonies spread infestation that halts any building it reaches, and bud new colonies once the brood exceeds 7. Destroy them with rockets: ${S.BLAST_R}-tile blast.</div>` +
      padsList().map(p => `<button data-act="launch" data-x="${p.x}" data-y="${p.y}" data-tx="${h.x}" data-ty="${h.y}" ${S.padReady(p) ? '' : 'disabled'}>Strike from pad (${p.x},${p.y})${S.padReady(p) ? '' : ' — not ready'}</button>`).join('') + '</div>';
  } else {
    const e = get(sel.x, sel.y); if (!e) { sel = null; return refreshInspect(true); }
    html = entPanel(e);
  }
  if (!force && html === inspHash) return;
  inspHash = html; box.innerHTML = html; box.classList.add('on');
}
const padsList = () => ents.filter(e => e.type === 'pad');
function invList(o, lim, fluid) {
  const ks = Object.keys(o || {}).filter(k => (o[k] || 0) > 1e-6 || (lim && lim[k]));
  if (!ks.length) return '<span class="dim">—</span>';
  return ks.map(k => `<span class="inv">${fluid ? `<span class="sw" style="background:${FLUIDS[k].col}"></span>` : `<img src="${SPR[k] ? SPR[k].toDataURL() : ''}">`}${num(+(o[k] || 0).toFixed(1))}${lim && lim[k] ? '/' + num(lim[k]) : ''} <span class="dim">${iname(k)}</span></span>`).join('');
}
const sprURL = {}; const sprSrc = k => sprURL[k] || (sprURL[k] = SPR[k] ? SPR[k].toDataURL() : '');
function entPanel(e) {
  const d = DEFS[e.type];
  let h = `<h3>${d.n}<span class="x">×</span></h3><div class="b">`;
  if (e.status && e.type !== 'road') h += kv('Status', esc(e.status), statusCls(e.status));
  if (e.type === 'pipe' || e.type === 'ptg') {
    const n = e.net; h += n ? kv('Contents', n.fluid ? FLUIDS[n.fluid].n : 'empty') + kv('Network', `${num(+n.amt.toFixed(0))} / ${n.cap} units, ${n.pipes.length} pipes`) + bar(n.amt / n.cap, n.fluid ? FLUIDS[n.fluid].col : '#555') : '';
    if (e.type === 'ptg') h += kv('Paired', e.under ? 'yes' : 'no — needs a facing underground pipe ≤10 tiles', e.under ? 'good' : 'bad');
  } else if (e.type === 'belt') h += kv('Items', e.items.map(i => ITEMS[i.type].n).join(', ') || '—');
  else if (e.type === 'chest') h += kv('Stored', `${e.total} / ${S.CHEST_CAP}`) + `<div>${invList(e.inv)}</div>`;
  else if (e.type === 'road') {
    const i = e.x + e.y * W;
    h += kv('Type', S.isJunction(i) ? 'Junction' : 'Road') + (e.sig ? kv('Signal', e.sig.allred ? 'all red' : `${e.sig.green ? 'E-W' : 'N-S'} ${e.sig.amber ? 'amber' : 'green'}`) + kv('Waiting', `N-S ${e.sig.dem && e.sig.dem[0] ? 'yes' : 'no'} · E-W ${e.sig.dem && e.sig.dem[1] ? 'yes' : 'no'}`) : '') +
      `<div class="desc">${d.desc}</div>`;
  } else if (e.type === 'hopper' || e.type === 'bin') {
    h += kv('Holding', `${Math.round(e.stock)} / ${S.BIN_CAP} t ${e.mat ? ITEMS[e.mat].n : ''}`) + bar(e.stock / S.BIN_CAP, e.mat ? MATCOL[e.mat] : '#555');
    if (e.type === 'hopper') h += `<div class="sec">Accepts</div><div class="opts">` + [...BULK].map(m => `<button class="opt${e.mat === m ? ' on' : ''}" data-act="hopper" data-mat="${m}" ${e.stock >= 1 && e.mat !== m ? 'disabled' : ''}><img src="${sprSrc(m)}">${ITEMS[m].n}</button>`).join('') + '</div>' + (e.stock >= 1 ? '<div class="desc">Empty it before changing material.</div>' : '');
    h += `<div class="desc">${d.desc}</div>`;
  } else if (e.type === 'feeder') h += kv('Rate', `${(e.flow * 60).toFixed(1)} t/s`) + `<div class="desc">${d.desc}</div>`;
  else if (e.type === 'excavator') {
    const as = trucks.filter(t => t.job && t.job.src === e).length;
    h += (e.dig >= 0 ? kv('Face', `${ITEMS[oreType[e.dig]] ? ITEMS[oreType[e.dig]].n : '—'}: ${fmt(oreAmt[e.dig])} t`) + kv('Overburden', ob[e.dig] > 0 ? `${ob[e.dig].toFixed(0)} t to strip` : 'stripped') : '') + kv('Trucks assigned', `${as} / 3`) + `<div class="desc">${d.desc}</div>`;
  } else if (e.type === 'oilwell') {
    let r = 0; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const k = e.x + i + (e.y + j) * W; if (oreType[k] === 'oil') r += oreAmt[k]; }
    h += kv('Reservoir', fmt(r) + ' units') + `<div class="desc">${d.desc}</div>`;
  } else if (e.type === 'depot') {
    const share = ents.filter(o => o.type === 'depot' && o.sel === e.sel).length;
    h += kv('Allocation', `${num(+(ALLOC[e.sel] / share).toFixed(1))} ${BULK.has(e.sel) ? 't' : ''}/min${share > 1 ? ` <span class="dim">(shared by ${share} depots)</span>` : ''}`) +
      (BULK.has(e.sel) ? kv('Stockpile', `${Math.round(e.stock)} / ${S.BIN_CAP} t`) + bar(e.stock / S.BIN_CAP, MATCOL[e.sel]) : kv('In bay', `${e.outb[e.sel] || 0} / 3`)) +
      `<div class="sec">Requisition</div><div class="opts">` + IMPORTS.map(k => `<button class="opt${e.sel === k ? ' on' : ''}" data-act="depot" data-sel="${k}"><img src="${sprSrc(k)}">${ITEMS[k].n} <span class="dim">${ALLOC[k]}${BULK.has(k) ? ' t' : ''}/min</span></button>`).join('') + '</div><div class="desc">' + d.desc + '</div>';
  } else if (e.type === 'store') {
    h += `<div class="sec">Team stockpile</div>` + Object.keys(stores).filter(k => stores[k] > 0 && ITEMS[k]).map(k => kv(`<img class="si" src="${sprSrc(k)}">${ITEMS[k].n}`, fmt(stores[k]))).join('') + `<div class="desc">${d.desc}</div>`;
  } else if (e.type === 'residue') h += kv('Stored', `${fmt(e.fill)} / ${fmt(S.RESIDUE_CAP)} t`) + bar(e.fill / S.RESIDUE_CAP, '#8a2c16') + `<div class="desc">${d.desc}</div>`;
  else if (e.type === 'pad') {
    h += kv('Vehicle', e.rocket ? 'on pad' : 'none', e.rocket ? 'good' : 'warn') + kv('RP-1', `${Math.floor(e.fin.rp1 || 0)} / ${S.PAD_RP1}`) + bar((e.fin.rp1 || 0) / S.PAD_RP1, FLUIDS.rp1.col) +
      kv('LOX', `${Math.floor(e.fin.lox || 0)} / ${S.PAD_LOX}`) + bar((e.fin.lox || 0) / S.PAD_LOX, FLUIDS.lox.col) + kv('LOX boil-off', `${((e.boil || 0) * 60).toFixed(1)} /s`) +
      `<label class="chk"><input type="checkbox" data-act="padauto" ${e.auto ? 'checked' : ''}> Auto-strike nearest colony when ready</label>` +
      `<button data-act="target" ${S.padReady(e) ? '' : 'disabled'}>Choose target on map…</button>` +
      `<div class="sec">Colonies</div>` + hives.slice().sort((a, b) => dist2(a, e) - dist2(b, e)).slice(0, 6).map(hv => `<div class="row"><span>(${hv.x}, ${hv.y}) · ${Math.round(Math.sqrt(dist2(hv, e)))} tiles · brood ${hv.pop.toFixed(1)}</span><button class="mini" data-act="launch" data-x="${e.x}" data-y="${e.y}" data-tx="${hv.x}" data-ty="${hv.y}" ${S.padReady(e) ? '' : 'disabled'}>Strike</button></div>`).join('') +
      `<div class="desc">${d.desc}</div>`;
  } else if (e.type === 'pot') {
    const se = e.ce > 0 && e.volt > 0 ? 2.98 * e.volt / e.ce : 0;
    h += kv('Temperature', `${e.T.toFixed(0)} °C`, e.T < 930 && e.hot ? 'bad' : '') + bar((e.T - 25) / 975, e.T > 930 ? '#ff8a30' : '#7fd0ff') +
      kv('Dissolved alumina', `${e.al.toFixed(2)} %`, e.al < 1.5 ? 'warn' : '') + kv('Bath level', `${e.bath.toFixed(0)} %`) + kv('Excess AlF₃', `${e.xs.toFixed(1)} %`) +
      kv('Anode remaining', `${e.carbon.toFixed(0)} %`) + kv('Metal pad', `${e.metal.toFixed(2)} t`) + kv('Cell voltage', `${e.volt.toFixed(2)} V`, e.ae ? 'bad' : '') +
      kv('Current efficiency', `${(e.ce * 100).toFixed(1)} %`) + kv('Specific energy', se ? `${se.toFixed(1)} kWh/kg` : '—') +
      `<div class="sec">Feeds</div>` + kv('Inputs', invList(e.inb, d.ilim)) + kv('Alumina (pipe)', invList(e.fin, d.flim, true)) + kv('Output', invList(e.outb));
  } else if (e.type === 'powerplant') {
    h += kv('Output', `${(e.gen || 0).toFixed(1)} / ${d.cap} MW`) + bar((e.gen || 0) / d.cap, '#62c25a') + kv('Coal', invList(e.inb, d.ilim)) + kv('Water', invList(e.fin, d.flim, true)) + `<div class="desc">${d.desc}</div>`;
  } else if (e.type === 'substation' || e.type === 'pump') h += `<div class="desc">${d.desc}</div>`;
  else if (e.type === 'inserter') h += kv('Holding', e.hand ? ITEMS[e.hand].n : '—');
  else if (e.type === 'sentry') h += kv('Rounds', `${e.rounds}`) + bar(Math.min(1, e.rounds / 60), '#f2b431') + kv('Crates', `${e.inb.ammo || 0} / 2`) + kv('Range', `${S.SENTRY_R} tiles`) + kv('Rate', '80 rounds/min') + `<div class="desc">${d.desc}</div>`;
  else if (e.type === 'turret') h += kv('Rounds', `${e.rounds} / 40`) + bar(e.rounds / 40, '#f2b431') + kv('Crates', `${e.inb.ammo || 0} / 4`) + kv('Range', `${S.TURRET_R} tiles`) + `<div class="desc">${d.desc}</div>`;
  if (e.hp !== undefined) h += kv('Integrity', `${Math.round(e.hp)} / ${S.entHpMax(e)}`, 'bad') + bar(e.hp / S.entHpMax(e), '#e2483a');
  if (d.recipes) {
    if (e.prog !== undefined) h += bar(e.active ? e.prog : 0);
    h += `<div class="sec">Recipe</div>` + d.recipes.map(r => `<div class="rcp">${fmtRecipe(r)}</div>`).join('');
    if (Object.keys(d.ilim).length) h += kv('Inputs', invList(e.inb, d.ilim));
    if (Object.keys(d.flim).length) h += kv('Fluids in', invList(e.fin, d.flim, true));
    if (Object.keys(d.olim).length) h += kv('Output', invList(e.outb));
    if (Object.keys(d.folim).length) h += kv('Fluids out', invList(e.fout, null, true));
    if (d.power) h += kv('Power', `${d.power} MW`);
    h += `<div class="desc">${d.desc}</div>`;
  }
  return h + '</div>';
}
const dist2 = (h, e) => { const [fw, fh] = fp(e.type, e.dir); const dx = h.x - (e.x + fw / 2), dy = h.y - (e.y + fh / 2); return dx * dx + dy * dy; };
$('inspect').addEventListener('click', ev => {
  const b = ev.target.closest('[data-act], .x'); if (!b) return;
  if (b.classList.contains('x')) { sel = null; refreshInspect(true); return; }
  const a = b.dataset.act, e = sel && sel.kind === 'ent' ? get(sel.x, sel.y) : null;
  if (a === 'rmtruck') { cmd({ k: 'rmtruck', id: +b.dataset.id }); sel = null; }
  else if (a === 'hopper' && e) cmd({ k: 'hopper', x: e.x, y: e.y, mat: b.dataset.mat });
  else if (a === 'depot' && e) cmd({ k: 'depot', x: e.x, y: e.y, sel: b.dataset.sel });
  else if (a === 'padauto' && e) cmd({ k: 'padauto', x: e.x, y: e.y, on: b.checked });
  else if (a === 'target' && e) { targeting = { x: e.x, y: e.y }; feed('Click anywhere on the map (or minimap) to strike. Right-click / Esc cancels.', 'sys', 5000); }
  else if (a === 'launch') cmd({ k: 'launch', x: +b.dataset.x, y: +b.dataset.y, tx: +b.dataset.tx, ty: +b.dataset.ty });
  setTimeout(() => refreshInspect(true), 120);
});
// ---- hover label
function updateHover() {
  const hv = $('hover');
  if (overUI || !joined || tool) { hv.style.display = 'none'; return; }
  const w = s2w(mx, my), [tx, ty] = curTile();
  let txt = '';
  const t = truckAt(w.x, w.y), hi = hiveAt(tx, ty), e = get(tx, ty), bg = bugAt(w.x, w.y);
  if (bg && !targeting) txt = `<b>Raider bug</b> · ${bg.hp}/${S.BUG_HP} · click to shoot`;
  else if (targeting) txt = `<b>Strike (${tx}, ${ty})</b> · ${S.BLAST_R}-tile blast`;
  else if (t) txt = `<b>Haul truck</b> · <span class="${statusCls(t.status)}">${esc(t.status)}</span>`;
  else if (hi) txt = `<b>Bug colony</b> · brood ${hi.pop.toFixed(1)}`;
  else if (e) { const n = e.net; txt = `<b>${DEFS[e.type].n}</b>` + (n ? ` · ${n.fluid ? FLUIDS[n.fluid].n : 'empty'} ${Math.round(n.amt)}/${n.cap}` : e.status && e.type !== 'road' && !['belt'].includes(e.type) ? ` · <span class="${statusCls(e.status)}">${esc(e.status)}</span>` : ''); }
  else if (tx >= 0 && ty >= 0 && tx < W && ty < H) {
    const i = tx + ty * W;
    if (creep[i]) txt = 'Infested ground';
    else if (oreType[i]) txt = oreType[i] === 'oil' ? `Oil seep · ${fmt(oreAmt[i])} units` : `${ITEMS[oreType[i]].n} · ${fmt(oreAmt[i])} t${ob[i] > 0 ? ` · ${ob[i].toFixed(0)} t overburden` : ''}`;
  }
  if (!txt) { hv.style.display = 'none'; return; }
  hv.innerHTML = txt; hv.style.display = 'block'; hv.style.left = (mx + 16) + 'px'; hv.style.top = (my + 18) + 'px';
}
// ---- minimap
const mini = $('miniC'), mg = mini.getContext('2d'); mini.width = W; mini.height = H; mini.style.width = '260px'; mini.style.height = Math.round(260 * H / W) + 'px';
const miniBase = mg.createImageData(W, H);
function buildMiniBase() {
  const OC = { bauxite: [150, 60, 30], coal: [30, 30, 32], limestone: [200, 195, 180], oil: [10, 8, 6] };
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = i / W | 0, n = fbm(x / 7, y / 7, 1);
    let col = water[i] ? [34, 66, 76] : [82 + n * 30, 76 + n * 24, 50 + n * 14];
    if (oreType[i]) col = OC[oreType[i]];
    miniBase.data.set([col[0], col[1], col[2], 255], i * 4);
  }
}
function drawMini() {
  if ($('mini').classList.contains('off')) return;
  mg.putImageData(miniBase, 0, 0);
  mg.fillStyle = 'rgba(120,50,130,.85)'; for (let i = 0; i < W * H; i++) if (creep[i]) mg.fillRect(i % W, i / W | 0, 1, 1);
  for (const e of ents) { const [fw, fh] = fp(e.type, e.dir); mg.fillStyle = e.type === 'road' ? '#c8b48a' : e.type === 'belt' ? '#8a8070' : e.type === 'pipe' || e.type === 'ptg' ? '#6a8aa0' : e.infested ? '#c84a9a' : '#d8d0c0'; mg.fillRect(e.x, e.y, fw, fh); }
  mg.fillStyle = '#ff3a2a'; for (const h of hives) mg.fillRect(h.x - 1, h.y - 1, 3, 3);
  mg.fillStyle = '#ff9a40'; for (const b of bugs) mg.fillRect(b.x - .5, b.y - .5, 1.5, 1.5);
  mg.fillStyle = '#ffd040'; for (const t of trucks) mg.fillRect(t.tile % W, t.tile / W | 0, 1, 1);
  for (const [id, o] of others) { const p = roster.get(id); mg.fillStyle = p ? p.col : '#fff'; mg.fillRect(o.x - 1, o.y - 1, 3, 3); }
  mg.fillStyle = me.col; mg.fillRect(me.x - 1.5, me.y - 1.5, 3, 3);
  const a = s2w(0, 0), b = s2w(vw, vh); mg.strokeStyle = 'rgba(255,255,255,.8)'; mg.lineWidth = 1; mg.strokeRect(a.x / T, a.y / T, (b.x - a.x) / T, (b.y - a.y) / T);
}
mini.addEventListener('mousedown', e => {
  const r = mini.getBoundingClientRect(), tx = Math.floor((e.clientX - r.left) / r.width * W), ty = Math.floor((e.clientY - r.top) / r.height * H);
  if (targeting) { cmd({ k: 'launch', x: targeting.x, y: targeting.y, tx, ty }); targeting = null; }
});
// ---- guide
function toggleGuide() { $('guide').classList.toggle('on'); if ($('guide').classList.contains('on')) renderGuide(); }
function renderGuide() {
  $('guide').innerHTML = `<h3>Field manual<span class="x" onclick="document.getElementById('guide').classList.remove('on')">×</span></h3><div class="b">
<h4>You</h4><p>You are an engineer on foot. <kbd>WASD</kbd> walk (<kbd>Shift</kbd> to hurry), mouse wheel zoom. You can only build or demolish within ${REACH} tiles of yourself. Belts carry you; roads are walkable. <kbd>Tab</kbd> / <kbd>1-9</kbd> pick a building, <kbd>R</kbd> rotate, <kbd>Q</kbd> copy the hovered building, right-click demolish (full refund), click to inspect, <kbd>Enter</kbd> chat, <kbd>M</kbd> minimap.</p>
<h4>Materials, not money</h4><p>Nothing is bought or sold. Every building costs <b>precast concrete</b>, <b>aluminium extrusions</b> and <b>machinery kits</b> from the team's <b>site stores</b> (shown top-left); demolishing returns everything. Make concrete from limestone (cement kiln → batching plant), extrusions from your own ingots (extrusion press), and requisition kits at a <b>supply depot</b>. Inserting anything into a site stores building adds it to the stockpile. Depots deliver one allocation each at a fixed rate; several depots on the same item share it.</p>
<h4>1 · Mine and haul</h4><p>Bulk solids — bauxite, coal, limestone, coke, hydrate, red mud — move by <b>truck</b>, never by belt. An <b>excavator</b> strips overburden (it does this even with no truck), then loads 4 t/s into a truck waiting on the road at its arrow. The dispatcher sends trucks from excavators, <b>load-out bins</b> and bulk imports to <b>dump hoppers</b> with a matching material, then (red mud) to the residue area. An <b>apron feeder</b> moves 4 t/s from a hopper into a machine, or from a machine into a bin. Trucks keep right; junctions let one truck through at a time unless a <b>signal</b> runs them.</p>
<h4>2 · Bayer refinery</h4><div class="eq">Al(OH)₃ + NaOH → NaAl(OH)₄ (145 °C)</div><p>Caustic make-up tank → liquor → <b>ball mill</b> (bauxite by feeder) → slurry → <b>digester</b> (+ steam, lime bags) → <b>settler</b>: pregnant liquor + red mud underflow → <b>washer</b> (mud to bin → truck → residue) and <b>precipitator</b> (hydrate → feeder → bin → truck → hopper → <b>calciner</b>). Liquor goes back to the mill.</p><div class="eq">2 Al(OH)₃ → Al₂O₃ + 3 H₂O (1,050 °C)</div>
<h4>3 · Smelter</h4><div class="eq">2 Al₂O₃ + 3 C → 4 Al + 3 CO₂ (960 °C, 4.2 V)</div><p>Alumina travels by dense-phase pneumatic pipe from the calciner to each <b>reduction cell</b>. Inserters feed anodes, cryolite and AlF₃. Cells get first call on power; below 85 % they cool, and if one stays under 880 °C for 10 s it freezes for good. Crucibles → <b>casthouse</b> → ingots.</p>
<h4>4 · Oil and propellants</h4><p><b>Oil well</b> on a black seep → crude → <b>crude distillation unit</b> (+ steam) → naphtha, kerosene and vacuum residue. Residue goes to the <b>delayed coker</b>, which makes pet coke for your anodes. Naphtha + steam → <b>reformer</b> → H₂. Kerosene + H₂ → <b>hydrotreater</b> → <b>RP-1</b>. The <b>air separation unit</b> (6 MW!) makes <b>LOX</b>.</p>
<h4>5 · Rocketry</h4><p>Ingots + lithium → <b>Al-Li casting pit</b> → slab → <b>rolling mill</b> → plate → <b>friction-stir tank shop</b> → tank sections. Inconel → <b>turbomachinery cell</b> → turbopumps. Copper + Inconel → <b>thrust chamber shop</b>. Both → <b>engine assembly</b> → <b>test stand</b> (hot-fire with RP-1 + LOX; ~4 % fail). The <b>VAB</b> stacks 4 tanks, 4 flight engines, 2 avionics kits and an encapsulated payload. A <b>launch pad</b> beside it takes the rocket, loads ${S.PAD_RP1} RP-1 and ${S.PAD_LOX} LOX (LOX boils off — keep it topped up), then launches.</p>
<h4>6 · Bug colonies</h4><p>After about 10 minutes, colonies on the far eastern edge send <b>raiding swarms</b> at your nearest buildings and chew them to rubble — nothing is refunded. Start with cheap <b>tripod sentries</b> (Defence tab): no power needed, 60 rounds included, but they fire slowly and reach only 6 tiles. Move up to <b>autocannon turrets</b> (9 tiles, rapid fire, 0.2 MW). Keep both fed with ammunition crates from a supply depot. Click a bug to shoot it yourself (12-tile range); if they swarm you, you are evacuated to base. Hives in the east spread infestation that shuts down whatever it touches and blocks trucks. They bud new hives as they grow. Each rocket hits a ${S.BLAST_R}-tile radius, and clears the infestation around it.</p>
<h4>Objectives</h4>${OBJ.map(o => `<div class="obj${o[1]() ? ' done' : ''}"><span class="cb"></span><span>${o[0]}</span></div>`).join('')}</div>`;
}

// =====================================================================
//  process diagrams (abstract flowsheets, step by step)
// =====================================================================
// node: [id, type | '@Label:sprite', col, row, label?]   edge: [from, to, material, mode]
// modes: pipe (fluid), truck (bulk on haul trucks), feeder (apron feeder, bulk), ins (inserter / belt, unit loads), adj (adjacent), fly, dig
const CHAINS = [
  { name: 'Defence', blurb: 'Raids start about 10 minutes in. Get turrets up first.',
    nodes: [['hive', '@Bug colony:hive', 0, 1], ['dep', 'depot', 1.5, 0, 'Supply depot (ammo)'], ['sen', 'sentry', 2, 1.9], ['tur', 'turret', 2, 1], ['base', '@Your buildings:store', 3, 1]],
    edges: [['dep', 'tur', 'ammo', 'ins'], ['dep', 'sen', 'ammo', 'ins'], ['hive', 'tur', 'raiders', 'fly'], ['hive', 'sen', '', 'fly'], ['tur', 'base', 'covers 9 tiles', 'adj'], ['sen', 'base', '6 tiles', 'adj']],
    steps: [
      { t: 'Start cheap: ring the eastern side of the base with tripod sentries. They need no power and come with 60 rounds, but they fire slowly and reach only 6 tiles.', on: ['sen', 'base'], tool: 'sentry' },
      { t: 'Upgrade the main approaches to autocannon turrets: 9 tiles, rapid fire, 0.2 MW.', on: ['tur', 'base'], tool: 'turret' },
      { t: 'Supply depot set to Ammunition (20 crates/min), with an inserter into each sentry or turret. Belts can carry crates along a turret line.', on: ['dep', 'tur', 'sen'], tool: 'depot', done: () => ents.some(e => e.type === 'depot' && e.sel === 'ammo') },
      { t: 'Raiders go for the nearest building to their colony. Click a bug to shoot it yourself (12 tiles). In the end, only rockets wipe out the colonies.', on: ['hive', 'tur'] },
    ] },
  { name: 'Mining & haulage', blurb: 'Bulk ore moves by truck, never by belt.',
    nodes: [['ore', '@Bauxite face:bauxite', 0, 1], ['exc', 'excavator', 1, 1], ['road', 'road', 1.5, 0, 'Haul road'], ['hop', 'hopper', 2, 1, 'Dump hopper'], ['feed', 'feeder', 3, 1], ['mill', 'mill', 4, 1]],
    edges: [['ore', 'exc', 'ore', 'dig'], ['exc', 'hop', 'bauxite', 'truck'], ['hop', 'feed', 'bauxite', 'feeder'], ['feed', 'mill', 'bauxite', 'feeder'], ['road', 'exc', '', 'adj'], ['road', 'hop', '', 'adj']],
    steps: [
      { t: 'Lay a haul road past a bauxite face and on toward the refinery site. Roads are free; drag to lay them. Trucks keep right.', on: ['road'], tool: 'road' },
      { t: 'Place an excavator next to the ore with its arrow (the truck bay) on the road. It strips overburden first, then digs everything within 3 tiles.', on: ['ore', 'exc', 'road'], tool: 'excavator' },
      { t: 'Place a dump hopper with its arrow facing the road. Click it and set it to Bauxite.', on: ['hop', 'road'], tool: 'hopper', done: () => ents.some(e => e.type === 'hopper' && e.mat) },
      { t: 'Put a haul truck on the road. The dispatcher runs it from shovel to hopper automatically. Use up to 3 trucks per excavator.', on: ['exc', 'hop'], tool: 'truck' },
      { t: 'Point an apron feeder out of the hopper into the ball mill. It moves 4 t/s from behind it to in front.', on: ['hop', 'feed', 'mill'], tool: 'feeder' },
      { t: 'Where roads cross, a traffic signal lets trucks take turns instead of queueing for the box.', on: ['road'], tool: 'signal' },
    ] },
  { name: 'Water & power', blurb: 'One pipe network = one fluid.',
    nodes: [['lake', '@Lake / river:water', 0, 1], ['pump', 'pump', 1, 1], ['coal', 'hopper', 1, 2.2, 'Coal hopper'], ['boil', 'boiler', 2, 0.4], ['plant', 'powerplant', 2, 2], ['sub', 'substation', 3, 2.6, 'Grid connection'], ['users', '@Digesters, CDU, reformer:digester', 3, 0.4]],
    edges: [['lake', 'pump', 'water', 'dig'], ['pump', 'boil', 'water', 'pipe'], ['pump', 'plant', 'water', 'pipe'], ['coal', 'boil', 'coal', 'feeder'], ['coal', 'plant', 'coal', 'feeder'], ['boil', 'users', 'steam', 'pipe']],
    steps: [
      { t: 'You start with a 30 MW grid connection. Add more to buy more capacity, which is free but capped.', on: ['sub'], tool: 'substation' },
      { t: 'Put an offshore pump on the shoreline with its back to the water. It pumps 60 water/s.', on: ['lake', 'pump'], tool: 'pump' },
      { t: 'Run pipes. A connected network carries only ONE fluid, so keep water, steam and liquor apart. Underground pipes cross roads and other pipes.', on: ['pump', 'boil', 'plant'], tool: 'pipe' },
      { t: 'Process steam boiler: coal by feeder from a coal hopper, water in on the south, steam out on the north.', on: ['coal', 'boil', 'users'], tool: 'boiler' },
      { t: '25 MW coal power station: coal by feeder, cooling water by pipe. The potline and the ASU are hungry.', on: ['coal', 'plant', 'pump'], tool: 'powerplant' },
    ] },
  { name: 'Bayer refinery', blurb: 'Bauxite → alumina hydrate → alumina.',
    nodes: [['depC', 'depot', 0, 0, 'Depot (caustic)'], ['dis', 'dissolver', 1, 0], ['hopB', 'hopper', 0, 1.3, 'Bauxite hopper'], ['mill', 'mill', 1, 1.3], ['boil', 'boiler', 2, 0], ['kiln', 'limekiln', 1, 2.6], ['dig', 'digester', 2, 1.3], ['depF', 'depot', 3, 2.6, 'Depot (flocculant)'],
      ['cla', 'clarifier', 3, 1.3], ['pre', 'precipitator', 4, 0.5], ['was', 'washer', 4, 2.1], ['binH', 'bin', 5, 0.5, 'Hydrate bin'], ['binM', 'bin', 5, 2.1, 'Red mud bin'], ['calc', 'calciner', 6, 0.5], ['res', 'residue', 6, 2.1]],
    edges: [['depC', 'dis', 'caustic', 'ins'], ['dis', 'mill', 'liquor', 'pipe'], ['hopB', 'mill', 'bauxite', 'feeder'], ['mill', 'dig', 'slurry', 'pipe'], ['boil', 'dig', 'steam', 'pipe'], ['kiln', 'dig', 'quicklime', 'ins'],
      ['dig', 'cla', 'digested', 'pipe'], ['depF', 'cla', 'flocculant', 'ins'], ['cla', 'pre', 'pregnant', 'pipe'], ['cla', 'was', 'mudslurry', 'pipe'], ['pre', 'mill', 'liquor', 'pipe'], ['pre', 'binH', 'gibbsite', 'feeder'],
      ['was', 'binM', 'redmud', 'feeder'], ['binH', 'calc', 'gibbsite', 'truck'], ['binM', 'res', 'redmud', 'truck']],
    steps: [
      { t: 'Set a supply depot to Caustic soda and run an inserter into the caustic make-up tank. Pipe water in. This charges the liquor circuit.', on: ['depC', 'dis'], tool: 'dissolver' },
      { t: 'Ball mill: liquor in on the south, slurry out on the north, bauxite by feeder from the hopper.', on: ['dis', 'hopB', 'mill'], tool: 'mill' },
      { t: 'Lime kiln: limestone and coal by feeders. Inserter its quicklime bags into the digester.', on: ['kiln', 'dig'], tool: 'limekiln' },
      { t: 'Digester: slurry and steam pipes in on the south, digested slurry out on the north.', on: ['mill', 'boil', 'dig'], tool: 'digester' },
      { t: 'Settler: digested slurry in on the south, pregnant liquor out on the north, mud underflow out on the east. Flocculant drums by inserter from a depot.', on: ['dig', 'cla', 'depF'], tool: 'clarifier' },
      { t: 'Precipitator: pregnant liquor in. Spent liquor goes back to the mill, and hydrate leaves as bulk through a feeder into a load-out bin.', on: ['cla', 'pre', 'binH', 'mill'], tool: 'precipitator' },
      { t: 'Mud washer: underflow and water in, recovered liquor back to the circuit, red mud through a feeder into a bin.', on: ['cla', 'was', 'binM'], tool: 'washer' },
      { t: 'Residue storage area beside a road. Trucks haul red mud from the bin automatically.', on: ['binM', 'res'], tool: 'residue' },
      { t: 'Calciner: trucks bring hydrate from the bin to a hopper set to Alumina hydrate, which feeds the calciner by feeder. A second feeder brings coal. Alumina leaves by pipe (north) for the potline.', on: ['binH', 'calc'], tool: 'calciner' },
    ] },
  { name: 'Smelter', blurb: 'Hall–Héroult: alumina + carbon → aluminium.',
    nodes: [['calc', 'calciner', 0, 0], ['depCr', 'depot', 1, 0, 'Depot (cryolite, AlF₃)'], ['hopK', 'hopper', 0, 1.6, 'Coke hopper'], ['depP', 'depot', 0, 2.8, 'Depot (pitch)'], ['paste', 'paste', 1, 2.2], ['bake', 'bake', 2, 2.2], ['pot', 'pot', 2.6, 0.9], ['cast', 'casthouse', 3.8, 0.9], ['out', '@Extrusion press / Al-Li pit:ingot', 4.8, 0.9]],
    edges: [['calc', 'pot', 'alumina', 'pipe'], ['depCr', 'pot', 'cryolite, AlF₃', 'ins'], ['hopK', 'paste', 'coke', 'feeder'], ['depP', 'paste', 'pitch', 'ins'], ['paste', 'bake', 'green anodes', 'ins'], ['bake', 'pot', 'anodes', 'ins'], ['pot', 'paste', 'butts', 'ins'], ['pot', 'cast', 'crucibles', 'ins'], ['cast', 'out', 'ingots', 'ins']],
    steps: [
      { t: 'Pipe alumina from the calciner\'s north port to each reduction cell\'s south port.', on: ['calc', 'pot'], tool: 'pot' },
      { t: 'Cells take power first. Below 85 % supply they cool, and one that stays under 880 °C for 10 s freezes for good.', on: ['pot'], tool: 'powerplant' },
      { t: 'Cryolite and AlF₃ from supply depots, inserted into the cells.', on: ['depCr', 'pot'], tool: 'depot' },
      { t: 'Anode paste plant: coke by feeder, pitch drums by inserter, plus spent butts returned from the cells.', on: ['hopK', 'depP', 'paste', 'pot'], tool: 'paste' },
      { t: 'Baking furnace: green anodes in by inserter, coal by feeder. Inserters put the baked anodes into the cells.', on: ['paste', 'bake', 'pot'], tool: 'bake' },
      { t: 'Inserter the crucibles from the cell into the casthouse, which casts ingots.', on: ['pot', 'cast', 'out'], tool: 'casthouse' },
    ] },
  { name: 'Construction materials', blurb: 'Everything you build is paid in these.',
    nodes: [['hopL', 'hopper', 0, 0, 'Limestone hopper'], ['ck', 'cementkiln', 1, 0], ['hopA', 'hopper', 1, 1.3, 'Limestone (aggregate)'], ['bat', 'batching', 2, 0.6], ['cast', 'casthouse', 0, 2.5, 'Casthouse (ingots)'], ['ext', 'extrusion', 1, 2.5], ['depK', 'depot', 2, 3.4, 'Depot (machinery kits)'], ['store', 'store', 3, 1.6]],
    edges: [['hopL', 'ck', 'limestone + coal', 'feeder'], ['ck', 'bat', 'cement', 'ins'], ['hopA', 'bat', 'limestone', 'feeder'], ['bat', 'store', 'concrete', 'ins'], ['cast', 'ext', 'ingots', 'ins'], ['ext', 'store', 'extrusions', 'ins'], ['depK', 'store', 'kits', 'ins']],
    steps: [
      { t: 'Site stores: anything inserted joins the team stockpile that pays for building.', on: ['store'], tool: 'store' },
      { t: 'Set a supply depot to Machinery kits and run an inserter into the stores. That\'s 4 kits/min, shared between depots.', on: ['depK', 'store'], tool: 'depot', done: () => ents.some(e => e.type === 'depot' && e.sel === 'kit') },
      { t: 'Cement kiln: limestone and coal by feeders. Cement bags leave by inserter.', on: ['hopL', 'ck'], tool: 'cementkiln' },
      { t: 'Batching plant: cement by inserter, limestone aggregate by feeder, water by pipe (south). Precast panels go by inserter into the stores.', on: ['ck', 'hopA', 'bat', 'store'], tool: 'batching' },
      { t: 'Extrusion press: ingots in by inserter, extrusions out by inserter into the stores.', on: ['cast', 'ext', 'store'], tool: 'extrusion' },
    ] },
  { name: 'Oil & propellants', blurb: 'RP-1 kerosene and liquid oxygen.',
    nodes: [['well', 'oilwell', 0, 1], ['boil', 'boiler', 0, 2.6], ['cdu', 'distill', 1, 1], ['cok', 'coker', 2, 2.2], ['binK', 'bin', 3, 2.8, 'Coke bin → anode plant'], ['ref', 'reformer', 2, 0], ['hyd', 'hydrotreater', 3, 0.8], ['asu', 'asu', 3, 3.9], ['ts', 'teststand', 4.2, 1.5], ['pad', 'pad', 4.2, 3.2]],
    edges: [['well', 'cdu', 'crude', 'pipe'], ['boil', 'cdu', 'steam', 'pipe'], ['cdu', 'ref', 'naphtha', 'pipe'], ['cdu', 'hyd', 'kerosene', 'pipe'], ['cdu', 'cok', 'residue', 'pipe'], ['cok', 'ref', 'naphtha', 'pipe'], ['cok', 'binK', 'coke', 'feeder'], ['boil', 'ref', 'steam', 'pipe'],
      ['ref', 'hyd', 'hydrogen', 'pipe'], ['hyd', 'ts', 'rp1', 'pipe'], ['hyd', 'pad', 'rp1', 'pipe'], ['asu', 'ts', 'lox', 'pipe'], ['asu', 'pad', 'lox', 'pipe']],
    steps: [
      { t: 'Oil well on a black oil seep. Crude comes out the north port into a pipe.', on: ['well'], tool: 'oilwell' },
      { t: 'Crude distillation unit: crude and steam in on the south. Naphtha, kerosene and residue leave on the north side, on three separate pipes.', on: ['well', 'boil', 'cdu'], tool: 'distill' },
      { t: 'Delayed coker: residue in. Cracked naphtha leaves by pipe, and pet coke goes as bulk through a feeder to a bin, then by truck to the anode plant\'s coke hopper.', on: ['cdu', 'cok', 'binK'], tool: 'coker' },
      { t: 'Steam reformer: naphtha + steam → hydrogen.', on: ['cdu', 'cok', 'boil', 'ref'], tool: 'reformer' },
      { t: 'Hydrotreater: kerosene + hydrogen → RP-1.', on: ['cdu', 'ref', 'hyd'], tool: 'hydrotreater' },
      { t: 'Air separation unit: water in, liquid oxygen out on the east. It needs 6 MW.', on: ['asu'], tool: 'asu' },
      { t: 'Pipe RP-1 and LOX to the engine test stand and the launch pad.', on: ['hyd', 'asu', 'ts', 'pad'], tool: 'pipe' },
    ] },
  { name: 'Rocket & launch', blurb: 'Al-Li tanks, gas-generator engines, strike.',
    nodes: [['cast', 'casthouse', 0, 0, 'Ingots'], ['depL', 'depot', 0, 1, 'Depot (lithium)'], ['alloy', 'alloy', 1, 0.5], ['roll', 'rolling', 2, 0.5], ['tank', 'tankshop', 3, 0], ['pf', 'payloadfab', 3, 1.1], ['depPk', 'depot', 2, 1.6, 'Depot (payload kit)'],
      ['depS', 'depot', 0, 2.7, 'Depot (Inconel, copper)'], ['turbo', 'turbo', 1, 2.2], ['cf', 'chamberfab', 1, 3.2], ['ea', 'engineasm', 2, 2.7], ['ts', 'teststand', 3, 2.7], ['depA', 'depot', 3, 3.8, 'Depot (avionics)'], ['vab', 'vab', 4, 1.6], ['pad', 'pad', 5, 1.6], ['hive', '@Bug colony:hive', 6, 1.6]],
    edges: [['cast', 'alloy', 'ingots', 'ins'], ['depL', 'alloy', 'lithium', 'ins'], ['alloy', 'roll', 'slab', 'ins'], ['roll', 'tank', 'plate', 'ins'], ['roll', 'pf', 'plate', 'ins'], ['depPk', 'pf', 'payload kit', 'ins'], ['depS', 'turbo', 'Inconel', 'ins'], ['depS', 'cf', 'Cu + Inconel', 'ins'],
      ['turbo', 'ea', 'turbopump', 'ins'], ['cf', 'ea', 'chamber', 'ins'], ['ea', 'ts', 'engine', 'ins'], ['ts', 'vab', 'flight engines', 'ins'], ['tank', 'vab', 'tanks', 'ins'], ['pf', 'vab', 'payload', 'ins'], ['depA', 'vab', 'avionics', 'ins'], ['vab', 'pad', 'rollout', 'adj'], ['pad', 'hive', 'strike', 'fly']],
    steps: [
      { t: 'Al-Li casting pit: 5 ingots + 1 lithium drum → a 2195 slab. Load it with inserters.', on: ['cast', 'depL', 'alloy'], tool: 'alloy' },
      { t: 'Plate rolling mill (4 MW): slab → 4 plates.', on: ['alloy', 'roll'], tool: 'rolling' },
      { t: 'Friction-stir tank shop: 6 plates → 1 tank barrel section.', on: ['roll', 'tank'], tool: 'tankshop' },
      { t: 'Turbomachinery cell: Inconel billets → turbopump.', on: ['depS', 'turbo'], tool: 'turbo' },
      { t: 'Thrust chamber shop: copper + Inconel → regeneratively cooled chamber.', on: ['depS', 'cf'], tool: 'chamberfab' },
      { t: 'Engine assembly: chamber + turbopump → engine.', on: ['turbo', 'cf', 'ea'], tool: 'engineasm' },
      { t: 'Engine test stand: engine in by inserter, RP-1 and LOX pipes on the south. About 4 % fail the hot-fire.', on: ['ea', 'ts'], tool: 'teststand' },
      { t: 'Payload processing: 2 plates + payload kit → encapsulated payload.', on: ['roll', 'depPk', 'pf'], tool: 'payloadfab' },
      { t: 'VAB: 4 tanks, 4 flight engines, 2 avionics kits and a payload → launch vehicle (30 s).', on: ['tank', 'ts', 'pf', 'depA', 'vab'], tool: 'vab' },
      { t: 'Launch pad DIRECTLY beside the VAB, so the rocket rolls over. Pipe RP-1 and LOX to its south ports, and keep the LOX topped up because it boils off.', on: ['vab', 'pad'], tool: 'pad' },
      { t: 'Click the pad, then Choose target (or tick auto-strike). The blast covers 5 tiles and kills raiders too.', on: ['pad', 'hive'] },
    ] },
];
const MODE = {
  pipe: { w: 4, dash: '' }, truck: { col: '#d9a22b', w: 3, dash: '9 5' }, feeder: { col: '#f08a24', w: 3, dash: '2 4' },
  ins: { col: '#cfc7b8', w: 2, dash: '' }, adj: { col: '#8a9aa6', w: 1.5, dash: '4 4' }, fly: { col: '#ff6a50', w: 2, dash: '10 6' }, dig: { col: '#a8502a', w: 3, dash: '' },
};
const bp = { open: false, chain: 0, step: 0, pinned: false };
const iconURL = {};
function nodeIcon(n) {
  const t = n[1];
  if (t[0] === '@') { const k = t.split(':')[1]; if (k === 'hive') return null; if (k === 'water') return null; if (DEFS[k]) return iconURL[k] || (iconURL[k] = iconFor(k).toDataURL()); return sprSrc(k); }
  return iconURL[t] || (iconURL[t] = iconFor(t).toDataURL());
}
const nodeName = n => n[4] || (n[1][0] === '@' ? n[1].slice(1).split(':')[0] : DEFS[n[1]].n);
function stepDone(st) {
  if (st.done) return st.done();
  if (!st.tool) return false;
  if (st.tool === 'truck') return trucks.length > 0;
  if (st.tool === 'signal') return ents.some(e => e.sig);
  return ents.some(e => e.type === st.tool);
}
function portHint(type) {
  const d = DEFS[type]; if (!d) return '';
  const side = ['north', 'east', 'south', 'west'];
  const parts = (d.ports || []).map(p => `<span class="sw" style="background:${FLUIDS[p.f].col}"></span>${FLUIDS[p.f].n} ${p.io === 'in' ? 'in' : 'out'} on the ${side[p.d]}`);
  if (type === 'excavator') parts.push('truck bay 2 tiles out on the arrow side');
  if (type === 'hopper' || type === 'bin') parts.push('road on the arrow side');
  if (type === 'feeder' || type === 'inserter') parts.push('takes from behind, delivers in front');
  if (type === 'pump') parts.push('back to the water');
  return parts.length ? `<div class="ports"><b>Connections</b> (arrow pointing north): ${parts.join(' · ')}</div>` : '';
}
function renderBP() {
  const ch = CHAINS[bp.chain], st = ch.steps[bp.step], on = new Set(st.on || []);
  $('bpSide').innerHTML = CHAINS.map((c2, i) => { const dn = c2.steps.filter(stepDone).length; return `<div class="bpc${i === bp.chain ? ' on' : ''}" data-ch="${i}"><b>${c2.name}</b><span class="dim">${dn}/${c2.steps.length}</span><div class="dim">${c2.blurb}</div></div>`; }).join('') +
    `<div class="legend"><b>Legend</b>${[['pipe', 'pipe (fluid colour)'], ['truck', 'haul truck (bulk)'], ['feeder', 'apron feeder (bulk)'], ['ins', 'inserter / belt (units)'], ['adj', 'placed beside'], ['fly', 'flight / raid']].map(([m, l]) => `<div><svg width="34" height="8"><line x1="1" y1="4" x2="33" y2="4" stroke="${MODE[m].col || '#7fb0d8'}" stroke-width="${MODE[m].w}" stroke-dasharray="${MODE[m].dash}"/></svg>${l}</div>`).join('')}</div>`;
  const CW = 178, RH = 96, NW = 144, NH = 60, P0 = 16;
  const pos = {}; let mxX = 0, mxY = 0;
  for (const n of ch.nodes) { const x = P0 + n[2] * CW, y = P0 + n[3] * RH; pos[n[0]] = [x, y]; mxX = Math.max(mxX, x + NW); mxY = Math.max(mxY, y + NH); }
  let svg = `<svg viewBox="0 0 ${mxX + P0} ${mxY + P0 + 6}" width="${mxX + P0}" height="${mxY + P0 + 6}" style="min-width:${Math.round((mxX + P0) * .7)}px">`;
  for (const [a, b, mat, mode] of ch.edges) {
    const [ax, ay] = pos[a], [bx, by] = pos[b], acx = ax + NW / 2, acy = ay + NH / 2, bcx = bx + NW / 2, bcy = by + NH / 2;
    const horiz = Math.abs(bcx - acx) >= Math.abs(bcy - acy) * 1.1;
    let x1, y1, x2, y2, c1, c2;
    if (horiz) { const s = Math.sign(bcx - acx) || 1; x1 = acx + s * NW / 2; y1 = acy; x2 = bcx - s * NW / 2; y2 = bcy; const k = Math.max(30, Math.abs(x2 - x1) * .45); c1 = [x1 + s * k, y1]; c2 = [x2 - s * k, y2]; }
    else { const s = Math.sign(bcy - acy) || 1; x1 = acx; y1 = acy + s * NH / 2; x2 = bcx; y2 = bcy - s * NH / 2; const k = Math.max(20, Math.abs(y2 - y1) * .45); c1 = [x1, y1 + s * k]; c2 = [x2, y2 - s * k]; }
    const m = MODE[mode], col = mode === 'pipe' ? (FLUIDS[mat] ? FLUIDS[mat].col : '#7fb0d8') : m.col, act = on.has(a) && on.has(b);
    const op = on.size ? (act ? 1 : .22) : .9;
    svg += `<path d="M${x1},${y1} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${x2},${y2}" fill="none" stroke="${col}" stroke-width="${m.w + (act ? 1 : 0)}" stroke-dasharray="${m.dash}" opacity="${op}"${act ? ' class="flow"' : ''}/>`;
    const ang = Math.atan2(y2 - c2[1], x2 - c2[0]), ah = 8;
    svg += `<path d="M${x2},${y2} L${x2 - ah * Math.cos(ang - .45)},${y2 - ah * Math.sin(ang - .45)} L${x2 - ah * Math.cos(ang + .45)},${y2 - ah * Math.sin(ang + .45)} Z" fill="${col}" opacity="${op}"/>`;
    if (mat) {
      const t = .5, mx2 = (1 - t) ** 3 * x1 + 3 * (1 - t) ** 2 * t * c1[0] + 3 * (1 - t) * t * t * c2[0] + t ** 3 * x2, my2 = (1 - t) ** 3 * y1 + 3 * (1 - t) ** 2 * t * c1[1] + 3 * (1 - t) * t * t * c2[1] + t ** 3 * y2;
      const label = FLUIDS[mat] ? FLUIDS[mat].n : ITEMS[mat] ? ITEMS[mat].n : mat;
      svg += `<text x="${mx2}" y="${my2 - 4}" text-anchor="middle" class="el" opacity="${op}">${esc(label)}</text>`;
    }
  }
  for (const n of ch.nodes) {
    const [x, y] = pos[n[0]], act = on.has(n[0]), op = on.size ? (act ? 1 : .35) : 1, ic = nodeIcon(n), isB = DEFS[n[1]] && n[1][0] !== '@';
    const built = isB && ents.some(e => e.type === n[1]);
    const rec = isB && DEFS[n[1]].recipes ? DEFS[n[1]].recipes.map(r => fmtRecipe(r).replace(/<[^>]+>/g, '')).join('\n') : '';
    svg += `<g class="bpn${isB ? ' bld' : ''}" data-t="${isB ? n[1] : ''}" opacity="${op}"><title>${esc(nodeName(n))}${rec ? '\n' + esc(rec) : ''}${isB ? '\nClick to build' : ''}</title>`;
    svg += `<rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="9" fill="${act ? 'rgba(240,169,69,.16)' : 'rgba(255,255,255,.05)'}" stroke="${act ? '#f0a945' : 'rgba(255,255,255,.18)'}" stroke-width="${act ? 2 : 1}"/>`;
    if (ic) svg += `<image href="${ic}" x="${x + 6}" y="${y + 10}" width="40" height="40"/>`;
    else svg += `<circle cx="${x + 26}" cy="${y + 30}" r="15" fill="${n[1].endsWith('hive') ? '#5a2a44' : '#2a5a7a'}" stroke="${n[1].endsWith('hive') ? '#c86ad8' : '#7fb0d8'}"/>`;
    const words = nodeName(n).split(' '), lines = [''];
    for (const w2 of words) { if ((lines[lines.length - 1] + ' ' + w2).trim().length > 15 && lines[lines.length - 1]) lines.push(w2); else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w2).trim(); }
    lines.slice(0, 3).forEach((l, i) => { svg += `<text x="${x + 52}" y="${y + NH / 2 - (Math.min(3, lines.length) - 1) * 6.5 + i * 13 + 4}" class="nl">${esc(l)}</text>`; });
    if (built) svg += `<circle cx="${x + NW - 9}" cy="${y + 9}" r="6" fill="#62c25a"/><path d="M${x + NW - 12},${y + 9} l2.5,2.5 l4.5,-5" stroke="#10200c" stroke-width="1.8" fill="none"/>`;
    svg += '</g>';
  }
  $('bpSvg').innerHTML = svg + '</svg>';
  $('bpStep').innerHTML = stepCard(true);
}
function stepCard(full) {
  const ch = CHAINS[bp.chain], st = ch.steps[bp.step], dn = stepDone(st);
  const d = st.tool && DEFS[st.tool];
  return `<div class="bph"><span class="dim">${esc(ch.name)} · step ${bp.step + 1} of ${ch.steps.length}</span>${dn ? '<span class="good">✓ done</span>' : ''}</div>
    <div class="bpt">${esc(st.t)}</div>
    ${full && d ? (d.recipes ? d.recipes.map(r => `<div class="rcp">${fmtRecipe(r)}</div>`).join('') : '') + portHint(st.tool) : ''}
    <div class="bpb"><button data-bp="prev" ${bp.step === 0 ? 'disabled' : ''}>◀ Prev</button><button data-bp="next" ${bp.step === ch.steps.length - 1 ? 'disabled' : ''}>Next ▶</button>
    ${d ? `<button data-bp="build" class="pri">Build ${esc(d.n)} <span class="dim">${costTxt(st.tool)}</span></button>` : ''}
    ${full ? '' : '<button data-bp="open">▦ Diagram</button><button data-bp="unpin">✕</button>'}</div>`;
}
function renderPin() { const el = $('bpCard'); if (!bp.pinned || bp.open) { el.style.display = 'none'; return; } el.style.display = 'block'; el.innerHTML = stepCard(false); }
function toggleBP(v) { bp.open = v === undefined ? !bp.open : v; $('bp').classList.toggle('on', bp.open); if (bp.open) renderBP(); renderPin(); }
function bpAction(a) {
  const ch = CHAINS[bp.chain], st = ch.steps[bp.step];
  if (a === 'prev') bp.step = Math.max(0, bp.step - 1);
  else if (a === 'next') bp.step = Math.min(ch.steps.length - 1, bp.step + 1);
  else if (a === 'build' && st.tool) { const gi = GROUPS.findIndex(g => g[1].includes(st.tool)); if (gi >= 0) cat = gi; setTool(st.tool); bp.pinned = true; toggleBP(false); return; }
  else if (a === 'open') { toggleBP(true); return; }
  else if (a === 'unpin') { bp.pinned = false; }
  if (bp.open) renderBP(); renderPin();
}
$('bp').addEventListener('click', ev => {
  const c2 = ev.target.closest('[data-ch]'); if (c2) { bp.chain = +c2.dataset.ch; bp.step = 0; renderBP(); return; }
  const b = ev.target.closest('[data-bp]'); if (b) { bpAction(b.dataset.bp); return; }
  const n = ev.target.closest('.bpn.bld'); if (n && n.dataset.t) { const ch = CHAINS[bp.chain], i = ch.steps.findIndex(s => s.tool === n.dataset.t); if (i >= 0) { bp.step = i; renderBP(); } else { const gi = GROUPS.findIndex(g => g[1].includes(n.dataset.t)); if (gi >= 0) cat = gi; setTool(n.dataset.t); toggleBP(false); } return; }
  if (ev.target.classList.contains('x')) toggleBP(false);
});
$('bpCard').addEventListener('click', ev => { const b = ev.target.closest('[data-bp]'); if (b) bpAction(b.dataset.bp); });
$('bpBtn').onclick = () => toggleBP();
setInterval(() => { if (bp.pinned && !bp.open) renderPin(); }, 1000);

// =====================================================================
//  render
// =====================================================================
function brackets(c, x, y, w, h, col = '#f2b134') {
  const l = 7; c.strokeStyle = col; c.lineWidth = 2.5 / cam.z + .5; c.lineCap = 'square';
  c.beginPath();
  c.moveTo(x, y + l); c.lineTo(x, y); c.lineTo(x + l, y); c.moveTo(x + w - l, y); c.lineTo(x + w, y); c.lineTo(x + w, y + l);
  c.moveTo(x + w, y + h - l); c.lineTo(x + w, y + h); c.lineTo(x + w - l, y + h); c.moveTo(x + l, y + h); c.lineTo(x, y + h); c.lineTo(x, y + h - l);
  c.stroke();
}
function statusIcon(c, e) {
  const [fw, fh] = fp(e.type, e.dir), x = (e.x + fw / 2) * T, y = (e.y + fh / 2) * T;
  const blink = Math.sin(tnow() * 6) > 0;
  if (e.infested) { c.fillStyle = 'rgba(60,10,40,.7)'; circle(c, x, y, 12); c.fill(); stencil(c, '☣', x, y + 5, 14, '#e08ad0'); return; }
  if (e.status === 'No power' && blink) {
    c.fillStyle = 'rgba(0,0,0,.6)'; circle(c, x, y, 11); c.fill();
    c.fillStyle = '#f2d24a'; c.beginPath(); c.moveTo(x + 2, y - 8); c.lineTo(x - 5, y + 1); c.lineTo(x, y + 1); c.lineTo(x - 2, y + 8); c.lineTo(x + 5, y - 1); c.lineTo(x, y - 1); c.closePath(); c.fill();
  }
  if (e.frozen) { c.fillStyle = 'rgba(0,0,0,.6)'; circle(c, x, y, 12); c.fill(); stencil(c, '❄', x, y + 6, 16, '#bfe6ff'); }
  if (e.ae && blink) { c.fillStyle = 'rgba(160,0,0,.75)'; circle(c, x, y, 12); c.fill(); stencil(c, 'AE', x, y + 4, 10, '#fff'); }
  if (e.type === 'pot' && !e.frozen && e.hot && e.T < 930 && blink) { c.fillStyle = 'rgba(0,0,0,.6)'; circle(c, x, y, 12); c.fill(); stencil(c, '▼°', x, y + 4, 10, '#7fd0ff'); }
  if (e.type === 'hopper' && !e.mat && blink) { c.fillStyle = 'rgba(0,0,0,.6)'; circle(c, x, y, 11); c.fill(); stencil(c, '?', x, y + 5, 14, '#ffb84a'); }
}
const BIG = new Set(['belt', 'pipe', 'ptg', 'road']);
let time = 0;
// Pixel-art pipeline: the world is drawn into a low-res buffer (ART_PX world units per art pixel = 16 art pixels per
// tile) and blown up with nearest-neighbour scaling. The camera snaps to whole art pixels so nothing shimmers.
const ART_PX = 2, pcv = document.createElement('canvas'), pc = pcv.getContext('2d');
function render(dt, frac) {
  const M = window.__mainCtx || (window.__mainCtx = cv.getContext('2d'));
  const pxs = Math.max(1, ART_PX * cam.z), kz = cam.z / pxs;
  const lw = Math.ceil(vw / pxs) + 1, lh = Math.ceil(vh / pxs) + 1;
  if (pcv.width !== lw || pcv.height !== lh) { pcv.width = lw; pcv.height = lh; }
  const ox = Math.round(vw / 2 / pxs - cam.x * kz), oy = Math.round(vh / 2 / pxs - cam.y * kz);
  let c = pc;
  c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#141210'; c.fillRect(0, 0, lw, lh);
  c.setTransform(kz, 0, 0, kz, ox, oy);
  const a = s2w(0, 0), b = s2w(vw, vh);
  const x0 = Math.max(0, Math.floor(a.x / T) - 6), y0 = Math.max(0, Math.floor(a.y / T) - 6);
  const x1 = Math.min(W, Math.ceil(b.x / T) + 1), y1 = Math.min(H, Math.ceil(b.y / T) + 6);
  chunkFrame++; chunkBuilds = 0;
  for (let cy = Math.floor(y0 / CH); cy <= Math.floor((y1 - 1) / CH); cy++) for (let cx = Math.floor(x0 / CH); cx <= Math.floor((x1 - 1) / CH); cx++) {
    const ch = getChunk(cx, cy); if (ch) c.drawImage(ch, cx * CH * T, cy * CH * T, CH * T, CH * T);
  }
  c.strokeStyle = 'rgba(210,240,255,.12)'; c.lineWidth = 1.2;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (water[x + y * W]) {
    const h = hash(x, y, 5), ox = ((time * 6 + h * 32) % 32);
    line(c, x * T + ox - 5, y * T + 8 + h * 16, x * T + ox + 3, y * T + 8 + h * 16);
  }
  drawCreep(c, Math.max(0, x0 - 1), Math.max(0, y0 - 1), Math.min(W, x1 + 1), Math.min(H, y1 + 1));
  const vis = ents.filter(e => { const [fw, fh] = fp(e.type, e.dir); return e.x + fw >= x0 && e.x <= x1 && e.y + fh >= y0 - 6 && e.y <= y1; });
  for (const r of vis) if (r.type === 'road') drawRoad(c, r);
  for (const p of vis) if (p.type === 'pipe' || p.type === 'ptg') drawPipe(c, p);
  const belts = vis.filter(e => e.type === 'belt');
  drawBelts(c, belts, time);
  const k = 1 - Math.exp(-dt * 22);
  for (const bl of belts) for (const it of bl.items) {
    const [px, py] = beltPoint(bl, it.pos);
    if (it.rx === undefined || Math.abs(it.rx - px) > 48 || Math.abs(it.ry - py) > 48) { it.rx = px; it.ry = py; }
    it.rx += (px - it.rx) * k; it.ry += (py - it.ry) * k;
    c.drawImage(SPR[it.type], it.rx - 9, it.ry - 9, 18, 18);
  }
  for (const r of vis) if (r.type === 'road' && r.sig) drawSignal(c, r);
  for (const t of trucks) { const tx = t.tile % W, ty = t.tile / W | 0; if (tx >= x0 - 2 && tx <= x1 + 2 && ty >= y0 - 2 && ty <= y1 + 2) drawTruck(c, t, dt); else t._x = undefined; }
  const bld = vis.filter(e => !BIG.has(e.type)).sort((p, q) => (p.y + fp(p.type, p.dir)[1]) - (q.y + fp(q.type, q.dir)[1]));
  for (const e of bld) {
    if (e.type === 'inserter') drawInserterBase(c, e); else drawMachine(c, e);
    if (e.type === 'excavator') drawExcavatorTop(c, e, dt);
    if (e.type === 'pad' && e.rocket) drawRocketStanding(c, e);
    if ((working(e) || (e.type === 'powerplant' && e.gen > 0) || (e.type === 'pot' && e.T > 600 && !e.frozen)) && DEFS[e.type].stacks) spawnStacks(e);
  }
  for (const e of bld) if (e.type === 'inserter') drawInserterArm(c, e);
  for (const sp of splats) { c.fillStyle = `rgba(90,40,20,${.5 * (1 - sp.t / 60)})`; circle(c, sp.x, sp.y, 6 + sp.r); c.fill(); }
  for (const e of bld) if (e.type === 'turret') drawTurretTop(c, e); else if (e.type === 'sentry') drawSentryTop(c, e);
  for (const b of bugs) if (b.x >= x0 - 2 && b.x <= x1 + 2 && b.y >= y0 - 2 && b.y <= y1 + 2) drawBug(c, b, dt); else b._x = undefined;
  for (const e of vis) if (e.hp !== undefined) hpBar(c, e);
  for (const tr of tracers) { c.strokeStyle = `rgba(255,230,150,${tr.t / .12})`; c.lineWidth = 1.6; line(c, tr.x0, tr.y0, tr.x1, tr.y1); }
  for (const hv of hives) if (hv.x >= x0 - 2 && hv.x <= x1 + 2 && hv.y >= y0 - 2 && hv.y <= y1 + 2) drawHive(c, hv);
  for (const [id, o] of others) { const p = roster.get(id); if (p && !driving(id)) drawPlayer(c, o, p.col, p.name); }
  if (!driving(me.id)) drawPlayer(c, me, me.col, me.name);
  if (me.hp < 100) { c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(me.x * T - 12, me.y * T + 12, 24, 3.5); c.fillStyle = me.hp > 40 ? '#62c25a' : '#e2483a'; c.fillRect(me.x * T - 12, me.y * T + 12, 24 * me.hp / 100, 3.5); }
  for (const bm of beams) { c.strokeStyle = bm.col; c.globalAlpha = bm.t / .35 * .7; c.lineWidth = 2; c.setLineDash([4, 4]); c.lineDashOffset = -time * 40; line(c, bm.x0, bm.y0, bm.x1, bm.y1); c.setLineDash([]); c.globalAlpha = 1; }
  for (const p of particles) {
    const t = p.life / p.max;
    c.fillStyle = p.k === 'steam' ? `rgba(240,240,240,${.32 * (1 - t)})` : p.k === 'dust' ? `rgba(150,70,35,${.3 * (1 - t)})` : p.k === 'fire' ? (t < .3 ? `rgba(255,${200 - t * 400},60,${.8 * (1 - t)})` : `rgba(60,50,45,${.5 * (1 - t)})`) : `rgba(62,58,54,${.45 * (1 - t)})`;
    circle(c, p.x, p.y, p.r * (p.k === 'fire' ? 1 + t * 2 : 1)); c.fill();
  }
  for (const f of flights) drawFlight(c, f, frac);
  for (const r of rings) { c.strokeStyle = `rgba(255,230,180,${Math.max(0, 1 - r.t)})`; c.lineWidth = 6 * (1 - r.t) + 1; circle(c, r.x, r.y, r.t * S.BLAST_R * T * 1.4); c.stroke(); }
  // blow the pixel buffer up, then draw the crisp overlays (names, cursors, ghosts) at full resolution
  M.setTransform(1, 0, 0, 1, 0, 0); M.imageSmoothingEnabled = false;
  M.filter = 'contrast(1.1) saturate(.8) brightness(.96)';
  M.drawImage(pcv, 0, 0, lw, lh, 0, 0, lw * pxs * dpr, lh * pxs * dpr);
  M.filter = 'none';
  c = M;
  c.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * ox * pxs, dpr * oy * pxs);
  for (const [id, o] of others) { const p = roster.get(id); if (p) drawNameTag(c, o, p.col, p.name); }
  drawNameTag(c, me, me.col, me.name);
  // remote cursors
  for (const [id, o] of others) { const p = roster.get(id); if (p && o.cx !== undefined) { c.globalAlpha = .55; brackets(c, o.cx * T + 3, o.cy * T + 3, T - 6, T - 6, p.col); c.globalAlpha = 1; } }
  // tool ghost / hover
  const [tx, ty] = curTile();
  if (targeting && !overUI) {
    const cx = (tx + .5) * T, cy = (ty + .5) * T, pr = BLAST();
    c.strokeStyle = 'rgba(255,80,60,.9)'; c.lineWidth = 2 / cam.z; c.setLineDash([8, 6]); circle(c, cx, cy, S.BLAST_R * T); c.stroke(); c.setLineDash([]);
    line(c, cx - 20, cy, cx + 20, cy); line(c, cx, cy - 20, cx, cy + 20);
    c.strokeStyle = 'rgba(255,255,255,.25)'; line(c, (targeting.x + 3) * T, (targeting.y + 3) * T, cx, cy);
    void pr;
  } else if (tool && !overUI) {
    if (tool === 'pipe' || tool === 'ptg') for (const e of vis) if (e.ports && e.ports.length) drawPortArrows(c, e);
    c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1.5 / cam.z; c.setLineDash([6, 6]); circle(c, me.x * T, me.y * T, REACH * T); c.stroke(); c.setLineDash([]);
    if (tool === 'truck' || tool === 'signal') {
      const ok = tool === 'truck' ? (get(tx, ty) && get(tx, ty).type === 'road') : S.isJunction(tx + ty * W);
      c.fillStyle = ok && inReach(tx, ty) && S.canAfford(costOf(tool)) ? 'rgba(100,220,100,.3)' : 'rgba(220,40,30,.35)'; c.fillRect(tx * T, ty * T, T, T);
      if (tool === 'truck') { c.save(); c.translate((tx + .5) * T, (ty + .5) * T); c.rotate(rot * PI / 2); c.globalAlpha = .6; drawTruckShape(c, 0, null, 0); c.restore(); c.globalAlpha = 1; }
    } else {
      const [ax, ay] = anchorFor(tool, tx, ty, rot), [fw, fh] = fp(tool, rot);
      const err = S.placeError(tool, ax, ay, rot), ok = !err && S.canAfford(costOf(tool)) && inReach(ax, ay, fw, fh);
      const g = S.makeEnt(tool, ax, ay, rot);
      if (tool === 'inserter' || tool === 'feeder') {
        c.fillStyle = 'rgba(240,160,60,.25)'; c.fillRect((ax - DX[rot]) * T + 2, (ay - DY[rot]) * T + 2, T - 4, T - 4);
        c.fillStyle = 'rgba(100,220,100,.25)'; c.fillRect((ax + DX[rot]) * T + 2, (ay + DY[rot]) * T + 2, T - 4, T - 4);
      }
      if (tool === 'excavator') {
        c.fillStyle = 'rgba(240,200,60,.12)'; for (const i of excTiles(ax, ay)) if (oreType[i] && oreType[i] !== 'oil') c.fillRect((i % W) * T, (i / W | 0) * T, T, T);
        c.fillStyle = 'rgba(100,220,100,.35)'; c.fillRect((ax + 1 + DX[rot] * 2) * T + 2, (ay + 1 + DY[rot] * 2) * T + 2, T - 4, T - 4); stencil(c, 'TRUCK BAY', (ax + 1.5 + DX[rot] * 2) * T, (ay + 1.6 + DY[rot] * 2) * T, 5, '#fff');
      }
      if (tool === 'hopper' || tool === 'bin') { c.fillStyle = 'rgba(100,220,100,.3)'; for (const [x, y] of sideTilesOf(ax, ay, fw, fh, rot)) c.fillRect(x * T + 2, y * T + 2, T - 4, T - 4); }
      if (tool === 'pump') { c.fillStyle = isWater(ax - DX[rot], ay - DY[rot]) ? 'rgba(100,180,240,.3)' : 'rgba(220,40,30,.3)'; c.fillRect((ax - DX[rot]) * T + 2, (ay - DY[rot]) * T + 2, T - 4, T - 4); }
      c.globalAlpha = .55; if (tool === 'road') drawRoad(c, g); else drawAny(c, g, time, true); c.globalAlpha = 1;
      if (!ok) { c.fillStyle = 'rgba(220,40,30,.35)'; c.fillRect(ax * T, ay * T, fw * T, fh * T); if (err) { c.save(); c.translate((ax + fw / 2) * T, ay * T - 6); c.scale(1 / cam.z, 1 / cam.z); stencil(c, err, 0, 0, 11, '#ffb0a0'); c.restore(); } else if (!inReach(ax, ay, fw, fh)) { c.save(); c.translate((ax + fw / 2) * T, ay * T - 6); c.scale(1 / cam.z, 1 / cam.z); stencil(c, 'Out of reach', 0, 0, 11, '#ffb0a0'); c.restore(); } }
      drawPortArrows(c, g);
      if (!['pipe', 'chest', 'road'].includes(tool)) drawArrow(c, (ax + fw / 2) * T, (ay + fh / 2) * T, rot, Math.max(fw, fh) >= 3 ? 14 : 8);
    }
  } else if (!overUI) {
    const w = s2w(mx, my), t = truckAt(w.x, w.y);
    const e = get(tx, ty);
    if (t) brackets(c, t._x - 14, t._y - 14, 28, 28);
    else if (e) { const [fw, fh] = fp(e.type, e.dir); brackets(c, e.x * T + 1, e.y * T + 1, fw * T - 2, fh * T - 2); if (e.ports) drawPortArrows(c, e); }
  }
  if (sel && sel.kind === 'ent') { const e = get(sel.x, sel.y); if (e) { const [fw, fh] = fp(e.type, e.dir); brackets(c, e.x * T - 2, e.y * T - 2, fw * T + 4, fh * T + 4, '#7fd4ff'); } }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vg = c.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * .4, vw / 2, vh / 2, Math.max(vw, vh) * .8);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(10,6,2,.35)');
  c.fillStyle = vg; c.fillRect(0, 0, vw, vh);
}
const BLAST = () => S.BLAST_R;
function sideTilesOf(x, y, fw, fh, side) {
  const out = [];
  if (side === 0) for (let i = 0; i < fw; i++) out.push([x + i, y - 1]);
  if (side === 2) for (let i = 0; i < fw; i++) out.push([x + i, y + fh]);
  if (side === 3) for (let j = 0; j < fh; j++) out.push([x - 1, y + j]);
  if (side === 1) for (let j = 0; j < fh; j++) out.push([x + fw, y + j]);
  return out;
}

// =====================================================================
//  main loop
// =====================================================================
let lastT = performance.now(), uiT = 0, miniT = 0;
function frame(now) {
  const dt = Math.min(.1, (now - lastT) / 1000); lastT = now; time += dt;
  if (joined) {
    if (!online) upto = S.tick + Math.min(6, Math.floor(simAcc + dt * 60));   // single-player: real time, never fast-forward
    simAcc += dt * 60;
    const behind = upto - S.tick;
    let n = Math.min(Math.floor(simAcc), behind);
    if (behind > 8) n = Math.min(behind - 2, 120);
    for (let i = 0; i < n; i++) simStep();
    simAcc = behind > 8 || n <= 0 ? Math.min(simAcc, 1) : simAcc - n;
    if (simAcc > 2) simAcc = 2;
    movePlayer(dt);
    infestCool -= dt;
  }
  const kc = Math.min(1, dt * 7);
  cam.x += (me.x * T - cam.x) * kc; cam.y += (me.y * T - cam.y) * kc;
  for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.x += p.vx; p.y += p.vy; if (p.k === 'fire') { p.vx *= .97; p.vy *= .97; } if (++p.life > p.max) particles.splice(i, 1); }
  for (let i = tracers.length - 1; i >= 0; i--) if ((tracers[i].t -= dt) <= 0) tracers.splice(i, 1);
  for (let i = splats.length - 1; i >= 0; i--) if ((splats[i].t += dt) > 60) splats.splice(i, 1);
  for (let i = beams.length - 1; i >= 0; i--) if ((beams[i].t -= dt) <= 0) beams.splice(i, 1);
  for (let i = rings.length - 1; i >= 0; i--) if ((rings[i].t += dt * .8) >= 1) rings.splice(i, 1);
  try { render(dt, Math.max(0, Math.min(1, simAcc))); } catch (err) { if (!window.__renderErr) { window.__renderErr = err; console.error(err); } }   // a drawing bug must never stall the simulation
  updateHover();
  if ((uiT += dt) > .2) { uiT = 0; if (joined) { updateHud(); refreshInspect(false); } }
  if ((miniT += dt) > .5) { miniT = 0; drawMini(); }
  requestAnimationFrame(frame);
}

// =====================================================================
//  boot
// =====================================================================
(function boot() {
  try { me.name = localStorage.getItem('rw-name') || ''; me.col = localStorage.getItem('rw-col') || SWATCH[Math.random() * SWATCH.length | 0]; } catch (e) { me.col = SWATCH[0]; }
  $('joinName').value = me.name;
  $('swatches').innerHTML = SWATCH.map(s => `<span class="swc${s === me.col ? ' on' : ''}" data-c="${s}" style="background:${s}"></span>`).join('');
  $('swatches').onclick = e => { const s = e.target.dataset.c; if (!s) return; me.col = s; for (const el of $('swatches').children) el.classList.toggle('on', el.dataset.c === s); };
  $('joinBtn').onclick = startGame;
  buildMiniBase(); buildBar(); updToolInfo();
  connect();
  requestAnimationFrame(frame);
  window.G = { S, me, others, cmd, get sel() { return sel; }, setTool, feed };
})();
})();
