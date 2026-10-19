// A whole track can be played from its very first frame. A track whose first beat sits within one onset frame of
// its start (the analysis places a kick at 0 a fraction of a millisecond either side) is cued at 0, so its first
// attack is whole; a later first beat is cued on the beat, as before. A live deck keeps its margin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run as runAll, clockErrMs, FakeNode } from './fixtures/deck-harness.mjs';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';
import { analyseTrackSync, applyAnalysis } from '../../engine/analysis.js';
import { Timeshift } from '../../engine/timeshift.js';

const run = (engine, clock, s) => runAll(engine, clock, s, () => { for (const x of engine.decks.values()) if (x.kind === 'resident') x.ts.liveEdge = x.duration; });
const sound = (sec, from = 0) => { const L = new Float32Array(Math.round(sec * FS)); L.fill(0.2, Math.round(from * FS)); return { L, R: L.slice(), sampleRate: FS }; };
const gridAt = (bpm, t0) => ({
  bpm, conf: 0.9, octConf: 1, segments: [{ from: 0, grid: { t0, T: 60 / bpm }, conf: 0.9 }], bar1: null,
  residuals: { median: 0.5, max: 1 }, wave: { tStart: 0, hop: 512 / FS, data: new Uint8Array(0) },
});

/** A resident deck holding pcm, gridded from analysis `a` and auto-cued as engine.gridResident does. */
async function resident(engine, clock, pcm, a, id = 2) {
  const d = await makeDeck(engine, clock, { id, slot: id, resident: pcm });
  applyAnalysis(d, a);
  const first = d.firstAudible ?? 0;
  if (d.canBeat(first)) d.snapAutoCue(d.grids.at(first));
  return d;
}

test('a whole track\'s first frame can be reached: the clamp, a cue and a seek go to 0; a live buffer keeps its margin', async () => {
  const clock = { t: 1 }, engine = makeEngine(clock);
  const d = await makeDeck(engine, clock, { id: 1, slot: 1, resident: sound(20) });
  assert.equal(d.ts.clampInput(0), 0);
  assert.equal(d.ts.clampInput(-1), 0);
  d.setCue(5);
  run(engine, clock, 0.3);
  assert.deepEqual(await d.act('seek', { pos: 0 }), { ok: true });
  run(engine, clock, 0.3);
  assert.equal(d.ts.posAt(clock.t), 0, `seek to 0 parks at ${d.ts.posAt(clock.t)}`);
  assert.equal(d.node.posAt(clock.t), 0);
  d.setCue(0);
  assert.equal(d.cue, 0);
  const live = new Timeshift(new FakeNode(clock), { sampleRate: FS, latency: 0.12, outLatency: 0.06 });
  live.liveEdge = 30;
  assert.ok(Math.abs(live.clampInput(-1) - 0.01) < 1e-12, `live: ${live.clampInput(-1)}`);
});

test('the automatic cue of a track whose first beat is within one onset frame of its start is at 0', async () => {
  for (const t0 of [0.001, 0.0002, 0.008, -0.0015]) {
    const clock = { t: 1 }, engine = makeEngine(clock);
    const d = await resident(engine, clock, sound(30), gridAt(124, t0));
    assert.equal(d.cue, 0, `first beat at ${t0} s: cued at ${d.cue}`);
    run(engine, clock, 0.3);
    assert.equal(d.node.posAt(clock.t), 0, `first beat at ${t0} s: parked at ${d.node.posAt(clock.t)}`);
  }
});

test('a first beat further into the track than one onset frame is cued on the beat, as before', async () => {
  for (const [t0, from] of [[0.015, 0], [0.05, 0], [1.2, 1.2]]) {
    const clock = { t: 1 }, engine = makeEngine(clock);
    const d = await resident(engine, clock, sound(30, from), gridAt(124, t0));
    assert.ok(Math.abs(d.cue - t0) < 1e-9, `first beat at ${t0} s (sound from ${from} s): cued at ${d.cue}`);
  }
});

test('analysed drum tracks that start on a kick are cued at 0, and SYNC PLAY from there starts on the master\'s beat', async () => {
  for (const pat of ['house', 'techno', 'dembow']) {
    const s = synth({ ...PATTERNS[pat], bars: 16, seed: 3 }), pcm = { L: s.x, R: s.x.slice(), sampleRate: FS };
    const a = analyseTrackSync(pcm, { lo: 70, hi: 180 });
    const clock = { t: 1 }, engine = makeEngine(clock);
    const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 124 });
    engine.clock.follow(m.id);
    await m.act('play');
    run(engine, clock, 1);
    const d = await resident(engine, clock, { L: s.x.slice(), R: s.x.slice(), sampleRate: FS }, a);
    assert.equal(d.cue, 0, `${pat}: first beat at ${d.grids.at(0).t0.toFixed(5)} s, cued at ${d.cue}`);
    run(engine, clock, 0.3);
    assert.deepEqual(await d.act('syncPlay'), { ok: true });
    run(engine, clock, 0.5);
    const err = clockErrMs(engine, d, clock.t);
    assert.ok(Math.abs(err) < 1, `${pat}: ${err.toFixed(2)} ms off the master just after SYNC PLAY`);
  }
});
