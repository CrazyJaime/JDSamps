// Deck navigation: seek, beat jump and search move the deck's own playhead within what it has
// buffered (so the DJ never scrubs the source tab), keep the beat phase when they must, land fast
// enough to follow a drag, and compose with a pending start, a roll and a CUE preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUiMessage } from '../../shared/protocol.js';
import { GridMap, LIVE_RESERVE } from '../../engine/timeshift.js';
import { wrapToHalf } from '../../engine/sync.js';
import { makeEngine, makeDeck, run, trueBeatOut, clockErrMs } from './fixtures/deck-harness.mjs';

const BPM = 124, BEAT = 60 / BPM;
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const last = (node) => node.map[node.map.length - 1];

/** One deck, paused at its cue, with `liveEdge` s buffered from `historyStart`. */
function rig({ liveEdge = 120, historyStart = 0, pitch = 0, cue = historyStart + 2 } = {}) {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  engine.params['assist.on'] = false;
  const d = makeDeck(engine, clock, { id: 1, slot: 1, liveEdge, bpm: BPM, pitch, capSec: 1e7 });
  d.ts.historyStart = historyStart;
  d.setCue(cue);
  const go = (s) => run(engine, clock, s);
  go(0.2);
  return { clock, engine, d, go };
}

/** A playing 128 BPM master on deck 1 and a 124 BPM deck 2 SYNCed (BEAT) to it, settled in phase. */
async function synced() {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
  const s = makeDeck(engine, clock, { id: 2, slot: 2, bpm: BPM, t0: 0.13, liveEdge: 600, capSec: 1e7 });
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2);
  assert.deepEqual(await s.act('sync', { on: true }), { ok: true });
  assert.deepEqual(await s.act('syncPlay'), { ok: true });
  run(engine, clock, 10);
  assert.ok(Math.abs(clockErrMs(engine, s, clock.t)) < 2, `in phase before: ${clockErrMs(engine, s, clock.t)}`);
  return { clock, engine, m, s };
}

// ---------------------------------------------------------------- seek
test('a paused deck seeks at once: the node is scheduled at the input position asked', async () => {
  const { clock, d } = rig();
  assert.deepEqual(await d.act('seek', { pos: 37.25 }), { ok: true });
  const t = clock.t + 0.001;
  assert.ok(near(d.node.posAt(t), 37.25, 1e-9), `node at ${d.node.posAt(t)}`);
  assert.equal(d.node.segAt(t).active, false, 'still paused');
  assert.ok(near(d.state(t).playhead, 37.25, 1e-9), 'the snapshot shows it at once');
});

test('a playing deck lands a seek within 60 ms of the press (not soon()\'s 150 ms), then plays from there', async () => {
  const { clock, d, go } = rig();
  await d.act('play');
  go(1);
  const now = clock.t;
  assert.deepEqual(await d.act('seek', { pos: 50 }), { ok: true });
  const seg = last(d.node);
  assert.equal(seg.input, 50);
  assert.equal(seg.active, true);
  const lead = seg.output - now;
  assert.ok(lead <= 0.06 + 1e-9 && lead >= 0.03, `lands ${(lead * 1000).toFixed(0)} ms after the press`);
  go(0.5);
  assert.ok(near(d.node.posAt(clock.t), 50 + (clock.t - seg.output), 1e-6), `node at ${d.node.posAt(clock.t)}`);
  assert.ok(near(d.ts.posAt(clock.t), d.node.posAt(clock.t), 1e-9), 'the model agrees with the node');
});

test('a seek outside the buffer is refused, saying how much is buffered, and leaves the playhead alone', async () => {
  const { clock, d } = rig({ historyStart: 5 });
  assert.deepEqual(await d.act('seek', { pos: 17 }), { ok: true });
  const behind = await d.act('seek', { pos: 2 });
  assert.equal(behind.ok, false);
  assert.match(behind.error, /only 12 s buffered behind the playhead/i);
  const ahead = await d.act('seek', { pos: d.ts.liveEdge + 5 });
  assert.equal(ahead.ok, false);
  assert.match(ahead.error, /only 103 s buffered ahead of the playhead/i);
  assert.ok(near(d.node.posAt(clock.t + 0.001), 17, 1e-9), 'refused seeks moved nothing');
});

