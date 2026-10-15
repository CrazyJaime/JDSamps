// Deck transport/rate scheduling against a node with the real one-pending-change rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeshift } from '../../engine/timeshift.js';
import { makeEngine, makeDeck, freeMaster, run, FakeNode } from './fixtures/deck-harness.mjs';

const near = (a, b, eps) => Math.abs(a - b) <= eps;

function setup({ pitch = 0, liveEdge = 30, cue = 2, bpm = 124, master = null, syncMode = 'BEAT' } = {}) {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  const m = master ? freeMaster(engine, master) : null;
  engine.updateClock(clock.t);
  const d = makeDeck(engine, clock, { pitch, liveEdge, bpm, syncMode });
  d.setCue(cue);
  const go = (s) => run(engine, clock, s);
  go(0.2);
  return { clock, engine, d, m, go };
}

/** The node itself (not params, not the UI flag) plays at `rate`, and the model agrees with it. */
function assertPlaying(d, t, rate) {
  const s = d.state(t);
  assert.equal(s.playing, true, 'deck shows PLAYING');
  assert.ok(d.node.segAt(t).active, `node segment inactive at +${t}`);
  assert.ok(near(d.node.rateAt(t), rate, 1e-6), `node rate ${d.node.rateAt(t)} != ${rate}`);
  assert.ok(near(s.engineRate, rate, 1e-6), `engineRate ${s.engineRate} != ${rate}`);
  assert.ok(near(d.node.posAt(t), d.ts.posAt(t), 1e-6), `node playhead ${d.node.posAt(t)} != model ${d.ts.posAt(t)}`);
}

// ---------------------------------------------------------------- F2: a pending start is never dropped
test('a pending PLAY survives a rate restatement (applyRate) inside the start window', async () => {
  const { d, clock, go } = setup();
  await d.act('play');
  d.applyRate();
  go(1);
  assertPlaying(d, clock.t, 1);
});

test('a pending PLAY survives a tempo-fader move and still starts at its planned time', async () => {
  const { d, clock, go } = setup();
  await d.act('play');
  const T0 = d.ts.pendingUntil();
  go(0.05);
  d.setParam('pitch', 0.02);
  go(1);
  assertPlaying(d, clock.t, 1.02);
  assert.ok(near(d.node.posAt(clock.t), 2 + 1.02 * (clock.t - T0), 1e-6), 'start kept at its original output time');
});

test('a starve flip inside the start window still starts the deck, clamped to 1x', async () => {
  const { d, clock, go } = setup({ pitch: 0.05 });
  d.ts.liveEdge = d.cue + d.ts.lat + 0.45; // reserve just under GUARD, Web-Audio-only page (no assist)
  await d.act('play');
  go(0.05);
  assert.equal(d.starved, true);
  go(1);
  assertPlaying(d, clock.t, 1);
});

/** A +5% deck on a Web-Audio-only page (no assist) that has run out of reserve. */
async function starvedDeck() {
  const ctx = setup({ pitch: 0.05, liveEdge: 1, cue: 0.3 });
  await ctx.d.act('play');
  ctx.go(10);
  assert.equal(ctx.d.starved, true, 'deck starved while playing +5% with no assist');
  assert.ok(ctx.engine.events.some((e) => /reserve empty/.test(e.text)));
  return ctx;
}

test('PLAY after pausing a starved deck plays', async () => {
  const { d, clock, go } = await starvedDeck();
  await d.act('pause');
  go(5);
  await d.act('play');
  go(1);
  assertPlaying(d, clock.t, 1.05);
  assert.equal(d.starved, false);
});

test('pausing clears the starved flag', async () => {
  const { d, clock, go } = await starvedDeck();
  await d.act('pause');
  go(0.1);
  assert.equal(d.starved, false);
  assert.equal(d.state(clock.t).starved, false);
});

test('a SYNC-PLAY waiting for its beat survives a tempo-fader move', async () => {
  const { d, clock, go } = setup({ master: { bpm: 128 } });
  await d.act('syncPlay');
  assert.ok(d.ts.pendingUntil() - clock.t > 0.2, 'start waits for the next master beat');
  go(0.1);
  d.setParam('pitch', 0.03);
  go(2);
  assertPlaying(d, clock.t, 1.03);
});

test('a pending LIVE jump survives a rate restatement', async () => {
  const { d, clock, go } = setup();
  await d.act('play');
  go(2);
  await d.act('live');
  d.applyRate();
  go(0.5);
  assertPlaying(d, clock.t, 1);
  assert.ok(d.ts.reserveAt(clock.t) < 1, `reserve ${d.ts.reserveAt(clock.t)}: LIVE jump lost`);
});

test('a roll pad pressed inside the start window still starts the deck, looping', async () => {
  const { d, clock, go } = setup();
  await d.act('play');
  assert.equal((await d.act('rollStart', { beats: 1 })).ok, true);
  go(1);
  const seg = d.node.segAt(clock.t);
  assert.ok(seg.active && near(d.node.rateAt(clock.t), 1, 1e-9), 'node plays');
  assert.ok(near(seg.loopStart, d.loop.start, 1e-9) && near(seg.loopEnd, d.loop.end, 1e-9), 'node loops the roll');
  assert.ok(d.state(clock.t).engineRate > 0);
});

test('pausing while a start is pending cancels the start', async () => {
  const { d, clock, go } = setup();
  await d.act('play');
  go(0.05);
  await d.act('pause');
  go(1);
  assert.equal(d.state(clock.t).playing, false);
  assert.equal(d.node.rateAt(clock.t), 0);
  assert.equal(d.ts.playingAt(clock.t), false);
  assert.ok(near(d.node.posAt(clock.t), d.ts.posAt(clock.t), 1e-6));
  assert.ok(near(d.ts.posAt(clock.t), 2, 1e-6), 'never moved off the cue');
});

