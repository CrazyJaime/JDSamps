import test from 'node:test';
import assert from 'node:assert/strict';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { GridMap } from '../../engine/timeshift.js';
import { synth, PATTERNS, FS, nearestBeatError } from './fixtures/synth.mjs';

/** Feed audio through OdfCore -> DeckTempo, calling onEval(tSec, deck) after every 0.5 s evaluation. */
function run(x, opts = {}, hooks = {}) {
  let deck;
  const batch = { full: [], low: [], t0: 0 };
  const odf = new OdfCore(FS, (full, low, t) => {
    deck.pushFrame(full, low, t);
  });
  deck = new DeckTempo({ sampleRate: FS, fps: odf.fps, ...opts });
  const origEval = deck.evaluate.bind(deck);
  deck.evaluate = () => { origEval(); hooks.onEval && hooks.onEval(deck.tracker.lastT / FS, deck); };
  for (let s = 0; s + 128 <= x.length; s += 128) {
    if (hooks.at) hooks.at(s, deck);
    odf.push(x.subarray(s, s + 128), s);
  }
  return { deck, odf, batch };
}

function phaseStats(name, cfg, opts = {}) {
  const { x, truth } = synth({ ...cfg });
  const endSec = x.length / FS - 0.6;
  const errs = [];
  const { deck } = run(x, opts, {
    onEval: (t, d) => {
      const g = d.get();
      if (t > 8 && t < endSec && g.grid && g.state === 'LOCKED') errs.push(Math.abs(nearestBeatError(g.grid.t0, truth)) * 1000);
    },
  });
  errs.sort((a, b) => a - b);
  const p95 = errs.length ? errs[Math.floor(0.95 * (errs.length - 1))] : Infinity;
  return { deck, p95, n: errs.length };
}

const CASES = [
  ['house', 124, 0.1, 10], ['techno', 132.7, 0.1, 10], ['boombap', 92, 0.15, 12], ['trap', 140, 0.1, 10],
  ['pop', 102, 0.1, 10], ['dembow', 95, 0.1, 10], ['slowhh', 75, 0.15, 12], ['noisy128', 128, 0.1, 10],
];

for (const [name, bpm, tolBpm, tolMs] of CASES) {
  test(`${name}: locks to ${bpm} BPM with a tight grid`, () => {
    const { deck, p95, n } = phaseStats(name, PATTERNS[name]);
    const g = deck.get();
    assert.equal(g.state, 'LOCKED', `${name} state ${g.state}`);
    assert.ok(Math.abs(g.inBpm - bpm) <= tolBpm, `${name} bpm ${g.inBpm}`);
    assert.ok(g.canBeat, `${name} canBeat`);
    assert.ok(n > 10, `${name} phase samples ${n}`);
    assert.ok(p95 <= tolMs, `${name} phase p95 ${p95.toFixed(1)} ms`);
  });
}

test('dnb in range 88-175 locks to 174', () => {
  const { deck } = phaseStats('dnb', PATTERNS.dnb, { lo: 88, hi: 175 });
  assert.ok(Math.abs(deck.get().inBpm - 174) <= 0.15, String(deck.get().inBpm));
});

test('dnb in AUTO reads 87, and ×2 corrects it to 174 with a good grid', () => {
  const { x, truth } = synth({ ...PATTERNS.dnb, bars: 40 });
  let multiplied = false; const errs = [];
  const { deck } = run(x, {}, {
    onEval: (t, d) => {
      if (!multiplied && t > 12) { assert.ok(Math.abs(d.get().inBpm - 87) < 0.2, `auto ${d.get().inBpm}`); d.multiply(2); multiplied = true; }
      const g = d.get();
      if (multiplied && t > 20 && t < x.length / FS - 0.6 && g.grid) errs.push(Math.abs(nearestBeatError(g.grid.t0, truth)) * 1000);
    },
  });
  assert.ok(Math.abs(deck.get().inBpm - 174) <= 0.2, String(deck.get().inBpm));
  assert.equal(deck.get().mult, 2);
  errs.sort((a, b) => a - b);
  assert.ok(errs[Math.floor(0.95 * (errs.length - 1))] <= 10, `p95 ${errs[Math.floor(0.95 * (errs.length - 1))]}`);
});

test('ambient pad never locks and refuses beat sync', () => {
  const { deck } = run(synth({ ...PATTERNS.ambient }).x);
  const g = deck.get();
  assert.notEqual(g.state, 'LOCKED');
  assert.equal(g.canBeat, false);
});