test('a seek into the edges of the buffer is clamped to the margins the other jumps keep', async () => {
  const { clock, d, go } = rig({ historyStart: 5 });
  await d.act('seek', { pos: 5 });
  assert.ok(near(d.node.posAt(clock.t + 0.001), 5.01, 1e-9), 'oldest audio: historyStart + 0.01');
  await d.act('seek', { pos: d.ts.liveEdge });
  assert.ok(near(d.node.posAt(clock.t + 0.001), d.ts.liveEdge - d.ts.lat - 0.3, 1e-9), 'paused: the clampInput margin');
  await d.act('seek', { pos: 20 });
  await d.act('play');
  go(1);
  await d.act('seek', { pos: d.ts.liveEdge });
  const seg = last(d.node);
  assert.ok(near(seg.input, d.ts.liveEdge - d.ts.lat - LIVE_RESERVE, 1e-9), `playing: LIVE's reserve, got ${seg.input}`);
});

test('a quantized seek on a deck SYNCed in BEAT keeps it in phase with the master', async () => {
  const { clock, engine, s } = await synced();
  const before = s.ts.posAt(clock.t);
  assert.deepEqual(await s.act('seek', { pos: before + 7.3 }), { ok: true }); // synced + playing: quantized by itself
  const T = last(s.node).output;
  run(engine, clock, 0.3);
  const err = clockErrMs(engine, s, clock.t);
  assert.ok(Math.abs(err) < 2, `${err.toFixed(2)} ms off the master after the seek`);
  const landed = s.node.segAt(T).input;
  assert.ok(Math.abs(landed - (before + 7.3)) <= 0.25, `landed ${landed}, asked ${before + 7.3}: within half a beat`);
});

test('the master a BEAT-synced deck follows keeps its own beat phase when it seeks, so the follower stays locked', async () => {
  const { clock, engine, m, s } = await synced();
  const b0 = trueBeatOut(m, clock.t);
  assert.deepEqual(await m.act('seek', { pos: m.ts.posAt(clock.t) + 5.3 }), { ok: true });
  run(engine, clock, 0.4);
  const b1 = trueBeatOut(m, clock.t);
  const e = wrapToHalf(b1.lastBeat - b0.lastBeat, b0.period) * 1000;
  assert.ok(Math.abs(e) < 0.5, `the master's beat moved ${e.toFixed(2)} ms`);
  run(engine, clock, 1);
  assert.ok(Math.abs(clockErrMs(engine, s, clock.t)) < 2, `follower ${clockErrMs(engine, s, clock.t).toFixed(2)} ms off`);
});

test('quantize on an unsynced playing deck moves it whole beats: its own beat phase is kept', async () => {
  const { clock, d, go } = rig();
  await d.act('play');
  go(2);
  const b0 = trueBeatOut(d, clock.t);
  assert.deepEqual(await d.act('seek', { pos: 41.17, quantize: true }), { ok: true });
  go(0.4);
  const b1 = trueBeatOut(d, clock.t);
  const e = wrapToHalf(b1.lastBeat - b0.lastBeat, b0.period) * 1000;
  assert.ok(Math.abs(e) < 0.5, `beat phase moved ${e.toFixed(2)} ms`);
  assert.ok(Math.abs(b1.p - 41.17 - (clock.t - last(d.node).output)) <= BEAT / 2, `landed near 41.17: ${b1.p}`);
});

test('without quantize or sync a playing deck lands exactly where asked', async () => {
  const { clock, d, go } = rig();
  await d.act('play');
  go(2);
  await d.act('seek', { pos: 41.17 });
  assert.equal(last(d.node).input, 41.17);
  go(0.2);
  assert.ok(clock.t > last(d.node).output);
});

test('a quantized seek on a paused deck lands on the nearest beat', async () => {
  const { clock, d } = rig();
  await d.act('seek', { pos: 10.1, quantize: true });
  assert.ok(near(d.node.posAt(clock.t + 0.001), Math.round(10.1 / BEAT) * BEAT, 1e-9), `at ${d.node.posAt(clock.t + 0.001)}`);
});

