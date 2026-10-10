// Movie Maker (web) — Player: playback clock, pooled <video> elements, scrubbing and drawing.
//
// - While playing, the master clock is the AudioContext (the sample being heard, so video
//   stays in sync with the sound); a performance.now() clock is used when Web Audio is not
//   running. A requestAnimationFrame loop renders frames through renderer.renderFrame().
// - One muted, playsinline <video> per video item, parked at 1px in `mediaHost` (iOS only
//   decodes reliably when the element is in the document). Videos follow the clock with
//   playbackRate nudging and re-seeks when they drift too far.
// - Paused seeks only draw once the needed videos have finished seeking (with a timeout),
//   and rapid scrubbing is coalesced: each video has at most one seek in flight and only
//   the latest requested time is applied after it.

import { renderFrame, sourceTimeAt } from './renderer.js';
import { ASPECTS } from './model.js';

const FRAME_STEP = 1 / 30;
const PREROLL = 1.0;            // seconds before a video segment starts to park it at its first frame
const IMAGE_AHEAD = 2.5;        // seconds of photos to decode ahead
const DRIFT_RESEEK = 0.25;      // re-seek a playing video when this far off (source seconds)
const DRIFT_SOFT = 0.03;        // nudge playbackRate beyond this
const SEEK_TIMEOUT_MS = 1500;   // paused draw happens anyway after this
const START_WAIT_MS = 1000;     // max wait for videos/audio before the clock starts
const HOLD_MAX_MS = 400;        // max time to keep the previous frame while a source catches up
const RESYNC_MS = 250;          // throttle for rescheduling audio after edits during playback
const STALL_MS = 600;           // audio clock frozen this long → fall back to the wall clock
const END_HOLD = 0.05;          // mirrors renderer: last frame stays visible at t = duration
const MIN_RATE = 0.0625;
const MAX_RATE = 16;
const PENDING = Object.freeze({ width: 0, height: 0 }); // source still decoding → renderer keeps black

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function isCoarsePointer() {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch (_) { return false; }
}

const _warned = new Set();
function warnOnce(key, err) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn('Movie Maker player:', key, err);
}