test('silence holds a previously locked tempo', () => {
  const a = synth({ ...PATTERNS.house, bars: 16, tail: 0 });
  const silence = new Float32Array(FS * 6);
  const x = new Float32Array(a.x.length + silence.length); x.set(a.x); x.set(silence, a.x.length);
  const { deck } = run(x);
  const g = deck.get();
  assert.equal(g.state, 'HOLD');
  assert.ok(Math.abs(g.inBpm - 124) < 0.15);
});

test('sourceRateChanged keeps BPM and grid continuous across an assist step', () => {
  const bars1 = 16, rate = 1.03;
  const a = synth({ ...PATTERNS.house, bpm: 120, bars: bars1, tail: 0 });
  const b = synth({ ...PATTERNS.house, bpm: 120, rate, bars: 16, tail: 0.5 });
  const x = new Float32Array(a.x.length + b.x.length); x.set(a.x); x.set(b.x, a.x.length);
  const t1 = a.x.length / FS;
  const truth = [...a.truth, ...b.truth.map((t) => t + t1)];
  let notified = false; const errs = []; const bpms = [];
  run(x, {}, {
    at: (s, d) => { if (!notified && s >= a.x.length) { d.sourceRateChanged(rate, a.x.length); notified = true; } },
    onEval: (t, d) => {
      const g = d.get();
      if (notified) { bpms.push(g.inBpm); assert.notEqual(g.state, 'SEARCH', `searching at ${t}`); }
      if (notified && t > t1 + 4 && t < x.length / FS - 0.6 && g.grid) errs.push(Math.abs(nearestBeatError(g.grid.t0, truth)) * 1000);
    },
  });
  assert.ok(Math.abs(bpms[0] - 123.6) < 0.3, `bpm right after change ${bpms[0]}`);
  assert.ok(Math.abs(bpms[bpms.length - 1] - 123.6) < 0.15, `final ${bpms[bpms.length - 1]}`);
  errs.sort((p, q) => p - q);
  assert.ok(errs[Math.floor(0.95 * (errs.length - 1))] <= 15, `p95 ${errs[Math.floor(0.95 * (errs.length - 1))]}`);
});

test('tap tempo sets bpm and phase from 4+ taps', () => {
  const d = new DeckTempo({ sampleRate: FS, fps: 93.75 });
  for (let k = 0; k < 8; k++) d.tap(Math.round(10 * FS + k * 0.5 * FS + (k % 2 ? 200 : -200)));
  const g = d.get();
  assert.equal(g.tapped, true);
  assert.equal(g.state, 'LOCKED');
  assert.ok(Math.abs(g.inBpm - 120) < 0.5, String(g.inBpm));
  assert.ok(Math.abs(g.grid.T - 0.5) < 0.003);
  assert.ok(Math.abs(nearestBeatError(g.grid.t0, [13.5]) ) < 0.01);
  // A tap more than 2 s after the last one starts a new sequence.
  d.tap(Math.round(20 * FS));
  assert.equal(d.get().tapped, true);
});

test('grid shift by half a beat persists through later measurements', () => {
  const { x, truth } = synth({ ...PATTERNS.house, bars: 32 });
  let shifted = false; const errs = [];
  run(x, {}, {
    onEval: (t, d) => {
      if (!shifted && t > 10 && d.get().grid) { d.shiftGrid({ beats: 0.5, ms: 0 }); shifted = true; }
      const g = d.get();
      if (shifted && t > 14 && t < x.length / FS - 0.6) errs.push(Math.abs(nearestBeatError(g.grid.t0, truth)) * 1000);
    },
  });
  const halfBeatMs = (60 / 124 / 2) * 1000;
  const median = errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)];
  assert.ok(Math.abs(median - halfBeatMs) < 15, `median ${median} vs ${halfBeatMs}`);
});

test('OdfCore emits band bytes and is allocation-free per sample', () => {
  const frames = [];
  const odf = new OdfCore(FS, (full, low, t, bl, bm, bh) => frames.push([full, low, t, bl, bm, bh]));
  const { x } = synth({ ...PATTERNS.house, bars: 2 });
  for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
  assert.equal(odf.spf, odf.H * odf.D);
  assert.ok(frames.length > 100);
  for (const f of frames) for (const b of f.slice(3)) assert.ok(Number.isInteger(b) && b >= 0 && b <= 255);
  // Kick frames (beat starts) carry more low-band energy than mid-beat frames.
  const beatFrames = frames.filter((f) => (f[2] / FS) % (60 / 124) < 0.03);
  const avgLow = (arr) => arr.reduce((a, f) => a + f[3], 0) / arr.length;
  assert.ok(avgLow(beatFrames) > avgLow(frames));
});

