// engine/tempo.js — live tempo + beat-grid tracking for one deck. Pure: runs in the
// offscreen document (and Node tests), fed by ODF frames whose timestamps are input-frame
// indices, so results never depend on when this code happens to run.

export const DEFAULTS = Object.freeze({
  lo: 70, hi: 180, wideLo: 55, wideHi: 220, priorCenter: 120, priorSigmaOct: 1.0,
  windowSec: 8, phaseSec: 6, grid: 0.05, harmonics: [1, 1, 0.5, 0.5], smoothSigma: 1.5,
  fineSpanSec: 16, phaseOffsetMs: 4,
});

class Ring {
  constructor(n) { this.n = n; this.a = new Float32Array(n); this.w = 0; this.count = 0; }
  push(v) { this.a[this.w] = v; this.w = (this.w + 1) % this.n; if (this.count < this.n) this.count++; }
  last(m, out) { const s = (this.w - m + this.n * 2) % this.n; for (let i = 0; i < m; i++) out[i] = this.a[(s + i) % this.n]; return out; }
  clear() { this.w = 0; this.count = 0; }
}

function gaussSmooth(x, sigma) {
  if (!sigma) return x;
  const R = Math.ceil(3 * sigma), k = [];
  let ks = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); ks += v; }
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let j = -R; j <= R; j++) { const q = Math.min(x.length - 1, Math.max(0, i + j)); s += x[q] * k[j + R]; }
    y[i] = s / ks;
  }
  return y;
}

/** Onset strength above its local mean, smoothed: what the tempo combs correlate. */
function onsetCurve(x, sigma) {
  const W = x.length, y = new Float32Array(W);
  for (let i = 0; i < W; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 8); j <= Math.min(W - 1, i + 7); j++) { s += x[j]; c++; }
    y[i] = Math.max(0, x[i] - s / c);
  }
  return gaussSmooth(y, sigma);
}

const rel = (a, b) => Math.abs(a / b - 1);
const RELATED = [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3]; // tempo ratios that count as the same beat
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Tempos a manual ½× / 2× may reach. */
export const MANUAL_BPM = Object.freeze([DEFAULTS.wideLo / 2, DEFAULTS.wideHi * 2]);

/** Power-of-two factor that folds bpm into [lo, hi] (1 when there is no tempo). */
export function octaveFold(bpm, lo, hi) {
  let f = 1;
  if (bpm > 0) { while (bpm * f < lo) f *= 2; while (bpm * f > hi) f /= 2; }
  return f;
}

export class TempoTracker {
  constructor(fps, opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.fps = fps;
    const cap = Math.ceil(12 * fps);
    this.full = new Ring(cap);
    this.low = new Ring(cap);
    this.lastT = 0; this.spf = 0; this.frames = 0;
    this.reset();
  }

  reset() {
    this.full.clear(); this.low.clear();
    this.state = 'search'; this.bpm = 0; this.cand = null; this.candCount = 0; this.conf = 0;
    this.beats = []; this.anchor = null; this.fineBpm = 0; this.fit = null; this.out = 0;
    this.holdUntil = 0; this.phaseFrom = 0;
  }

  resetFine() { this.beats = []; this.fit = null; this.anchor = null; this.fineBpm = 0; this.out = 0; }

  /** The input tempo changed by `ratio` at input frame tChange (assist step). */
  rateChanged(ratio, tChange, marginSec = 0.3) {
    const sr = this.spf * this.fps || 48000;
    if (this.bpm) this.bpm *= ratio;
    if (this.cand) this.cand *= ratio;
    this.resetFine();
    this.holdUntil = tChange + this.o.windowSec * sr;
    this.phaseFrom = tChange + marginSec * sr;
  }

  pushFrame(full, low, t) {
    if (this.frames > 0) this.spf = t - this.lastT;
    this.full.push(full); this.low.push(low); this.lastT = t; this.frames++;
  }

