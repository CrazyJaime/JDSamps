// A resident deck plans its stop at the end of the track up to 0.6 s ahead. That stop is the deck's, not the DJ's:
// PAUSE, CUE, CUE let go, a jog or a roll pressed in the track's last 0.6 s act at once, as anywhere else in the
// track, and the stop is planned again around them; the stretcher never plays past the end. A CUE preview held
// into the end is back on the cue once it is let go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run as runAll } from './fixtures/deck-harness.mjs';

const SR = 48000, LEN = 10;
const track = (sec) => { const L = new Float32Array(Math.round(sec * SR)); L.fill(0.2, Math.round(0.002 * SR)); return { L, R: L.slice(), sampleRate: SR }; };

/** Input position the stretcher renders at output time t, its loop included (the fake node leaves loops out). */
function nodePos(d, t) {
  const s = d.node.segAt(t);
  let p = d.node.posAt(t);
  if (s.active && s.loopEnd > s.loopStart && p >= s.loopEnd) p = s.loopStart + ((p - s.loopStart) % (s.loopEnd - s.loopStart));
  return p;
}

/** The harness's run with a whole track's end kept in place; every tick checks the stretcher stays inside the track. */
function run(engine, clock, s, d, faults) {
  runAll(engine, clock, s, (t) => {
    for (const x of engine.decks.values()) if (x.kind === 'resident') x.ts.liveEdge = x.duration;
    if (d && nodePos(d, t) > d.duration + 1e-6) faults.push(`t ${t.toFixed(3)}: the stretcher is at ${nodePos(d, t).toFixed(3)} s, past the end`);
  });
}

/** A 10 s resident deck playing from `from`, run until its playhead reaches `at`. */
async function playingTo(from, at) {
  const clock = { t: 1 }, engine = makeEngine(clock), faults = [];
  const d = await makeDeck(engine, clock, { id: 1, slot: 1, resident: track(LEN) });
  d.setCue(from);
  run(engine, clock, 0.3, d, faults);
  assert.deepEqual(await d.act('play'), { ok: true });
  while (d.ts.posAt(clock.t) < at) run(engine, clock, 1536 / SR, d, faults);
  return { clock, engine, d, faults };
}

/** First output time from t0 (1 ms steps, up to 2 s) at which the stretcher's own schedule satisfies pred, or null. */
function nodeWhen(d, t0, pred) {
  for (let t = t0; t < t0 + 2; t += 0.001) if (pred(d.node.segAt(t), nodePos(d, t))) return t;
  return null;
}

// soon() is 0.15 s at this latency: a press lands then (a stop up to its output latency earlier), wherever in the track.
const LEAD = 0.15 + 0.005;
const AT = [LEN - 0.55, LEN - 0.4, LEN - 0.25];

test('PAUSE in a whole track\'s last 0.6 s stops the stretcher at once, short of the end, and it stays paused there', async () => {
  for (const at of AT) {
    const { clock, engine, d, faults } = await playingTo(at - 1.5, at);
    const press = clock.t, p = d.ts.posAt(press);
    assert.deepEqual(await d.act('pause'), { ok: true });
    const stop = nodeWhen(d, press, (s) => !s.active);
    assert.ok(stop != null && stop - press <= LEAD, `pressed at ${p.toFixed(3)} s: the stretcher stops ${stop == null ? 'never' : `${((stop - press) * 1000).toFixed(0)} ms`} after the press`);
    run(engine, clock, 1.5, d, faults);
    const parked = d.ts.posAt(clock.t);
    assert.ok(parked < LEN - 0.05 && Math.abs(nodePos(d, clock.t) - parked) < 1e-6, `pressed at ${p.toFixed(3)} s: paused at ${parked.toFixed(3)} s (the stretcher at ${nodePos(d, clock.t).toFixed(3)})`);
    assert.equal(d.wantPlay, false);
    assert.equal(d.node.segAt(clock.t).active, false);
    assert.deepEqual(faults, []);
  }
});

