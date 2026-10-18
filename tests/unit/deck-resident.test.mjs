// Resident decks: the whole decoded track is in the deck's buffer, so the live-window machinery
// (trim and the buffer cap, starvation, the emergency jump, dry notices, player assist) never runs,
// and the deck stops at the end of its track. Real Deck + Timeshift, fake stretch node and clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, makeDeck, FakeNode } from './fixtures/deck-harness.mjs';
import { Deck } from '../../engine/deck.js';
import { Timeshift } from '../../engine/timeshift.js';

const SR = 48000, DT = 1536 / SR;
const PARAMS = { pitch: 0, range: 0.1, keyLock: true, syncMode: 'BEAT', fader: 1, xf: 'THRU', 'fx.type': 'ECHO', 'fx.beats': 0.5, 'fx.level': 0.5, 'fx.on': false };
const tone = (sec, sr = SR) => { const n = Math.round(sec * sr), L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = 0.3 * Math.sin(i / 7); return { L, R: L.slice(), sampleRate: sr }; };

async function resident(sec, opts = {}) {
  const clock = { t: 1 };
  const engine = makeEngine(clock);
  const d = await makeDeck(engine, clock, { resident: tone(sec), ...opts });
  return { d, clock, engine };
}
function run(d, clock, seconds) { const end = clock.t + seconds; while (clock.t < end - 1e-9) { clock.t += DT; d.tick(clock.t); } }
const said = (engine, re) => engine.events.filter((e) => re.test(e.text));

test('a resident deck holds the whole track from one addBuffers call, cued at its first sound', async () => {
  const { d } = await resident(300);
  assert.equal(d.kind, 'resident');
  assert.deepEqual(d.node.adds, [300 * SR], 'one addBuffers call with the whole track');
  assert.equal(d.ts.historyStart, 0);
  assert.equal(d.ts.liveEdge, 300);
  assert.equal(d.duration, 300);
  assert.equal(d.tabId, null);
  assert.ok(d.cue < 0.02, `cue ${d.cue}`);
});

test('a resident 300 s track never triggers the buffer-cap skip on first PLAY', async () => {
  const { d, clock, engine } = await resident(300);
  assert.equal(d.kind, 'resident');
  assert.equal(d.ts.liveEdge, 300);
  await d.act('play');
  run(d, clock, 200 * DT);
  const p = d.ts.posAt(clock.t);
  assert.ok(p < 10, `playhead jumped to ${p.toFixed(1)} s (cap skip fired)`);
  assert.equal(said(engine, /skipped ahead|almost full/).length, 0, JSON.stringify(engine.events));
});

test('a resident deck plays to the end and stops there: no emergency loop, no dry notice', async () => {
  const { d, clock, engine } = await resident(20);
  await d.act('play');
  run(d, clock, 1000 * DT); // 32 s modelled
  assert.equal(d.ts.playingAt(clock.t), false, 'still playing past the end');
  assert.equal(d.node.segAt(clock.t).active, false, 'the stretcher is still playing past the end');
  const p = d.ts.posAt(clock.t);
  assert.ok(p >= 19.9 && p <= 20.0001, `stopped at ${p}`);
  assert.equal(d.wantPlay, false, 'the deck still says it is playing');
  assert.equal(d.state(clock.t).playing, false);
  assert.equal(said(engine, /ran dry|skipped ahead|reserve empty/).length, 0, JSON.stringify(engine.events));
});

test('PLAY at the end of the track does nothing until the playhead moves, and never throws', async () => {
  const { d, clock } = await resident(10);
  await d.act('play');
  run(d, clock, 12);
  assert.equal((await d.act('play')).ok, true);
  run(d, clock, 1);
  assert.equal(d.ts.playingAt(clock.t), false);
  assert.ok(Math.abs(d.ts.posAt(clock.t) - 10) < 1e-6, `moved to ${d.ts.posAt(clock.t)}`);
  d.setCue(4); // moved: PLAY plays again, from there
  run(d, clock, 0.3);
  await d.act('play');
  run(d, clock, 1);
  assert.equal(d.ts.playingAt(clock.t), true);
  const p = d.ts.posAt(clock.t);
  assert.ok(p > 4.5 && p < 5.2, `playhead ${p}`);
});

