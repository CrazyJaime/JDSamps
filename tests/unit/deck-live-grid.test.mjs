// A live deck's beat as heard (Deck.gridAt) is where the tracker measured its audio's beats near the playhead. The DJ's
// GRID ◀ ▶ (½ beat, or 10 ms with shift) moves the whole track's grid: the beat that sync uses moves with it, a master's
// published clock and a follower's phase alike, and so does the grid kept before a capture gap found after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, run } from './fixtures/deck-harness.mjs';
import { phaseError } from '../../engine/sync.js';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { GridMap } from '../../engine/timeshift.js';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

/** A click track at 48 kHz (a 3 kHz blip a beat) with `drops` ({ms, at}: ms of audio dropped at track second at). */
function clicks(seconds, bpm, drops = []) {
  const T = 60 / bpm;
  let x = new Float32Array(seconds * FS);
  for (let i = 0; i < x.length; i++) { const u = (i / FS) % T; if (u < 0.04) x[i] = 0.6 * Math.sin(2 * Math.PI * 3000 * u) * Math.exp(-u * 90); }
  for (const { ms, at } of [...drops].sort((a, b) => b.at - a.at)) {
    const i = Math.round(at * FS), n = Math.round((ms / 1000) * FS), y = new Float32Array(x.length - n);
    y.set(x.subarray(0, i)); y.set(x.subarray(i + n), i); x = y;
  }
  return x;
}

/** Deck x follows its capture `audio` with a real tracker and grid map; the returned function feeds it up to its live edge. */
function tracks(x, audio) {
  const odf = new OdfCore(FS, (f, l, t) => x.tempo.pushFrame(f, l, t));
  let fed = 0;
  x.tempo = new DeckTempo({ sampleRate: FS, fps: odf.fps });
  x.grids = new GridMap();
  x.ts.liveEdge = 0.05;
  return () => {
    for (const upto = Math.min(audio.length, Math.floor((x.ts.liveEdge * FS) / 128) * 128); fed + 128 <= upto; fed += 128) odf.push(audio.subarray(fed, fed + 128), fed);
    x.followTempo();
  };
}

/**
 * Run `s` seconds: deck x's audio beat (the last of `beats`, input s, its playhead played) against the master clock,
 * ms, at each tick: their median.
 */
function offClock(engine, clock, x, beats, s, feed) {
  const es = [];
  run(engine, clock, s, (t) => {
    feed(t);
    const p = x.node.posAt(t), seg = x.node.segAt(t), mb = engine.clock.beat(t);
    if (!seg.active || !(seg.rate > 0) || !mb) return;
    let b = 0;
    while (b + 1 < beats.length && beats[b + 1] <= p) b++;
    es.push(phaseError(t - (p - beats[b]) / seg.rate, (beats[1] - beats[0]) / seg.rate, mb.lastBeat, mb.period) * 1000);
  });
  es.sort((a, b) => a - b);
  return es[es.length >> 1];
}

const every = (T, seconds) => Array.from({ length: Math.ceil(seconds / T) }, (_, k) => k * T);

for (const ms of [10, -10]) {
  test(`GRID ${ms > 0 ? '+' : ''}${ms} ms on a live master: its published clock moves ${Math.abs(ms)} ms against its audio`, async () => {
    const clock = { t: 100 }, engine = makeEngine(clock), T = 60 / 128;
    engine.params['assist.on'] = false;
    const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
    const feed = tracks(m, clicks(60, 128));
    run(engine, clock, 6, feed); // the playhead 6 s behind its live edge
    await m.act('play');
    engine.clock.follow(1);
    run(engine, clock, 4, feed);
    const before = offClock(engine, clock, m, every(T, 60), 4, feed);
    assert.deepEqual(await m.act('gridShift', { beats: 0, ms }), { ok: true });
    run(engine, clock, 1, feed);
    const after = offClock(engine, clock, m, every(T, 60), 6, feed);
    // The grid later by ms: its beat comes ms later against the same audio.
    assert.ok(Math.abs(before - after - ms) < 2, `moved ${(before - after).toFixed(2)} ms`);
  });

  test(`GRID ${ms > 0 ? '+' : ''}${ms} ms on a live BEAT follower: its audio moves ${Math.abs(ms)} ms against the master's beat`, async () => {
    const clock = { t: 100 }, engine = makeEngine(clock), T = 60 / 128;
    engine.params['assist.on'] = false;
    const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 124, liveEdge: 600, capSec: 1e7 });
    const d = makeDeck(engine, clock, { id: 2, slot: 2, bpm: 128, liveEdge: 600, capSec: 1e7 });
    const feed = tracks(d, clicks(70, 128));
    await m.act('play');
    engine.clock.follow(1);
    run(engine, clock, 8, feed); // the follower's playhead will be 8 s behind its live edge
    assert.deepEqual(await d.act('syncPlay'), { ok: true });
    run(engine, clock, 8, feed);
    const before = offClock(engine, clock, d, every(T, 70), 4, feed);
    assert.deepEqual(await d.act('gridShift', { beats: 0, ms }), { ok: true });
    run(engine, clock, 4, feed);
    const after = offClock(engine, clock, d, every(T, 70), 6, feed);
    // Its grid later by ms on the master's beat: its audio comes ms earlier.
    assert.ok(Math.abs(before - after - ms) < 2.5, `moved ${(before - after).toFixed(2)} ms`);
  });
}

