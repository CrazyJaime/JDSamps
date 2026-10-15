// No false SYNC: BEAT sync needs the deck's own confident beat grid; without it SYNC is refused
// with a reason (TEMPO sync is still allowed), and a BEAT-synced deck that loses its grid says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Deck } from '../../engine/deck.js';
import { Timeshift } from '../../engine/timeshift.js';
import { MasterClock } from '../../engine/sync.js';

const SR = 48000, BPM = 124, BEAT = 60 / BPM;
const LOCKED = { state: 'LOCKED', conf: 0.9, tapped: false, canBeat: true };
const UNSURE = { state: 'UNSURE', conf: 0.3, tapped: false, canBeat: false }; // tracker locked, conf < 0.5
const TAPPED = { state: 'LOCKED', conf: 1, tapped: true, canBeat: true };

function fakeNode(clock) {
  return {
    map: [{ active: false, input: 0, output: 0, rate: 1 }],
    schedule(obj) {
      while (this.map.length > 1 && this.map[this.map.length - 1].output >= clock.t + 0.003) this.map.pop();
      this.map.push({ ...this.map[this.map.length - 1], ...obj });
      return Promise.resolve();
    },
    addBuffers() { return 0; },
    dropBuffers() { return Promise.resolve({ start: 0, end: 0 }); },
  };
}

/** One deck plus, unless `alone`, a playing 128 BPM master clock on another deck. */
function setup({ tempo = UNSURE, syncMode = 'BEAT', alone = false } = {}) {
  const clock = { t: 100 };
  const engine = {
    ctx: { get currentTime() { return clock.t; }, sampleRate: SR },
    params: { 'buffer.capSec': 120, 'assist.on': false, 'bpm.range': 'AUTO', 'rec.format': 'wav' },
    clock: new MasterClock(), decks: new Map(), events: [],
    master: { setAssign() {}, removeDeck() {} },
    event(level, text) { this.events.push({ t: clock.t, level, text }); },
    broadcast() {}, updateClock() {}, wallNow: () => clock.t * 1000, ctxTimeAtWall: (w) => w / 1000, heardTime: () => clock.t,
  };
  const d = new Deck(engine, {
    id: 1, slot: 1, tabId: 10, stream: { getTracks: () => [], getAudioTracks: () => [] }, meta: { title: 'mix' },
    params: { pitch: 0, range: 0.1, keyLock: true, syncMode, fader: 1, xf: 'THRU', 'fx.type': 'ECHO', 'fx.beats': 0.5, 'fx.level': 0.5, 'fx.on': false },
  });
  d.ts = new Timeshift(fakeNode(clock), { sampleRate: SR, latency: 0.12, outLatency: 0.06, capSec: 120 });
  d.ts.liveEdge = 30;
  const grid = { t0: 0, T: BEAT, bar1: null };
  const st = { ...tempo };
  d.tempo = {
    st,
    get: () => ({ state: st.state, inBpm: BPM, conf: st.conf, mult: 1, tapped: st.tapped, grid, canBeat: st.canBeat }),
    sourceRateChanged() {}, pushBatch() {}, tap() {}, multiply() {}, shiftGrid() {}, setBar1() {},
  };
  d.grids.update(grid);
  d.analyser = { getFloatTimeDomainData() {} };
  d.meterBuf = new Float32Array(16);
  d.rack = { setClock() {}, tick() {}, setFx() {}, setFilter() {} };
  d.xfGain = { gain: { value: 1 } };
  d.recorder = { state: 'idle' };
  engine.decks.set(d.id, d);
  if (!alone) {
    engine.clock.follow(2);
    engine.clock.update(clock.t, { playing: true, bpm: 128, lastBeat: clock.t, period: 60 / 128 });
  }
  d.ts.change(clock.t, clock.t + 0.01, { active: false, input: 2 });
  clock.t += 0.02;
  return { clock, engine, d };
}

