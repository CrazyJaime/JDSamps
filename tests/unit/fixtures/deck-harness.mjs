// Drives the real Deck + Timeshift without Web Audio. FakeNode mimics SignalsmithStretch.schedule():
// every call pops the map entries with output >= the worklet's currentTime, then appends the new one.
import { Deck } from '../../../engine/deck.js';
import { Timeshift } from '../../../engine/timeshift.js';
import { MasterClock } from '../../../engine/sync.js';

export const TICK = 1536 / 48000;

export class FakeNode {
  constructor(clock) {
    this.clock = clock;
    this.map = [{ active: false, input: 0, output: 0, rate: 1, semitones: 0, loopStart: 0, loopEnd: 0 }];
    this.log = [];
  }
  addBuffers() { return 0; }
  schedule(obj) {
    const wNow = this.clock.t + 0.003; // the worklet runs slightly ahead of the main thread
    while (this.map.length && this.map[this.map.length - 1].output >= wNow) this.map.pop();
    const latest = this.map[this.map.length - 1] || {};
    this.map.push({ ...latest, ...obj });
    this.log.push({ at: this.clock.t, ...obj });
    return Promise.resolve();
  }
  dropBuffers(t) { return Promise.resolve({ start: t, end: 0 }); }
  /** The node's segment in effect for audio output at context time t. */
  segAt(t) { let s = this.map[0]; for (const x of this.map) if (x.output <= t) s = x; return s; }
  /** The node's playhead at output time t. */
  posAt(t) { const s = this.segAt(t); return s.active ? s.input + s.rate * (t - s.output) : s.input; }
  /** The node's playback rate at t (0 while inactive). */
  rateAt(t) { const s = this.segAt(t); return s.active ? s.rate : 0; }
}

export function makeEngine(clock) {
  return {
    ctx: { get currentTime() { return clock.t; }, sampleRate: 48000 },
    params: { 'buffer.capSec': 240, 'assist.on': true, 'bpm.range': 'AUTO', 'rec.format': 'wav' },
    clock: new MasterClock(), decks: new Map(), events: [],
    master: { setAssign() {}, removeDeck() {} },
    event(level, text) { this.events.push({ t: clock.t, level, text }); },
    broadcast() {}, updateClock() {}, wallNow: () => clock.t * 1000, ctxTimeAtWall: (w) => w / 1000, heardTime: () => clock.t,
  };
}

/** A free-running master clock at `bpm` (beats at t0 + k·60/bpm), assigned to an absent deck 1. */
export function freeMaster(engine, { bpm = 128, t0 = 100 } = {}) {
  const m = { bpm, t0 };
  engine.clock.follow(1);
  engine.updateClock = (now) => {
    const P = 60 / m.bpm;
    engine.clock.update(now, { playing: true, bpm: m.bpm, lastBeat: m.t0 + Math.floor((now - m.t0) / P) * P, period: P });
  };
  return m;
}

export function fakeTempo({ bpm, t0 = 0, canBeat = true }) {
  const T = 60 / bpm;
  return {
    bpm, grid: { t0, T, bar1: null },
    get() { return { state: 'LOCKED', inBpm: this.bpm, conf: 0.9, mult: 1, tapped: false, grid: this.grid, canBeat }; },
    sourceRateChanged(ratio) { this.bpm *= ratio; this.grid = { ...this.grid, T: this.grid.T / ratio }; },
    pushBatch() {}, tap() {}, multiply() {}, shiftGrid() {}, setBar1() {},
  };
}

export function makeDeck(engine, clock, { id = 2, slot = 2, bpm = 124, pitch = 0, liveEdge = 30, lat = 0.12, syncMode = 'BEAT' } = {}) {
  const d = new Deck(engine, {
    id, slot, tabId: id * 10, stream: { getTracks: () => [], getAudioTracks: () => [] }, meta: { title: 't' + id },
    params: { pitch, range: 0.1, keyLock: true, syncMode, fader: 1, xf: 'THRU', 'fx.type': 'ECHO', 'fx.beats': 0.5, 'fx.level': 0.5, 'fx.on': false },
  });
  d.node = new FakeNode(clock);
  d.ts = new Timeshift(d.node, { sampleRate: 48000, latency: lat, outLatency: lat / 2, capSec: 240 });
  d.ts.liveEdge = liveEdge;
  d.tempo = fakeTempo({ bpm });
  d.grids.update(d.tempo.get().grid);
  d.analyser = { getFloatTimeDomainData() {} };
  d.meterBuf = new Float32Array(16);
  d.rack = { setClock() {}, tick() {}, setFx() {}, setFilter() {} };
  d.xfGain = { gain: { value: 1 } };
  d.recorder = { state: 'idle' };
  engine.decks.set(id, d);
  return d;
}

/** Advance `seconds` in render-quantum-sized ticks, in the engine's order; live edges grow in real time. */
export function run(engine, clock, seconds, onTick) {
  const end = clock.t + seconds;
  while (clock.t < end - 1e-9) {
    clock.t += TICK;
    for (const d of engine.decks.values()) d.ts.liveEdge += TICK * d.assist.sourceRate;
    if (onTick) onTick(clock.t);
    for (const d of engine.decks.values()) d.tick(clock.t);
    engine.updateClock(clock.t);
    for (const d of engine.decks.values()) d.syncTick(clock.t);
    if (clock.t >= (engine.nextPhase || 0)) { engine.nextPhase = clock.t + 0.5; for (const d of engine.decks.values()) d.phaseTick(clock.t); }
  }
}
