// Drives the real engine/deck.js + engine/timeshift.js with stubs. Fake node mimics
// SignalsmithStretch.schedule(): pops every map entry with output >= worklet currentTime.
import { Deck } from '../../../engine/deck.js';
import { Timeshift } from '../../../engine/timeshift.js';
import { MasterClock, lastBeatOut, phaseError } from '../../../engine/sync.js';

export class FakeNode {
  constructor(clock) { this.clock = clock; this.map = [{ active: false, input: 0, output: 0, rate: 1, loopStart: 0, loopEnd: 0 }]; this.log = []; }
  addBuffers() { return 0; }
  schedule(obj) {
    const wNow = this.clock.t + 0.003; // worklet slightly ahead of main thread
    while (this.map.length && this.map[this.map.length - 1].output >= wNow) this.map.pop();
    const latest = this.map[this.map.length - 1] || {};
    this.map.push({ ...latest, ...obj });
    this.log.push({ at: this.clock.t, ...obj });
    return Promise.resolve();
  }
  dropBuffers(t) { return Promise.resolve({ start: t, end: 0 }); }
  /** node's segment in effect for audio output at context time t */
  segAt(t) { let s = this.map[0]; for (const x of this.map) if (x.output <= t) s = x; return s; }
  /** input position the node is really rendering at output time t */
  posAt(t) { const s = this.segAt(t); return s.active ? s.input + s.rate * (t - s.output) : s.input; }
}

export function makeEngine(clock) {
  const engine = {
    ctx: { get currentTime() { return clock.t; }, sampleRate: 48000 },
    params: { 'buffer.capSec': 240, 'assist.on': true, 'bpm.range': 'AUTO', 'rec.format': 'wav' },
    clock: new MasterClock(), decks: new Map(), events: [],
    master: { setAssign() {}, removeDeck() {} },
    event(level, text, id) { this.events.push({ t: clock.t, level, text, id }); },
    broadcast() {}, broadcastWave() {}, wallNow: () => clock.t * 1000, ctxTimeAtWall: (w) => w / 1000, heardTime: () => clock.t,
    updateClock(now) {
      const a = this.clock.assigned != null ? this.decks.get(this.clock.assigned) : null;
      this.clock.update(now, a ? a.masterInfo(now) : null);
    },
    eject(id) { const d = this.decks.get(id); if (!d) return; this.decks.delete(id); this.clock.release(id); d.disposed = true; },
  };
  return engine;
}

export function fakeTempo({ bpm, t0 = 0.0, canBeat = true }) {
  const T = 60 / bpm;
  return {
    bpm, grid: { t0, T, bar1: null }, canBeat,
    /** retune the tracker in place, the way a tracker following a pitched-down master would */
    setBpm(v) { this.bpm = v; this.grid = { ...this.grid, T: 60 / v }; },
    get() { return { state: 'LOCKED', inBpm: this.bpm, conf: 0.9, mult: 1, tapped: false, grid: this.grid, canBeat: this.canBeat }; },
    sourceRateChanged(ratio) { this.bpm *= ratio; this.grid = { ...this.grid, T: this.grid.T / ratio }; },
    pushBatch() {}, tap() {}, multiply() {}, shiftGrid() {}, setBar1() {},
  };
}

export function makeDeck(engine, clock, { id = 2, slot = 2, bpm = 124, pitch = 0, liveEdge = 30, lat = 0.12,
  t0 = 0, range = 0.1, keyLock = true, syncMode = 'BEAT', canBeat = true, capSec = 240 } = {}) {
  const d = new Deck(engine, { id, slot, tabId: id * 10, stream: { getTracks: () => [], getAudioTracks: () => [] }, meta: { title: 't' + id },
    params: { pitch, range, keyLock, syncMode, fader: 1, xf: 'THRU', 'fx.type': 'ECHO', 'fx.beats': 0.5, 'fx.level': 0.5, 'fx.on': false } });
  const node = new FakeNode(clock);
  d.node = node;
  d.ts = new Timeshift(node, { sampleRate: 48000, latency: lat, outLatency: lat / 2, capSec });
  d.ts.liveEdge = liveEdge;
  d.tempo = fakeTempo({ bpm, t0, canBeat });
  d.grids.update(d.tempo.get().grid);
  d.analyser = { getFloatTimeDomainData() {} };
  d.meterBuf = new Float32Array(16);
  d.rack = { setClock() {}, tick() {}, setFx() {}, setFilter() {} };
  d.xfGain = { gain: { value: 1 } };
  d.recorder = { state: 'idle' };
  engine.decks.set(id, d);
  return d;
}

/** advance by dt in 1536-frame ticks, growing every deck's live edge in real time */
export function run(engine, clock, seconds, onTick) {
  const dt = 1536 / 48000;
  const end = clock.t + seconds;
  while (clock.t < end - 1e-9) {
    clock.t += dt;
    for (const d of engine.decks.values()) d.ts.liveEdge += dt * (d.assist ? d.assist.sourceRate : 1);
    if (onTick) onTick(clock.t);
    for (const d of engine.decks.values()) d.tick(clock.t);
    engine.updateClock(clock.t);
    for (const d of engine.decks.values()) d.syncTick(clock.t);
    if (clock.t >= (engine.nextPhase || 0)) { engine.nextPhase = clock.t + 0.5; for (const d of engine.decks.values()) d.phaseTick(clock.t); }
  }
}

/** Beat phase of the audio the NODE is really rendering at output time t, not the deck's model. */
export function trueBeatOut(d, t) {
  const p = d.node.posAt(t), seg = d.node.segAt(t), g = d.grids.at(p);
  if (!g || !seg.active || !(seg.rate > 0)) return null;
  return { lastBeat: lastBeatOut(g, p, seg.rate, t), period: g.T / seg.rate, p };
}

/** BPM of the audio the node is really rendering, or null when it is not playing. */
export function playedBpm(d, t) { const b = trueBeatOut(d, t); return b ? 60 / b.period : null; }

/** Phase error (ms) between the audio two decks are really rendering. */
export function pairErrMs(a, b, t) {
  const x = trueBeatOut(a, t), y = trueBeatOut(b, t);
  return (!x || !y) ? null : phaseError(x.lastBeat, x.period, y.lastBeat, y.period) * 1000;
}

/** Phase error (ms) between the audio a deck is really rendering and the master clock. */
export function clockErrMs(engine, d, t) {
  const x = trueBeatOut(d, t), mb = engine.clock.beat(t);
  return (!x || !mb) ? null : phaseError(x.lastBeat, x.period, mb.lastBeat, mb.period) * 1000;
}
