// engine/analysis.js — whole-track analysis for a resident deck (a deck that holds its whole track,
// decoded), run once in a Worker (analysis-worker.js) so the main thread only makes the mono
// downmix. The onset function runs over the whole track (OdfCore, as the deck-input worklet runs it
// live), and the beat grid is fitted to all of it, so the deck needs no live tracker and no lock wait:
//   tempo segments — a coarse tempo per 20 s block (the live tracker's own estimate), related tempi
//     merged, each change point refined by TempoTracker.changePoint;
//   per segment — the tempo from the whole segment's autocorrelation and comb, its octave chosen by
//     pickOctave from whole-segment evidence; phase combs over 10 s windows every 5 s, unwrapped to
//     beat numbers and fitted by clarity-weighted least squares; piecewise between the windows' beats
//     where that fit's residuals trend away (the tempo drifts);
//   a bar-1 suggestion, only when one beat of the bar clearly stands out; the waveform bands.
// analyseTrackSync runs the same pipeline inline, for Node tests. applyAnalysis puts it on a deck.
import { OdfCore } from '../worklets/odf-core.js';
import { BPM_RANGES } from '../shared/protocol.js';
import { TempoTracker, DeckTempo, DEFAULTS, RELATED } from './tempo.js';

const WIN = 10, HOP = 5;  // s: phase-comb windows, and how far apart they start
const BLOCK = 20;         // s: blocks a coarse tempo is read from, to find tempo changes
const SAME = 0.02;        // blocks whose tempi are related within this are one tempo segment
const CUT = 25;           // s: history either side of a block boundary searched for the change point
const EDGE = 4;           // s: a refined change point stays this far inside the blocks it splits
const MIN_SEG = 8;        // s: shortest tempo segment kept
const GATE = 0.25;        // conf under which there is no beat to grid (the live tracker's lock gate)
const CLEAR = 0.5;        // a window's phase comb is clear at this fraction of its segment's median clarity
const DRIFT_MS = 5;       // trend of the fit residuals (ms) over which a segment's tempo is not constant
const BAR1_MIN = 0.3;     // how far the strongest beat of the bar must stand out to be offered as bar 1

/**
 * Onset frames of a whole mono track: {full, low, bands, t0, spf, fps}. Frame i is centred on input
 * frame t0 + i·spf; bands holds its waveform levels (low, mid, high bytes), as the live path sends them.
 */
export function odfFrames(mono, sampleRate) {
  let n = 0, t0 = 0, full, low, bands;
  const odf = new OdfCore(sampleRate, (f, l, t, bl, bm, bh) => {
    if (n === 0) t0 = t;
    full[n] = f; low[n] = l;
    bands[n * 3] = bl; bands[n * 3 + 1] = bm; bands[n * 3 + 2] = bh;
    n++;
  });
  const cap = Math.ceil(mono.length / odf.spf) + 2;
  full = new Float32Array(cap); low = new Float32Array(cap); bands = new Uint8Array(cap * 3);
  odf.push(mono, 0);
  return { full: full.slice(0, n), low: low.slice(0, n), bands: bands.slice(0, n * 3), t0, spf: odf.spf, fps: odf.fps };
}

function smooth(x, sigma) {
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

/** Full- and low-band onsets over frames [from, to), each over its own mean, smoothed: what the phase combs read. */
function onsets(fr, from, to) {
  const W = to - from, f = fr.full, l = fr.low, z = new Float32Array(W);
  let mf = 1e-9, ml = 1e-9;
  for (let i = from; i < to; i++) { mf += f[i]; ml += l[i]; }
  mf /= W; ml /= W;
  for (let i = 0; i < W; i++) z[i] = f[from + i] / mf + l[from + i] / ml;
  return smooth(z, 1);
}

const median = (xs) => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 0; };
const related = (a, b) => RELATED.some((m) => Math.abs(a / (b * m) - 1) < SAME);
const inputAt = (fr, i) => fr.t0 + i * fr.spf; // input frame at the centre of onset frame i

