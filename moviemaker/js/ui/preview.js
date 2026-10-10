// ui/preview.js — the preview monitor of Movie Maker (web).
//
// A black stage with the movie canvas (kept at the project aspect ratio, letterboxed in the pane),
// a seek slider, the time readout "00:05.20/01:30.00", the transport (previous frame, big round
// play/pause, next frame) and a full screen button. Double-tap the picture to play/pause.
// Tap a title/caption while paused to select it, tap it again to edit it in place (WLMM style):
// a transparent <textarea> is laid exactly over the text, styled like it, while the renderer skips
// that text.
//
// export class Preview {
//   constructor(rootEl, app)   // builds the DOM and the <canvas> (exposed as .canvas); must not touch
//                              // app.player / app.commands (they do not exist yet)
//   attach()                   // subscribe to player events (called by app.js once the player exists)
//   editText(id)               // inline-edit the caption/credits (TextItem id) or title (VisualItem id)
//   editingTextId              // id being edited, or null
//   finishEditing(commit = true), toggleFullscreen(), destroy()
// }

import { formatTime, ASPECTS } from '../model.js';
import * as TextMod from '../text.js';
import * as Icons from './icons.js';

const LINE_HEIGHT = 1.22;               // keep in sync with js/text.js
const PHONE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 1024px) and (orientation: portrait), (pointer: coarse) and (orientation: landscape) and (max-height: 520px)';
const OUTLINE = { none: 0, thin: 0.045, medium: 0.08, thick: 0.13 };
const DOUBLE_TAP_MS = 320;
const TAP_MOVE_PX = 12;
const DEFAULT_TEXTS = new Set(['', 'Enter text here', 'My Movie', 'Title']);

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

function el(tag, cls, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  return e;
}

function iconEl(name, size) {
  try { if (typeof Icons.icon === 'function') return Icons.icon(name, size); } catch (_) { /* fall through */ }
  return el('span');
}

