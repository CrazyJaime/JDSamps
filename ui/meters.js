// ui/meters.js — vertical level / gain-reduction meters with peak hold, drawn on canvas.
const FLOOR_DB = -48;
const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const frac = (db) => Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));

export class VMeter {
  constructor(canvas, { channels = 1, mode = 'level' } = {}) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.channels = channels;
    this.mode = mode;
    this.vals = Array.from({ length: channels }, () => ({ peak: 0, rms: 0, hold: 0, holdAt: 0, clip: false }));
    this.gr = 0;
  }

  update(values) {
    const now = performance.now();
    if (this.mode === 'gr') { this.gr = Math.min(0, values.gr || 0); return; }
    values.forEach((v, i) => {
      const s = this.vals[i];
      s.peak = v.peak; s.rms = v.rms; s.clip = !!v.clip;
      if (v.peak >= s.hold || now - s.holdAt > 1200) { s.hold = v.peak; s.holdAt = now; }
    });
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(this.c.clientWidth * dpr)), H = Math.max(1, Math.round(this.c.clientHeight * dpr));
    if (this.c.width !== W || this.c.height !== H) { this.c.width = W; this.c.height = H; }
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#05060a';
    g.fillRect(0, 0, W, H);
    if (this.mode === 'gr') {
      const f = Math.min(1, -this.gr / 20);
      g.fillStyle = '#fb923c';
      g.fillRect(0, 0, W, Math.round(f * H));
      return;
    }
    const gap = Math.max(1, Math.round(dpr)), cw = (W - gap * (this.channels - 1)) / this.channels;
    const grad = g.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, '#22c55e'); grad.addColorStop(0.7, '#a3e635'); grad.addColorStop(0.86, '#fbbf24'); grad.addColorStop(1, '#ef4444');
    this.vals.forEach((s, i) => {
      const x = i * (cw + gap);
      const rh = frac(toDb(s.rms)) * H, ph = frac(toDb(s.peak)) * H, hh = frac(toDb(s.hold)) * H;
      g.globalAlpha = 0.35; g.fillStyle = grad; g.fillRect(x, H - ph, cw, ph);
      g.globalAlpha = 1; g.fillRect(x, H - rh, cw, rh);
      g.fillStyle = s.hold >= 0.999 || s.clip ? '#ef4444' : '#e5e7eb';
      g.fillRect(x, Math.max(0, H - hh - 2 * dpr), cw, 2 * dpr);
    });
    // -6, -12, -24 dB ticks.
    g.fillStyle = 'rgba(0,0,0,0.6)';
    for (const db of [-6, -12, -24]) g.fillRect(0, Math.round(H - frac(db) * H), W, Math.max(1, dpr));
  }
}
