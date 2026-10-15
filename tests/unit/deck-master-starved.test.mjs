// A starved master (reserve empty, clamped to 1x) must publish one tempo: the BPM it reports
// and the beat period slaves phase-lock to describe the same, actually heard, beat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GridMap } from '../../engine/timeshift.js';
import { makeEngine, makeDeck, run } from './fixtures/deck-harness.mjs';

const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** Deck 1: 124 BPM at +5% on a Web-Audio page (no assist) with no reserve; deck 2: 128 BPM, BEAT-synced to it. */
async function setup() {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  engine.updateClock = (now) => {
    const a = engine.clock.assigned != null ? engine.decks.get(engine.clock.assigned) : null;
    engine.clock.update(now, a ? a.masterInfo(now) : null);
  };
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 124, pitch: 0.05, liveEdge: 1 });
  const s = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 128, liveEdge: 30 });
  m.setCue(0.3); s.setCue(2);
  const go = (sec, fn) => run(engine, clock, sec, (t) => { engine.updateClock(t); if (fn) fn(t); });
  go(0.2);
  engine.clock.follow(m.id);
  m.ts.liveEdge = m.cue + m.ts.lat + 0.45; // reserve just under GUARD
  await m.act('play');
  go(3);
  assert.equal(m.starved, true, 'master starved while playing +5% with no reserve');
  assert.deepEqual(await s.act('sync', { on: true }), { ok: true });
  await s.act('play');
  return { clock, engine, m, s, go };
}

test('a starved master reports the BPM of the beat period it publishes', async () => {
  const { clock, m, go } = await setup();
  go(1);
  const info = m.masterInfo(clock.t);
  assert.ok(near(info.period, 60 / 124, 1e-6), `published period ${info.period} is the 1x beat`);
  assert.ok(near(info.bpm, 60 / info.period, 1e-6), `bpm ${info.bpm} vs 60/period ${60 / info.period}`);
});

test('a starved master with no beat grid yet reports the tempo it plays', async () => {
  const { clock, m, go } = await setup();
  m.grids = new GridMap(); // tempo from the tracker only
  go(0.5);
  const info = m.masterInfo(clock.t);
  assert.ok(near(info.bpm, 124, 1e-6), `bpm ${info.bpm}`);
  assert.ok(near(info.period, 60 / 124, 1e-6), `period ${info.period}`);
});

test('a slave of a starved master matches its heard tempo and stops bending', async () => {
  const { engine, m, s, go } = await setup();
  go(6); // settle
  const bends = [];
  const before = s.ts.bend.bind(s.ts);
  s.ts.bend = (...a) => { bends.push(a[2]); return before(...a); };
  const phase = [];
  go(8, () => { if (s.phaseMs != null) phase.push(Math.abs(s.phaseMs)); });
  assert.equal(m.starved, true, 'master still starved');
  assert.ok(near(s.tempoInfo().out, 124, 0.05), `slave plays ${s.tempoInfo().out} BPM, master is heard at 124`);
  assert.ok(near(engine.clock.state().bpm, 124, 0.05), `clock ${engine.clock.state().bpm}`);
  assert.ok(bends.length <= 1, `slave kept bending: ${bends.length} bends in 8 s`);
  assert.ok(Math.max(...phase) < 10, `phase error up to ${Math.max(...phase).toFixed(1)} ms`);
});

test('once the master refills, the clock returns to its set tempo', async () => {
  const { engine, m, go } = await setup();
  go(1);
  m.ts.liveEdge += 10; // the reserve refills (e.g. assist kicked in)
  go(1);
  assert.equal(m.starved, false);
  assert.ok(near(engine.clock.state().bpm, 124 * 1.05, 1e-6), `clock ${engine.clock.state().bpm}`);
});
