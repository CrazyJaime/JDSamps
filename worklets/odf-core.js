// worklets/odf-core.js — onset detection function (ODF) core, shared by the
// deck-input AudioWorklet and the Node unit tests. push() is allocation-free.
//
// Mono input at ctx.sampleRate -> 4th-order Butterworth LP @ 0.4·fsDec -> decimate by D
// (to ~12 kHz) -> Hann(N=512) FFT every H=128 decimated samples -> log magnitude ->
// "SuperFlux-lite" flux (compare against a 3-bin max of the previous frame) ->
// half-wave-rectified flux for the full band and the low band (<150 Hz), plus
// three waveform band levels (low <250 Hz, mid <2.5 kHz, high) as bytes 0..255.
// Each frame is stamped with the input-frame index of the analysis-window centre.

class Biquad {
  constructor(b0, b1, b2, a1, a2) { this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2; this.z1 = 0; this.z2 = 0; }
  static lowpass(fs, f, q) {
    const w = (2 * Math.PI * f) / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), a0 = 1 + al;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }
  step(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

const toByte = (mag) => {
  const db = 20 * Math.log10(mag + 1e-9);
  const v = Math.round(((db + 60) * 255) / 60);
  return v < 0 ? 0 : v > 255 ? 255 : v;
};

export class OdfCore {
  constructor(sampleRate, onFrame) {
    this.fs = sampleRate;
    this.D = Math.max(1, Math.round(sampleRate / 12000));
    this.fsDec = sampleRate / this.D;
    this.N = 512;
    this.H = 128;
    this.spf = this.H * this.D;
    this.fps = this.fsDec / this.H;
    this.lp1 = Biquad.lowpass(sampleRate, 0.4 * this.fsDec, Math.SQRT1_2);
    this.lp2 = Biquad.lowpass(sampleRate, 0.4 * this.fsDec, Math.SQRT1_2);
    this.ring = new Float32Array(this.N);
    this.w = 0;
    this.sinceHop = 0;
    this.decPhase = 0;
    this.win = new Float32Array(this.N);
    let wsum = 0;
    for (let i = 0; i < this.N; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N); wsum += this.win[i]; }
    this.norm = 2 / wsum;
    this.re = new Float32Array(this.N);
    this.im = new Float32Array(this.N);
    this.K = this.N / 2;
    this.prev = new Float32Array(this.K);
    this.cur = new Float32Array(this.K);
    this.gamma = 100;
    const binHz = this.fsDec / this.N;
    this.lowMaxBin = Math.max(2, Math.round(150 / binHz));
    this.bandLowMax = Math.max(2, Math.round(250 / binHz));
    this.bandMidMax = Math.min(this.K - 2, Math.round(2500 / binHz));
    this.rev = new Uint16Array(this.N);
    const bits = Math.log2(this.N);
    for (let i = 0; i < this.N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float32Array(this.N / 2);
    this.sin = new Float32Array(this.N / 2);
    for (let i = 0; i < this.N / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / this.N); this.sin[i] = -Math.sin((2 * Math.PI * i) / this.N); }
    this.onFrame = onFrame;
    this.primed = false;
  }

  /** @param {Float32Array} block mono samples  @param {number} startFrame input-frame index of block[0] */
  push(block, startFrame) {
    for (let i = 0; i < block.length; i++) {
      const y = this.lp2.step(this.lp1.step(block[i]));
      if (++this.decPhase < this.D) continue;
      this.decPhase = 0;
      this.ring[this.w] = y;
      this.w = (this.w + 1) & (this.N - 1);
      if (++this.sinceHop >= this.H) {
        this.sinceHop = 0;
        this.frame(startFrame + i - (this.N / 2) * this.D);
      }
    }
  }

  frame(tCentre) {
    const N = this.N, re = this.re, im = this.im;
    for (let i = 0; i < N; i++) { const s = this.ring[(this.w + i) & (N - 1)] * this.win[i]; re[this.rev[i]] = s; im[this.rev[i]] = 0; }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let st = 0; st < N; st += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = st + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    const cur = this.cur, prev = this.prev, K = this.K;
    let eL = 0, eM = 0, eH = 0;
    for (let k = 1; k < K; k++) {
      const r = re[k], i = im[k], mag = this.norm * Math.sqrt(r * r + i * i); // not Math.hypot: it allocates per call
      cur[k] = Math.log1p(this.gamma * mag);
      const e = mag * mag;
      if (k <= this.bandLowMax) eL += e; else if (k <= this.bandMidMax) eM += e; else eH += e;
    }
    let full = 0, low = 0;
    if (this.primed) {
      for (let k = 1; k < K; k++) {
        const p = Math.max(prev[k], prev[k - 1], k + 1 < K ? prev[k + 1] : 0);
        const d = cur[k] - p;
        if (d > 0) { full += d; if (k <= this.lowMaxBin) low += d; }
      }
    }
    this.primed = true;
    prev.set(cur);
    this.onFrame(full, low, tCentre, toByte(Math.sqrt(eL)), toByte(Math.sqrt(eM)), toByte(Math.sqrt(eH)));
  }
}
