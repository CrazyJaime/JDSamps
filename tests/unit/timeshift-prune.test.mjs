// Timeshift keeps a bounded schedule history, and 'now' lookups do not scan it (final review engine/F8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeshift } from '../../engine/timeshift.js';
import { makeEngine, makeDeck, run, FakeNode } from './fixtures/deck-harness.mjs';

const mk = (clock) => {
  const ts = new Timeshift(new FakeNode(clock), { sampleRate: 48000, latency: 0.12, outLatency: 0.06 });
  ts.liveEdge = 1e6;
  return ts;
};

/** Number of segment reads fn() makes (index reads on ts.segs). */
function segReads(ts, fn) {
  const real = ts.segs;
  let n = 0;
  ts.segs = new Proxy(real, { get(o, k) { if (typeof k === 'string' && /^\d+$/.test(k)) n++; return o[k]; } });
  try { fn(); } finally { ts.segs = real; }
  return n;
}

test('Timeshift.segs stays bounded over a simulated hour of rate changes and bends', () => {
  const clock = { t: 0 };
  const ts = mk(clock);
  ts.change(0, 0.2, { active: true, input: 0, rate: 1, semitones: 0 });
  let max = 0, k = 0;
  // ~110 changes a minute (a synced deck), every third one a phase bend.
  for (let now = 1; now < 3600; now += 0.55, k++) {
    clock.t = now;
    ts.flush(now);
    // What was heard in the last 2 s can no longer change: those lookups must survive the cut.
    const past = [0, 0.5, 1, 1.5, 1.99].map((back) => [now - back, ts.posAt(now - back), ts.rateAt(now - back)]);
    if (k % 3 === 2) ts.bend(now, ts.soon(now), 1.01, 0.3);
    else ts.change(now, ts.soon(now), { rate: 1 + 0.001 * Math.sin(k) });
    for (const [t, p, r] of past) {
      assert.ok(Math.abs(ts.posAt(t) - p) < 1e-9, `posAt(${t.toFixed(2)}) moved at ${now.toFixed(2)}`);
      assert.equal(ts.rateAt(t), r);
    }
    max = Math.max(max, ts.segs.length);
  }
  assert.ok(max <= 16, `segs grew to ${max}`);
});

test('posAt/rateAt/segAt at now and ahead read O(1) segments, however many are planned in the window', () => {
  const clock = { t: 0 };
  const ts = mk(clock);
  ts.change(0, 0.2, { active: true, input: 0, rate: 1, semitones: 0 });
  // 500 changes inside the 2 s history window: none can be pruned.
  let now = 0.3;
  for (let i = 0; i < 500; i++, now += 0.003) { clock.t = now; ts.change(now, now + 0.001, { rate: 1 + i * 1e-5 }); }
  now += 0.01;
  assert.ok(ts.segs.length > 400, `segs ${ts.segs.length}`);
  for (const t of [now, ts.soon(now), now + 5]) {
    const reads = segReads(ts, () => { ts.posAt(t); ts.rateAt(t); ts.segAt(t); ts.playingAt(t); });
    assert.ok(reads <= 8, `${reads} segment reads at t=${t.toFixed(3)}`);
  }
  // Older lookups stay exact.
  const s = ts.segAt(0.3 + 100 * 0.003 + 0.0015);
  assert.ok(Math.abs(s.rate - (1 + 100 * 1e-5)) < 1e-12, `rate ${s.rate}`);
});

test('a synced deck playing for 3 minutes keeps its schedule history bounded', async () => {
  const clock = { t: 100 };
  const engine = makeEngine(clock);
  engine.clock.follow(1);
  let bpm = 128, k = 0;
  engine.updateClock = (now) => { const P = 60 / bpm; engine.clock.update(now, { playing: true, bpm, lastBeat: 100 + Math.floor((now - 100) / P) * P, period: P }); };
  engine.updateClock(clock.t);
  const d = makeDeck(engine, clock, { liveEdge: 30, bpm: 124 });
  d.setCue(2);
  run(engine, clock, 0.2);
  assert.equal((await d.act('sync', { on: true })).ok, true);
  await d.act('syncPlay');
  let max = 0;
  // The master's tempo estimate wanders a little, as a real tracker's does: the deck keeps re-planning.
  const hook = (now) => { if (++k % 16 === 0) bpm = 128 * (1 + 2e-4 * Math.sin(k / 50)); engine.updateClock(now); };
  for (let sec = 1; sec <= 180; sec++) { run(engine, clock, 1, hook); max = Math.max(max, d.ts.segs.length); }
  assert.ok(d.node.log.length > 300, `only ${d.node.log.length} changes were scheduled`);
  assert.ok(max <= 40, `segs grew to ${max}`);
  assert.ok(d.phaseMs != null && Math.abs(d.phaseMs) < 10, `phase ${d.phaseMs} ms`);
});
