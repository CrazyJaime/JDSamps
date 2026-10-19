// PLAY on a BEAT-synced deck starts in phase with the master, even when the phase it needs lies
// before the first playable input (a resident deck cued on its first beat, near the track's start).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run as runAll, clockErrMs } from './fixtures/deck-harness.mjs';
import { applyAnalysis } from '../../engine/analysis.js';
import { lastBeatOut, phaseError } from '../../engine/sync.js';

const SR = 48000;
/** The harness's run, with a whole track's end kept where it is (the harness grows every deck's live edge). */
const run = (engine, clock, s) => runAll(engine, clock, s, () => { for (const x of engine.decks.values()) if (x.kind === 'resident') x.ts.liveEdge = x.duration; });
const silence = (sec) => { const L = new Float32Array(Math.round(sec * SR)); L.fill(0.2, Math.round(0.002 * SR)); return { L, R: L.slice(), sampleRate: SR }; };
const gridAt = (bpm, t0) => ({
  bpm, conf: 0.9, octConf: 1, segments: [{ from: 0, grid: { t0, T: 60 / bpm }, conf: 0.9 }], bar1: null,
  residuals: { median: 0.5, max: 1 }, wave: { tStart: 0, hop: 512 / SR, data: new Uint8Array(0) },
});

/** A playing 124 BPM master, and a 128 BPM resident deck BEAT-synced to it, cued on its first beat. */
async function setup() {
  const clock = { t: 1 };
  const engine = makeEngine(clock);
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 124 });
  engine.clock.follow(m.id);
  await m.act('play');
  run(engine, clock, 1);
  const d = await makeDeck(engine, clock, { id: 2, slot: 2, resident: silence(60) });
  applyAnalysis(d, gridAt(128, -0.0024));
  d.snapAutoCue(d.grids.at(0));
  assert.ok(Math.abs(d.cue - 0.01) < 1e-9, `cue ${d.cue}: on its first beat, at the first playable input`);
  assert.deepEqual(await d.act('sync', { on: true }), { ok: true });
  run(engine, clock, 0.2);
  return { clock, engine, m, d };
}

/** The deck's beats against the master clock's (ms) at the start T, as the deck planned it (a start this close to the end stops within the output latency). */
function startErrMs(engine, d, T) {
  const s = d.ts.segAt(T + 1e-6), g = d.grids.at(s.input), mb = engine.clock.beat(T);
  assert.equal(s.active, true, 'playing from T');
  return phaseError(lastBeatOut(g, s.input, s.rate, T), g.T / s.rate, mb.lastBeat, mb.period) * 1000;
}

/** Run until PLAY now would start at master beat phase `ph` (0..1). */
function untilPhase(engine, clock, d, ph) {
  for (let i = 0; i < 400; i++) {
    const T = d.ts.soon(clock.t), mb = engine.clock.beat(T), x = (T - mb.lastBeat) / mb.period;
    if (Math.abs(x - Math.floor(x) - ph) < 0.03) return;
    run(engine, clock, 1536 / SR);
  }
  assert.fail(`never at master phase ${ph}`);
}

for (const ph of [0.2, 0.45, 0.6, 0.7, 0.85]) {
  test(`PLAY on a BEAT-synced resident deck cued at its first beat starts in phase, the master at beat phase ${ph}`, async () => {
    const { clock, engine, d } = await setup();
    untilPhase(engine, clock, d, ph);
    const T = d.ts.soon(clock.t);
    assert.deepEqual(await d.act('play'), { ok: true });
    run(engine, clock, T - clock.t + 0.02);
    const err = clockErrMs(engine, d, T + 0.002);
    assert.ok(Math.abs(err) < 3, `its beats come ${err.toFixed(1)} ms off the master's at the start (input ${d.node.segAt(T).input.toFixed(3)} s)`);
    assert.ok(d.node.segAt(T).input >= d.ts.clampInput(-Infinity), 'started inside the track');
  });
}

for (const ph of [0.1, 0.3, 0.5, 0.7, 0.9]) {
  test(`PLAY on a BEAT-synced resident deck parked just before its end starts in phase, a beat back, the master at beat phase ${ph}`, async () => {
    const { clock, engine, d } = await setup();
    d.setCue(d.duration - 0.1);
    run(engine, clock, 0.2);
    untilPhase(engine, clock, d, ph);
    const T = d.ts.soon(clock.t);
    assert.deepEqual(await d.act('play'), { ok: true });
    assert.equal(d.wantPlay, true, 'PLAY played');
    const err = startErrMs(engine, d, T);
    assert.ok(Math.abs(err) < 3, `its beats come ${err.toFixed(1)} ms off the master's at the start (input ${d.ts.segAt(T + 1e-6).input.toFixed(3)} s)`);
  });
}
