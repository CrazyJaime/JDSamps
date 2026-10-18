// ½× / 2×, GRID ◀ ▶ and TAP 1 must report what actually happened: a refusal reaches the UI as a
// toast instead of a dead button answering {ok: true}. (grid.test.mjs covers what they do when
// they succeed, against the real tracker.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { GridMap } from '../../engine/timeshift.js';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';

/** The harness's fake tracker refuses every multiply(), like DeckTempo at its ×4 limit. */
function mk() {
  const clock = { t: 10 };
  const engine = makeEngine(clock);
  const d = makeDeck(engine, clock, { liveEdge: 40 });
  d.tempo.track = { n: 0 };
  return { clock, engine, d };
}

test('before the first input frame the grid tools answer “Waiting for audio.”, as TAP does', async () => {
  const { d } = mk();
  d.tempo = null;
  for (const [a, arg] of [['mult', { factor: 2 }], ['gridShift', { beats: 0.5, ms: 0 }], ['tap1', {}]]) {
    assert.deepEqual(await d.act(a, arg), { ok: false, error: 'Waiting for audio.' }, `${a} with no tracker`);
  }
});

test('a ½× / 2× the tracker refuses is reported, not answered ok', async () => {
  const { d, engine } = mk();
  const before = d.grids.at(d.heardPos()).T;
  const r = await d.act('mult', { factor: 2 });
  assert.equal(r.ok, false, `the refused 2× answered ${JSON.stringify(r)}`);
  assert.match(r.error, /\S/, 'with a reason');
  assert.equal(d.grids.at(d.heardPos()).T, before, 'and the grid really did not move');
  assert.deepEqual(engine.events, [], 'the reason goes to the caller, not to a broadcast event');
});

test('GRID ◀ ▶ and TAP 1 with no beat grid yet say so instead of answering ok', async () => {
  const { d } = mk();
  d.grids = new GridMap();
  for (const [a, arg] of [['gridShift', { beats: 0.5, ms: 0 }], ['tap1', {}]]) {
    const r = await d.act(a, arg);
    assert.equal(r.ok, false, `${a} with no grid answered ${JSON.stringify(r)}`);
    assert.match(r.error, /\S/, `${a} gives a reason`);
  }
});

test('a grid tool that does its job still answers ok', async () => {
  const { d } = mk();
  assert.deepEqual(await d.act('gridShift', { beats: 0.5, ms: 0 }), { ok: true });
  assert.deepEqual(await d.act('tap1'), { ok: true });
});