const concat = (...xs) => { const out = new Float32Array(xs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of xs) { out.set(a, o); o += a.length; } return out; };
const bpmOf = (g) => 60 / g.T;
/** Phase error (ms) of the grid beat nearest p against the truth beat times. */
const gridErrMs = (g, p, truth) => nearestBeatError(g.t0 + Math.round((p - g.t0) / g.T) * g.T, truth) * 1000;

test('a new track keeps the old grid at the playhead until the playhead reaches it', () => {
  // The tab autoplays a 100 BPM track after a 124 BPM one; the deck plays 20 s behind the live edge.
  const A = synth({ ...PATTERNS.house, bars: 40, tail: 0 });
  const B = synth({ ...PATTERNS.house, bpm: 100, bars: 20, tail: 0, seed: 9 });
  const x = concat(A.x, B.x), boundary = A.x.length / FS, reserve = 20;
  const truthB = B.truth.map((t) => t + boundary);
  const grids = new GridMap();
  let inA = null, inB = null;
  const { deck } = run(x, {}, {
    onEval: (t, d) => {
      const g = d.get();
      grids.update(g.grid, g.track);
      const p = t - reserve, gp = grids.at(p);
      if (!inA && t > boundary + 6 && g.inBpm && Math.abs(g.inBpm - 100) < 1) inA = { p, gp, live: g.inBpm };
      if (!inB && p > boundary + 1.5) inB = { p, gp };
    },
  });
  assert.ok(inA, 'the live edge moved on to the 100 BPM track');
  assert.ok(inA.p < boundary - 10, `playhead ${inA.p} is still in the first track`);
  assert.ok(Math.abs(bpmOf(inA.gp) - 124) < 0.2, `grid at the playhead ${bpmOf(inA.gp).toFixed(2)} BPM while the live edge reads ${inA.live.toFixed(2)}`);
  assert.ok(Math.abs(gridErrMs(inA.gp, inA.p, A.truth)) < 5, `first-track phase ${gridErrMs(inA.gp, inA.p, A.truth).toFixed(1)} ms`);
  const from = deck.get().track && deck.get().track.from;
  assert.ok(Math.abs(from - boundary) < 0.5, `new track found at ${from} s, it starts at ${boundary.toFixed(2)} s`);
  assert.ok(inB, 'the playhead crossed into the second track');
  assert.ok(Math.abs(bpmOf(inB.gp) - 100) < 0.2, `grid after the crossing ${bpmOf(inB.gp).toFixed(2)} BPM`);
  assert.ok(Math.abs(gridErrMs(inB.gp, inB.p, truthB)) < 10, `second-track phase ${gridErrMs(inB.gp, inB.p, truthB).toFixed(1)} ms`);
});

test('the old track keeps the grid it had before the new track bled into the beat clock', () => {
  // Here the beat clock re-phases on the trap track's hits about 2 s before the new tempo is accepted.
  const A = synth({ ...PATTERNS.house, bars: 40, tail: 0 });
  const B = synth({ ...PATTERNS.trap, bars: 30, tail: 0, seed: 9 });
  const x = concat(A.x, B.x), boundary = A.x.length / FS;
  const grids = new GridMap();
  let checked = false;
  run(x, {}, {
    onEval: (t, d) => {
      const g = d.get();
      grids.update(g.grid, g.track);
      if (checked || t < boundary + 8) return;
      checked = true;
      for (const p of [boundary - 12, boundary - 1.5]) {
        const gp = grids.at(p);
        assert.ok(Math.abs(bpmOf(gp) - 124) < 0.2, `grid at ${p.toFixed(1)} s: ${bpmOf(gp).toFixed(2)} BPM`);
        assert.ok(Math.abs(gridErrMs(gp, p, A.truth)) < 5, `phase at ${p.toFixed(1)} s: ${gridErrMs(gp, p, A.truth).toFixed(1)} ms`);
      }
    },
  });
  assert.ok(checked);
});

test('½× / 2× after TAP scale the tapped tempo instead of discarding it', () => {
  const d = new DeckTempo({ sampleRate: FS, fps: 93.75 });
  for (let k = 0; k < 8; k++) d.tap(Math.round(10 * FS + k * 0.75 * FS));
  const t0 = d.get().grid.t0;
  d.multiply(2);
  let g = d.get();
  assert.equal(g.tapped, true, 'still tapped');
  assert.ok(Math.abs(g.inBpm - 160) < 0.5, `2× of an 80 BPM tap reads ${g.inBpm}`);
  assert.ok(g.grid && Math.abs(g.grid.T - 0.375) < 0.002 && Math.abs(g.grid.t0 - t0) < 1e-9, `grid ${JSON.stringify(g.grid)}`);
  d.multiply(0.5); d.multiply(0.5);
  g = d.get();
  assert.ok(Math.abs(g.inBpm - 40) < 0.3, `½ ½ reads ${g.inBpm}`);
  assert.ok(Math.abs(g.grid.T - 1.5) < 0.01);
});

