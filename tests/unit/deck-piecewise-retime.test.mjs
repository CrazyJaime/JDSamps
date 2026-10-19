// A typed track tempo or a TAP on a resident deck whose whole-track analysis gave a piecewise grid (a mix
// of tracks at different tempi, a drummer who drifts): each analysed piece keeps its own tempo, and the
// grid stays on the beats everywhere, not only where the DJ typed or tapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';
import { analyseTrackSync, applyAnalysis } from '../../engine/analysis.js';

const cat = (xs) => { const o = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of xs) { o.set(x, at); at += x.length; } return o; };

/** A DJ mix: 124, 126 and 128 BPM house, 24 bars each, end to end; its true beats (s). */
function mix() {
  const parts = [124, 126, 128].map((bpm, i) => synth({ ...PATTERNS.house, bpm, bars: 24, tail: 0, seed: 20 + i, padDb: -30 }));
  const truth = [];
  let t = 0;
  for (const p of parts) { for (const b of p.truth) truth.push(t + b); t += p.x.length / FS; }
  return { x: cat(parts.map((p) => p.x)), truth };
}

/** One track whose tempo moves bar by bar from 124 to 126 over 96 bars; its true beats (s). */
function drifting() {
  const bars = 96, pieces = [], truth = [];
  let t = 0;
  for (let b = 0; b < bars; b++) {
    const s = synth({ ...PATTERNS.house, bpm: 124 + (2 * b) / (bars - 1), bars: 1, tail: 0.7, seed: 5 + b, padDb: -60 });
    pieces.push({ at: t, x: s.x });
    for (const tb of s.truth) truth.push(t + tb);
    t += 4 * s.beatSec;
  }
  const x = new Float32Array(Math.ceil((t + 0.7) * FS));
  for (const p of pieces) { const s = Math.round(p.at * FS); for (let i = 0; i < p.x.length && s + i < x.length; i++) x[s + i] += p.x[i]; }
  return { x, truth };
}

const made = new Map();
/** A case's track, and its whole-track analysis: made once. */
function track(c) {
  if (!made.has(c)) {
    const { x, truth } = c.make(), pcm = { L: x, R: x.slice(), sampleRate: FS };
    made.set(c, { pcm, truth, analysis: analyseTrackSync(pcm, { lo: 70, hi: 180 }) });
  }
  return made.get(c);
}

/** A resident deck holding the case's track, gridded from its whole-track analysis as engine.gridResident does. */
async function resident(c) {
  const clock = { t: 1 };
  const engine = makeEngine(clock);
  const { pcm, truth, analysis } = track(c);
  const d = await makeDeck(engine, clock, { id: 1, slot: 1, resident: pcm });
  applyAnalysis(d, analysis);
  d.snapAutoCue(d.grids.at(d.firstAudible ?? 0));
  return { d, clock, engine, truth };
}

/** The grid at p against the true beat nearest p (ms). */
function offMs(d, truth, p) {
  const g = d.grids.at(p), tb = truth.reduce((b, t) => (Math.abs(t - p) < Math.abs(b - p) ? t : b), Infinity);
  return (tb - (g.t0 + Math.round((tb - g.t0) / g.T) * g.T)) * 1000;
}
function assertOnBeats(d, truth, probes, what, tol = 4) {
  const off = probes.map((p) => offMs(d, truth, p));
  assert.ok(off.every((e) => Math.abs(e) < tol), `${what}: the grid against the true beats at ${probes.join(', ')} s (ms): ${off.map((e) => e.toFixed(1)).join(', ')}`);
}
const periods = (d) => new Set(d.grids.segs.map((s) => s.grid.T.toFixed(6))).size;

/** Park the deck so that it is heard at input p. */
function parkAt(d, clock, p) {
  d.ts.change(clock.t, clock.t, { active: false, input: p });
  clock.t += 0.5;
}

/** Eight TAPs on the true beats from the one at or after `from`: the deck plays from just before it. */
async function tapBeats(d, clock, truth, from) {
  const i = truth.findIndex((t) => t >= from), p0 = truth[i] - 0.25;
  d.ts.change(clock.t, clock.t + 0.01, { active: true, input: p0, rate: 1 });
  const t0 = clock.t + 0.01;
  for (let k = 0; k < 8; k++) {
    clock.t = t0 + (truth[i + k] - p0);
    assert.deepEqual(await d.act('tap', { wallMs: clock.t * 1000 }), { ok: true });
  }
  return truth[i + 7];
}

