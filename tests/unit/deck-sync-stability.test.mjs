// Sync stability: the master clock must publish one tempo, the half/double multiplier must not
// flip under the DJ's hand, and SYNC PLAY must do what the SYNC button does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GridMap } from '../../engine/timeshift.js';
import { chooseMultiplier, syncRatio } from '../../engine/sync.js';
import { makeEngine, makeDeck, run, playedBpm, pairErrMs, clockErrMs } from './fixtures/deck-harness.mjs';

const DECK = { liveEdge: 600, capSec: 1e7 };

function rig() {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  engine.params['assist.on'] = false;
  return { clock, engine };
}

/** A playing master on deck 1 plus `slaves` SYNCed and SYNC PLAYed decks, settled. */
async function mix({ masterBpm = 128, masterRange = 0.1, slaves = [], settle = 20 } = {}) {
  const { clock, engine } = rig();
  const m = makeDeck(engine, clock, { ...DECK, id: 1, slot: 1, bpm: masterBpm, range: masterRange });
  const ss = slaves.map((o, i) => makeDeck(engine, clock, { ...DECK, id: i + 2, slot: i + 2, t0: 0.11 * (i + 1), ...o }));
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2);
  for (const s of ss) {
    assert.deepEqual(await s.act('sync', { on: true }), { ok: true }, `deck ${s.id} SYNC`);
    assert.deepEqual(await s.act('syncPlay'), { ok: true }, `deck ${s.id} SYNC PLAY`);
  }
  run(engine, clock, settle);
  return { clock, engine, m, ss };
}

// ---------------------------------------------------------------- SYNC-1 (multiplier hysteresis)

test('SYNC-1 chooseMultiplier holds the multiplier it was given across the half/double boundary', () => {
  // 175 / sqrt(2) = 123.744: the argmin flips between these two master tempos.
  assert.notEqual(chooseMultiplier(123.80, 175), chooseMultiplier(123.70, 175), 'the stateless choice still flips (unchanged)');
  for (const m of [123.80, 123.70, 121, 127]) {
    assert.equal(chooseMultiplier(m, 175, 1), 1, `master ${m} must keep the multiplier already in use`);
    assert.equal(chooseMultiplier(m, 175, 2), 2, `master ${m} must keep the multiplier already in use`);
  }
  // It still leaves a multiplier that is clearly wrong (here 2x beats 1x by far more than the margin).
  assert.equal(chooseMultiplier(100, 175, 1), 2, 'well past the margin, it folds to the nearer octave');
  assert.equal(chooseMultiplier(250, 124, 2), 0.5);
  // An unknown/absent current multiplier falls back to the stateless choice.
  assert.equal(chooseMultiplier(128, 64, null), 0.5);
  assert.equal(syncRatio(128, 64, 0.5, 0.5).mult, 0.5);
  assert.equal(syncRatio(123.70, 175, 0.5, 1).mult, 1, 'syncRatio passes the current multiplier through');
});

test('SYNC-1 a 0.3 % master pitch move must not double a synced deck', async () => {
  const { clock, engine, m, ss } = await mix({ masterBpm: 124, slaves: [{ bpm: 175, range: 0.5 }] });
  const [s] = ss;
  const before = playedBpm(s, clock.t);
  assert.ok(Math.abs(before - 124) < 0.5, `locked at ${before}`);
  m.setParam('pitch', -0.003); // the master's pitch fader eased down 0.3 %: 124 -> 123.63 BPM
  run(engine, clock, 3);
  const after = playedBpm(s, clock.t);
  assert.ok(Math.abs(after / before - 1) < 0.05,
    `a 0.3 % master pitch move changed the slave from ${before.toFixed(2)} to ${after.toFixed(2)} BPM (x${(after / before).toFixed(2)})`);
});

