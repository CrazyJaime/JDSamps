// When the deck page goes away mid-press (reload, close), the engine ends what only lasts while
// a control is held: rolls, nudges and CUE previews. Everything else stays as it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run } from './fixtures/deck-harness.mjs';

const near = (a, b, eps) => Math.abs(a - b) <= eps;

function setup() {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  const d = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 124, liveEdge: 30 });
  d.setCue(2);
  const go = (s) => run(engine, clock, s);
  go(0.2);
  return { clock, engine, d, go };
}

test('a held roll and nudge end, and the deck plays on at 1x from where it would have been', async () => {
  const { clock, d, go } = setup();
  await d.act('play');
  go(1);
  await d.act('rollStart', { beats: 1 });
  await d.act('nudge', { dir: 1 });
  go(1.2);
  assert.equal(d.roll, 1); assert.equal(d.nudge, 1);
  await d.releaseHolds();
  go(0.5);
  const s = d.state(clock.t);
  assert.equal(s.roll, null); assert.equal(s.loop, null); assert.equal(s.nudge, 0);
  assert.equal(s.playing, true, 'still playing');
  const seg = d.node.segAt(clock.t);
  assert.equal(seg.active, true);
  assert.equal(seg.loopStart, 0); assert.equal(seg.loopEnd, 0);
  assert.ok(near(seg.rate, 1, 1e-9), `rate ${seg.rate}`);
});

test('a CUE preview ends back at the cue, paused', async () => {
  const { clock, d, go } = setup();
  await d.act('cueDown');
  assert.equal(d.previewing, true);
  go(1);
  await d.releaseHolds();
  go(0.5);
  const s = d.state(clock.t);
  assert.equal(s.previewing, false); assert.equal(s.playing, false);
  assert.equal(d.node.segAt(clock.t).active, false);
  assert.ok(near(s.playhead, d.cue, 1e-9), `playhead ${s.playhead} back at cue ${d.cue}`);
});

test('nothing held: a playing deck and its latched kill and FX are left alone', async () => {
  const { clock, d, go } = setup();
  await d.act('play');
  d.params['kill.low'] = true; d.params['fx.on'] = true; // latched by a tap
  go(1);
  const n = d.node.log.length;
  await d.releaseHolds();
  go(0.5);
  assert.equal(d.node.log.length, n, 'no change scheduled');
  assert.equal(d.state(clock.t).playing, true);
  assert.equal(d.params['kill.low'], true); assert.equal(d.params['fx.on'], true);
});