// ---------------------------------------------------------------- beat jump
test('beat jump on a synced deck moves whole beats and stays in phase with the master', async () => {
  const { clock, engine, s } = await synced();
  for (const beats of [8, -4]) {
    const now = clock.t, at = s.ts.posAt(now);
    assert.deepEqual(await s.act('beatJump', { beats }), { ok: true });
    const seg = last(s.node), T = seg.output;
    const expected = at + s.ts.rateAt(now) * (T - now) + beats * BEAT; // where it would have been, plus N beats
    assert.ok(Math.abs(seg.input - expected) < 0.003, `${beats} beats: landed ${seg.input}, expected ${expected}`);
    run(engine, clock, 1);
    const err = clockErrMs(engine, s, clock.t);
    assert.ok(Math.abs(err) < 2, `${beats} beats: ${err.toFixed(2)} ms off the master`);
  }
});

test('beat jump on a paused deck moves the playhead N beats', async () => {
  const { clock, d } = rig({ cue: 10 });
  assert.deepEqual(await d.act('beatJump', { beats: 16 }), { ok: true });
  assert.ok(near(d.node.posAt(clock.t + 0.001), 10 + 16 * BEAT, 1e-9));
  assert.equal(d.node.segAt(clock.t + 0.001).active, false);
});

test('beat jump with no beat grid is refused with a reason', async () => {
  const { d } = rig();
  d.grids = new GridMap();
  d.tempo.grid = null;
  const r = await d.act('beatJump', { beats: 4 });
  assert.equal(r.ok, false);
  assert.match(r.error, /beat grid/i);
});

test('beat jump past the buffer is refused (not clamped into a phase-breaking jump), with the amount', async () => {
  const { clock, d } = rig({ historyStart: 5, cue: 7 });
  const r = await d.act('beatJump', { beats: -8 });
  assert.equal(r.ok, false);
  assert.match(r.error, /only 2\.0 s buffered behind the playhead/i);
  assert.ok(near(d.node.posAt(clock.t + 0.001), 7, 1e-9), 'nothing moved');
  d.ts.liveEdge = 12;
  const f = await d.act('beatJump', { beats: 16 });
  assert.equal(f.ok, false);
  assert.match(f.error, /buffered ahead of the playhead/i);
});

// ---------------------------------------------------------------- composition
test('a seek during a pending PLAY starts at the planned time, from the seek target', async () => {
  const { clock, d, go } = rig();
  await d.act('play');
  const Ts = d.ts.pendingUntil();
  assert.ok(Ts > clock.t + 0.1, 'the start is still pending');
  await d.act('seek', { pos: 20 });
  go(0.5);
  const start = d.node.map.find((x) => x.active && x.input === 20);
  assert.ok(start, `the start carries the seek: ${JSON.stringify(d.node.map)}`);
  assert.ok(near(start.output, Ts, 1e-9), `started at ${start.output}, planned ${Ts}`);
  assert.equal(d.node.segAt(Ts - 0.005).active, false, 'not before its time');
  assert.ok(near(d.node.posAt(clock.t), 20 + (clock.t - Ts), 1e-6));
});

test('a seek during a pending SYNC PLAY keeps the start on the master beat, in phase', async () => {
  const { clock, engine, m } = await synced();
  const d = makeDeck(engine, clock, { id: 3, slot: 3, bpm: 126, t0: 0.05, liveEdge: 600, capSec: 1e7 });
  d.setCue(3);
  run(engine, clock, 0.2);
  assert.deepEqual(await d.act('sync', { on: true }), { ok: true });
  assert.deepEqual(await d.act('syncPlay'), { ok: true });
  const Ts = d.ts.pendingUntil();
  assert.deepEqual(await d.act('seek', { pos: 30.2 }), { ok: true });
  assert.ok(near(d.ts.pendingUntil(), Ts, 1e-9), 'the start stays on the master beat');
  run(engine, clock, 1);
  assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 2, `${clockErrMs(engine, d, clock.t).toFixed(2)} ms off at start`);
  assert.ok(Math.abs(d.node.segAt(Ts).input - 30.2) <= 0.25, `started near the target: ${d.node.segAt(Ts).input}`);
  assert.ok(m.wantPlay);
});

