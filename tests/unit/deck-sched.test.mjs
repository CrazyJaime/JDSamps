// Deck transport/rate scheduling against a node with the real one-pending-change rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeshift } from '../../engine/timeshift.js';
import { makeEngine, makeDeck, run, FakeNode } from './fixtures/deck-harness.mjs';

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const TICK = 1536 / 48000;
/** The node's playhead and playback rate at output time t (from its own schedule map). */
const nodePos = (node, t) => { const s = node.segAt(t); return s.active ? s.input + s.rate * (t - s.output) : s.input; };
const nodeRate = (node, t) => { const s = node.segAt(t); return s.active ? s.rate : 0; };

/** A free-running master clock at `bpm` (beats at t0 + k·60/bpm), assigned to an absent deck 1. */
function freeMaster(engine, { bpm = 128, t0 = 100 } = {}) {
  const m = { bpm, t0 };
  engine.clock.follow(1);
  engine.updateClock = (now) => {
    const P = 60 / m.bpm;
    engine.clock.update(now, { playing: true, bpm: m.bpm, lastBeat: m.t0 + Math.floor((now - m.t0) / P) * P, period: P });
  };
  return m;
}

function setup({ pitch = 0, liveEdge = 30, cue = 2, bpm = 124, master = null, syncMode = 'BEAT' } = {}) {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  const m = master ? freeMaster(engine, master) : null;
  engine.updateClock(clock.t);
  const d = makeDeck(engine, clock, { pitch, liveEdge, bpm });
  d.params.syncMode = syncMode;
  d.setCue(cue);
  const go = (s) => run(engine, clock, s, (t) => engine.updateClock(t));
  go(0.2);
  return { clock, engine, d, m, go };
}

/** The node itself (not params, not the UI flag) plays at `rate`, and the model agrees with it. */
function assertPlaying(d, t, rate) {
  const s = d.state(t);
  assert.equal(s.playing, true, 'deck shows PLAYING');
  assert.ok(d.node.segAt(t).active, `node segment inactive at +${t}`);
  assert.ok(near(nodeRate(d.node, t), rate, 1e-6), `node rate ${nodeRate(d.node, t)} != ${rate}`);
  assert.ok(near(s.engineRate, rate, 1e-6), `engineRate ${s.engineRate} != ${rate}`);
  assert.ok(near(nodePos(d.node, t), d.ts.posAt(t), 1e-6), `node playhead ${nodePos(d.node, t)} != model ${d.ts.posAt(t)}`);
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
  assert.ok(near(nodePos(d.node, clock.t), 2 + 1.02 * (clock.t - T0), 1e-6), 'start kept at its original output time');
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
  assert.ok(seg.active && near(nodeRate(d.node, clock.t), 1, 1e-9), 'node plays');
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
  assert.equal(nodeRate(d.node, clock.t), 0);
  assert.equal(d.ts.playingAt(clock.t), false);
  assert.ok(near(nodePos(d.node, clock.t), d.ts.posAt(clock.t), 1e-6));
  assert.ok(near(d.ts.posAt(clock.t), 2, 1e-6), 'never moved off the cue');
});

