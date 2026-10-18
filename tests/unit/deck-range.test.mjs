// A pitch-range change must never move the tempo a deck is playing at: narrowing it below the
// current pitch is refused and said out loud, instead of clamping the pitch silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run } from './fixtures/deck-harness.mjs';

const nodeRate = (n, t) => { const s = n.segAt(t); return s.active ? s.rate : 0; };

function setup() {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  const d = makeDeck(engine, clock, { liveEdge: 400, bpm: 124 });
  d.setCue(2);
  return { clock, engine, d, go: (s) => run(engine, clock, s) };
}

async function playingAt(pitch) {
  const s = setup();
  s.d.setParam('range', 0.5);
  await s.d.act('play');
  s.go(1);
  s.d.setParam('pitch', pitch);
  s.go(0.5);
  assert.equal(nodeRate(s.d.node, s.clock.t), 1 + pitch, 'deck is on air at the asked tempo');
  return s;
}

test('narrowing the range below the deck’s tempo is refused, and the DJ is told', async () => {
  const { d, clock, engine, go } = await playingAt(0.3);
  const before = engine.events.length;
  d.setParam('range', 0.06);
  go(0.5);
  assert.equal(d.params.range, 0.5, 'the range change was refused');
  assert.equal(d.params.pitch, 0.3, 'the tempo is untouched');
  assert.equal(nodeRate(d.node, clock.t), 1.3, `the deck still plays at +30% (${nodeRate(d.node, clock.t)})`);
  const said = engine.events.slice(before);
  assert.equal(said.length, 1, `exactly one warning: ${JSON.stringify(said)}`);
  assert.equal(said[0].level, 'warn');
});

test('a range that can hold the tempo still changes it, and widening always works', async () => {
  const { d, engine, go } = await playingAt(0.05);
  const before = engine.events.length;
  d.setParam('range', 0.06);
  go(0.3);
  assert.equal(d.params.range, 0.06);
  assert.equal(d.params.pitch, 0.05, 'the tempo is kept');
  d.setParam('range', 0.5);
  go(0.3);
  assert.equal(d.params.range, 0.5, 'widening is never refused');
  assert.equal(d.params.pitch, 0.05);
  assert.deepEqual(engine.events.slice(before), [], 'nothing to warn about');
});

test('a range exactly holding the pitch is allowed (no float-noise refusal)', async () => {
  const { d } = await playingAt(0.16);
  d.setParam('range', 0.16);
  assert.equal(d.params.range, 0.16);
  assert.equal(d.params.pitch, 0.16);
});
