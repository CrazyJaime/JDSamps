// applyAnalysis: a whole-track analysis put on a deck — its grid map, a seeded tempo, its waveform.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OdfCore } from '../../worklets/odf-core.js';
import { applyAnalysis, analyseTrackSync } from '../../engine/analysis.js';
import { DeckTempo } from '../../engine/tempo.js';
import { GridMap } from '../../engine/timeshift.js';
import { BPM_RANGES } from '../../shared/protocol.js';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

const T124 = 60 / 124;
const analysis = (over = {}) => ({
  bpm: 124, conf: 0.9, octConf: 0.8, segments: [{ from: 0, grid: { t0: 0.1, T: T124 }, conf: 0.9 }], bar1: null,
  residuals: { median: 0.5, max: 1 }, wave: { tStart: -513 / FS, hop: 512 / FS, data: new Uint8Array(30) }, ...over,
});
const piecewise = () => analysis({
  segments: [
    { from: 0, grid: { t0: 0.1, T: 0.5 }, conf: 0.9 },
    { from: 60, grid: { t0: 60.05, T: 0.49 }, conf: 0.3 },
    { from: 120, grid: { t0: 120.2, T: 0.48 }, conf: 0.9 },
  ],
});
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
/** Phase of x on grid g, 0..1. */
const phase = (g, x) => { const v = (x - g.t0) / g.T; return v - Math.floor(v); };

/**
 * A harness deck as a resident deck stands before its analysis: the whole track buffered (live edge at
 * its end), a real DeckTempo with nothing fed to it, an empty grid map. Playhead parked at `at` s.
 */
function residentDeck({ dur = 180, at = 30 } = {}) {
  const clock = { t: 1 };
  const engine = makeEngine(clock);
  const waves = [];
  engine.broadcastWave = (d, tStart, hop, bands) => waves.push({ d, tStart, hop, bands: Array.from(bands) });
  const d = makeDeck(engine, clock, { liveEdge: dur });
  d.tempo = new DeckTempo({ sampleRate: FS, fps: FS / 512 });
  d.grids = new GridMap();
  d.ts.change(clock.t, clock.t, { active: false, input: at });
  clock.t += 0.01;
  return { d, engine, clock, waves };
}

/** 20 s of a 100 BPM track's onsets, as the deck-input worklet batches them to a live deck. */
function feedLive(d) {
  const { x } = synth({ ...PATTERNS.techno, bpm: 100, bars: 9 });
  let batch = null;
  const odf = new OdfCore(FS, (f, l, t) => {
    if (!batch) batch = { t0: t, spf: odf.spf, full: [], low: [] };
    batch.full.push(f); batch.low.push(l);
    if (batch.full.length === 8) { d.tempo.pushBatch(batch); batch = null; }
  });
  for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
}

test('a resident deck can beat-match at its playhead the moment the analysis is applied', () => {
  const { d } = residentDeck();
  assert.equal(d.canBeat(), false);
  applyAnalysis(d, analysis());
  assert.equal(d.canBeat(), true, 'at the playhead');
  assert.equal(d.canBeat(170), true, 'near the end');
  assert.ok(near(d.tempoInfo().native, 124), `native ${d.tempoInfo().native}`);
  assert.equal(d.tempo.get().state, 'LOCKED');
  const g = d.grids.at(30);
  assert.ok(near(g.t0, 0.1) && near(g.T, T124), JSON.stringify(g));
  assert.equal(g.bar1, null, 'bar 1 is never applied by the analysis');
  assert.equal(d.state(d.now()).bpm.state, 'LOCKED');
});

test('every analysed segment is in the grid map, in order, with its own confidence', () => {
  const { d } = residentDeck();
  applyAnalysis(d, piecewise());
  assert.deepEqual(d.grids.segs.map((s) => s.from), [-Infinity, 60, 120]);
  assert.ok(near(d.grids.at(30).T, 0.5) && near(d.grids.at(90).T, 0.49) && near(d.grids.at(150).T, 0.48));
  assert.equal(d.canBeat(30), true);
  assert.equal(d.canBeat(90), false, 'the segment the analysis was unsure of');
  assert.equal(d.canBeat(150), true);
});

test('applying an analysis again replaces the grid map', () => {
  const { d } = residentDeck();
  applyAnalysis(d, piecewise());
  applyAnalysis(d, analysis());
  assert.equal(d.grids.segs.length, 1);
  assert.ok(near(d.grids.at(150).T, T124));
});

