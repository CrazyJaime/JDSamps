// ui/deck-strip.js — one deck: its column in the board and its row in the waveform stack.
// All page-derived text goes through textContent; favicons are only set after isSafeIconUrl().
import { DECK_COLORS, PITCH_RANGES, isSafeIconUrl } from '../shared/protocol.js';
import { $, $$, clone, setText, toggleAttr, setAttr, setHidden, setClass, setStyle, pageHidden, cssSize, forgetSize, fmtBpm, fmtPct, fmtClock } from './util.js';
import { Knob, Fader, bindPad, bindSeg } from './controls.js';
import { WaveStore, drawWave, beatIndex } from './waveform.js';
import { VMeter } from './meters.js';
import { bindHold } from './hold.js';

const RANGE_LABEL = { 0.06: '±6', 0.1: '±10', 0.16: '±16', 0.5: 'WIDE' };
const STATE_CLASS = { LOCKED: 'ok', SEARCH: '', UNSURE: 'warn', HOLD: 'info' };
// Screen-reader names for the knobs, after "Deck N" (the visible labels are terse).
const KNOB_NAME = { trim: 'gain', filter: 'filter', 'filter.res': 'filter resonance', 'eq.hi': 'EQ high', 'eq.mid': 'EQ mid', 'eq.low': 'EQ low', 'fx.level': 'FX level' };