/** A live tempo tracker holding exactly frames [from, to). */
function tracker(fr, from, to, range) {
  const W = to - from;
  const tr = new TempoTracker(fr.fps, { ...range, windowSec: (W + 1) / fr.fps, capSec: (W + 8) / fr.fps });
  for (let i = from; i < to; i++) tr.pushFrame(fr.full[i], fr.low[i], inputAt(fr, i));
  return tr;
}

/** The live tracker's coarse estimate over all of frames [from, to): {bpm, conf, octConf} or null. */
function estimate(fr, from, to, range) {
  const e = tracker(fr, from, to, range).estimate();
  return e && !e.silent && e.bpm > 0 ? e : null;
}

/**
 * Tempo segments as frame ranges [{from, to, est}], est null where there is no beat. A block with no
 * beat (a breakdown, an intro) belongs to the segment around it; only an unrelated tempo starts one.
 */
function tempoSegments(fr, range) {
  const n = fr.full.length, fps = fr.fps, B = Math.round(BLOCK * fps), nB = Math.max(1, Math.floor(n / B));
  const segs = [];
  for (let i = 0; i < nB; i++) {
    const from = i * B, to = i === nB - 1 ? n : from + B;
    const e = estimate(fr, from, to, range), bpm = e && e.conf >= GATE ? e.bpm : 0;
    const last = segs[segs.length - 1];
    if (last && (!bpm || !last.bpm || related(bpm, last.bpm))) {
      last.to = to;
      if (!last.bpm) last.bpm = bpm;
      if (bpm && (!last.best || e.conf > last.best.conf)) last.best = e;
    } else segs.push({ from, to, bpm, best: bpm ? e : null });
  }
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1], b = segs[i];
    const tr = tracker(fr, Math.max(0, b.from - Math.round(CUT * fps)), Math.min(n, b.from + Math.round(CUT * fps)), range);
    const at = Math.round((tr.changePoint(a.bpm, b.bpm) - fr.t0) / fr.spf);
    if (at > a.from + EDGE * fps && at < b.to - EDGE * fps) { a.to = at; b.from = at; }
  }
  for (let i = 0; i < segs.length; i++) {
    if (segs.length < 2 || segs[i].to - segs[i].from >= MIN_SEG * fps) continue;
    const s = segs[i], into = i > 0 ? segs[i - 1] : segs[i + 1];
    into.from = Math.min(into.from, s.from); into.to = Math.max(into.to, s.to);
    segs.splice(i--, 1);
  }
  // Each segment's tempo is estimated over all of it; when a long beatless stretch dilutes that
  // below the gate, the clearest block's estimate stands.
  for (const s of segs) {
    const e = estimate(fr, s.from, s.to, range);
    s.est = e && e.conf >= GATE ? e : s.best;
  }
  return segs;
}

/** Phase comb at `bpm` over frames [from, to): the first beat (input frames), the period and how clear the peak is. */
function phaseComb(fr, from, to, bpm, sr) {
  const W = to - from, s = onsets(fr, from, to);
  const at = (p) => { const i = Math.floor(p), f = p - i; return i < 0 || i + 1 >= W ? 0 : s[i] * (1 - f) + s[i + 1] * f; };
  const tau = (60 * fr.fps) / bpm, K = Math.floor((W - 2) / tau), step = 0.25, nP = Math.ceil(tau / step);
  const P = new Float32Array(nP);
  for (let p = 0; p < nP; p++) { let acc = 0; for (let k = 0; k < K; k++) acc += at(p * step + k * tau); P[p] = acc; }
  let best = 0; for (let p = 1; p < nP; p++) if (P[p] > P[best]) best = p;
  const a = P[(best - 1 + nP) % nP], b = P[best], c = P[(best + 1) % nP];
  const d = a - 2 * b + c, off = d < 0 ? (0.5 * (a - c)) / d : 0;
  let mean = 0; for (let p = 0; p < nP; p++) mean += P[p]; mean /= nP;
  // The onset function lags the attack by about phaseOffsetMs; the live phase comb corrects the same.
  const first = inputAt(fr, from) + (best + off) * step * fr.spf + (DEFAULTS.phaseOffsetMs / 1000) * sr;
  return { first, P: tau * fr.spf, clarity: b / (mean || 1e-9) };
}

