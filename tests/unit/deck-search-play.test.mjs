// A nudge held on a paused deck searches. PLAY (or SYNC PLAY) while it is still held ends the search: the deck
// starts cleanly at its own tempo, with no bend, and a synced deck's phase lock runs while the button stays down.
// Letting go afterwards changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run, clockErrMs } from './fixtures/deck-harness.mjs';

/** A playing 128 BPM master and a paused 124 BPM deck, SYNCed (BEAT), its nudge held down for 0.3 s (a search). */
async function heldOnPaused() {
  const clock = { t: 100 }, engine = makeEngine(clock);
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
  const d = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 124, t0: 0.13, liveEdge: 600, capSec: 1e7 });
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2);
  assert.deepEqual(await d.act('sync', { on: true }), { ok: true });
  assert.deepEqual(await d.act('nudge', { dir: 1 }), { ok: true });
  assert.ok(d.search, 'paused: the nudge searches');
  run(engine, clock, 0.3);
  return { clock, engine, d };
}

for (const press of ['play', 'syncPlay']) {
  test(`${press === 'play' ? 'PLAY' : 'SYNC PLAY'} while a search is held: the search stops, the deck plays at its own tempo, no bend`, async () => {
    const { clock, engine, d } = await heldOnPaused();
    assert.deepEqual(await d.act(press), { ok: true });
    run(engine, clock, 1);
    assert.equal(d.search, null, 'search over');
    assert.equal(d.nudge, 0, 'the held button no longer nudges');
    assert.equal(d.nudgeFactor, 1);
    const want = (1 + d.params.pitch) / d.src.rateAt(d.ts.posAt(clock.t));
    assert.ok(Math.abs(d.node.segAt(clock.t).rate - want) < 1e-9, `rate ${d.node.segAt(clock.t).rate}, synced rate ${want}`);
    assert.equal(d.state(clock.t).nudge, 0);
  });

  test(`${press === 'play' ? 'PLAY' : 'SYNC PLAY'} while a search is held: phase lock runs while the button stays down, and letting go changes nothing`, async () => {
    const { clock, engine, d } = await heldOnPaused();
    assert.deepEqual(await d.act(press), { ok: true });
    run(engine, clock, 3);
    assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1, `in phase after the start: ${clockErrMs(engine, d, clock.t).toFixed(1)} ms`);
    // Knocked 40 ms out of phase (as a capture skip would), the button still down.
    const T = d.ts.soon(clock.t);
    d.sched(T, { input: d.ts.posAt(T) + 0.04 * d.ts.rateAt(T) });
    run(engine, clock, 0.6);
    assert.ok(d.phaseMs != null && Math.abs(d.phaseMs) > 20, `phase lock measures the error: ${d.phaseMs}`);
    run(engine, clock, 6);
    const err = clockErrMs(engine, d, clock.t);
    assert.ok(Math.abs(err) < 2, `6 s later, the button still down: ${err.toFixed(1)} ms off the master`);
    const n = d.node.log.length, settle = d.settleUntil;
    assert.deepEqual(await d.act('nudge', { dir: 0 }), { ok: true });
    assert.equal(d.node.log.length, n, 'letting go schedules nothing');
    assert.equal(d.settleUntil, settle, 'letting go does not pause phase lock');
    run(engine, clock, 2);
    assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 2, `after letting go: ${clockErrMs(engine, d, clock.t).toFixed(1)} ms`);
  });
}

test('a nudge pressed while playing still bends, and letting go of it ends the bend', async () => {
  const { clock, engine, d } = await heldOnPaused();
  await d.act('nudge', { dir: 0 });
  await d.act('syncPlay');
  run(engine, clock, 2);
  const base = d.node.segAt(clock.t).rate;
  assert.deepEqual(await d.act('nudge', { dir: 1 }), { ok: true });
  run(engine, clock, 0.3);
  assert.ok(Math.abs(d.node.segAt(clock.t).rate / base - 1.04) < 1e-6, `bent to ${d.node.segAt(clock.t).rate / base}`);
  assert.deepEqual(await d.act('nudge', { dir: 0 }), { ok: true });
  run(engine, clock, 0.3);
  assert.ok(Math.abs(d.node.segAt(clock.t).rate / base - 1) < 1e-6, `after letting go: ${d.node.segAt(clock.t).rate / base}`);
});