test('a resident deck can reach its last frames through the input clamp, and stops at the end from there', async () => {
  const { d, clock } = await resident(30);
  assert.equal(d.ts.clampInput(29.95), 29.95);
  assert.equal(d.ts.clampInput(31), 30 - 1 / SR);
  d.setCue(29.9); // the clamp every move goes through (seek, cue, roll slip, phase jump)
  run(d, clock, 0.3);
  assert.ok(Math.abs(d.ts.posAt(clock.t) - 29.9) < 1e-9, `parked at ${d.ts.posAt(clock.t)}`);
  await d.act('play');
  run(d, clock, 1);
  assert.equal(d.ts.playingAt(clock.t), false);
  assert.ok(Math.abs(d.ts.posAt(clock.t) - 30) < 1e-6, `stopped at ${d.ts.posAt(clock.t)}`);
  // A live buffer keeps its margin behind the live edge.
  const live = new Timeshift(new FakeNode(clock), { sampleRate: SR, latency: 0.12, outLatency: 0.06 });
  live.liveEdge = 30;
  assert.ok(Math.abs(live.clampInput(29.95) - (30 - 0.12 - 0.3)) < 1e-9);
});

test('a resident deck never schedules assist and never trims, even near its end with a player in its tab', async () => {
  const { d, clock } = await resident(120, { pitch: 0.06 });
  // An audible, assistable player: a live deck this close to its live edge would ask it to speed up.
  d.agents.set(0, { port: { postMessage() {} }, status: { t: 'status', hasMedia: true, playing: true, rate: 1, audible: 1, seq: -1 } });
  const sent = []; d.postAssist = (m) => sent.push(m);
  let trims = 0; const t0 = d.ts.trim.bind(d.ts); d.ts.trim = (...a) => { trims++; return t0(...a); };
  d.setCue(108);
  run(d, clock, 0.3);
  await d.act('play');
  run(d, clock, 400 * DT);
  assert.deepEqual(sent, []);
  assert.equal(trims, 0);
  assert.equal(d.starved, false);
});

test('LIVE has no meaning on a resident deck', async () => {
  const { d } = await resident(30);
  const r = await d.act('live');
  assert.equal(r.ok, false);
  assert.match(r.error, /no live edge/);
});

test('snapshot reports kind, duration and load state; a live deck reports itself as live', async () => {
  const { d, clock, engine } = await resident(42);
  const s = d.state(clock.t);
  assert.equal(s.kind, 'resident');
  assert.ok(Math.abs(s.duration - 42) < 1e-3);
  assert.deepEqual(s.load, { state: 'ready', progress: 1, strategy: null, error: null, report: null });
  assert.equal(s.liveEdge, 42);
  assert.equal(s.starved, false);
  assert.deepEqual(s.assist, { available: false, active: false, sourceRate: 1 });
  const live = makeDeck(engine, clock, { id: 5, slot: 5 }).state(clock.t);
  assert.equal(live.kind, 'live');
  assert.equal(live.duration, null);
  assert.equal(live.load.state, 'ready');
});

test('snapshot carries the analysis summary (bar 1 suggestion and confidence); null on a deck without one', async () => {
  const { d, clock, engine } = await resident(42);
  assert.equal(d.state(clock.t).analysis, null);
  d.analysis = { bpm: 124, conf: 0.9, octConf: 0.8, bar1: { t: 2.5, conf: 0.6 }, residuals: { median: 1, max: 3 } }; // as Engine.gridResident sets it
  assert.deepEqual(d.state(clock.t).analysis, { bar1: { t: 2.5, conf: 0.6 }, conf: 0.9 });
  d.analysis = { ...d.analysis, bar1: null };
  assert.deepEqual(d.state(clock.t).analysis, { bar1: null, conf: 0.9 });
  assert.equal(makeDeck(engine, clock, { id: 5, slot: 5 }).state(clock.t).analysis, null);
});

test('with no analysis, a resident deck is unlocked and has no waveform, and ticks, sync, master and meters run without an input worklet', async () => {
  const { d, clock, engine } = await resident(60);
  engine.master.deckMeter = () => ({ peak: 0, rms: 0, clipFrame: -1 });
  const s = d.state(clock.t);
  assert.equal(s.bpm.state, 'SEARCH');
  assert.equal(s.bpm.native, null);
  assert.equal(s.grid, null);
  assert.equal(d.waveBacklog(), null);
  assert.equal(d.canBeat(), false);
  assert.equal((await d.act('sync', { on: true })).ok, false); // no BPM yet: said, not thrown
  assert.equal((await d.act('master')).ok, true);
  await d.act('play');
  for (let i = 0; i < 100; i++) {
    clock.t += DT;
    d.tick(clock.t); engine.updateClock(clock.t); d.syncTick(clock.t); d.phaseTick(clock.t); d.meterTick(clock.t);
    d.state(clock.t);
  }
  assert.equal(d.ts.playingAt(clock.t), true);
});

