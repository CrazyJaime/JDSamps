// A file holding tracks at unrelated tempi (an album or a mix in one file, spec §8.5): a correction (½× / 2×,
// GRID, a typed tempo, a TAP, the BPM range) acts on the analysed segment the DJ hears and on any segment at a
// related tempo, never on an unrelated tempo elsewhere in the file. One song whose tempo drifts is still corrected
// piece by piece as a whole (deck-piecewise-retime).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';
import { analyseTrackSync, applyAnalysis } from '../../engine/analysis.js';

/** Tracks end to end, each {pattern, bpm, bars, seed}: the file and each track's true beats (s) and span. */
function album(tracks) {
  const parts = tracks.map((t) => synth({ ...PATTERNS[t.pattern], bpm: t.bpm, bars: t.bars, tail: 0, seed: t.seed }));
  const x = new Float32Array(parts.reduce((n, p) => n + p.x.length, 0)), spans = [];
  let at = 0;
  for (const p of parts) { x.set(p.x, at); const t = at / FS; spans.push({ from: t, to: t + p.x.length / FS, truth: p.truth.map((b) => t + b) }); at += p.x.length; }
  return { x, spans };
}

const FILES = {
  two: () => album([{ pattern: 'house', bpm: 100, bars: 30, seed: 11 }, { pattern: 'techno', bpm: 128, bars: 36, seed: 23 }]),
  back: () => album([{ pattern: 'house', bpm: 100, bars: 24, seed: 11 }, { pattern: 'techno', bpm: 128, bars: 30, seed: 23 }, { pattern: 'house', bpm: 100, bars: 24, seed: 31 }]),
};
const made = new Map();
function file(name) {
  if (!made.has(name)) {
    const { x, spans } = FILES[name]();
    const pcm = { L: x, R: x.slice(), sampleRate: FS };
    made.set(name, { x, spans, analysis: analyseTrackSync(pcm, { lo: 70, hi: 180 }) });
  }
  return made.get(name);
}

async function resident(name) {
  const clock = { t: 1 }, engine = makeEngine(clock), f = file(name);
  const d = await makeDeck(engine, clock, { id: 1, slot: 1, resident: { L: f.x.slice(), R: f.x.slice(), sampleRate: FS } });
  applyAnalysis(d, f.analysis);
  return { d, clock, engine, spans: f.spans };
}

const mid = (s) => (s.from + s.to) / 2;
const bpmAt = (d, p) => 60 / d.grids.at(p).T;
/** The grid at p against the true beat nearest p (ms). */
function offMs(d, truth, p) {
  const g = d.grids.at(p), tb = truth.reduce((b, t) => (Math.abs(t - p) < Math.abs(b - p) ? t : b), Infinity);
  return (tb - (g.t0 + Math.round((tb - g.t0) / g.T) * g.T)) * 1000;
}
/** The grid of span s, at three points inside it, on its true beats at its true tempo. */
function assertIntact(d, s, bpm, what) {
  for (const p of [s.from + 10, mid(s), s.to - 10]) {
    assert.ok(Math.abs(bpmAt(d, p) - bpm) < 0.05, `${what}: ${bpmAt(d, p).toFixed(3)} BPM at ${p.toFixed(1)} s, not ${bpm}`);
    const e = offMs(d, s.truth, p);
    assert.ok(Math.abs(e) < 4, `${what}: the grid ${e.toFixed(1)} ms off the true beats at ${p.toFixed(1)} s`);
  }
}
function parkAt(d, clock, p) {
  d.ts.change(clock.t, clock.t, { active: false, input: p });
  clock.t += 0.5;
}
/** Eight TAPs on span s's true beats from the one at or after `from`, on every `every`th beat. */
async function tapBeats(d, clock, s, from, every = 1) {
  const i = s.truth.findIndex((t) => t >= from), p0 = s.truth[i] - 0.25;
  d.ts.change(clock.t, clock.t + 0.01, { active: true, input: p0, rate: 1 });
  const t0 = clock.t + 0.01;
  for (let k = 0; k < 8; k++) {
    clock.t = t0 + (s.truth[i + k * every] - p0);
    assert.deepEqual(await d.act('tap', { wallMs: clock.t * 1000 }), { ok: true });
  }
}

test('the analysis tags each tempo segment with its part: unrelated tempi apart, a related tempo later in the file with the first', () => {
  const two = file('two').analysis, back = file('back').analysis;
  const tag = (a) => a.segments.map((s) => `${s.from.toFixed(0)}s:${(60 / s.grid.T).toFixed(1)}:${s.part}`).join(' ');
  const partAt = (a, p) => { let s = a.segments[0]; for (const x of a.segments) if (x.from <= p) s = x; return s.part; };
  const [a, b] = file('two').spans;
  assert.notEqual(partAt(two, mid(a)), partAt(two, mid(b)), tag(two));
  const [a1, b1, a2] = file('back').spans;
  assert.notEqual(partAt(back, mid(a1)), partAt(back, mid(b1)), tag(back));
  assert.equal(partAt(back, mid(a1)), partAt(back, mid(a2)), tag(back));
});

