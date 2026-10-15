import test from 'node:test';
import assert from 'node:assert/strict';
import { Deck } from '../../engine/deck.js';
import { Timeshift } from '../../engine/timeshift.js';
import { MasterClock } from '../../engine/sync.js';

// Deck harness: the real Deck + Timeshift with stubbed audio nodes. The fake stretch node mimics
// SignalsmithStretch: schedule() drops planned changes at/after its currentTime, and
// dropBuffers() drops whole 2048-frame chunks that end at or before the requested time.
const SR = 48000, DT = 1536 / SR, BPM = 124, BEAT = 60 / BPM, BAR = 4 * BEAT;

function fakeNode(clock) {
  return {
    map: [{ active: false, input: 0, output: 0, rate: 1 }],
    schedule(obj) {
      while (this.map.length > 1 && this.map[this.map.length - 1].output >= clock.t + 0.003) this.map.pop();
      this.map.push({ ...this.map[this.map.length - 1], ...obj });
      return Promise.resolve();
    },
    addBuffers() { return 0; },
    dropBuffers(t) { return Promise.resolve({ start: Math.floor((t * SR) / 2048) * 2048 / SR, end: 0 }); },
  };
}

function setup({ pitch = 0, capSec = 120, liveEdge = 10 } = {}) {
  const clock = { t: 100 };
  const engine = {
    ctx: { get currentTime() { return clock.t; }, sampleRate: SR },
    params: { 'buffer.capSec': capSec, 'assist.on': false, 'bpm.range': 'AUTO', 'rec.format': 'wav' },
    clock: new MasterClock(), decks: new Map(), events: [],
    master: { setAssign() {}, removeDeck() {} },
    event(level, text) { this.events.push({ t: clock.t, level, text }); },
    broadcast() {}, updateClock() {}, wallNow: () => clock.t * 1000, ctxTimeAtWall: (w) => w / 1000, heardTime: () => clock.t,
  };
  const d = new Deck(engine, {
    id: 1, slot: 1, tabId: 10, stream: { getTracks: () => [], getAudioTracks: () => [] }, meta: { title: 'mix' },
    params: { pitch, range: 0.1, keyLock: true, syncMode: 'BEAT', fader: 1, xf: 'THRU', 'fx.type': 'ECHO', 'fx.beats': 0.5, 'fx.level': 0.5, 'fx.on': false },
  });
  d.ts = new Timeshift(fakeNode(clock), { sampleRate: SR, latency: 0.12, outLatency: 0.06, capSec });
  d.ts.liveEdge = liveEdge;
  const grid = { t0: 0, T: BEAT, bar1: null };
  d.tempo = {
    get: () => ({ state: 'LOCKED', inBpm: BPM, conf: 0.9, mult: 1, tapped: false, grid, canBeat: true }),
    sourceRateChanged() {}, pushBatch() {}, tap() {}, multiply() {}, shiftGrid() {}, setBar1() {},
  };
  d.grids.update(grid);
  d.analyser = { getFloatTimeDomainData() {} };
  d.meterBuf = new Float32Array(16);
  d.rack = { setClock() {}, tick() {}, setFx() {}, setFilter() {} };
  d.xfGain = { gain: { value: 1 } };
  d.recorder = { state: 'idle' };
  engine.decks.set(d.id, d);
  d.ts.change(clock.t, clock.t + 0.01, { active: false, input: 2 });
  d.cue = 2;
  clock.t += 0.02; // the cue position is in effect before the test acts
  return { clock, engine, d };
}

/** Advance in 1536-frame ticks with the source arriving in real time; trims settle asynchronously. */
async function run({ clock, d }, seconds, onTick) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    clock.t += DT;
    d.ts.liveEdge += DT;
    d.tick(clock.t);
    if (i % 16 === 0) await new Promise((r) => setImmediate(r));
    onTick && onTick(clock.t);
  }
}

const onGrid = (x) => Math.abs(x / BEAT - Math.round(x / BEAT)) < 1e-6;