test('SYNC-1 a master tempo sweep across the boundary never flips a playing slave an octave', async () => {
  const { clock, engine, m, ss } = await mix({ masterBpm: 124, masterRange: 0.5, slaves: [{ bpm: 175, range: 0.5 }] });
  const [s] = ss;
  let prev = playedBpm(s, clock.t), worstStep = 0;
  for (let i = 1; i <= 12; i++) { // 124 -> 117.8 BPM, straight through 123.744
    m.setParam('pitch', -0.004 * i);
    run(engine, clock, 1);
    const now = playedBpm(s, clock.t);
    worstStep = Math.max(worstStep, Math.abs(now / prev - 1));
    prev = now;
  }
  assert.ok(worstStep < 0.05, `the slave's rendered tempo jumped by x${(1 + worstStep).toFixed(2)} during the sweep`);
  assert.ok(Math.abs(prev - 124 * 0.952) < 1, `slave ends at ${prev.toFixed(2)} BPM, master at ${(124 * 0.952).toFixed(2)}`);
});

// ---------------------------------------------------------------- SYNC-2 (nudge the master)

test('SYNC-2 the master clock publishes one tempo: bpm and period agree through a nudge', async () => {
  const { clock, engine, m } = await mix({ slaves: [{ bpm: 124 }] });
  const agree = () => Math.abs(engine.clock.bpm - 60 / engine.clock.period);
  assert.ok(agree() < 0.01, 'bpm and period agree before the nudge');
  await m.act('nudge', { dir: 1 });
  run(engine, clock, 1);
  assert.ok(agree() < 0.01,
    `the master clock publishes bpm ${engine.clock.bpm.toFixed(2)} but a period of ${(60 / engine.clock.period).toFixed(2)} BPM`);
  assert.ok(Math.abs(engine.clock.bpm - 128 * 1.04) < 0.2, `the clock must report the nudged tempo, got ${engine.clock.bpm.toFixed(2)}`);
  await m.act('nudge', { dir: 0 });
  run(engine, clock, 1);
  assert.ok(agree() < 0.01, 'bpm and period agree after the nudge');
  assert.ok(Math.abs(engine.clock.bpm - 128) < 0.2, `the clock returns to 128, got ${engine.clock.bpm.toFixed(2)}`);
});

test('SYNC-2 holding NUDGE on the master keeps its slaves in phase', async () => {
  const { clock, engine, m, ss } = await mix({ slaves: [{ bpm: 124, keyLock: false }] });
  const [s] = ss;
  assert.ok(Math.abs(clockErrMs(engine, s, clock.t)) < 5, 'locked before the nudge');
  await m.act('nudge', { dir: 1 }); // the DJ holds NUDGE + against a vocal
  let worst = 0;
  for (let i = 0; i < 20; i++) { run(engine, clock, 1); worst = Math.max(worst, Math.abs(clockErrMs(engine, s, clock.t))); }
  assert.ok(worst < 30, `holding NUDGE on the master for 20 s pushed the slave ${worst.toFixed(0)} ms out of phase`);
  await m.act('nudge', { dir: 0 });
  run(engine, clock, 10);
  assert.ok(Math.abs(clockErrMs(engine, s, clock.t)) < 5, `${clockErrMs(engine, s, clock.t).toFixed(1)} ms after the nudge was let go`);
});

// ---------------------------------------------------------------- SYNC-3 (master re-entry)

test('SYNC-3 SYNC PLAY on the master drops it back in on the free clock it left running', async () => {
  const { clock, engine, m, ss } = await mix({ slaves: [{ bpm: 124 }, { bpm: 130 }] });
  assert.ok(Math.abs(pairErrMs(ss[0], ss[1], clock.t)) < 5, 'the two slaves are locked');
  await m.act('pause');
  run(engine, clock, 7.3); // out for a non-integral number of beats
  assert.equal(engine.clock.state().mode, 'free');
  const slavesBefore = [clockErrMs(engine, ss[0], clock.t), clockErrMs(engine, ss[1], clock.t)];
  await m.act('syncPlay');
  run(engine, clock, 0.4);
  const e = pairErrMs(m, ss[0], clock.t);
  assert.ok(Math.abs(e) < 10, `SYNC PLAY on the master dropped it in ${e.toFixed(0)} ms off the decks already playing`);
  run(engine, clock, 2);
  for (const [i, s] of ss.entries()) {
    assert.ok(Math.abs(clockErrMs(engine, s, clock.t) - slavesBefore[i]) < 10,
      `slave ${i} was dragged ${(clockErrMs(engine, s, clock.t) - slavesBefore[i]).toFixed(0)} ms by the master's re-entry`);
  }
});

