// A resident deck stopped at the end of its track stays there until it is moved: SYNC PLAY, or PLAY on a
// SYNCed deck, leave it parked. A start planned while it still sits at the end (CUE, then PLAY at once)
// plays, and stops at the end. The stretcher never plays while the deck says it is paused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run as runAll } from './fixtures/deck-harness.mjs';
import { applyAnalysis } from '../../engine/analysis.js';

const SR = 48000, DT = 1536 / SR;
const track = (sec) => { const L = new Float32Array(Math.round(sec * SR)); L.fill(0.2, Math.round(0.002 * SR)); return { L, R: L.slice(), sampleRate: SR }; };
const gridAt = (bpm, t0) => ({
  bpm, conf: 0.9, octConf: 1, segments: [{ from: 0, grid: { t0, T: 60 / bpm }, conf: 0.9 }], bar1: null,
  residuals: { median: 0.5, max: 1 }, wave: { tStart: 0, hop: 512 / SR, data: new Uint8Array(0) },
});

/**
 * The harness's run, with a whole track's end kept where it is (the harness grows every deck's live edge), and
 * every tick checked: the stretcher playing while the deck says it is paused (and no stop is on its way), or past
 * the end of the track.
 */
function run(engine, clock, s, d, faults) {
  runAll(engine, clock, s, (t) => {
    for (const x of engine.decks.values()) if (x.kind === 'resident') x.ts.liveEdge = x.duration;
    if (!d) return;
    if (d.node.segAt(t).active && !d.wantPlay && !d.ts.planned(t, false)) faults.push(`t ${t.toFixed(3)}: the stretcher plays at ${d.node.posAt(t).toFixed(3)} s, the deck says paused and plans no stop`);
    if (d.node.posAt(t) > d.duration + 1e-6) faults.push(`t ${t.toFixed(3)}: the stretcher is at ${d.node.posAt(t).toFixed(3)} s, past the end (${d.duration} s)`);
  });
}

/** A playing 124 BPM master, and a 40 s resident deck (128 BPM; SYNCed when `sync`) that has played to its end. */
async function atEnd({ sync, bpm = 128, t0 = 0.011 }) {
  const clock = { t: 1 }, engine = makeEngine(clock);
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 124 });
  engine.clock.follow(m.id);
  await m.act('play');
  run(engine, clock, 1);
  const d = await makeDeck(engine, clock, { id: 2, slot: 2, resident: track(40) });
  applyAnalysis(d, gridAt(bpm, t0));
  if (sync) assert.deepEqual(await d.act('sync', { on: true }), { ok: true });
  d.setCue(d.duration - 1);
  run(engine, clock, 0.2);
  await d.act('play');
  run(engine, clock, 2);
  assert.equal(d.wantPlay, false, 'stopped at the end');
  assert.ok(Math.abs(d.ts.posAt(clock.t) - d.duration) < 1e-6, `parked at ${d.ts.posAt(clock.t)}`);
  return { clock, engine, m, d };
}

/** Run until a start planned now at the next master beat would be `ph` (0..1) of a beat away. */
function untilPhase(engine, clock, d, ph) {
  for (let i = 0; i < 400; i++) {
    const T = d.ts.soon(clock.t), mb = engine.clock.beat(T), x = (T - mb.lastBeat) / mb.period;
    if (Math.abs(x - Math.floor(x) - ph) < 0.03) return;
    run(engine, clock, DT);
  }
  assert.fail(`never at master phase ${ph}`);
}

/** After the press: parked at the end, nothing plays; then a seek, PLAY and PAUSE do what they say. */
async function staysParked({ clock, engine, d }, faults) {
  run(engine, clock, 3, d, faults);
  assert.deepEqual(faults, []);
  assert.equal(d.wantPlay, false);
  assert.equal(d.state(clock.t).playing, false);
  assert.ok(Math.abs(d.ts.posAt(clock.t) - d.duration) < 1e-6, `moved to ${d.ts.posAt(clock.t)}`);
  assert.equal((await d.act('seek', { pos: 10 })).ok, true);
  run(engine, clock, 0.3, d, faults);
  await d.act('play');
  run(engine, clock, 1, d, faults);
  assert.equal(d.wantPlay, true, 'PLAY after a seek plays');
  assert.equal(d.node.segAt(clock.t).active, true);
  const p = d.ts.posAt(clock.t);
  assert.ok(p > 10 && p < 12, `playhead ${p}`);
  await d.act('pause');
  run(engine, clock, 0.5, d, faults);
  assert.equal(d.node.segAt(clock.t).active, false, 'PAUSE stops the stretcher');
  assert.deepEqual(faults, []);
}

for (const ph of [0.1, 0.3, 0.5, 0.7, 0.9]) {
  test(`SYNC PLAY on a resident deck stopped at its end leaves it parked there, the master at beat phase ${ph}`, async () => {
    const s = await atEnd({ sync: false }), faults = [];
    untilPhase(s.engine, s.clock, s.d, ph);
    assert.equal((await s.d.act('syncPlay')).ok, true);
    assert.equal(s.d.syncOn, true, 'SYNC▶ still syncs');
    await staysParked(s, faults);
  });

  test(`PLAY (Space) on a SYNCed resident deck stopped at its end leaves it parked there, the master at beat phase ${ph}`, async () => {
    const s = await atEnd({ sync: true }), faults = [];
    untilPhase(s.engine, s.clock, s.d, ph);
    assert.equal((await s.d.act('playToggle')).ok, true);
    await staysParked(s, faults);
  });
}

test('CUE then PLAY at once on a resident deck stopped at its end, its last beat just before it: it plays that beat and stops at the end', async () => {
  const { clock, engine, d } = await atEnd({ sync: false, bpm: 100, t0: 0.26 }), faults = [];
  await d.act('cueDown'); await d.act('cueUp'); // paused off its cue: the cue moves to the playhead, on its beat
  assert.ok(Math.abs(d.cue - 39.86) < 1e-6, `cue ${d.cue}`);
  const T = d.ts.soon(clock.t);
  await d.act('play'); // before the cue has landed
  assert.equal(d.wantPlay, true);
  run(engine, clock, T - clock.t + 0.04, d, faults);
  assert.equal(d.wantPlay, true, 'the deck says paused');
  assert.equal(d.node.segAt(clock.t).active, true, 'the stretcher is not playing');
  const p = d.ts.posAt(clock.t);
  assert.ok(p > 39.86 && p < 40, `playhead ${p}`);
  run(engine, clock, 1, d, faults);
  assert.deepEqual(faults, []);
  assert.equal(d.wantPlay, false, 'stopped at the end again');
  assert.equal(d.node.segAt(clock.t).active, false);
  assert.ok(Math.abs(d.ts.posAt(clock.t) - d.duration) < 1e-6, `parked at ${d.ts.posAt(clock.t)}`);
});