test('CUE in a whole track\'s last 0.6 s goes back to the cue at once, without playing on to the end', async () => {
  for (const at of AT) {
    const { clock, engine, d, faults } = await playingTo(at - 1.5, at);
    d.cue = 2; // the DJ's cue point
    const press = clock.t, p = d.ts.posAt(press);
    assert.deepEqual(await d.act('cueDown'), { ok: true });
    const back = nodeWhen(d, press, (s, pos) => !s.active && Math.abs(pos - 2) < 1e-9);
    assert.ok(back != null && back - press <= LEAD, `pressed at ${p.toFixed(3)} s: back on the cue ${back == null ? 'never' : `${((back - press) * 1000).toFixed(0)} ms`} after the press`);
    let furthest = p;
    for (let t = press; t < back; t += 0.001) if (d.node.segAt(t).active) furthest = Math.max(furthest, nodePos(d, t));
    assert.ok(furthest < p + LEAD + 0.01, `pressed at ${p.toFixed(3)} s: the stretcher played on to ${furthest.toFixed(3)} s`);
    await d.act('cueUp');
    run(engine, clock, 1, d, faults);
    assert.ok(Math.abs(d.ts.posAt(clock.t) - 2) < 1e-9 && !d.wantPlay, `parked at ${d.ts.posAt(clock.t)}`);
    assert.deepEqual(faults, []);
  }
});

test('a CUE preview let go in a whole track\'s last 0.6 s is back on the cue at once', async () => {
  for (const hold of [0.5, 0.65, 0.8]) { // let go 0.5, 0.35 and 0.2 s before the end
    const clock = { t: 1 }, engine = makeEngine(clock), faults = [];
    const d = await makeDeck(engine, clock, { id: 1, slot: 1, resident: track(LEN) });
    d.setCue(LEN - 1);
    run(engine, clock, 0.3, d, faults);
    assert.deepEqual(await d.act('cueDown'), { ok: true });
    assert.equal(d.previewing, true);
    run(engine, clock, 0.15 + hold, d, faults);
    const press = clock.t, p = d.ts.posAt(press);
    assert.ok(p > LEN - 0.6 && p < LEN - 0.15, `let go at ${p.toFixed(3)} s`);
    assert.deepEqual(await d.act('cueUp'), { ok: true });
    const back = nodeWhen(d, press, (s, pos) => !s.active && Math.abs(pos - (LEN - 1)) < 1e-6);
    assert.ok(back != null && back - press <= LEAD, `let go at ${p.toFixed(3)} s: back on the cue ${back == null ? 'never' : `${((back - press) * 1000).toFixed(0)} ms`} after`);
    run(engine, clock, 1, d, faults);
    assert.ok(Math.abs(d.ts.posAt(clock.t) - (LEN - 1)) < 1e-6 && !d.wantPlay && !d.previewing, `let go at ${p.toFixed(3)} s: parked at ${d.ts.posAt(clock.t).toFixed(3)}`);
    assert.deepEqual(faults, []);
  }
});

test('a CUE preview held into the end of a whole track is on the cue once let go', async () => {
  const clock = { t: 1 }, engine = makeEngine(clock), faults = [];
  const d = await makeDeck(engine, clock, { id: 1, slot: 1, resident: track(LEN) });
  d.setCue(LEN - 1);
  run(engine, clock, 0.3, d, faults);
  assert.deepEqual(await d.act('cueDown'), { ok: true });
  run(engine, clock, 1.6, d, faults); // past the end, still held
  assert.equal(d.node.segAt(clock.t).active, false, 'stopped at the end');
  assert.deepEqual(await d.act('cueUp'), { ok: true });
  run(engine, clock, 0.5, d, faults);
  assert.ok(Math.abs(d.ts.posAt(clock.t) - (LEN - 1)) < 1e-6, `let go: playhead ${d.ts.posAt(clock.t).toFixed(3)} s, cue ${d.cue}`);
  assert.ok(Math.abs(nodePos(d, clock.t) - (LEN - 1)) < 1e-6, `let go: the stretcher at ${nodePos(d, clock.t).toFixed(3)} s`);
  assert.equal(d.wantPlay, false);
  assert.equal(d.previewing, false);
  assert.deepEqual(faults, []);
  // A preview from there plays as before.
  assert.deepEqual(await d.act('cueDown'), { ok: true });
  run(engine, clock, 0.4, d, faults);
  assert.equal(d.node.segAt(clock.t).active, true, 'a new preview plays');
});