test('TAP gives a resident deck with no analysis its tempo', async () => {
  const { d, clock } = await resident(60);
  await d.act('play');
  run(d, clock, 0.5);
  const t0 = clock.t;
  for (let k = 0; k < 6; k++) {
    const t = t0 + 0.5 * k;
    while (clock.t < t) { clock.t += DT; d.tick(clock.t); }
    assert.equal((await d.act('tap', { wallMs: t * 1000 })).ok, true);
  }
  const s = d.state(clock.t);
  assert.equal(s.bpm.state, 'LOCKED');
  assert.ok(Math.abs(s.bpm.native - 120) < 0.01, `bpm ${s.bpm.native}`);
  assert.ok(s.grid, 'no grid after TAP');
});

test("a file or link load's token stays in the deck's load through every later update and the promotion; a deck without one shows none", () => {
  const clock = { t: 1 };
  const engine = makeEngine(clock);
  const d = new Deck(engine, { id: 4, slot: 4, tabId: null, stream: null, meta: { title: 'x' }, params: { ...PARAMS }, kind: 'loading' });
  d.setLoad({ token: 'tok-1' });
  d.setLoad({ progress: 0.5, strategy: 'decoding' });
  d.setLoad({ state: 'ready', progress: 1, strategy: null, error: null });
  assert.deepEqual(d.load, { state: 'ready', progress: 1, strategy: null, error: null, report: null, token: 'tok-1' });
  const plain = new Deck(engine, { id: 5, slot: 5, tabId: null, stream: null, meta: {}, params: { ...PARAMS }, kind: 'loading' });
  plain.setLoad({ progress: 0.2 });
  assert.equal('token' in plain.load, false);
});

test('a loading deck is inert but for eject, takes its track in pieces, then becomes resident', async () => {
  const clock = { t: 1 };
  const engine = makeEngine(clock);
  const d = new Deck(engine, { id: 3, slot: 3, tabId: null, stream: null, meta: { title: 'piece' }, params: { ...PARAMS }, kind: 'loading' });
  d.node = new FakeNode(clock);
  d.ts = new Timeshift(d.node, { sampleRate: SR, latency: 0.12, outLatency: 0.06, capSec: 240 });
  d.rack = { setClock() {}, tick() {}, setFx() {}, setFilter() {} };
  d.xfGain = { gain: { value: 1 } };
  engine.decks.set(3, d);
  assert.equal(d.kind, 'loading');
  assert.deepEqual(d.state(clock.t).load, { state: 'loading', progress: 0, strategy: null, error: null, report: null });
  for (const a of ['play', 'cueDown', 'live', 'recStart']) assert.match((await d.act(a)).error, /still loading/, a);
  d.setLoad({ progress: 0.42, strategy: 'fetching' });
  assert.deepEqual(d.state(clock.t).load, { state: 'loading', progress: 0.42, strategy: 'fetching', error: null, report: null });
  let trims = 0; d.ts.trim = async () => { trims++; return { dropped: false }; };
  d.appendResident(tone(10));
  run(d, clock, 3);
  d.appendResident(tone(5));
  assert.equal(d.kind, 'loading');
  assert.equal(d.ts.liveEdge, 15);
  assert.deepEqual(d.node.adds, [10 * SR, 5 * SR]);
  assert.equal(trims, 0);
  d.finishResident({ duration: 15 });
  assert.equal(d.kind, 'resident');
  assert.equal(d.duration, 15);
  assert.equal(d.state(clock.t).load.state, 'ready');
  assert.equal(d.state(clock.t).load.progress, 1);
  assert.equal((await d.act('play')).ok, true);
  run(d, clock, 1);
  assert.equal(d.ts.playingAt(clock.t), true);
  // Eject works on a loading deck.
  const e = new Deck(engine, { id: 4, slot: 4, tabId: null, stream: null, meta: {}, params: { ...PARAMS }, kind: 'loading' });
  engine.decks.set(4, e);
  assert.equal((await e.act('eject')).ok, true);
  assert.equal(engine.decks.has(4), false);
});