test('GRID +½ on a live master playing a house loop: its published clock moves half a beat against its audio', async () => {
  const clock = { t: 100 }, engine = makeEngine(clock), s = synth({ ...PATTERNS.house, bars: 40, tail: 0 }), T = s.beatSec;
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 124, liveEdge: 600, capSec: 1e7 });
  const feed = tracks(m, s.x);
  run(engine, clock, 8, feed);
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 4, feed);
  const before = offClock(engine, clock, m, s.truth, 4, feed);
  assert.deepEqual(await m.act('gridShift', { beats: 0.5, ms: 0 }), { ok: true });
  run(engine, clock, 1, feed);
  const after = offClock(engine, clock, m, s.truth, 8, feed), P = T * 1000, moved = before - after - P / 2;
  assert.ok(Math.abs(moved - Math.round(moved / P) * P) < 3, `moved ${(before - after).toFixed(1)} ms, half a beat is ${(P / 2).toFixed(1)}`);
});

test('GRID +10 ms on a live deck, then a capture gap found: the grid kept before the gap keeps the nudge', async () => {
  const clock = { t: 100 }, engine = makeEngine(clock), T = 60 / 128;
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
  const feed = tracks(m, clicks(40, 128, [{ ms: 12, at: 24.1 }]));
  run(engine, clock, 4, feed);
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 10, feed);
  const beatOf = (g, p) => g.t0 + Math.round((p - g.t0) / g.T) * g.T, click = (p) => Math.round(p / T) * T; // (before the gap)
  const p0 = m.ts.posAt(clock.t), was = (beatOf(m.grids.at(p0), p0) - click(p0)) * 1000;
  assert.deepEqual(await m.act('gridShift', { beats: 0, ms: 10 }), { ok: true });
  run(engine, clock, 16, feed);
  const segs = m.grids.segs, k = segs.findIndex((s) => s.shift);
  assert.ok(k > 0, `a gap found: segments from ${segs.map((s) => s.from.toFixed(2)).join(', ')}`);
  const at = segs[k].from - 1, off = (beatOf(segs[k - 1].grid, at) - click(at)) * 1000;
  assert.ok(Math.abs(off - was - 10) < 2, `the grid kept before the gap at ${segs[k].from.toFixed(2)} s is ${off.toFixed(1)} ms off the clicks, ${was.toFixed(1)} before the nudge`);
});

test('a live deck TAPped 15 ms after its onsets, then a capture gap found: the grids before and after the gap keep the tap', async () => {
  // A tapped grid is the DJ's: the tracker may follow its period, never move its beat to the onsets.
  const clock = { t: 100 }, engine = makeEngine(clock), T = 60 / 128;
  engine.params['assist.on'] = false;
  const m = makeDeck(engine, clock, { id: 1, slot: 1, bpm: 128, liveEdge: 600, capSec: 1e7 });
  const feed = tracks(m, clicks(40, 128, [{ ms: 12, at: 24.1 }]));
  run(engine, clock, 4, feed);
  await m.act('play');
  engine.clock.follow(1);
  run(engine, clock, 8, feed);
  const p0 = m.ts.posAt(clock.t), k0 = Math.ceil(p0 / T) + 1; // (the master plays at 1×)
  for (let k = k0; k < k0 + 6; k++) assert.deepEqual(await m.act('tap', { wallMs: (clock.t + k * T + 0.015 - p0) * 1000 }), { ok: true });
  assert.equal(m.tempo.get().tapped, true);
  run(engine, clock, 18, feed);
  const segs = m.grids.segs, k = segs.findIndex((s) => s.shift);
  assert.ok(k > 0, `a gap found: segments from ${segs.map((s) => s.from.toFixed(2)).join(', ')}`);
  const beatOf = (g, p) => g.t0 + Math.round((p - g.t0) / g.T) * g.T, click = (p, d = 0) => Math.round((p + d) / T) * T - d;
  const before = segs[k].from - 1, after = segs[k].from + 1;
  const off = [(beatOf(segs[k - 1].grid, before) - click(before)) * 1000, (beatOf(segs[k].grid, after) - click(after, 0.012)) * 1000];
  assert.ok(off.every((x) => Math.abs(x - 15) < 2), `the grids before and after the gap at ${segs[k].from.toFixed(2)} s are ${off.map((x) => x.toFixed(1)).join(' and ')} ms off the clicks`);
});