test('a jog or a roll in a whole track\'s last 0.6 s acts at once, and the deck still stops at the end', async () => {
  for (const at of [LEN - 0.55, LEN - 0.4]) {
    const { clock, engine, d, faults } = await playingTo(at - 1.5, at);
    const press = clock.t;
    assert.deepEqual(await d.act('nudge', { dir: 1 }), { ok: true });
    const bend = nodeWhen(d, press, (s) => s.active && s.rate > 1.01);
    assert.ok(bend != null && bend - press <= LEAD, `jog at ${at}: the stretcher bends ${bend == null ? 'never' : `${((bend - press) * 1000).toFixed(0)} ms`} after the press`);
    run(engine, clock, 1, d, faults);
    assert.equal(d.wantPlay, false, 'stopped at the end');
    assert.ok(Math.abs(nodePos(d, clock.t) - LEN) < 1e-6, `jog at ${at}: the stretcher stopped at ${nodePos(d, clock.t).toFixed(3)} s`);
    await d.act('nudge', { dir: 0 });
    assert.deepEqual(faults, []);
  }
  {
    const { clock, engine, d, faults } = await playingTo(LEN - 2, LEN - 0.5);
    const press = clock.t;
    assert.deepEqual(await d.act('rollStart', { beats: 0.25 }), { ok: true });
    const loop = nodeWhen(d, press, (s) => s.active && s.loopEnd > s.loopStart);
    assert.ok(loop != null && loop - press <= LEAD, `roll: the stretcher loops ${loop == null ? 'never' : `${((loop - press) * 1000).toFixed(0)} ms`} after the press`);
    run(engine, clock, 1, d, faults);
    assert.equal(d.wantPlay, true, 'still rolling past the time the end would have come');
    await d.act('rollEnd');
    run(engine, clock, 1.5, d, faults);
    assert.equal(d.wantPlay, false, 'stopped at the end after the roll');
    assert.ok(Math.abs(nodePos(d, clock.t) - LEN) < 1e-6, `after the roll the stretcher stopped at ${nodePos(d, clock.t).toFixed(3)} s`);
    assert.deepEqual(faults, []);
  }
});

test('PAUSE or CUE pressed so close to the end that the end comes first: the deck stops at the end, then does what was pressed', async () => {
  for (const before of [0.1, 0.03]) {
    {
      const { clock, engine, d, faults } = await playingTo(LEN - 2, LEN - before);
      assert.deepEqual(await d.act('pause'), { ok: true });
      run(engine, clock, 1, d, faults);
      assert.ok(Math.abs(nodePos(d, clock.t) - LEN) < 1e-6 && !d.wantPlay, `PAUSE ${before} s before the end: at ${nodePos(d, clock.t).toFixed(3)} s`);
      assert.deepEqual(faults, []);
    }
    {
      const { clock, engine, d, faults } = await playingTo(LEN - 2, LEN - before);
      d.cue = 2;
      assert.deepEqual(await d.act('cueDown'), { ok: true });
      run(engine, clock, 1, d, faults);
      assert.ok(Math.abs(nodePos(d, clock.t) - 2) < 1e-9 && Math.abs(d.ts.posAt(clock.t) - 2) < 1e-9 && !d.wantPlay, `CUE ${before} s before the end: at ${nodePos(d, clock.t).toFixed(3)} s`);
      assert.deepEqual(faults, []);
    }
  }
});
