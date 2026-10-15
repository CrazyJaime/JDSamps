// worklets/master.js — master limiter + meters + engine tick.
// Lookahead brickwall limiter: audio is delayed by L = 5 ms. A sliding-window max of |x|
// over the last W = L+1 samples gives a held required gain h (with a 100 ms release, e <= h);
// a W-tap moving average of e then ramps the applied gain down across the lookahead instead
// of stepping it. Ceiling proof: the output frame n is x[n-L], and every averaged e[n-k],
// k = 0..L, is held from a window [n-k-L, n-k] that contains n-L, so each is <= ceil/|x[n-L]|
// and so is their mean. The delay stays in place when the limiter is off, so toggling never
// shifts timing. Every 1536 frames it posts post-limiter peak/RMS per channel and the deepest
// gain reduction: the engine's tick.

const TICK = 1536;

class Master extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = Math.max(1, Math.round(0.005 * sampleRate));
    this.dl = new Float32Array(this.L);
    this.dr = new Float32Array(this.L);
    this.dw = 0;
    this.W = this.L + 1;
    this.C = this.W + 1;
    this.qv = new Float32Array(this.C);
    this.qi = new Float64Array(this.C);
    this.qh = 0; this.qt = 0; this.qn = 0;
    this.count = 0;
    this.e = 1;
    this.gb = new Float64Array(this.W).fill(1);
    this.gw = 0; this.gs = this.W;
    this.g = 1;
    this.on = true;
    this.ceil = Math.pow(10, -1 / 20);
    this.rel = 1 - Math.exp(-1 / (0.1 * sampleRate));
    this.acc = 0; this.pkL = 0; this.pkR = 0; this.sqL = 0; this.sqR = 0; this.minG = 1;
    this.port.onmessage = (e) => { const m = e.data || {}; if (m.t === 'limiter') this.on = !!m.on; };
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const il = inp && inp.length ? inp[0] : null;
    const ir = inp && inp.length > 1 ? inp[1] : il;
    const ol = out[0], or = out.length > 1 ? out[1] : out[0];
    const n = ol.length, C = this.C, W = this.W, gb = this.gb;
    for (let i = 0; i < n; i++) {
      const xl = il ? il[i] : 0, xr = ir ? ir[i] : 0;
      const w = this.dw;
      const yl = this.dl[w], yr = this.dr[w];
      this.dl[w] = xl; this.dr[w] = xr;
      this.dw = w + 1 === this.L ? 0 : w + 1;
      const al = xl < 0 ? -xl : xl, ar = xr < 0 ? -xr : xr, a = al > ar ? al : ar;
      const id = this.count++;
      while (this.qn > 0) {
        const b = this.qt === 0 ? C - 1 : this.qt - 1;
        if (this.qv[b] <= a) { this.qt = b; this.qn--; } else break;
      }
      this.qv[this.qt] = a; this.qi[this.qt] = id;
      this.qt = this.qt + 1 === C ? 0 : this.qt + 1;
      this.qn++;
      while (this.qi[this.qh] <= id - this.W) { this.qh = this.qh + 1 === C ? 0 : this.qh + 1; this.qn--; }
      const pk = this.qv[this.qh];
      const req = this.on && pk > this.ceil ? this.ceil / pk : 1;
      if (req < this.e) this.e = req; else this.e += (req - this.e) * this.rel;
      const k = this.gw;
      this.gs += this.e - gb[k]; gb[k] = this.e;
      if (k + 1 === W) { this.gw = 0; let s = 0; for (let j = 0; j < W; j++) s += gb[j]; this.gs = s; } else this.gw = k + 1;
      const g = this.g = Math.min(1, this.gs / W);
      const zl = yl * g, zr = yr * g;
      ol[i] = zl;
      if (or !== ol) or[i] = zr;
      const ml = zl < 0 ? -zl : zl, mr = zr < 0 ? -zr : zr;
      if (ml > this.pkL) this.pkL = ml;
      if (mr > this.pkR) this.pkR = mr;
      this.sqL += zl * zl; this.sqR += zr * zr;
      if (g < this.minG) this.minG = g;
      if (++this.acc === TICK) {
        this.port.postMessage({
          t: 'meter', frame: currentFrame + i + 1, peakL: this.pkL, peakR: this.pkR,
          rmsL: Math.sqrt(this.sqL / TICK), rmsR: Math.sqrt(this.sqR / TICK), gr: 20 * Math.log10(this.minG),
        });
        this.acc = 0; this.pkL = 0; this.pkR = 0; this.sqL = 0; this.sqR = 0; this.minG = this.g;
      }
    }
    return true;
  }
}

registerProcessor('jds-master', Master);