function makeEvent(type, detail) {
  if (typeof CustomEvent === 'function') return new CustomEvent(type, { detail });
  const e = new Event(type);
  e.detail = detail;
  return e;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function ensureHost(host) {
  if (typeof document === 'undefined') return host || null;
  let el = host || document.getElementById('media-host');
  let created = false;
  if (!el) {
    el = document.createElement('div');
    el.id = 'media-host';
    (document.body || document.documentElement).appendChild(el);
    created = true;
  }
  let hidden = created;
  if (!created) {
    try {
      const cs = getComputedStyle(el);
      hidden = cs.display === 'none' || cs.visibility === 'hidden';
    } catch (_) { hidden = false; }
  }
  if (hidden) {
    // display:none / visibility:hidden parking stops iOS from decoding frames.
    el.style.cssText += ';display:block;visibility:visible;position:fixed;left:0;top:0;width:1px;height:1px;'
      + 'overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';
  }
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export class Player extends EventTarget {
  constructor({ store, audio = null, canvas = null, mediaHost = null } = {}) {
    super();
    if (!store) throw new TypeError('Player needs a store');
    this.store = store;
    this.audio = audio || null;
    this.canvas = null;
    this._ctx = null;
    this._coarse = isCoarsePointer();
    this.mediaHost = ensureHost(mediaHost);

    // playback state
    this._time = 0;
    this._playing = false;
    this._clockRunning = false;
    this._mode = 'perf';
    this._anchorTime = 0;
    this._anchorCtx = 0;
    this._anchorPerf = 0;
    this._lastClock = 0;
    this._stallRef = -1;
    this._stallAt = 0;
    this._playToken = 0;
    this._loopHandle = 0;
    this._loopType = '';
    this._holdSince = 0;
    this._lastPrefetch = 0;
    this._loop = null;
    this._audioSig = '';
    this._audioMix = 0;
    this._lastResync = 0;
    this._resyncTimer = 0;
    this._prepTimer = 0;
    this._pendingSeek = null;   // seek requested while playing, applied on the next frame
    this._lastSeekRestart = 0;
    this._quietTimer = 0;

    // paused drawing
    this._needDraw = false;
    this._drawHandle = 0;
    this._drawType = '';
    this._pendingSince = 0;
    this._pendTimer = 0;
    this._drawWaiters = [];

    // output
    this._output = null;
    this._outCtx = null;
    this._overlay = null;
    this._mirrorTick = 0;
    this._lay = { valid: false, s: 1, fw: 0, fh: 0, ox: 0, oy: 0, bw: 0, bh: 0, bars: false, aspect: '' };
    this._cssW = 0;
    this._cssH = 0;
    this._ro = null;
    this._parentRO = null;
    this._sizeMode = 'box';      // 'box': page sizes the canvas; 'fit': we size it (see _detectSizing)
    this._sizingChecked = false;
    this._parentBox = null;
    this._fitStyle = null;

    // sources
    this._videos = new Map();   // item id → video entry
    this._pool = [];
    this._images = new Map();   // media id → image entry
    this._act = [null, null];
    this._actN = 0;
    this._syncStamp = 0;

    this._getSource = this._getSource.bind(this);
    this._getMedia = (id) => this.store.getMedia(id);
    this._renderOpts = {
      project: null, timeline: null, width: 0, height: 0,
      getSource: this._getSource, getMedia: this._getMedia, quality: 'preview', hideTextIds: null,
    };
    this._audioOpts = { getMedia: this._getMedia, at: undefined };
    this._timeDetail = { time: 0 };
    this._timeEvent = typeof CustomEvent === 'function' ? new CustomEvent('timeupdate', { detail: this._timeDetail }) : null;
    this._dispatchingTime = false;

    this._tick = this._tick.bind(this);
    this._pausedFrame = this._pausedFrame.bind(this);
    this._onStoreChange = this._onStoreChange.bind(this);
    this._onStoreMedia = this._onStoreMedia.bind(this);
    this._onAudioState = this._onAudioState.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onWinResize = this._onWinResize.bind(this);

    store.addEventListener('change', this._onStoreChange);
    store.addEventListener('media', this._onStoreMedia);
    if (this.audio && typeof this.audio.addEventListener === 'function') {
      this.audio.addEventListener('statechange', this._onAudioState);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);

    this._lastDuration = this.duration;
    this.setCanvas(canvas);
    this._scheduleAudioPrepare(50);
  }

  // ---------------------------------------------------------------------------
  // Public API

  get currentTime() {
    if (this._playing && this._clockRunning) {
      const t = this._clock();
      const d = this.duration;
      return t > d ? d : t;
    }
    return this._time;
  }

  get duration() {
    const tl = this.store.timeline;
    return tl && tl.duration > 0 ? tl.duration : 0;
  }

  get playing() { return this._playing; }

  /** The canvas frames are drawn to right now (export canvas while exporting). */
  get output() { return this._output || this.canvas; }

  /** Where the movie frame sits inside the preview canvas, in CSS pixels. */
  get frameRect() {
    const L = this._lay;
    if (!L.valid) return { x: 0, y: 0, width: this._cssW, height: this._cssH };
    return { x: L.ox / L.s, y: L.oy / L.s, width: L.fw, height: L.fh };
  }

  /** Text item ids not to draw (being edited inline over the preview). */
  get hideTextIds() { return this._renderOpts.hideTextIds; }
  set hideTextIds(set) {
    this._renderOpts.hideTextIds = set && (typeof set.has === 'function' || Array.isArray(set)) ? set : null;
    if (!this._playing) this._invalidate(true);
  }

  async play() {
    if (this._playing) return;
    const dur = this.duration;
    if (!(dur > 0)) return;
    let t = this._time;
    const lr = this._loop;
    if (lr) {
      const end = Math.min(lr.end, dur);
      if (t < lr.start - 1e-3 || t >= end - 0.02) t = lr.start < end ? lr.start : 0;
    } else if (t >= dur - 0.02) {
      t = 0; // play at the end starts over
    }
    // Everything up to the first await runs inside the user gesture (needed on iOS).
    let unlockP = null;
    if (this.audio && typeof this.audio.unlock === 'function') {
      try { unlockP = Promise.resolve(this.audio.unlock()).catch(() => false); } catch (_) { unlockP = null; }
    }
    this._time = t;
    this._playing = true;
    this._clockRunning = false;
    const token = ++this._playToken;
    this._cancelPausedDraw();
    this._flushWaiters();
    this._bless(t, token);
    this._emitTime(t);
    this._emit('play');
    const deadline = now() + START_WAIT_MS;
    await Promise.race([
      Promise.all([unlockP, this._waitReady(token, deadline)]),
      delay(START_WAIT_MS + 50),
    ]);
    if (token !== this._playToken || !this._playing) return;
    this._startClock(this._time);
    this._loopNext();
  }

  pause() {
    if (!this._playing) return;
    const t = this._clockRunning ? this._clock() : this._time;
    this._playing = false;
    this._clockRunning = false;
    this._playToken++;
    this._cancelLoop();
    this._clearResync();
    this._clearSeekState();
    if (this.audio) { try { this.audio.stop(); } catch (_) { /* ignore */ } }
    for (const v of this._pool) {
      if (!v.el.paused) { try { v.el.pause(); } catch (_) { /* ignore */ } }
    }
    this._time = clamp(t, 0, this.duration);
    this._emitTime(this._time);
    this._emit('pause');
    this._invalidate(false); // settle videos on the exact frame and redraw
  }

  toggle() {
    if (this._playing) { this.pause(); return Promise.resolve(); }
    return this.play();
  }

  /** Seek to t (seconds). Resolves when the frame for the latest seek has been drawn. */
  seek(t) {
    let time = +t;
    if (!Number.isFinite(time)) time = 0;
    time = clamp(time, 0, this.duration);
    if (this._playing) {
      if (this._clockRunning) {
        this._pendingSeek = time; // coalesced: applied once per frame by _tick()
        this._time = time;
      } else {
        this._time = time;
      }
      this._emitTime(time);
      return Promise.resolve();
    }
    this._time = time;
    this._emitTime(time);
    return this._requestDraw();
  }

  /** Step one frame (1/30 s) backwards (-1) or forwards (+1). */
  stepFrame(dir = 1) {
    const d = dir < 0 ? -1 : 1;
    if (this._playing) this.pause();
    const frame = Math.round(this._time / FRAME_STEP + 1e-6);
    return this.seek((frame + d) * FRAME_STEP);
  }

  /** Render into another canvas (export); null restores the preview canvas. */
  setOutput(canvas) {
    const prevExport = !!this._output;
    if (canvas && typeof canvas.getContext === 'function') {
      this._output = canvas;
      this._outCtx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    } else {
      this._output = null;
      this._outCtx = null;
    }
    if (prevExport !== !!this._output && this._playing && this._clockRunning && this._mode === 'audio') {
      // The export clock follows rendered (not heard) audio; keep the timeline position.
      const t = this._clockFor(prevExport);
      this._anchorTime = t;
      this._anchorCtx = this._audioNow();
      this._lastClock = t;
    }
    if (!this._playing) this._invalidate(false);
  }

  /** Redraw the current frame (after edits). */
  renderNow() {
    if (this._playing) return Promise.resolve();
    this._refitForAspect();
    return this._requestDraw();
  }

  _refitForAspect() {
    if (!this.canvas || this._lay.aspect === this.store.project.aspect) return;
    if (this._sizeMode === 'fit' && this._parentBox) this._fitTo(this._parentBox.w, this._parentBox.h);
    else this._onResize(this._cssW, this._cssH);
  }

  /** Extra drawing on top of the preview (not the export), e.g. trim markers: fn(ctx, t, w, h). */
  setOverlayHook(fn) {
    this._overlay = typeof fn === 'function' ? fn : null;
    if (!this._playing) this._invalidate(true);
  }

  get loopRange() { return this._loop ? { start: this._loop.start, end: this._loop.end } : null; }
  set loopRange(r) {
    if (!r || !Number.isFinite(+r.start) || !Number.isFinite(+r.end) || +r.end - +r.start < 0.05) {
      this._loop = null;
      return;
    }
    this._loop = { start: Math.max(0, +r.start), end: +r.end };
    if (this._playing && this._clockRunning) {
      const t = this._clock();
      if (t < this._loop.start || t >= this._loop.end) this._restartAt(this._loop.start);
    }
  }

  /** Attach (or replace) the preview canvas. */
  setCanvas(canvas) {
    this._detachCanvas();
    this.canvas = canvas || null;
    this._ctx = null;
    this._lay.valid = false;
    if (!canvas || typeof canvas.getContext !== 'function') return;
    try { this._ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d'); } catch (_) { this._ctx = null; }
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        const r = e && e.contentRect;
        if (!this._sizingChecked) this._detectSizing();
        if (r) this._onResize(r.width, r.height);
      });
      try { this._ro.observe(canvas, { box: 'content-box' }); } catch (_) { this._ro.observe(canvas); }
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this._onWinResize);
    this._detectSizing();
    this._onResize(canvas.clientWidth, canvas.clientHeight);
  }

  _detachCanvas() {
    if (this._ro) { try { this._ro.disconnect(); } catch (_) { /* ignore */ } this._ro = null; }
    if (this._parentRO) { try { this._parentRO.disconnect(); } catch (_) { /* ignore */ } this._parentRO = null; }
    if (typeof window !== 'undefined') window.removeEventListener('resize', this._onWinResize);
    this._sizeMode = 'box';
    this._sizingChecked = false;
    this._parentBox = null;
    this._fitStyle = null;
  }

  /**
   * A canvas whose CSS size follows its own pixel size (no width/height given by the page)
   * would just grow with the backing store. Detect that once and, if so, size it ourselves:
   * the largest box of the project's aspect that fits its parent.
   */
  _detectSizing() {
    const c = this.canvas;
    if (!c || this._sizingChecked || typeof document === 'undefined' || !c.isConnected) return;
    const cw0 = c.clientWidth, ch0 = c.clientHeight;
    if (!(cw0 > 0) && !(ch0 > 0)) return; // not laid out yet: decide once it is
    this._sizingChecked = true;
    const w0 = c.width, h0 = c.height;
    let intrinsic = false;
    try {
      c.width = 2;
      c.height = 2;
      intrinsic = c.clientWidth !== cw0 || c.clientHeight !== ch0;
    } catch (_) { intrinsic = false; }
    c.width = w0;
    c.height = h0;
    if (intrinsic) this._enableFit();
  }

  _enableFit() {
    const c = this.canvas;
    const parent = c && c.parentElement;
    if (!parent) return;
    this._sizeMode = 'fit';
    if (typeof ResizeObserver === 'function') {
      this._parentRO = new ResizeObserver((entries) => {
        const r = entries[entries.length - 1].contentRect;
        this._fitTo(r.width, r.height);
      });
      this._parentRO.observe(parent);
    }
    this._fitParent();
  }

  _fitParent() {
    const parent = this.canvas && this.canvas.parentElement;
    if (!parent) return;
    let pw = parent.clientWidth, ph = parent.clientHeight;
    try {
      const cs = getComputedStyle(parent);
      pw -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      ph -= (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    } catch (_) { /* ignore */ }
    this._fitTo(pw, ph);
  }

  _fitTo(pw, ph) {
    const c = this.canvas;
    if (!c || this._sizeMode !== 'fit') return;
    if (this._fitStyle && (c.style.width !== this._fitStyle[0] || c.style.height !== this._fitStyle[1])) {
      // The page took over sizing the canvas: stop managing it.
      if (this._parentRO) { try { this._parentRO.disconnect(); } catch (_) { /* ignore */ } this._parentRO = null; }
      this._sizeMode = 'box';
      return;
    }
    this._parentBox = { w: pw, h: ph };
    if (!(pw > 0 && ph > 0)) return;
    const aspect = ASPECTS[this.store.project.aspect] || 16 / 9;
    let w = pw, h = pw / aspect;
    if (h > ph) { h = ph; w = ph * aspect; }
    const sw = Math.max(1, Math.floor(w)) + 'px', sh = Math.max(1, Math.floor(h)) + 'px';
    if (c.style.width !== sw) c.style.width = sw;
    if (c.style.height !== sh) c.style.height = sh;
    this._fitStyle = [c.style.width, c.style.height];
    this._onResize(c.clientWidth, c.clientHeight);
  }

  /** Stop everything and release all elements and listeners. */
  destroy() {
    this.pause();
    this._cancelPausedDraw();
    this._flushWaiters();
    clearTimeout(this._prepTimer);
    clearTimeout(this._pendTimer);
    this.store.removeEventListener('change', this._onStoreChange);
    this.store.removeEventListener('media', this._onStoreMedia);
    if (this.audio && typeof this.audio.removeEventListener === 'function') {
      this.audio.removeEventListener('statechange', this._onAudioState);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
    this._detachCanvas();
    while (this._pool.length) this._releaseVideo(this._pool[this._pool.length - 1]);
    for (const id of [...this._images.keys()]) this._dropImage(id);
  }

  // ---------------------------------------------------------------------------
  // Events

  _emit(type, detail) {
    try { this.dispatchEvent(makeEvent(type, detail)); } catch (err) { warnOnce('event ' + type, err); }
  }

  _emitTime(t) {
    this._timeDetail.time = t;
    if (this._timeEvent && !this._dispatchingTime) {
      this._dispatchingTime = true;
      try {
        this.dispatchEvent(this._timeEvent);
        return;
      } catch (_) {
        /* fall through to a fresh event */
      } finally {
        this._dispatchingTime = false;
      }
    }
    this._emit('timeupdate', { time: t });
  }

  _onStoreChange(e) {
    const label = e && e.detail ? e.detail.label : '';
    if (label === 'load') {
      // A different project: start from the beginning.
      if (this._playing) this.pause();
      this._time = 0;
      this._emitTime(0);
    }
    const dur = this.duration;
    this._reconcileVideos();
    this._refitForAspect();
    if (dur !== this._lastDuration) {
      this._lastDuration = dur;
      this._emit('durationchange', { duration: dur });
    }
    if (this._time > dur) {
      this._time = dur;
      if (!this._playing) this._emitTime(dur);
    }
    this._scheduleAudioPrepare(300);
    if (this._playing) this._onPlayingEdit();
    else this._invalidate(false);
  }

  _onStoreMedia() {
    for (const [id, e] of [...this._images]) {
      const m = this.store.getMedia(id);
      if (!m || (m.blob || null) !== e.blob || m.url !== e.url) this._dropImage(id);
    }
    this._reconcileVideos();
    const dur = this.duration;
    if (dur !== this._lastDuration) {
      this._lastDuration = dur;
      this._emit('durationchange', { duration: dur });
    }
    this._scheduleAudioPrepare(200);
    if (this._playing) {
      this._audioSig = '';
      this._onPlayingEdit();
    } else {
      this._invalidate(false);
    }
  }

  _onAudioState() {
    if (!this._playing || !this._clockRunning || !this.audio) return;
    const ctx = this.audio.contextIfCreated || null;
    if (!ctx) return;
    if (ctx.state === 'running' && this._mode === 'perf') {
      // Sound became available (e.g. after a tap): hand the clock over to the audio context.
      const t = this._clock();
      this._startClock(t);
    } else if (ctx.state !== 'running' && this._mode === 'audio') {
      const t = this._clock();
      if (this._output) {
        // Exporting: keep going on the wall clock rather than ruining the recording.
        this._mode = 'perf';
        this._anchorTime = t;
        this._anchorPerf = now();
        this._lastClock = t;
      } else {
        this.pause(); // interrupted (phone call, another app took the audio session…)
      }
    }
  }

  _onVisibility() {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      if (this._playing && !this._output) this.pause();
      // rAF doesn't run in hidden tabs: make sure pending paused draws still resolve.
      if (this._drawHandle && this._drawType === 'raf') {
        cancelAnimationFrame(this._drawHandle);
        this._drawHandle = 0;
        this._schedulePaused();
      }
      if (this._loopHandle && this._loopType === 'raf' && this._output) {
        cancelAnimationFrame(this._loopHandle);
        this._loopHandle = 0;
        this._loopNext();
      }
    } else if (!this._playing) {
      this._invalidate(false);
    }
  }

  _onWinResize() {
    if (!this.canvas) return;
    if (!this._sizingChecked) this._detectSizing();
    if (this._sizeMode === 'fit' && !this._parentRO) this._fitParent();
    this._onResize(this.canvas.clientWidth, this.canvas.clientHeight);
  }

  _onResize(w, h) {
    this._cssW = w > 0 ? w : 0;
    this._cssH = h > 0 ? h : 0;
    const changed = this._layout();
    if (!this._lay.valid) return;
    if (changed && !this._playing && !this._output) {
      // Resizing clears the canvas: redraw right away (sources are normally ready) to avoid a blank flash.
      this._collect(this._time);
      if (this._sourcesReady()) this._draw(this._time);
      this._invalidate(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Layout

  _layout() {
    const L = this._lay;
    const c = this.canvas;
    const cw = this._cssW, ch = this._cssH;
    L.aspect = this.store.project.aspect;
    if (!c || !(cw > 0 && ch > 0)) { L.valid = false; return false; }
    const aspect = ASPECTS[L.aspect] || 16 / 9;
    let fw = cw, fh = cw / aspect;
    if (fh > ch) { fh = ch; fw = ch * aspect; }
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    let s = Math.min(dpr, 2);
    const maxPx = this._coarse ? 1.4e6 : 2.8e6;
    if (fw * fh * s * s > maxPx) s = Math.sqrt(maxPx / (fw * fh));
    const bw = Math.max(1, Math.round(cw * s));
    const bh = Math.max(1, Math.round(ch * s));
    let changed = false;
    if (c.width !== bw) { c.width = bw; changed = true; }
    if (c.height !== bh) { c.height = bh; changed = true; }
    const dfw = Math.max(1, Math.min(bw, Math.round(fw * s)));
    const dfh = Math.max(1, Math.min(bh, Math.round(fh * s)));
    const ox = Math.floor((bw - dfw) / 2), oy = Math.floor((bh - dfh) / 2);
    const moved = L.ox !== ox || L.oy !== oy || L.fw !== dfw / s || L.fh !== dfh / s;
    L.s = s; L.fw = dfw / s; L.fh = dfh / s; L.ox = ox; L.oy = oy; L.bw = bw; L.bh = bh;
    L.bars = dfw !== bw || dfh !== bh;
    L.valid = true;
    return changed || moved;
  }

  // ---------------------------------------------------------------------------
  // Drawing

  _draw(t) {
    const o = this._renderOpts;
    o.project = this.store.project;
    o.timeline = this.store.timeline;
    if (this._output) {
      const c = this._output, ctx = this._outCtx;
      if (!ctx || !(c.width > 0) || !(c.height > 0)) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      o.width = c.width;
      o.height = c.height;
      o.quality = 'export';
      renderFrame(ctx, t, o);
      if ((++this._mirrorTick & 1) === 0 || !this._playing) this._mirror();
      return;
    }
    const ctx = this._ctx;
    if (!ctx) return;
    const L = this._lay;
    if (!L.valid || L.aspect !== this.store.project.aspect || this.canvas.width !== L.bw || this.canvas.height !== L.bh) {
      this._layout();
      if (!L.valid) return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (L.bars) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, L.bw, L.bh);
    }
    ctx.setTransform(L.s, 0, 0, L.s, L.ox, L.oy);
    if (L.bars) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, L.fw, L.fh);
      ctx.clip();
    }
    o.width = L.fw;
    o.height = L.fh;
    o.quality = 'preview';
    renderFrame(ctx, t, o);
    if (this._overlay) {
      ctx.save();
      try { this._overlay(ctx, t, L.fw, L.fh); } catch (err) { warnOnce('overlay hook', err); }
      ctx.restore();
    }
    if (L.bars) ctx.restore();
  }

  /** Show the export frames (scaled) on the preview while exporting. */
  _mirror() {
    const ctx = this._ctx, out = this._output;
    if (!ctx || !out) return;
    const L = this._lay;
    if (!L.valid || L.aspect !== this.store.project.aspect) { this._layout(); if (!L.valid) return; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (L.bars) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, L.bw, L.bh); }
    try { ctx.drawImage(out, L.ox, L.oy, L.fw * L.s, L.fh * L.s); } catch (_) { /* ignore */ }
  }

  _getSource(seg) {
    const item = seg && seg.item;
    if (!item) return null;
    if (item.kind === 'video') {
      const v = this._videos.get(item.id);
      if (!v || v.mediaId !== item.mediaId) return this.store.getMedia(item.mediaId) ? PENDING : null;
      if (v.error) return null;
      return v.el; // renderer keeps black while it has no frame yet
    }
    if (item.kind === 'image') {
      const media = item.mediaId ? this.store.getMedia(item.mediaId) : null;
      if (!media) return null;
      const e = this._ensureImage(media);
      if (e.status === 'ready') return e.source;
      if (e.status === 'error') return null;
      return PENDING;
    }
    return null;
  }

  /** Paused: settle sources at the current time, then draw (coalesced to one per frame). */
  _requestDraw() {
    if (this._playing) return Promise.resolve();
    const p = new Promise((resolve) => this._drawWaiters.push(resolve));
    this._needDraw = true;
    this._schedulePaused();
    return p;
  }

  _invalidate(immediateOk) {
    if (this._playing) return;
    this._needDraw = true;
    if (immediateOk) this._pendingSince = 0;
    this._schedulePaused();
  }

  _schedulePaused() {
    if (this._drawHandle) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden || typeof requestAnimationFrame !== 'function') {
      this._drawType = 'timeout';
      this._drawHandle = setTimeout(this._pausedFrame, 0);
    } else {
      this._drawType = 'raf';
      this._drawHandle = requestAnimationFrame(this._pausedFrame);
    }
  }

  _cancelPausedDraw() {
    if (this._drawHandle) {
      if (this._drawType === 'raf') cancelAnimationFrame(this._drawHandle); else clearTimeout(this._drawHandle);
      this._drawHandle = 0;
    }
    if (this._pendTimer) { clearTimeout(this._pendTimer); this._pendTimer = 0; }
    this._needDraw = false;
    this._pendingSince = 0;
  }

  _flushWaiters() {
    if (!this._drawWaiters.length) return;
    const list = this._drawWaiters;
    this._drawWaiters = [];
    for (const r of list) r();
  }

  _pausedFrame() {
    this._drawHandle = 0;
    if (this._playing) { this._flushWaiters(); return; }
    if (!this._needDraw) { this._flushWaiters(); return; }
    const t = this._time;
    let ready = true;
    try { ready = this._prepareAt(t, 1e-3); } catch (err) { warnOnce('prepare', err); }
    const pn = now();
    if (!ready) {
      if (!this._pendingSince) this._pendingSince = pn;
      if (pn - this._pendingSince < SEEK_TIMEOUT_MS) {
        if (!this._pendTimer) {
          this._pendTimer = setTimeout(() => {
            this._pendTimer = 0;
            if (this._needDraw && !this._playing) this._schedulePaused();
          }, SEEK_TIMEOUT_MS + 20);
        }
        return; // 'seeked' / image load will call back
      }
    }
    this._pendingSince = 0;
    this._needDraw = false;
    if (this._pendTimer) { clearTimeout(this._pendTimer); this._pendTimer = 0; }
    try { this._draw(t); } catch (err) { warnOnce('draw', err); }
    this._flushWaiters();
  }

  // ---------------------------------------------------------------------------
  // Clock

  _audioNow(forExport = !!this._output) {
    const a = this.audio;
    if (!a) return 0;
    if (forExport) return typeof a.renderTime === 'function' ? a.renderTime() : a.context.currentTime;
    return typeof a.outputTime === 'function' ? a.outputTime() : a.context.currentTime;
  }

  _clockFor(forExport) {
    if (this._mode === 'audio') return this._anchorTime + (this._audioNow(forExport) - this._anchorCtx);
    return this._anchorTime + (now() - this._anchorPerf) / 1000;
  }

  _clock() {
    if (!this._clockRunning) return this._time;
    if (this._pendingSeek !== null) return this._pendingSeek;
    let t;
    if (this._mode === 'audio') {
      const ctx = this.audio && this.audio.contextIfCreated;
      t = this._anchorTime + (this._audioNow() - this._anchorCtx);
      if (ctx) {
        const cur = ctx.currentTime;
        const pn = now();
        if (cur !== this._stallRef) {
          this._stallRef = cur;
          this._stallAt = pn;
        } else if (pn - this._stallAt > STALL_MS) {
          // The audio clock stopped advancing (no output device, driver hiccup): use the wall clock.
          this._mode = 'perf';
          this._anchorTime = Math.max(this._lastClock, this._anchorTime);
          this._anchorPerf = pn;
          t = this._anchorTime;
        }
      }
    } else {
      t = this._anchorTime + (now() - this._anchorPerf) / 1000;
    }
    if (t < this._lastClock) t = this._lastClock; // monotonic while playing
    this._lastClock = t;
    return t;
  }

  _clearSeekState() {
    this._pendingSeek = null;
    if (this._quietTimer) { clearTimeout(this._quietTimer); this._quietTimer = 0; }
  }

  _startClock(t) {
    this._clearSeekState();
    this._anchorTime = t;
    this._lastClock = t;
    this._time = t;
    this._holdSince = 0;
    let at = null;
    const a = this.audio;
    if (a && typeof a.start === 'function') {
      this._audioOpts.at = undefined;
      try { at = a.start(this.store.project, this.store.timeline, t, this._audioOpts); } catch (err) { warnOnce('audio start', err); at = null; }
    }
    const ctx = a ? a.contextIfCreated : null;
    if (at != null && Number.isFinite(at) && ctx && ctx.state === 'running') {
      this._mode = 'audio';
      this._anchorCtx = at;
      this._stallRef = ctx.currentTime;
      this._stallAt = now();
    } else {
      this._mode = 'perf';
      this._anchorPerf = now();
    }
    this._audioSig = this._signature();
    this._audioMix = this.store.project.audioMix;
    this._clockRunning = true;
  }

  /**
   * Jump while playing. `quiet` (rapid seeking, e.g. dragging the seek bar during playback)
   * runs on the wall clock without sound and brings the sound back once seeking settles.
   */
  _restartAt(t, quiet = false) {
    this._time = t;
    this._pendingSeek = null;
    if (this._quietTimer) { clearTimeout(this._quietTimer); this._quietTimer = 0; }
    if (this.audio) { try { this.audio.stop(); } catch (_) { /* ignore */ } }
    const n = this._collect(t);
    for (let i = 0; i < n; i++) {
      const v = this._videos.get(this._act[i].item.id);
      if (v) v.forceSeek = true;
    }
    if (!quiet) { this._startClock(t); return; }
    this._mode = 'perf';
    this._anchorTime = t;
    this._anchorPerf = now();
    this._lastClock = t;
    this._holdSince = 0;
    this._clockRunning = true;
    this._quietTimer = setTimeout(() => {
      this._quietTimer = 0;
      if (this._playing && this._clockRunning && this._pendingSeek === null) this._startClock(this._clock());
    }, 160);
  }

  _finish(dur) {
    this._playing = false;
    this._clockRunning = false;
    this._playToken++;
    this._cancelLoop();
    this._clearResync();
    this._clearSeekState();
    if (this.audio) { try { this.audio.stop(); } catch (_) { /* ignore */ } }
    for (const v of this._pool) {
      if (!v.el.paused) { try { v.el.pause(); } catch (_) { /* ignore */ } }
    }
    this._time = dur;
    this._collect(dur);
    try { this._draw(dur); } catch (err) { warnOnce('draw', err); }
    this._emitTime(dur);
    this._emit('pause');
    this._emit('ended');
  }

  _loopNext() {
    if (this._loopHandle || !this._playing) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if ((hidden && this._output) || typeof requestAnimationFrame !== 'function') {
      this._loopType = 'timeout';
      this._loopHandle = setTimeout(this._tick, 16);
    } else {
      this._loopType = 'raf';
      this._loopHandle = requestAnimationFrame(this._tick);
    }
  }

  _cancelLoop() {
    if (!this._loopHandle) return;
    if (this._loopType === 'raf') cancelAnimationFrame(this._loopHandle); else clearTimeout(this._loopHandle);
    this._loopHandle = 0;
  }

  _tick() {
    this._loopHandle = 0;
    if (!this._playing) return;
    this._loopNext();
    if (!this._clockRunning) return;
    try {
      if (this._pendingSeek !== null) {
        const pn0 = now();
        const quiet = pn0 - this._lastSeekRestart < 150;
        this._lastSeekRestart = pn0;
        this._restartAt(this._pendingSeek, quiet);
      }
      let t = this._clock();
      const dur = this.duration;
      const lr = this._loop;
      if (lr) {
        const end = Math.min(lr.end, dur);
        if (t >= end) {
          t = lr.start < end ? lr.start : 0;
          this._restartAt(t);
        }
      } else if (t >= dur) {
        this._finish(dur);
        return;
      }
      this._time = t;
      const pn = now();
      this._collect(t);
      this._syncVideos(t, pn);
      if (pn - this._lastPrefetch > 200) {
        this._lastPrefetch = pn;
        this._prefetch(t, pn);
      }
      if (this._sourcesReady()) {
        this._holdSince = 0;
        this._draw(t);
      } else {
        if (!this._holdSince) this._holdSince = pn;
        if (pn - this._holdSince > HOLD_MAX_MS) this._draw(t);
      }
      this._emitTime(t);
    } catch (err) {
      warnOnce('tick', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Audio follow-up

  _scheduleAudioPrepare(ms) {
    const a = this.audio;
    if (!a || typeof a.prepare !== 'function') return;
    clearTimeout(this._prepTimer);
    this._prepTimer = setTimeout(() => {
      this._prepTimer = 0;
      try {
        const p = a.prepare(this.store.project, this.store);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) { /* ignore */ }
    }, ms);
  }

  _signature() {
    const p = this.store.project, tl = this.store.timeline;
    const parts = [p.emphasize || '', p.duckMusic ? 1 : 0];
    for (const s of tl.segments) {
      const it = s.item;
      parts.push(it.id, s.start.toFixed(3), s.end.toFixed(3), s.transitionIn ? s.transitionIn.duration.toFixed(3) : '-');
      if (it.kind === 'video') parts.push(it.mediaId, s.sourceIn.toFixed(3), it.speed, it.volume, it.fadeIn, it.fadeOut);
    }
    for (const m of tl.music) {
      const it = m.item;
      parts.push(it.id, it.mediaId, it.kind, m.start.toFixed(3), m.end.toFixed(3), it.trimStart, it.volume, it.fadeIn, it.fadeOut);
    }
    return parts.join('|');
  }

  _onPlayingEdit() {
    if (!this._clockRunning) return;
    const sig = this._signature();
    const mix = this.store.project.audioMix;
    if (sig !== this._audioSig) {
      this._audioSig = sig;
      this._queueResync();
    } else if (mix !== this._audioMix) {
      this._audioMix = mix;
      if (this.audio && typeof this.audio.setMix === 'function') this.audio.setMix(mix);
    }
  }

  _queueResync() {
    const wait = RESYNC_MS - (now() - this._lastResync);
    if (wait <= 0) { this._resyncAudio(); return; }
    if (!this._resyncTimer) {
      this._resyncTimer = setTimeout(() => {
        this._resyncTimer = 0;
        if (this._playing) this._resyncAudio();
      }, wait);
    }
  }

  _clearResync() {
    if (this._resyncTimer) { clearTimeout(this._resyncTimer); this._resyncTimer = 0; }
  }

  /** Re-schedule the sound after an edit without moving the playback position. */
  _resyncAudio() {
    this._lastResync = now();
    const a = this.audio;
    if (!a || !this._clockRunning || typeof a.start !== 'function') return;
    const ctx = a.contextIfCreated;
    this._audioMix = this.store.project.audioMix;
    this._audioSig = this._signature();
    if (this._mode !== 'audio' || !ctx) return;
    let at = ctx.currentTime + (a.startLead > 0 ? a.startLead : 0.08);
    let tFrom = this._anchorTime + (at - this._anchorCtx);
    if (at < this._anchorCtx) { at = this._anchorCtx; tFrom = this._anchorTime; }
    if (tFrom < 0) tFrom = 0;
    this._audioOpts.at = at;
    let res = null;
    try { res = a.start(this.store.project, this.store.timeline, tFrom, this._audioOpts); } catch (err) { warnOnce('audio start', err); }
    this._audioOpts.at = undefined;
    if (res != null && Number.isFinite(res)) {
      this._anchorTime = tFrom;
      this._anchorCtx = res;
    }
  }

  // ---------------------------------------------------------------------------
  // Timeline helpers

  _collect(t) {
    const segs = this.store.timeline.segments;
    const act = this._act;
    let n = 0;
    act[0] = null; act[1] = null;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!(s.duration > 0)) continue;
      if (t >= s.start && t < s.end) {
        if (n < 2) act[n++] = s;
        else { act[0] = act[1]; act[1] = s; }
      }
    }
    if (n === 0) {
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i];
        if (s.duration > 0) {
          if (t >= s.end && t <= s.end + END_HOLD) { act[0] = s; n = 1; }
          break;
        }
      }
    }
    this._actN = n;
    return n;
  }

  _isActive(v) {
    for (let i = 0; i < this._actN; i++) if (this._act[i] && this._act[i].item.id === v.id) return true;
    return false;
  }

  /** Ensure every source needed at t exists and is positioned. Returns true when all are drawable. */
  _prepareAt(t, tolerance) {
    const n = this._collect(t);
    let ready = true;
    const pn = now();
    for (let i = 0; i < n; i++) {
      const seg = this._act[i];
      const item = seg.item;
      if (item.kind === 'video') {
        const v = this._ensureVideo(item);
        if (!v || v.error) continue;
        v.used = pn;
        const want = sourceTimeAt(seg, t);
        const el = v.el;
        if (el.readyState < 1) { v.target = want; ready = false; continue; }
        if (el.seeking) { v.target = want; ready = false; continue; }
        if (Math.abs(el.currentTime - want) > tolerance) this._seekVideo(v, want);
        if (!this._videoReady(v)) {
          ready = false;
          if (el.readyState < 2 && !el.seeking) this._warmUp(v);
        }
      } else if (item.kind === 'image') {
        const media = item.mediaId ? this.store.getMedia(item.mediaId) : null;
        if (!media) continue;
        const e = this._ensureImage(media);
        if (e.status === 'loading') ready = false;
      }
    }
    return ready;
  }

  _sourcesReady() {
    for (let i = 0; i < this._actN; i++) {
      const item = this._act[i].item;
      if (item.kind === 'video') {
        const v = this._videos.get(item.id);
        if (!v) {
          if (item.mediaId && this.store.getMedia(item.mediaId)) return false;
          continue;
        }
        if (!this._videoReady(v)) return false;
      } else if (item.kind === 'image') {
        if (!item.mediaId) continue;
        const e = this._images.get(item.mediaId);
        if (e && e.status === 'loading') return false;
        if (!e && this.store.getMedia(item.mediaId)) return false;
      }
    }
    return true;
  }

  _waitReady(token, deadline) {
    return new Promise((resolve) => {
      const check = () => {
        if (token !== this._playToken || this._clockRunning || !this._playing || now() > deadline) { resolve(); return; }
        let ok = true;
        try { ok = this._prepareAt(this._time, 0.15); } catch (_) { ok = true; }
        if (ok) resolve(); else setTimeout(check, 25);
      };
      check();
    });
  }

  _prefetch(t, pn) {
    const segs = this.store.timeline.segments;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.start <= t || !(s.duration > 0)) continue;
      const ahead = s.start - t;
      if (ahead > IMAGE_AHEAD) break;
      const item = s.item;
      if (item.kind === 'image') {
        const media = item.mediaId ? this.store.getMedia(item.mediaId) : null;
        if (media) this._ensureImage(media);
      } else if (item.kind === 'video' && ahead <= PREROLL) {
        const v = this._ensureVideo(item);
        if (!v || v.error) continue;
        v.used = pn;
        const el = v.el;
        if (!el.paused || v.blessing) continue;
        const want = sourceTimeAt(s, s.start);
        if (el.readyState < 1) v.target = want;
        else if (!el.seeking && Math.abs(el.currentTime - want) > 0.05) this._seekVideo(v, want);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Video pool

  _ensureVideo(item) {
    const media = item.mediaId ? this.store.getMedia(item.mediaId) : null;
    let v = this._videos.get(item.id);
    if (v && (v.mediaId !== item.mediaId || v.media !== media)) { this._releaseVideo(v); v = null; }
    if (v) return v;
    if (!media || media.type === 'image' || typeof document === 'undefined') return null;
    let url = media.url || '';
    let own = false;
    if (!url && media.blob) {
      try { url = URL.createObjectURL(media.blob); own = true; } catch (_) { url = ''; }
    }
    if (!url) return null;
    const el = document.createElement('video');
    el.muted = true;
    el.defaultMuted = true;
    el.setAttribute('muted', '');
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.preload = 'auto';
    el.controls = false;
    el.loop = false;
    try { el.disablePictureInPicture = true; } catch (_) { /* ignore */ }
    try { el.disableRemotePlayback = true; } catch (_) { /* ignore */ }
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    el.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    v = {
      id: item.id, mediaId: item.mediaId, media, el, url, own,
      error: false, released: false, target: null, used: now(), stamp: 0,
      playReq: false, manual: false, blessing: false, warming: false, warmed: false,
      forceSeek: false, lastSeekAt: 0, seekStart: 0, seekCost: 120, handlers: null,
    };
    const h = {
      loadedmetadata: () => this._onVideoMeta(v),
      loadeddata: () => this._onVideoData(v),
      canplay: () => this._onVideoData(v),
      seeking: () => { v.seekStart = now(); },
      seeked: () => this._onVideoSeeked(v),
      error: () => this._onVideoError(v),
    };
    v.handlers = h;
    for (const k of Object.keys(h)) el.addEventListener(k, h[k]);
    el.src = url;
    if (this.mediaHost) this.mediaHost.appendChild(el);
    this._videos.set(item.id, v);
    this._pool.push(v);
    this._trimPool();
    return v;
  }

  _releaseVideo(v) {
    if (!v || v.released) return;
    v.released = true;
    const el = v.el;
    if (v.handlers) for (const k of Object.keys(v.handlers)) el.removeEventListener(k, v.handlers[k]);
    try { el.pause(); } catch (_) { /* ignore */ }
    try { el.removeAttribute('src'); el.load(); } catch (_) { /* ignore */ }
    try { el.remove(); } catch (_) { /* ignore */ }
    if (v.own) { try { URL.revokeObjectURL(v.url); } catch (_) { /* ignore */ } }
    if (this._videos.get(v.id) === v) this._videos.delete(v.id);
    const i = this._pool.indexOf(v);
    if (i >= 0) this._pool.splice(i, 1);
  }

  _trimPool() {
    const max = this._coarse ? 6 : 12;
    if (this._pool.length <= max) return;
    const pn = now();
    const victims = this._pool.filter((v) => pn - v.used > 1500 && !this._isActive(v)).sort((a, b) => a.used - b.used);
    while (this._pool.length > max && victims.length) this._releaseVideo(victims.shift());
  }

  _reconcileVideos() {
    const items = this.store.project.items;
    for (let i = this._pool.length - 1; i >= 0; i--) {
      const v = this._pool[i];
      let it = null;
      for (let j = 0; j < items.length; j++) if (items[j].id === v.id) { it = items[j]; break; }
      const media = it && it.mediaId ? this.store.getMedia(it.mediaId) : null;
      if (!it || it.kind !== 'video' || it.mediaId !== v.mediaId || media !== v.media) this._releaseVideo(v);
    }
  }

  _videoReady(v) {
    if (v.error) return true;
    const el = v.el;
    return el.readyState >= 2 && !el.seeking && v.target == null;
  }

  _seekVideo(v, time) {
    if (v.error || v.released) return;
    const el = v.el;
    if (el.readyState < 1) { v.target = time; return; }
    const d = el.duration;
    if (Number.isFinite(d) && d > 0 && time > d - 0.01) time = Math.max(0, d - 0.01);
    if (time < 0) time = 0;
    if (el.seeking) { v.target = time; return; } // coalesce: only the latest target is applied
    v.target = null;
    if (Math.abs(el.currentTime - time) < 1e-3) return;
    v.lastSeekAt = now();
    try { el.currentTime = time; } catch (_) { v.target = time; }
  }

  _onVideoMeta(v) {
    if (v.released) return;
    if (v.target != null) {
      const t = v.target;
      v.target = null;
      this._seekVideo(v, t);
    }
    if (!this._playing) this._invalidate(false);
  }

  _onVideoData(v) {
    if (v.released) return;
    if (v.target != null && !v.el.seeking) {
      const t = v.target;
      v.target = null;
      this._seekVideo(v, t);
    }
    if (!this._playing) this._invalidate(false);
  }

  _onVideoSeeked(v) {
    if (v.released) return;
    const cost = now() - (v.seekStart || v.lastSeekAt || now());
    if (cost > 0 && cost < 5000) v.seekCost = v.seekCost * 0.7 + cost * 0.3;
    if (v.target != null && Math.abs(v.target - v.el.currentTime) < 1e-3) v.target = null;
    if (v.target != null) {
      // Scrubbing: show this intermediate frame now, then go after the latest requested time.
      if (!this._playing && !this._output && this._ctx) {
        try { this._collect(this._time); this._draw(this._time); } catch (err) { warnOnce('draw', err); }
      }
      const t = v.target;
      v.target = null;
      this._seekVideo(v, t);
    }
    if (!this._playing) this._invalidate(false);
  }

  _onVideoError(v) {
    if (v.released) return;
    v.error = true;
    v.target = null;
    const name = v.media && v.media.name ? v.media.name : v.mediaId;
    warnOnce('video ' + v.mediaId, new Error(`"${name}" can't be played in this browser`));
    if (!this._playing) this._invalidate(false);
  }

  /** iOS may not fetch frames for a paused, never-played video: play muted for a moment. */
  _warmUp(v) {
    if (v.warmed || v.warming || v.error || this._playing) return;
    const el = v.el;
    if (el.readyState < 1) return;
    v.warmed = true;
    v.warming = true;
    const target = el.currentTime;
    let p = null;
    try { p = el.play(); } catch (_) { p = null; }
    const done = () => {
      v.warming = false;
      if (!this._playing || !this._isActive(v)) {
        try { el.pause(); } catch (_) { /* ignore */ }
        if (!this._playing) {
          this._seekVideo(v, v.target != null ? v.target : target);
          this._invalidate(false);
        }
      }
    };
    if (p && typeof p.then === 'function') p.then(done, () => { v.warming = false; });
    else done();
  }

  /** Inside the play() gesture: start the first videos so iOS low-power mode lets them play later. */
  _bless(t, token) {
    const segs = this.store.timeline.segments;
    let count = 0;
    for (let i = 0; i < segs.length && count < 3; i++) {
      const s = segs[i];
      if (!(s.duration > 0) || s.end <= t || s.item.kind !== 'video') continue;
      if (s.start > t + 5) break;
      const v = this._ensureVideo(s.item);
      if (!v || v.error || v.manual) continue;
      count++;
      const want = sourceTimeAt(s, Math.max(t, s.start));
      const el = v.el;
      if (el.readyState < 1) v.target = want;
      else if (!el.seeking && Math.abs(el.currentTime - want) > 0.05) this._seekVideo(v, want);
      if (!el.paused) continue;
      let p = null;
      try { p = el.play(); } catch (_) { p = null; }
      v.blessing = true;
      const done = () => {
        v.blessing = false;
        // Keep it running only if the clock already moved and the video is on screen.
        if (!this._clockRunning || this._playToken !== token || !this._isActive(v)
          || this._lastClock <= this._anchorTime + 1e-4) {
          try { el.pause(); } catch (_) { /* ignore */ }
        }
      };
      if (p && typeof p.then === 'function') {
        p.then(done, (err) => {
          v.blessing = false;
          if (err && err.name === 'NotAllowedError') v.manual = true;
        });
      } else {
        done();
      }
    }
  }

  _setRate(v, r) {
    try { v.el.playbackRate = r; } catch (_) { v.manual = true; }
  }

  _playEl(v) {
    if (v.playReq) return;
    v.playReq = true;
    let p = null;
    try { p = v.el.play(); } catch (_) { p = null; }
    if (p && typeof p.then === 'function') {
      p.then(() => { v.playReq = false; }, (err) => {
        v.playReq = false;
        // Autoplay refused (e.g. iOS Low Power Mode): follow the clock by seeking instead.
        if (err && err.name === 'NotAllowedError') v.manual = true;
      });
    } else {
      v.playReq = false;
    }
  }

  _syncVideos(t, pn) {
    const stamp = ++this._syncStamp;
    const started = t > this._anchorTime + 1e-4; // audio has started (clock moved)
    for (let i = 0; i < this._actN; i++) {
      const seg = this._act[i];
      const item = seg.item;
      if (item.kind !== 'video') continue;
      const v = this._ensureVideo(item);
      if (!v || v.error) continue;
      v.used = pn;
      v.stamp = stamp;
      const el = v.el;
      const want = sourceTimeAt(seg, t);
      if (el.readyState < 1) { v.target = want; continue; }
      const speed = item.speed > 0 ? item.speed : 1;
      const rate = clamp(speed, MIN_RATE, MAX_RATE);
      if (v.manual || speed > MAX_RATE) {
        if (!el.paused && !v.blessing) { try { el.pause(); } catch (_) { /* ignore */ } }
        if (!el.seeking && Math.abs(el.currentTime - want) > FRAME_STEP) this._seekVideo(v, want);
        else if (el.seeking) v.target = want;
        continue;
      }
      if (el.paused || v.blessing) {
        if (v.forceSeek || Math.abs(el.currentTime - want) > 0.08) {
          v.forceSeek = false;
          this._seekVideo(v, want);
        }
        if (Math.abs(el.playbackRate - rate) > 1e-3) this._setRate(v, rate);
        // play() on an ended element would restart it from 0: just hold its last frame.
        const atEnd = el.ended || (seg.sourceOut > 0 && want >= seg.sourceOut - 0.02)
          || (Number.isFinite(el.duration) && want >= el.duration - 0.02);
        if (started && el.paused && !v.blessing && !atEnd) this._playEl(v);
        continue;
      }
      if (el.seeking) continue;
      const drift = el.currentTime - want; // > 0: video ahead of the clock
      if (v.forceSeek || Math.abs(drift) > DRIFT_RESEEK * Math.max(1, rate)) {
        if (v.forceSeek || pn - v.lastSeekAt > 500) {
          v.forceSeek = false;
          // Land where the clock will be once the seek completes.
          const ahead = Math.min(0.5, v.seekCost / 1000) * speed;
          this._seekVideo(v, want + ahead);
          if (Math.abs(el.playbackRate - rate) > 1e-3) this._setRate(v, rate);
        }
      } else if (Math.abs(drift) > DRIFT_SOFT) {
        const k = 1 - clamp(drift / Math.max(rate, 0.25), -0.12, 0.12);
        const r = clamp(rate * k, MIN_RATE, MAX_RATE);
        if (Math.abs(el.playbackRate - r) > 0.004) this._setRate(v, r);
      } else if (Math.abs(el.playbackRate - rate) > 0.004) {
        this._setRate(v, rate);
      }
    }
    // Park everything that is not on screen.
    for (let i = 0; i < this._pool.length; i++) {
      const v = this._pool[i];
      if (v.stamp !== stamp && !v.blessing && !v.warming && !v.el.paused) {
        try { v.el.pause(); } catch (_) { /* ignore */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Image cache

  _ensureImage(media) {
    let e = this._images.get(media.id);
    if (e && e.blob === (media.blob || null) && e.url === media.url) {
      e.used = now();
      return e;
    }
    if (e) this._dropImage(media.id);
    e = { id: media.id, blob: media.blob || null, url: media.url, status: 'loading', source: null, used: now(), own: '' };
    this._images.set(media.id, e);
    this._decodeImage(media, e).then((source) => {
      if (this._images.get(media.id) !== e) { freeSource(source); return; }
      e.source = source;
      e.status = 'ready';
      if (!this._playing) this._invalidate(false);
    }, (err) => {
      if (this._images.get(media.id) !== e) return;
      e.status = 'error';
      warnOnce('image ' + media.id, err);
      if (!this._playing) this._invalidate(false);
    });
    this._trimImages();
    return e;
  }

  async _decodeImage(media, e) {
    let url = media.url;
    if (!url && media.blob) { url = URL.createObjectURL(media.blob); e.own = url; }
    if (!url) throw new Error('photo has no data');
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('photo took too long to load')), 30000);
      img.onload = () => { clearTimeout(timer); resolve(); };
      img.onerror = () => { clearTimeout(timer); reject(new Error(`"${media.name || 'photo'}" can't be shown`)); };
      img.src = url;
    });
    if (typeof img.decode === 'function') { try { await img.decode(); } catch (_) { /* drawn anyway */ } }
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!(w > 0 && h > 0)) throw new Error('photo has no size');
    // Keep memory in check: phones can't hold many full-size camera photos.
    const maxSide = this._coarse ? 2048 : 3072;
    const k = maxSide / Math.max(w, h);
    if (k < 1) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      const cx = c.getContext('2d');
      if (cx) {
        cx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in cx) cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, c.width, c.height);
        img.removeAttribute('src');
        return c;
      }
    }
    return img;
  }

  _dropImage(id) {
    const e = this._images.get(id);
    if (!e) return;
    this._images.delete(id);
    freeSource(e.source);
    e.source = null;
    if (e.own) { try { URL.revokeObjectURL(e.own); } catch (_) { /* ignore */ } }
  }

  _trimImages() {
    const max = this._coarse ? 12 : 30;
    if (this._images.size <= max) return;
    const pn = now();
    const victims = [...this._images.values()].filter((e) => pn - e.used > 3000).sort((a, b) => a.used - b.used);
    while (this._images.size > max && victims.length) this._dropImage(victims.shift().id);
  }
}

function freeSource(src) {
  if (!src) return;
  try {
    if (typeof src.close === 'function') src.close();          // ImageBitmap
    else if (typeof src.getContext === 'function') { src.width = 0; src.height = 0; } // canvas
    else if (typeof src.removeAttribute === 'function') src.removeAttribute('src'); // <img>
  } catch (_) { /* ignore */ }
}
