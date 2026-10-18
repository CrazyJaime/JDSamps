// Whole-track analysis (engine/analysis.js) against synthetic tracks with known beat times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseTrackSync } from '../../engine/analysis.js';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

/**
 * `secs` of a pattern at `bpm`, as a 16-bar synth loop tiled end to end, with the true beat times.
 * Synthesising 180 s outright takes about 4 s; a loop gives the same whole-track length in a sixth.
 */
function loop(name, bpm, secs, extra = {}) {
  const one = synth({ ...PATTERNS[name], bpm, bars: 16, tail: 0, ...extra });
  const n = one.x.length, x = new Float32Array(Math.round(secs * FS)), truth = [];
  for (let at = 0; at < x.length; at += n) {
    x.set(one.x.subarray(0, Math.min(n, x.length - at)), at);
    for (const t of one.truth) if (at + t * FS < x.length) truth.push(at / FS + t);
  }
  return { x, truth };
}

/** Play x back at a rate that varies with output time u (s): a drifting record. Beat times follow. */
function warp({ x, truth }, rate, secs) {
  const n = Math.floor(secs * FS), out = new Float32Array(n), tt = [];
  let p = 0, k = 0;
  for (let j = 0; j < n; j++) {
    const i = Math.floor(p), f = p - i;
    if (i + 1 >= x.length) break;
    out[j] = x[i] * (1 - f) + x[i + 1] * f;
    const next = p + rate(j / FS);
    while (k < truth.length && truth[k] * FS < next) { if (truth[k] * FS >= p) tt.push((j + (truth[k] * FS - p) / (next - p)) / FS); k++; }
    p = next;
  }
  return { x: out, truth: tt };
}

function concat(a, b) {
  const x = new Float32Array(a.x.length + b.x.length);
  x.set(a.x); x.set(b.x, a.x.length);
  const at = a.x.length / FS;
  return { x, truth: [...a.truth, ...b.truth.map((t) => t + at)], at };
}

/** Distance (ms) from each true beat in [from, to] to the nearest line of the grid segment in force there. */
function truthErrMs(segments, truth, from = 0, to = Infinity) {
  const errs = [];
  for (const t of truth) {
    if (t < from || t > to) continue;
    let g = segments[0].grid;
    for (const s of segments) { if (s.from <= t) g = s.grid; else break; }
    errs.push(Math.abs(g.t0 + Math.round((t - g.t0) / g.T) * g.T - t) * 1000);
  }
  errs.sort((a, b) => a - b);
  return { median: +errs[errs.length >> 1].toFixed(2), p95: +errs[Math.floor(0.95 * (errs.length - 1))].toFixed(2), n: errs.length };
}

const analyse = (x, range = { lo: 70, hi: 180 }) => analyseTrackSync({ L: x, R: x, sampleRate: FS }, range);

const steady = new Map(); // name@bpm -> {x, truth, a}, for the tests that reuse a steady analysis
for (const [name, bpm] of [['house', 124], ['techno', 130], ['dnb', 174], ['house', 76], ['trap', 140]]) {
  test(`whole-track analysis of ${name} at ${bpm} BPM: BPM within 0.01 %, grid within 3 ms median across the whole track`, () => {
    const { x, truth } = loop(name, bpm, 180);
    const a = analyse(x);
    steady.set(`${name}@${bpm}`, { x, truth, a });
    assert.ok(Math.abs(a.bpm - bpm) / bpm < 1e-4, `bpm ${a.bpm}`);
    assert.ok(a.segments.length >= 1, 'no grid');
    for (const s of a.segments) assert.ok(Math.abs(60 / s.grid.T - bpm) / bpm < 1e-3, `segment at ${s.from}: ${60 / s.grid.T} BPM`);
    const e = truthErrMs(a.segments, truth);
    assert.ok(e.median < 3 && e.p95 < 8, JSON.stringify(e));
    assert.ok(a.conf >= 0.5 && a.conf <= 1, `conf ${a.conf}`);
    assert.ok(a.octConf > 0 && a.octConf <= 1, `octConf ${a.octConf}`);
  });
}

test('a steady track is one segment, and its fit residuals say so', () => {
  const { a } = steady.get('house@124');
  assert.equal(a.segments.length, 1);
  assert.equal(a.segments[0].from, 0);
  assert.ok(a.residuals.median < 2 && a.residuals.max < 5, JSON.stringify(a.residuals));
});

test('the BPM range reaches the octave choice', () => {
  const { x } = steady.get('house@124');
  const a = analyse(x, { lo: 40, hi: 90 });
  assert.ok(Math.abs(a.bpm - 62) / 62 < 1e-4, `bpm ${a.bpm}`);
});

