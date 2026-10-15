// ui/waveform.js — waveform memory and the scrolling renderer.
// Data arrives as 3 bytes (low, mid, high) per ODF hop on the deck's input timeline.
// The view is centred on the playhead and scaled in *beats* (when a grid exists), so synced
// decks show identical grid spacing and their beats line up vertically across rows.

export class WaveStore {
  constructor() { this.hop = 0; this.t0 = 0; this.data = new Uint8Array(0); this.n = 0; }

  add({ tStart, hop, data }) {
    if (!(hop > 0) || !data || !data.length) return;
    if (!this.hop) { this.hop = hop; this.t0 = tStart; }
    const i0 = Math.round((tStart - this.t0) / this.hop);
    if (i0 < 0) return;
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

/**
 * opts: {w, h (device px), store, playhead, grid, cue, liveEdge, historyStart, loop, color,
 *        pxPerBeat, pxPerSec, playing}
 */
export function drawWave(g, o) {
  const { w, h } = o;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, w, h);
  const cx = Math.round(w / 2), mid = h / 2;
  const secPerPx = o.grid ? o.grid.T / o.pxPerBeat : 1 / o.pxPerSec;
  const tAt = (x) => o.playhead + (x - cx) * secPerPx;
  const xAt = (t) => cx + (t - o.playhead) / secPerPx;

  // Loop region.
  if (o.loop) {
    g.fillStyle = 'rgba(255,255,255,0.08)';
    const x0 = xAt(o.loop.start), x1 = xAt(o.loop.end);
    g.fillRect(x0, 0, x1 - x0, h);
  }

  // Waveform columns: low (deck colour), mid (lighter), high (white core).
  const midCol = mixWhite(o.color, 0.45);
  for (let x = 0; x < w; x++) {
    const t = tAt(x);
    if (t < o.historyStart || t > o.liveEdge) continue;
    if (!o.store.at(t, secPerPx, tmp)) continue;
    const past = x < cx;
    g.globalAlpha = past ? 0.5 : 1;
    const hl = lvl(tmp[0]) * mid, hm = lvl(tmp[1]) * mid * 0.8, hh = lvl(tmp[2]) * mid * 0.6;
    g.fillStyle = o.color; g.fillRect(x, mid - hl, 1, hl * 2);
    g.fillStyle = midCol; g.fillRect(x, mid - hm, 1, hm * 2);
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(x, mid - hh, 1, hh * 2);
  }
  g.globalAlpha = 1;

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

  // Beat grid.
  if (o.grid) {
    const { t0, T } = o.grid;
    const k0 = Math.ceil((tAt(0) - t0) / T), k1 = Math.floor((tAt(w) - t0) / T);
    const barRef = o.grid.bar1 != null ? Math.round((o.grid.bar1 - t0) / T) : null;
    for (let k = k0; k <= k1; k++) {
      const x = Math.round(xAt(t0 + k * T)) + 0.5;
      const bar = barRef != null && (((k - barRef) % 4) + 4) % 4 === 0;
      g.fillStyle = bar ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.22)';
      g.fillRect(x - (bar ? 1 : 0.5), 0, bar ? 2 : 1, h);
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

function mixWhite(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const m = (c) => Math.round(c + (255 - c) * t);
  return `rgb(${m(r)},${m(gg)},${m(b)})`;
}
