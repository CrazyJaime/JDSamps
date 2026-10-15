// ui/waveform.js — waveform memory and the scrolling renderer.
// Data arrives as 3 bytes (low, mid, high) per ODF hop on the deck's input timeline.
// The view is centred on the playhead and scaled in *beats* (when a grid exists), so synced
// decks show identical grid spacing and their beats line up vertically across rows.
// The bands are drawn once into cached tiles at a fixed time scale (appended per hop as audio
// arrives) and blitted every frame; only the grid, markers and playhead are drawn per frame.

export class WaveStore {
  constructor() { this.hop = 0; this.t0 = 0; this.data = new Uint8Array(0); this.n = 0; this.rev = 0; }

  add({ tStart, hop, data }) {
    if (!(hop > 0) || !data || !data.length) return;
    if (!this.hop) { this.hop = hop; this.t0 = tStart; }
    const i0 = Math.round((tStart - this.t0) / this.hop);
    if (i0 < 0) return;
    if (i0 < this.n) this.rev++; // rewrites audio already drawn: cached tiles are stale
    const count = Math.floor(data.length / 3);
    const need = (i0 + count) * 3;
    if (need > this.data.length) {
      let cap = Math.max(4096, this.data.length);
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.data);
      this.data = next;
    }
    this.data.set(data.subarray ? data.subarray(0, count * 3) : data.slice(0, count * 3), i0 * 3);
    this.n = Math.max(this.n, i0 + count);
  }

  /** Max of each band over [tIn, tIn+span). */
  at(tIn, span, out) {
    if (!this.hop) return null;
    let a = Math.floor((tIn - this.t0) / this.hop);
    let b = Math.max(a + 1, Math.ceil((tIn + span - this.t0) / this.hop));
    if (b <= 0 || a >= this.n) return null;
    a = Math.max(0, a); b = Math.min(this.n, b);
    let l = 0, m = 0, h = 0;
    for (let i = a; i < b; i++) {
      const j = i * 3;
      if (this.data[j] > l) l = this.data[j];
      if (this.data[j + 1] > m) m = this.data[j + 1];
      if (this.data[j + 2] > h) h = this.data[j + 2];
    }
    out[0] = l; out[1] = m; out[2] = h;
    return out;
  }
}

export function beatIndex(grid, playhead) {
  return grid ? Math.floor((playhead - grid.t0) / grid.T + 1e-9) : 0;
}

const tmp = [0, 0, 0];
const lvl = (b) => Math.max(0, (b - 40) / 215);
const TILE = 512;          // cached tile width, device px
const SCALE_SLACK = 0.03;  // tiles are stretched to fit while the time scale moves less than this
const caches = new WeakMap(); // canvas context -> tile cache and last drawn view
const levels = new Float32Array(TILE * 3);

/**
 * opts: {w, h (device px), store, playhead, grid, cue, liveEdge, historyStart, loop, color,
 *        pxPerBeat, pxPerSec, playing, dpr?}
 */