/**
 * One beat (input frames) near the centre of each 10 s window of frames [from, to), with its comb's
 * clarity. bpmAt(input frame) is the tempo each window is combed at.
 */
function anchors(fr, from, to, bpmAt, sr) {
  const W = Math.round(WIN * fr.fps), H = Math.round(HOP * fr.fps), out = [];
  for (let a = from; a < to; a += H) {
    const b = Math.min(to, a + W), centre = inputAt(fr, (a + b) / 2), bpm = bpmAt(centre);
    if (out.length && b - a < 0.6 * W) break;
    if (b - a < (3 * 60 * fr.fps) / bpm) break; // under three beats: nothing to comb
    const ph = phaseComb(fr, a, b, bpm, sr);
    out.push({ b: ph.first + Math.round((centre - ph.first) / ph.P) * ph.P, clarity: ph.clarity });
  }
  return out;
}

/**
 * The clear anchors (by comb clarity), numbered in beats and fitted with a line {t0, T} (input frames).
 * A clear window whose beat sits off the line through its neighbours by more than an eighth of a beat
 * has combed the wrong phase (a fill, a break), and is left out.
 */
function clearFit(all, T) {
  const floor = CLEAR * median(all.map((a) => a.clarity));
  let as = all.filter((a) => a.clarity >= floor), line = lineFit(as, T);
  if (as.length >= 3) {
    const keep = as.filter((a, i) => {
      const p = as[i - 1] || as[i + 2], q = as[i + 1] || as[i - 2];
      return Math.abs(a.b - (p.b + ((q.b - p.b) * (a.k - p.k)) / (q.k - p.k))) < line.T / 8;
    });
    if (keep.length >= 2 && keep.length < as.length) { as = keep; line = lineFit(as, line.T); }
  }
  return { as, line };
}

/** Clarity-weighted least-squares line y = a + b·k through anchors' (k, y(anchor)): {a, b} or null. */
function wline(as, y) {
  let sw = 0, sk = 0, sy = 0, skk = 0, sky = 0;
  for (const p of as) { const w = Math.max(0.2, p.clarity), v = y(p); sw += w; sk += w * p.k; sy += w * v; skk += w * p.k * p.k; sky += w * p.k * v; }
  const den = sw * skk - sk * sk;
  if (!(den > 0)) return null;
  const b = (sw * sky - sk * sy) / den;
  return { a: (sy - b * sk) / sw, b };
}

/** Number the anchors' beats from the first (unwrapping by period T) and fit b = t0 + k·T. */
function lineFit(as, T) {
  let t0 = as[0].b;
  for (let iter = 0; iter < 3; iter++) {
    as[0].k = 0;
    for (let i = 1; i < as.length; i++) as[i].k = as[i - 1].k + Math.round((as[i].b - as[i - 1].b) / T);
    const l = as.length > 1 && wline(as, (p) => p.b);
    if (!l) break;
    t0 = l.a; T = l.b;
  }
  for (const a of as) a.resid = a.b - (t0 + a.k * T);
  return { t0, T };
}

/**
 * Each anchor's beat (input frames) on the trend of the line's residuals: a local line through the
 * anchor and its nearest, `span` in all, so jitter averages out and drift stays.
 */
function onTrend(as, line, span) {
  return as.map((a, i) => {
    const lo = Math.max(0, Math.min(i - (span >> 1), as.length - span)), l = wline(as.slice(lo, lo + span), (p) => p.resid);
    return line.t0 + a.k * line.T + (l ? l.a + l.b * a.k : a.resid);
  });
}

/**
 * The grid of one tempo segment (frames [from, to) at coarse `bpm`): {pieces: [{from (input s), grid}],
 * resid (the line's residuals, ms), T (its period, input frames)}. One line over the whole segment, or,
 * where its residuals trend away (the tempo drifts), a piece between each two clear windows' beats
 * (continuous at them), re-combed at the tempo the first pass found there.
 */