test('a track with a +0.5 % tempo ramp gets a piecewise grid that stays on the beats', () => {
  const { x, truth } = warp(loop('house', 124, 182), (u) => 1 + 0.005 * (u / 180), 180);
  const a = analyse(x);
  assert.ok(a.segments.length > 1, `${a.segments.length} segment(s)`);
  for (let i = 1; i < a.segments.length; i++) assert.ok(a.segments[i].from > a.segments[i - 1].from, 'segments out of order');
  assert.ok(a.residuals.max > 10, `a ramp is not constant tempo: ${JSON.stringify(a.residuals)}`);
  const e = truthErrMs(a.segments, truth);
  assert.ok(e.p95 < 25, JSON.stringify(e));
});

test('two tempos in one file are split at the change point', () => {
  const { x, truth, at } = concat(loop('house', 124, 90), loop('techno', 100, 90));
  const a = analyse(x);
  const cut = a.segments.slice(1).map((s) => s.from);
  assert.ok(cut.some((t) => Math.abs(t - at) < 1), `boundaries ${cut.map((t) => t.toFixed(2))} vs change at ${at.toFixed(2)}`);
  const first = a.segments.filter((s) => s.from < at - 1), second = a.segments.filter((s) => s.from > at - 1);
  assert.ok(first.every((s) => Math.abs(60 / s.grid.T - 124) < 0.1), 'first part not at 124');
  assert.ok(second.every((s) => Math.abs(60 / s.grid.T - 100) < 0.1), 'second part not at 100');
  const e1 = truthErrMs(a.segments, truth, 0, at - 3), e2 = truthErrMs(a.segments, truth, at + 3);
  assert.ok(e1.p95 < 8 && e2.p95 < 8, `${JSON.stringify(e1)} ${JSON.stringify(e2)}`);
});

test('a beatless track is refused: conf below the gate, no grid, no bar 1', () => {
  const { x } = loop('ambient', 100, 180);
  const a = analyse(x);
  assert.ok(a.conf < 0.25, `conf ${a.conf}`);
  assert.deepEqual(a.segments, []);
  assert.equal(a.bar1, null);
});

test('silence is refused too', () => {
  const a = analyse(new Float32Array(30 * FS));
  assert.equal(a.conf, 0);
  assert.deepEqual(a.segments, []);
  assert.equal(a.bar1, null);
});

test('bar 1 is offered only when one beat of the bar stands out, and then on a downbeat', () => {
  assert.equal(steady.get('house@124').a.bar1, null, 'a kick on every beat: no bar 1');
  assert.equal(steady.get('techno@130').a.bar1, null, 'a kick on every beat: no bar 1');
  for (const key of ['dnb@174', 'trap@140']) {
    const { truth, a: { bar1 } } = steady.get(key);
    assert.ok(bar1, `${key}: the kick leads one beat of the bar`);
    assert.ok(bar1.conf > 0 && bar1.conf <= 1, `${key}: conf ${bar1.conf}`);
    const j = truth.reduce((b, t, i) => (Math.abs(t - bar1.t) < Math.abs(truth[b] - bar1.t) ? i : b), 0);
    assert.equal(j % 4, 0, `${key}: bar 1 at ${bar1.t.toFixed(3)} s is beat ${j % 4} of its bar`);
    assert.ok(Math.abs(truth[j] - bar1.t) < 0.01, `${key}: ${((bar1.t - truth[j]) * 1000).toFixed(1)} ms off the beat`);
  }
});

test('the waveform covers the whole track, hop for hop as the live input path makes it', async () => {
  const { OdfCore } = await import('../../worklets/odf-core.js');
  const { x } = loop('house', 124, 20), a = analyse(x);
  // The deck-input worklet: OdfCore over the mono downmix in 128-frame render quanta.
  const live = [];
  let t0 = null;
  const odf = new OdfCore(FS, (f, l, t, bl, bm, bh) => { if (t0 == null) t0 = t; live.push(bl, bm, bh); });
  for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
  const w = a.wave;
  assert.ok(w.data instanceof Uint8Array);
  assert.equal(w.hop, odf.spf / FS);
  assert.equal(w.tStart, t0 / FS);
  assert.deepEqual(Array.from(w.data.subarray(0, live.length)), live);
  assert.ok(Math.abs(w.tStart + (w.data.length / 3) * w.hop - x.length / FS) < 2 * w.hop, `${w.data.length / 3} hops for ${x.length / FS} s`);
});

// The guard is against a pipeline that grows faster than the track (an O(n²) step), not a benchmark: this
// box runs several test suites at once, and the onset pass alone takes 1–1.5 s of it there.
test('analysis of 5 minutes takes under 4 s in Node', () => {
  const { x } = loop('house', 124, 300);
  const t0 = performance.now();
  const a = analyse(x);
  const ms = performance.now() - t0;
  assert.ok(Math.abs(a.bpm - 124) / 124 < 1e-4, `bpm ${a.bpm}`);
  assert.ok(ms < 4000, `${ms.toFixed(0)} ms`);
});