export function drawWave(g, o) {
  const { w, h, store, grid, loop } = o;
  const secPerPx = grid ? grid.T / o.pxPerBeat : 1 / o.pxPerSec;
  let c = caches.get(g);
  if (!c) caches.set(g, (c = { view: '', tiles: new Map(), free: [], spp: 0, h: 0, color: '', mid: '', store: null, rev: 0 }));
  // Nothing moved (a paused deck, no new audio): the canvas already shows this view.
  const view = `${w},${h},${o.playhead},${secPerPx},${grid ? `${grid.t0},${grid.bar1}` : '-'},${o.cue},${o.liveEdge},${o.historyStart},`
    + `${loop ? `${loop.start},${loop.end}` : '-'},${o.color},${o.playing},${store.n},${store.rev}`;
  if (view === c.view) return;
  c.view = view;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, w, h);
  const cx = Math.round(w / 2);
  const tAt = (x) => o.playhead + (x - cx) * secPerPx;
  const xAt = (t) => cx + (t - o.playhead) / secPerPx;

  // Loop region.
  if (o.loop) {
    g.fillStyle = 'rgba(255,255,255,0.08)';
    const x0 = xAt(o.loop.start), x1 = xAt(o.loop.end);
    g.fillRect(x0, 0, x1 - x0, h);
  }

  // Waveform from the tile cache, dimmed left of the playhead (already played).
  const tA = Math.max(tAt(0), o.historyStart, store.t0), tB = Math.min(tAt(w), o.liveEdge, store.t0 + store.n * store.hop);
  if (store.hop && tB > tA) {
    syncTiles(c, o, secPerPx);
    const span = TILE * c.spp, i0 = Math.floor((tA - store.t0) / span), i1 = Math.floor((tB - store.t0) / span);
    for (let i = i0; i <= i1; i++) tileAt(c, i);
    const xa = Math.round(xAt(tA)), xb = Math.round(xAt(tB));
    blit(g, c, i0, i1, xa, Math.min(cx, xb), true, xAt);
    blit(g, c, i0, i1, Math.max(cx, xa), xb, false, xAt);
    for (const [i, t] of c.tiles) if (i < i0 - 1 || i > i1 + 1) { c.tiles.delete(i); c.free.push(t); }
  }

  // Region beyond the live edge: no audio yet.
  const xl = xAt(o.liveEdge);
  if (xl < w) {
    g.fillStyle = 'rgba(20,23,32,0.9)';
    g.fillRect(Math.max(0, xl), 0, w - Math.max(0, xl), h);
    g.strokeStyle = 'rgba(251,191,36,0.85)';
    g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(xl + 0.5, 0); g.lineTo(xl + 0.5, h); g.stroke();
    g.setLineDash([]);
  }

  // Beat grid; once bar 1 is known (TAP 1) bar lines are bold and numbered from it.
  if (grid) {
    const { t0, T } = grid;
    const k0 = Math.ceil((tAt(0) - t0) / T), k1 = Math.floor((tAt(w) - t0) / T);
    const barRef = grid.bar1 != null ? Math.round((grid.bar1 - t0) / T) : null;
    const isBar = (k) => barRef != null && (((k - barRef) % 4) + 4) % 4 === 0;
    const lineX = (k) => Math.round(xAt(t0 + k * T)) + 0.5;
    g.fillStyle = 'rgba(255,255,255,0.22)';
    for (let k = k0; k <= k1; k++) if (!isBar(k)) g.fillRect(lineX(k) - 0.5, 0, 1, h);
    if (barRef != null) {
      const kb0 = barRef + 4 * Math.ceil((k0 - barRef) / 4);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      for (let k = kb0; k <= k1; k += 4) g.fillRect(lineX(k) - 1, 0, 2, h);
      const dpr = o.dpr || globalThis.devicePixelRatio || 1, fs = Math.round(9 * dpr), pad = Math.round(2 * dpr);
      g.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
      g.textBaseline = 'top';
      for (let k = Math.max(kb0, barRef); k <= k1; k += 4) {
        const label = String((k - barRef) / 4 + 1), x = lineX(k) + pad;
        g.fillStyle = 'rgba(5,6,10,0.7)';
        g.fillRect(x - 1, 0, Math.ceil(label.length * fs * 0.62) + 2, fs + pad);
        g.fillStyle = 'rgba(255,255,255,0.8)';
        g.fillText(label, x, pad / 2);
      }
    }
  }

  // Cue marker.
  const xc = xAt(o.cue);
  if (xc >= -8 && xc <= w + 8) {
    g.fillStyle = '#f59e0b';
    g.beginPath(); g.moveTo(xc - 6, 0); g.lineTo(xc + 6, 0); g.lineTo(xc, 9); g.fill();
    g.beginPath(); g.moveTo(xc - 6, h); g.lineTo(xc + 6, h); g.lineTo(xc, h - 9); g.fill();
  }

  // Playhead.
  g.fillStyle = o.playing ? '#ffffff' : '#f59e0b';
  g.fillRect(cx - 1, 0, 2, h);
}