  estimate() {
    const o = this.o, fps = this.fps;
    const W = Math.min(this.full.count, Math.round(o.windowSec * fps));
    if (W < 4 * fps) return null;
    const y = onsetCurve(this.full.last(W, new Float32Array(W)), o.smoothSigma);
    let mean = 0; for (let i = 0; i < W; i++) mean += y[i]; mean /= W;
    let energy = 0; for (let i = 0; i < W; i++) { y[i] -= mean; energy += y[i] * y[i]; }
    if (energy / W < 1e-4) return { silent: true };
    const maxLag = Math.min(W - 2, Math.ceil((4 * 60 * fps) / o.wideLo) + 2);
    const r = new Float32Array(maxLag + 1);
    for (let L = 0; L <= maxLag; L++) { let s = 0; for (let i = L; i < W; i++) s += y[i] * y[i - L]; r[L] = s / (W - L); }
    const r0 = r[0];
    const interp = (lag) => { const i = Math.floor(lag), f = lag - i; return i + 1 > maxLag ? 0 : r[i] * (1 - f) + r[i + 1] * f; };
    const nG = Math.round((o.wideHi - o.wideLo) / o.grid) + 1;
    const S = new Float32Array(nG), Sw = new Float32Array(nG);
    let wsum = 0; for (const w of o.harmonics) wsum += w;
    for (let g = 0; g < nG; g++) {
      const bpm = o.wideLo + g * o.grid, tau = (60 * fps) / bpm;
      let s = 0; for (let k = 0; k < o.harmonics.length; k++) s += o.harmonics[k] * interp((k + 1) * tau);
      s /= wsum * r0;
      const lp = -0.5 * (Math.log2(bpm / o.priorCenter) / o.priorSigmaOct) ** 2;
      S[g] = s; Sw[g] = Math.max(0, s) * Math.exp(lp);
    }
    let best = 0; for (let g = 1; g < nG; g++) if (Sw[g] > Sw[best]) best = g;
    let off = 0;
    if (best > 0 && best < nG - 1) { const a = Sw[best - 1], b = Sw[best], c = Sw[best + 1]; const d = a - 2 * b + c; if (d < 0) off = (0.5 * (a - c)) / d; }
    let bpm = o.wideLo + (best + off) * o.grid;
    while (bpm < o.lo) bpm *= 2;
    while (bpm > o.hi) bpm /= 2;
    const related = (b) => { for (let i = 0; i < RELATED.length; i++) if (Math.abs(b / (bpm * RELATED[i]) - 1) < 0.04) return true; return false; };
    let second = 1e-9;
    for (let g = 0; g < nG; g++) { const b = o.wideLo + g * o.grid; if (!related(b) && Sw[g] > second) second = Sw[g]; }
    const salience = S[best], peakRatio = Sw[best] / second;
    const conf = clamp01((salience - 0.05) / 0.25) * clamp01((peakRatio - 1) / 0.6);
    return { bpm, salience, peakRatio, conf };
  }

  update(est) {
    if (!est || est.silent) return this.snapshot(est && est.silent ? 'hold' : undefined);
    if (this.holdUntil && this.lastT < this.holdUntil) return this.snapshot();
    if (this.state === 'search' || this.bpm === 0) {
      if (est.conf < 0.25) return this.snapshot();
      if (this.cand && rel(est.bpm, this.cand) < 0.02) this.candCount++; else { this.cand = est.bpm; this.candCount = 1; }
      if (this.candCount >= 3) { this.state = 'locked'; this.bpm = est.bpm; this.cand = null; this.candCount = 0; }
      this.conf = est.conf;
      return this.snapshot();
    }
    if (rel(est.bpm, this.bpm) < 0.02) {
      this.bpm += 0.2 * (est.bpm - this.bpm);
      this.conf += 0.3 * (est.conf - this.conf);
      this.cand = null; this.candCount = 0;
    } else {
      const octave = [2, 0.5, 1.5, 2 / 3].some((m) => rel(est.bpm, this.bpm * m) < 0.03);
      const need = octave ? 6 : 3;
      if (this.cand && rel(est.bpm, this.cand) < 0.02) this.candCount++; else { this.cand = est.bpm; this.candCount = 1; }
      if (this.candCount >= need && est.conf > (octave ? 0.5 : 0.3)) {
        this.bpm = est.bpm; this.conf = est.conf; this.cand = null; this.candCount = 0;
        this.resetFine();
      } else this.conf *= 0.9;
    }
    return this.snapshot();
  }

