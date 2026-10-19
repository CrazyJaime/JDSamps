// A tab capture under load drops or repeats 10-20 ms of audio now and then. The tracker finds the step (DeckTempo
// detectJump) and the grid map splits there (a segment whose beats come `shift` s later). A beat-locked deck used to
// play the step as it came, and the phase loop then bent it back by 2-4 % for a beat or two, an audible wobble. It
// jumps the playhead across the gap instead: by the same step, where the playhead reaches it, so its beats never
// leave the master's. Gaps up to 60 ms, at most one jump a beat, only on a beat-locked deck (a BEAT follower, or the
// master BEAT followers lock to), never under a nudge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run, clockErrMs, pairErrMs } from './fixtures/deck-harness.mjs';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { GridMap } from '../../engine/timeshift.js';

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
  const t0 = clock.t;
  let err = 0, bend = 0;
  run(engine, clock, s, (t) => {
    const e = clockErrMs(engine, x, t);
    if (e != null && !(quiet && Math.abs(x.node.posAt(t) - quiet.X) < quiet.w)) err = Math.max(err, Math.abs(e));
    bend = Math.max(bend, bendOf(x, t));
    onTick(t);
  });
  // A jump: a change the node played whose input is off where the segment before it would have been at its output time
  // (the node's own schedule: a planned change that a later one dropped was never played).
  const jumps = [], map = x.node.map;
  for (let i = 1; i < map.length; i++) {
    const a = map[i - 1], b = map[i];
    if (b.output <= t0) continue;
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

// The DJ's hand on a beat-locked deck (a nudge, a roll, a beat jump, the master's tempo fader) is heard as soon as with
// no gap coming. A gap jump planned ahead used to take every later change into itself, so the hand waited for the
// jump (up to 0.6 s), and a short nudge tap was lost in it. Planned 0.6 s ahead, it also held back what waits for a
// planned change to pass: a follower following the master's tempo move.
const HANDS = {
  nudge: { on: 'd', press: ({ d }) => d.act('nudge', { dir: 1 }), heard: (x, s, r0) => s.rate > r0 * 1.03 },
  roll: { on: 'd', press: ({ d }) => d.act('rollStart', { beats: 0.25 }), heard: (x, s) => s.loopEnd > s.loopStart },
  'beat jump': { on: 'd', press: ({ d }) => d.act('beatJump', { beats: 4 }), heard: (x, s, r0, p0, t0, t) => x.node.posAt(t) - (p0 + r0 * (t - t0)) > 1.5 },
  "the master's tempo fader": { on: 'm', press: ({ m }) => m.setParam('pitch', 0.02), heard: (x, s, r0) => s.rate > r0 * 1.015 },
  "the master's tempo fader, on its follower": { on: 'd', aheads: [0.5], press: ({ m }) => m.setParam('pitch', 0.02), heard: (x, s, r0) => s.rate > r0 * 1.015 },
};

/** Output s from `hand` pressed until the node of the deck it is on plays it: with no gap coming in that deck's capture, or one `ahead` input s ahead. */
async function handDelay(hand, ahead) {
  const r = await rig(), x = r[hand.on];
  if (ahead != null) {
    const X = gap(x, r.clock, 1, 15);
    while (X - x.ts.posAt(r.clock.t) > ahead) run(r.engine, r.clock, TICK);
  }
  const t0 = r.clock.t, r0 = x.node.segAt(t0).rate, p0 = x.node.posAt(t0);
  await hand.press(r);
  let at = null;
  run(r.engine, r.clock, 1, (t) => { if (at == null && hand.heard(x, x.node.segAt(t), r0, p0, t0, t)) at = t; });
  return at == null ? Infinity : at - t0;
}

for (const [name, hand] of Object.entries(HANDS)) {
  test(`${name}: with a capture gap coming, heard as soon as with none`, async () => {
    const base = await handDelay(hand, null);
    assert.ok(base < 0.4, `heard after ${base} s with no gap`);
    for (const ahead of hand.aheads || [0.5, 0.3, 0.2, 0.12]) {
      const delay = await handDelay(hand, ahead);
      assert.ok(delay <= base + 0.01, `gap ${ahead} s ahead: heard after ${delay.toFixed(3)} s, with no gap ${base.toFixed(3)} s`);
    }
  });
}

test('a nudge tapped just before a gap is heard, and the gap jump never lands under it', async () => {
  for (const ahead of [0.3, 0.2, 0.12]) {
    const { clock, engine, d } = await rig();
    const X = gap(d, clock, 1, 15);
    while (X - d.ts.posAt(clock.t) > ahead) run(engine, clock, TICK);
    const r0 = d.node.segAt(clock.t).rate;
    await d.act('nudge', { dir: 1 });
    let nudged = false;
    const held = watch(engine, clock, d, 0.15, { onTick: (t) => { nudged ||= d.node.segAt(t).rate > r0 * 1.03; } });
    await d.act('nudge', { dir: 0 });
    run(engine, clock, 0.3, (t) => { nudged ||= d.node.segAt(t).rate > r0 * 1.03; });
    assert.ok(nudged, `gap ${ahead} s ahead: the nudge was never played`);
    assert.deepEqual(held.jumps, [], `gap ${ahead} s ahead: jumped under the nudge`);
  }
});

test('a gap jump that the DJ\'s change dropped is planned again: after a beat jump back, where the playhead next reaches the gap', async () => {
  for (const ahead of [0.2, 0.12, 0.06]) {
    const { clock, engine, d } = await rig();
    const X = gap(d, clock, 1, 15);
    while (X - d.ts.posAt(clock.t) > ahead) run(engine, clock, TICK);
    await d.act('beatJump', { beats: -4 });
    const w = watch(engine, clock, d, 4), skips = w.jumps.filter((j) => Math.abs(j.by) < 0.1);
    assert.equal(skips.length, 1, `gap ${ahead} s ahead: ${JSON.stringify(w.jumps)}`);
    assert.ok(Math.abs(skips[0].at - X) < 1e-3 && Math.abs(skips[0].by - 0.015) < 1e-6, `gap ${ahead} s ahead: ${JSON.stringify(skips[0])}`);
    assert.ok(w.bend < 0.002, `bent ${(w.bend * 100).toFixed(2)} %`);
  }
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

// The grid after a gap is the tracker's live clock until a later gap is found, and it moves on after the gap was found:
// it follows the beats at the live edge, seconds past the gap. Its move is no better a step than the one found (over 57
// jumps in six live-sync runs, the step found was a median 0.4 ms off the step in the deck's own capture, the live
// grid's 0.5 ms, and up to 8.4 ms off where it had taken in part of a later gap). The deck jumps the step found; a move
// inside the phase loop's deadband leaves it that far off its grid's beat, and nothing bends.
for (const [who, moved] of [['follower', 3], ['follower', -2.5], ['master', 3]]) {
  test(`the grid after a gap moved ${moved} ms since the gap was found: the ${who} jumps the step found there, and nothing bends`, async () => {
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
    assert.ok(Math.abs(w.jumps[0].by - 0.012) < 2e-4, `jumped ${(w.jumps[0].by * 1000).toFixed(2)} ms, the step found is 12 ms`);
    if (who === 'follower') {
      const off = clockErrMs(engine, d, clock.t);
      assert.ok(Math.abs(Math.abs(off) - Math.abs(moved)) < 1, `${off.toFixed(2)} ms off its grid's beat after the gap, the grid moved ${moved} ms`);
    }
    assert.ok(pair < Math.abs(moved) + 1, `follower and master ${pair.toFixed(1)} ms apart across the gap, by their grids`);
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

// A real tempo change in a live source (a DJ stream moving its pitch) is no capture gap: the tracker used to fit a step
// to the first beats of the new slope, and the deck jumped 12-47 ms where nothing was dropped; a master with BEAT
// followers jumped its own audio. With the deck's real tracker fed from its capture, it goes through the tempo and
// phase paths: no jump.

/** A kick track at 48 kHz going from b0 to b1 BPM at input second 20, at once or over `ramp` s, its beats unbroken. */
function kicks(b0, b1, ramp, seconds = 50, sr = 48000) {
  const x = new Float32Array(seconds * sr);
  let ph = 0, onset = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, f = t < 20 ? 0 : ramp > 0 ? Math.min(1, (t - 20) / ramp) : 1, was = ph;
    ph += (b0 + (b1 - b0) * f) / 60 / sr;
    if (Math.floor(ph) !== Math.floor(was)) onset = t;
    const u = t - onset;
    if (u < 0.2) x[i] = 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-u * 35)) * u) * Math.exp(-u * 18);
  }
  return x;
}

/** Deck x follows its capture `audio` with a real tracker and grid map; the returned function feeds it up to its live edge. */
function tracks(x, audio) {
  const sr = 48000, odf = new OdfCore(sr, (f, l, t) => x.tempo.pushFrame(f, l, t));
  let fed = 0;
  x.tempo = new DeckTempo({ sampleRate: sr, fps: odf.fps });
  x.grids = new GridMap();
  x.ts.liveEdge = 0.05;
  return () => {
    for (const upto = Math.min(audio.length, Math.floor((x.ts.liveEdge * sr) / 128) * 128); fed + 128 <= upto; fed += 128) odf.push(audio.subarray(fed, fed + 128), fed);
    x.followTempo();
  };
}

for (const [who, b0, b1, ramp] of [['follower', 124, 125, 0], ['follower', 120, 118, 2], ['master', 124, 125, 0], ['master', 128, 126.5, 2]]) {
  test(`a real tempo change of ${b0} to ${b1} BPM${ramp ? ` over ${ramp} s` : ''} in a ${who}'s live source: no playhead jump on it or its ${who === 'master' ? 'follower' : 'master'}`, async () => {
    const clock = { t: 100 }, engine = makeEngine(clock);
    engine.params['assist.on'] = false;
    const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
    const d = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 124, t0: 0.11, liveEdge: 600, capSec: 1e7 });
    const x = who === 'master' ? m : d, feed = tracks(x, kicks(b0, b1, ramp));
    run(engine, clock, 9, feed); // the playhead plays from the start of the capture, seconds behind its live edge
    assert.equal(x.tempo.get().state, 'LOCKED');
    await m.act('play');
    engine.clock.follow(1);
    run(engine, clock, 1, feed);
    assert.deepEqual(await d.act('syncPlay'), { ok: true });
    run(engine, clock, 3, feed);
    const other = x === m ? d : m, theirs = other.node.map.length;
    const w = watch(engine, clock, x, 32, { onTick: feed });
    assert.ok(x.ts.posAt(clock.t) > 24 + ramp, `played to input ${x.ts.posAt(clock.t).toFixed(1)} s, past the change`);
    assert.deepEqual(w.jumps.map((j) => `${(j.by * 1000).toFixed(1)} ms at input ${j.at.toFixed(2)} s`), [], `${who} playhead jumps`);
    const gaps = x.grids.segs.filter((s) => s.shift).map((s) => `${(s.shift * 1000).toFixed(1)} ms at ${s.from.toFixed(2)} s`);
    assert.deepEqual(gaps, [], 'capture gaps on its grid');
    const tj = [];
    for (let i = Math.max(1, theirs); i < other.node.map.length; i++) {
      const a = other.node.map[i - 1], b = other.node.map[i], at = a.input + a.rate * (b.output - a.output);
      if (a.active && b.active !== false && Math.abs(b.input - at) > 1e-4) tj.push(b);
    }
    assert.deepEqual(tj, [], 'the other deck\'s playhead jumps');
  });
}