// ---------------------------------------------------------------- SYNC-4 (no master yet)

test('SYNC-4 SYNC PLAY with no master picks one, engages SYNC and matches tempo', async () => {
  const { clock, engine } = rig();
  const a = makeDeck(engine, clock, { ...DECK, id: 1, slot: 1, bpm: 128 });
  const b = makeDeck(engine, clock, { ...DECK, id: 2, slot: 2, bpm: 124, t0: 0.11 });
  await a.act('play');
  run(engine, clock, 2);
  assert.equal(engine.clock.state().mode, 'none');
  assert.deepEqual(await b.act('syncPlay'), { ok: true });
  run(engine, clock, 10);
  assert.equal(engine.clock.assigned, 1, 'SYNC PLAY with no master picked no master');
  assert.equal(b.syncOn, true, 'SYNC PLAY left SYNC off');
  assert.ok(Math.abs(playedBpm(b, clock.t) - 128) < 0.5,
    `SYNC PLAY started deck 2 at ${playedBpm(b, clock.t).toFixed(2)} BPM against a 128 BPM deck`);
  assert.ok(Math.abs(pairErrMs(a, b, clock.t)) < 10, `${pairErrMs(a, b, clock.t).toFixed(1)} ms apart`);
});

test('SYNC-4 SYNC PLAY on the only deck still plays, and takes the tempo master', async () => {
  const { clock, engine } = rig();
  const a = makeDeck(engine, clock, { ...DECK, id: 1, slot: 1, bpm: 128 });
  assert.deepEqual(await a.act('syncPlay'), { ok: true });
  run(engine, clock, 2);
  assert.equal(a.wantPlay, true);
  assert.equal(engine.clock.assigned, 1);
  assert.match(engine.events.at(-1).text, /tempo master/);
});

test('SYNC-4 SYNC PLAY says why it cannot sync instead of starting unsynced', async () => {
  const { clock, engine } = rig();
  const a = makeDeck(engine, clock, { ...DECK, id: 1, slot: 1, bpm: 128 });
  const b = makeDeck(engine, clock, { ...DECK, id: 2, slot: 2, bpm: 124, canBeat: false });
  await a.act('play');
  run(engine, clock, 2);
  const r = await b.act('syncPlay');
  assert.equal(r.ok, false);
  assert.match(r.error, /Beat grid not confident/);
  assert.equal(b.wantPlay, false, 'a refused SYNC PLAY does not start the deck unsynced');
});

// ---------------------------------------------------------------- SYNC-5 (TEMPO mode)

test('SYNC-5 SYNC PLAY in TEMPO mode matches tempo, as the SYNC button does', async () => {
  const { clock, engine } = rig();
  const m = makeDeck(engine, clock, { ...DECK, id: 1, slot: 1, bpm: 128 });
  const s = makeDeck(engine, clock, { ...DECK, id: 2, slot: 2, bpm: 124, syncMode: 'TEMPO', canBeat: false });
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2);
  assert.deepEqual(await s.act('syncPlay'), { ok: true });
  run(engine, clock, 3);
  assert.equal(s.syncOn, true, 'SYNC PLAY left a TEMPO-mode deck unsynced');
  assert.ok(Math.abs(playedBpm(s, clock.t) - 128) < 0.5, `plays ${playedBpm(s, clock.t).toFixed(2)} BPM against a 128 BPM master`);
  assert.equal(s.phaseMs, null, 'TEMPO mode still does not phase-lock');
});

// ---------------------------------------------------------------- SYNC-6 (hand-assigned master)

