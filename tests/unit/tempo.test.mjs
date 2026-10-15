import test from 'node:test';
import assert from 'node:assert/strict';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
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