function segmentGrid(fr, from, to, bpm, sr) {
  const all = anchors(fr, from, to, () => bpm, sr);
  if (!all.length) return null;
  const { as, line } = clearFit(all, (60 * sr) / bpm);
  const resid = as.map((a) => (Math.abs(a.resid) / sr) * 1000);
  const start = inputAt(fr, from) / sr;
  const b1 = as.length >= 5 ? onTrend(as, line, 5) : null;
  if (!b1 || !b1.some((b, i) => (Math.abs(b - line.t0 - as[i].k * line.T) / sr) * 1000 > DRIFT_MS)) {
    const t0 = line.t0 / sr, T = line.T / sr;
    return { pieces: [{ from: start, grid: { t0: t0 + Math.ceil((start - t0) / T - 1e-9) * T, T } }], resid, T: line.T };
  }
  // A window combed at a tempo far from its own smears its beats: comb each again at its local tempo.
  const localBpm = (t) => {
    let i = 0;
    while (i < as.length - 2 && b1[i + 1] < t) i++;
    return (60 * sr * (as[i + 1].k - as[i].k)) / (b1[i + 1] - b1[i]);
  };
  const again = clearFit(anchors(fr, from, to, localBpm, sr), line.T);
  const p = again.as.length >= 5 ? again : { as, line };
  const beat = onTrend(p.as, p.line, 3).map((b) => b / sr), pieces = [];
  for (let i = 0; i + 1 < p.as.length; i++) {
    pieces.push({ from: i ? beat[i] : start, grid: { t0: beat[i], T: (beat[i + 1] - beat[i]) / (p.as[i + 1].k - p.as[i].k) } });
  }
  return { pieces, resid, T: line.T };
}

/** Each beat time (s) of the grid in [from, to), walking the segments in force. */
function beatsIn(segments, from, to) {
  const out = [], segAt = (t) => { let s = segments[0]; for (const x of segments) { if (x.from <= t) s = x; else break; } return s.grid; };
  let g = segAt(from), b = g.t0 + Math.ceil((from - g.t0) / g.T - 1e-9) * g.T;
  while (b < to) {
    out.push(b);
    g = segAt(b + g.T / 2);
    b = g.t0 + Math.round((b + g.T - g.t0) / g.T) * g.T;
  }
  return out;
}

/**
 * Bar 1, as a suggestion: the beat of the bar (counting in 4) whose low-band onsets (the kick) stand
 * out from the other three over the whole of [from, to). Whether a 4-beat unit exists is reliable to
 * tell; which beat starts it is not (the backbeat is often the loudest), so it is offered only when one
 * beat's kick clearly leads. {t (input s), conf} or null.
 */
function bar1Of(fr, segments, from, to, sr) {
  const n = fr.full.length, sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
  let ml = 1e-9;
  for (let i = 0; i < n; i++) ml += fr.low[i];
  const z = smooth(fr.low.map((v) => (v * n) / ml), 1);
  const beats = beatsIn(segments, from, to);
  for (let k = 0; k < beats.length; k++) {
    const T = k + 1 < beats.length ? beats[k + 1] - beats[k] : beats[k] - beats[k - 1];
    const c = (beats[k] * sr - (DEFAULTS.phaseOffsetMs / 1000) * sr - fr.t0) / fr.spf, half = (T * sr) / 8 / fr.spf;
    let peak = 0;
    for (let i = Math.max(0, Math.round(c - half)); i <= Math.min(n - 1, Math.round(c + half)); i++) if (z[i] > peak) peak = z[i];
    sum[k % 4] += peak; cnt[k % 4]++;
  }
  if (cnt[3] < 8) return null;
  const s = sum.map((v, i) => v / cnt[i]);
  const order = [0, 1, 2, 3].sort((p, q) => s[q] - s[p]), contrast = s[order[0]] / (s[order[1]] || 1e-9) - 1;
  if (!(contrast >= BAR1_MIN)) return null;
  return { t: beats[order[0]], conf: contrast / (1 + contrast) };
}