  bestBpm() { return this.fineBpm && rel(this.fineBpm, this.bpm) < 0.01 ? this.fineBpm : this.bpm; }
  snapshot(tag) { return { state: tag || this.state, bpm: this.bestBpm(), coarse: this.bpm, conf: this.conf }; }

  /**
   * Input frame where tempo bpmB took over from bpmA within the onset history: the split that
   * best explains the frames before it by bpmA's beat comb and the frames after it by bpmB's.
   */
  changePoint(bpmA, bpmB) {
    const W = this.full.count, H = this.o.harmonics;
    if (W < 2 || !this.spf) return this.lastT;
    const y = onsetCurve(this.full.last(W, new Float32Array(W)), this.o.smoothSigma);
    const at = (pos) => { const i = Math.floor(pos), f = pos - i; return i < 0 || i + 1 >= W ? 0 : y[i] * (1 - f) + y[i + 1] * f; };
    const comb = (i, tau) => { let s = 0; for (let k = 0; k < H.length; k++) s += H[k] * (at(i - (k + 1) * tau) + at(i + (k + 1) * tau)); return y[i] * s; };
    const tauA = (60 * this.fps) / bpmA, tauB = (60 * this.fps) / bpmB;
    let acc = 0, best = 0, split = 0;
    for (let i = 0; i < W; i++) { acc += comb(i, tauA) - comb(i, tauB); if (acc > best) { best = acc; split = i + 1; } }
    return Math.min(this.lastT, this.lastT - (W - 1 - split) * this.spf);
  }

  /** Phase comb at `bpm` (already multiplied by `mult`). Returns times in input frames. */
  phase(bpm, mult = 1) {
    const o = this.o, fps = this.fps;
    let W = Math.min(this.full.count, Math.round(o.phaseSec * fps));
    if (this.phaseFrom && this.lastT > this.phaseFrom) {
      const since = Math.floor((this.lastT - this.phaseFrom) / this.spf);
      if (since < W) W = Math.max(since, Math.ceil((2.2 * 60 * fps) / bpm));
    }
    W = Math.min(W, this.full.count);
    const f = this.full.last(W, new Float32Array(W)), l = this.low.last(W, new Float32Array(W));
    let mf = 1e-9, ml = 1e-9; for (let i = 0; i < W; i++) { mf += f[i]; ml += l[i]; } mf /= W; ml /= W;
    const z = new Float32Array(W);
    for (let i = 0; i < W; i++) z[i] = f[i] / mf + l[i] / ml;
    const s = gaussSmooth(z, 1);
    const at = (pos) => { const i = Math.floor(pos), fr = pos - i; if (i < 0 || i + 1 >= W) return 0; return s[i] * (1 - fr) + s[i + 1] * fr; };
    const tau = (60 * fps) / bpm;
    const K = Math.max(2, Math.floor((W - 2) / tau));
    const newest = W - 2, step = 0.25, nP = Math.ceil(tau / step);
    const P = new Float32Array(nP);
    for (let p = 0; p < nP; p++) { const phi = p * step; let acc = 0, g = 1; for (let k = 0; k < K; k++) { acc += g * at(newest - phi - k * tau); g *= 0.9; } P[p] = acc; }
    let best = 0; for (let p = 1; p < nP; p++) if (P[p] > P[best]) best = p;
    const a = P[(best - 1 + nP) % nP], b = P[best], c = P[(best + 1) % nP];
    const d = a - 2 * b + c, off = d < 0 ? (0.5 * (a - c)) / d : 0;
    let mean = 0; for (let p = 0; p < nP; p++) mean += P[p]; mean /= nP;
    const framesBack = W - 1 - newest + (best + off) * step;
    const sr = this.spf * fps;
    const beatT = this.lastT - framesBack * this.spf + (o.phaseOffsetMs / 1000) * sr;
    this.addBeat(beatT, tau * this.spf, mult);
    return { beatT, periodT: tau * this.spf, clarity: b / mean };
  }

