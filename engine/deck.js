// engine/deck.js — one captured tab as a DJ deck.
//
// tab stream ─► MediaStreamSource ─► jds-deck-input ─(chunks)─► Timeshift/stretch node (buffer mode)
//                                         └─(ODF)─► DeckTempo ─► GridMap
// stretch ─► trim ─► EQ ─► FX rack (filter, gate/crush, flanger, echo/reverb sends) ─┬─► fader ─► xfGain ─► master bus
//                                                                                    └─► recorder (pre-fader, post-FX)
// All transport/tempo/phase changes are scheduled on the audio clock through Timeshift.
import { BPM_RANGES, validateAgentMessage } from '../shared/protocol.js';
import { DeckTempo, MANUAL_BPM, octaveFold } from './tempo.js';
import { Timeshift, SourceMap, GridMap, GUARD, LIVE_RESERVE } from './timeshift.js';
import { createIsolator, createTrim } from './eq.js';
import { createFxRack } from './fx.js';
import { Recorder } from './recorder.js';
import { glide } from './params.js';
import { syncRatio, lastBeatOut, phaseError, planCorrection, engineSemitones, assistStep, pickAutoMaster } from './sync.js';

const OK = { ok: true };
const fail = (error) => ({ ok: false, error });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const CAP_MARGIN = 4; // s of audio always kept behind a playing deck's playhead (covers small backward jumps)
// Player assist: rate match tolerance (steps are 0.25 %), how long the page has to confirm a rate
// before the ramp holds (a background tab Chrome throttles may answer late), how long before an
// unconfirmed rate counts as refused, how long assist stays off after the page refused it, and the
// keep-alive period (the agent lets go of the page after 3 s without a command).
const ASSIST_EPS = 1e-4, ASSIST_CONFIRM = 2, ASSIST_REFUSE = 5, ASSIST_OFF = 30, ASSIST_KEEPALIVE = 1;

