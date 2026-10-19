// LIVE on a beat-synced playing deck jumps whole beats of its input. When player assist ran the page faster or
// slower for part of the audio between the playhead and the live edge, those beats are closer together (or further
// apart) in input seconds than at the playhead: the jump counts them on the grid where it lands, so it still lands
// on a beat, and the deck stays in phase with the master.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_RESERVE } from '../../engine/timeshift.js';
import { makeEngine, makeDeck, run, clockErrMs } from './fixtures/deck-harness.mjs';

const frac = (x) => x - Math.floor(x);

/**
 * The page ran at `rate` from input x on (an assist step the page confirmed): the source model says so, and the
 * grid there plays the same beats faster, its phase continuous at x (as the audio is).
 */
function step(d, x, rate) {
  const g = d.grids.at(x), T = (g.T * d.src.rateAt(x)) / rate;
  d.src.set(x, rate);
  d.grids.split(x, { t0: x - frac((x - g.t0) / g.T) * T, T, bar1: null });
}

/** A playing 128 BPM master and a 124 BPM live deck SYNC PLAYed to it and settled; then the steps [{at, rate}]. */
async function rig(steps, span) {
  const clock = { t: 100 }, engine = makeEngine(clock);
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
  const d = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 124, t0: 0.11, liveEdge: 20, capSec: 1e7 });
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 2);
  assert.deepEqual(await d.act('syncPlay'), { ok: true });
  run(engine, clock, 10);
  for (const s of steps) step(d, s.at, s.rate);
  const last = steps[steps.length - 1];
  d.ts.liveEdge = last.at + span * last.rate + 0.37; // span s of the page since the last step
  return { clock, engine, d };
}

const ramp = (from, to, n, at, every) => Array.from({ length: n }, (_, i) => ({ at: at + i * every, rate: from + ((to - from) * (i + 1)) / n }));
const CASES = [
  { name: 'one step to 1.03×', steps: [{ at: 25, rate: 1.03 }], span: 20 },
  { name: 'one step to 1.05×', steps: [{ at: 25.2, rate: 1.05 }], span: 20 },
  { name: 'one step down to 0.97×', steps: [{ at: 25.1, rate: 0.97 }], span: 12 },
  { name: 'a ramp up to 1.03× in 0.25 % steps', steps: ramp(1, 1.03, 12, 25, 0.8), span: 8 },
  { name: 'a ramp up to 1.04×, then back down to 1×', steps: [...ramp(1, 1.04, 16, 25, 0.5), ...ramp(1.04, 1, 16, 33.3, 0.5)], span: 6 },
];

for (const c of CASES) {
  test(`LIVE on a beat-synced deck across ${c.name}: lands on its beat, in phase with the master`, async () => {
    const { clock, engine, d } = await rig(c.steps, c.span);
    assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1, `locked before LIVE: ${clockErrMs(engine, d, clock.t).toFixed(1)} ms`);
    const edge = d.ts.liveEdge - d.ts.lat;
    assert.deepEqual(await d.act('live'), { ok: true });
    const to = d.node.log.at(-1).input, g = d.grids.at(to);
    assert.ok(edge - to >= LIVE_RESERVE - 1e-9 && edge - to < LIVE_RESERVE + g.T, `jumps to a reserve of ${(edge - to).toFixed(3)} s`);
    run(engine, clock, 0.4); // the jump has landed; the phase loop has looked once
    const err = clockErrMs(engine, d, clock.t);
    assert.ok(Math.abs(err) < 1, `${err.toFixed(1)} ms off the master after LIVE`);
    run(engine, clock, 3);
    assert.ok(Math.abs(clockErrMs(engine, d, clock.t)) < 1 && !d.starved, `3 s later ${clockErrMs(engine, d, clock.t).toFixed(1)} ms, starved ${d.starved}`);
  });
}