  addBeat(t, T, mult) {
    if (this.anchor == null) { this.anchor = t; this.out = 0; }
    const sr = this.spf * this.fps;
    if (this.fit && this.beats.length >= 8) {
      const n = Math.round((t - this.fit.b) / this.fit.a);
      const resid = t - (this.fit.b + n * this.fit.a);
      if (Math.abs(resid) > 0.1 * T) {
        if (++this.out >= 4) { this.beats = []; this.anchor = t; this.fit = null; this.fineBpm = 0; this.out = 0; }
        return;
      }
      this.out = 0;
    }
    const n = Math.round((t - this.anchor) / T);
    const last = this.beats[this.beats.length - 1];
    if (last && last.n === n) last.t = t; else this.beats.push({ n, t });
    while (this.beats.length && t - this.beats[0].t > this.o.fineSpanSec * sr) this.beats.shift();
    if (this.beats.length < 8) return;
    let sn = 0, st = 0, snn = 0, snt = 0; const m = this.beats.length;
    for (const bt of this.beats) { sn += bt.n; st += bt.t; snn += bt.n * bt.n; snt += bt.n * bt.t; }
    const a = (m * snt - sn * st) / (m * snn - sn * sn);
    const b0 = (st - a * sn) / m;
    if (a > 0) { this.fit = { a, b: b0 }; this.fineBpm = (60 * sr) / a / mult; }
  }
}

export class BeatClock {
  constructor() { this.t0 = null; this.T = 0; this.miss = 0; }
  update(tMeas, T, beta = 0.3) {
    this.T = T;
    if (this.t0 == null) { this.t0 = tMeas; return this.t0; }
    const k = Math.round((tMeas - this.t0) / T), pred = this.t0 + k * T, e = tMeas - pred;
    if (Math.abs(e) < T / 4) { this.t0 = pred + beta * e; this.miss = 0; }
    else if (++this.miss >= 3) { this.t0 = tMeas; this.miss = 0; }
    else this.t0 = pred;
    return this.t0;
  }
}

/** One deck's tempo state: tracker + beat clock + manual corrections (×2/½, TAP, GRID, TAP 1). */
export class DeckTempo {
  constructor({ sampleRate, fps, lo = DEFAULTS.lo, hi = DEFAULTS.hi }) {
    this.sr = sampleRate;
    this.fps = fps;
    this.tracker = new TempoTracker(fps, { lo, hi });
    this.estEvery = Math.max(1, Math.round(0.5 * fps));
    this.reset();
  }

  reset() {
    this.tracker.reset();
    this.clock = new BeatClock();
    this.mult = 1;
    this.tapped = null;
    this.taps = [];
    this.bar1 = null;
    this.gridOffset = 0;
    this.sinceEst = 0;
    this.snap = { state: 'search', bpm: 0, coarse: 0, conf: 0 };
    // The track the tracker follows: n counts tracks, from (input s) is where this one took over
    // and prev is the previous track's grid as it stood there.
    this.track = { n: this.track ? this.track.n + 1 : 0, from: this.tracker.lastT / this.sr, prev: null };
    this.hist = []; // recent beat-clock states {t, t0, T} (input frames), oldest first
  }

  /**
   * New BPM range: fold the tempo into it by octaves, keeping the lock, the grid (anchor beat
   * kept, period scaled), the taps and bar 1. Returns the factor applied to the tempo.
   */
  setRange(lo, hi) {
    const tr = this.tracker;
    const f = octaveFold(this.bpmIn(), lo, hi), fTr = octaveFold(tr.bpm, lo, hi);
    tr.o.lo = lo; tr.o.hi = hi;
    tr.cand = null; tr.candCount = 0;
    if ((f !== 1 || fTr !== 1) && this.snap.bpm) { tr.bpm = this.snap.bpm * fTr; tr.resetFine(); }
    if (this.tapped) this.tapped.bpm *= f;
    else this.mult *= f / fTr;
    if (f !== 1) {
      if (this.clock.T) this.clock.T /= f;
      const T = this.clock.T;
      if (T && Math.abs(this.gridOffset) > T / 2) this.gridOffset -= Math.round(this.gridOffset / T) * T;
      for (const h of this.hist) h.T /= f;
    }
    this.snap = { ...this.snap, bpm: tr.bestBpm(), coarse: tr.bpm };
    return f;
  }

