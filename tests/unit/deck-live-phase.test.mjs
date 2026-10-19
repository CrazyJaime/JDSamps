// LIVE on a playing deck jumps to its live edge in whole beats, so a beat-synced deck keeps its phase: there is
// nothing for the phase loop to bend out of the small reserve LIVE leaves (a +4 % bend of up to 3 s drained it into
// the starvation guard, and the deck sat 30-60 ms off the beat until it refilled).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_RESERVE } from '../../engine/timeshift.js';
import { makeEngine, makeDeck, run, clockErrMs } from './fixtures/deck-harness.mjs';

const T = 60 / 124;

/** A playing 128 BPM master and a 124 BPM deck SYNC PLAYed to it, settled; the deck's live edge `edge` s ahead. */
async function rig(edge) {
  const clock = { t: 100 }, engine = makeEngine(clock);
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
  const d = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 124, t0: 0.11, liveEdge: edge, capSec: 1e7 });
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2);
  assert.deepEqual(await d.act('syncPlay'), { ok: true });
  run(engine, clock, 10);
  return { clock, engine, d };
}

test('LIVE on a beat-synced playing deck lands on its beat, at least the LIVE reserve behind the edge and less than a beat more', async () => {
  for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) { // where in the beat the live edge falls
    const { clock, engine, d } = await rig(40 + frac * T);
    assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1, 'locked before LIVE');
    const edge = d.ts.liveEdge - d.ts.lat;
    assert.deepEqual(await d.act('live'), { ok: true });
    const res = edge - d.node.log.at(-1).input; // the reserve it jumps to
    assert.ok(res >= LIVE_RESERVE - 1e-9 && res < LIVE_RESERVE + T, `edge at ${frac} of a beat: jumps to a reserve of ${res.toFixed(3)} s`);
    run(engine, clock, 0.4); // the jump has landed; the phase loop has looked once
    const err = clockErrMs(engine, d, clock.t);
    assert.ok(Math.abs(err) < 1, `edge at ${frac} of a beat: ${err.toFixed(1)} ms off the master after LIVE`);
    run(engine, clock, 3);
    assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1 && !d.starved, `edge at ${frac} of a beat: 3 s later ${clockErrMs(engine, d, clock.t).toFixed(1)} ms, starved ${d.starved}`);
  }
});

test('LIVE on a paused deck, or on a deck with no beat grid, goes to the LIVE reserve exactly, as before', async () => {
  const clock = { t: 100 }, engine = makeEngine(clock);
  const p = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 124, liveEdge: 40.2 });
  const n = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 124, liveEdge: 40.2, canBeat: false });
  await n.act('play');
  run(engine, clock, 1);
  for (const [name, d] of [['paused', p], ['no grid', n]]) {
    const want = d.ts.liveEdge - d.ts.lat - LIVE_RESERVE;
    await d.act('live');
    assert.ok(Math.abs(d.node.log.at(-1).input - want) < 1e-9, `${name}: to ${d.node.log.at(-1).input}, not ${want}`);
  }
});