// Each correction made while the deck is heard in one track: what it does there, and the other track left intact.
const AT_B = [
  { name: 'a typed 136 BPM', act: (d) => d.act('setNativeBpm', { bpm: 136 }), here: (d, p) => assert.ok(Math.abs(bpmAt(d, p) - 136) < 1e-6) },
  { name: '½×', act: (d) => d.act('mult', { factor: 0.5 }), here: (d, p) => assert.ok(Math.abs(bpmAt(d, p) - 64) < 0.05) },
  { name: '2×', act: (d) => d.act('mult', { factor: 2 }), here: (d, p) => assert.ok(Math.abs(bpmAt(d, p) - 256) < 0.1) },
  { name: 'GRID +½', act: (d) => d.act('gridShift', { beats: 0.5 }), here: (d, p, s) => assert.ok(Math.abs(Math.abs(offMs(d, s.truth, p)) - 234.4) < 5, `${offMs(d, s.truth, p)}`) },
  { name: 'GRID +10 ms', act: (d) => d.act('gridShift', { ms: 10 }), here: (d, p, s) => assert.ok(Math.abs(offMs(d, s.truth, p) + 10) < 4, `${offMs(d, s.truth, p)}`) },
];

for (const c of AT_B) {
  test(`${c.name} made in the 128 BPM track leaves the 100 BPM track before it on its beats`, async () => {
    const { d, clock, spans: [a, b] } = await resident('two');
    assertIntact(d, a, 100, 'as analysed');
    assertIntact(d, b, 128, 'as analysed');
    parkAt(d, clock, mid(b));
    assert.deepEqual(await c.act(d), { ok: true });
    c.here(d, mid(b), b);
    assertIntact(d, a, 100, `after ${c.name} at ${mid(b).toFixed(0)} s`);
  });
}

test('a TAP in the 128 BPM track (half time) leaves the 100 BPM track before it on its beats', async () => {
  const { d, clock, spans: [a, b] } = await resident('two');
  await tapBeats(d, clock, b, mid(b), 2);
  assert.equal(d.tempo.get().tapped, true, 'the tracker holds the tapped tempo of the track it follows');
  assert.ok(Math.abs(bpmAt(d, mid(b)) - 64) < 0.1, `tapped at half time: ${bpmAt(d, mid(b))} BPM`);
  assertIntact(d, a, 100, 'after a TAP in the other track');
});

for (const c of [
  { name: 'a typed 104 BPM', act: (d) => d.act('setNativeBpm', { bpm: 104 }), bpm: 104 },
  { name: '½×', act: (d) => d.act('mult', { factor: 0.5 }), bpm: 50 },
  { name: 'GRID +½', act: (d) => d.act('gridShift', { beats: 0.5 }), bpm: 100 },
]) {
  test(`${c.name} made in the 100 BPM track leaves the 128 BPM track after it, and the tempo it plays to, alone`, async () => {
    const { d, clock, spans: [a, b] } = await resident('two');
    const before = d.tempo.get();
    parkAt(d, clock, mid(a));
    assert.deepEqual(await c.act(d), { ok: true });
    assert.ok(Math.abs(bpmAt(d, mid(a)) - c.bpm) < 0.05, `${bpmAt(d, mid(a))} BPM where it was made`);
    assertIntact(d, b, 128, `after ${c.name} at ${mid(a).toFixed(0)} s`);
    const after = d.tempo.get();
    assert.deepEqual({ ...after, track: null }, { ...before, track: null }, 'the tracker follows the 128 BPM track and is not corrected');
  });
}

test('a BPM range change folds each track by its own tempo: one already inside the range stays as it is', async () => {
  for (const [lo, hi, wantA, wantB] of [[55, 115, 100, 64], [98, 195, 100, 128], [130, 260, 200, 256]]) {
    const { d, clock, engine, spans: [a, b] } = await resident('two');
    parkAt(d, clock, mid(b));
    engine.params['bpm.range'] = `${lo}-${hi}`;
    d.setRange(lo, hi);
    assert.ok(Math.abs(bpmAt(d, mid(a)) - wantA) < 0.05 && Math.abs(bpmAt(d, mid(b)) - wantB) < 0.1,
      `range ${lo}-${hi}: ${bpmAt(d, mid(a)).toFixed(2)} and ${bpmAt(d, mid(b)).toFixed(2)} BPM, not ${wantA} and ${wantB}`);
    assert.ok(Math.abs(offMs(d, a.truth, mid(a))) < 4, `range ${lo}-${hi}: the first track off its beats`);
  }
});

test('a correction made in one track applies to a track at a related tempo later in the file, not to the unrelated one between', async () => {
  const { d, clock, spans: [a1, b, a2] } = await resident('back');
  parkAt(d, clock, mid(a1));
  assert.deepEqual(await d.act('mult', { factor: 0.5 }), { ok: true });
  assert.ok(Math.abs(bpmAt(d, mid(a1)) - 50) < 0.05, `${bpmAt(d, mid(a1))} where it was made`);
  assert.ok(Math.abs(bpmAt(d, mid(a2)) - 50) < 0.05, `the related track: ${bpmAt(d, mid(a2))} BPM`);
  assertIntact(d, b, 128, 'the unrelated track between');
  parkAt(d, clock, mid(a2));
  assert.deepEqual(await d.act('mult', { factor: 2 }), { ok: true });
  assertIntact(d, a1, 100, '2× in the related track puts the first back');
  assertIntact(d, a2, 100, '2× where it was made');
  assertIntact(d, b, 128, 'the unrelated track between');
});