test('pausing during the SYNC-PLAY beat wait cancels the start and leaves the deck on its cue', async () => {
  const { d, clock, go } = setup({ master: { bpm: 128 } });
  await d.act('syncPlay');
  go(0.1);
  await d.act('pause');
  go(1);
  assert.equal(d.node.rateAt(clock.t), 0);
  assert.equal(d.ts.playingAt(clock.t), false);
  assert.ok(near(d.ts.posAt(clock.t), d.cue, 1e-9) && near(d.node.posAt(clock.t), d.cue, 1e-9), `playhead ${d.ts.posAt(clock.t)}, cue ${d.cue}`);
});

// ---------------------------------------------------------------- F3: the node's rate follows the deck's
test('SYNC-PLAY on an unsynced deck starts at the synced rate and stays phase-locked', async () => {
  const { d, clock, go } = setup({ master: { bpm: 128 } });
  assert.equal(d.syncOn, false);
  await d.act('syncPlay');
  const t0 = clock.t, want = 128 / 124;
  assert.equal(d.syncOn, true);
  go(1);
  assertPlaying(d, clock.t, want);
  for (const s of [5, 10]) {
    go(s - (clock.t - t0));
    assert.ok(d.phaseMs != null && Math.abs(d.phaseMs) < 3, `phase ${d.phaseMs} ms at +${s} s`);
    assertPlaying(d, clock.t, want);
  }
});

test('a sync tempo change made while a change is pending still reaches the node', async () => {
  const { d, clock, go, m } = setup({ master: { bpm: 128 }, syncMode: 'TEMPO' });
  assert.equal((await d.act('sync', { on: true })).ok, true);
  await d.act('play');
  go(2);
  assertPlaying(d, clock.t, 128 / 124);
  await d.act('live');   // any pending change
  m.bpm = 126;           // the master moves while it is pending
  go(3);
  assert.ok(near(d.params.pitch, 126 / 124 - 1, 1e-9));
  assertPlaying(d, clock.t, 126 / 124);
});

test('a source-rate crossing dropped by a later change is re-planned at the step', async () => {
  const { d, clock, go } = setup({ pitch: 0.05 });
  d.assistTick = () => {};                 // drive the source map by hand
  await d.act('play');
  go(1);
  const step = d.ts.posAt(clock.t) + 0.5;
  d.src.set(step, 1.03);                   // an assist step 0.5 s of input ahead
  go(0.07);
  assert.ok(d.ts.pendingUntil() > clock.t, 'crossing scheduled');
  d.setParam('keyLock', false);            // any rate restatement inside the crossing window
  go(2);
  const want = 1.05 / 1.03;
  assertPlaying(d, clock.t, want);
  assert.ok(near(d.node.segAt(clock.t).semitones, 12 * Math.log2(want), 1e-9));
  const sw = d.node.map.find((x) => x.active && near(x.rate, want, 1e-9)); // the dropped crossing is gone from the map
  assert.ok(sw && near(sw.input, step, 1e-6), `rate switched at input ${sw && sw.input}, step at ${step}`);
});

test('Timeshift.bend ends at the rate the caller asks for', () => {
  const clock = { t: 0 };
  const ts = new Timeshift(new FakeNode(clock), { sampleRate: 48000, latency: 0.12, outLatency: 0.06 });
  ts.liveEdge = 30;
  ts.change(0, 0.2, { active: true, input: 0, rate: 1, semitones: 0 });
  clock.t = 1;
  assert.ok(near(ts.bend(1, 1.2, 1.04, 0.5, 1.02), 1.7, 1e-12));
  assert.ok(near(ts.rateAt(1.3), 1.04, 1e-12), 'bend is relative to the rate in effect');
  assert.ok(near(ts.rateAt(1.8), 1.02, 1e-12), 'bend ends at the requested rate');
  clock.t = 1.21; ts.flush(1.21);
  clock.t = 2;
  assert.ok(near(ts.bend(2, 2.2, 1.04, 0.5), 2.7, 1e-12));
  assert.ok(near(ts.rateAt(2.8), 1.02, 1e-12), 'without an end rate the bend returns to the rate in effect');
});

test('Timeshift.change folds a later change into a pending start instead of dropping it', () => {
  const clock = { t: 0 };
  const node = new FakeNode(clock);
  const ts = new Timeshift(node, { sampleRate: 48000, latency: 0.12, outLatency: 0.06 });
  ts.liveEdge = 30;
  ts.change(0, 0.05, { active: false, input: 2.9 });  // cued at 2.9
  clock.t = 0.1;
  ts.change(0.1, 0.5, { active: true, input: 3, rate: 1 }); // start (aligned to 3) at 0.5
  clock.t = 0.2;
  ts.change(0.2, 0.35, { rate: 1.02, semitones: 0 }); // rate-only: re-issued at the start's time and input
  assert.equal(ts.pendingUntil(), 0.5);
  assert.equal(node.map.filter((s) => s.output >= clock.t).length, 1, 'still one pending change in the node');
  for (const at of [0.6, 1.5]) {
    assert.ok(ts.playingAt(at) && node.segAt(at).active);
    assert.ok(near(ts.posAt(at), 3 + 1.02 * (at - 0.5), 1e-12) && near(node.posAt(at), ts.posAt(at), 1e-12));
  }
  clock.t = 0.3;
  ts.change(0.3, 0.45, { active: false }); // PAUSE cancels the start: the deck stays where it was cued
  assert.equal(ts.playingAt(1), false);
  assert.equal(node.segAt(1).active, false);
  assert.ok(near(ts.posAt(1), 2.9, 1e-12) && near(node.posAt(1), 2.9, 1e-12));
});