test('SYNC-6 pressing SYNC does not steal a master the DJ assigned by hand', async () => {
  const { clock, engine } = rig();
  const a = makeDeck(engine, clock, { ...DECK, id: 1, slot: 1, bpm: 128, range: 0.5 });
  const b = makeDeck(engine, clock, { ...DECK, id: 2, slot: 2, bpm: 124 });
  const c = makeDeck(engine, clock, { ...DECK, id: 3, slot: 3, bpm: 100 });
  await b.act('play');
  run(engine, clock, 2);
  await c.act('master'); // cued, but the DJ has chosen it as the anchor for the next section
  run(engine, clock, 1);
  assert.equal(engine.clock.assigned, 3);
  assert.deepEqual(await a.act('sync', { on: true }), { ok: true });
  assert.equal(engine.clock.assigned, 3, 'SYNC on deck 1 moved the master off the deck the DJ chose');
  // And once deck 3 drops, deck 1 matches it rather than the deck it never chose.
  await c.act('play');
  run(engine, clock, 5);
  assert.ok(Math.abs(a.tempoInfo().out - 100) < 0.5, `deck 1 matched ${a.tempoInfo().out}, master deck 3 is 100`);
});

test('SYNC-6 with no master at all, SYNC still auto-picks one', async () => {
  const { clock, engine } = rig();
  const a = makeDeck(engine, clock, { ...DECK, id: 1, slot: 1, bpm: 128 });
  const b = makeDeck(engine, clock, { ...DECK, id: 2, slot: 2, bpm: 124 });
  await b.act('play');
  run(engine, clock, 2);
  assert.deepEqual(await a.act('sync', { on: true }), { ok: true });
  assert.equal(engine.clock.assigned, 2);
});

// ---------------------------------------------------------------- SYNC-7 (gridless master)

test('SYNC-7 a master with no grid at its playhead does not re-anchor the clock every tick', async () => {
  const { clock, engine } = rig();
  const m = makeDeck(engine, clock, { ...DECK, id: 1, slot: 1, bpm: 128 });
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2);
  const period = engine.clock.period, anchor = engine.clock.anchor;
  m.grids = new GridMap(); // the grid map has no segment covering the playhead
  run(engine, clock, 0.5);
  const drift = (engine.clock.anchor - anchor) % period;
  assert.ok(Math.min(drift, period - drift) < 1e-6,
    `the master's last beat moved ${(engine.clock.anchor - anchor).toFixed(4)} s off the beat grid in 0.5 s of output`);
  assert.equal(engine.clock.state().mode, 'free', 'a master with no phase to publish leaves the clock free-running');
});

// ---------------------------------------------------------------- the whole mix, over minutes

test('three decks hold phase for minutes through a master nudge and a tempo sweep across the boundary', async () => {
  const { clock, engine, m, ss } = await mix({
    masterBpm: 124, masterRange: 0.5, settle: 10,
    slaves: [{ bpm: 175, range: 0.5 }, { bpm: 92, range: 0.5, keyLock: false }],
  });
  const octave = ss.map((s) => playedBpm(s, clock.t) / s.tempo.bpm);
  let worst = 0;
  const watch = (sec) => {
    const steps = Math.round(sec);
    for (let i = 0; i < steps; i++) {
      run(engine, clock, 1);
      for (const s of ss) worst = Math.max(worst, Math.abs(clockErrMs(engine, s, clock.t)));
    }
  };
  watch(30);
  assert.ok(worst < 10, `settled mix wandered ${worst.toFixed(1)} ms`);
  // The DJ holds NUDGE + on the master for 8 s, then lets go.
  await m.act('nudge', { dir: 1 });
  watch(8);
  await m.act('nudge', { dir: 0 });
  watch(12);
  // Then eases the master's pitch fader down through 123.744 BPM, where 175 flips octave.
  for (let i = 1; i <= 10; i++) { m.setParam('pitch', -0.005 * i); watch(6); }
  watch(60);
  assert.ok(worst < 40, `phase error reached ${worst.toFixed(1)} ms over the run`);
  assert.ok(Math.abs(clockErrMs(engine, ss[0], clock.t)) < 5 && Math.abs(clockErrMs(engine, ss[1], clock.t)) < 5,
    `the mix ends ${ss.map((s) => clockErrMs(engine, s, clock.t).toFixed(1)).join(' / ')} ms out`);
  for (const [i, s] of ss.entries()) {
    assert.ok(Math.abs(playedBpm(s, clock.t) / s.tempo.bpm / octave[i] - 1) < 0.1,
      `deck ${s.id} changed octave during the run (rate ${(playedBpm(s, clock.t) / s.tempo.bpm).toFixed(3)} vs ${octave[i].toFixed(3)})`);
  }
});

