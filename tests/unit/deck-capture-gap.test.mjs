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
  const p = x.ts.posAt(clock.t), g = x.grids.segs.at(-1).grid, X = p + ahead; // the live grid, as the tracker's
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
  const X1 = gap(d, clock, 2, 12, 0), X2 = gap(d, clock, 2 + 0.3 * T, -10, 1);
  // Watched until the playhead is well past both: a second jump would be planned behind the first and sent after it.
  const w = watch(engine, clock, d, 5);
  assert.ok(d.ts.posAt(clock.t) > X2 + 2, 'the playhead went past both gaps');
  assert.equal(w.jumps.length, 1, JSON.stringify(w.jumps));
  assert.ok(Math.abs(w.jumps[0].at - X1) < 1e-3 && Math.abs(w.jumps[0].by - 0.012) < 1e-6, JSON.stringify(w.jumps[0]));
  assert.ok(w.bend > 0.005, `the phase loop bent ${(w.bend * 100).toFixed(2)} % for the second step`);
  assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 2, `${clockErrMs(engine, d, clock.t).toFixed(2)} ms off the beat after it`);
});

test('under a held nudge the gap is played as it came', async () => {
  const { clock, engine, d } = await rig();
  await d.act('nudge', { dir: 1, fine: true });
  gap(d, clock, 1, 15);
  const w = watch(engine, clock, d, 2);
  await d.act('nudge', { dir: 0 });
  assert.deepEqual(w.jumps, []);
});

test('a follower sitting a few ms off the beat (inside the phase loop\'s deadband) jumps that off with the gap', async () => {
  // Otherwise the jump's own millisecond of error can tip it over the deadband, and the loop bends 1.5 % right after
  // the gap (seen in the browser: 4.5 ms off before a 20 ms gap, 6.1 ms after, then a bend).
  const { clock, engine, d } = await rig();
  const r = d.ts.rateAt(clock.t), T = d.ts.soon(clock.t);
  d.sched(T, { input: d.ts.posAt(T) - 0.004 * r }); // 4 ms late
  run(engine, clock, 2);
  const late = clockErrMs(engine, d, clock.t);
  assert.ok(late > 3.5 && late < 4.5, `${late.toFixed(2)} ms off before the gap`);
  const X = gap(d, clock, 2, -15);
  const w = watch(engine, clock, d, 4, { quiet: { X, w: 0.02 } });
  assert.equal(w.jumps.length, 1, JSON.stringify(w.jumps));
  assert.ok(Math.abs(w.jumps[0].by - (-0.015 + late / 1000 * r)) < 2e-4, `jumped ${(w.jumps[0].by * 1000).toFixed(2)} ms`);
  assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1, `${clockErrMs(engine, d, clock.t).toFixed(2)} ms off after the gap`);
  assert.ok(w.bend < 0.002, `bent ${(w.bend * 100).toFixed(2)} %`);
});

test('a gap found just before the playhead gets there, after a phase look past it: the jump still takes the few ms off', async () => {
  // Seen in the browser: the gap confirmed 0.17 s before the playhead reached it, the last phase look (it looks a
  // little ahead) had measured past the gap with no jump planned yet, 23 ms, so the jump took none of the 3-4 ms
  // the follower sat off, and the loop bent twice after it. The offset is taken against the grid before the gap.
  const { clock, engine, d } = await rig();
  const r = d.ts.rateAt(clock.t), T = d.ts.soon(clock.t);
  d.sched(T, { input: d.ts.posAt(T) - 0.004 * r }); // 4 ms late
  run(engine, clock, 2);
  const late = clockErrMs(engine, d, clock.t);
  assert.ok(late > 3.5 && late < 4.5, `${late.toFixed(2)} ms off before the gap`);
  const X = gap(d, clock, 0.2, -15);
  d.phaseMs = late + 15 / r; // what a look past the gap reads
  const w = watch(engine, clock, d, 3, { quiet: { X, w: 0.02 } });
  assert.equal(w.jumps.length, 1, JSON.stringify(w.jumps));
  assert.ok(Math.abs(w.jumps[0].by - (-0.015 + late / 1000 * r)) < 2e-4, `jumped ${(w.jumps[0].by * 1000).toFixed(2)} ms`);
  assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1, `${clockErrMs(engine, d, clock.t).toFixed(2)} ms off after the gap`);
  assert.ok(w.bend < 0.002, `bent ${(w.bend * 100).toFixed(2)} %`);
});

// The tracker refines the grid after a gap for as long as it is the live one; by the time the playhead reaches the gap
// the step between the two grids is no longer quite the one found (seen in the browser: 15 ms found, 13 ms a few
// seconds later). A jump of the old step would leave the deck that far off the beat its grid shows, and the phase loop
// bends it back. It jumps the step the grids give where the playhead reaches the gap.
for (const [who, moved] of [['follower', 3], ['follower', -2.5], ['master', 3]]) {
  test(`the grid after a gap moved ${moved} ms since the gap was found: the ${who} jumps the step the grids give now and stays on the beat`, async () => {
    const { clock, engine, m, d } = await rig();
    const x = who === 'master' ? m : d, X = gap(x, clock, 2, 12), live = x.grids.segs.at(-1);
    x.grids.update({ ...live.grid, t0: live.grid.t0 + moved / 1000 }, { n: 0, from: -Infinity, prev: null, jump: x.grids.jump });
    assert.ok(Math.abs(live.shift - 0.012) < 1e-9, 'the step stored when the gap was found stands');
    let pair = 0, dBend = 0;
    const w = watch(engine, clock, x, 5, { quiet: { X, w: 0.02 }, onTick: (t) => {
      const e = pairErrMs(d, m, t);
      if (e != null && Math.abs(x.node.posAt(t) - X) >= 0.02) pair = Math.max(pair, Math.abs(e));
      dBend = Math.max(dBend, bendOf(d, t));
    } });
    assert.equal(w.jumps.length, 1, JSON.stringify(w.jumps));
    assert.ok(Math.abs(w.jumps[0].by - (12 + moved) / 1000) < 2e-4, `jumped ${(w.jumps[0].by * 1000).toFixed(2)} ms, the grids step ${12 + moved} ms`);
    if (who === 'follower') assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1, `${clockErrMs(engine, d, clock.t).toFixed(2)} ms off after the gap`);
    assert.ok(pair < 1, `follower and master ${pair.toFixed(1)} ms apart across the gap`);
    assert.ok(w.bend < 0.002 && dBend < 0.002, `bent: ${(w.bend * 100).toFixed(2)} %, follower ${(dBend * 100).toFixed(2)} %`);
  });
}

test('a gap found after the playhead went through it: the phase loop jumps the step when its error is that step', async () => {
  const { clock, engine, d } = await rig();
  run(engine, clock, 0.5 - ((clock.t - 100) % 0.5) + TICK); // just past a phase-loop look
  gap(d, clock, -0.05, 12);
  const w = watch(engine, clock, d, 3);
  assert.equal(w.jumps.length, 1, JSON.stringify(w.jumps));
  assert.ok(Math.abs(w.jumps[0].by - 0.012) < 0.002, `jumped ${(w.jumps[0].by * 1000).toFixed(2)} ms`);
  assert.ok(w.bend < 0.002, `bent ${(w.bend * 100).toFixed(2)} %`);
});