/** The beat grid and waveform from a track's onset frames (see the header). */
function fit(fr, sr, { lo = DEFAULTS.lo, hi = DEFAULTS.hi } = {}) {
  const wave = { tStart: fr.t0 / sr, hop: fr.spf / sr, data: fr.bands };
  const out = { bpm: 0, conf: 0, octConf: 0, segments: [], bar1: null, residuals: { median: 0, max: 0 }, wave };
  if (fr.full.length < 4 * fr.fps) return out;
  const segs = tempoSegments(fr, { lo, hi }), resid = [];
  let main = null;
  for (const s of segs) {
    const g = s.est ? segmentGrid(fr, s.from, s.to, s.est.bpm, sr) : null;
    if (!g) continue;
    for (const p of g.pieces) out.segments.push({ ...p, conf: s.est.conf });
    resid.push(...g.resid);
    if (!main || s.to - s.from > main.to - main.from) main = { ...s, T: g.T };
  }
  if (!main) {
    // No beat anywhere: say how close it came, without a grid.
    const e = estimate(fr, 0, fr.full.length, { lo, hi });
    if (e) { out.conf = Math.min(e.conf, GATE - 1e-3); out.octConf = e.octConf; }
    return out;
  }
  out.segments[0].from = 0;
  out.bpm = (60 * sr) / main.T;
  out.conf = main.est.conf;
  out.octConf = main.est.octConf;
  out.residuals = { median: median(resid), max: resid.length ? Math.max(...resid) : 0 };
  out.bar1 = bar1Of(fr, out.segments, inputAt(fr, main.from) / sr, inputAt(fr, main.to) / sr, sr);
  return out;
}

/** Mono downmix, as the deck-input worklet makes it. */
function downmix({ L, R }) {
  const m = new Float32Array(L.length);
  if (!R || R === L) m.set(L);
  else for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i]);
  return m;
}

/** The whole analysis of a mono track (what the Worker runs). */
export function analyseMono(mono, sampleRate, { lo, hi } = {}) {
  return fit(odfFrames(mono, sampleRate), sampleRate, { lo, hi });
}

/**
 * Analyse a whole decoded track (I2) in a Worker: the mono downmix is transferred there and the
 * waveform bytes back; the PCM itself is never copied. `signal` (an AbortSignal) stops the Worker,
 * for a load cancelled mid-analysis.
 */
export function analyseTrack(pcm, { lo, hi, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('Track analysis cancelled')); return; }
    const mono = downmix(pcm);
    const w = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    const done = (fn, v) => { w.terminate(); if (signal) signal.removeEventListener('abort', abort); fn(v); };
    const abort = () => done(reject, new Error('Track analysis cancelled'));
    if (signal) signal.addEventListener('abort', abort, { once: true });
    w.onmessage = (e) => {
      if (e.data && e.data.error) done(reject, new Error(`Track analysis failed: ${e.data.error}`));
      else done(resolve, e.data);
    };
    w.onerror = (e) => { e.preventDefault(); done(reject, new Error(`Track analysis failed: ${e.message || 'the worker did not start'}`)); };
    w.postMessage({ mono, sampleRate: pcm.sampleRate, range: { lo, hi } }, [mono.buffer]);
  });
}

/** The same analysis inline, without a Worker (Node tests). */
export function analyseTrackSync(pcm, { lo, hi } = {}) {
  return analyseMono(downmix(pcm), pcm.sampleRate, { lo, hi });
}

/**
 * Put a whole-track analysis on a resident deck: every analysed segment into its grid map (replacing
 * what was there), its tempo seeded from the analysis (made first, at the analysis rate and the deck's
 * BPM range, if the deck has none: no input worklet ever announced one), and the whole waveform into
 * its wave store and out to the pages, as the live input path stores and sends each batch. Bar 1 is
 * left for the DJ: the analysis only suggests it.
 */
export function applyAnalysis(deck, a) {
  const w = a.wave;
  if (!deck.tempo) {
    const [lo, hi] = BPM_RANGES[deck.engine.params['bpm.range']] || BPM_RANGES.AUTO;
    deck.tempo = new DeckTempo({ sampleRate: deck.sr, fps: deck.sr / Math.round(w.hop * deck.sr), lo, hi });
  }
  a.segments.forEach((s, i) => deck.grids.split(i ? s.from : -Infinity, { t0: s.grid.t0, T: s.grid.T, bar1: null }));
  deck.tempo.seed(a);
  if (w.data.length) {
    deck.appendWave(w.tStart, w.hop, w.data);
    deck.engine.broadcastWave(deck, w.tStart, w.hop, w.data);
  }
}
