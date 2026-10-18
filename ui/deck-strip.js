// ui/deck-strip.js — one deck: its column in the board and its row in the waveform stack.
// All page-derived text goes through textContent; favicons are only set after isSafeIconUrl().
import { DECK_COLORS, PITCH_RANGES, JUMP_BEATS, MAX_BEND, isSafeIconUrl, parseTypedBpm } from '../shared/protocol.js';
import { $, $$, clamp, clone, setText, toggleAttr, setAttr, setHidden, setClass, setStyle, pageHidden, cssSize, forgetSize, fmtBpm, fmtPct, fmtClock, fmtTime } from './util.js';
import { Knob, Fader, bindPad, bindSeg } from './controls.js';
import { WaveStore, drawWave, drawOverview, beatIndex } from './waveform.js';
import { VMeter } from './meters.js';
import { bindHold } from './hold.js';

const RANGE_LABEL = { 0.06: '±6', 0.1: '±10', 0.16: '±16', 0.5: 'WIDE' };
const STATE_CLASS = { LOCKED: 'ok', SEARCH: '', UNSURE: 'warn', HOLD: 'info' };
// Screen-reader names for the knobs, after "Deck N" (the visible labels are terse).
const KNOB_NAME = { trim: 'gain', filter: 'filter', 'filter.res': 'filter resonance', 'eq.hi': 'EQ high', 'eq.mid': 'EQ mid', 'eq.low': 'EQ low', 'fx.level': 'FX level' };
const PX_PER_BEAT = 56, PX_PER_SEC = 110; // zoomed waveform scale, CSS px (with a grid: per beat)
// Jog (drag the waveform of a playing deck): the tempo bends with the drag's speed, like the edge
// of a jog wheel: 400 px/s is a 4 % bend. Measured over the last JOG_WINDOW ms, sent in 0.5 % steps.
const JOG_GAIN = 1e-4, JOG_STEP = 0.005, JOG_WINDOW = 80;
// A drag's local playhead is shown until the engine's snapshot has had time to land the seek.
const NAV_SETTLE = 150;
// What a deck is, in its header: a whole track, a live tab, or a track on its way (or one that failed to arrive).
const KIND = {
  resident: ['TRACK', 'ok', 'Whole track: the deck holds all of it, so its tab no longer matters'],
  live: ['LIVE', '', 'Live: the deck plays its tab as the tab plays, so the tab has to keep playing'],
  loading: ['LOADING', 'info', 'Loading the whole track'],
  failed: ['FAILED', 'warn', 'The track could not be loaded'],
};
// The only presses a loading deck takes.
const LOADING_ACTS = new Set(['eject', 'loadCancel']);
/** The input span a deck can be moved through: a whole-track deck's track, else what it has buffered. */
const navSpan = (d) => (d.kind === 'resident' && d.duration > 0 ? [0, d.duration] : [d.historyStart, d.liveEdge]);