test('pausing during the SYNC-PLAY beat wait cancels the start and leaves the deck on its cue', async () => {
  const { d, clock, go } = setup({ master: { bpm: 128 } });
  await d.act('syncPlay');
  go(0.1);
  await d.act('pause');
  go(1);
  assert.equal(nodeRate(d.node, clock.t), 0);
  assert.equal(d.ts.playingAt(clock.t), false);
  assert.ok(near(d.ts.posAt(clock.t), d.cue, 1e-9) && near(nodePos(d.node, clock.t), d.cue, 1e-9), `playhead ${d.ts.posAt(clock.t)}, cue ${d.cue}`);
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

test('Timeshift.bend ends at the rate the caller asks for; with pitchFollows the pitch bends too', () => {
  const clock = { t: 0 };
  const ts = new Timeshift(new FakeNode(clock), { sampleRate: 48000, latency: 0.12, outLatency: 0.06 });
  ts.liveEdge = 30;
  ts.change(0, 0.2, { active: true, input: 0, rate: 1, semitones: 0 });
  clock.t = 1;
  assert.ok(near(ts.bend(1, 1.2, 1.04, 0.5, { rate: 1.02 }), 1.7, 1e-12));
  assert.ok(near(ts.rateAt(1.3), 1.04, 1e-12), 'bend is relative to the rate in effect');
  assert.equal(ts.segAt(1.3).semitones, 0, 'key lock: pitch untouched');
  assert.ok(near(ts.rateAt(1.8), 1.02, 1e-12), 'bend ends at the requested rate');
  clock.t = 1.21; ts.flush(1.21);
  clock.t = 2;
  assert.ok(near(ts.bend(2, 2.2, 1.04, 0.5), 2.7, 1e-12));
  assert.ok(near(ts.rateAt(2.8), 1.02, 1e-12), 'without an end rate the bend returns to the rate in effect');
  clock.t = 2.21; ts.flush(2.21);
  clock.t = 3;
  ts.bend(3, 3.2, 0.98, 0.5, { rate: 1.02, semitones: 12 * Math.log2(1.02) }, true);
  assert.ok(near(ts.segAt(3.3).semitones, 12 * Math.log2(0.98), 1e-12), 'vinyl: pitch bends with the speed');
  assert.ok(near(ts.segAt(3.8).semitones, 12 * Math.log2(1.02), 1e-12));
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
    assert.ok(near(ts.posAt(at), 3 + 1.02 * (at - 0.5), 1e-12) && near(nodePos(node, at), ts.posAt(at), 1e-12));
  }
  clock.t = 0.3;
  ts.change(0.3, 0.45, { active: false }); // PAUSE cancels the start: the deck stays where it was cued
  assert.equal(ts.playingAt(1), false);
  assert.equal(node.segAt(1).active, false);
  assert.ok(near(ts.posAt(1), 2.9, 1e-12) && near(nodePos(node, 1), 2.9, 1e-12));
});

// ---------------------------------------------------------------- I5: SYNC PLAY resumes in place
const BEAT = 60 / 124;

test('SYNC PLAY after a pause resumes from the paused position, beat-aligned, not from the cue', async () => {
  const { d, clock, go } = setup({ master: { bpm: 128 } });
  await d.act('play');
  go(10);
  await d.act('pause');
  go(1);
  const paused = d.ts.posAt(clock.t);
  assert.ok(paused > 11, `paused at ${paused}`);
  await d.act('syncPlay');
  const start = d.ts.segs[d.ts.segs.length - 1];
  assert.ok(start.active && Math.abs(start.input - paused) <= BEAT / 2 + 1e-9, `resumes at ${start.input}, paused at ${paused}`);
  go(3);
  assertPlaying(d, clock.t, 128 / 124);
  assert.ok(d.phaseMs != null && Math.abs(d.phaseMs) < 3, `phase ${d.phaseMs} ms`);
});

test('SYNC PLAY from the cue (fresh, or returned by CUE) starts at the cue', async () => {
  const { d, clock, go } = setup({ master: { bpm: 128 } });
  await d.act('syncPlay');
  let start = d.ts.segs[d.ts.segs.length - 1];
  assert.ok(Math.abs(start.input - d.cue) <= BEAT / 2 + 1e-9, `fresh deck starts at ${start.input}, cue ${d.cue}`);
  go(5);
  await d.act('cueDown');   // playing: back to the cue and pause
  go(0.5);
  assert.ok(near(d.ts.posAt(clock.t), d.cue, 1e-9));
  await d.act('syncPlay');
  start = d.ts.segs[d.ts.segs.length - 1];
  assert.ok(Math.abs(start.input - d.cue) <= BEAT / 2 + 1e-9, `CUE-returned deck starts at ${start.input}, cue ${d.cue}`);
});

// ---------------------------------------------------------------- M8: vinyl pitch follows the applied rate
test('vinyl mode: a starved deck clamped to 1x is not detuned', async () => {
  const { d, clock, go } = setup({ pitch: 0.067 });
  d.setParam('keyLock', false);
  d.ts.liveEdge = d.cue + d.ts.lat + 0.45; // Web-Audio-only page, reserve under GUARD
  await d.act('play');
  go(1);
  assert.equal(d.starved, true);
  assertPlaying(d, clock.t, 1);
  assert.ok(near(d.node.segAt(clock.t).semitones, 0, 1e-9), `semitones ${d.node.segAt(clock.t).semitones} at 1x`);
});

test('vinyl mode: a nudge bends the pitch with the speed', async () => {
  const { d, clock, go } = setup();
  d.setParam('keyLock', false);
  await d.act('play');
  go(1);
  await d.act('nudge', { dir: 1 });
  go(0.5);
  assertPlaying(d, clock.t, 1.04);
  assert.ok(near(d.node.segAt(clock.t).semitones, 12 * Math.log2(1.04), 1e-9), `semitones ${d.node.segAt(clock.t).semitones}`);
  await d.act('nudge', { dir: 0 });
  go(0.5);
  assert.ok(near(d.node.segAt(clock.t).semitones, 0, 1e-9));
});

test('vinyl mode: a phase bend moves the pitch with the speed, key lock keeps it', async () => {
  for (const keyLock of [false, true]) {
    const { d, clock, go, m } = setup({ master: { bpm: 128 } });
    d.setParam('keyLock', keyLock);
    await d.act('syncPlay');
    go(3);
    const want = 128 / 124;
    m.t0 += 0.02;           // the master's beats move 20 ms: the phase loop bends
    let bent = null;
    for (let i = 0; i < 200 && !bent; i++) { go(TICK); const r = nodeRate(d.node, clock.t); if (Math.abs(r - want) > 1e-6) bent = d.node.segAt(clock.t); }
    assert.ok(bent, 'a bend happened');
    const semis = keyLock ? 0 : 12 * Math.log2(bent.rate);
    assert.ok(near(bent.semitones, semis, 1e-9), `keyLock=${keyLock}: bent rate ${bent.rate}, semitones ${bent.semitones}`);
    go(4);
    assertPlaying(d, clock.t, want);
    assert.ok(near(d.node.segAt(clock.t).semitones, keyLock ? 0 : 12 * Math.log2(want), 1e-9), 'pitch settles with the rate');
  }
});
