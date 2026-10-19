// engine/deck.js — one captured tab as a DJ deck.
//
// tab stream ─► MediaStreamSource ─► jds-deck-input ─(chunks, on the audio thread)─► stretch node (buffer mode)
//                                         ├─(live edge)─► Timeshift (drives the stretch node)
//                                         └─(ODF)─► DeckTempo ─► GridMap
// stretch ─► trim ─► EQ ─► FX rack (filter, gate/crush, flanger, echo/reverb sends) ─┬─► fader ─► xfGain ─► master bus
//                                                                                    └─► recorder (pre-fader, post-FX)
// All transport/tempo/phase changes are scheduled on the audio clock through Timeshift.
import { BPM_RANGES, PITCH_RANGES, validateAgentMessage } from '../shared/protocol.js';
import { DeckTempo, MANUAL_BPM, octaveFold } from './tempo.js';
import { Timeshift, SourceMap, GridMap, GUARD, LIVE_RESERVE } from './timeshift.js';
import { createIsolator, createTrim } from './eq.js';
import { createFxRack } from './fx.js';
import { Recorder } from './recorder.js';
import { glide } from './params.js';
import { syncRatio, lastBeatOut, phaseError, planCorrection, engineSemitones, assistStep, pickAutoMaster, MULT_MARGIN, PHASE_DEADBAND } from './sync.js';
import { OdfCore } from '../worklets/odf-core.js';

const OK = { ok: true };
const fail = (error) => ({ ok: false, error });
const NO_GRID = 'No beat grid yet. Wait for the deck to lock, or TAP the beat.';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const CAP_MARGIN = 4; // s of audio always kept behind a playing deck's playhead (covers small backward jumps)
const NO_TIME_UPDATES = 1e9; // s between the stretcher's 'time' messages: never
// The live edge is stale when the newest chunk heard of was made longer ago than this (chunks come every
// ~43 ms): the main thread is working through a backlog, and the reserve it computes is too low.
const EDGE_STALE = 0.25;
const DRY_NOTICE_EVERY = 30; // s: at most one 'audio ran dry' notice per deck in this long
// Player assist: rate match tolerance (steps are 0.25 %), how long the page has to confirm a rate
// before the ramp holds (a background tab Chrome throttles may answer late), how long before an
// unconfirmed rate counts as refused, how long assist stays off after the page refused it, and the
// keep-alive period (the agent lets go of the page after 3 s without a command).
const ASSIST_EPS = 1e-4, ASSIST_CONFIRM = 2, ASSIST_REFUSE = 5, ASSIST_OFF = 30, ASSIST_KEEPALIVE = 1;
const AUDIBLE = 0.003; // about -50 dBFS, as the input worklet's first audible sample
const END_PLAN = 0.6; // s: a resident deck plans its stop at the end of the track this close to it
// Search (nudge held on a paused deck): slow enough at first to place a cue, then doubling every
// SEARCH_DOUBLE s up to SEARCH_MAX (input s per s). Fine (Shift) is five times slower.
const SEARCH_V0 = 0.5, SEARCH_DOUBLE = 0.75, SEARCH_MAX = 16;
const SKIP_MAX = 0.06; // s: the largest capture gap a beat-locked deck jumps across; a bigger step is not a gap
const SKIP_LEAD = 0.05; // s: a gap jump is planned once it would land within this of soon(), a tick and a bit
const frac = (x) => x - Math.floor(x);

/** Input seconds a search held for h s has covered. */
function searchDistance(h, fine) {
  const k = fine ? 0.2 : 1, v0 = SEARCH_V0 * k, vmax = SEARCH_MAX * k, r = Math.LN2 / SEARCH_DOUBLE;
  const top = Math.log(vmax / v0) / r; // held this long, it is at full speed
  return (v0 / r) * (Math.exp(r * Math.min(h, top)) - 1) + vmax * Math.max(0, h - top);
}