test('a seek during a roll moves the slip target: the roll keeps rolling, the release lands there', async () => {
  const { clock, d, go } = rig();
  await d.act('play');
  go(2);
  await d.act('rollStart', { beats: 1 });
  go(0.3);
  const loop = { ...d.loop };
  assert.deepEqual(await d.act('seek', { pos: 60 }), { ok: true });
  go(0.5);
  assert.equal(d.roll, 1, 'still rolling');
  const p = d.ts.posAt(clock.t);
  assert.ok(p >= loop.start - 1e-9 && p <= loop.end + 1e-9, `the roll keeps looping: ${p} in [${loop.start}, ${loop.end}]`);
  assert.ok(d.ts.segAt(clock.t).loopEnd > 0 && last(d.node).loopEnd > 0, 'the loop is still scheduled');
  await d.act('rollEnd');
  const end = last(d.node);
  go(0.5);
  assert.equal(end.loopEnd, 0);
  assert.ok(end.input > 60 && end.input < 61, `released into the moved slip: ${end.input}`);
  assert.ok(near(d.node.posAt(clock.t), end.input + (clock.t - end.output), 1e-6));
});

test('a seek during a CUE preview moves the preview; letting go of CUE still returns to the cue', async () => {
  const { clock, d, go } = rig();
  await d.act('cueDown');
  go(0.3);
  assert.equal(d.previewing, true);
  await d.act('seek', { pos: 30 });
  go(0.3);
  assert.ok(d.node.posAt(clock.t) > 30 && d.node.posAt(clock.t) < 30.4, `preview from 30: ${d.node.posAt(clock.t)}`);
  await d.act('cueUp');
  go(0.4);
  assert.equal(d.node.segAt(clock.t).active, false);
  assert.ok(near(d.node.posAt(clock.t), 2, 1e-9), 'back at the cue');
});

test('a starved deck: a seek back refills its reserve and frees its tempo; a seek to the edge keeps LIVE\'s reserve (no emergency jump)', async () => {
  const { clock, engine, d, go } = rig({ pitch: 0.05, cue: 50 });
  d.ts.liveEdge = 50 + d.ts.lat + 0.45; // a Web-Audio-only page (no assist): reserve under GUARD
  await d.act('play');
  go(0.5);
  assert.equal(d.starved, true, 'starved at 1x');
  await d.act('seek', { pos: 30 });
  go(0.5);
  assert.equal(d.starved, false, 'the reserve is back');
  assert.ok(near(d.node.segAt(clock.t).rate, 1.05, 1e-9), `rate ${d.node.segAt(clock.t).rate}`);
  const jumps = d.node.log.length;
  await d.act('seek', { pos: d.ts.liveEdge });
  const seg = last(d.node);
  assert.ok(d.ts.liveEdge - d.ts.lat - seg.input >= LIVE_RESERVE - 1e-9, `lands with ${d.ts.liveEdge - d.ts.lat - seg.input} s of reserve`);
  go(1);
  assert.equal(d.node.log.slice(jumps + 1).filter((x) => x.input !== undefined && x.input < seg.input - 0.5).length, 0, 'no emergency jump back');
  assert.equal(engine.events.filter((e) => /dry/.test(e.text)).length, 0);
});

test('a drag (a seek every 32 ms) is heard while it lasts, not only after the hand stops', async () => {
  const { clock, d, go } = rig();
  await d.act('play');
  go(1);
  const t0 = clock.t;
  let target = 40;
  let heardDuring = false;
  for (let k = 0; k < 20; k++) {
    await d.act('seek', { pos: target });
    target += 0.05;
    go(0.032);
    if (clock.t - t0 > 0.15 && d.node.posAt(clock.t) > 39) heardDuring = true;
  }
  assert.ok(heardDuring, 'the node never moved while the drag went on');
  go(0.2);
  const lastTarget = target - 0.05;
  assert.ok(Math.abs(d.node.posAt(clock.t) - lastTarget) < 0.3, `ends at the last target: ${d.node.posAt(clock.t)} vs ${lastTarget}`);
});