function svg(markup, size) {
  const holder = document.createElement('span');
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${markup}</svg>`;
  return holder.firstChild;
}

const PLAY_SVG = '<path d="M8 5.2v13.6L19 12z"/>';
const PAUSE_SVG = '<rect x="6.5" y="5.5" width="4" height="13" rx="1"/><rect x="13.5" y="5.5" width="4" height="13" rx="1"/>';

function fontPxFor(style, h) {
  try { if (typeof TextMod.textFontPx === 'function') return TextMod.textFontPx(style, h); } catch (_) { /* fall back */ }
  let size = style && +style.size;
  if (!(size > 0)) size = 8;
  if (size > 80) size = 80;
  return Math.max(4, (size / 100) * h);
}

// ---------------------------------------------------------------------------------------------
// Styles (scoped to .pv-root; complements the shared .pv-* defaults in css/moviemaker.css)

const STYLE_ID = 'pv-style';
const STYLE = `
.pv-root .pv-stage{position:relative;}
/* Desktop: the monitor keeps the movie's aspect with the transport right below it (WLMM); it
   shrinks (letterboxing inside) when the pane is short. Full screen fills the screen. */
.pv-root.pv-desktop:not(.is-fullscreen) .pv-stage{flex:0 1 auto;height:auto;aspect-ratio:var(--pv-aspect,16 / 9);}
.pv-root.is-fullscreen .pv-stage{flex:1 1 auto;aspect-ratio:auto;max-height:none;}
.pv-root .pv-canvas{display:block;flex:none;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}
.pv-root .pv-stage.is-clickable-text{cursor:text;}
.pv-root .pv-placeholder{flex-direction:column;gap:8px;text-align:center;padding:12px;line-height:1.35;}
.pv-root .pv-placeholder svg{opacity:.55;}
.pv-root .pv-text-sel{position:absolute;z-index:3;pointer-events:none;box-sizing:border-box;border:1px dashed rgba(255,255,255,.95);
  box-shadow:0 0 0 1px rgba(0,0,0,.55),inset 0 0 0 1px rgba(0,0,0,.35);}
.pv-root .pv-text-sel::after{content:"";position:absolute;right:-4px;bottom:-4px;width:7px;height:7px;background:#fff;border:1px solid #333;box-sizing:border-box;}
.pv-root textarea.pv-text-editor{position:absolute;z-index:4;box-sizing:border-box;display:block;margin:0;border:0;border-radius:0;
  outline:1px dashed rgba(255,255,255,.95);outline-offset:0;box-shadow:0 0 0 1px rgba(0,0,0,.6);background:transparent;
  resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;transform-origin:0 0;
  -webkit-user-select:text;user-select:text;-webkit-touch-callout:default;-webkit-appearance:none;appearance:none;
  font-kerning:normal;text-rendering:optimizeLegibility;min-width:0;min-height:0;max-width:none;max-height:none;}
.pv-root .pv-seekrow{flex:none;padding:6px 14px 0;}
@supports (overflow:clip){.pv-root .pv-seekrow{overflow-x:clip;overflow-y:visible;}}
.pv-root .pv-seekbar{position:relative;display:block;width:100%;height:22px;margin:0;padding:0;cursor:pointer;touch-action:none;outline:none;-webkit-appearance:none;appearance:none;background:transparent;}
.pv-root .pv-seekbar:focus-visible .pv-seek-knob{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--c-focus,#3399ff);}
.pv-root .pv-seekbar.is-disabled{cursor:default;opacity:.55;}
.pv-root .pv-seek-track{position:absolute;left:0;right:0;top:50%;height:6px;margin-top:-3px;box-sizing:border-box;border-radius:3px;overflow:hidden;
  background:linear-gradient(#9fb1c7,#d9e2ee);border:1px solid #7d93ad;pointer-events:none;}
.pv-root .pv-seek-fill{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:0 50%;transform:scaleX(0);
  background:linear-gradient(#8fcbff,#2f74c9);will-change:transform;}
.pv-root .pv-seek-knobwrap{position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;transform:translateX(0);will-change:transform;}
.pv-root .pv-seek-knob{position:absolute;left:-7px;top:50%;width:14px;height:14px;margin-top:-7px;box-sizing:border-box;border-radius:50%;
  border:1px solid #1f4f8f;background:radial-gradient(circle at 35% 30%,#fff,#8cc0f3 45%,#2f74c9);box-shadow:0 1px 2px rgba(0,0,0,.35);}
.pv-root .pv-seekbar.is-scrubbing .pv-seek-knob{transform:scale(1.15);}
.pv-root .pv-transport{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px;}
.pv-root .pv-transport .pv-time{justify-self:start;overflow:hidden;text-overflow:ellipsis;}
.pv-root .pv-controls{display:flex;align-items:center;justify-content:center;gap:10px;}
.pv-root .pv-right{justify-self:end;display:flex;align-items:center;gap:6px;}
.pv-root .pv-play svg{fill:#fff;}
.pv-root .pv-play.is-playing svg{transform:none;}
.pv-root .pv-btn:disabled,.pv-root .pv-play:disabled{opacity:.5;}
@media (max-width: 760px), (pointer: coarse) and (max-width: 1024px) and (orientation: portrait), (pointer: coarse) and (orientation: landscape) and (max-height: 520px){
  .pv-root .pv-seekrow{display:flex;align-items:center;gap:12px;padding:4px 16px 0 14px;background:#20252c;}
  .pv-root .pv-seekrow .pv-time{flex:none;font-size:12.5px;color:#e3e8ef;}
  .pv-root .pv-seekrow .pv-seekbar{flex:1 1 auto;min-width:80px;}
  .pv-root .pv-seekbar{height:30px;}
  .pv-root .pv-seek-knob{width:20px;height:20px;left:-10px;margin-top:-10px;}
  .pv-root .pv-seek-track{background:linear-gradient(#59636f,#7b8693);border-color:#3b4552;}
}
@media (pointer: coarse){.pv-root .pv-seekbar{height:32px;}.pv-root .pv-seek-knob{width:20px;height:20px;left:-10px;margin-top:-10px;}}
#app.is-pseudo-fullscreen .pv-root .pv-seekrow,.pv-root:fullscreen .pv-seekrow{background:#111;}
.pv-root:-webkit-full-screen .pv-seekrow{background:#111;}
.pv-root:-webkit-full-screen .pv-stage{margin:0;border:0;}
.pv-root:-webkit-full-screen .pv-transport{background:#111;}
.pv-root:-webkit-full-screen .pv-time{color:#ddd;}
`;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLE;
  (document.head || document.documentElement).appendChild(s);
}

// ---------------------------------------------------------------------------------------------

export class Preview {
  constructor(rootEl, app) {
    if (!rootEl) throw new Error('Preview needs a root element (#preview-pane).');
    this.root = rootEl;
    this.app = app || {};
    this.store = this.app.store || null;
    this.editingTextId = null;
    this.editor = null;
    this._attached = false;
    this._player = null;
    this._offs = [];
    this._playerOffs = [];
    this._scrub = null;
    this._seekRaf = 0;
    this._seekT = 0;
    this._down = null;
    this._lastTap = null;
    this._timeText = '';
    this._duration = 0;
    this._time = 0;
    this._wakeLock = null;
    this._repeat = 0;
    this._measureCanvas = null;
    this._downInRibbonAt = -1e9;
    this._editOrig = '';
    this._editStartedAt = -1e9;
    this._pseudoExit = null;
    this._destroyed = false;
    injectStyles();
    this._build();
    this._subscribeStore();
    this._fit();
    this._updateTime(0, 0);
    this._updatePlaceholder();
    // app.js attaches us once the player exists; do it ourselves if that never happens.
    setTimeout(() => { if (!this._attached && !this._destroyed && this.app.player) this.attach(); }, 0);
  }

  // ------------------------------------------------------------------------------- DOM

  _build() {
    const root = this.root;
    root.textContent = '';
    root.classList.add('pv-root');

    this.stage = el('div', 'pv-stage');
    this.canvas = el('canvas', 'pv-canvas', { role: 'img', 'aria-label': 'Movie preview' });
    this.placeholder = el('div', 'pv-placeholder');
    this.placeholder.appendChild(iconEl('film', 40));
    const ph = el('span');
    ph.textContent = 'Your movie will play here';
    this.placeholder.appendChild(ph);
    this.selBox = el('div', 'pv-text-sel');
    this.selBox.hidden = true;
    this.stage.append(this.canvas, this.placeholder, this.selBox);

    this.seekRow = el('div', 'pv-seekrow');
    this.seek = el('div', 'pv-seekbar pv-seek', {
      role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0',
      'aria-valuetext': '00:00.00 of 00:00.00',
    });
    const track = el('div', 'pv-seek-track');
    this.seekFill = el('div', 'pv-seek-fill');
    track.appendChild(this.seekFill);
    this.seekKnobWrap = el('div', 'pv-seek-knobwrap');
    this.seekKnobWrap.appendChild(el('div', 'pv-seek-knob'));
    this.seek.append(track, this.seekKnobWrap);
    this.seekTrack = track;
    this.seekRow.appendChild(this.seek);

    this.transport = el('div', 'pv-transport');
    this.timeEl = el('span', 'pv-time', { 'aria-live': 'off' });
    this.timeEl.textContent = '00:00.00/00:00.00';
    this._timeSpacer = el('span', 'pv-time-spacer', { 'aria-hidden': 'true' });
    this._timeSpacer.hidden = true;
    const controls = el('div', 'pv-controls');
    this.prevBtn = el('button', 'pv-btn pv-prev', { type: 'button', title: 'Previous frame', 'aria-label': 'Previous frame' });
    this.prevBtn.appendChild(iconEl('prev-frame', 16));
    this.playBtn = el('button', 'pv-play', { type: 'button', title: 'Play', 'aria-label': 'Play' });
    this._playIcon = svg(PLAY_SVG, 20);
    this._pauseIcon = svg(PAUSE_SVG, 20);
    this.playBtn.appendChild(this._playIcon);
    this.nextBtn = el('button', 'pv-btn pv-next', { type: 'button', title: 'Next frame', 'aria-label': 'Next frame' });
    this.nextBtn.appendChild(iconEl('next-frame', 16));
    controls.append(this.prevBtn, this.playBtn, this.nextBtn);
    const right = el('div', 'pv-right');
    this.fsBtn = el('button', 'pv-btn pv-fs', { type: 'button', title: 'Full screen preview', 'aria-label': 'Full screen preview' });
    this.fsBtn.appendChild(iconEl('fullscreen', 16));
    right.appendChild(this.fsBtn);
    this.transport.append(this.timeEl, this._timeSpacer, controls, right);

    root.append(this.stage, this.seekRow, this.transport);
    this._placeTime();
    this._wireDom();
  }

  /** Phones: the time readout sits left of the seek slider (the transport row is too narrow). */
  _placeTime() {
    let phone = false;
    try { phone = !!(window.matchMedia && window.matchMedia(PHONE_QUERY).matches); } catch (_) { phone = false; }
    if (this.root.classList.contains('pv-desktop') === phone) this.root.classList.toggle('pv-desktop', !phone);
    if (phone && this.timeEl.parentNode !== this.seekRow) this.seekRow.insertBefore(this.timeEl, this.seek);
    else if (!phone && this.timeEl.parentNode !== this.transport) this.transport.insertBefore(this.timeEl, this.transport.firstChild);
    if (this._timeSpacer) this._timeSpacer.hidden = !phone;
  }

  _listen(target, type, fn, opts, list = this._offs) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    list.push(() => target.removeEventListener(type, fn, opts));
  }

  _wireDom() {
    // Stage: taps select / edit texts, double-tap toggles playback.
    this._listen(this.stage, 'pointerdown', (e) => this._onStageDown(e));
    this._listen(this.stage, 'pointermove', (e) => this._onStageMove(e));
    this._listen(this.stage, 'pointerup', (e) => this._onStageUp(e));
    this._listen(this.stage, 'pointercancel', () => { this._down = null; });
    this._listen(this.stage, 'click', (e) => this._onStageClick(e));
    this._listen(this.stage, 'contextmenu', (e) => { if (e.target !== this.editor) e.preventDefault(); });
    this._listen(this.stage, 'dblclick', (e) => { if (e.target !== this.editor) e.preventDefault(); });

    // Seek slider.
    this._listen(this.seek, 'pointerdown', (e) => this._onSeekDown(e));
    this._listen(this.seek, 'pointermove', (e) => this._onSeekMove(e));
    this._listen(this.seek, 'pointerup', (e) => this._onSeekUp(e, false));
    this._listen(this.seek, 'pointercancel', (e) => this._onSeekUp(e, true));
    this._listen(this.seek, 'lostpointercapture', (e) => { if (this._scrub && this._scrub.id === e.pointerId) this._onSeekUp(e, true); });
    this._listen(this.seek, 'keydown', (e) => this._onSeekKey(e));

    // Transport.
    this._listen(this.playBtn, 'click', () => this._togglePlay());
    this._wireRepeat(this.prevBtn, -1);
    this._wireRepeat(this.nextBtn, 1);
    this._listen(this.fsBtn, 'click', () => this.toggleFullscreen());

    // Layout.
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(this.stage);
      this._ro.observe(this.seek);
    }
    this._listen(window, 'resize', () => this._onResize());
    this._listen(window, 'orientationchange', () => setTimeout(() => this._onResize(), 250));
    const onFs = () => this._onFullscreenChange();
    this._listen(document, 'fullscreenchange', onFs);
    this._listen(document, 'webkitfullscreenchange', onFs);
    const appEl = this._appEl();
    if (appEl && typeof MutationObserver === 'function') {
      let was = appEl.classList.contains('is-pseudo-fullscreen');
      this._mo = new MutationObserver(() => {
        const now = appEl.classList.contains('is-pseudo-fullscreen');
        if (now !== was) { was = now; this._onFullscreenChange(); }
      });
      this._mo.observe(appEl, { attributes: true, attributeFilter: ['class'] });
    }
    this._listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible' && this._isPlaying()) this._wake(true);
    });
  }

  _wireRepeat(btn, dir) {
    let timer = 0, interval = 0, fired = false;
    const stop = () => { clearTimeout(timer); clearInterval(interval); timer = 0; interval = 0; };
    this._listen(btn, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (btn.disabled) return;
      stop();
      fired = true;
      this._step(dir);
      timer = setTimeout(() => { interval = setInterval(() => this._step(dir), 90); }, 420);
    });
    this._listen(btn, 'pointerup', stop);
    this._listen(btn, 'pointercancel', stop);
    this._listen(btn, 'pointerleave', stop);
    // Keyboard activation (Enter/Space) arrives as a click with detail 0.
    this._listen(btn, 'click', (e) => {
      if (fired && e.detail !== 0) { fired = false; return; }
      fired = false;
      this._step(dir);
    });
    this._offs.push(stop);
  }

  _subscribeStore() {
    const s = this.store;
    if (!s) return;
    this._listen(s, 'change', () => this._onStoreChange());
    this._listen(s, 'selection', () => this._onSelection());
    this._listen(s, 'media', () => this._updateSelBox());
  }

  // ------------------------------------------------------------------------------- player

  /** Subscribe to player events (call once app.player exists). */
  attach() {
    const p = this.app.player;
    if (!p || typeof p.addEventListener !== 'function') return;
    if (this._player === p) return;
    this._detachPlayer();
    this._player = p;
    this._attached = true;
    const L = (type, fn) => this._listen(p, type, fn, undefined, this._playerOffs);
    L('timeupdate', (e) => {
      const t = e && e.detail && Number.isFinite(e.detail.time) ? e.detail.time : this._currentTime();
      this._time = t;
      this._updateTime(t, this._dur());
      if (!this._isPlaying()) this._updateSelBox();
    });
    L('play', () => this._onPlayState(true));
    L('pause', () => this._onPlayState(false));
    L('ended', () => this._onPlayState(false));
    L('durationchange', () => { this._updateTime(this._currentTime(), this._dur()); this._updatePlaceholder(); });
    this._onPlayState(this._isPlaying());
    this._updateTime(this._currentTime(), this._dur());
    this._updatePlaceholder();
    this._fit();
  }

  _detachPlayer() {
    this._playerOffs.forEach((f) => { try { f(); } catch (_) { /* ignore */ } });
    this._playerOffs = [];
    this._player = null;
  }

  _ensureAttached() {
    if (!this._attached && this.app.player) this.attach();
  }

  _currentTime() {
    const p = this.app.player;
    try { return p && Number.isFinite(p.currentTime) ? p.currentTime : this._time; } catch (_) { return this._time; }
  }

  _dur() {
    const p = this.app.player;
    try {
      if (p && Number.isFinite(p.duration)) return p.duration;
    } catch (_) { /* ignore */ }
    try { return this.store ? num(this.store.timeline.duration, 0) : 0; } catch (_) { return 0; }
  }

  _isPlaying() {
    const p = this.app.player;
    try { return !!(p && p.playing); } catch (_) { return false; }
  }

  _cmds() {
    const c = this.app.commands;
    return c && typeof c.run === 'function' ? c : null;
  }

  _hasCommand(name) {
    const c = this._cmds();
    if (!c) return false;
    try { return typeof c.list !== 'function' || c.list().includes(name); } catch (_) { return true; }
  }

  _run(name, arg) {
    const c = this._cmds();
    if (!c) return undefined;
    try {
      const r = c.run(name, arg);
      if (r && typeof r.then === 'function') r.then(null, (err) => this._report(err));
      return r;
    } catch (err) {
      this._report(err);
      return undefined;
    }
  }

  _report(err) {
    if (!err || err.name === 'AbortError') return;
    const d = this.app.dialogs;
    const msg = err && err.message ? err.message : 'Something went wrong.';
    if (d && typeof d.toast === 'function') { try { d.toast(msg, { type: 'error' }); return; } catch (_) { /* ignore */ } }
    console.error('[preview]', err);
  }

  _unlockAudio() {
    const a = this.app.audio;
    if (!a || typeof a.unlock !== 'function') return;
    try { const r = a.unlock(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (_) { /* ignore */ }
  }

  _togglePlay() {
    this._ensureAttached();
    const p = this.app.player;
    if (!p) return;
    if (!this._isPlaying() && !(this._dur() > 0)) return;
    if (this.editingTextId) this.finishEditing(true);
    // Unlock Web Audio synchronously inside the gesture (iOS), whatever the command does next.
    if (!this._isPlaying()) this._unlockAudio();
    if (this._hasCommand('togglePlay')) { this._run('togglePlay'); return; }
    try { const r = p.toggle ? p.toggle() : (p.playing ? p.pause() : p.play()); if (r && r.catch) r.catch((err) => this._report(err)); } catch (err) { this._report(err); }
  }

  _step(dir) {
    this._ensureAttached();
    const name = dir < 0 ? 'prevFrame' : 'nextFrame';
    if (this.editingTextId) this.finishEditing(true);
    if (this._hasCommand(name)) { this._run(name); return; }
    const p = this.app.player;
    if (p && typeof p.stepFrame === 'function') {
      try { const r = p.stepFrame(dir); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ }
    }
  }

  _seekTo(t, immediate) {
    this._seekT = t;
    const go = () => {
      this._seekRaf = 0;
      const p = this.app.player;
      if (!p || typeof p.seek !== 'function') return;
      try { const r = p.seek(this._seekT); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ }
    };
    if (immediate) {
      if (this._seekRaf) { cancelAnimationFrame(this._seekRaf); this._seekRaf = 0; }
      go();
      return;
    }
    if (!this._seekRaf) this._seekRaf = requestAnimationFrame(go);
  }

  _onPlayState(playing) {
    this.playBtn.classList.toggle('is-playing', playing);
    const label = playing ? 'Pause' : 'Play';
    if (this.playBtn.getAttribute('aria-label') !== label) {
      this.playBtn.setAttribute('aria-label', label);
      this.playBtn.title = label;
      this.playBtn.replaceChild(playing ? this._pauseIcon : this._playIcon, this.playBtn.firstChild);
    }
    this.root.classList.toggle('is-playing', playing);
    if (playing) {
      if (this.editingTextId) this.finishEditing(true);
      this.selBox.hidden = true;
    } else {
      this._updateSelBox();
    }
    this._wake(playing);
    this._updateTime(this._currentTime(), this._dur());
  }

  async _wake(on) {
    try {
      if (on) {
        if (this._wakeLock || typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
        if (document.visibilityState !== 'visible') return;
        const lock = await navigator.wakeLock.request('screen');
        if (!this._isPlaying()) { lock.release().catch(() => {}); return; }
        this._wakeLock = lock;
        lock.addEventListener('release', () => { if (this._wakeLock === lock) this._wakeLock = null; });
      } else if (this._wakeLock) {
        const l = this._wakeLock;
        this._wakeLock = null;
        await l.release();
      }
    } catch (_) { /* wake lock refused (battery saver, permissions): not important */ }
  }

  // ------------------------------------------------------------------------------- time readout & seek bar

  _updateTime(t, dur) {
    const d = dur > 0 ? dur : 0;
    const tt = clamp(num(t, 0), 0, d || 0);
    this._time = tt;
    const txt = `${formatTime(tt)}/${formatTime(d)}`;
    if (txt !== this._timeText) {
      this._timeText = txt;
      this.timeEl.textContent = txt;
    }
    if (!this._scrub) this._setSeekUi(d > 0 ? tt / d : 0);
    if (d !== this._duration) {
      this._duration = d;
      this.seek.setAttribute('aria-valuemax', d.toFixed(2));
      const disabled = !(d > 0);
      this.seek.classList.toggle('is-disabled', disabled);
      this.seek.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      this.playBtn.disabled = disabled && !this._isPlaying();
      this.prevBtn.disabled = disabled;
      this.nextBtn.disabled = disabled;
    }
    const n = nowMs();
    if (!this._isPlaying() || n - (this._ariaAt || 0) > 500) {
      this._ariaAt = n;
      this.seek.setAttribute('aria-valuenow', tt.toFixed(2));
      this.seek.setAttribute('aria-valuetext', `${formatTime(tt)} of ${formatTime(d)}`);
    }
  }

  _setSeekUi(p) {
    const f = clamp(num(p, 0), 0, 1);
    if (this._seekP === f) return;
    this._seekP = f;
    this.seekFill.style.transform = `scaleX(${f})`;
    this.seekKnobWrap.style.transform = `translateX(${(f * 100).toFixed(3)}%)`;
  }

  _seekFrac(clientX) {
    const r = this.seekTrack.getBoundingClientRect();
    if (!(r.width > 0)) return 0;
    return clamp((clientX - r.left) / r.width, 0, 1);
  }

  _onSeekDown(e) {
    this._ensureAttached();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const d = this._dur();
    if (!(d > 0)) return;
    e.preventDefault();
    try { this.seek.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    try { this.seek.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    if (this.editingTextId) this.finishEditing(true);
    const wasPlaying = this._isPlaying();
    if (wasPlaying) {
      const p = this.app.player;
      try { p.pause(); } catch (_) { /* ignore */ }
    }
    this._scrub = { id: e.pointerId, wasPlaying };
    this.seek.classList.add('is-scrubbing');
    this._scrubAt(e.clientX, false);
  }

  _scrubAt(clientX, immediate) {
    const d = this._dur();
    const f = this._seekFrac(clientX);
    this._setSeekUi(f);
    const t = f * d;
    this._updateTimeText(t, d);
    this._seekTo(t, immediate);
  }

  _updateTimeText(t, d) {
    const txt = `${formatTime(t)}/${formatTime(d)}`;
    if (txt !== this._timeText) { this._timeText = txt; this.timeEl.textContent = txt; }
  }

  _onSeekMove(e) {
    if (!this._scrub || this._scrub.id !== e.pointerId) return;
    this._scrubAt(e.clientX, false);
  }

  _onSeekUp(e, cancelled) {
    const s = this._scrub;
    if (!s || s.id !== e.pointerId) return;
    this._scrub = null;
    this.seek.classList.remove('is-scrubbing');
    if (!cancelled) this._scrubAt(e.clientX, true);
    if (s.wasPlaying) {
      this._unlockAudio();
      const p = this.app.player;
      try { const r = p && p.play(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ }
    }
  }

  _onSeekKey(e) {
    const d = this._dur();
    if (!(d > 0)) return;
    const t = this._currentTime();
    let nt = null;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': nt = t - (e.shiftKey ? 5 : 1); break;
      case 'ArrowRight': case 'ArrowUp': nt = t + (e.shiftKey ? 5 : 1); break;
      case 'PageDown': nt = t - d / 10; break;
      case 'PageUp': nt = t + d / 10; break;
      case 'Home': nt = 0; break;
      case 'End': nt = d; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    nt = clamp(nt, 0, d);
    this._updateTime(nt, d);
    this._seekTo(nt, true);
  }

  // ------------------------------------------------------------------------------- layout

  _aspect() {
    const a = this.store && this.store.project ? this.store.project.aspect : '16:9';
    return (ASPECTS && ASPECTS[a]) || 16 / 9;
  }

  /** Size the canvas to the largest box of the project aspect that fits the stage. */
  _fit() {
    const a = this.store && this.store.project ? this.store.project.aspect : '16:9';
    const parts = typeof a === 'string' ? a.split(':') : [];
    const av = parts.length === 2 && +parts[0] > 0 && +parts[1] > 0 ? `${+parts[0]} / ${+parts[1]}` : '16 / 9';
    if (this._aspectVar !== av) { this._aspectVar = av; this.root.style.setProperty('--pv-aspect', av); }
    const st = this.stage;
    const W = st.clientWidth, H = st.clientHeight;
    if (!(W > 0 && H > 0)) return false;
    const aspect = this._aspect();
    let w = W, h = W / aspect;
    if (h > H) { h = H; w = H * aspect; }
    const sw = `${Math.max(1, Math.floor(w))}px`, sh = `${Math.max(1, Math.floor(h))}px`;
    let changed = false;
    if (this.canvas.style.width !== sw) { this.canvas.style.width = sw; changed = true; }
    if (this.canvas.style.height !== sh) { this.canvas.style.height = sh; changed = true; }
    return changed;
  }

  _onResize() {
    this._placeTime();
    this._fit();
    if (this.editingTextId) this._layoutEditor();
    this._updateSelBox();
  }

  /** The movie frame inside the stage, in CSS px relative to the stage's padding box. */
  _frameRect() {
    const c = this.canvas;
    const cr = c.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    if (!(cr.width > 0 && cr.height > 0)) return null;
    const ox = cr.left - sr.left - this.stage.clientLeft;
    const oy = cr.top - sr.top - this.stage.clientTop;
    let fx = 0, fy = 0, fw = cr.width, fh = cr.height;
    const p = this.app.player;
    let fr = null;
    try { fr = p && p.frameRect; } catch (_) { fr = null; }
    if (fr && fr.width > 0 && fr.height > 0 && fr.width <= cr.width + 1 && fr.height <= cr.height + 1) {
      fx = fr.x; fy = fr.y; fw = fr.width; fh = fr.height;
    } else {
      const aspect = this._aspect();
      let w = cr.width, h = cr.width / aspect;
      if (h > cr.height) { h = cr.height; w = cr.height * aspect; }
      fx = (cr.width - w) / 2; fy = (cr.height - h) / 2; fw = w; fh = h;
    }
    return { x: ox + fx, y: oy + fy, w: fw, h: fh, clientLeft: cr.left + fx, clientTop: cr.top + fy };
  }

  _measureCtx() {
    if (!this._measureCanvas) {
      this._measureCanvas = document.createElement('canvas');
      this._measureCanvas.width = 4;
      this._measureCanvas.height = 4;
    }
    return this._measureCanvas.getContext('2d');
  }

  _textBox(text, style, fr) {
    const ctx = this._measureCtx();
    if (typeof TextMod.measureTextBox === 'function' && ctx) {
      try {
        const b = TextMod.measureTextBox(ctx, { text, style, w: fr.w, h: fr.h });
        if (b && b.width > 0 && b.height > 0) return b;
      } catch (_) { /* fall back */ }
    }
    return { x: fr.w * 0.1, y: fr.h * 0.4, width: fr.w * 0.8, height: fr.h * 0.2 };
  }

  // ------------------------------------------------------------------------------- texts at a time

  /** Resolve an id to the text it edits: { type:'text'|'item', obj, start, end, text, style, effect }. */
  _resolveText(id) {
    const s = this.store;
    if (!s || !id) return null;
    let found = null;
    try { found = typeof s.find === 'function' ? s.find(id) : null; } catch (_) { found = null; }
    if (!found || !found.obj) return null;
    let tl = null;
    try { tl = s.timeline; } catch (_) { tl = null; }
    if (found.type === 'text') {
      const o = found.obj;
      const e = tl && tl.texts ? tl.texts.find((x) => x.item && x.item.id === id) : null;
      const start = e ? e.start : num(o.start, 0);
      const end = e ? e.end : start + num(o.duration, 0);
      return { type: 'text', obj: o, start, end, text: o.text || '', style: o.style, effect: o.effect || 'none' };
    }
    if (found.type === 'item' && found.obj.kind === 'title') {
      const o = found.obj;
      const seg = tl && tl.segments ? tl.segments.find((x) => x.item && x.item.id === id) : null;
      const start = seg ? seg.start : 0;
      const end = seg ? seg.end : start + num(o.duration, 0);
      return { type: 'item', obj: o, start, end, text: o.text || '', style: o.style, effect: o.textEffect || 'none' };
    }
    return null;
  }

  /** Texts visible at time t, topmost first: captions/credits (drawn last) then titles. */
  _textsAt(t) {
    const out = [];
    let tl = null;
    try { tl = this.store && this.store.timeline; } catch (_) { tl = null; }
    if (!tl) return out;
    const texts = tl.texts || [];
    for (let i = texts.length - 1; i >= 0; i--) {
      const e = texts[i];
      if (e.item && t >= e.start && t < e.end) out.push(e.item.id);
    }
    const segs = tl.segments || [];
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (s.item && s.item.kind === 'title' && t >= s.start && t < s.end) out.push(s.item.id);
    }
    return out;
  }

  _hitText(clientX, clientY) {
    const fr = this._frameRect();
    if (!fr) return null;
    const x = clientX - fr.clientLeft;
    const y = clientY - fr.clientTop;
    if (x < 0 || y < 0 || x > fr.w || y > fr.h) return null;
    const t = this._currentTime();
    const slop = 8;
    for (const id of this._textsAt(t)) {
      const r = this._resolveText(id);
      if (!r) continue;
      if (r.effect === 'scroll' || r.effect === 'ticker') return { id, type: r.type };
      const b = this._textBox(r.text, r.style, fr);
      if (x >= b.x - slop && x <= b.x + b.width + slop && y >= b.y - slop && y <= b.y + b.height + slop) return { id, type: r.type };
    }
    return null;
  }

  // ------------------------------------------------------------------------------- stage taps

  _onStageDown(e) {
    if (this.editor && (e.target === this.editor || this.editor.contains(e.target))) return;
    this._ensureAttached();
    // Keep the browser from moving focus (and closing the on-screen keyboard) or selecting text.
    if (e.cancelable) e.preventDefault();
    if (e.pointerType === 'mouse' && e.button !== 0) { this._down = null; return; }
    if (this.editingTextId) {
      this.finishEditing(true);
      this._down = null;
      this._lastTap = null;
      return;
    }
    this._down = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  }

  _onStageMove(e) {
    const d = this._down;
    if (!d || d.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_MOVE_PX) d.moved = true;
  }

  _onStageUp(e) {
    if (this.editor && (e.target === this.editor || this.editor.contains(e.target))) return;
    const d = this._down;
    this._down = null;
    if (!d || d.moved || d.id !== e.pointerId) return;
    const t = nowMs();
    const playing = this._isPlaying();
    if (!playing && this.store) {
      const hit = this._hitText(e.clientX, e.clientY);
      if (hit) {
        this._lastTap = null;
        const sel = this.store.selection || { type: null, ids: [] };
        if (sel.ids && sel.ids.length === 1 && sel.ids[0] === hit.id) {
          this.editText(hit.id);
        } else {
          this.store.select(hit.type, [hit.id]);
        }
        return;
      }
    }
    const last = this._lastTap;
    if (last && t - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
      this._lastTap = null;
      this._lastToggleAt = t;
      this._togglePlay();
      return;
    }
    this._lastTap = { t, x: e.clientX, y: e.clientY };
  }

  /** Safety net: if a browser refused focus() during pointerup, a click is always a user gesture. */
  _onStageClick(e) {
    // Some browsers only count click (not pointerup) as a gesture that may start audio.
    if (nowMs() - (this._lastToggleAt || -1e9) < 700 && this._isPlaying()) this._unlockAudio();
    if (!this.editor || e.target === this.editor) return;
    if (document.activeElement !== this.editor && nowMs() - this._editStartedAt < 1000) {
      try { this.editor.focus({ preventScroll: true }); } catch (_) { this.editor.focus(); }
    }
  }

  // ------------------------------------------------------------------------------- selection box

  _onSelection() {
    if (this.editingTextId) {
      const sel = this.store.selection || { ids: [] };
      if (!(sel.ids && sel.ids.length === 1 && sel.ids[0] === this.editingTextId)) this.finishEditing(true);
    }
    this._updateSelBox();
  }

  _updateSelBox() {
    const box = this.selBox;
    const hide = () => { if (!box.hidden) box.hidden = true; this.stage.classList.remove('is-clickable-text'); };
    if (!this.store || this.editingTextId || this._isPlaying()) { hide(); return; }
    const sel = this.store.selection || { type: null, ids: [] };
    if (!sel.ids || sel.ids.length !== 1 || (sel.type !== 'text' && sel.type !== 'item')) { hide(); return; }
    const r = this._resolveText(sel.ids[0]);
    if (!r) { hide(); return; }
    const t = this._currentTime();
    if (!(t >= r.start && t < r.end)) { hide(); return; }
    const fr = this._frameRect();
    if (!fr) { hide(); return; }
    let b;
    if (r.effect === 'scroll' || r.effect === 'ticker') b = { x: fr.w * 0.05, y: fr.h * 0.06, width: fr.w * 0.9, height: fr.h * 0.88 };
    else b = this._textBox(r.text, r.style, fr);
    const x = clamp(fr.x + b.x, fr.x, fr.x + fr.w), y = clamp(fr.y + b.y, fr.y, fr.y + fr.h);
    const w = Math.min(fr.x + fr.w, fr.x + b.x + b.width) - x;
    const h = Math.min(fr.y + fr.h, fr.y + b.y + b.height) - y;
    if (!(w > 1 && h > 1)) { hide(); return; }
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.hidden = false;
    this.stage.classList.add('is-clickable-text');
  }

  _onStoreChange() {
    if (this._fit()) { /* canvas resized: the player re-measures through its ResizeObserver */ }
    if (this.editingTextId) {
      if (!this._resolveText(this.editingTextId)) this.finishEditing(false);
      else this._layoutEditor();
    }
    this._updatePlaceholder();
    this._updateTime(this._currentTime(), this._dur());
    this._updateSelBox();
  }

  _updatePlaceholder() {
    let empty = true;
    try {
      const p = this.store && this.store.project;
      empty = !p || (!(p.items && p.items.length) && !(p.texts && p.texts.length) && !(p.music && p.music.length));
    } catch (_) { empty = true; }
    if (this.placeholder.hidden !== !empty) this.placeholder.hidden = !empty;
  }

  // ------------------------------------------------------------------------------- inline text editing

  /**
   * Start editing a caption/credits (TextItem id) or a title (VisualItem id) in place.
   * Returns true if editing started.
   */
  editText(id) {
    const r = this._resolveText(id);
    if (!r) return false;
    this._ensureAttached();
    if (this.editingTextId === id && this.editor) {
      try { this.editor.focus({ preventScroll: true }); } catch (_) { this.editor.focus(); }
      return true;
    }
    if (this.editingTextId) this.finishEditing(true);
    const store = this.store;
    // Commands like textEdit / textSet act on the selection: make it this text.
    const sel = store.selection || { ids: [] };
    if (!(sel.ids && sel.ids.length === 1 && sel.ids[0] === id)) {
      try { store.select(r.type, [id]); } catch (_) { /* ignore */ }
    }
    const p = this.app.player;
    if (p && this._isPlaying()) { try { p.pause(); } catch (_) { /* ignore */ } }
    // Show a moment where the text is on screen.
    const t = this._currentTime();
    if (!(t >= r.start && t < r.end) && r.end > r.start && p && typeof p.seek === 'function') {
      const at = r.start + Math.min(0.5, (r.end - r.start) / 2);
      try { const q = p.seek(at); if (q && q.catch) q.catch(() => {}); } catch (_) { /* ignore */ }
      this._time = at;
    }
    this.editingTextId = id;
    this._editOrig = r.text;
    this._editStartedAt = nowMs();
    this._hideInPlayer(id);

    const ta = el('textarea', 'pv-text-editor', {
      'aria-label': r.type === 'item' ? 'Title text' : (r.obj.kind === 'credits' ? 'Credits text' : 'Caption text'),
      spellcheck: 'true', autocapitalize: 'sentences', autocomplete: 'off', rows: '1', wrap: 'soft',
    });
    ta.value = r.text;
    this.editor = ta;
    this.stage.appendChild(ta);
    this._editOffs = [];
    const L = (target, type, fn, opts) => this._listen(target, type, fn, opts, this._editOffs);
    L(ta, 'input', () => this._layoutEditor());
    L(ta, 'keydown', (e) => this._onEditorKey(e));
    for (const type of ['keyup', 'keypress', 'paste', 'copy', 'cut']) L(ta, type, (e) => e.stopPropagation());
    L(ta, 'pointerdown', (e) => e.stopPropagation());
    L(ta, 'blur', () => this._onEditorBlur());
    L(document, 'pointerdown', (e) => this._onDocDownWhileEditing(e), true);
    // Escape anywhere (e.g. focus is on a ribbon button) ends editing unless something else used it.
    L(document, 'keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && this.editingTextId && document.activeElement !== this.editor) this.finishEditing(true);
    });
    this.selBox.hidden = true;
    this._layoutEditor();
    try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); }
    try {
      if (DEFAULT_TEXTS.has(r.text.trim())) ta.select();
      else ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch (_) { /* ignore */ }
    return true;
  }

  _hideInPlayer(id) {
    const p = this.app.player;
    if (!p) return;
    this._hiddenSet = id ? new Set([id]) : null;
    try { p.hideTextIds = this._hiddenSet; } catch (_) { /* ignore */ }
    try { if (typeof p.renderNow === 'function') { const r = p.renderNow(); if (r && r.catch) r.catch(() => {}); } } catch (_) { /* ignore */ }
  }

  _onEditorKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.finishEditing(false);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      this.finishEditing(true);
    }
  }

  _isRibbonEl(node) {
    return !!(node && node.closest && node.closest('#ribbon, .rb-popup-layer'));
  }

  _onDocDownWhileEditing(e) {
    const t = e.target;
    if (!this.editingTextId) return;
    if (this.editor && this.editor.contains(t)) return;
    if (this._isRibbonEl(t)) { this._downInRibbonAt = nowMs(); return; }
    if (this.stage.contains(t)) return; // the stage handler finishes and handles the tap
    this.finishEditing(true);
  }

  _onEditorBlur() {
    setTimeout(() => {
      if (!this.editingTextId || !this.editor) return;
      if (document.activeElement === this.editor) return;
      const ae = document.activeElement;
      if (nowMs() - this._downInRibbonAt < 1500 || this._isRibbonEl(ae)) {
        // Formatting from the ribbon (Text Tools): keep the box open, save what was typed and,
        // after a plain button (Bold, Align…), put the caret back so typing can continue.
        this._commit(this.editingTextId, this.editor.value);
        const tag = ae && ae.tagName;
        if (!ae || ae === document.body || tag === 'BUTTON') {
          const ed = this.editor;
          setTimeout(() => {
            if (this.editor !== ed || !ed) return;
            const a2 = document.activeElement;
            if (a2 && a2 !== document.body && a2.tagName !== 'BUTTON') return; // a popup took focus
            try { ed.focus({ preventScroll: true }); } catch (_) { ed.focus(); }
          }, 0);
        }
        return;
      }
      this.finishEditing(true);
    }, 0);
  }

  _commit(id, value) {
    if (!id) return;
    const r = this._resolveText(id);
    if (!r || r.text === value) return;
    const store = this.store;
    const sel = store.selection || { ids: [] };
    if (!(sel.ids && sel.ids.length === 1 && sel.ids[0] === id)) {
      try { store.select(r.type, [id]); } catch (_) { /* ignore */ }
    }
    if (this._hasCommand('textEdit')) {
      this._run('textEdit', value);
    } else {
      try {
        store.update(() => { r.obj.text = value; }, { label: 'Edit text' });
      } catch (err) { this._report(err); }
    }
  }

  /** End inline editing; commit (default) saves the text through the textEdit command. */
  finishEditing(commit = true) {
    const id = this.editingTextId;
    if (!id) return;
    const ta = this.editor;
    const value = ta ? ta.value : '';
    // Detach first so the store change caused by the commit does not re-enter.
    this.editingTextId = null;
    this.editor = null;
    if (this._editOffs) { this._editOffs.forEach((f) => { try { f(); } catch (_) { /* ignore */ } }); this._editOffs = null; }
    const hadFocus = ta && document.activeElement === ta;
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    if (commit) this._commit(id, value);
    const p = this.app.player;
    if (p) {
      try { if (p.hideTextIds === this._hiddenSet || !this._hiddenSet) p.hideTextIds = null; } catch (_) { /* ignore */ }
      this._hiddenSet = null;
      try { if (typeof p.renderNow === 'function') { const r = p.renderNow(); if (r && r.catch) r.catch(() => {}); } } catch (_) { /* ignore */ }
    }
    if (hadFocus) { try { ta.blur(); } catch (_) { /* ignore */ } }
    this._updateSelBox();
  }

  /** Position and style the editor exactly over the text box (frame px → CSS px). */
  _layoutEditor() {
    const ta = this.editor;
    const id = this.editingTextId;
    if (!ta || !id) return;
    const r = this._resolveText(id);
    const fr = this._frameRect();
    if (!r || !fr) return;
    const style = r.obj.style || {};
    const text = ta.value;
    const b = this._textBox(text, style, fr);
    const px = fontPxFor(style, fr.h);
    const lh = px * LINE_HEIGHT;
    const padX = px * 0.35, padY = px * 0.15;
    const slack = 2 + px * 0.12;
    let left = fr.x + b.x;
    let width = Math.max(b.width + slack, px * 1.6);
    const align = style.align === 'left' || style.align === 'right' ? style.align : 'center';
    if (align === 'center') left -= (width - b.width) / 2;
    else if (align === 'right') left -= (width - b.width);
    const top = fr.y + b.y;
    const height = Math.max(b.height, lh + 2 * padY) + 1;
    // Keep the computed font size >= 16px so iOS does not zoom the page on focus; scale it down instead.
    const k = px < 16 ? px / 16 : 1;
    const s = ta.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${width / k}px`;
    s.height = `${height / k}px`;
    s.padding = `${padY / k}px ${padX / k}px`;
    s.fontSize = `${px / k}px`;
    s.lineHeight = `${lh / k}px`;
    s.transform = k !== 1 ? `scale(${k})` : '';
    s.fontFamily = style.font || 'Segoe UI, Arial, sans-serif';
    s.fontWeight = style.bold ? '700' : '400';
    s.fontStyle = style.italic ? 'italic' : 'normal';
    s.textAlign = align;
    s.color = style.color || '#ffffff';
    s.caretColor = style.color || '#ffffff';
    s.background = style.background || 'transparent';
    const op = num(style.opacity, 1);
    s.opacity = String(clamp(op, 0.45, 1));
    const ow = OUTLINE[style.outline] || 0;
    if (ow > 0) {
      const d = Math.max(0.75, px * ow) / k;
      const c = style.outlineColor || '#000000';
      s.textShadow = [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]
        .map(([x, y]) => `${c} ${x.toFixed(2)}px ${y.toFixed(2)}px 0`).join(',');
    } else {
      s.textShadow = '0 0 1px rgba(0,0,0,.35)';
    }
  }

  // ------------------------------------------------------------------------------- full screen

  _fsElement() {
    const d = document;
    return d.fullscreenElement || d.webkitFullscreenElement || null;
  }

  _appEl() { return document.getElementById('app') || this.root.closest('.mm-app') || null; }

  isFullscreen() {
    const a = this._appEl();
    return this._fsElement() === this.root || !!(a && a.classList.contains('is-pseudo-fullscreen'));
  }

  toggleFullscreen() {
    const d = document;
    const fsEl = this._fsElement();
    if (fsEl) {
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      if (exit) { try { const r = exit.call(d); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ } }
      return;
    }
    const a = this._appEl();
    if (a && a.classList.contains('is-pseudo-fullscreen')) { this._pseudo(false); return; }
    const pane = this.root;
    const enabled = d.fullscreenEnabled || d.webkitFullscreenEnabled;
    const req = pane.requestFullscreen || pane.webkitRequestFullscreen;
    if (enabled && req) {
      try {
        const r = req.call(pane);
        if (r && typeof r.then === 'function') {
          r.then(() => this._lockOrientation(), () => this._pseudo(true));
        } else {
          setTimeout(() => this._lockOrientation(), 50);
        }
        return;
      } catch (_) { /* fall back to the pseudo full screen overlay */ }
    }
    this._pseudo(true);
  }

  _lockOrientation() {
    try {
      const o = screen.orientation;
      const aspect = this._aspect();
      if (o && typeof o.lock === 'function' && aspect > 1.05 && mqMatchesCoarse()) {
        o.lock('landscape').catch(() => {});
      }
    } catch (_) { /* not supported */ }
  }

  _pseudo(on) {
    const a = this._appEl();
    if (!a) return;
    a.classList.toggle('is-pseudo-fullscreen', on);
    if (on) {
      if (!document.querySelector('.pv-fs-exit')) {
        const b = el('button', 'pv-fs-exit', { type: 'button', title: 'Exit full screen', 'aria-label': 'Exit full screen' });
        b.appendChild(iconEl('exit-fullscreen', 22));
        b.addEventListener('click', () => this._pseudo(false));
        document.body.appendChild(b);
        this._pseudoExit = b;
      }
      if (!this._pseudoKey) {
        this._pseudoKey = (e) => { if (e.key === 'Escape' && !this.editingTextId) this._pseudo(false); };
        document.addEventListener('keydown', this._pseudoKey);
      }
    } else {
      document.querySelectorAll('.pv-fs-exit').forEach((n) => n.remove());
      this._pseudoExit = null;
      if (this._pseudoKey) { document.removeEventListener('keydown', this._pseudoKey); this._pseudoKey = null; }
    }
    this._onFullscreenChange();
    requestAnimationFrame(() => {
      this._onResize();
      try { window.dispatchEvent(new Event('resize')); } catch (_) { /* ignore */ }
    });
  }

  _onFullscreenChange() {
    const on = this.isFullscreen();
    this.root.classList.toggle('is-fullscreen', on);
    const label = on ? 'Exit full screen' : 'Full screen preview';
    if (this.fsBtn.getAttribute('aria-label') !== label) {
      this.fsBtn.setAttribute('aria-label', label);
      this.fsBtn.title = label;
      this.fsBtn.replaceChildren ? this.fsBtn.replaceChildren(iconEl(on ? 'exit-fullscreen' : 'fullscreen', 16))
        : (this.fsBtn.textContent = '', this.fsBtn.appendChild(iconEl(on ? 'exit-fullscreen' : 'fullscreen', 16)));
    }
    if (!this._fsElement()) {
      try { if (screen.orientation && typeof screen.orientation.unlock === 'function') screen.orientation.unlock(); } catch (_) { /* ignore */ }
    }
    requestAnimationFrame(() => this._onResize());
  }

  // ------------------------------------------------------------------------------- teardown

  destroy() {
    this._destroyed = true;
    if (this.editingTextId) this.finishEditing(true);
    this._detachPlayer();
    this._offs.forEach((f) => { try { f(); } catch (_) { /* ignore */ } });
    this._offs = [];
    if (this._ro) { try { this._ro.disconnect(); } catch (_) { /* ignore */ } }
    if (this._mo) { try { this._mo.disconnect(); } catch (_) { /* ignore */ } }
    this._wake(false);
    if (this._pseudoKey) document.removeEventListener('keydown', this._pseudoKey);
    this.root.classList.remove('pv-root', 'is-playing', 'is-fullscreen');
  }
}

function mqMatchesCoarse() {
  try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (_) { return false; }
}