export class Deck {
  constructor(engine, { id, slot, tabId, stream, meta, params, kind = 'live' }) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.sr = engine.ctx.sampleRate;
    this.id = id;
    this.slot = slot;
    this.tabId = tabId;
    this.stream = stream;
    this.meta = { title: '', url: '', favIconUrl: '', ...meta };
    this.params = { ...params };
    // 'live': a tab's capture. 'loading': a track on its way (inert but for eject). 'resident': the whole
    // track, decoded, in the stretcher's buffer: no capture, so none of the live-window machinery runs.
    this.kind = kind;
    this.duration = null; // s: a resident deck's track
    this.load = { state: kind === 'loading' ? 'loading' : 'ready', progress: kind === 'loading' ? 0 : 1, strategy: null, error: null, report: null };
    this.tempo = null;
    this.grids = new GridMap();
    this.src = new SourceMap();
    this.cue = 0;
    this.cueAuto = true;
    this.cueSnapped = false;
    this.firstAudible = null;
    this.wantPlay = false;
    this.previewing = false;
    this.hasPlayed = false;
    this.playingSince = Infinity;
    this.syncOn = false;
    this.outOfRange = false;
    this.syncMult = null;    // half/double multiplier in use, latched while the deck plays
    this.syncMaster = null;  // the deck it was chosen against
    this.phaseMs = null;
    this.beatLostNoted = false; // a BEAT-synced deck lost its grid: said once per SYNC press
    this.settleUntil = 0;
    this.nudge = 0;
    this.nudgeFactor = 1;
    this.roll = null;
    this.rollFrom = null;
    this.loop = null;
    this.search = null;  // a held search on a paused deck: {dir, fine, from, at}
    this.navKeep = null; // the latest navigation target {p, T}: kept buffered until it has landed
    this.starved = false;
    this.emergencyUntil = 0;
    this.edgeAt = null; // context time (s) the input worklet made the newest chunk we have heard of
    this.dropouts = { runs: 0, seconds: 0 }; // the stretcher read past its buffered audio ('dry')
    this.dryNoticeAt = -Infinity;
    this.dryUnnoticed = 0;
    // sourceRate is what the page confirmed (the source model); sent is the last rate commanded,
    // to the frame agent of the one audible element (agent). inLag: context time minus input
    // position (the input timeline runs on the audio clock), its smallest value seen.
    this.assist = {
      target: 1, sourceRate: 1, active: false, sent: 1, agent: null, seq: Math.floor(Math.random() * 1e9), okSeq: -1, inflight: [], sentAt: -Infinity, offUntil: 0,
      inLag: Infinity,
    };
    this.agents = new Map();
    this.loader = null; // a loading tab deck's Loader (engine/loader.js): its agents' tap messages go there
    this.pauseFought = false; // a frame's site kept pausing its player: warned once
    this.meter = { peak: 0, rms: 0, clipUntil: 0, clipFrame: Math.round(engine.ctx.currentTime * this.sr) }; // clips before this deck are not its own
    this.error = null;
    this.nextTrim = 0;
    this.capNotice = null; // latched buffer-cap notice: null | 'near' | 'full'
    this.nextAssist = 0;
    this.nextFxClock = 0;
    this.lastFxBpm = 0;
    this.crossingFor = null;
    this.crossingSeg = null;
    this.skips = new WeakSet(); // grid segments past a capture gap that the deck has dealt with
    this.skipAt = -Infinity;    // output time of its latest jump across one
    this.skipPlan = null;       // the jump planned and not yet landed: {seg, s, prevAt}
    this.wave = { tStart: null, hop: 0, data: new Uint8Array(0), n: 0 };
    this.disposed = false;
  }

  now() { return this.ctx.currentTime; }

  init() { return this.initLive(); }

  /** A live deck: the tab's capture feeds the stretcher through the input worklet. A loading deck has its chain already. */
  async initLive() {
    const ctx = this.ctx, e = this.engine;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.inputNode = new AudioWorkletNode(ctx, 'jds-deck-input', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { pipeId: this.id },
    });
    this.inputNode.port.onmessage = (ev) => this.onInput(ev.data);
    if (!this.ts) await this.build();
    else if (this.ts.liveEdge > 0) await this.dropHeld();
    // The input worklet hands its chunks to the stretcher on the audio thread, not through this (shared,
    // sometimes busy) main thread. Registered before the capture is connected, so every chunk goes that way.
    await withTimeout(this.stretch.attachInput(this.id), 4000, 'The time-stretcher did not take its input');
    this.kind = 'live';
    // Connect the capture last, so no chunk arrives before the Timeshift exists.
    this.source.connect(this.inputNode);
    this.inputNode.connect(e.silentSink);
    for (const t of this.stream.getAudioTracks()) t.addEventListener('ended', () => e.eject(this.id, `Deck ${this.slot}: the tab stopped sharing audio.`));
  }

  /** The stretcher and everything after it (Timeshift, trim, EQ, FX, fader, recorder): every kind of deck has one. */
  async build() {
    const ctx = this.ctx, e = this.engine;
    this.stretch = await e.createStretch();
    // Timeshift models the playhead itself: the stretcher's 10/s 'time' updates would only wake the main thread.
    this.stretch.setUpdateInterval(NO_TIME_UPDATES);
    this.stretch.port.addEventListener('message', (ev) => { if (Array.isArray(ev.data) && ev.data[0] === 'dry') this.onDry(ev.data[1]); });
    const lat = await withTimeout(this.stretch.latency(), 4000, 'The time-stretcher did not report its latency');
    this.ts = new Timeshift(this.stretch, { sampleRate: this.sr, latency: lat, outLatency: lat / 2, capSec: e.params['buffer.capSec'] });
    this.trimNode = createTrim(ctx);
    this.eq = createIsolator(ctx);
    this.rack = createFxRack(ctx);
    this.fader = ctx.createGain();
    this.xfGain = ctx.createGain();
    this.stretch.connect(this.trimNode.input);
    this.trimNode.output.connect(this.eq.input);
    this.eq.output.connect(this.rack.input);
    this.rack.output.connect(this.fader);
    this.fader.connect(this.xfGain);
    e.master.meterIn(this.slot, this.fader);
    this.xfGain.connect(e.master.bus);
    this.recorder = new Recorder(ctx, this.rack.output, {
      format: e.params['rec.format'], who: `D${this.slot}`, title: () => this.recTitle(), sink: e.silentSink,
      deliver: (blob, name) => e.deliver(blob, name), onChange: () => {}, onError: (msg) => e.event('error', msg, this.id),
    });
    for (const [k, v] of Object.entries(this.params)) this.applyParam(k, v);
  }

  /** Recordings are named after the track, or after its tab while that has no title. */
  recTitle() { return this.meta.title || (this.tabId == null ? `Deck ${this.slot}` : `Tab ${this.tabId}`); }

  // ------------------------------------------------------------------ resident
  /**
   * A resident deck: the whole decoded track, pushed to the stretcher in one addBuffers call (transferred:
   * the caller's arrays are empty afterwards). No capture and no input worklet: the track runs from
   * input 0 to its duration, where the deck stops.
   */
  async initResident({ L, R }) {
    if (!this.ts) await this.build();
    this.noteFirstAudible(L, R, 0);
    this.ts.hold(L, R);
    this.becomeResident();
  }

  /** Slow paths: more of the track, decoded, while the deck is loading. A loading deck does not tick, so nothing is trimmed. */
  appendResident({ L, R }) {
    if (this.kind !== 'loading') throw new Error('Only a loading deck takes more of its track.');
    const at = this.ts.liveEdge;
    this.noteFirstAudible(L, R, at);
    this.ts.hold(L, R);
  }

  /** Slow paths: the whole track has arrived. */
  finishResident({ duration } = {}) {
    if (this.kind !== 'loading') throw new Error('Only a loading deck can finish loading.');
    this.becomeResident(duration);
  }

  becomeResident(duration) {
    const ts = this.ts;
    if (duration > 0 && duration < ts.liveEdge) ts.liveEdge = duration;
    this.kind = 'resident';
    ts.whole = true;
    this.duration = ts.liveEdge;
    // The tempo starts unlocked, for TAP and the grid tools; whole-track analysis seeds it when there is one.
    if (!this.tempo) {
      const [lo, hi] = BPM_RANGES[this.engine.params['bpm.range']] || BPM_RANGES.AUTO;
      this.tempo = new DeckTempo({ sampleRate: this.sr, fps: new OdfCore(this.sr, () => {}).fps, lo, hi });
    }
    this.setLoad({ state: 'ready', progress: 1, strategy: null, error: null });
    if (this.cueAuto && !this.hasPlayed) this.setCue(this.firstAudible ?? 0);
  }

  /**
   * The automatic cue moves, once, to the first beat of grid g at the track's first sound. A whole track whose first
   * beat is within one onset frame of its start (the grid is read to about a frame) is cued at the start itself, so
   * its first attack is whole.
   */
  snapAutoCue(g) {
    if (!g || !this.cueAuto || this.cueSnapped || this.hasPlayed || this.firstAudible == null) return;
    this.cueSnapped = true;
    const k = Math.ceil((this.firstAudible - 0.05 - g.t0) / g.T), b = g.t0 + k * g.T;
    this.setCue(this.ts.whole && b < 1 / this.tempo.fps ? 0 : b);
  }

  noteFirstAudible(L, R, at) {
    if (this.firstAudible != null) return;
    for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > AUDIBLE || Math.abs(R[i]) > AUDIBLE) { this.firstAudible = at + i / this.sr; return; }
  }

  /** A loading deck going live after part of its track arrived: drop that, so the capture starts the input timeline at 0. */
  async dropHeld() {
    const old = this.ts;
    await withTimeout(this.stretch.dropBuffers(), 1500, 'The time-stretcher did not let go of its buffer').catch(() => {});
    this.ts = new Timeshift(this.stretch, { sampleRate: this.sr, latency: old.lat, outLatency: old.outLat, capSec: old.capSec });
    this.firstAudible = null;
    this.cue = 0;
  }

  /** What the snapshot says about a load. Fields not given are kept; progress is 0..1; token: a file or link load's mark. */
  setLoad({ state, progress, strategy, error, report, token } = {}) {
    const l = this.load, keep = (v, old) => (v === undefined ? old : v);
    this.load = {
      state: keep(state, l.state), progress: clamp(Number(keep(progress, l.progress)) || 0, 0, 1),
      strategy: keep(strategy, l.strategy), error: keep(error, l.error), report: keep(report, l.report),
    };
    if (keep(token, l.token) != null) this.load.token = keep(token, l.token);
  }

  // ------------------------------------------------------------------ input
  onInput(m) {
    if (!m || this.disposed) return;
    if (m.t === 'init') {
      const [lo, hi] = BPM_RANGES[this.engine.params['bpm.range']] || BPM_RANGES.AUTO;
      this.tempo = new DeckTempo({ sampleRate: this.sr, fps: m.fps, lo, hi });
    } else if (m.t === 'chunk') {
      if (m.piped) this.ts.extend(m.n); else this.ts.append(m.L, m.R);
      if (m.at != null) this.edgeAt = m.at / this.sr;
      if (this.firstAudible == null && m.firstAbove >= 0) {
        this.firstAudible = (m.start + m.firstAbove) / this.sr;
        if (this.cueAuto && !this.hasPlayed) this.setCue(this.firstAudible);
      }
    } else if (m.t === 'odf' && this.tempo) {
      this.tempo.pushBatch(m);
      this.snapAutoCue(this.followTempo().grid);
      const tStart = m.t0 / this.sr, hop = m.spf / this.sr;
      this.appendWave(tStart, hop, m.bands);
      this.engine.broadcastWave(this, tStart, hop, m.bands);
    }
  }

  /** The stretcher read past its buffered audio for `seconds` (its input came too late). Told at most every 30 s. */
  onDry(seconds) {
    if (this.disposed || !(seconds > 0) || this.kind === 'resident') return; // a whole track never waits for its input
    this.dropouts.runs++;
    this.dropouts.seconds += seconds;
    this.dryUnnoticed += seconds;
    const now = this.now();
    if (now < this.dryNoticeAt + DRY_NOTICE_EVERY) return;
    this.dryNoticeAt = now;
    this.engine.event('warn', `Deck ${this.slot}: audio ran dry for ${Math.round(this.dryUnnoticed * 1000)} ms (the browser was busy).`, this.id);
    this.dryUnnoticed = 0;
  }

  appendWave(tStart, hop, bands) {
    const w = this.wave;
    if (w.tStart == null) { w.tStart = tStart; w.hop = hop; }
    const i0 = Math.round((tStart - w.tStart) / w.hop);
    const need = (i0 + bands.length / 3) * 3;
    if (need > w.data.length) { const n = new Uint8Array(Math.max(need, w.data.length * 2, 4096)); n.set(w.data); w.data = n; }
    w.data.set(bands, i0 * 3);
    w.n = Math.max(w.n, need / 3);
  }

  waveBacklog() { return this.waveSince(-Infinity); }

  /** Waveform message from input time t (no earlier than historyStart) to the latest hop, or null. */
  waveSince(t) {
    const w = this.wave;
    if (w.tStart == null || !w.n) return null;
    const from = Math.max(0, Math.floor((this.ts.historyStart - w.tStart) / w.hop), Math.round((t - w.tStart) / w.hop));
    if (from >= w.n) return null;
    return { t: 'wave', deck: this.id, tStart: w.tStart + from * w.hop, hop: w.hop, data: Array.from(w.data.subarray(from * 3, w.n * 3)) };
  }

  /** Input time just after the latest waveform hop (-Infinity before the first). */
  waveEnd() { const w = this.wave; return w.tStart == null ? -Infinity : w.tStart + w.n * w.hop; }

  /** Forget the waveform before input time t (audio no longer buffered). */
  compactWave(t) {
    const w = this.wave;
    if (w.tStart == null) return;
    const k = Math.min(w.n, Math.floor((t - w.tStart) / w.hop));
    if (k <= 0) return;
    w.data.copyWithin(0, k * 3, w.n * 3);
    w.data.fill(0, (w.n - k) * 3, w.n * 3);
    w.tStart += k * w.hop;
    w.n -= k;
  }

  // ------------------------------------------------------------------ tempo
  /** Bring the grid map up to date with the tracker (live grid, track changes). */
  followTempo() {
    const g = this.tempo.get();
    this.grids.update(g.grid, g.track, (x) => this.src.rateAt(x));
    return g;
  }

  /**
   * BPM of the audio at input position p (default: the playhead), so it follows what the DJ
   * hears: the grid there, at the source rate that audio was captured at. Lock state is the
   * tracker's, at the live edge.
   */
  tempoInfo(p = this.ts ? this.ts.posAt(this.now()) : 0) {
    const g = this.tempo ? this.tempo.get() : null;
    const grid = this.grids.at(p);
    let native = null;
    if (grid) native = 60 / grid.T / this.src.rateAt(p);
    else if (g && g.inBpm) native = g.inBpm / this.assist.sourceRate;
    return { g, native, out: native ? native * (1 + this.params.pitch) : null };
  }
  /**
   * Whether the deck can beat-match on the grid of the audio at input position p (the playhead
   * by default): the grid the DJ is hearing, not the tracker's verdict on audio arriving at the
   * live edge, which may be a quiet passage or a new track they have not reached yet.
   */
  canBeat(p) {
    if (!this.tempo) return false;
    const at = p === undefined ? this.heardPos() : p;
    const seg = this.grids.seg(at);
    if (!seg) return !!this.tempo.get().canBeat; // no grid map yet: the live grid is all there is
    return !!seg.grid && this.tempo.canBeatAt(Math.round(at * this.sr));
  }

  desiredRate(p) { return ((1 + this.params.pitch) / this.src.rateAt(p)) * this.nudgeFactor; }
  effRate(p) { const d = this.desiredRate(p); return this.starved ? Math.min(1, d) : d; }
  /** Vinyl mode (KEY off) follows the engine rate actually applied: starve clamp and nudge included. */
  semis(p) { return engineSemitones(this.params.keyLock, this.src.rateAt(p), this.effRate(p)); }

  /** Schedule a change at T, always restating rate/semitones so a pending bend can never stick. */
  sched(T, fields) {
    const p = fields.input !== undefined ? fields.input : this.ts.posAt(T);
    return this.ts.change(this.now(), T, { rate: this.effRate(p), semitones: this.semis(p), ...fields });
  }

  applyRate() {
    if (!this.ts || !this.wantPlay) return;
    this.sched(this.ts.soon(this.now()), {});
  }

  // ------------------------------------------------------------------ transport
  setCue(x) {
    this.cue = this.ts.clampInput(x);
    if (!this.wantPlay) this.ts.change(this.now(), this.ts.soon(this.now()), { active: false, input: this.cue });
  }

  snapToGrid(p) {
    const g = this.grids.at(p);
    if (!g || !this.canBeat()) return p;
    const k = Math.round((p - g.t0) / g.T), b = g.t0 + k * g.T;
    return Math.abs(b - p) <= g.T / 4 ? b : p;
  }

  /** Shift a start position so the deck's beats land on the master clock's beats at time T. */
  alignForStart(p, T) {
    if (this.params.syncMode !== 'BEAT' || !this.canBeat()) return p;
    // The master sets the phase while the clock follows it; on a free clock it kept running
    // without the master, so the master drops back in on it like any other deck.
    if (!(this.isMaster() ? this.engine.clock.state().mode === 'free' : this.syncOn)) return p;
    const mb = this.engine.clock.beat(T), g = this.grids.at(p);
    if (!mb || !g || !(g.T > 0)) return p;
    const rate = this.effRate(p);
    const e = phaseError(lastBeatOut(g, p, rate, T), g.T / rate, mb.lastBeat, mb.period);
    // Outside what can be played (a deck cued at its first beat), the start would be clamped off the
    // beat: a whole beat later (or earlier) keeps the phase, as seek() has it.
    const lo = this.ts.clampInput(-Infinity), hi = this.ts.clampInput(Infinity);
    let q = p + e * rate;
    while (q < lo) q += g.T;
    while (q > hi) q -= g.T;
    return q >= lo ? q : p + e * rate;
  }

  /** A resident deck stopped at the end of its track at output time t. */
  parkedAtEnd(t) { return !this.ts.playingAt(t) && this.ts.posAt(t) >= this.duration - 0.5 / this.sr; }

  startAt(T, p) {
    // A resident deck stopped at the end of its track stays there until it is moved, wherever a phase-matched
    // start would begin (alignForStart steps a beat back into the track).
    if (this.kind === 'resident' && (p >= this.duration - 0.5 / this.sr || this.parkedAtEnd(T))) return;
    const input = this.ts.clampInput(p);
    this.ts.change(this.now(), T, { active: true, input, rate: this.effRate(input), semitones: this.semis(input) });
    this.wantPlay = true;
    // A search is a paused deck's: PLAY ends it, and the button still held does nothing (phase lock runs) until let go.
    if (this.search) { this.search = null; this.nudge = 0; this.nudgeFactor = 1; }
    this.hasPlayed = true;
    this.playingSince = T;
    this.settleUntil = T + 0.5;
  }

  isMaster() { return this.engine.clock.assigned === this.id; }

  audible() {
    return this.wantPlay && this.params.fader > 0.01 && this.xfGain.gain.value > 0.01;
  }

  async act(a, arg = {}) {
    if (a === 'eject') { this.engine.eject(this.id); return OK; }
    if (a === 'loadCancel') return this.engine.loadCancel(this.id);
    if (this.kind === 'loading') return fail('The deck is still loading.');
    if (!this.ts) return fail('The deck is still starting.');
    const now = this.now(), T = this.ts.soon(now);
    switch (a) {
      case 'play': {
        if (this.previewing) { this.previewing = false; return OK; }
        if (this.wantPlay) return OK;
        this.startAt(T, this.alignForStart(this.ts.posAt(T), T));
        return OK;
      }
      // Decided here, not from the UI's snapshot; PLAY during a CUE preview keeps playing.
      case 'playToggle': return this.act(this.wantPlay && !this.previewing ? 'pause' : 'play');
      case 'pause':
        if (!this.wantPlay) return OK;
        this.ts.change(now, T, { active: false });
        this.wantPlay = false; this.previewing = false; this.playingSince = Infinity;
        return OK;
      case 'syncPlay': {
        if (this.wantPlay && !this.previewing) return OK;
        const clock = this.engine.clock;
        // SYNC▶ is SYNC then PLAY: with no master at all, pick one the way the SYNC button does,
        // and say why when it cannot, rather than degrading to a silent unsynced PLAY.
        if (clock.assigned == null && clock.state().mode === 'none') {
          const r = this.actSync(true, now);
          if (!r.ok) return r;
        }
        let start = T;
        // A free clock keeps the phase the master left behind, so the master itself drops back in on it.
        const mb = !this.isMaster() || clock.state().mode === 'free' ? clock.beat(T) : null;
        if (mb) { start = mb.lastBeat + mb.period; while (start < T) start += mb.period; }
        const wasSync = this.syncOn;
        // A confident grid is what phase lock needs, so BEAT mode alone demands it — as actSync has it.
        if (mb && !this.isMaster() && (this.params.syncMode !== 'BEAT' || this.canBeat())) this.syncOn = true;
        if (!wasSync && this.syncOn) { this.syncMult = null; this.syncTick(now); } // tempo first: the start and its alignment use the synced rate
        // From the cue only when the playhead sits there (fresh, CUE-returned, previewing); else resume in place.
        const p = this.ts.posAt(start);
        const from = this.previewing || Math.abs(p - this.cue) < 0.02 ? this.snapToGrid(this.cue) : mb ? this.snapToGrid(p) : p;
        this.startAt(start, this.alignForStart(from, start));
        this.previewing = false;
        return OK;
      }
      case 'cueDown': {
        if (this.wantPlay && !this.previewing) {
          this.ts.change(now, T, { active: false, input: this.cue });
          this.wantPlay = false; this.playingSince = Infinity;
          return OK;
        }
        const p = this.ts.posAt(T);
        if (Math.abs(p - this.cue) < 0.02) { this.startAt(T, this.cue); this.previewing = true; return OK; }
        this.cueAuto = false;
        this.setCue(this.snapToGrid(p));
        return OK;
      }
      case 'cueUp':
        if (this.previewing) {
          this.ts.change(now, T, { active: false, input: this.cue });
          this.wantPlay = false; this.previewing = false; this.playingSince = Infinity;
        }
        return OK;
      case 'live': {
        if (this.kind === 'resident') return fail('A whole-track deck has no live edge.');
        let target = this.ts.clampInput(this.ts.liveEdge - this.ts.lat - LIVE_RESERVE);
        if (this.wantPlay) {
          // Playing on its beat grid, the deck jumps whole beats (landing up to a beat further back), so it keeps its
          // phase: a synced deck has nothing to bend back into line out of the small reserve LIVE leaves it. The beats
          // are counted on the grid where it lands (audio captured at an assist rate has them closer together).
          const p = this.ts.posAt(T), g = this.grids.at(p), to = this.grids.at(target);
          if (g && g.T > 0 && to && to.T > 0 && this.canBeat(p)) {
            const ph = frac((p - g.t0) / g.T);
            target = this.ts.clampInput(to.t0 + (Math.floor((target - to.t0) / to.T - ph) + ph) * to.T);
          }
          this.sched(T, { input: target });
        } else this.ts.change(now, T, { active: false, input: target });
        return OK;
      }
      case 'sync': return this.actSync(arg.on, now);
      case 'master':
        if (this.isMaster()) this.engine.clock.release(this.id);
        else { this.engine.clock.follow(this.id); this.syncOn = false; this.phaseMs = null; }
        return OK;
      case 'nudge':
        if (!arg.dir && !this.nudge) return OK; // nothing held (PLAY ended its search): letting go changes nothing
        // Paused, the nudge buttons search instead: the playhead moves while held (searchTick).
        this.search = !this.wantPlay && arg.dir ? { dir: arg.dir, fine: arg.fine, from: this.ts.posAt(this.landAt(now)), at: now } : null;
        if (this.search) this.cueAuto = false;
        this.nudge = arg.dir;
        // amt: a jog bend (waveform drag), sized by the drag; else the fixed fine/coarse steps.
        this.nudgeFactor = arg.dir && !this.search ? 1 + arg.dir * (arg.amt ?? (arg.fine ? 0.01 : 0.04)) : 1;
        if (this.wantPlay) this.sched(this.landAt(now), {});
        this.settleUntil = now + (arg.dir ? 1e9 : 1);
        return OK;
      case 'seek': return this.seek(arg.pos, arg.quantize, now);
      case 'beatJump': return this.beatJump(arg.beats, now);
      case 'tap': {
        if (!this.tempo) return fail('Waiting for audio.');
        const t = this.engine.ctxTimeAtWall(arg.wallMs ?? this.engine.wallNow());
        // A tap marks a position in the deck's input. A standing playhead stamps every tap at
        // the same input frame, so say so rather than take taps that cannot be timed.
        if (!this.ts.playingAt(t)) return fail('Start the deck to tap its tempo.');
        this.tapAt(this.ts.posAt(t));
        return OK;
      }
      case 'mult':
        if (!this.tempo) return fail('Waiting for audio.');
        return this.multiplyAt(this.heardPos(), arg.factor) ? OK : fail('½× / 2× would take the beat grid outside the BPM range it can hold.');
      case 'gridShift':
        if (!this.tempo) return fail('Waiting for audio.');
        return this.shiftAt(this.heardPos(), arg) ? OK : fail(NO_GRID);
      case 'tap1':
        if (!this.tempo) return fail('Waiting for audio.');
        return this.bar1At(arg.t ?? this.heardPos()) ? OK : fail(NO_GRID);
      case 'setBpm': return this.setBpm(arg.bpm);
      case 'setNativeBpm':
        if (!this.tempo) return fail('Waiting for audio.');
        return this.setNativeBpm(this.heardPos(), arg.bpm);
      case 'rollStart': return this.rollStart(arg.beats, now, T);
      case 'rollEnd': return this.rollEnd(now, T);
      case 'recStart':
        try { this.recorder.start(this.engine.params['rec.format']); return OK; } catch (err) { return fail(`Could not start recording: ${err.message}`); }
      case 'recStop': this.recorder.stop(); return OK;
      case 'recordWhole': return this.engine.recordWhole(this.id);
      case 'clipReset': this.meter.clipUntil = 0; return OK;
      default: return fail(`Unknown action ${a}`);
    }
  }

  actSync(on, now) {
    const want = on == null ? !this.syncOn : on;
    if (!want) { this.syncOn = false; this.phaseMs = null; this.syncMult = null; return OK; }
    if (this.isMaster()) return fail('This deck is the master. Make another deck master to sync this one.');
    if (!this.tempoInfo().native) return fail('No BPM yet. Wait for the deck to lock, or TAP the tempo.');
    const clock = this.engine.clock;
    let pick = null;
    // Auto-pick only when there is neither a deck assigned nor a clock already running: a master
    // the DJ assigned by hand is not stolen just because it has not published a tempo yet.
    if (clock.assigned == null && clock.state().mode === 'none') {
      const others = [...this.engine.decks.values()].filter((d) => d !== this).map((d) => ({
        id: d.id, playing: d.wantPlay && !!d.tempoInfo().native, canBeat: d.canBeat(), conf: d.tempo ? d.tempo.get().conf : 0, since: d.playingSince,
      }));
      pick = pickAutoMaster(others);
      if (pick == null) {
        clock.follow(this.id);
        this.engine.event('info', `Deck ${this.slot} is now the tempo master.`);
        return OK;
      }
    }
    // No false SYNC: BEAT mode locks phase, which needs this deck's own confident beat grid.
    if (this.params.syncMode === 'BEAT' && !this.canBeat()) return fail('Beat grid not confident yet: TAP the beat, or switch SYNC to TEMPO.');
    if (pick != null) { clock.follow(pick); this.engine.updateClock(now); }
    this.syncOn = true;
    this.beatLostNoted = false;
    this.settleUntil = 0;
    this.syncMult = null; // a SYNC press re-chooses the half/double octave
    this.syncTick(now);
    return OK;
  }

  rollStart(beats, now, T) {
    if (!this.wantPlay) return fail('Rolls work while the deck is playing.');
    const p = this.ts.posAt(T), g = this.grids.at(p);
    const L = g ? beats * g.T : beats * 0.5;
    let start = g ? g.t0 + Math.floor((p - g.t0) / L) * L : p;
    if (start + L > this.ts.liveEdge - this.ts.lat - 0.05) start -= L;
    start = Math.max(start, this.ts.historyStart + 0.01);
    this.rollFrom = this.rollFrom || { p, T, rate: this.ts.rateAt(T) };
    this.loop = { start, end: start + L };
    this.roll = beats;
    this.sched(T, { loopStart: start, loopEnd: start + L });
    return OK;
  }

  rollEnd(now, T) {
    if (!this.rollFrom) return OK;
    const slip = this.slipAt(T);
    // A whole track that carried on past its end beneath the roll has ended: it lands stopped there.
    if (this.kind === 'resident' && slip >= this.duration) this.sched(T, { active: false, input: this.duration, loopStart: 0, loopEnd: 0 });
    else this.sched(T, { input: this.ts.clampInput(slip), loopStart: 0, loopEnd: 0 });
    this.roll = null; this.loop = null; this.rollFrom = null;
    this.settleUntil = T + 0.3;
    return OK;
  }

  /** The deck page went away mid-press: end what only lasts while held (roll, nudge, CUE preview). */
  async releaseHolds() {
    if (!this.ts || this.disposed) return;
    if (this.rollFrom) await this.act('rollEnd');
    if (this.nudge) await this.act('nudge', { dir: 0 });
    if (this.previewing) await this.act('cueUp');
  }

  // ------------------------------------------------------------------ navigation
  // Seek, beat jump and search move the deck's own playhead within what it has buffered
  // (historyStart to liveEdge), so the DJ never has to move the source tab's player. A deck whose
  // whole track is buffered reaches all of it the same way.

  /**
   * Output time a navigation change asked for now lands at. A paused deck is silent: at once. A
   * playing one as soon as the stretcher lands it exactly (Timeshift.asap), or with the change
   * already on its way if that lands sooner, so a drag's stream of seeks (or a jog's of bends) is
   * heard every ~50 ms instead of each one pushing the last out until the hand stops. A planned
   * start (playing) or pause (paused) keeps its time: change() folds the jump into it (navFields).
   */
  landAt(now) {
    const ts = this.ts;
    let T = now;
    if (this.wantPlay) { T = ts.asap(now); const pend = ts.pendingUntil(); if (pend > now) T = Math.min(T, pend); }
    const planned = ts.planned(now, this.wantPlay ? true : undefined);
    return planned ? Math.max(T, planned.output) : T;
  }

  /**
   * A jump's fields. A playing deck's says so, so that change() folds it into a planned start or an
   * earlier jump but never into a planned stop (a whole track's stop at its end, replanned after it).
   */
  navFields(input) { return this.wantPlay ? { input, active: true } : { input }; }

  /** Input position the deck would be at at output time t: under a roll, where the track carries on (the slip). */
  slipAt(t) {
    const r = this.rollFrom;
    return r ? r.p + r.rate * (t - r.T) : this.ts.posAt(t);
  }

  /**
   * Where navigation may put the playhead: what clampInput allows (the buffer less its margins). A
   * playing deck whose audio still arrives at the live edge keeps LIVE's reserve there, so a jump
   * there does not starve it; a whole track (Timeshift.whole) can be played to its end.
   */
  navRange() {
    const ts = this.ts, lo = ts.clampInput(-Infinity);
    let hi = ts.clampInput(Infinity);
    if (this.wantPlay && !ts.whole) hi = Math.max(lo, Math.min(hi, ts.liveEdge - ts.lat - LIVE_RESERVE));
    return { lo, hi };
  }

  /** Why the playhead cannot go to `target` from `at`: how much is buffered on that side. */
  notBuffered(target, at, { lo, hi }) {
    const s = target < at ? Math.max(0, at - lo) : Math.max(0, hi - at);
    return `Only ${s < 10 ? s.toFixed(1) : Math.round(s)} s buffered ${target < at ? 'behind' : 'ahead of'} the playhead.`;
  }

  /** Playing in BEAT sync: a follower phase-locked to the master, or the master BEAT followers lock to. */
  beatLocked() {
    if (!this.wantPlay || this.previewing) return false;
    if (this.isMaster()) return [...this.engine.decks.values()].some((d) => d !== this && d.syncOn && d.params.syncMode === 'BEAT');
    return this.syncOn && this.params.syncMode === 'BEAT';
  }

  /**
   * Where a jump to `pos` landing at T goes to keep the beat phase. A follower SYNCed in BEAT lines
   * up with the master clock there, as a start does (alignForStart). Any other playing deck moves
   * whole beats from `at`, where it would have been at T: its own phase is kept (and a master's is
   * the clock its followers keep). A paused deck lands on the nearest beat. No confident grid at
   * pos: no phase to keep.
   */
  phaseLand(pos, T, at) {
    const g = this.grids.at(pos);
    if (!g || !this.canBeat(pos)) return pos;
    if (this.beatLocked() && !this.isMaster()) return this.alignForStart(pos, T);
    const gc = this.wantPlay ? this.grids.at(at) : null;
    const ph = gc ? frac((at - gc.t0) / gc.T) : 0;
    return g.t0 + (Math.round((pos - g.t0) / g.T - ph) + ph) * g.T;
  }

  /**
   * Move the playhead to input position `pos`. Inside the buffer it is clamped to navRange();
   * outside it, refused. Phase is kept (phaseLand) when the deck plays in BEAT sync or `quantize`
   * asks for it; whole beats at a time, so a landing past the margins steps back a beat.
   */
  seek(pos, quantize, now) {
    const ts = this.ts, range = this.navRange();
    if (pos < ts.historyStart || pos > ts.liveEdge) return fail(this.notBuffered(pos, this.slipAt(now), range));
    const T = this.landAt(now);
    let target = clamp(pos, range.lo, range.hi);
    if (quantize || this.beatLocked()) {
      let p = this.phaseLand(target, T, this.slipAt(T));
      const g = this.grids.at(p);
      if (g) { while (p > range.hi) p -= g.T; while (p < range.lo) p += g.T; }
      if (p >= range.lo && p <= range.hi) target = p; // a buffer shorter than a beat: as asked
    }
    return this.jumpTo(target, T);
  }

  /** Move ±beats along the grid at the playhead, keeping phase. Past the buffer: refused, never clamped off the beat. */
  beatJump(beats, now) {
    const T = this.landAt(now), at = this.slipAt(T), g = this.grids.at(at);
    if (!g) return fail(NO_GRID);
    const range = this.navRange();
    let target = at + beats * g.T;
    // Another grid there (the next track, an assist step), or SYNCed: land on the beat that keeps phase.
    if (this.grids.seg(target) !== this.grids.seg(at) || this.beatLocked()) target = this.phaseLand(target, T, at);
    if (target < range.lo || target > range.hi) return fail(this.notBuffered(target, this.slipAt(now), range));
    return this.jumpTo(target, T);
  }

  /**
   * Land a navigation jump at T. Under a roll it moves the slip, where the track carries on and the
   * release lands: the roll is the DJ's held pad, the jump is on the track beneath it, and moving
   * the slip honours both (ending the roll would cut a pad still held down).
   */
  jumpTo(target, T) {
    this.cueAuto = false; // the DJ has placed the playhead: the automatic cue no longer pulls it back
    this.navKeep = { p: target, T };
    if (this.rollFrom) { this.rollFrom = { ...this.rollFrom, p: target, T }; return OK; }
    this.sched(T, this.navFields(target));
    if (this.wantPlay) this.settleUntil = Math.max(this.settleUntil, T + 0.3);
    return OK;
  }

  /** A held search on a paused deck: the playhead goes where the hold has taken it so far. */
  searchTick(now) {
    const s = this.search, { lo, hi } = this.navRange();
    const p = clamp(s.from + s.dir * searchDistance(now - s.at, s.fine), lo, hi);
    if (Math.abs(p - this.ts.posAt(this.landAt(now))) > 1e-9) this.sched(now, { input: p });
  }

  // ------------------------------------------------------------------ manual grid tools
  // A correction acts on what the DJ hears: every grid segment of the track at the heard position
  // (assist steps split a track's grid), plus the tracker when it is still on that track. A track
  // the tracker has already left (the tab moved on) is corrected in the grid map only.

  heardPos() { return this.ts.posAt(this.engine.heardTime()); }

  followsTrackAt(p) { const n = this.grids.trackAt(p); return n == null || n === this.tempo.track.n; }

  /** @returns false (so act() can say why) when there is no grid at p to move. */
  shiftAt(p, { beats = 0, ms = 0 }) {
    if (!this.grids.at(p)) return false;
    if (this.followsTrackAt(p)) this.tempo.shiftGrid({ beats, ms });
    this.grids.editTrack(this.grids.trackAt(p), (g) => ({ ...g, t0: g.t0 + beats * g.T + ms / 1000 }));
    this.followTempo();
    return true;
  }

  /** @returns false when the tracker, or the manual BPM bounds, refuse the new grid. */
  multiplyAt(p, factor) {
    const g = this.grids.at(p);
    if (this.followsTrackAt(p)) { if (!this.tempo.multiply(factor)) return false; }
    else if (!g || (60 * factor) / g.T < MANUAL_BPM[0] || (60 * factor) / g.T > MANUAL_BPM[1]) return false;
    this.grids.editTrack(this.grids.trackAt(p), (x) => ({ ...x, T: x.T / factor }));
    this.followTempo();
    this.syncMult = null; // as for a typed tempo: a synced deck chooses its octave of the master again
    return true;
  }

  /** @returns false when there is no grid at p to mark the downbeat on. */
  bar1At(p) {
    const g = this.grids.at(p);
    if (!g) return false;
    const b = g.t0 + Math.round((p - g.t0) / g.T) * g.T;
    if (this.followsTrackAt(p)) this.tempo.setBar1(Math.round(b * this.sr), false);
    this.grids.editTrack(this.grids.trackAt(p), (x) => ({ ...x, bar1: b }));
    this.followTempo();
    return true;
  }

  /**
   * A manual grid {t0, T} (a TAP, a typed tempo) for the audio at p. A whole-track analysis's pieces (a
   * mix, a drummer who drifts) each keep their own tempo: every piece of the track is scaled by the new
   * period over the old one at p, as ½× / 2× scale them, and the piece at p takes the grid. Any other
   * grid is carried across its track at each source rate.
   */
  regridAt(p, grid) {
    const seg = this.grids.seg(p);
    if (!this.tempo.seeded || !seg || !seg.grid) { this.grids.retime(p, grid, (x) => this.src.rateAt(x)); return; }
    const k = seg.grid.T / grid.T;
    this.grids.editTrack(seg.track, (x) => ({ ...x, T: x.T / k }));
    seg.grid = { ...seg.grid, t0: grid.t0, T: grid.T };
  }

  /** TAP at heard input position p: the tapped grid holds there, and is carried across its track (regridAt). */
  tapAt(p) {
    const fit = this.tempo.tapFit(Math.round(p * this.sr));
    if (!fit) return;
    this.regridAt(p, { t0: fit.t0 / this.sr, T: fit.T / this.sr });
    if (this.followsTrackAt(p)) {
      const segs = this.grids.segs, live = segs.length ? segs[segs.length - 1].grid : null;
      this.tempo.applyTap(live
        ? { t0: live.t0 * this.sr, T: live.T * this.sr }
        : { t0: fit.t0, T: (fit.T * this.src.rateAt(p)) / this.assist.sourceRate });
    }
    this.followTempo();
  }

  /** New BPM range: the tracker refolds its tempo; older tracks still in the grid map refold by their own octave. */
  setRange(lo, hi) {
    if (!this.tempo) return;
    const f = this.tempo.setRange(lo, hi), done = new Set();
    for (const s of this.grids.segs) {
      if (!s.grid || done.has(s.track)) continue;
      done.add(s.track);
      const k = s.track === this.tempo.track.n ? f : octaveFold(60 / s.grid.T, lo, hi);
      if (k !== 1) this.grids.editTrack(s.track, (g) => ({ ...g, T: g.T / k }));
    }
    this.followTempo();
  }

  // ------------------------------------------------------------------ typed tempos
  /**
   * Play at `bpm` as heard at the playhead. A hand-moved tempo, so it goes the fader's way (SYNC
   * off); a pitch range too narrow for it is widened to the smallest that reaches it.
   */
  setBpm(bpm) {
    const native = this.tempoInfo().native, f = (v) => v.toFixed(1);
    if (!native) return fail('No BPM yet. Wait for the deck to lock, or TAP the tempo.');
    const pitch = bpm / native - 1, need = Math.abs(pitch) - 1e-9;
    if (need > this.params.range) {
      const range = PITCH_RANGES.find((r) => r >= need);
      if (range == null) {
        // Out of reach by that much, the track is most likely read at the wrong octave.
        const m = bpm > native ? 2 : 0.5;
        return fail(`${f(bpm)} is beyond the widest pitch range (±50%) for a ${f(native)} BPM track. Is it ${f(native * m)}? Press ${m === 2 ? '2×' : '½×'}.`);
      }
      this.setParam('range', range);
      this.engine.event('info', `Deck ${this.slot}: range widened to ±${Math.round(range * 100)} to reach ${f(bpm)}.`, this.id);
    }
    this.setParam('pitch', pitch);
    return OK;
  }

  /**
   * The DJ says the track at heard position p is `bpm` (detection got it wrong). Its grid keeps
   * the beat nearest p (with no grid yet: the cue of a paused deck, else p) and takes that period
   * across the track; the tracker holds it as a manual tempo, as it holds a TAP. Tempo only, so a
   * paused deck can take it. The pitch stays: the tempo played changes in proportion.
   */
  setNativeBpm(p, bpm) {
    // Refused rather than folded: what the DJ typed is what the deck shows, and the range is the
    // DJ's own setting of which octave a tempo is counted in (detection and setRange keep to it).
    const [lo, hi] = BPM_RANGES[this.engine.params['bpm.range']] || BPM_RANGES.AUTO;
    if (bpm < lo || bpm > hi) {
      const alt = bpm * octaveFold(bpm, lo, hi);
      const how = alt >= lo && alt <= hi ? `Type ${alt.toFixed(1)} (the same beat), or change` : 'Change';
      return fail(`${bpm.toFixed(1)} is outside the BPM range ${lo}–${hi}. ${how} the BPM range in Settings.`);
    }
    const g = this.grids.at(p), rate = this.src.rateAt(p), T = 60 / (bpm * rate);
    const b = g ? g.t0 + Math.round((p - g.t0) / g.T) * g.T : this.wantPlay ? p : this.cue;
    this.regridAt(p, { t0: b, T });
    if (this.followsTrackAt(p)) {
      const segs = this.grids.segs, live = segs.length ? segs[segs.length - 1].grid : null;
      this.tempo.applyTap(live
        ? { t0: live.t0 * this.sr, T: live.T * this.sr }
        : { t0: b * this.sr, T: ((T * rate) / this.assist.sourceRate) * this.sr }, 'typed');
    }
    this.followTempo();
    this.syncMult = null; // a synced deck chooses again which octave of the master it follows
    return OK;
  }

  // ------------------------------------------------------------------ params
  setParam(k, v) {
    if (k === 'pitch') {
      v = clamp(v, -this.params.range, this.params.range);
      if (this.syncOn) { this.syncOn = false; this.phaseMs = null; this.engine.event('info', `Deck ${this.slot}: sync off (tempo moved by hand).`); }
    }
    // A narrower range must never move a deck that is on air: refuse it and say so, instead of
    // clamping the pitch in place (one stray RANGE click would be a silent mid-track tempo jump).
    if (k === 'range' && Math.abs(this.params.pitch) > v + 1e-9) {
      const pct = `${this.params.pitch < 0 ? '−' : '+'}${Math.abs(this.params.pitch * 100).toFixed(2)}%`;
      this.engine.event('warn', `Deck ${this.slot}: tempo is ${pct}, outside ±${Math.round(v * 100)}%. Move the tempo fader inside it first.`, this.id);
      return;
    }
    this.params[k] = v;
    this.applyParam(k, v);
  }

  applyParam(k, v) {
    switch (k) {
      case 'trim': this.trimNode.set(v); break;
      case 'eq.hi': case 'eq.mid': case 'eq.low': this.eq.set(k.slice(3), v); break;
      case 'kill.hi': case 'kill.mid': case 'kill.low': this.eq.kill(k.slice(5), v); break;
      case 'filter': case 'filter.res': this.rack.setFilter(this.params.filter, this.params['filter.res']); break;
      case 'fader': glide(this.ctx, this.fader.gain, v * v); break;
      case 'xf': if (this.engine.decks.has(this.id)) this.engine.master.setAssign(this.id, v); break;
      case 'fx.type': case 'fx.beats': case 'fx.level': case 'fx.on': this.applyFx(); break;
      case 'keyLock': case 'pitch': case 'range': this.applyRate(); break;
      default: break;
    }
  }

  applyFx() {
    const bpm = this.tempoInfo().out || 120;
    this.lastFxBpm = bpm;
    this.rack.setFx({ type: this.params['fx.type'], beats: this.params['fx.beats'], level: this.params['fx.level'], on: this.params['fx.on'], bpm });
  }

  // ------------------------------------------------------------------ periodic
  tick(now) {
    if (!this.ts || this.disposed || this.kind === 'loading') return;
    const ts = this.ts, live = this.kind !== 'resident'; // a resident deck has no capture to wait for, trim or speed up
    ts.flush(now);
    const p = ts.posAt(now);
    const res = ts.reserveAt(now);
    // After a main-thread stall, backlogged ticks run at the current time while the live edge is still
    // catching up: the reserve looks empty when the stretcher (fed on the audio thread) is fine. Wait.
    const stale = this.edgeAt != null && now - this.edgeAt > EDGE_STALE;

    if (this.wantPlay && !stale) {
      const desired = this.desiredRate(p);
      if (live && !this.starved && desired > 1 && res < GUARD) {
        this.starved = true;
        this.applyRate();
        this.engine.event('warn', `Deck ${this.slot}: reserve empty, playing at the source's speed until it refills.`, this.id);
      } else if (this.starved && (desired <= 1 || res > GUARD + 1.5)) {
        this.starved = false;
        this.applyRate();
      }
      if (live && res < 0.15 && now > this.emergencyUntil) {
        this.emergencyUntil = now + 2;
        this.sched(ts.soon(now), { input: ts.clampInput(ts.posAt(ts.soon(now)) - 1) });
      }
      this.scheduleCrossing(now, p);
      this.scheduleSkip(now, p);
      this.reconcileRate(now);
      if (!live) this.planEnd(now);
    } else if (!this.wantPlay && this.starved) {
      this.starved = false; // re-evaluated on the next PLAY
    }
    if (this.search && !this.wantPlay) this.searchTick(now);

    if (live && now >= this.nextAssist) { this.nextAssist = now + 0.25; this.assistTick(now, res); }
    if (now >= this.nextFxClock) {
      this.nextFxClock = now + 0.5;
      const g = this.grids.at(p), rate = ts.rateAt(now);
      if (g && rate > 0) this.rack.setClock(Math.round(lastBeatOut(g, p, rate, now) * this.sr), (g.T / rate) * this.sr);
      const out = this.tempoInfo().out;
      if (out && Math.abs(out - this.lastFxBpm) > 0.05) this.applyFx();
    }
    this.rack.tick(now);
    if (live && now >= this.nextTrim) { this.nextTrim = now + 2; this.trim(now, p); }
  }

  /**
   * A resident deck stops at the end of its track (input = duration). The stop is planned once the end is
   * near, after any change still pending; a later change drops it, and the next tick plans it again. Parked
   * at the end with a start still to come (CUE, then PLAY at once), it is not stopped: that start would play unseen.
   * A CUE preview held into the end goes back to the cue there, as letting go of it would.
   */
  planEnd(now) {
    const ts = this.ts, end = this.duration;
    if (this.parkedAtEnd(now) && !ts.planned(now, true)) {
      if (this.previewing) ts.change(now, now, { active: false, input: this.cue });
      this.wantPlay = false; this.previewing = false; this.playingSince = Infinity;
      return;
    }
    const last = ts.segs[ts.segs.length - 1];
    if (!last.active || !(last.rate > 0) || last.loopEnd > last.loopStart) return; // stop planned already, or looping
    const from = Math.max(last.output, now), tEnd = from + (end - ts.posAt(from)) / last.rate;
    if (tEnd - now > END_PLAN) return;
    if (last.output > now) ts.then(now, Math.max(tEnd, last.output + 1e-6), { active: false, input: end, end: true });
    else ts.change(now, Math.max(tEnd, ts.soon(now)), { active: false, input: end, end: true });
  }

  /**
   * Post-fader meter over the latest engine tick, measured in the master worklet (this deck's
   * input there is its slot); read only for a state a UI will be sent. The worklet keeps the
   * latest clip's frame, so a clip between two reads (a hidden page reads twice a second) still
   * lights the clip light for 2 s from the clip.
   */
  meterTick(now) {
    if (!this.ts || this.disposed) return;
    const m = this.engine.master.deckMeter(this.slot), mt = this.meter;
    if (!m) return;
    mt.peak = m.peak;
    mt.rms = m.rms;
    if (m.clipFrame > mt.clipFrame) { mt.clipFrame = m.clipFrame; mt.clipUntil = Math.max(mt.clipUntil, m.clipFrame / this.sr + 2); }
  }

  /** When the playhead reaches an input position where the source rate changed, change the engine rate exactly there. */
  scheduleCrossing(now, p) {
    const next = this.src.nextChangeAfter(p);
    if (!next) return;
    if (this.ts.pendingUntil() >= now) return;
    // Planned once already, unless a later change dropped that crossing.
    if (this.crossingFor === next.inPos && this.ts.segAt(this.crossingSeg.output) === this.crossingSeg) return;
    const rate = this.ts.rateAt(now);
    if (!(rate > 0)) return;
    const tCross = now + (next.inPos - p) / rate;
    if (tCross - now > 0.6) return;
    const T = Math.max(tCross, this.ts.soon(now));
    this.crossingFor = next.inPos;
    this.crossingSeg = this.ts.change(now, T, { rate: this.effRate(next.inPos + 1e-6), semitones: this.semis(next.inPos + 1e-6) });
  }

  /**
   * A capture gap the tracker found ahead of the playhead (a grid segment whose beats come `shift` s later than the
   * grid before it) is played across by a playhead jump of the same size, landing where the playhead reaches it: a
   * beat-locked deck (a BEAT follower, or the master such followers lock to) keeps its beats where they were, instead
   * of the phase loop bending it back into line by up to 4 %. The size is the step the tracker found there (gapStep).
   * Gaps up to SKIP_MAX, at most one jump a beat; under a nudge, roll or loop the gap is played as it came.
   *
   * The jump is the deck's own, never in the DJ's way: planned as late as a tick allows (SKIP_LEAD), and no later
   * change folds into it and waits for it (a nudge, roll, beat jump or tempo move is heard as soon as ever). Such a
   * change drops it instead, and the gap is seen to again: planned anew, or by the phase loop.
   */
  scheduleSkip(now, p) {
    const ts = this.ts, plan = this.skipPlan;
    if (plan && !ts.segs.includes(plan.seg)) { this.skips.delete(plan.s); this.skipAt = plan.prevAt; this.skipPlan = null; }
    else if (plan && plan.seg.output <= now) this.skipPlan = null;
    if (!this.beatLocked() || this.nudge || this.rollFrom || this.loop || (this.outOfRange && !this.isMaster())) return;
    const s = this.grids.segs.find((x) => x.from > p && x.shift && !this.skips.has(x));
    if (!s) return;
    const tc = this.reachAt(now, s.from);
    if (tc == null || tc - ts.soon(now) > SKIP_LEAD) return; // through whatever is planned before it
    const T = Math.max(tc, ts.soon(now)), pend = ts.pendingUntil();
    if (!this.skipFits(s, T)) { this.skips.add(s); return; } // the phase loop sees to it
    if (pend >= T) return; // a change lands after the gap: jumped by the phase loop once it is through
    this.skips.add(s);
    // A follower a few ms off the beat, inside the phase loop's deadband, takes that off too: else the jump's own ms of
    // error can tip it over, and the loop bends right after the gap.
    const off = this.isMaster() ? 0 : this.offBefore(s, T);
    const input = ts.clampInput(ts.posAt(T) + this.gapStep(s) + off), fields = { input, rate: this.effRate(input), semitones: this.semis(input) };
    const seg = pend >= now ? ts.then(now, T, fields) : ts.change(now, T, fields);
    seg.transport = false; // not a planned transport change for later ones to fold into: they drop it
    this.skipPlan = { seg, s, prevAt: this.skipAt };
    this.skipAt = T;
    this.settleUntil = Math.max(this.settleUntil, T + 0.3);
  }

  /** Whether grid segment s's capture gap may be jumped at output time T: small enough, and a beat after the last jump. */
  skipFits(s, T) {
    const r = this.ts.rateAt(T);
    return Math.abs(this.gapStep(s)) <= SKIP_MAX && r > 0 && !!s.grid && T - this.skipAt >= s.grid.T / r;
  }

  /**
   * A follower's phase error at output time T against the grid before capture gap s, as input seconds, when inside the
   * phase loop's deadband (else 0). Not the last phase look's: that looks a little ahead, and past a gap found late.
   */
  offBefore(s, T) {
    const segs = this.grids.segs, i = segs.indexOf(s), g = i > 0 ? segs[i - 1].grid : null;
    const mb = this.engine.clock.beat(T), rate = this.ts.rateAt(T);
    if (!g || !mb || !(rate > 0)) return 0;
    const e = phaseError(lastBeatOut(g, this.ts.posAt(T), rate, T), g.T / rate, mb.lastBeat, mb.period);
    return Math.abs(e) <= PHASE_DEADBAND ? e * rate : 0;
  }

  /**
   * The step of grid segment s's capture gap: the one the tracker found there, from the beats on both sides of it. Not
   * the step its grid gives against the grid before it when the playhead gets there: until a later gap is found, that
   * grid is the tracker's live clock, which by then follows the beats at the live edge, seconds past the gap, and has
   * partly taken in any later gap it has not found yet (a jump of -19.5 ms seen for a gap found -11.5 ms).
   */
  gapStep(s) { return s.shift; }

  /** Output time (from now on) at which the planned playhead reaches input x, or null if a pause, loop or jump comes first. */
  reachAt(now, x) {
    const ts = this.ts, segs = ts.segs;
    let i = segs.length - 1;
    while (i > 0 && segs[i].output > now) i--;
    for (; i < segs.length; i++) {
      const s = segs[i], from = Math.max(s.output, now), end = i + 1 < segs.length ? segs[i + 1].output : Infinity;
      if (!s.active || !(s.rate > 0) || s.loopEnd > s.loopStart) return null;
      const p0 = ts.posAt(from);
      if (x < p0) return null;
      if (from + (x - p0) / s.rate < end) return from + (x - p0) / s.rate;
    }
    return null;
  }

  /**
   * Restate rate/semitones when the scheduled ones differ from what the deck wants: an update that
   * was deferred (syncTick while a change was pending) or dropped. Only while nothing is pending,
   * so a start, bend or crossing is never cut short.
   */
  reconcileRate(now) {
    const ts = this.ts;
    if (ts.pendingUntil() >= now || !ts.playingAt(now)) return;
    const T = ts.soon(now), p = ts.posAt(T), seg = ts.segAt(T);
    const rate = this.effRate(p);
    if (Math.abs(seg.rate - rate) > 1e-9 * rate || Math.abs(seg.semitones - this.semis(p)) > 1e-9) this.sched(T, {});
  }

  assistTick(now, res) {
    const as = this.assist;
    // Input chunks reach the main thread late, never early: the smallest lag maps context time
    // onto the input timeline (agentLetGo), whatever a stall did to the order of messages.
    if (now - this.ts.liveEdge < as.inLag) as.inLag = now - this.ts.liveEdge;
    // A late confirmation is still taken (onAgentStatus); only silence this long refuses.
    const overdue = as.inflight.length ? now - as.inflight[0].at : 0;
    if (overdue > ASSIST_REFUSE) { this.refuseAssist(now); return; }
    const enabled = !!this.engine.params['assist.on'];
    const available = this.agentAvailable(now), heard = this.audibleAgent();
    // The heard element went away or moved to another frame: let go, and start again from 1x.
    if ((as.sent !== 1 || as.sourceRate !== 1) && (!available || heard !== as.agent)) { this.dropAssist(); return; }
    const st = assistStep({
      need: this.wantPlay ? 1 + this.params.pitch : 1, reserve: res, sourceRate: as.sent,
      target: as.target, available, playing: this.wantPlay, enabled,
    });
    as.target = st.target;
    // While a confirmation is overdue the ramp holds (keep-alives only), so a slow page is not
    // sent steps ahead of what it has confirmed.
    if (Math.abs(st.next - as.sent) > 1e-9 && overdue <= ASSIST_CONFIRM) {
      // Committed to the source model only when the page confirms it (onAgentStatus).
      as.sent = st.next;
      as.agent = heard;
      as.inflight.push({ seq: ++as.seq, rate: st.next, at: now });
      this.postAssist(st.next === 1 && st.target === 1 ? { t: 'release', seq: as.seq } : { t: 'rate', rate: st.next, seq: as.seq });
      as.sentAt = now;
    } else if (as.sent !== 1 && now - as.sentAt >= ASSIST_KEEPALIVE) {
      this.postAssist({ t: 'rate', rate: as.sent, seq: as.seq });
      as.sentAt = now;
    }
  }

  async trim(now, p) {
    const ts = this.ts, cap = ts.capSec, res = ts.reserveAt(now);
    // Buffer-cap notices are latched once per episode: until the reserve falls well under the
    // cap again, or (for the paused 'buffer full' notice) until the deck plays.
    if (res < 0.8 * cap) this.capNotice = null;
    else if (this.wantPlay && this.capNotice === 'full') this.capNotice = 'near';
    // A playing deck slower than its source gains reserve. Near the cap, warn once; at the cap
    // (5% slack, so a deck played at 1x from a full buffer just keeps playing) skip ahead whole
    // bars (keeping phase) to half the cap.
    if (this.wantPlay && !this.previewing && !this.roll) {
      if (res >= 1.05 * cap) {
        const T = ts.soon(now), at = ts.posAt(T), g = this.grids.at(at);
        let skip = res - cap / 2;
        if (g && this.canBeat()) skip = Math.max(1, Math.round(skip / (4 * g.T))) * 4 * g.T;
        this.sched(T, { input: ts.clampInput(at + skip) });
        this.settleUntil = T + 0.3;
        this.engine.event('warn', `Deck ${this.slot}: buffer full, skipped ahead ${Math.round(skip)} s to keep playing.`, this.id);
      } else if (res >= 0.9 * cap && !this.capNotice) {
        this.capNotice = 'near';
        this.engine.event('warn', `Deck ${this.slot}: buffer almost full. It will skip ahead when full; press LIVE to catch up now.`, this.id);
      }
    }
    // A roll's slip (moved by a seek, it can be far from the loop) and a jump still on its way stay buffered.
    const nav = Math.min(this.rollFrom ? this.rollFrom.p - 1 : Infinity, this.navKeep && this.navKeep.T > now - 1 ? this.navKeep.p - 1 : Infinity);
    const keepFrom = Math.min(this.cue - 1, p - this.ts.historySec, this.loop ? this.loop.start - 1 : Infinity, nav);
    // Never drop the audio under (or just behind) a playing deck's playhead.
    const r = await this.ts.trim(now, keepFrom, this.wantPlay ? p - CAP_MARGIN : Infinity);
    if (!r.dropped || this.disposed) return;
    const hs = this.ts.historyStart;
    this.grids.prune(hs);
    this.src.prune(hs);
    this.compactWave(hs);
    if (this.cue < hs) {
      const g = this.grids.at(hs + 0.05);
      this.cue = g && this.canBeat() ? g.t0 + Math.ceil((hs + 0.05 - g.t0) / g.T) * g.T : hs + 0.05;
    }
    if (!this.wantPlay && this.ts.posAt(this.now()) < hs) {
      this.ts.change(this.now(), this.ts.soon(this.now()), { active: false, input: this.cue });
      if (this.capNotice !== 'full') {
        this.capNotice = 'full';
        this.engine.event('warn', `Deck ${this.slot}: buffer full, the oldest audio was dropped.`, this.id);
      }
    }
  }

  /** Tempo follow for a synced deck (every tick). */
  syncTick(now) {
    if (!this.syncOn || this.isMaster()) return;
    const c = this.engine.clock.state();
    const native = this.tempoInfo().native;
    if (!c.bpm || !native) return;
    // The half/double octave is latched for as long as the deck plays: a pitch move on the master
    // must never double a deck mid-mix. It is re-chosen on a SYNC press, while the deck is silent,
    // and when the DJ hands mastership to another deck. Silent moves still get hysteresis.
    const master = this.engine.clock.assigned;
    if (master != null && master !== this.syncMaster) { this.syncMaster = master; this.syncMult = null; }
    const r = syncRatio(c.bpm, native, this.params.range, this.syncMult, this.wantPlay ? Infinity : MULT_MARGIN);
    this.syncMult = r.mult;
    this.outOfRange = r.outOfRange;
    if (Math.abs(r.ratio - (1 + this.params.pitch)) > 2e-5) {
      this.params.pitch = r.ratio - 1;
      if (this.ts.pendingUntil() < now) this.applyRate();
    }
  }

  /** Phase lock for a BEAT-synced playing deck (every 0.5 s). */
  phaseTick(now) {
    this.phaseMs = null;
    if (!this.syncOn) this.beatLostNoted = false;
    if (!this.syncOn || this.params.syncMode !== 'BEAT' || this.outOfRange || !this.wantPlay || this.previewing) return;
    if (this.isMaster() || this.nudge || this.roll) return;
    if (!this.canBeat()) {
      // Tempo stays synced; phase lock waits for a confident grid. Said once per SYNC press.
      if (!this.beatLostNoted) { this.beatLostNoted = true; this.engine.event('warn', `Deck ${this.slot}: beat grid not confident, phase lock paused (tempo still synced). TAP the beat to re-lock.`, this.id); }
      return;
    }
    const starved = this.starved;
    const T = this.ts.soon(now) + 0.02;
    const mb = this.engine.clock.beat(T);
    const p = this.ts.posAt(T), g = this.grids.at(p), rate = this.ts.rateAt(T);
    if (!mb || !g || !(rate > 0)) return;
    const e = phaseError(lastBeatOut(g, p, rate, T), g.T / rate, mb.lastBeat, mb.period);
    this.phaseMs = e * 1000;
    // A starved deck cannot keep up; bending faster would only spend the reserve it is protecting.
    if (starved || now < this.settleUntil || this.ts.pendingUntil() >= now) return;
    // A capture gap the playhead went through before the tracker found it (or before it could be planned): when
    // the error is that gap's step, it is jumped back into line as scheduleSkip would have.
    const gap = this.grids.segs.find((x) => x.shift && x.from <= p && p - x.from < 2 && !this.skips.has(x)
      && Math.abs(e * rate - this.gapStep(x)) <= Math.max(0.003, 0.3 * Math.abs(this.gapStep(x))));
    if (gap) {
      this.skips.add(gap);
      if (this.skipFits(gap, T)) {
        this.sched(T, { input: this.ts.clampInput(p + e * rate) });
        this.skipAt = T;
        this.settleUntil = T + 0.3;
        return;
      }
    }
    const plan = planCorrection(e, { audible: this.audible(), keyLock: this.params.keyLock });
    if (plan.kind === 'bend') {
      const pEnd = p + rate * (1 + plan.bend) * plan.duration;
      const end = { rate: this.effRate(pEnd), semitones: this.semis(pEnd) };
      this.settleUntil = this.ts.bend(now, T, 1 + plan.bend, plan.duration, end, !this.params.keyLock) + 0.25;
    }
    else if (plan.kind === 'jump') { this.sched(T, { input: this.ts.clampInput(p + plan.seconds * rate) }); this.settleUntil = T + 0.3; }
  }

  masterInfo(now) {
    if (!this.ts) return null;
    const p = this.ts.posAt(now), g = this.grids.at(p), rate = this.ts.rateAt(now), out = this.tempoInfo(p).out;
    if (!out) return null;
    const playing = this.wantPlay && !this.previewing && this.ts.playingAt(now);
    // One clock: the tempo of the beat actually being played — nudge, bend and starve clamp
    // included — so bpm and period describe the same beat and slaves follow what they hear.
    if (g && rate > 0) return { playing, bpm: (60 * rate) / g.T, lastBeat: lastBeatOut(g, p, rate, now), period: g.T / rate };
    // No grid under the playhead means no phase to publish: let the clock keep the last real one
    // and free-run, the way it does for a master that paused, instead of re-anchoring to this tick.
    const bpm = this.starved && rate > 0 ? (out * rate) / this.desiredRate(p) : out;
    return { playing: false, bpm, lastBeat: now, period: 60 / bpm };
  }

  // ------------------------------------------------------------------ agent (player assist)
  /** A source-rate step the page confirmed: it starts at the current live edge, or at input position atIn. */
  commitSourceRate(rate, seq, atIn = this.ts.liveEdge) {
    const as = this.assist, prev = as.sourceRate;
    if (seq != null) as.okSeq = seq;
    as.active = rate !== 1;
    if (Math.abs(rate - prev) < 1e-9) return;
    as.sourceRate = rate;
    this.src.set(atIn, rate);
    if (this.tempo) {
      this.tempo.sourceRateChanged(rate / prev, Math.round(atIn * this.sr));
      this.grids.split(atIn, this.tempo.get().grid);
    }
  }

  /** Give the page its player back and roll the source model back to 1x at the live edge. */
  dropAssist() {
    const as = this.assist;
    as.inflight = []; as.target = 1; as.sent = 1; as.agent = null;
    this.sendAgent({ t: 'release', seq: ++as.seq });
    as.sentAt = this.now();
    this.commitSourceRate(1);
  }

  /**
   * The agent let go of the page by itself at wall time `at` (ms): it had no command for a long
   * while, because this engine stalled. Not a refusal: the source model steps back to 1x where
   * the page did (not where the engine heard of it, maybe seconds later), and assist ramps again
   * from 1x. The release (a new seq) stops a command still on its way from taking the page back.
   */
  agentLetGo(at) {
    const as = this.assist, now = this.now();
    this.postAssist({ t: 'release', seq: ++as.seq });
    as.inflight = []; as.target = 1; as.sent = 1; as.agent = null; as.okSeq = -1; as.sentAt = now;
    // Where the input timeline was then: maybe past the live edge, if the audio from the stall is
    // still on its way.
    const ago = Math.max(0, (this.engine.wallNow() - at) / 1000);
    const atIn = Number.isFinite(as.inLag) ? now - ago - as.inLag : this.ts.liveEdge - ago;
    this.commitSourceRate(1, null, Math.max(this.src.steps[this.src.steps.length - 1].inPos + 1e-6, atIn));
  }

  /** The page did not hold the rate (it resets it, or the rate went to an element that is not heard). */
  refuseAssist(now = this.now()) {
    this.dropAssist();
    this.assist.offUntil = now + ASSIST_OFF;
  }

  /** The frame agent whose tab has exactly one playing, audible media element, or null. */
  audibleAgent() {
    let found = null, n = 0;
    for (const a of this.agents.values()) if (a.status && a.status.audible) { n += a.status.audible; found = a; }
    return n === 1 ? found : null;
  }

  /** Assist drives one audible element only, and engages only if the page plays it at 1x. */
  agentAvailable(now = this.now()) {
    const as = this.assist, a = this.audibleAgent();
    if (now < as.offUntil || !a) return false;
    return as.sent !== 1 || as.sourceRate !== 1 || as.inflight.length > 0 || Math.abs(a.status.rate - 1) < ASSIST_EPS;
  }

  /** Confirm commanded rates from the audible element's status (it echoes the command's seq). */
  onAgentStatus(a) {
    const as = this.assist, s = a.status;
    if (a !== as.agent || a !== this.audibleAgent() || (as.sourceRate === 1 && !as.inflight.length)) return;
    const i = as.inflight.findIndex((x) => x.seq === s.seq);
    // Let go by itself after our latest command it applied (a later one would have taken it back).
    if (s.selfReleased) { if (i >= 0 || s.seq === as.okSeq) this.agentLetGo(s.releasedAt); return; }
    if (i >= 0) {
      const want = as.inflight[i].rate;
      as.inflight.splice(0, i + 1);
      if (Math.abs(s.rate - want) < ASSIST_EPS) this.commitSourceRate(want, s.seq);
      else this.refuseAssist();
    } else if (s.seq === as.okSeq && Math.abs(s.rate - as.sourceRate) >= ASSIST_EPS) {
      this.refuseAssist(); // the page changed the rate after confirming it
    }
  }

  attachAgent(port, frameId) {
    const a = { port, status: null };
    this.agents.set(frameId, a);
    port.onMessage.addListener((raw) => {
      const m = validateAgentMessage(raw);
      if (!m || this.disposed || this.agents.get(frameId) !== a) return;
      if (m.t === 'status') { a.status = m; this.onAgentStatus(a); }
      else if (m.t.startsWith('tap-')) { if (this.loader) this.loader.onTap(frameId, m); } // the page tap: the load's
      else if (m.t === 'external-rate' && a === this.assist.agent) this.refuseAssist();
      else if (m.t === 'external-pause') this.notePauseFight();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.agents.get(frameId) !== a) return;
      this.agents.delete(frameId);
      if (this.loader) this.loader.onDetach(frameId, a);
    });
    // This deck is capturing the frame's tab: until it lets go, a pause the frame's own site asks
    // for is dropped, so a site that allows one playing track at a time cannot stop the source.
    try { port.postMessage({ t: 'query' }); port.postMessage({ t: 'isolate', on: true }); } catch (_) {}
    if (this.loader) this.loader.onAttach(frameId, a);
  }

  /**
   * A frame's site keeps pausing its player although the tab is on a deck, so its agent stopped
   * resisting rather than fight it. Said once per deck: nothing more can be done from here.
   */
  notePauseFight() {
    if (this.pauseFought) return;
    this.pauseFought = true;
    this.engine.event('warn', `Deck ${this.slot}: the site keeps pausing this tab — it may only allow one track at a time.`, this.id);
  }

  /** Assist rate commands go to the heard element's frame only. */
  postAssist(msg) {
    const a = this.assist.agent;
    if (a) { try { a.port.postMessage(msg); } catch (_) {} }
  }

  sendAgent(msg) {
    for (const a of this.agents.values()) {
      if (!a.status || !a.status.hasMedia) continue;
      try { a.port.postMessage(msg); } catch (_) {}
    }
  }

  // ------------------------------------------------------------------ snapshot
  state(now) {
    const ts = this.ts;
    const p = ts ? ts.posAt(now) : 0;
    const info = this.tempoInfo(p);
    const g = info.g, grid = this.grids.at(p);
    const playingNow = !!ts && ts.playingAt(now);
    return {
      id: this.id, slot: this.slot, tabId: this.tabId, title: this.meta.title, favIconUrl: this.meta.favIconUrl, url: this.meta.url,
      kind: this.kind, duration: this.duration, load: { ...this.load },
      analysis: this.analysis ? { bar1: this.analysis.bar1 || null, conf: this.analysis.conf } : null, // whole-track analysis: bar 1 suggestion
      playing: this.wantPlay, previewing: this.previewing, cue: this.cue, playhead: p,
      engineRate: playingNow ? ts.rateAt(now) : 0, liveEdge: ts ? ts.liveEdge : 0, reserve: ts ? ts.reserveAt(now) : 0,
      starved: this.starved, historyStart: ts ? ts.historyStart : 0,
      bpm: { state: g ? g.state : 'SEARCH', native: info.native, out: info.out, conf: g ? g.conf : 0, mult: g ? g.mult : 1, tapped: g ? g.tapped : false, manual: (g && g.manual) || null },
      grid: grid ? { t0: grid.t0, T: grid.T, bar1: grid.bar1 } : null,
      sync: { on: this.syncOn, mode: this.params.syncMode, isMaster: this.isMaster(), outOfRange: this.syncOn && this.outOfRange, phaseMs: this.phaseMs },
      assist: { available: this.agentAvailable(), active: this.assist.active, sourceRate: this.assist.sourceRate },
      params: { ...this.params },
      roll: this.roll, loop: this.loop, nudge: this.nudge,
      meter: { peak: this.meter.peak, rms: this.meter.rms, clip: now < this.meter.clipUntil },
      rec: this.recorder ? { state: this.recorder.state, format: this.recorder.format, seconds: this.recorder.seconds } : { state: 'idle', format: 'wav', seconds: 0 },
      error: this.error,
    };
  }

  // ------------------------------------------------------------------ teardown
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sendAgent({ t: 'release' });
    this.sendAgent({ t: 'isolate', on: false });
    for (const a of this.agents.values()) { try { a.port.disconnect(); } catch (_) {} }
    this.agents.clear();
    if (this.recorder && this.recorder.state !== 'idle') {
      this.recorder.stop();
      const t0 = Date.now();
      while (this.recorder.state !== 'idle' && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    }
    if (this.recorder) this.recorder.teardown(); // no-op when idle; a stuck finalize must not leave its processor running
    if (this.stream) for (const t of this.stream.getTracks()) t.stop(); // a resident deck has no capture
    // Chrome keeps calling process() on a disconnected AudioWorkletNode for as long as it returns true,
    // so every processor is told to stop. The stretcher first goes silent and lets go of its buffer.
    try { this.inputNode && this.inputNode.port.postMessage({ t: 'dispose' }); } catch (_) {}
    const st = this.stretch;
    if (st && st.dropBuffers) {
      const calls = [st.schedule({ active: false, output: this.now() }), st.dropBuffers()];
      if (st.destroy) calls.push(st.destroy());
      await withTimeout(Promise.all(calls), 1500, 'The time-stretcher did not stop').catch(() => {});
    }
    const nodes = [this.source, this.inputNode, st, this.fader, this.xfGain];
    for (const n of nodes) { try { n && n.disconnect(); } catch (_) {} }
    for (const n of [this.inputNode, st]) { try { n && n.port.close(); } catch (_) {} }
    for (const m of [this.trimNode, this.eq, this.rack]) { try { m && m.dispose(); } catch (_) {} }
    this.engine.master.removeDeck(this.id);
  }
}