// ---------------------------------------------------------------- search (paused nudge)
test('nudge on a paused deck searches: the playhead moves while held, faster the longer, and stops on release', async () => {
  const { clock, d, go } = rig({ cue: 60 });
  await d.act('nudge', { dir: -1 });
  const p = [d.ts.posAt(clock.t)];
  for (let i = 0; i < 4; i++) { go(0.5); p.push(d.ts.posAt(clock.t)); }
  assert.equal(d.node.segAt(clock.t).active, false, 'searching does not start the deck');
  const steps = p.slice(1).map((x, i) => p[i] - x);
  assert.ok(steps.every((s) => s > 0), `moves back: ${steps}`);
  assert.ok(steps[3] > 2 * steps[0], `accelerates: ${steps.map((s) => s.toFixed(3))}`);
  assert.ok(near(d.node.posAt(clock.t), d.ts.posAt(clock.t), 1e-9), 'the node follows');
  await d.act('nudge', { dir: 0 });
  const at = d.ts.posAt(clock.t);
  go(0.5);
  assert.ok(near(d.ts.posAt(clock.t), at, 1e-9), 'stops on release');
  assert.equal(d.state(clock.t).nudge, 0);
});

test('a search stops at the start of the buffer', async () => {
  const { clock, d, go } = rig({ historyStart: 3, cue: 3.5 });
  await d.act('nudge', { dir: -1 });
  go(3);
  assert.ok(near(d.ts.posAt(clock.t), 3.01, 1e-9), `at ${d.ts.posAt(clock.t)}`);
});

test('a page that goes away mid-search ends it (releaseHolds)', async () => {
  const { clock, d, go } = rig({ cue: 40 });
  await d.act('nudge', { dir: 1 });
  go(0.5);
  assert.ok(d.ts.posAt(clock.t) > 40.1, `searching: ${d.ts.posAt(clock.t)}`);
  await d.releaseHolds();
  const at = d.ts.posAt(clock.t);
  go(0.5);
  assert.ok(near(d.ts.posAt(clock.t), at, 1e-9));
});

test('a jog bend (nudge with an amount) lands within 60 ms at that rate', async () => {
  const { clock, d, go } = rig();
  await d.act('play');
  go(1);
  const now = clock.t;
  await d.act('nudge', { dir: -1, amt: 0.025 });
  const seg = last(d.node);
  assert.ok(seg.output - now <= 0.06 + 1e-9, `lands ${((seg.output - now) * 1000).toFixed(0)} ms after`);
  assert.ok(near(seg.rate, 0.975, 1e-9), `rate ${seg.rate}`);
  go(0.2);
  await d.act('nudge', { dir: 0 });
  go(0.2);
  assert.ok(near(d.node.segAt(clock.t).rate, 1, 1e-9));
});

// ---------------------------------------------------------------- protocol
test('seek, beatJump and nudge amounts are validated', () => {
  const act = (a, arg) => validateUiMessage({ t: 'act', deck: 1, a, arg });
  assert.deepEqual(act('seek', { pos: 12.5 }), { ok: true, arg: { pos: 12.5, quantize: false } });
  assert.deepEqual(act('seek', { pos: 3, quantize: true }).arg, { pos: 3, quantize: true });
  for (const bad of [{}, { pos: 'x' }, { pos: NaN }, { pos: Infinity }, { pos: 1, quantize: 'yes' }]) assert.equal(act('seek', bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(act('beatJump', { beats: -16 }), { ok: true, arg: { beats: -16 } });
  for (const bad of [{}, { beats: 0 }, { beats: 1.5 }, { beats: 129 }, { beats: '4' }]) assert.equal(act('beatJump', bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(act('nudge', { dir: 1, amt: 0.02 }).arg, { dir: 1, fine: false, amt: 0.02 });
  assert.deepEqual(act('nudge', { dir: 1 }).arg, { dir: 1, fine: false });
  for (const bad of [{ dir: 1, amt: 0 }, { dir: 1, amt: 0.2 }, { dir: 1, amt: -0.01 }, { dir: 1, amt: 'x' }]) assert.equal(act('nudge', bad).ok, false, JSON.stringify(bad));
});