  /** Remember the beat clock as it stands now, for the grid an old track keeps after a track change. */
  remember() {
    const t = this.tracker.lastT;
    this.hist.push({ t, t0: this.clock.t0, T: this.clock.T });
    while (this.hist.length && this.hist[0].t < t - 16 * this.sr) this.hist.shift();
  }

  /** The grid (input s) as it stood when the live edge reached input frame `from`. */
  gridBefore(from) {
    let h = null;
    for (const e of this.hist) { if (e.t <= from) h = e; else break; }
    h = h || this.hist[0] || (this.clock.t0 != null && this.clock.T > 0 ? this.clock : null);
    return h ? { t0: h.t0 / this.sr, T: h.T / this.sr, bar1: this.bar1 == null ? null : this.bar1 / this.sr } : null;
  }

  pushBatch({ t0, spf, full, low }) { for (let i = 0; i < full.length; i++) this.pushFrame(full[i], low[i], t0 + i * spf); }

  pushFrame(full, low, t) {
    this.tracker.pushFrame(full, low, t);
    if (++this.sinceEst >= this.estEvery) { this.sinceEst = 0; this.evaluate(); }
  }

  /** True when the last 1.5 s of onset energy is under 10% of the 8 s mean (breakdown, pause, silence). */
  recentlyQuiet() {
    const tr = this.tracker, nR = Math.round(1.5 * this.fps), nL = Math.min(tr.full.count, Math.round(8 * this.fps));
    if (tr.full.count < nR || nL <= nR) return false;
    const mean = (n) => { const a = tr.full.last(n, new Float32Array(n)); let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s / n; };
    const r = mean(nR), l = mean(nL);
    return r < 1e-4 || r < 0.1 * l;
  }

  evaluate() {
    const prev = this.snap.coarse;
    if (this.clock.t0 != null && this.clock.T > 0) this.remember();
    this.snap = this.tracker.update(this.tracker.estimate());
    if (this.snap.state !== 'hold' && this.snap.bpm && this.recentlyQuiet()) this.snap = this.tracker.snapshot('hold');
    if (prev && this.snap.coarse && rel(this.snap.coarse, prev) > 0.03 && this.snap.state !== 'hold') {
      // The tracker accepted a new tempo (new track): manual corrections no longer apply. The new
      // track starts where its beats took over (the playhead may still be playing the old one),
      // and the old track keeps the grid it had there, before the new beats could pull the clock.
      const from = this.tracker.changePoint(prev, this.snap.coarse);
      this.track = { n: this.track.n + 1, from: from / this.sr, prev: this.gridBefore(from) };
      this.mult = 1; this.tapped = null; this.gridOffset = 0; this.clock = new BeatClock(); this.bar1 = null; this.hist = [];
    }
    const bpm = this.bpmIn();
    const usable = this.tapped || this.tracker.state === 'locked';
    if (!bpm || !usable || this.snap.state === 'hold') return;
    if (this.tracker.full.count < (2.2 * 60 * this.fps) / bpm) return;
    const ph = this.tracker.phase(bpm, this.tapped ? 1 : this.mult);
    if (ph.clarity >= 2 || this.clock.t0 == null) this.clock.update(ph.beatT + this.gridOffset, ph.periodT);
    else this.clock.T = ph.periodT;
  }

  bpmIn() {
    if (this.tapped) return this.tapped.bpm;
    return this.snap.bpm ? this.snap.bpm * this.mult : 0;
  }

  /** ½× / 2×. A tapped tempo is scaled (keeping its anchor beat), not discarded. Returns false if refused. */
  multiply(factor) {
    if (this.tapped) {
      const bpm = this.tapped.bpm * factor;
      if (bpm < MANUAL_BPM[0] || bpm > MANUAL_BPM[1]) return false;
      this.tapped.bpm = bpm;
      this.clock.T /= factor;
    } else {
      const next = this.mult * factor;
      if (next < 0.25 || next > 4) return false;
      this.mult = next;
      this.gridOffset = 0;
      this.clock = new BeatClock();
    }
    this.tracker.resetFine();
    for (const h of this.hist) h.T /= factor;
    return true;
  }