// The newer grid of a gap is the tracker's live clock until a later gap is found, and the live clock follows the beats
// at the live edge, seconds past the gap: through a later gap it has not found yet, which it then partly takes in. Seen
// in the browser (live-sync acceptance): a master 5.6 s behind its live edge jumped -19.5 ms for a gap found -11.5 ms
// (its capture stepped -11.1 ms there), its live clock already 8 ms into the next gap, found 0.2 s after the jump.

/** A 128 BPM click track at 48 kHz (a 3 kHz blip a beat) with `drops` ({ms, at}: ms of audio dropped at track second at). */
function clicks(seconds, drops, sr = 48000) {
  const T = 60 / 128;
  let x = new Float32Array(seconds * sr);
  for (let i = 0; i < x.length; i++) { const u = (i / sr) % T; if (u < 0.04) x[i] = 0.6 * Math.sin(2 * Math.PI * 3000 * u) * Math.exp(-u * 90); }
  for (const { ms, at } of [...drops].sort((a, b) => b.at - a.at)) {
    const i = Math.round(at * sr), n = Math.round((ms / 1000) * sr), y = new Float32Array(x.length - n);
    y.set(x.subarray(0, i)); y.set(x.subarray(i + n), i); x = y;
  }
  return x;
}

test('two capture gaps 2.4 s apart, the second taken in by the live grid but not found yet when the playhead reaches the first: each jump is its own gap\'s step', async () => {
  const clock = { t: 100 }, engine = makeEngine(clock);
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
  const d = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 124, t0: 0.11, liveEdge: 600, capSec: 1e7 });
  const feed = tracks(m, clicks(40, [{ ms: 12, at: 24.15 }, { ms: 18, at: 26.55 }]));
  run(engine, clock, 4, feed); // the playhead 4 s behind its live edge
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2, feed);
  assert.deepEqual(await d.act('syncPlay'), { ok: true });
  run(engine, clock, 3, feed);
  let late = null; // the second gap is found after the jump over the first is planned
  const plan = m.scheduleSkip.bind(m);
  m.scheduleSkip = (now, p) => { plan(now, p); if (late == null && m.skipPlan) late = !m.grids.segs.some((s) => s.shift && s.from > 26); };
  const w = watch(engine, clock, m, 25, { onTick: feed });
  assert.ok(m.ts.posAt(clock.t) > 28, `played to input ${m.ts.posAt(clock.t).toFixed(1)} s, past both gaps`);
  assert.equal(late, true, 'the second gap was found before the playhead reached the first');
  const got = w.jumps.map((j) => `${(j.by * 1000).toFixed(1)} ms at input ${j.at.toFixed(2)} s`);
  assert.equal(w.jumps.length, 2, JSON.stringify(got));
  for (const [j, ms, at] of [[w.jumps[0], -12, 24.15], [w.jumps[1], -18, 26.538]]) {
    assert.ok(Math.abs(j.at - at) < 0.5 && Math.abs(j.by * 1000 - ms) <= 1.5, `jumped ${got.join(', ')}: the gaps are ${ms} ms at ${at} s`);
  }
  let bend = 0;
  for (const s of d.node.map) if (s.active && s.output > clock.t - 25) bend = Math.max(bend, Math.abs(s.rate / ((1 + d.params.pitch) * d.nudgeFactor) - 1));
  assert.ok(bend < 0.002, `the follower bent ${(bend * 100).toFixed(2)} %`);
});
