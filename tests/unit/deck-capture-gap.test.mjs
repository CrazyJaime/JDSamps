// A tab capture under load drops or repeats 10-20 ms of audio now and then. The tracker finds the step (DeckTempo
// detectJump) and the grid map splits there (a segment whose beats come `shift` s later). A beat-locked deck used to
// play the step as it came, and the phase loop then bent it back by 2-4 % for a beat or two, an audible wobble. It
// jumps the playhead across the gap instead: by the same step, where the playhead reaches it, so its beats never
// leave the master's. Gaps up to 60 ms, at most one jump a beat, only on a beat-locked deck (a BEAT follower, or the
// master BEAT followers lock to), never under a nudge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run, clockErrMs, pairErrMs } from './fixtures/deck-harness.mjs';

const TICK = 1536 / 48000;

/** A playing 128 BPM master (deck 1) and a 124 BPM deck (deck 2) SYNC PLAYed to it in `mode`, settled. */
async function rig({ mode = 'BEAT', sync = true } = {}) {
  const clock = { t: 100 }, engine = makeEngine(clock);
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
  const d = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 124, t0: 0.11, liveEdge: 600, capSec: 1e7, syncMode: mode });
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2);
  assert.deepEqual(await d.act(sync ? 'syncPlay' : 'play'), { ok: true });
  run(engine, clock, 10);
  return { clock, engine, m, d };
}

/**
 * A capture gap `ahead` s of input past deck x's playhead (negative: behind it, found late): the beats after it come
 * `ms` later (a repeat) or earlier (a drop), as the tracker reports one (track.jump) and the grid map splits on it.
 */
function gap(x, clock, ahead, ms, n = 0) {
  const p = x.ts.posAt(clock.t), g = x.grids.at(p), X = p + ahead;
  x.grids.update({ ...g, t0: g.t0 + ms / 1000 }, { n: 0, from: -Infinity, prev: null, jump: { n, from: X, prev: { ...g } } });
  assert.ok(Math.abs(x.grids.seg(X + 1e-6).shift - ms / 1000) < 1e-9, 'the grid map split on the gap');
  return X;
}

/** How far (fraction) deck x's node plays off the rate it is synced to at output time t, 0 when it is not playing. */
const bendOf = (x, t) => { const seg = x.node.segAt(t); return seg.active ? Math.abs(seg.rate / ((1 + x.params.pitch) * x.nudgeFactor) - 1) : 0; };

/**
 * Run `s` seconds: the worst phase error (ms) of `x` against the master clock, its worst bend, and its playhead
 * jumps. A drop is jumped back across, so the few ms before the gap play twice: the error is not read while the
 * playhead is within `quiet` (input s) of it, where no beat falls (the tracker puts a gap between two beats).
 */
function watch(engine, clock, x, s, { quiet = null, onTick = () => {} } = {}) {
  const from = x.node.log.length;
  let err = 0, bend = 0;
  run(engine, clock, s, (t) => {
    const e = clockErrMs(engine, x, t);
    if (e != null && !(quiet && Math.abs(x.node.posAt(t) - quiet.X) < quiet.w)) err = Math.max(err, Math.abs(e));
    bend = Math.max(bend, bendOf(x, t));
    onTick(t);
  });
  // A jump: a change whose input is off where the segment before it would have been at its output time.
  const jumps = [];
  for (let i = Math.max(1, from); i < x.node.log.length; i++) {
    const a = x.node.log[i - 1], b = x.node.log[i];
    if (!a.active || b.active === false) continue;
    const at = a.input + a.rate * (b.output - a.output);
    if (Math.abs(b.input - at) > 1e-4) jumps.push({ output: b.output, at, by: b.input - at });
  }
  return { err, bend, jumps };
}