  /** Record a tap (input frame) and fit the taps so far: {bpm, t0, T} (input frames) or null. */
  tapFit(inFrame) {
    const last = this.taps[this.taps.length - 1];
    if (last != null && inFrame - last > 2 * this.sr) this.taps = [];
    this.taps.push(inFrame);
    if (this.taps.length > 9) this.taps.shift();
    if (this.taps.length < 4) return null;
    const iv = this.taps.slice(1).map((t, i) => t - this.taps[i]).sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    if (!(med > 0)) return null;
    // Least-squares line through the taps, indexed by whole beats: robust to alternating jitter.
    const first = this.taps[0], m = this.taps.length;
    let sn = 0, st = 0, snn = 0, snt = 0;
    for (const t of this.taps) { const n = Math.round((t - first) / med); sn += n; st += t; snn += n * n; snt += n * t; }
    const den = m * snn - sn * sn;
    const period = den > 0 ? (m * snt - sn * st) / den : med;
    if (!(period > 0)) return null;
    const b0 = (st - period * sn) / m;
    const nLast = Math.round((this.taps[m - 1] - first) / med);
    return { bpm: (60 * this.sr) / period, t0: b0 + nLast * period, T: period };
  }

  /** Use a tapped grid ({t0, T} in input frames, at the live edge's source rate) as the tempo. */
  applyTap({ t0, T }) {
    this.tapped = { bpm: (60 * this.sr) / T };
    this.mult = 1;
    this.gridOffset = 0;
    this.clock = new BeatClock();
    this.clock.t0 = t0;
    this.clock.T = T;
    this.hist = [];
  }

  tap(inFrame) {
    const fit = this.tapFit(inFrame);
    if (!fit) return null;
    this.applyTap(fit);
    return fit.bpm;
  }

  shiftGrid({ beats = 0, ms = 0 }) {
    if (this.clock.t0 == null || !this.clock.T) return;
    const T = this.clock.T;
    const delta = beats * T + (ms / 1000) * this.sr;
    this.gridOffset += delta;
    if (Math.abs(this.gridOffset) > T / 2) this.gridOffset -= Math.round(this.gridOffset / T) * T;
    this.clock.t0 += delta;
    for (const h of this.hist) h.t0 += beats * h.T + (ms / 1000) * this.sr;
  }

  /** Bar 1 at the beat nearest inFrame (or exactly at inFrame when snap is false). */
  setBar1(inFrame, snap = true) {
    const { t0, T } = this.clock;
    this.bar1 = snap && t0 != null && T ? t0 + Math.round((inFrame - t0) / T) * T : inFrame;
  }

  sourceRateChanged(ratio, atFrame) {
    if (!(ratio > 0) || ratio === 1) return;
    this.tracker.rateChanged(ratio, atFrame);
    if (this.tapped) this.tapped.bpm *= ratio;
    if (this.clock.t0 != null && this.clock.T) {
      const k = Math.floor((atFrame - this.clock.t0) / this.clock.T);
      this.clock.t0 += k * this.clock.T;
      this.clock.T /= ratio;
      this.clock.miss = 0;
    }
    this.gridOffset /= ratio;
    this.snap = { ...this.snap, bpm: this.snap.bpm * ratio, coarse: this.snap.coarse * ratio };
  }

  get() {
    const bpm = this.bpmIn();
    const tr = this.tracker;
    let state;
    if (this.tapped) state = 'LOCKED';
    else if (this.snap.state === 'hold' && bpm) state = 'HOLD';
    else if (tr.state === 'locked') state = tr.conf >= 0.5 ? 'LOCKED' : 'UNSURE';
    else state = 'SEARCH';
    const grid = this.clock.t0 != null && this.clock.T > 0
      ? { t0: this.clock.t0 / this.sr, T: this.clock.T / this.sr, bar1: this.bar1 == null ? null : this.bar1 / this.sr }
      : null;
    const canBeat = !!grid && (!!this.tapped || (tr.state === 'locked' && tr.conf >= 0.5));
    return { state, inBpm: bpm || null, conf: this.tapped ? 1 : tr.conf, mult: this.mult, tapped: !!this.tapped, grid, canBeat, track: this.track };
  }
}