test('a deck playing slower than its source keeps the audio under its playhead, warns once, then skips ahead whole bars', async () => {
  const h = setup({ pitch: -0.1, capSec: 120 });
  const { clock, engine, d } = h;
  await d.act('play');
  let prev = null, maxKept = 0;
  const skips = [];
  // The reserve grows 0.1 s per second: run well past capSec / 0.1.
  await run(h, 1500, (t) => {
    const p = d.ts.posAt(t);
    assert.ok(p >= d.ts.historyStart, `t=+${(t - 100).toFixed(0)} s: playhead ${p.toFixed(2)} behind historyStart ${d.ts.historyStart.toFixed(2)} (silence)`);
    if (prev !== null && p - prev > 1) skips.push({ t, by: p - prev - 0.9 * DT, res: d.ts.reserveAt(t) });
    maxKept = Math.max(maxKept, d.ts.liveEdge - d.ts.historyStart);
    prev = p;
  });
  assert.ok(d.wantPlay && d.ts.playingAt(clock.t), 'still playing');
  const near = engine.events.filter((e) => /almost full/.test(e.text));
  const skipped = engine.events.filter((e) => /skipped ahead/.test(e.text));
  assert.equal(near.length, 1, `one heads-up before the cap: ${JSON.stringify(engine.events)}`);
  assert.ok(skips.length >= 1 && skipped.length === skips.length, `each skip is announced: ${JSON.stringify(engine.events)}`);
  assert.ok(near[0].t < skipped[0].t, 'the heads-up comes first');
  assert.ok(engine.events.length <= 3, `no repeated warnings: ${engine.events.length}`);
  for (const s of skips) {
    assert.ok(Math.abs(s.by / BAR - Math.round(s.by / BAR)) < 1e-6, `skip of ${s.by} s is a whole number of bars`);
    assert.ok(Math.abs(s.res - 60) < BAR, `skip lands near half the cap (reserve ${s.res.toFixed(1)} s)`);
  }
  assert.ok(d.ts.reserveAt(clock.t) < 0.9 * 120, 'reserve back under the cap');
  // Bound: cap + 5% slack + the 4 s kept behind the playhead + one 2 s trim interval + rounding.
  assert.ok(maxKept <= 1.05 * 120 + 7, `memory stays bounded near the cap (kept ${maxKept.toFixed(1)} s)`);
});

test('a cued deck at the buffer cap warns once and keeps its pushed cue on the beat', async () => {
  const h = setup({ capSec: 120, liveEdge: 5 });
  const { clock, engine, d } = h;
  await run(h, 300, () => {});
  const full = engine.events.filter((e) => /buffer full/.test(e.text));
  assert.equal(full.length, 1, `one 'buffer full' notice per episode, got ${full.length}`);
  assert.ok(d.cue >= d.ts.historyStart, 'cue inside the buffer');
  assert.ok(d.ts.liveEdge - d.cue > 110, 'cue pushed along with the oldest audio');
  assert.ok(onGrid(d.cue), `pushed cue ${d.cue} is on the beat grid`);
  assert.ok(Math.abs(d.ts.posAt(clock.t + 1) - d.cue) < 1e-9, 'paused playhead sits on the cue');
  // A new episode (LIVE frees the buffer, then it fills again) is announced again.
  await d.act('live');
  await run(h, 130, () => {});
  assert.equal(engine.events.filter((e) => /buffer full/.test(e.text)).length, 2);
});

test('a deck played at 1x from a full buffer keeps playing without skipping or losing audio', async () => {
  const h = setup({ capSec: 120, liveEdge: 5 });
  const { clock, engine, d } = h;
  await run(h, 300, () => {});
  await d.act('play');
  let maxKept = 0;
  await run(h, 600, (t) => {
    assert.ok(d.ts.posAt(t) >= d.ts.historyStart, `t=+${(t - 100).toFixed(0)} s: playhead behind historyStart`);
    maxKept = Math.max(maxKept, d.ts.liveEdge - d.ts.historyStart);
  });
  assert.deepEqual(engine.events.map((e) => e.text), ['Deck 1: buffer full, the oldest audio was dropped.'], 'no skip, no extra warnings');
  assert.ok(d.wantPlay && d.ts.reserveAt(clock.t) > 115, 'still playing a full buffer behind live');
  // Steady: the reserve at play (up to cap + one 2 s trim interval) + 4 s behind the playhead + 2 s + rounding.
  assert.ok(maxKept <= 120 + 9, `kept ${maxKept.toFixed(1)} s`);
});