test('BEAT SYNC on a deck whose grid is not confident (UNSURE) is refused with a reason', async () => {
  const { engine, d } = setup({ tempo: UNSURE, syncMode: 'BEAT' });
  const before = engine.clock.state();
  const r = await d.act('sync', { on: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /Beat grid not confident/);
  assert.match(r.error, /TAP/);
  assert.match(r.error, /TEMPO/);
  assert.equal(d.syncOn, false);
  assert.equal(d.state(d.now()).sync.on, false);
  assert.deepEqual(engine.clock.state(), before);
  assert.equal(d.params.pitch, 0, 'a refused SYNC leaves the tempo alone');
});

test('BEAT SYNC refused with no master leaves no master picked behind', async () => {
  const { engine, d } = setup({ tempo: UNSURE, syncMode: 'BEAT', alone: true });
  const other = { id: 2, wantPlay: true, tempoInfo: () => ({ native: 128 }), canBeat: () => true, tempo: { get: () => ({ conf: 0.9 }) }, playingSince: 50 };
  engine.decks.set(2, other);
  const r = await d.act('sync', { on: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /Beat grid not confident/);
  assert.equal(engine.clock.assigned, null);
  assert.equal(engine.clock.state().mode, 'none');
});

test('TEMPO SYNC on the same UNSURE deck is accepted and matches tempo', async () => {
  const { d } = setup({ tempo: UNSURE, syncMode: 'TEMPO' });
  const r = await d.act('sync', { on: true });
  assert.deepEqual(r, { ok: true });
  assert.equal(d.syncOn, true);
  assert.ok(Math.abs(d.params.pitch - (128 / BPM - 1)) < 1e-6, `pitch ${d.params.pitch}`);
});

test('BEAT SYNC is accepted on a confident deck and on a TAPped deck', async () => {
  for (const tempo of [LOCKED, TAPPED]) {
    const { d } = setup({ tempo, syncMode: 'BEAT' });
    assert.deepEqual(await d.act('sync', { on: true }), { ok: true }, JSON.stringify(tempo));
    assert.equal(d.syncOn, true);
  }
});

test('an UNSURE deck alone can still press SYNC to become the tempo master', async () => {
  const { engine, d } = setup({ tempo: UNSURE, syncMode: 'BEAT', alone: true });
  assert.deepEqual(await d.act('sync', { on: true }), { ok: true });
  assert.equal(engine.clock.assigned, d.id);
  assert.equal(d.syncOn, false);
});

test('a BEAT-synced deck that loses its beat grid keeps tempo sync and says once that phase lock paused', async () => {
  const { clock, engine, d } = setup({ tempo: LOCKED, syncMode: 'BEAT' });
  assert.deepEqual(await d.act('sync', { on: true }), { ok: true });
  await d.act('play');
  clock.t += 1;
  d.phaseTick(clock.t);
  assert.notEqual(d.phaseMs, null, 'phase is measured while the grid is confident');
  d.tempo.st.canBeat = false; d.tempo.st.state = 'UNSURE'; d.tempo.st.conf = 0.3;
  for (let i = 0; i < 6; i++) { clock.t += 0.5; d.phaseTick(clock.t); }
  const notes = engine.events.filter((e) => /phase lock paused/.test(e.text));
  assert.equal(notes.length, 1, JSON.stringify(engine.events));
  assert.equal(notes[0].level, 'warn');
  assert.match(notes[0].text, /Deck 1/);
  assert.equal(d.syncOn, true, 'tempo sync stays on');
  assert.equal(d.phaseMs, null);
  d.tempo.st.canBeat = true; d.tempo.st.state = 'LOCKED'; d.tempo.st.conf = 0.9;
  clock.t += 0.5; d.phaseTick(clock.t);
  assert.notEqual(d.phaseMs, null, 'phase lock resumes once the grid is confident again');
  // A new SYNC press re-arms the notice.
  await d.act('sync', { on: false });
  clock.t += 0.5; d.phaseTick(clock.t);
  assert.deepEqual(await d.act('sync', { on: true }), { ok: true });
  d.tempo.st.canBeat = false;
  clock.t += 0.5; d.phaseTick(clock.t);
  assert.equal(engine.events.filter((e) => /phase lock paused/.test(e.text)).length, 2);
});