export class Deck {
  constructor(engine, { id, slot, tabId, stream, meta, params }) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.sr = engine.ctx.sampleRate;
    this.id = id;
    this.slot = slot;
    this.tabId = tabId;
    this.stream = stream;
    this.meta = { title: '', url: '', favIconUrl: '', ...meta };
    this.params = { ...params };
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
    this.phaseMs = null;
    this.beatLostNoted = false; // a BEAT-synced deck lost its grid: said once per SYNC press
    this.settleUntil = 0;
    this.nudge = 0;
    this.nudgeFactor = 1;
    this.roll = null;
    this.rollFrom = null;
    this.loop = null;
    this.starved = false;
    this.emergencyUntil = 0;
    // sourceRate is what the page confirmed (the source model); sent is the last rate commanded,
    // to the frame agent of the one audible element (agent). inLag: context time minus input
    // position (the input timeline runs on the audio clock), its smallest value seen.
    this.assist = {
      target: 1, sourceRate: 1, active: false, sent: 1, agent: null, seq: Math.floor(Math.random() * 1e9), okSeq: -1, inflight: [], sentAt: -Infinity, offUntil: 0,
      inLag: Infinity,
    };
    this.agents = new Map();
    this.meter = { peak: 0, rms: 0, clipUntil: 0, clipFrame: Math.round(engine.ctx.currentTime * this.sr) }; // clips before this deck are not its own
    this.error = null;
    this.nextTrim = 0;
    this.capNotice = null; // latched buffer-cap notice: null | 'near' | 'full'
    this.nextAssist = 0;
    this.nextFxClock = 0;
    this.lastFxBpm = 0;
    this.crossingFor = null;
    this.crossingSeg = null;
    this.wave = { tStart: null, hop: 0, data: new Uint8Array(0), n: 0 };
    this.disposed = false;
  }

  now() { return this.ctx.currentTime; }

  async init() {
    const ctx = this.ctx, e = this.engine;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.inputNode = new AudioWorkletNode(ctx, 'jds-deck-input', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    this.inputNode.port.onmessage = (ev) => this.onInput(ev.data);
    this.stretch = await e.createStretch();
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
      format: e.params['rec.format'], who: `D${this.slot}`, title: () => this.meta.title || `Tab ${this.tabId}`, sink: e.silentSink,
      deliver: (blob, name) => e.deliver(blob, name), onChange: () => {}, onError: (msg) => e.event('error', msg, this.id),
    });
    for (const [k, v] of Object.entries(this.params)) this.applyParam(k, v);
    // Connect the capture last, so no chunk arrives before the Timeshift exists.
    this.source.connect(this.inputNode);
    this.inputNode.connect(e.silentSink);
    for (const t of this.stream.getAudioTracks()) t.addEventListener('ended', () => e.eject(this.id, `Deck ${this.slot}: the tab stopped sharing audio.`));
  }

  // ------------------------------------------------------------------ input
  onInput(m) {
    if (!m || this.disposed) return;
    if (m.t === 'init') {
      const [lo, hi] = BPM_RANGES[this.engine.params['bpm.range']] || BPM_RANGES.AUTO;
      this.tempo = new DeckTempo({ sampleRate: this.sr, fps: m.fps, lo, hi });
    } else if (m.t === 'chunk') {
      this.ts.append(m.L, m.R);
      if (this.firstAudible == null && m.firstAbove >= 0) {
        this.firstAudible = (m.start + m.firstAbove) / this.sr;
        if (this.cueAuto && !this.hasPlayed) this.setCue(this.firstAudible);
      }
    } else if (m.t === 'odf' && this.tempo) {
      this.tempo.pushBatch(m);
      const g = this.followTempo().grid;
      if (g && this.cueAuto && !this.cueSnapped && !this.hasPlayed && this.firstAudible != null) {
        this.cueSnapped = true;
        const k = Math.ceil((this.firstAudible - 0.05 - g.t0) / g.T);
        this.setCue(g.t0 + k * g.T);
      }
      const tStart = m.t0 / this.sr, hop = m.spf / this.sr;
      this.appendWave(tStart, hop, m.bands);
      this.engine.broadcastWave(this, tStart, hop, m.bands);
    }
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
  canBeat() { const g = this.tempo && this.tempo.get(); return !!(g && g.canBeat); }

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
    if (!this.syncOn || this.params.syncMode !== 'BEAT' || !this.canBeat() || this.isMaster()) return p;
    const mb = this.engine.clock.beat(T), g = this.grids.at(p);
    if (!mb || !g) return p;
    const rate = this.effRate(p);
    const e = phaseError(lastBeatOut(g, p, rate, T), g.T / rate, mb.lastBeat, mb.period);
    return p + e * rate;
  }

  startAt(T, p) {
    const input = this.ts.clampInput(p);
    this.ts.change(this.now(), T, { active: true, input, rate: this.effRate(input), semitones: this.semis(input) });
    this.wantPlay = true;
    this.hasPlayed = true;
    this.playingSince = T;
    this.settleUntil = T + 0.5;
  }

  isMaster() { return this.engine.clock.assigned === this.id; }

  audible() {
    return this.wantPlay && this.params.fader > 0.01 && this.xfGain.gain.value > 0.01;
  }

  async act(a, arg = {}) {
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
        let start = T;
        const mb = !this.isMaster() ? this.engine.clock.beat(T) : null;
        if (mb) { start = mb.lastBeat + mb.period; while (start < T) start += mb.period; }
        const wasSync = this.syncOn;
        if (mb && this.canBeat()) this.syncOn = true;
        if (!wasSync && this.syncOn) this.syncTick(now); // tempo first: the start and its alignment use the synced rate
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
        const target = this.ts.clampInput(this.ts.liveEdge - this.ts.lat - LIVE_RESERVE);
        if (this.wantPlay) this.sched(T, { input: target });
        else this.ts.change(now, T, { active: false, input: target });
        return OK;
      }
      case 'sync': return this.actSync(arg.on, now);
      case 'master':
        if (this.isMaster()) this.engine.clock.release(this.id);
        else { this.engine.clock.follow(this.id); this.syncOn = false; this.phaseMs = null; }
        return OK;
      case 'nudge':
        this.nudge = arg.dir;
        this.nudgeFactor = arg.dir ? 1 + arg.dir * (arg.fine ? 0.01 : 0.04) : 1;
        this.applyRate();
        this.settleUntil = now + (arg.dir ? 1e9 : 1);
        return OK;
      case 'tap': {
        if (!this.tempo) return fail('Waiting for audio.');
        const t = this.engine.ctxTimeAtWall(arg.wallMs ?? this.engine.wallNow());
        this.tapAt(this.ts.posAt(t));
        return OK;
      }
      case 'mult': if (this.tempo) this.multiplyAt(this.heardPos(), arg.factor); return OK;
      case 'gridShift': if (this.tempo) this.shiftAt(this.heardPos(), arg); return OK;
      case 'tap1': if (this.tempo) this.bar1At(this.heardPos()); return OK;
      case 'rollStart': return this.rollStart(arg.beats, now, T);
      case 'rollEnd': return this.rollEnd(now, T);
      case 'recStart':
        try { this.recorder.start(this.engine.params['rec.format']); return OK; } catch (err) { return fail(`Could not start recording: ${err.message}`); }
      case 'recStop': this.recorder.stop(); return OK;
      case 'eject': this.engine.eject(this.id); return OK;
      case 'clipReset': this.meter.clipUntil = 0; return OK;
      default: return fail(`Unknown action ${a}`);
    }
  }

  actSync(on, now) {
    const want = on == null ? !this.syncOn : on;
    if (!want) { this.syncOn = false; this.phaseMs = null; return OK; }
    if (this.isMaster()) return fail('This deck is the master. Make another deck master to sync this one.');
    if (!this.tempoInfo().native) return fail('No BPM yet. Wait for the deck to lock, or TAP the tempo.');
    const clock = this.engine.clock;
    let pick = null;
    if (clock.state().mode === 'none') {
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
    const slip = this.rollFrom.p + this.rollFrom.rate * (T - this.rollFrom.T);
    this.sched(T, { input: this.ts.clampInput(slip), loopStart: 0, loopEnd: 0 });
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

  // ------------------------------------------------------------------ manual grid tools
  // A correction acts on what the DJ hears: every grid segment of the track at the heard position
  // (assist steps split a track's grid), plus the tracker when it is still on that track. A track
  // the tracker has already left (the tab moved on) is corrected in the grid map only.

  heardPos() { return this.ts.posAt(this.engine.heardTime()); }

  followsTrackAt(p) { const n = this.grids.trackAt(p); return n == null || n === this.tempo.track.n; }

  shiftAt(p, { beats = 0, ms = 0 }) {
    if (this.followsTrackAt(p)) this.tempo.shiftGrid({ beats, ms });
    this.grids.editTrack(this.grids.trackAt(p), (g) => ({ ...g, t0: g.t0 + beats * g.T + ms / 1000 }));
    this.followTempo();
  }

  multiplyAt(p, factor) {
    const g = this.grids.at(p);
    if (this.followsTrackAt(p)) { if (!this.tempo.multiply(factor)) return; }
    else if (!g || (60 * factor) / g.T < MANUAL_BPM[0] || (60 * factor) / g.T > MANUAL_BPM[1]) return;
    this.grids.editTrack(this.grids.trackAt(p), (x) => ({ ...x, T: x.T / factor }));
    this.followTempo();
  }

  bar1At(p) {
    const g = this.grids.at(p);
    const b = g ? g.t0 + Math.round((p - g.t0) / g.T) * g.T : p;
    if (this.followsTrackAt(p)) this.tempo.setBar1(Math.round(b * this.sr), false);
    this.grids.editTrack(this.grids.trackAt(p), (x) => ({ ...x, bar1: b }));
    this.followTempo();
  }

  /** TAP at heard input position p: the tapped grid holds there, and is carried across its track at each source rate. */
  tapAt(p) {
    const fit = this.tempo.tapFit(Math.round(p * this.sr));
    if (!fit) return;
    this.grids.retime(p, { t0: fit.t0 / this.sr, T: fit.T / this.sr }, (x) => this.src.rateAt(x));
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

  // ------------------------------------------------------------------ params
  setParam(k, v) {
    if (k === 'pitch') {
      v = clamp(v, -this.params.range, this.params.range);
      if (this.syncOn) { this.syncOn = false; this.phaseMs = null; this.engine.event('info', `Deck ${this.slot}: sync off (tempo moved by hand).`); }
    }
    if (k === 'range') this.params.pitch = clamp(this.params.pitch, -v, v);
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
    if (!this.ts || this.disposed) return;
    const ts = this.ts;
    ts.flush(now);
    const p = ts.posAt(now);
    const res = ts.reserveAt(now);

    if (this.wantPlay) {
      const desired = this.desiredRate(p);
      if (!this.starved && desired > 1 && res < GUARD) {
        this.starved = true;
        this.applyRate();
        this.engine.event('warn', `Deck ${this.slot}: reserve empty, playing at the source's speed until it refills.`, this.id);
      } else if (this.starved && (desired <= 1 || res > GUARD + 1.5)) {
        this.starved = false;
        this.applyRate();
      }
      if (res < 0.15 && now > this.emergencyUntil) {
        this.emergencyUntil = now + 2;
        this.sched(ts.soon(now), { input: ts.clampInput(ts.posAt(ts.soon(now)) - 1) });
      }
      this.scheduleCrossing(now, p);
      this.reconcileRate(now);
    } else if (this.starved) {
      this.starved = false; // re-evaluated on the next PLAY
    }

    if (now >= this.nextAssist) { this.nextAssist = now + 0.25; this.assistTick(now, res); }
    if (now >= this.nextFxClock) {
      this.nextFxClock = now + 0.5;
      const g = this.grids.at(p), rate = ts.rateAt(now);
      if (g && rate > 0) this.rack.setClock(Math.round(lastBeatOut(g, p, rate, now) * this.sr), (g.T / rate) * this.sr);
      const out = this.tempoInfo().out;
      if (out && Math.abs(out - this.lastFxBpm) > 0.05) this.applyFx();
    }
    this.rack.tick(now);
    if (now >= this.nextTrim) { this.nextTrim = now + 2; this.trim(now, p); }
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
    const keepFrom = Math.min(this.cue - 1, p - this.ts.historySec, this.loop ? this.loop.start - 1 : Infinity);
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
    const r = syncRatio(c.bpm, native, this.params.range);
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
    // A starved deck plays slower than its set tempo: publish the tempo of the beat it plays,
    // so slaves match the same beat their phase lock follows.
    if (g && rate > 0) return { playing, bpm: this.starved ? (60 * rate) / g.T : out, lastBeat: lastBeatOut(g, p, rate, now), period: g.T / rate };
    const bpm = this.starved && rate > 0 ? (out * rate) / this.desiredRate(p) : out;
    return { playing, bpm, lastBeat: now, period: 60 / bpm };
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
      else if (m.t === 'external-rate' && a === this.assist.agent) this.refuseAssist();
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (this.agents.get(frameId) === a) this.agents.delete(frameId); });
    try { port.postMessage({ t: 'query' }); } catch (_) {}
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
      playing: this.wantPlay, previewing: this.previewing, cue: this.cue, playhead: p,
      engineRate: playingNow ? ts.rateAt(now) : 0, liveEdge: ts ? ts.liveEdge : 0, reserve: ts ? ts.reserveAt(now) : 0,
      starved: this.starved, historyStart: ts ? ts.historyStart : 0,
      bpm: { state: g ? g.state : 'SEARCH', native: info.native, out: info.out, conf: g ? g.conf : 0, mult: g ? g.mult : 1, tapped: g ? g.tapped : false },
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
    for (const a of this.agents.values()) { try { a.port.disconnect(); } catch (_) {} }
    this.agents.clear();
    if (this.recorder && this.recorder.state !== 'idle') {
      this.recorder.stop();
      const t0 = Date.now();
      while (this.recorder.state !== 'idle' && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    }
    if (this.recorder) this.recorder.teardown(); // no-op when idle; a stuck finalize must not leave its processor running
    for (const t of this.stream.getTracks()) t.stop();
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
