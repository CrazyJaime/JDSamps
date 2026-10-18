// engine/tempo.js — live tempo + beat-grid tracking for one deck. Pure: runs in the
// offscreen document (and Node tests), fed by ODF frames whose timestamps are input-frame
// indices, so results never depend on when this code happens to run.

export const DEFAULTS = Object.freeze({
  lo: 70, hi: 180, wideLo: 55, wideHi: 220, priorCenter: 120, priorSigmaOct: 1.5,
  windowSec: 8, phaseSec: 6, grid: 0.05, harmonics: [1, 1, 0.5, 0.5], smoothSigma: 1.5,
  fineSpanSec: 16, phaseOffsetMs: 4,
  // Octave evidence: least accent a grid's weaker beats may carry and still be the beat level
  // (less of it for the level already held, so a passing bar cannot flip the octave), most
  // subdivisions a beat may span, and how a subdivision is found in the autocorrelation.
  octAlt: 0.55, octHyst: 0.3, octSub: 3, octSlack: 0.005, tatumMinSec: 0.055, tatumRel: 0.1, vouchSec: 300,
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

/** Gaussian kernel for in-place smoothing: {w, R}. */
function kernel(sigma) {
  const R = Math.ceil(3 * sigma), w = new Float32Array(2 * R + 1);
  let ks = 0;
  for (let i = -R; i <= R; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); w[i + R] = v; ks += v; }
  for (let i = 0; i < w.length; i++) w[i] /= ks;
  return { w, R };
}

/** Smooth x[0..W) with a precomputed kernel into out (which may not alias x). */
function blur(x, W, k, out) {
  const { w, R } = k;
  for (let i = 0; i < W; i++) {
    let s = 0;
    for (let j = -R; j <= R; j++) { const q = i + j < 0 ? 0 : i + j > W - 1 ? W - 1 : i + j; s += x[q] * w[j + R]; }
    out[i] = s;
  }
}

const rel = (a, b) => Math.abs(a / b - 1);
const RELATED = [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3]; // tempo ratios that count as the same beat
/** The ratio in RELATED that takes tempo `a` to tempo `b`, or 0 when the two are unrelated. */
function relatedFactor(b, a) {
  for (const f of RELATED) if (f !== 1 && Math.abs(b / (a * f) - 1) < 0.04) return f;
  return 0;
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Tempos a manual ½× / 2× may reach. */
export const MANUAL_BPM = Object.freeze([DEFAULTS.wideLo / 2, DEFAULTS.wideHi * 2]);

/** Power-of-two factor that folds bpm into [lo, hi] (1 when there is no tempo). */
export function octaveFold(bpm, lo, hi) {
  let f = 1;
  if (bpm > 0) { while (bpm * f < lo) f *= 2; while (bpm * f > hi) f /= 2; }
  return f;
}

/**
 * Which metrical level of `base` is the beat, within [lo, hi]. A comb finds the beat period only
 * up to an octave — every level of it scores well — so the level is chosen from evidence that
 * actually separates them, supplied by the caller so a whole-file analysis can reuse this:
 *   alt(bpm) — onset on the weaker half of that grid's beats over the stronger half. A level
 *              twice the beat has nothing on its alternate beats, so alt is near 0.
 *   sub(bpm) — how many of the track's shortest onset periods one beat of that level spans. A
 *              "beat" four subdivisions long is a bar-level accent, not the pulse.
 * Walks down from the fastest level in range while its beats are not all accented, unless
 * halving would make the beat too long. `held` is the level the caller is already on, which
 * keeps a passing bar from flipping the octave. Returns {bpm, conf}: conf is how clear the call
 * was, under 0.5 when the two levels are too close to separate.
 */
export function pickOctave(base, lo, hi, alt, sub, o = DEFAULTS, held = 0) {
  const folded = base * octaveFold(base, lo, hi);
  // The ends of the range are measured, not exact: a 70 BPM track whose comb peak lands at 69.95
  // must still have 70 among its levels, or it can only be read at double.
  const loS = lo * (1 - o.octSlack), hiS = hi * (1 + o.octSlack), lv = [];
  let top = folded;
  while (top * 2 <= hiS) top *= 2;
  for (let b = top; b >= loS; b /= 2) lv.push(b);
  if (lv.length < 2) return { bpm: folded, conf: 1 };
  const bar = (b) => (held && rel(b, held) < 0.04 ? o.octAlt * (1 - o.octHyst) : o.octAlt);
  const clear = (x) => clamp01(0.35 + 2.5 * x);
  let conf = 1;
  for (let i = 0; i < lv.length - 1; i++) {
    const a = alt(lv[i]), t = bar(lv[i]);
    if (a >= t) return { bpm: lv[i], conf: Math.min(conf, clear((a - t) / t)) };
    const s = sub(lv[i + 1]);
    if (s >= o.octSub) return { bpm: lv[i], conf: Math.min(conf, clear((s - o.octSub) / o.octSub)) };
    conf = Math.min(conf, clear((t - a) / t));
  }
  return { bpm: lv[lv.length - 1], conf };
}

export class TempoTracker {
  constructor(fps, opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.fps = fps;
    const cap = Math.ceil(12 * fps);
    this.full = new Ring(cap);
    this.low = new Ring(cap);
    // Scratch for the octave evidence: built once so evaluate() stays allocation-light.
    this.ea = new Float32Array(cap); this.eb = new Float32Array(cap); this.env = new Float32Array(cap);
    this.envBase = 0; this.ek = kernel(1);
    this.lastT = 0; this.spf = 0; this.frames = 0;
    this.reset();
  }

  reset() {
    this.full.clear(); this.low.clear();
    this.state = 'search'; this.bpm = 0; this.cand = null; this.candCount = 0; this.conf = 0; this.octConf = 0;
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
    // The comb has found the beat period up to an octave. Which octave is the beat is decided
    // from evidence that tells them apart, not from the prior: accent on alternate beats, and
    // how many subdivisions a beat would span.
    const tatum = this.tatum(r, r0, maxLag);
    let envReady = false; // only built when the range holds more than one level to choose from
    const alt = (b) => { if (!envReady) { this.envelope(W); envReady = true; } return this.altBeat(b, W); };
    const picked = pickOctave(o.wideLo + (best + off) * o.grid, o.lo, o.hi,
      alt, (b) => (tatum ? (60 * fps) / b / tatum : 0), o, this.bpm);
    // Sharpen the chosen level onto its own comb peak (the one the prior may not have picked).
    let bpm = picked.bpm, peak = Math.round((bpm - o.wideLo) / o.grid);
    if (peak >= 1 && peak <= nG - 2) {
      const span = Math.max(1, Math.round((0.02 * bpm) / o.grid));
      for (let g = Math.max(1, peak - span); g <= Math.min(nG - 2, peak + span); g++) if (S[g] > S[peak]) peak = g;
      const a = S[peak - 1], b = S[peak], c = S[peak + 1], d = a - 2 * b + c;
      const x = o.wideLo + (peak + (d < 0 ? (0.5 * (a - c)) / d : 0)) * o.grid;
      if (x >= o.lo && x <= o.hi) bpm = x;
    }
    const related = (b) => { for (let i = 0; i < RELATED.length; i++) if (Math.abs(b / (bpm * RELATED[i]) - 1) < 0.04) return true; return false; };
    let second = 1e-9;
    for (let g = 0; g < nG; g++) { const b = o.wideLo + g * o.grid; if (!related(b) && Sw[g] > second) second = Sw[g]; }
    const salience = S[best], peakRatio = Sw[best] / second;
    // peakRatio says there is a beat here; it cannot say which octave, because the octaves are
    // left out of its denominator by construction. Only the two together are a confidence.
    const octConf = picked.conf;
    const conf = clamp01((salience - 0.05) / 0.25) * clamp01((peakRatio - 1) / 0.6) * octConf;
    return { bpm, salience, peakRatio, octConf, conf };
  }

  /**
   * The shortest clear onset period in the window (frames): the first autocorrelation peak worth
   * tatumRel of the signal's own energy. Weaker ripples are not a subdivision the music keeps.
   */
  tatum(r, r0, maxLag) {
    const first = Math.max(2, Math.round(this.o.tatumMinSec * this.fps)), floor = this.o.tatumRel * r0;
    for (let L = first; L < maxLag - 1; L++) if (r[L] >= floor && r[L] >= r[L - 1] && r[L] >= r[L + 1]) return L;
    return 0;
  }

  /**
   * Onset envelope over the last W frames into this.env (full and low band, each over its own
   * mean, smoothed), with its median in this.envBase so a beat carrying no onset reads about 0.
   */
  envelope(W) {
    const f = this.full.last(W, this.ea), l = this.low.last(W, this.eb);
    let mf = 1e-9, ml = 1e-9;
    for (let i = 0; i < W; i++) { mf += f[i]; ml += l[i]; }
    mf /= W; ml /= W;
    for (let i = 0; i < W; i++) this.eb[i] = f[i] / mf + l[i] / ml; // l is eb: read then write, per index
    blur(this.eb, W, this.ek, this.env);
    const c = this.ea.subarray(0, W);
    c.set(this.env.subarray(0, W));
    c.sort();
    this.envBase = c[W >> 1];
  }

  /**
   * Onset on the weaker half of the beats of a `bpm` grid over the stronger half (0..1), at the
   * phase that carries most onset. Near 1 when every beat is accented; near 0 when the accents
   * are two beats apart, which means `bpm` is twice the beat.
   */
  altBeat(bpm, W) {
    const e = this.env, base = this.envBase, tau = (60 * this.fps) / bpm, last = W - 2;
    const at = (p) => { const i = Math.floor(p), fr = p - i; return i < 0 || i + 1 >= W ? 0 : e[i] * (1 - fr) + e[i + 1] * fr; };
    const step = 0.25;
    let phi = 0, bv = -Infinity;
    for (let p = 0; p * step < tau; p++) {
      const q0 = p * step;
      let acc = 0, n = 0;
      for (let q = q0; q < last; q += tau) { acc += at(q); n++; }
      if (n && acc / n > bv) { bv = acc / n; phi = q0; }
    }
    let sa = 0, na = 0, sb = 0, nb = 0, k = 0;
    for (let q = phi; q < last; q += tau, k++) {
      const v = Math.max(0, at(q) - base);
      if (k & 1) { sb += v; nb++; } else { sa += v; na++; }
    }
    if (!na || !nb) return 1;
    const ma = sa / na, mb = sb / nb;
    return Math.min(ma, mb) / (Math.max(ma, mb) || 1e-9);
  }

  update(est) {
    if (!est || est.silent) return this.snapshot(est && est.silent ? 'hold' : undefined);
    if (this.holdUntil && this.lastT < this.holdUntil) return this.snapshot();
    if (this.state === 'search' || this.bpm === 0) {
      if (est.conf < 0.25) return this.snapshot();
      if (this.cand && rel(est.bpm, this.cand) < 0.02) this.candCount++; else { this.cand = est.bpm; this.candCount = 1; }
      if (this.candCount >= 3) { this.state = 'locked'; this.bpm = est.bpm; this.cand = null; this.candCount = 0; }
      this.conf = est.conf; this.octConf = est.octConf;
      return this.snapshot();
    }
    if (rel(est.bpm, this.bpm) < 0.02) {
      this.bpm += 0.2 * (est.bpm - this.bpm);
      this.conf += 0.3 * (est.conf - this.conf);
      this.octConf += 0.3 * (est.octConf - this.octConf);
      this.cand = null; this.candCount = 0;
    } else {
      const octave = [2, 0.5, 1.5, 2 / 3].some((m) => rel(est.bpm, this.bpm * m) < 0.03);
      const need = octave ? 6 : 3;
      if (this.cand && rel(est.bpm, this.cand) < 0.02) this.candCount++; else { this.cand = est.bpm; this.candCount = 1; }
      if (this.candCount >= need && est.conf > (octave ? 0.5 : 0.3)) {
        this.bpm = est.bpm; this.conf = est.conf; this.octConf = est.octConf; this.cand = null; this.candCount = 0;
        this.resetFine();
      } else this.conf *= 0.9;
    }
    return this.snapshot();
  }

  bestBpm() { return this.fineBpm && rel(this.fineBpm, this.bpm) < 0.01 ? this.fineBpm : this.bpm; }
  snapshot(tag) { return { state: tag || this.state, bpm: this.bestBpm(), coarse: this.bpm, conf: this.conf, octConf: this.octConf }; }

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

// Capture gaps: smallest phase jump (s) acted on, largest (beats), and how far it must stand out of
// the per-beat jitter (standard deviations).
const JUMP = { min: 0.005, max: 1 / 8, z: 6 };

/**
 * Where per-beat onset offsets r (oldest first) step: the least-squares fit r_i = a + b·i + D·[i ≥ j]
 * (a level, a drift from a slightly wrong period, and a step) over every split j with at least 4
 * beats before it and 3 after, leaving out beat `skip`. Returns the best {j, D, clear, worst} or
 * null; clear when the step stands out of the jitter, outweighs the drift across the window and
 * every beat sits nearer its own side of the step; worst is the beat farthest off the fit.
 */
function phaseStep(r, skip = -1) {
  const K = r.length, n = K - (skip >= 0 ? 1 : 0);
  if (n < 7) return null;
  const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  let Si = 0, Sii = 0, Sr = 0, Sir = 0, Srr = 0, best = null;
  for (let i = 0; i < K; i++) if (i !== skip) { Si += i; Sii += i * i; Sr += r[i]; Sir += i * r[i]; Srr += r[i] * r[i]; }
  for (let j = 1; j < K; j++) {
    let Su = 0, Siu = 0, Sur = 0;
    for (let i = j; i < K; i++) if (i !== skip) { Su++; Siu += i; Sur += r[i]; }
    if (n - Su < 4 || Su < 3) continue;
    const det = det3([n, Si, Su, Si, Sii, Siu, Su, Siu, Su]);
    if (!det) continue;
    const a = det3([Sr, Si, Su, Sir, Sii, Siu, Sur, Siu, Su]) / det;
    const b = det3([n, Sr, Su, Si, Sir, Siu, Su, Sur, Su]) / det;
    const D = det3([n, Si, Sr, Si, Sii, Sir, Su, Siu, Sur]) / det;
    const sse = Srr - a * Sr - b * Sir - D * Sur;
    if (!best || sse < best.sse) best = { j, a, b, D, sse };
  }
  if (!best) return null;
  const { j, a, b, D, sse } = best;
  let worst = -1, we = -1;
  for (let i = 0; i < K; i++) {
    const e = i === skip ? 0 : Math.abs(r[i] - a - b * i - (i >= j ? D : 0));
    if (e > we) { we = e; worst = i; }
  }
  const clear = Math.abs(D) >= JUMP.z * Math.sqrt(Math.max(0, sse) / (n - 3)) && Math.max(we, Math.abs(b) * (K - 1)) < Math.abs(D) / 2;
  return { j, D, worst, clear };
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
    // and prev is the previous track's grid as it stood there. jump is the latest capture gap in
    // it: n counts them, from (input s) is where the beat phase jumped and prev the grid before.
    this.track = { n: this.track ? this.track.n + 1 : 0, from: this.tracker.lastT / this.sr, prev: null, jump: null };
    this.hist = []; // recent beat-clock states {t, t0, T} (input frames), oldest first
    // Whether the grid was worth phase-locking to as the live edge passed each input frame, as
    // {t, ok} runs, so the deck can ask about the audio under the playhead and not the live edge.
    this.vouch = [];
    this.jumpsFrom(this.tracker.lastT);
  }

  /** Look for capture gaps only after input frame t (the grid was replaced or rescaled there). */
  jumpsFrom(t) { this.jumpFrom = t; this.jumpCand = null; }

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
      this.jumpsFrom(tr.lastT);
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
      const f = relatedFactor(this.snap.coarse, prev);
      if (f) this.reread(f);
      else {
        // The tracker accepted an unrelated tempo (new track): manual corrections no longer apply.
        // The new track starts where its beats took over (the playhead may still be playing the
        // old one), and the old track keeps the grid it had there, before the new beats pulled
        // the clock.
        const from = this.tracker.changePoint(prev, this.snap.coarse);
        this.track = { n: this.track.n + 1, from: from / this.sr, prev: this.gridBefore(from), jump: null };
        this.mult = 1; this.tapped = null; this.gridOffset = 0; this.clock = new BeatClock(); this.bar1 = null; this.hist = [];
        this.jumpsFrom(from);
      }
    }
    this.vouchFor();
    const bpm = this.bpmIn();
    const usable = this.tapped || this.tracker.state === 'locked';
    if (!bpm || !usable || this.snap.state === 'hold') return;
    if (this.tracker.full.count < (2.2 * 60 * this.fps) / bpm) return;
    const ph = this.tracker.phase(bpm, this.tapped ? 1 : this.mult);
    // A tapped grid is the DJ's: detection may follow the period, never the anchor beat they set.
    if (this.tapped) this.clock.T = ph.periodT;
    else if (ph.clarity >= 2 || this.clock.t0 == null) this.clock.update(ph.beatT + this.gridOffset, ph.periodT);
    else this.clock.T = ph.periodT;
    this.detectJump();
  }

  /**
   * The tracker re-read the same beats at another metrical level (½×, 2×, …). That is a
   * correction to this track, not a new track: the DJ's TAP, ½×/2×, GRID nudge and bar 1 all
   * stand, and the grid keeps its anchor beat and scales its period so the whole track moves
   * with it. When the DJ had already made the same correction by hand, theirs is dropped
   * instead, so the two cannot compound.
   */
  reread(f) {
    this.tracker.resetFine();
    if (this.tapped) return; // the tapped grid is the DJ's; detection may not re-time it
    const next = this.mult / f;
    if (this.mult !== 1 && Math.abs(Math.log2(next)) < Math.abs(Math.log2(this.mult))) { this.mult = next; return; }
    if (this.clock.T > 0) {
      this.clock.T /= f;
      const T = this.clock.T;
      if (Math.abs(this.gridOffset) > T / 2) this.gridOffset -= Math.round(this.gridOffset / T) * T;
      this.clock.miss = 0;
    }
    for (const h of this.hist) h.T /= f;
    this.jumpsFrom(this.tracker.lastT);
  }

  /** Record whether the audio now reaching the live edge has a grid worth phase-locking to. */
  vouchFor() {
    const t = this.tracker.lastT, v = this.vouch;
    const ok = !!this.tapped || (this.tracker.state === 'locked' && this.tracker.conf >= 0.5);
    // Nothing is recorded before the first grid: the tracker needs seconds of onsets to find one,
    // and the grid it then finds covers the audio before it, as the grid map's own first
    // segment does. Only losing a grid it once had says anything about the audio.
    if (!v.length && !ok) return;
    if (!v.length || v[v.length - 1].ok !== ok) v.push({ t, ok });
    while (v.length > 1 && v[1].t <= t - this.tracker.o.vouchSec * this.sr) v.shift();
  }

  /** Whether the audio at input frame t had a grid worth phase-locking to when it was analysed. */
  canBeatAt(t) {
    if (this.tapped) return true;
    const v = this.vouch;
    if (!v.length) return this.tracker.state === 'locked' && this.tracker.conf >= 0.5;
    let ok = v[0].ok;
    for (const e of v) { if (e.t <= t) ok = e.ok; else break; }
    return ok;
  }

  /**
   * Each beat of the clock grid since input frame `from` (at most the last 8 s), with the offset
   * r (input frames) of the strongest onset within T/6 of it: {beat, r}, oldest first.
   */
  beatOffsets(from) {
    const tr = this.tracker, { t0, T } = this.clock, spf = tr.spf;
    const W = Math.min(tr.full.count, Math.round(8 * this.fps), Math.floor((tr.lastT - from) / spf));
    const half = Math.max(2, Math.round(T / 6 / spf)), out = [];
    if (!(W > 4 * half)) return out;
    const f = tr.full.last(W, new Float32Array(W)), l = tr.low.last(W, new Float32Array(W));
    let mf = 1e-9, ml = 1e-9; for (let i = 0; i < W; i++) { mf += f[i]; ml += l[i]; } mf /= W; ml /= W;
    const z = new Float32Array(W);
    for (let i = 0; i < W; i++) z[i] = f[i] / mf + l[i] / ml;
    const s = gaussSmooth(z, 1);
    const start = tr.lastT - (W - 1) * spf, off = (tr.o.phaseOffsetMs / 1000) * this.sr;
    for (let k = Math.ceil((start - t0) / T); ; k++) {
      const beat = t0 + k * T, c = (beat - off - start) / spf, ci = Math.round(c);
      if (ci + half > W - 3) break;
      if (ci - half < 1) continue;
      let bi = ci - half; for (let i = bi + 1; i <= ci + half; i++) if (s[i] > s[bi]) bi = i;
      const a = s[bi - 1], b = s[bi], d = s[bi + 1], q = a - 2 * b + d;
      out.push({ beat, r: (bi + (q < 0 ? (0.5 * (a - d)) / q : 0) - c) * spf });
    }
    return out;
  }

  /**
   * A capture gap: under load the tab capture drops or repeats a few ms of audio, so the beats
   * after one input position come that much early or late. The onsets then step against the
   * grid between two beats; once the same step shows in two evaluations in a row, record it as
   * track.jump (the audio before it keeps the grid it had there) and re-phase at once: the beat
   * clock moves by the step from that grid, the phase comb looks only past the jump, and the
   * fine tempo fit keeps its older beats, moved by the step.
   */
  detectJump() {
    const tr = this.tracker, clock = this.clock, sr = this.sr;
    if (clock.t0 == null || !(clock.T > 0) || tr.cand) { this.jumpCand = null; return; }
    const rs = this.beatOffsets(Math.max(this.jumpFrom, tr.phaseFrom, this.track.from * sr)), r = rs.map((x) => x.r);
    // The gap itself can click: a beat next to the jump whose strongest onset is that click may be left out.
    let st = phaseStep(r), skip = -1;
    if (st && !st.clear) { skip = st.worst; st = phaseStep(r, skip); if (st && skip !== st.j - 1 && skip !== st.j) st = null; }
    if (!st || !st.clear || Math.abs(st.D) < JUMP.min * sr || Math.abs(st.D) > JUMP.max * clock.T) { this.jumpCand = null; return; }
    const D = st.D, before = rs[st.j - 1 === skip ? st.j - 2 : st.j - 1], after = rs[st.j === skip ? st.j + 1 : st.j];
    const at = (before.beat + after.beat + D) / 2; // between the last beat before the jump and the first after
    const cand = this.jumpCand;
    this.jumpCand = { at, D };
    if (!cand || Math.abs(cand.at - at) > clock.T / 2 || Math.abs(cand.D - D) > Math.max(0.3 * Math.abs(D), 0.002 * sr)) return;
    const prev = this.gridBefore(at), t0 = prev.t0 * sr, T = prev.T * sr;
    this.track.jump = { n: this.track.jump ? this.track.jump.n + 1 : 0, from: at / sr, prev };
    this.jumpsFrom(at);
    tr.phaseFrom = at;
    tr.beats = tr.beats.filter((x) => x.t < at).map((x) => ({ n: x.n, t: x.t + D }));
    tr.fit = null;
    clock.t0 = t0 + Math.round((clock.t0 - t0) / T) * T + D;
    clock.miss = 0;
    for (const h of this.hist) if (h.t > at) { h.t0 = clock.t0; h.T = clock.T; }
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
    this.jumpsFrom(this.tracker.lastT);
    return true;
  }

  /** Record a tap (input frame) and fit the taps so far: {bpm, t0, T} (input frames) or null. */
  tapFit(inFrame) {
    const last = this.taps[this.taps.length - 1];
    // A tap at or before the one before it cannot be timed — a standing playhead stamps them all
    // at the same input frame — so it starts a new run instead of joining the old one.
    if (last != null && (inFrame <= last || inFrame - last > 2 * this.sr)) this.taps = [];
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
    this.jumpsFrom(this.tracker.lastT);
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
    this.jumpsFrom(atFrame);
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
    return {
      state, inBpm: bpm || null, conf: this.tapped ? 1 : tr.conf, octConf: this.tapped ? 1 : tr.octConf,
      mult: this.mult, tapped: !!this.tapped, grid, canBeat, track: this.track,
    };
  }
}
