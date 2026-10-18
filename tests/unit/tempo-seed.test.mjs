// DeckTempo.seed: a resident deck's tempo, locked to a whole-track analysis instead of tracked live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

const FPS = FS / 512;
const tempo = () => new DeckTempo({ sampleRate: FS, fps: FPS });
const T124 = 60 / 124;
/** An analysis as engine/analysis.js returns it (I2). */
const analysis = (over = {}) => ({
  bpm: 124, conf: 0.9, octConf: 0.8, segments: [{ from: 0, grid: { t0: 0.1, T: T124 } }], bar1: null,
  residuals: { median: 0.5, max: 1 }, wave: { tStart: 0, hop: 512 / FS, data: new Uint8Array(0) }, ...over,
});
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** 20 s of a 100 BPM track's onsets, pushed the way the deck-input worklet hands them to a live deck. */
function feedLive(t) {
  const { x } = synth({ ...PATTERNS.techno, bpm: 100, bars: 9 });
  const odf = new OdfCore(FS, (f, l, tc) => t.pushFrame(f, l, tc));
  for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
}

test('a seeded tempo is locked to the analysed grid at once, with the analysis confidence', () => {
  const t = tempo();
  t.seed(analysis());
  const g = t.get();
  assert.equal(g.state, 'LOCKED');
  assert.ok(near(g.inBpm, 124), `bpm ${g.inBpm}`);
  assert.equal(g.conf, 0.9);
  assert.equal(g.octConf, 0.8);
  assert.ok(near(g.grid.t0, 0.1) && near(g.grid.T, T124), JSON.stringify(g.grid));
  assert.equal(g.canBeat, true);
  assert.equal(g.tapped, false);
  assert.equal(g.mult, 1);
  for (const s of [-1, 0, 1, 90, 179.9, 1e4]) assert.equal(t.canBeatAt(Math.round(s * FS)), true, `canBeatAt ${s} s`);
});

test('nothing the live path feeds a seeded tempo resets it', () => {
  const t = tempo();
  t.seed(analysis());
  const before = JSON.stringify(t.get());
  feedLive(t);
  t.evaluate();
  assert.equal(JSON.stringify(t.get()), before);
  assert.equal(t.canBeatAt(15 * FS), true);
});

test('a piecewise analysis: the clock holds the grid at the end of the track, canBeatAt reads each segment', () => {
  const t = tempo();
  t.seed(analysis({
    segments: [
      { from: 0, grid: { t0: 0.1, T: 0.5 }, conf: 0.9 },
      { from: 60, grid: { t0: 60.05, T: 0.6 }, conf: 0.3 },
      { from: 120, grid: { t0: 120.2, T: 0.48 } },
    ],
  }));
  const g = t.get();
  assert.ok(near(g.grid.t0, 120.2) && near(g.grid.T, 0.48), JSON.stringify(g.grid));
  assert.ok(near(g.inBpm, 125), `bpm ${g.inBpm}`);
  assert.equal(t.canBeatAt(30 * FS), true);
  assert.equal(t.canBeatAt(90 * FS), false, 'the segment the analysis was unsure of');
  assert.equal(t.canBeatAt(150 * FS), true, 'a segment without its own conf takes the analysis conf');
});

test('a seeded tempo the analysis is unsure of is UNSURE and cannot beat-match', () => {
  const t = tempo();
  t.seed(analysis({ conf: 0.3 }));
  const g = t.get();
  assert.equal(g.state, 'UNSURE');
  assert.equal(g.canBeat, false);
  assert.equal(t.canBeatAt(10 * FS), false);
  assert.ok(near(g.grid.T, T124), 'the grid is still there to correct');
});

test('a beatless analysis seeds no grid; TAP still makes one', () => {
  const t = tempo();
  t.seed(analysis({ bpm: 0, conf: 0.1, octConf: 0, segments: [] }));
  let g = t.get();
  assert.equal(g.state, 'SEARCH');
  assert.equal(g.grid, null);
  assert.equal(g.canBeat, false);
  assert.equal(t.canBeatAt(10 * FS), false);
  let bpm = null;
  for (let i = 0; i < 5; i++) bpm = t.tap(Math.round((10 + i * 0.5) * FS));
  assert.ok(near(bpm, 120, 1e-6), `tapped ${bpm}`);
  g = t.get();
  assert.equal(g.state, 'LOCKED');
  assert.equal(g.canBeat, true);
  assert.equal(t.canBeatAt(10 * FS), true);
});

test('½× / 2× on a seeded tempo scale its grid and keep its anchor beat', () => {
  const t = tempo();
  t.seed(analysis());
  assert.equal(t.multiply(2), true);
  let g = t.get();
  assert.ok(near(g.inBpm, 248), `bpm ${g.inBpm}`);
  assert.ok(near(g.grid.T, T124 / 2) && near(g.grid.t0, 0.1), JSON.stringify(g.grid));
  assert.equal(g.state, 'LOCKED');
  assert.equal(g.canBeat, true);
  assert.equal(t.multiply(0.5), true);
  assert.equal(t.multiply(0.5), true);
  g = t.get();
  assert.ok(near(g.inBpm, 62), `bpm ${g.inBpm}`);
  assert.ok(near(g.grid.T, T124 * 2) && near(g.grid.t0, 0.1), JSON.stringify(g.grid));
  feedLive(t);
  assert.ok(near(t.get().grid.T, T124 * 2), 'the corrected grid holds');
});

test('GRID ±½ and TAP 1 act on the seeded grid, and hold', () => {
  const t = tempo();
  t.seed(analysis());
  t.shiftGrid({ beats: 0.5 });
  let g = t.get();
  assert.ok(near(g.grid.t0, 0.1 + T124 / 2), `t0 ${g.grid.t0}`);
  t.setBar1(Math.round(30.3 * FS));
  g = t.get();
  const b = 0.1 + T124 / 2 + Math.round((30.3 - 0.1 - T124 / 2) / T124) * T124;
  assert.ok(near(g.grid.bar1, b, 1e-6), `bar1 ${g.grid.bar1} vs ${b}`);
  feedLive(t);
  g = t.get();
  assert.ok(near(g.grid.t0, 0.1 + T124 / 2) && near(g.grid.bar1, b, 1e-6), 'the corrections hold');
});

test('TAP on a seeded tempo replaces its grid, and holds', () => {
  const t = tempo();
  t.seed(analysis());
  for (let i = 0; i < 5; i++) t.tap(Math.round((20 + i * 0.5) * FS));
  let g = t.get();
  assert.equal(g.tapped, true);
  assert.ok(near(g.inBpm, 120, 1e-6) && near(g.grid.T, 0.5, 1e-9), JSON.stringify(g));
  feedLive(t);
  g = t.get();
  assert.ok(near(g.grid.T, 0.5, 1e-9), `T ${g.grid.T}`);
});

test('a new BPM range folds a seeded tempo by octaves', () => {
  const t = tempo();
  t.seed(analysis());
  t.setRange(50, 100);
  const g = t.get();
  assert.ok(near(g.inBpm, 62), `bpm ${g.inBpm}`);
  assert.ok(near(g.grid.T, T124 * 2), `T ${g.grid.T}`);
});