export class DeckStrip {
  constructor(d, { conn, toast, onSelect, onLeave = () => {} }) {
    this.id = d.id;
    this.conn = conn;
    this.toast = toast;
    this.onLeave = onLeave;
    this.leaving = false; // ✕ or eject sent: the deck is on its way out
    this.d = d;
    this.shownBpm = null;
    this.rollHeld = [];
    this.nudgeHeld = [];
    this.jumpBeats = 4;
    this.nav = null;    // a seek the hand made, shown at once: {pos, at, dragging, sentAt}
    this.seekQ = null;  // the latest seek of a drag, sent once per frame
    this.seekRaf = 0;
    this.jog = null;    // a jog bend in progress
    this.inert = d.kind === 'loading'; // a loading deck takes nothing but eject and cancel
    this.shownInert = false;
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
      reserve: this.q('.reserve'), assist: $('[data-assist]', this.waveRow), starved: $('[data-starved]', this.waveRow),
      jumpBack: this.q('[data-act="jumpBack"]'), jumpFwd: this.q('[data-act="jumpFwd"]'), jumpSize: this.q('[data-act="jumpSize"]'),
      nudgeBack: this.q('[data-hold="nudge-"]'), nudgeFwd: this.q('[data-hold="nudge+"]'),
      ov: $('[data-overview]', this.waveRow), jogHint: $('[data-jog-hint]', this.waveRow),
      phase: this.q('[data-phase]'), phaseDot: this.q('[data-phase-dot]'),
      play: this.q('[data-act="playToggle"]'), playIcon: this.q('[data-play-icon] use'),
      cue: this.q('[data-hold="cue"]'), sync: this.q('[data-act="sync"]'), master: this.q('[data-act="master"]'),
      keyLock: this.q('[data-act="keyLock"]'), syncMode: this.q('[data-act="syncMode"]'), range: this.q('[data-act="range"]'),
      rec: this.q('[data-act="rec"]'), recLabel: this.q('[data-act="rec"] span'), recTime: this.q('[data-rec-time]'),
      wslot: $('[data-slot]', this.waveRow), wbpm: $('[data-wbpm]', this.waveRow), wave: $('[data-wave]', this.waveRow),
      kind: this.q('[data-kind]'), kindWord: this.q('[data-kind-word]'), kindPct: this.q('[data-kind-pct]'), loadRow: this.q('[data-load-row]'), loadLine: this.q('[data-load-line]'), cancel: this.q('[data-act="loadCancel"]'),
      report: this.q('[data-report]'), reportBtn: this.q('[data-report-btn]'), reportMenu: this.q('[data-report-menu]'), recWhole: this.q('[data-record-whole]'),
      copyNow: this.q('.deck-status [data-copy-report]'), jump: this.q('.jump'), time: this.q('[data-time]'),
      live: this.q('[data-act="live"]'), bar1: this.q('[data-act="bar1"]'),
    };
    setText(this.refs.slot, d.slot);
    setText(this.refs.wslot, d.slot);
    this.waveCtx = this.refs.wave.getContext('2d');
    this.ovCtx = this.refs.ov.getContext('2d');
    setAttr(this.refs.ov, 'aria-label', `Deck ${d.slot} buffer overview: click or drag to move the playhead`);
    setAttr(this.refs.cancel, 'aria-label', `Cancel loading deck ${d.slot}`);
    this.meter = new VMeter(this.q('[data-meter]'));
    this.buildControls(d);
    this.render();
    this.onVisible = () => { if (this.stale && !pageHidden()) this.render(); };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  set(key, value, hold) { if (!this.inert) this.conn.set(this.id, key, value, hold); }
  async act(a, arg) {
    if (this.inert && !LOADING_ACTS.has(a)) return { ok: false }; // the engine would refuse it with an error toast
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
    // Fine moves (Shift-drag, Shift-wheel, Shift-arrows) step a 128 BPM deck by at most 0.03 BPM at ±10%.
    this.pitch = new Fader(this.q('[data-ctl="pitch"]'), {
      orientation: 'horizontal', label: `Deck ${d.slot} tempo`, min: -1, max: 1, def: 0, value: p.range ? p.pitch / p.range : 0, center: true, readout: true,
      step: 0.005, fine: 0.0005, fineDrag: 0.002,
      format: (v) => this.fmtTempo(v * this.d.params.range),
      onChange: (v) => this.set('pitch', v * this.d.params.range),
    });
    // The BPM and ORIG readouts take a typed tempo (click, tap, or Enter): the one to play at, and the track's own.
    const entry = (el, value, action, label) => {
      const open = () => this.editTempo(el, value(), action, label);
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); open(); } });
    };
    entry(this.refs.bpm, () => this.shownBpm, 'setBpm', `Deck ${d.slot}: tempo to play at`);
    entry(this.refs.native, () => this.d.bpm.native, 'setNativeBpm', `Deck ${d.slot}: original tempo of the track`);
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
      bindPad(el, { latch: false, onDown: () => this.nudgeDown(el, dir, fine), onUp: () => this.nudgeUp(el) });
    }
    const on = (sel, fn) => this.q(sel).addEventListener('click', fn);
    on('[data-act="playToggle"]', () => this.act('playToggle'));
    on('[data-act="sync"]', () => this.act('sync', { on: !this.d.sync.on }));
    on('[data-act="master"]', () => this.act('master'));
    on('[data-act="syncPlay"]', () => this.act('syncPlay'));
    on('[data-act="live"]', () => this.act('live'));
    on('[data-act="loadCancel"]', () => this.leave('loadCancel'));
    // The whole-track analysis's bar 1, offered while the grid has none: TAP 1 there.
    on('[data-act="bar1"]', () => { const b = this.d.analysis && this.d.analysis.bar1; if (b) this.act('tap1', { t: b.t }); });
    for (const el of $$('[data-copy-report]', this.el)) el.addEventListener('click', () => { this.closeReportMenu(true); this.copyReport(); });
    // A live deck whose bytes could not be had: record the track from the tab at 2× instead (spec §4.4), only when asked.
    this.refs.recWhole.addEventListener('click', () => { this.closeReportMenu(true); this.act('recordWhole'); });
    this.bindReportMenu();
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
    on('[data-act="jumpBack"]', () => this.beatJump(-1));
    on('[data-act="jumpFwd"]', () => this.beatJump(1));
    on('[data-act="jumpSize"]', (e) => this.jumpSize(e.shiftKey ? -1 : 1, true));
    this.renderJump();
    this.bindOverview();
    this.bindWaveDrag();
    // One click must never slam a deck that is on air: the cycle steps past any range too narrow
    // to hold the tempo the deck is at (the engine refuses such a change anyway), and when none
    // can hold it the DJ is told instead of the button quietly doing nothing.
    on('[data-act="range"]', () => {
      const p = this.d.params, n = PITCH_RANGES.length, i = PITCH_RANGES.indexOf(p.range);
      for (let k = 1; k <= n; k++) {
        const r = PITCH_RANGES[(i + k) % n];
        if (r === p.range) break;
        if (Math.abs(p.pitch) <= r + 1e-9) { this.set('range', r); return; }
      }
      this.toast(`Tempo is ${fmtPct(p.pitch)}: no other pitch range can hold it. Move the tempo fader first.`, 'warn');
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
    bindHold(this.q('[data-act="eject"]'), { ms: 500, onHold: () => this.leave('eject'), onShort: () => this.toast('Hold the eject button to unload this deck.', 'info') });
    // A loading deck is inert but for its header (eject, load report) and its cancel: a press on anything else
    // stops here, before the control's own handlers (keys are stopped in act() and set()).
    this.inertEls = [...$$('button, [role="slider"], [role="button"]', this.el).filter((el) => !el.closest('.deck-head, [data-load-row]') && !el.hasAttribute('data-copy-report')), this.refs.ov, this.refs.wave];
    const guard = (e) => {
      if (!this.inert || !(e.target instanceof Element) || !e.target.closest('[aria-disabled="true"]')) return;
      e.stopPropagation();
      if (e.type !== 'keydown' && e.type !== 'wheel') e.preventDefault(); // Tab still moves on, the page still scrolls
    };
    for (const type of ['pointerdown', 'click', 'dblclick', 'wheel', 'keydown']) this.el.addEventListener(type, guard, true);
  }

  /** ✕ or a held eject, which the DJ asked for: once, as a second press would only hear that the deck is gone. */
  async leave(a) {
    if (this.leaving) return;
    this.leaving = true;
    this.onLeave(this.id);
    const r = await this.act(a);
    if (!r.ok) this.leaving = false;
  }

  /**
   * The ⓘ menu of a deck with a load report: a plain list of buttons (the page has no role="menu" menus).
   * Escape, a click elsewhere, focus leaving it or using one of its buttons closes it; Escape and a button give focus back to the ⓘ.
   */
  bindReportMenu() {
    const r = this.refs;
    this.onMenuAway = (e) => {
      if (e.type === 'keydown' ? e.key === 'Escape' : !r.report.contains(e.target)) this.closeReportMenu(e.type === 'keydown');
    };
    r.reportBtn.addEventListener('click', () => (r.reportMenu.hidden ? this.openReportMenu() : this.closeReportMenu()));
    r.report.addEventListener('focusout', (e) => { if (!r.report.contains(e.relatedTarget)) this.closeReportMenu(); });
  }

  openReportMenu() {
    const r = this.refs;
    setHidden(r.reportMenu, false);
    this.placeReportMenu();
    setAttr(r.reportBtn, 'aria-expanded', 'true');
    r.reportMenu.querySelector('button').focus();
    document.addEventListener('pointerdown', this.onMenuAway, true);
    document.addEventListener('keydown', this.onMenuAway, true);
  }

  /**
   * The menu hangs from the ⓘ's right edge; where that would run off the left of the deck row (the leftmost
   * deck) it hangs from its left edge instead, and it is kept inside the row and the window either way.
   */
  placeReportMenu() {
    const m = this.refs.reportMenu, row = this.el.parentElement || document.documentElement;
    m.style.translate = '';
    const b = m.getBoundingClientRect(), rb = row.getBoundingClientRect(), x0 = rb.left + row.clientLeft;
    const lo = Math.max(0, x0) + 4, hi = Math.min(document.documentElement.clientWidth, x0 + row.clientWidth) - 4;
    const left = clamp(b.left < lo ? this.refs.report.getBoundingClientRect().left : b.left, lo, Math.max(lo, hi - b.width));
    if (Math.abs(left - b.left) > 0.5) m.style.translate = `${left - b.left}px 0`;
  }

  closeReportMenu(refocus = false) {
    const r = this.refs;
    if (r.reportMenu.hidden) return;
    setHidden(r.reportMenu, true);
    setAttr(r.reportBtn, 'aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onMenuAway, true);
    document.removeEventListener('keydown', this.onMenuAway, true);
    if (refocus) r.reportBtn.focus();
  }

  /** The load report to the clipboard: how a real site's failure gets back to be fixed. The deck page is an extension page. */
  async copyReport() {
    const d = this.d, l = d.load || {};
    const text = l.report || ['JD Samps load report', `Deck ${d.slot}: ${d.title || ''}`, d.url, l.strategy && `Step: ${l.strategy}`, l.error && `Error: ${l.error}`].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.toast(`Deck ${d.slot}: load report copied.`, 'info');
    } catch (_) {
      this.toast('Could not copy the load report.', 'warn');
    }
  }

  /** Tempo fader readout: the percentage, and the BPM it plays at once the deck has one. */
  fmtTempo(pitch) {
    const n = this.d.bpm.native;
    return n ? `${fmtPct(pitch)} · ${fmtBpm(n * (1 + pitch))}` : fmtPct(pitch);
  }

  /**
   * Type a tempo in place of a readout: an input of the same size takes its place (the layout does
   * not move). Enter sends `action`, junk is refused with a toast, Escape or blur cancels.
   */
  editTempo(el, value, action, label) {
    if (el.hidden) return;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const input = document.createElement('input');
    Object.assign(input, { type: 'text', inputMode: 'decimal', className: 'tempo-edit', autocomplete: 'off', spellcheck: false, value: value ? value.toFixed(1) : '' });
    input.setAttribute('aria-label', label);
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textAlign']) input.style[k] = cs[k];
    input.style.width = `${r.width}px`;
    input.style.height = `${r.height}px`;
    el.hidden = true;
    el.after(input);
    input.focus();
    input.select();
    let open = true;
    const close = (refocus) => {
      if (!open) return;
      open = false;
      input.remove();
      el.hidden = false;
      if (refocus) el.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const t = parseTypedBpm(input.value);
      if (!t.ok) { this.toast(t.error, 'warn'); input.select(); return; }
      close(true);
      this.conn.flush(); // a tempo fader move still queued must not land after the typed tempo
      this.act(action, { bpm: t.bpm });
    });
    input.addEventListener('blur', () => close(false));
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

  /** Nudges held by keys and pads, newest last: releasing one falls back to the newest still held. */
  nudgeDown(src, dir, fine) {
    this.nudgeHeld = this.nudgeHeld.filter((h) => h.src !== src);
    this.nudgeHeld.push({ src, dir, fine });
    this.act('nudge', { dir, fine });
  }
  nudgeUp(src) {
    const i = this.nudgeHeld.findIndex((h) => h.src === src);
    if (i < 0) return;
    const wasNewest = i === this.nudgeHeld.length - 1;
    this.nudgeHeld.splice(i, 1);
    const top = this.nudgeHeld[this.nudgeHeld.length - 1];
    if (!top) this.act('nudge', { dir: 0 });
    else if (wasNewest) this.act('nudge', { dir: top.dir, fine: top.fine });
  }

  // ---------------------------------------------------------------- navigation
  /** Beat jump back (-1) or forward (1) by the size set on this deck. */
  beatJump(dir) { return this.act('beatJump', { beats: dir * this.jumpBeats }); }

  /** Step the beat-jump size through JUMP_BEATS: the button wraps round, the keys stop at the ends. */
  jumpSize(step, wrap = false) {
    const n = JUMP_BEATS.length, i = Math.max(0, JUMP_BEATS.indexOf(this.jumpBeats));
    this.jumpBeats = JUMP_BEATS[wrap ? (i + step + n) % n : clamp(i + step, 0, n - 1)];
    this.renderJump();
  }

  renderJump() {
    const r = this.refs, b = this.jumpBeats, beats = `${b} beat${b === 1 ? '' : 's'}`;
    setText(r.jumpSize, b);
    setAttr(r.jumpSize, 'aria-label', `Beat jump size: ${beats}`);
    setAttr(r.jumpBack, 'aria-label', `Beat jump back ${beats}`);
    setAttr(r.jumpFwd, 'aria-label', `Beat jump forward ${beats}`);
  }

  /**
   * Move the playhead to input position pos. It is shown there at once; the engine gets the latest
   * position once per frame while a drag streams them (now: at once, as a drag ends).
   */
  seekTo(pos, now = false) {
    this.nav = { pos, at: performance.now(), dragging: !!(this.nav && this.nav.dragging), sentAt: this.nav ? this.nav.sentAt : 0 };
    this.seekQ = pos;
    if (now) this.flushSeek();
    else if (!this.seekRaf) this.seekRaf = requestAnimationFrame(() => { this.seekRaf = 0; this.flushSeek(); });
  }

  flushSeek() {
    if (this.seekRaf) { cancelAnimationFrame(this.seekRaf); this.seekRaf = 0; }
    if (this.seekQ == null) return;
    const pos = this.seekQ;
    this.seekQ = null;
    if (this.nav) this.nav.sentAt = performance.now();
    this.act('seek', { pos }).then((r) => { if (!r.ok && this.nav && !this.nav.dragging) this.nav = null; });
  }

  /** A pointer drag on el: onMove(ev) for each move, onEnd() once on release, cancel or lost capture. */
  drag(el, e, onMove, onEnd) {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    const id = e.pointerId;
    const move = (ev) => { if (ev.pointerId === id) onMove(ev); };
    const end = (ev) => {
      if (ev.pointerId !== id) return;
      for (const [type, fn] of handlers) el.removeEventListener(type, fn);
      this.waveRow.classList.remove('dragging');
      onEnd();
    };
    const handlers = [['pointermove', move], ['pointerup', end], ['pointercancel', end], ['lostpointercapture', end]];
    for (const [type, fn] of handlers) el.addEventListener(type, fn);
    this.waveRow.classList.add('dragging');
  }

  /** The overview: click or drag to move the playhead anywhere in the buffer (needle search). */
  bindOverview() {
    const c = this.refs.ov;
    const posAt = (ev) => {
      const [lo, hi] = navSpan(this.d), w = Math.max(1, cssSize(c).w);
      return lo + clamp(ev.offsetX / w, 0, 1) * Math.max(0, hi - lo);
    };
    c.addEventListener('pointerdown', (e) => {
      const [lo, hi] = navSpan(this.d);
      if (e.button !== 0 || this.inert || !(hi > lo)) return;
      this.nav = { pos: posAt(e), at: performance.now(), dragging: true, sentAt: 0 };
      this.seekTo(posAt(e));
      this.drag(c, e, (ev) => this.seekTo(posAt(ev)), () => { if (this.nav) this.nav.dragging = false; this.flushSeek(); });
    });
  }

  /**
   * The zoomed waveform, with CDJ jog semantics. Paused (or previewing), a horizontal drag moves
   * the playhead: the waveform follows the hand under the fixed centre line. Playing, the drag
   * bends the tempo with its speed, like the edge of a jog wheel: with the scroll (left) faster,
   * against it (right) slower, back to normal when the hand stops or lets go.
   */
  bindWaveDrag() {
    const c = this.refs.wave;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.inert) return;
      const d = this.d;
      if (this.jogMode(d) === 'seek') {
        const x0 = e.clientX, p0 = this.shownPlayhead ?? d.playhead;
        const spp = d.grid ? d.grid.T / PX_PER_BEAT : 1 / PX_PER_SEC; // input s per CSS px, as drawn
        this.nav = { pos: p0, at: performance.now(), dragging: true, sentAt: 0 };
        this.drag(c, e, (ev) => this.seekTo(clamp(p0 - (ev.clientX - x0) * spp, ...navSpan(this.d))),
          () => { if (this.nav) this.nav.dragging = false; this.flushSeek(); });
        return;
      }
      const jog = { samples: [[e.timeStamp, e.clientX]], k: 0, raf: 0 };
      this.jog = jog;
      const tick = () => { if (this.jog === jog) { this.jogTick(); jog.raf = requestAnimationFrame(tick); } };
      jog.raf = requestAnimationFrame(tick);
      this.drag(c, e, (ev) => jog.samples.push([ev.timeStamp, ev.clientX]), () => {
        cancelAnimationFrame(jog.raf);
        this.jog = null;
        if (jog.k) this.act('nudge', { dir: 0 });
        this.renderJogHint();
      });
    });
  }

  /** What a drag on the waveform does now. */
  jogMode(d = this.d) { return d.playing && !d.previewing ? 'bend' : 'seek'; }

  /** The jog's bend from the drag speed over the last JOG_WINDOW ms (none once the hand stops), sent when its 0.5 % step changes. */
  jogTick() {
    const j = this.jog, now = performance.now(), s = j.samples;
    while (s.length > 2 && now - s[1][0] > JOG_WINDOW) s.shift();
    const [t0, x0] = s[0], [t1, x1] = s[s.length - 1];
    const v = s.length > 1 && t1 > t0 && now - t1 < JOG_WINDOW ? (x1 - x0) / ((t1 - t0) / 1000) : 0;
    const max = Math.round(MAX_BEND / JOG_STEP);
    const k = clamp(Math.round((-v * JOG_GAIN) / JOG_STEP), -max, max);
    if (k === j.k) return;
    j.k = k;
    this.act('nudge', k ? { dir: Math.sign(k), amt: Math.abs(k) * JOG_STEP } : { dir: 0 });
    this.renderJogHint();
  }

  renderJogHint() {
    const mode = this.jogMode(), r = this.refs;
    setAttr(r.wave, 'data-jog', mode);
    setAttr(r.wave, 'title', mode === 'bend' ? 'Drag to bend the tempo (jog)' : 'Drag to move the playhead');
    const k = this.jog ? this.jog.k : 0;
    setText(r.jogHint, mode === 'bend' ? (k ? `BEND ${fmtPct(k * JOG_STEP)}` : 'DRAG: BEND TEMPO') : 'DRAG: MOVE PLAYHEAD');
  }

  /** Keyboard entry points (Task 13 keys.js). */
  toggle(name) {
    if (name.startsWith('kill.')) this.set(name, !this.d.params[name]);
    else if (name === 'keyLock') this.set('keyLock', !this.d.params.keyLock);
  }
  /** From the tempo fader's local value, so key repeats never build on a stale snapshot. */
  nudgePitch(delta) {
    const r = this.d.params.range;
    if (r && !this.inert) this.pitch.commit(this.pitch.value + delta / r);
  }

  /**
   * Every snapshot is stored; the DOM follows once per animation frame (frame()), with the latest
   * one, so snapshots a busy main thread delivers back to back cost one render. Hidden pages get
   * no frames: they catch up when they show.
   */
  update(d, s) {
    this.d = d;
    this.inert = d.kind === 'loading';
    this.stale = true;
    // The hand's seek has had time to land (or was refused): the engine's playhead takes over again.
    if (this.nav && !this.nav.dragging && this.seekQ == null && performance.now() - this.nav.sentAt > NAV_SETTLE) this.nav = null;
  }

  /** Writes only what changed (spec §3.9): at 30 Hz per deck, same-value attribute writes add up. */
  render() {
    const d = this.d;
    this.stale = false;
    const r = this.refs, p = d.params;
    setAttr(this.el, 'data-tstate', d.bpm.state);
    const title = d.title || (d.tabId == null ? `Deck ${d.slot}` : `Tab ${d.tabId}`);
    setText(r.title, title);
    setAttr(r.title, 'title', d.title || ''); // the full title on hover, over the title only
    setAttr(this.el, 'aria-label', `Deck ${d.slot}: ${title}`);
    if (isSafeIconUrl(d.favIconUrl)) { if (r.fav.getAttribute('src') !== d.favIconUrl) r.fav.src = d.favIconUrl; setHidden(r.fav, false); }
    else setHidden(r.fav, true);

    this.renderKind(d);

    const out = d.bpm.out;
    if (out == null) this.shownBpm = null;
    else if (this.shownBpm == null || Math.abs(out - this.shownBpm) >= 0.07) this.shownBpm = out;
    setText(r.bpm, fmtBpm(this.shownBpm));
    setText(r.wbpm, fmtBpm(this.shownBpm));
    setText(r.tstate, d.bpm.tapped ? (d.bpm.manual === 'typed' ? 'SET' : 'TAP') : d.bpm.state);
    setClass(r.tstate, `badge ${d.bpm.tapped ? 'ok' : STATE_CLASS[d.bpm.state] || ''}`);
    setText(r.pitch, fmtPct(p.pitch));
    setText(r.native, `orig ${fmtBpm(d.bpm.native)}${d.bpm.native && d.bpm.mult !== 1 ? ` ×${d.bpm.mult}` : ''}`);

    const resFrac = Math.min(1, d.reserve / 30);
    setStyle(r.reserveFill, 'width', `${(resFrac * 100).toFixed(1)}%`);
    setText(r.reserveText, `${d.reserve.toFixed(1)}s`);
    r.reserve.classList.toggle('low', d.reserve < 4);
    setHidden(r.assist, !(d.assist.active || (!d.assist.available && d.sync.on && d.engineRate > 1)));
    setText(r.assist, d.assist.active ? `ASSIST ${d.assist.sourceRate.toFixed(3)}×` : 'ASSIST n/a');
    setClass(r.assist, `badge ${d.assist.active ? 'info' : 'warn'}`);
    setHidden(r.starved, !d.starved);

    const running = d.playing && !d.previewing; // a CUE preview is not a play: PLAY keeps it going
    // Paused, the nudge buttons search (the engine decides; the labels say which).
    for (const [el, way] of [[r.nudgeBack, 'back'], [r.nudgeFwd, 'forward']]) {
      const label = d.playing ? `Nudge ${way} (hold)` : `Search ${way} (hold, faster the longer)`;
      setAttr(el, 'aria-label', label);
      setAttr(el, 'title', label);
    }
    this.renderJogHint();
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
    // The readout's BPM follows a new tempo reading too, not only the fader.
    if (this.pitch.readout.textContent !== this.fmtTempo(this.pitch.value * p.range)) this.pitch.render();
    // While SYNC drives the fader it says so: moving it turns SYNC off.
    const locked = d.sync.on && !d.sync.isMaster;
    this.pitch.el.classList.toggle('synced', locked);
    setAttr(this.pitch.el, 'title', locked ? 'Locked to SYNC: moving it turns SYNC off' : '');
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

  /** What the deck is (header badge and load line) and what that changes: LIVE, the reserve or the time, inert controls. */
  renderKind(d) {
    const r = this.refs, kind = d.kind || 'live', load = d.load || {}, failed = kind === 'loading' && load.state === 'error';
    const resident = kind === 'resident', [word, cls, tip] = KIND[failed ? 'failed' : kind] || KIND.live;
    setAttr(this.el, 'data-kind', kind);
    const loading = kind === 'loading' && !failed;
    setText(r.kindWord, loading ? `${word} · ` : word);
    setText(r.kindPct, loading ? `${Math.round((load.progress || 0) * 100)}%` : '');
    setClass(r.kind, `badge kind ${cls}`);
    setAttr(r.kind, 'title', tip);
    const line = failed ? load.error || 'The track could not be loaded.' : kind === 'loading' ? load.strategy || 'starting' : '';
    setHidden(r.loadRow, kind !== 'loading');
    setText(r.loadLine, line);
    setAttr(r.loadLine, 'title', line);
    setHidden(r.report, !load.report || failed); // a failed deck shows the copy button itself
    setHidden(r.recWhole, kind !== 'live');
    if (r.report.hidden) this.closeReportMenu();
    setHidden(r.copyNow, !failed);
    setHidden(r.jump, failed);
    setHidden(r.live, resident);
    setHidden(r.reserve, resident || failed);
    setHidden(r.time, !resident);
    const b1 = resident && d.analysis && d.analysis.bar1;
    setHidden(r.bar1, !(b1 && d.grid && d.grid.bar1 == null));
    if (b1) setAttr(r.bar1, 'title', `The analysis suggests bar 1 at ${fmtTime(b1.t)}: click to mark it there`);
    if (this.inert !== this.shownInert) {
      this.shownInert = this.inert;
      for (const el of this.inertEls) if (this.inert) el.setAttribute('aria-disabled', 'true'); else el.removeAttribute('aria-disabled');
    }
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
    // A seek the hand just made shows at once, before the engine has landed it (and while a roll holds the audio, the slip it moves is not drawn).
    const nav = this.nav;
    if (nav && !d.roll) playhead = nav.pos + (d.playing ? d.engineRate * Math.min(0.25, (performance.now() - nav.at) / 1000) : 0);
    this.shownPlayhead = playhead;
    const c = this.refs.wave, dpr = window.devicePixelRatio || 1, size = cssSize(c); // no layout read per frame
    const W = Math.max(1, Math.round(size.w * dpr)), H = Math.max(1, Math.round(size.h * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    drawWave(this.waveCtx, {
      w: W, h: H, store: this.store, playhead, grid: d.grid, cue: d.cue, liveEdge: d.liveEdge, historyStart: d.historyStart,
      loop: d.loop, color: this.color, pxPerBeat: PX_PER_BEAT * dpr, pxPerSec: PX_PER_SEC * dpr, playing: d.playing,
    });
    const oc = this.refs.ov, osz = cssSize(oc);
    const OW = Math.max(1, Math.round(osz.w * dpr)), OH = Math.max(1, Math.round(osz.h * dpr));
    if (oc.width !== OW || oc.height !== OH) { oc.width = OW; oc.height = OH; }
    const [lo, hi] = navSpan(d);
    drawOverview(this.ovCtx, {
      w: OW, h: OH, store: this.store, playhead, cue: d.cue, liveEdge: hi, historyStart: lo, loop: d.loop, color: this.color, playing: d.playing,
    });
    // A whole track: elapsed and remaining time (END once it has played out), at the playhead as drawn.
    if (d.kind === 'resident' && d.duration > 0) {
      const p = clamp(playhead, 0, d.duration), end = !d.playing && d.duration - p < 0.05;
      setText(this.refs.time, `${fmtTime(p)} / ${end ? 'END' : `-${fmtTime(d.duration - p)}`}`);
      setClass(this.refs.time, end ? 'time mono end' : 'time mono');
    }
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
    this.closeReportMenu();
    if (this.seekRaf) cancelAnimationFrame(this.seekRaf);
    if (this.jog) cancelAnimationFrame(this.jog.raf);
    forgetSize(this.refs.wave); forgetSize(this.refs.ov); forgetSize(this.meter.c);
    this.el.remove(); this.waveRow.remove();
  }
}