for (const ms of [12, -15, 40]) {
  test(`a BEAT follower jumps a ${ms > 0 ? 'repeat' : 'drop'} of ${Math.abs(ms)} ms in its capture where its playhead reaches it, and never bends`, async () => {
    const { clock, engine, d } = await rig();
    assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1, 'locked before the gap');
    const X = gap(d, clock, 2, ms);
    const w = watch(engine, clock, d, 5, { quiet: { X, w: Math.abs(ms) / 1000 } });
    assert.equal(w.jumps.length, 1, `jumps ${JSON.stringify(w.jumps)}`);
    assert.ok(Math.abs(w.jumps[0].by - ms / 1000) < 1e-6, `jumped ${(w.jumps[0].by * 1000).toFixed(2)} ms for a step of ${ms} ms`);
    assert.ok(Math.abs(w.jumps[0].at - X) < 1e-3, `jumped at input ${w.jumps[0].at.toFixed(4)}, the gap is at ${X.toFixed(4)}`);
    assert.ok(w.err < 1, `${w.err.toFixed(1)} ms off the master across the gap`);
    assert.ok(w.bend < 0.002, `bent ${(w.bend * 100).toFixed(2)} %`);
  });
}

test('the master BEAT followers lock to jumps a gap in its own capture, so neither it nor they move off the beat', async () => {
  const { clock, engine, m, d } = await rig();
  const X = gap(m, clock, 2, -12);
  let pair = 0, dBend = 0;
  const mw = watch(engine, clock, m, 5, { quiet: { X, w: 0.012 }, onTick: (t) => {
    const e = pairErrMs(d, m, t);
    if (e != null && Math.abs(m.node.posAt(t) - X) >= 0.012) pair = Math.max(pair, Math.abs(e));
    dBend = Math.max(dBend, bendOf(d, t));
  } });
  assert.equal(mw.jumps.length, 1, `master jumps ${JSON.stringify(mw.jumps)}`);
  assert.ok(Math.abs(mw.jumps[0].by + 0.012) < 1e-6 && Math.abs(mw.jumps[0].at - X) < 1e-3, `master jumped ${JSON.stringify(mw.jumps[0])}`);
  assert.ok(mw.bend < 0.002 && dBend < 0.002, `bent: master ${(mw.bend * 100).toFixed(2)} %, follower ${(dBend * 100).toFixed(2)} %`);
  assert.ok(pair < 1, `follower and master ${pair.toFixed(1)} ms apart across the gap`);
});

test('a deck that is not beat-locked plays a capture gap as it came: unsynced, TEMPO sync, or a master nobody locks to', async () => {
  for (const [name, opts, deck] of [['unsynced', { sync: false }, 'd'], ['TEMPO sync', { mode: 'TEMPO' }, 'd'], ['lone master', { sync: false }, 'm']]) {
    const r = await rig(opts), x = r[deck];
    gap(x, r.clock, 2, 15);
    const w = watch(r.engine, r.clock, x, 4);
    assert.deepEqual(w.jumps, [], `${name}: ${JSON.stringify(w.jumps)}`);
  }
});

test('a step over 60 ms is no capture gap: no jump', async () => {
  const { clock, engine, d } = await rig();
  gap(d, clock, 2, 80);
  const w = watch(engine, clock, d, 1.9);
  assert.deepEqual(w.jumps, []);
});

test('two gaps within a beat: one jump, the second step goes to the phase loop', async () => {
  const { clock, engine, d } = await rig();
  const T = 60 / 124;
  gap(d, clock, 2, 12, 0);
  gap(d, clock, 2 + 0.3 * T, -10, 1);
  const w = watch(engine, clock, d, 1.5);
  assert.equal(w.jumps.length, 1, JSON.stringify(w.jumps));
});

test('under a held nudge the gap is played as it came', async () => {
  const { clock, engine, d } = await rig();
  await d.act('nudge', { dir: 1, fine: true });
  gap(d, clock, 1, 15);
  const w = watch(engine, clock, d, 2);
  await d.act('nudge', { dir: 0 });
  assert.deepEqual(w.jumps, []);
});

test('a gap found after the playhead went through it: the phase loop jumps the step when its error is that step', async () => {
  const { clock, engine, d } = await rig();
  run(engine, clock, 0.5 - ((clock.t - 100) % 0.5) + TICK); // just past a phase-loop look
  gap(d, clock, -0.05, 12);
  const w = watch(engine, clock, d, 3);
  assert.equal(w.jumps.length, 1, JSON.stringify(w.jumps));
  assert.ok(Math.abs(w.jumps[0].by - 0.012) < 0.002, `jumped ${(w.jumps[0].by * 1000).toFixed(2)} ms`);
  assert.ok(w.bend < 0.002, `bent ${(w.bend * 100).toFixed(2)} %`);
});