test('the whole track\'s waveform goes into the wave store and out to the pages, as the live path sends it', () => {
  const { d, waves } = residentDeck({ dur: 30 });
  const one = synth({ ...PATTERNS.house, bpm: 124, bars: 16, tail: 0 }), x = one.x.subarray(0, 30 * FS);
  const a = analyseTrackSync({ L: x, R: x, sampleRate: FS }, { lo: 70, hi: 180 });
  const bands = Array.from(a.wave.data);
  applyAnalysis(d, a);
  assert.equal(waves.length, 1);
  assert.equal(waves[0].d, d);
  assert.equal(waves[0].tStart, a.wave.tStart);
  assert.equal(waves[0].hop, a.wave.hop);
  assert.deepEqual(waves[0].bands, bands);
  const w = d.waveBacklog();
  assert.equal(w.t, 'wave');
  assert.equal(w.deck, d.id);
  assert.ok(Array.isArray(w.data));
  assert.ok(near(w.hop, 512 / FS));
  assert.ok(w.tStart > -w.hop && w.tStart < w.hop, `tStart ${w.tStart}`);
  assert.ok(Math.abs(w.tStart + (w.data.length / 3) * w.hop - 30) < 2 * w.hop, `${w.data.length / 3} hops`);
  assert.deepEqual(w.data, bands.slice(bands.length - w.data.length));
});

test('½× / 2× acts on the analysed grid at the playhead, and holds', async () => {
  const { d } = residentDeck();
  applyAnalysis(d, analysis());
  assert.deepEqual(await d.act('mult', { factor: 2 }), { ok: true });
  assert.ok(near(d.grids.at(30).T, T124 / 2), `T ${d.grids.at(30).T}`);
  assert.ok(near(d.tempoInfo().native, 248));
  assert.ok(near(d.tempo.get().grid.T, T124 / 2), 'the tempo clock follows');
  assert.equal(d.canBeat(), true);
  feedLive(d);
  assert.ok(near(d.grids.at(30).T, T124 / 2));
  assert.ok(near(d.tempo.get().grid.T, T124 / 2));
  assert.deepEqual(await d.act('mult', { factor: 0.5 }), { ok: true });
  assert.ok(near(d.tempoInfo().native, 124));
});

test('GRID ±½ acts on the analysed grid at the playhead, and holds', async () => {
  const { d } = residentDeck();
  applyAnalysis(d, analysis());
  assert.deepEqual(await d.act('gridShift', { beats: 0.5 }), { ok: true });
  const g = d.grids.at(30);
  assert.ok(near(phase(g, 0.1 + T124 / 2), 0, 1e-6) || near(phase(g, 0.1 + T124 / 2), 1, 1e-6), JSON.stringify(g));
  feedLive(d);
  assert.deepEqual(d.grids.at(30), g);
});

test('TAP 1 marks bar 1 on the analysed grid at the playhead, and holds', async () => {
  const { d } = residentDeck({ at: 30.3 });
  applyAnalysis(d, analysis());
  assert.deepEqual(await d.act('tap1'), { ok: true });
  const b = 0.1 + Math.round((30.3 - 0.1) / T124) * T124;
  assert.ok(near(d.grids.at(30).bar1, b, 1e-6), `bar1 ${d.grids.at(30).bar1} vs ${b}`);
  feedLive(d);
  assert.ok(near(d.grids.at(30).bar1, b, 1e-6));
});

test('TAP retimes the analysed grid at the playhead, and holds', async () => {
  const { d, clock } = residentDeck();
  applyAnalysis(d, analysis());
  await d.act('play');
  clock.t += 0.5;
  for (let i = 0; i < 5; i++) { assert.deepEqual(await d.act('tap', { wallMs: clock.t * 1000 }), { ok: true }); clock.t += 0.5; }
  const p = d.ts.posAt(clock.t);
  assert.ok(near(d.grids.at(p).T, 0.5, 1e-6), `T ${d.grids.at(p).T}`);
  assert.ok(near(d.tempoInfo(p).native, 120, 1e-3));
  feedLive(d);
  assert.ok(near(d.grids.at(p).T, 0.5, 1e-6));
});

test('on a piecewise grid a correction moves every segment, and none takes another\'s grid', async () => {
  const { d } = residentDeck();
  applyAnalysis(d, piecewise());
  assert.deepEqual(await d.act('mult', { factor: 2 }), { ok: true });
  assert.deepEqual(d.grids.segs.map((s) => +s.grid.T.toFixed(9)), [0.25, 0.245, 0.24]);
  assert.deepEqual(await d.act('gridShift', { beats: 1 }), { ok: true });
  assert.deepEqual(d.grids.segs.map((s) => +s.grid.t0.toFixed(9)), [0.35, 60.295, 120.44]);
  assert.deepEqual(await d.act('tap1'), { ok: true });
  assert.deepEqual(d.grids.segs.map((s) => +s.grid.T.toFixed(9)), [0.25, 0.245, 0.24]);
});

test('with no tempo yet, applyAnalysis makes one at the analysis rate and the deck\'s BPM range', () => {
  const { d, engine } = residentDeck();
  d.tempo = null;
  engine.params['bpm.range'] = '88-175';
  applyAnalysis(d, analysis());
  assert.ok(d.tempo instanceof DeckTempo);
  assert.equal(d.tempo.fps, FS / 512);
  assert.deepEqual([d.tempo.tracker.o.lo, d.tempo.tracker.o.hi], BPM_RANGES['88-175']);
  assert.equal(d.canBeat(), true);
});