/** Drop the tiles when what they show changed: new store, rewritten audio, size, colour or scale. */
function syncTiles(c, o, spp) {
  const { store } = o;
  if (c.store === store && c.rev === store.rev && c.h === o.h && c.color === o.color && Math.abs(spp / c.spp - 1) <= SCALE_SLACK) return;
  if (c.h === o.h) c.free.push(...c.tiles.values()); else c.free.length = 0;
  c.tiles.clear();
  Object.assign(c, { store, rev: store.rev, h: o.h, color: o.color, mid: mixWhite(o.color, 0.45), spp });
}

/**
 * Tile i covers input time [t0 + i·TILE·spp, t0 + (i+1)·TILE·spp); new audio is painted in as it
 * arrives. Rows 0..h hold the bands at full strength, rows h..2h the dimmed copy for played audio.
 */
function tileAt(c, i) {
  let t = c.tiles.get(i);
  if (!t) {
    t = c.free.pop();
    if (!t) {
      const cv = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(TILE, 2 * c.h) : Object.assign(document.createElement('canvas'), { width: TILE, height: 2 * c.h });
      t = { cv, g: cv.getContext('2d') };
    }
    t.g.clearRect(0, 0, TILE, 2 * c.h);
    t.col = 0; t.n = -1;
    c.tiles.set(i, t);
  }
  if (t.n !== c.store.n && t.col < TILE) paintColumns(c, i, t);
  t.n = c.store.n;
  return t;
}

/** Columns from the first one not yet final up to the audio received so far, batched by band colour. */
function paintColumns(c, i, t) {
  const { store, spp, h } = c, mid = h / 2, tStart = store.t0 + i * TILE * spp;
  const avail = (store.t0 + store.n * store.hop - tStart) / spp;
  const c0 = t.col, c1 = Math.min(TILE, Math.ceil(avail));
  t.col = Math.max(c0, Math.min(TILE, Math.floor(avail)));
  if (c1 <= c0) return;
  for (let x = c0; x < c1; x++) {
    const j = x * 3;
    if (store.at(tStart + x * spp, spp, tmp)) { levels[j] = lvl(tmp[0]) * mid; levels[j + 1] = lvl(tmp[1]) * mid * 0.8; levels[j + 2] = lvl(tmp[2]) * mid * 0.6; }
    else levels[j] = levels[j + 1] = levels[j + 2] = 0;
  }
  // Low (deck colour), mid (lighter), high (white core); each band at half alpha in the dimmed copy.
  const tg = t.g, fills = [c.color, c.mid, 'rgba(255,255,255,0.85)'];
  tg.clearRect(c0, 0, c1 - c0, 2 * h);
  for (const y0 of [0, h]) {
    tg.globalAlpha = y0 ? 0.5 : 1;
    for (let b = 0; b < 3; b++) {
      tg.fillStyle = fills[b];
      for (let x = c0; x < c1; x++) { const v = levels[x * 3 + b]; if (v > 0) tg.fillRect(x, y0 + mid - v, 1, v * 2); }
    }
  }
  tg.globalAlpha = 1;
}

/** Draw tiles i0..i1 into [x0, x1) of the view; tile edges land on whole pixels so they never seam. */
function blit(g, c, i0, i1, x0, x1, dim, xAt) {
  if (x1 <= x0) return;
  const span = TILE * c.spp, t0 = c.store.t0, sy = dim ? c.h : 0;
  g.save();
  g.beginPath(); g.rect(x0, 0, x1 - x0, c.h); g.clip();
  for (let i = i0; i <= i1; i++) {
    const d0 = Math.round(xAt(t0 + i * span)), d1 = Math.round(xAt(t0 + (i + 1) * span));
    if (d1 > x0 && d0 < x1) g.drawImage(c.tiles.get(i).cv, 0, sy, TILE, c.h, d0, 0, d1 - d0, c.h);
  }
  g.restore();
}

function mixWhite(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const m = (c) => Math.round(c + (255 - c) * t);
  return `rgb(${m(r)},${m(gg)},${m(b)})`;
}