export class DeckStrip {
  constructor(d, { conn, toast, onSelect }) {
    this.id = d.id;
    this.conn = conn;
    this.toast = toast;
    this.d = d;
    this.shownBpm = null;
    this.rollHeld = [];
    this.store = new WaveStore();
    this.el = clone('tpl-deck');
    this.waveRow = clone('tpl-wave-row');
    const color = DECK_COLORS[(d.slot - 1) % DECK_COLORS.length];
    for (const n of [this.el, this.waveRow]) n.style.setProperty('--deck', color);
    this.color = color;
    this.el.addEventListener('pointerdown', () => onSelect(this.id), true);
    this.waveRow.addEventListener('pointerdown', () => onSelect(this.id));
    this.q = (sel) => $(sel, this.el);
    this.refs = {
      slot: this.q('[data-slot]'), fav: this.q('[data-fav]'), title: this.q('[data-title]'),
      bpm: this.q('[data-bpm]'), tstate: this.q('[data-tstate]'), pitch: this.q('[data-pitch]'), native: this.q('[data-native]'),
      leds: $$('[data-leds] i', this.el), reserveFill: this.q('[data-reserve-fill]'), reserveText: this.q('[data-reserve-text]'),
      reserve: this.q('.reserve'), assist: this.q('[data-assist]'), starved: this.q('[data-starved]'),
      phase: this.q('[data-phase]'), phaseDot: this.q('[data-phase-dot]'),
      play: this.q('[data-act="playToggle"]'), playIcon: this.q('[data-play-icon] use'),
      cue: this.q('[data-hold="cue"]'), sync: this.q('[data-act="sync"]'), master: this.q('[data-act="master"]'),
      keyLock: this.q('[data-act="keyLock"]'), syncMode: this.q('[data-act="syncMode"]'), range: this.q('[data-act="range"]'),
      rec: this.q('[data-act="rec"]'), recLabel: this.q('[data-act="rec"] span'), recTime: this.q('[data-rec-time]'),
      wslot: $('[data-slot]', this.waveRow), wbpm: $('[data-wbpm]', this.waveRow), wave: $('[data-wave]', this.waveRow),
    };
    setText(this.refs.slot, d.slot);
    setText(this.refs.wslot, d.slot);
    this.waveCtx = this.refs.wave.getContext('2d');
    this.meter = new VMeter(this.q('[data-meter]'));
    this.buildControls(d);
    this.render();
    this.onVisible = () => { if (this.stale && !pageHidden()) this.render(); };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  set(key, value, hold) { this.conn.set(this.id, key, value, hold); }
  async act(a, arg) {
    const r = await this.conn.act(this.id, a, arg);
    if (!r.ok && r.error) this.toast(r.error, 'warn');
    return r;
  }

  buildControls(d) {
    const p = d.params;
    const knob = (key, o) => new Knob(this.q(`[data-ctl="${key}"]`), { label: this.q(`[data-ctl="${key}"]`).dataset.label, name: `Deck ${d.slot} ${KNOB_NAME[key]}`, def: 0.5, value: p[key], onChange: (v) => this.set(key, v), ...o });
    const db = (v, max) => { if (v <= 0) return '−∞'; const g = v >= 0.5 ? (max * (v - 0.5)) / 0.5 : 20 * Math.log10((2 * v) ** 3); return `${g >= 0 ? '+' : '−'}${Math.abs(g).toFixed(1)}`; };
    this.knobs = {
      trim: knob('trim', { format: (v) => db(v, 12) }),
      'eq.hi': knob('eq.hi', { format: (v) => db(v, 6) }),
      'eq.mid': knob('eq.mid', { format: (v) => db(v, 6) }),
      'eq.low': knob('eq.low', { format: (v) => db(v, 6) }),
      filter: knob('filter', { min: -1, max: 1, def: 0, bipolar: true, format: (v) => (Math.abs(v) < 0.04 ? 'OFF' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`) }),
      'filter.res': knob('filter.res', { def: 0.3, format: (v) => `${Math.round(v * 100)}%` }),
      'fx.level': knob('fx.level', { def: 0.5, format: (v) => `${Math.round(v * 100)}%` }),
    };
    // On-air fader: no wheel (a stray scroll must not cut a deck) and no double-click jump to full.
    this.fader = new Fader(this.q('[data-ctl="fader"]'), { label: `Deck ${d.slot} channel fader`, def: 1, value: p.fader, ticks: [0, 0.25, 0.5, 0.75, 1], wheel: false, reset: false, onChange: (v) => this.set('fader', v), format: (v) => `${Math.round(v * 100)}%` });
    this.pitch = new Fader(this.q('[data-ctl="pitch"]'), {
      orientation: 'horizontal', label: `Deck ${d.slot} tempo`, min: -1, max: 1, def: 0, value: p.range ? p.pitch / p.range : 0, center: true, readout: true,
      step: 0.005, fine: 0.0005,
      format: (v) => fmtPct(v * this.d.params.range),
      onChange: (v) => this.set('pitch', v * this.d.params.range),
    });
    for (const band of ['hi', 'mid', 'low']) {
      const el = this.q(`[data-kill="${band}"]`);
      const pad = bindPad(el, { latch: true, onDown: () => this.set(`kill.${band}`, true, true), onUp: () => this.set(`kill.${band}`, false), onLatch: () => this.set(`kill.${band}`, true) });
      this[`kill_${band}`] = pad;
    }
    this.fxOn = bindPad(this.q('[data-pad="fx.on"]'), { latch: true, onDown: () => this.set('fx.on', true, true), onUp: () => this.set('fx.on', false), onLatch: () => this.set('fx.on', true) });
    this.segs = {
      'fx.type': bindSeg(this.q('[data-seg="fx.type"]'), { onSelect: (v) => this.set('fx.type', v) }),
      'fx.beats': bindSeg(this.q('[data-seg="fx.beats"]'), { onSelect: (v) => this.set('fx.beats', v) }),
      xf: bindSeg(this.q('[data-seg="xf"]'), { onSelect: (v) => this.set('xf', v) }),
    };
    this.rolls = $$('[data-roll]', this.el).map((el) => bindPad(el, {
      latch: false,
      onDown: () => this.rollDown(el, Number(el.dataset.roll)),
      onUp: () => this.rollUp(el),
    }));
    // The CUE light is engine state (render): a press-time paint would fight the next snapshot.
    this.cue = bindPad(this.refs.cue, { latch: false, paint: false, onDown: () => this.act('cueDown'), onUp: () => this.act('cueUp') });
    for (const [sel, dir] of [['[data-hold="nudge-"]', -1], ['[data-hold="nudge+"]', 1]]) {
      // Shift = fine ±1% (spec §3.3), like the arrow keys. Registered before bindPad so the press sees it.
      const el = this.q(sel);
      let fine = false;
      const shift = (e) => { fine = e.shiftKey; };
      el.addEventListener('pointerdown', shift);
      el.addEventListener('keydown', shift);
      bindPad(el, { latch: false, onDown: () => this.act('nudge', { dir, fine }), onUp: () => this.act('nudge', { dir: 0 }) });
    }
    const on = (sel, fn) => this.q(sel).addEventListener('click', fn);
    on('[data-act="playToggle"]', () => this.act('playToggle'));
    on('[data-act="sync"]', () => this.act('sync', { on: !this.d.sync.on }));
    on('[data-act="master"]', () => this.act('master'));
    on('[data-act="syncPlay"]', () => this.act('syncPlay'));
    on('[data-act="live"]', () => this.act('live'));
    on('[data-act="half"]', () => this.act('mult', { factor: 0.5 }));
    on('[data-act="double"]', () => this.act('mult', { factor: 2 }));
    // TAP is stamped at the press: a release-time stamp would put the grid late by the click length.
    const tapBtn = this.q('[data-act="tap"]');
    const tap = (e) => (e.shiftKey ? this.act('tap1') : this.act('tap', { wallMs: performance.timeOrigin + e.timeStamp }));
    tapBtn.addEventListener('pointerdown', (e) => { if (e.button === 0) tap(e); });
    tapBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) tap(e); } });
    on('[data-act="gridBack"]', (e) => this.act('gridShift', e.shiftKey ? { ms: -10 } : { beats: -0.5 }));
    on('[data-act="gridFwd"]', (e) => this.act('gridShift', e.shiftKey ? { ms: 10 } : { beats: 0.5 }));
    on('[data-act="keyLock"]', () => this.set('keyLock', !this.d.params.keyLock));
    on('[data-act="syncMode"]', () => this.set('syncMode', this.d.params.syncMode === 'BEAT' ? 'TEMPO' : 'BEAT'));
    on('[data-act="clipReset"]', () => this.act('clipReset')); // deck meter: clear its clip light (spec §3.7)
    on('[data-act="range"]', () => {
      const i = PITCH_RANGES.indexOf(this.d.params.range);
      this.set('range', PITCH_RANGES[(i + 1) % PITCH_RANGES.length]);
    });
    // REC starts on one press; stopping needs a 600 ms hold so a slip never splits a recording.
    this.recHold = bindHold(this.refs.rec, {
      ms: 600,
      needsHold: () => this.d.rec.state === 'recording',
      onPress: () => (this.d.rec.state === 'finalizing' ? this.toast('Still saving the last recording of this deck.', 'info') : this.act('recStart')),
      onHold: () => this.act('recStop'),
      onShort: () => this.toast('Hold REC (or R) to stop the deck recording.', 'info'),
    });
    // Eject needs a 500 ms hold: a stray click must never kill a playing deck.
    bindHold(this.q('[data-act="eject"]'), { ms: 500, onHold: () => this.act('eject'), onShort: () => this.toast('Hold the eject button to unload this deck.', 'info') });
  }

  /** Rolls held by keys and pads, newest last: releasing one falls back to the newest still held. */
  rollDown(src, beats) {
    this.rollHeld = this.rollHeld.filter((h) => h.src !== src);
    this.rollHeld.push({ src, beats });
    this.act('rollStart', { beats });
  }
  rollUp(src) {
    const i = this.rollHeld.findIndex((h) => h.src === src);
    if (i < 0) return;
    const wasNewest = i === this.rollHeld.length - 1;
    this.rollHeld.splice(i, 1);
    if (!this.rollHeld.length) this.act('rollEnd');
    else if (wasNewest) this.act('rollStart', { beats: this.rollHeld[this.rollHeld.length - 1].beats });
  }

  /** Keyboard entry points (Task 13 keys.js). */
  toggle(name) {
    if (name.startsWith('kill.')) this.set(name, !this.d.params[name]);
    else if (name === 'keyLock') this.set('keyLock', !this.d.params.keyLock);
  }
  /** From the tempo fader's local value, so key repeats never build on a stale snapshot. */
  nudgePitch(delta) {
    const r = this.d.params.range;
    if (r) this.pitch.commit(this.pitch.value + delta / r);
  }

  /**
   * Every snapshot is stored; the DOM follows once per animation frame (frame()), with the latest
   * one, so snapshots a busy main thread delivers back to back cost one render. Hidden pages get
   * no frames: they catch up when they show.
   */
  update(d, s) {
    this.d = d;
    this.stale = true;
  }

  /** Writes only what changed (spec §3.9): at 30 Hz per deck, same-value attribute writes add up. */
  render() {
    const d = this.d;
    this.stale = false;
    const r = this.refs, p = d.params;
    setAttr(this.el, 'data-tstate', d.bpm.state);
    const title = d.title || `Tab ${d.tabId}`;
    setText(r.title, title);
    setAttr(r.title, 'title', d.title || ''); // the full title on hover, over the title only
    setAttr(this.el, 'aria-label', `Deck ${d.slot}: ${title}`);
    if (isSafeIconUrl(d.favIconUrl)) { if (r.fav.getAttribute('src') !== d.favIconUrl) r.fav.src = d.favIconUrl; setHidden(r.fav, false); }
    else setHidden(r.fav, true);

    const out = d.bpm.out;
    if (out == null) this.shownBpm = null;
    else if (this.shownBpm == null || Math.abs(out - this.shownBpm) >= 0.07) this.shownBpm = out;
    setText(r.bpm, fmtBpm(this.shownBpm));
    setText(r.wbpm, fmtBpm(this.shownBpm));
    setText(r.tstate, d.bpm.tapped ? 'TAP' : d.bpm.state);
    setClass(r.tstate, `badge ${d.bpm.tapped ? 'ok' : STATE_CLASS[d.bpm.state] || ''}`);
    setText(r.pitch, fmtPct(p.pitch));
    setText(r.native, d.bpm.native ? `orig ${fmtBpm(d.bpm.native)}${d.bpm.mult !== 1 ? ` ×${d.bpm.mult}` : ''}` : '');

    const resFrac = Math.min(1, d.reserve / 30);
    setStyle(r.reserveFill, 'width', `${(resFrac * 100).toFixed(1)}%`);
    setText(r.reserveText, `${d.reserve.toFixed(1)}s`);
    r.reserve.classList.toggle('low', d.reserve < 4);
    setHidden(r.assist, !(d.assist.active || (!d.assist.available && d.sync.on && d.engineRate > 1)));
    setText(r.assist, d.assist.active ? `ASSIST ${d.assist.sourceRate.toFixed(3)}×` : 'ASSIST n/a');
    setClass(r.assist, `badge ${d.assist.active ? 'info' : 'warn'}`);
    setHidden(r.starved, !d.starved);

    const running = d.playing && !d.previewing; // a CUE preview is not a play: PLAY keeps it going
    toggleAttr(r.play, 'aria-pressed', running);
    setAttr(r.playIcon, 'href', running ? '#i-pause' : '#i-play');
    setAttr(r.play, 'aria-label', running ? 'Pause' : 'Play');
    // CUE is lit while it previews and while the deck sits paused at the cue point.
    r.cue.classList.toggle('on', d.previewing || (!d.playing && Math.abs(d.playhead - d.cue) < 0.03));
    toggleAttr(r.sync, 'aria-pressed', d.sync.on);
    r.sync.classList.toggle('oor', d.sync.on && d.sync.outOfRange);
    setAttr(r.sync, 'title', d.sync.outOfRange ? 'Tempo is outside the pitch range: widen the range for a full sync' : '');
    toggleAttr(r.master, 'aria-pressed', d.sync.isMaster);
    toggleAttr(r.keyLock, 'aria-pressed', p.keyLock);
    setText(r.syncMode, p.syncMode);
    setText(r.range, RANGE_LABEL[p.range] || '±10');
    const recording = d.rec.state === 'recording';
    toggleAttr(r.rec, 'aria-pressed', recording);
    const saving = d.rec.state === 'finalizing';
    if (r.rec.disabled !== saving) r.rec.disabled = saving;
    setText(r.recLabel, saving ? 'SAVING' : 'REC');
    setText(r.recTime, d.rec.state === 'idle' ? '' : fmtClock(d.rec.seconds));

    for (const k of Object.keys(this.knobs)) this.knobs[k].set(p[k]);
    this.fader.set(p.fader);
    this.pitch.set(p.range ? p.pitch / p.range : 0);
    for (const band of ['hi', 'mid', 'low']) this[`kill_${band}`].setOn(p[`kill.${band}`]);
    this.fxOn.setOn(p['fx.on']);
    for (const k of Object.keys(this.segs)) this.segs[k].set(p[k]);

    setHidden(r.phase, !(d.sync.on && d.sync.phaseMs != null && !d.sync.isMaster));
    if (!r.phase.hidden && d.grid) {
      const half = (d.grid.T * 1000) / Math.max(0.25, d.engineRate) / 2;
      const f = Math.max(-1, Math.min(1, d.sync.phaseMs / half));
      setStyle(r.phaseDot, 'left', `${(50 + f * 50).toFixed(1)}%`);
      r.phase.classList.toggle('locked', Math.abs(d.sync.phaseMs) < 10);
    }
    this.meter.update([d.meter]);
  }

  addWave(m) { this.store.add(m); }

  setSelected(on) { this.el.classList.toggle('selected', on); this.waveRow.classList.toggle('selected', on); }

  frame(nowCtx) {
    if (this.stale && !pageHidden()) this.render();
    const d = this.d;
    const dt = Math.max(0, Math.min(0.25, nowCtx - this.snapCtx));
    let playhead = d.playing ? d.playhead + d.engineRate * dt : d.playhead;
    // A roll loops the engine's playhead: the extrapolation wraps inside the loop the same way.
    const lp = d.loop;
    if (lp && lp.end > lp.start && playhead >= lp.end && d.playhead >= lp.start && d.playhead <= lp.end) {
      playhead = lp.start + ((playhead - lp.start) % (lp.end - lp.start));
    }
    const c = this.refs.wave, dpr = window.devicePixelRatio || 1, size = cssSize(c); // no layout read per frame
    const W = Math.max(1, Math.round(size.w * dpr)), H = Math.max(1, Math.round(size.h * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    drawWave(this.waveCtx, {
      w: W, h: H, store: this.store, playhead, grid: d.grid, cue: d.cue, liveEdge: d.liveEdge, historyStart: d.historyStart,
      loop: d.loop, color: this.color, pxPerBeat: 56 * dpr, pxPerSec: 110 * dpr, playing: d.playing,
    });
    // Beat LEDs: current beat of the bar (beat 1 white when TAP 1 set the downbeat).
    const b = beatIndex(d.grid, playhead);
    const ref = d.grid && d.grid.bar1 != null ? Math.round((d.grid.bar1 - d.grid.t0) / d.grid.T) : 0;
    const beatInBar = (((b - ref) % 4) + 4) % 4;
    this.refs.leds.forEach((led, i) => {
      const lit = !!d.grid && i === beatInBar;
      led.classList.toggle('on', lit);
      led.classList.toggle('one', lit && i === 0 && d.grid.bar1 != null);
    });
    this.meter.draw();
  }

  setSnapshotTime(ctxTime) { this.snapCtx = ctxTime; }

  destroy() {
    document.removeEventListener('visibilitychange', this.onVisible);
    forgetSize(this.refs.wave); forgetSize(this.meter.c);
    this.el.remove(); this.waveRow.remove();
  }
}