// tol (ms): 125 is 0.06 % off the tempo analysed at 90 s on the drifting track, and every piece is scaled by that
// much, which moves the last beats of a 20-beat piece by a few ms.
const CASES = [
  { name: 'a mix of 124, 126 and 128 BPM tracks', make: mix, probes: [10, 40, 60, 100, 120], at: 60, bpm: 126, tol: 4, tracker: false },
  { name: 'a track drifting from 124 to 126 BPM', make: drifting, probes: [10, 40, 90, 120, 150], at: 90, bpm: 125, tol: 8, tracker: true },
];

for (const c of CASES) {
  test(`${c.name}: typing the tempo heard at ${c.at} s leaves the analysed grid on the beats everywhere`, async () => {
    const { d, clock, truth } = await resident(c);
    assert.ok(periods(d) > 1, 'analysed as a piecewise grid');
    assertOnBeats(d, truth, c.probes, 'as analysed');
    parkAt(d, clock, c.at);
    assert.deepEqual(await d.act('setNativeBpm', { bpm: c.bpm }), { ok: true });
    assert.ok(Math.abs(d.tempoInfo(c.at).native - c.bpm) < 1e-6, `native ${d.tempoInfo(c.at).native} at ${c.at} s`);
    assertOnBeats(d, truth, c.probes, `typed ${c.bpm} at ${c.at} s`, c.tol);
    assert.ok(periods(d) > 1, 'each piece keeps a tempo of its own');
  });

  test(`${c.name}: TAPping the beat at ${c.at} s leaves the analysed grid on the beats everywhere`, async () => {
    const { d, clock, truth } = await resident(c);
    const p = await tapBeats(d, clock, truth, c.at - 3);
    // The tempo tracker holds the TAP when it follows the piece tapped (one song); the mix's tracker follows its
    // 128 BPM track, which the analysis reads as another tempo (deck-tempo-parts), so it is left alone.
    assert.equal(d.tempo.get().tapped, c.tracker);
    assertOnBeats(d, truth, [...c.probes, p], `tapped at ${p.toFixed(1)} s`);
    assert.ok(periods(d) > 1, 'each piece keeps a tempo of its own');
  });
}

/** A resident deck with a hand-made piecewise grid of three pieces (75, 75.95 and 76.92 BPM). */
async function threePieces() {
  const clock = { t: 1 };
  const engine = makeEngine(clock);
  const L = new Float32Array(180 * 100);
  const d = await makeDeck(engine, clock, { id: 1, slot: 1, resident: { L, R: L.slice(), sampleRate: 100 } });
  applyAnalysis(d, {
    bpm: 75, conf: 0.9, octConf: 0.8, bar1: null, residuals: { median: 0.5, max: 1 }, wave: { tStart: 0, hop: 0.01, data: new Uint8Array(0) },
    segments: [{ from: 0, grid: { t0: 0.1, T: 0.8 }, conf: 0.9 }, { from: 60, grid: { t0: 60.05, T: 0.79 }, conf: 0.9 }, { from: 120, grid: { t0: 120.2, T: 0.78 }, conf: 0.9 }],
  });
  return { d, clock };
}

test('on a piecewise grid a typed tempo scales every piece by the same ratio, each keeping its own beat; the piece heard takes the beat nearest the playhead', async () => {
  const { d, clock } = await threePieces();
  const p = 60.05 + 20 * 0.79 + 0.1, k = 76 / (60 / 0.79);
  parkAt(d, clock, p);
  assert.deepEqual(await d.act('setNativeBpm', { bpm: 76 }), { ok: true });
  const [a, b, c] = d.grids.segs.map((s) => s.grid);
  assert.ok(Math.abs(a.T - 0.8 / k) < 1e-12 && Math.abs(a.t0 - 0.1) < 1e-12, JSON.stringify(a));
  assert.ok(Math.abs(c.T - 0.78 / k) < 1e-12 && Math.abs(c.t0 - 120.2) < 1e-12, JSON.stringify(c));
  assert.ok(Math.abs(b.T - 60 / 76) < 1e-12 && Math.abs(b.t0 - (60.05 + 20 * 0.79)) < 1e-9, JSON.stringify(b));
});

test('on a piecewise grid a typed tempo an octave up doubles every piece, as 2× does: every beat stays a beat', async () => {
  const { d, clock } = await threePieces();
  parkAt(d, clock, 90.05 + 10 * 0.79);
  assert.deepEqual(await d.act('setNativeBpm', { bpm: 2 * 60 / 0.79 }), { ok: true });
  assert.deepEqual(d.grids.segs.map((s) => +s.grid.T.toFixed(9)), [0.4, 0.395, 0.39]);
  for (const [s, t0] of [[0, 0.1], [1, 60.05], [2, 120.2]]) {
    const g = d.grids.segs[s].grid, k = (t0 - g.t0) / g.T;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6, `piece ${s}: its beat at ${t0} s is no beat any more`);
  }
});