test('changing the BPM range refolds the tempo and keeps the grid, the taps and bar 1', () => {
  const { x } = synth({ ...PATTERNS.dnb, bars: 24 });
  const { deck } = run(x);
  const before = deck.get();
  assert.ok(Math.abs(before.inBpm - 87) < 0.2, `AUTO reads ${before.inBpm}`);
  deck.setBar1(Math.round(before.grid.t0 * FS));
  const bar1 = deck.get().grid.bar1;
  deck.setRange(88, 175);
  const g = deck.get();
  assert.equal(g.state, before.state, 'lock kept');
  assert.ok(Math.abs(g.inBpm - 2 * before.inBpm) < 1e-6, `refolded to ${g.inBpm}`);
  assert.ok(g.grid, 'grid kept');
  assert.ok(Math.abs(g.grid.t0 - before.grid.t0) < 1e-9 && Math.abs(g.grid.T - before.grid.T / 2) < 1e-9, `grid ${JSON.stringify(g.grid)}`);
  assert.equal(g.grid.bar1, bar1, 'bar 1 kept');
  assert.equal(g.canBeat, before.canBeat);
  // A manual 2× that already put the tempo in range survives a range change.
  deck.setRange(55, 115);
  assert.ok(Math.abs(deck.get().inBpm - before.inBpm) < 1e-6, `55-115 reads ${deck.get().inBpm}`);
  deck.multiply(2);
  const m = deck.get();
  deck.setRange(88, 175);
  assert.ok(Math.abs(deck.get().inBpm - m.inBpm) < 1e-6, `manual 2× kept: ${deck.get().inBpm} vs ${m.inBpm}`);
  // A tapped tempo stays tapped, refolded like any other tempo.
  const t = new DeckTempo({ sampleRate: FS, fps: 93.75 });
  for (let k = 0; k < 8; k++) t.tap(Math.round(10 * FS + k * 0.5 * FS));
  const tg = t.get();
  t.setRange(68, 135);
  assert.deepEqual(t.get(), tg, 'in range: nothing changes');
  t.setRange(55, 115);
  assert.equal(t.get().tapped, true);
  assert.ok(Math.abs(t.get().inBpm - tg.inBpm / 2) < 1e-9, `tapped refolded to ${t.get().inBpm}`);
  assert.ok(Math.abs(t.get().grid.t0 - tg.grid.t0) < 1e-9 && Math.abs(t.get().grid.T - 2 * tg.grid.T) < 1e-9);
  assert.equal(t.taps.length, 8, 'taps kept');
});

/** x with `ms` of audio dropped at input second `at`, as a capture under load does: the beats after it come `ms` early. */
function dropAt(x, at, ms) {
  const i = Math.round(at * FS), n = Math.round((ms / 1000) * FS);
  return concat(x.subarray(0, i), x.subarray(i + n));
}

test('a capture gap keeps the old beat phase for the audio before it', () => {
  // A steady 128 BPM track whose capture drops 15 ms at X: the live edge's grid re-phases there,
  // while the playhead, seconds behind, still plays the audio from before the gap. (Without a gap
  // the grid of this track wobbles by up to 1.5 ms; the tempo re-fitted across a gap adds a little.)
  const A = synth({ ...PATTERNS.noisy128, bars: 40 });
  const X = 30.2, gap = 0.015, T = 60 / 128;
  const truthPost = A.truth.map((t) => t - gap);
  const grids = new GridMap();
  const worst = { pre: 0, post: 0 };
  let checks = 0;
  run(dropAt(A.x, X, gap * 1000), {}, {
    onEval: (t, d) => {
      const g = d.get();
      grids.update(g.grid, g.track);
      if (t < X + 4 || t > X + 20) return;
      checks++;
      for (let p = X - 4; p <= X - T; p += 0.37) worst.pre = Math.max(worst.pre, Math.abs(gridErrMs(grids.at(p), p, A.truth)));
      for (let p = X + T; p <= t - 0.5; p += 0.37) worst.post = Math.max(worst.post, Math.abs(gridErrMs(grids.at(p), p, truthPost)));
    },
  });
  assert.ok(checks > 20, `checked ${checks} times`);
  assert.ok(worst.pre < 2, `before the gap the grid is ${worst.pre.toFixed(1)} ms off the beats there`);
  assert.ok(worst.post < 3, `after the gap the grid is ${worst.post.toFixed(1)} ms off the shifted beats`);
});