// ------------------------------------------------- what already worked, and must keep working

test('half and double pairs still pick the right octave and lock', async () => {
  for (const [bpm, mult] of [[64, 0.5], [256, 2], [170, 1]]) {
    const { clock, engine, ss } = await mix({ masterBpm: 128, slaves: [{ bpm, range: 0.5 }], settle: 15 });
    const [s] = ss;
    assert.equal(s.syncMult, mult, `native ${bpm}`);
    assert.ok(Math.abs(playedBpm(s, clock.t) - 128 * mult) < 0.5, `native ${bpm} plays ${playedBpm(s, clock.t).toFixed(2)}`);
    assert.ok(Math.abs(clockErrMs(engine, s, clock.t)) < 1, `native ${bpm} is ${clockErrMs(engine, s, clock.t).toFixed(2)} ms out`);
  }
});

test('six decks synced to one master all lock and stay locked', async () => {
  const { clock, engine, ss } = await mix({
    masterBpm: 128, settle: 30,
    slaves: [124, 170, 92, 140, 100].map((bpm) => ({ bpm, range: 0.5 })),
  });
  for (const s of ss) assert.ok(Math.abs(clockErrMs(engine, s, clock.t)) < 1, `deck ${s.id} ${clockErrMs(engine, s, clock.t).toFixed(2)} ms`);
  run(engine, clock, 120);
  for (const s of ss) assert.ok(Math.abs(clockErrMs(engine, s, clock.t)) < 1, `deck ${s.id} after 120 s: ${clockErrMs(engine, s, clock.t).toFixed(2)} ms`);
  assert.deepEqual(engine.events.filter((e) => e.level === 'warn'), []);
});

test('ejecting the master leaves the clock free and its slaves undisturbed, and nobody steals it', async () => {
  const { clock, engine, m, ss } = await mix({ slaves: [{ bpm: 124 }, { bpm: 130 }] });
  const pitch = ss.map((s) => s.params.pitch);
  await m.act('eject');
  run(engine, clock, 20);
  assert.equal(engine.clock.assigned, null);
  assert.equal(engine.clock.state().mode, 'free');
  for (const [i, s] of ss.entries()) {
    assert.equal(s.params.pitch, pitch[i], `deck ${s.id} tempo moved after the eject`);
    assert.ok(Math.abs(clockErrMs(engine, s, clock.t)) < 1, `deck ${s.id} ${clockErrMs(engine, s, clock.t).toFixed(2)} ms off the free clock`);
  }
  assert.ok(Math.abs(pairErrMs(ss[0], ss[1], clock.t)) < 1);
  // A deck pressing SYNC now follows the free clock instead of making itself master.
  const late = makeDeck(engine, clock, { ...DECK, id: 9, slot: 4, bpm: 140, range: 0.5, t0: 0.37 });
  assert.deepEqual(await late.act('sync', { on: true }), { ok: true });
  assert.equal(engine.clock.assigned, null, 'a deck must not steal mastership from a running free clock');
  assert.deepEqual(await late.act('syncPlay'), { ok: true });
  run(engine, clock, 20);
  assert.ok(Math.abs(clockErrMs(engine, late, clock.t)) < 1, `the late deck is ${clockErrMs(engine, late, clock.t).toFixed(2)} ms out`);
});
