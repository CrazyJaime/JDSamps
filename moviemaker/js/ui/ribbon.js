// ui/ribbon.js — the Movie Maker ribbon (tabs, groups, galleries, contextual tabs),
// quick access toolbar (#qat), application button wiring (#app-menu-btn), title text
// (#doc-title) and the status bar controls (#status-text, #status-controls).
//
//   export class Ribbon { constructor(rootEl, app); refresh(); activateTab(id); get activeTab(); destroy(); }
//
// State comes from app.store (project, selection, view); actions go through app.commands
// (run / isEnabled / isChecked). The ribbon subscribes to the store itself, so callers only
// need refresh() after changing something the ribbon cannot observe.
//
// Layout: desktop = classic WLMM 2011 ribbon; phone (see dom.js isPhone()) = scrolling tab strip
// and one scrolling row of 44px+ commands, galleries/menus open as bottom sheets.

import {
  h, on, clamp, rafThrottle, debounce, isPhone, watchLayout, prefersReducedMotion, clear,
} from './dom.js';
import { icon } from './icons.js';
import { TRANSITIONS, PANZOOM, EFFECTS, TEXT_EFFECTS, AUTOMOVIE_THEMES } from '../catalog.js';
import { SPEEDS, ASPECTS, DEFAULT_TRANSITION_DURATION, formatTime } from '../model.js';

// ---------------------------------------------------------------------------
// Optional modules written by other owners: loaded lazily so the ribbon still works if one
// of them fails to load (galleries fall back to labelled tiles, presets to the contract list).

const FALLBACK_PRESETS = [
  { id: 'recommended', name: 'Recommended for this project', height: 720 },
  { id: 'hd1080', name: 'High definition (1080p)', height: 1080 },
  { id: 'hd720', name: 'High definition (720p)', height: 720 },
  { id: 'wide480', name: 'Widescreen (480p)', height: 480 },
  { id: 'mobile', name: 'For mobile phone', height: 480 },
  { id: 'email', name: 'For email', height: 240 },
];
const PRESET_ICONS = {
  recommended: 'save-movie', hd1080: 'aspect-wide', hd720: 'aspect-wide', wide480: 'film', mobile: 'aspect-portrait', email: 'share',
};
let exportPresets = FALLBACK_PRESETS;
let presetsPromise = null;
function loadPresets() {
  if (!presetsPromise) {
    presetsPromise = import('../exporter.js').then((m) => {
      if (m && Array.isArray(m.EXPORT_PRESETS) && m.EXPORT_PRESETS.length) exportPresets = m.EXPORT_PRESETS;
    }).catch((err) => { console.warn('[ribbon] export presets unavailable, using defaults:', err && err.message); });
  }
  return presetsPromise;
}

let renderThumbFn = null;
let galleryPromise = null;
function loadGallery() {
  if (!galleryPromise) {
    galleryPromise = import('../gallery.js').then((m) => {
      if (m && typeof m.renderGalleryThumb === 'function') renderThumbFn = m.renderGalleryThumb;
    }).catch((err) => { console.warn('[ribbon] gallery thumbnails unavailable, using labelled tiles:', err && err.message); });
  }
  return galleryPromise;
}

// ---------------------------------------------------------------------------
// Constants

const FADE_OPTIONS = [
  { value: 'none', label: 'None' }, { value: 'slow', label: 'Slow' },
  { value: 'medium', label: 'Medium' }, { value: 'fast', label: 'Fast' },
];
const OUTLINE_OPTIONS = [
  { value: 'none', label: 'None' }, { value: 'thin', label: 'Small' },
  { value: 'medium', label: 'Medium' }, { value: 'thick', label: 'Large' },
];
const VALIGN_OPTIONS = [
  { value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' },
];
const FONTS = [
  { value: 'Segoe UI, Arial, sans-serif', label: 'Segoe UI' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: 'Arial Black, Arial, sans-serif', label: 'Arial Black' },
  { value: 'Calibri, Carlito, Arial, sans-serif', label: 'Calibri' },
  { value: 'Cambria, Georgia, serif', label: 'Cambria' },
  { value: 'Comic Sans MS, Comic Neue, cursive', label: 'Comic Sans MS' },
  { value: 'Courier New, Courier, monospace', label: 'Courier New' },
  { value: 'Georgia, Times New Roman, serif', label: 'Georgia' },
  { value: 'Helvetica Neue, Helvetica, Arial, sans-serif', label: 'Helvetica' },
  { value: 'Impact, Haettenschweiler, Arial Narrow Bold, sans-serif', label: 'Impact' },
  { value: 'Palatino Linotype, Palatino, Book Antiqua, serif', label: 'Palatino' },
  { value: 'Tahoma, Verdana, sans-serif', label: 'Tahoma' },
  { value: 'Times New Roman, Times, serif', label: 'Times New Roman' },
  { value: 'Trebuchet MS, Helvetica, sans-serif', label: 'Trebuchet MS' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: 'Brush Script MT, Brush Script Std, cursive', label: 'Brush Script' },
  { value: 'system-ui, -apple-system, sans-serif', label: 'System' },
];
const TEXT_SIZES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
const TRANSITION_DURATIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const ITEM_DURATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 30];
const TEXT_DURATIONS = [1, 2, 3, 3.5, 4, 5, 7, 10, 15, 20];

// Office-style palette: theme colors + 5 tints/shades, then standard colors.
const THEME_COLORS = ['#ffffff', '#000000', '#eeece1', '#1f497d', '#4f81bd', '#c0504d', '#9bbb59', '#8064a2', '#4bacc6', '#f79646'];
const STANDARD_COLORS = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
function mix(hex, target, amt) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(target.slice(1), 16);
  const ch = (x, y) => Math.round(x + (y - x) * amt);
  const r = ch((a >> 16) & 255, (b >> 16) & 255), g = ch((a >> 8) & 255, (b >> 8) & 255), bl = ch(a & 255, b & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}
const PALETTE_ROWS = (() => {
  const rows = [THEME_COLORS.slice()];
  const steps = [['#ffffff', 0.8], ['#ffffff', 0.6], ['#ffffff', 0.4], ['#000000', 0.25], ['#000000', 0.5]];
  for (const [t, amt] of steps) {
    rows.push(THEME_COLORS.map((c, i) => {
      if (i === 0) return mix('#ffffff', '#000000', [0.05, 0.15, 0.25, 0.35, 0.5][rows.length - 1]);
      if (i === 1) return mix('#000000', '#ffffff', [0.5, 0.35, 0.25, 0.15, 0.05][rows.length - 1]);
      return mix(c, t, amt);
    }));
  }
  return rows;
})();

const TILE = { ribbon: [64, 48], full: [68, 51], sheet: [128, 96], launch: [40, 30] };
const TILE_STEP_X = 72;   // ribbon tile width (70) + column gap (2)
const TILE_STEP_Y = 64;   // ribbon tile height (54) + row gap (10)
const ZOOM_MIN = 5, ZOOM_MAX = 400, ZOOM_DEFAULT = 40;

const dpr = () => Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const sameColor = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Parse "7", "7.5", "1:05.25", "0:07" → seconds; NaN when invalid. */
function parseSeconds(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : NaN;
  const t = String(s || '').trim().replace(',', '.').replace(/\s*s(ec(onds?)?)?$/i, '');
  if (!t) return NaN;
  const parts = t.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    if (!/^\d*\.?\d*$/.test(p) || p === '' || p === '.') return NaN;
    total = total * 60 + Number(p);
  }
  return total;
}
function fmtSeconds(v, timeStyle) {
  if (!Number.isFinite(v)) return '';
  if (timeStyle) return formatTime(v);
  return (Math.round(v * 100) / 100).toFixed(2);
}
function friendlyError(err) {
  const msg = err && (err.message || String(err));
  if (!msg || /^\s*$/.test(msg)) return 'Something went wrong. Please try again.';
  return msg.length > 200 ? `${msg.slice(0, 197)}…` : msg;
}
function groupsOfList(list) {
  const out = new Map();
  for (const e of list || []) {
    if (!e) continue;
    const g = e.group || 'Other';
    if (!out.has(g)) out.set(g, []);
    out.get(g).push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gallery thumbnail drawing + hover/press animation

function drawFallbackTile(canvas, entry) {
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch (_) { ctx = null; }
  if (!ctx) return;
  const w = canvas.width, h0 = canvas.height;
  const g = ctx.createLinearGradient(0, 0, 0, h0);
  g.addColorStop(0, '#6a92c0');
  g.addColorStop(1, '#2b4f7d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h0);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(0, 0, w, h0 * 0.45);
  const name = (entry && entry.name) || '';
  const fs = Math.max(8, Math.round(h0 / 5.2));
  ctx.font = `600 ${fs}px Segoe UI, Arial, sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const words = name.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > w - 6 && line) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 3);
  const lh = fs * 1.1;
  const y0 = h0 / 2 - ((shown.length - 1) * lh) / 2;
  shown.forEach((l, i) => ctx.fillText(l, w / 2, y0 + i * lh, w - 4));
}

const _fallbackDrawn = new Set();
function drawThumb(canvas, kind, entry, p) {
  if (!canvas || !entry) return;
  if (renderThumbFn) {
    try {
      renderThumbFn(canvas, kind, entry.id, p);
      _fallbackDrawn.delete(canvas);
      return;
    } catch (err) {
      console.warn('[ribbon] renderGalleryThumb failed:', err);
    }
  }
  drawFallbackTile(canvas, entry);
  _fallbackDrawn.add(canvas);
}

class ThumbAnimator {
  constructor() {
    this.cur = null;
    this.raf = 0;
    this.t0 = 0;
    this._tick = this._tick.bind(this);
  }
  start(canvas, kind, entry) {
    if (this.cur && this.cur.canvas === canvas) return;
    this.stop();
    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') return;
    this.cur = { canvas, kind, entry };
    this.t0 = performance.now();
    this.raf = requestAnimationFrame(this._tick);
  }
  stop(canvas) {
    const c = this.cur;
    if (!c || (canvas && c.canvas !== canvas)) return;
    this.cur = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (c.canvas.isConnected) drawThumb(c.canvas, c.kind, c.entry);
  }
  _tick(now) {
    const c = this.cur;
    if (!c) return;
    if (!c.canvas.isConnected) { this.cur = null; this.raf = 0; return; }
    const run = 1700, hold = 450;
    const e = (now - this.t0) % (run + hold);
    const p = Math.min(1, e / run);
    drawThumb(c.canvas, c.kind, c.entry, p);
    this.raf = requestAnimationFrame(this._tick);
  }
}

// ---------------------------------------------------------------------------
// Popups: desktop dropdowns and phone bottom sheets

class Popups {
  constructor(ribbon) {
    this.ribbon = ribbon;
    this.layer = h('div.rb-popup-layer');
    this.colorInput = h('input', { type: 'color', tabindex: '-1', 'aria-hidden': 'true', style: 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;' });
    this.colorApply = null;
    this.colorInput.addEventListener('change', () => {
      const fn = this.colorApply;
      this.colorApply = null;
      if (fn) fn(this.colorInput.value);
    });
    this.layer.appendChild(this.colorInput);
    document.body.appendChild(this.layer);
    this.cur = null;
    this._onDown = this._onDown.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onResize = debounce(() => { if (this.cur && !this.cur.sheet) this.close(); }, 60);
  }

  get isOpen() { return !!this.cur; }

  /**
   * Open `content` anchored to `anchor`. opts: { sheet, title, className, width, align: 'start'|'cover', onClose }
   * Returns the scroll container (for lazy rendering).
   */
  open(anchor, content, opts = {}) {
    this.close();
    const sheet = opts.sheet != null ? opts.sheet : isPhone();
    let root, scroller, panel;
    if (sheet) {
      const backdrop = h('div.rb-sheet-backdrop', { onclick: () => this.close() });
      const closeBtn = h('button.rb-sheet-close', { type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => this.close() }, icon('close', 18));
      const head = h('div.rb-sheet-head', null, h('div.rb-sheet-title', null, opts.title || ''), closeBtn);
      scroller = h('div.rb-sheet-body', null, content);
      panel = h('div.rb-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Options', class: opts.className || '' }, head, scroller);
      root = h('div', null, backdrop, panel);
      this._wireSheetDrag(head, panel);
    } else {
      panel = h('div.rb-popup', { role: 'dialog', 'aria-label': opts.title || 'Options', class: opts.className || '' }, content);
      root = panel;
      scroller = panel;
    }
    this.layer.appendChild(root);
    const toggle = opts.toggle || anchor || null;
    this.cur = { anchor, toggle, root, panel, sheet, onClose: opts.onClose };
    if (toggle && toggle.setAttribute) toggle.setAttribute('aria-expanded', 'true');
    if (!sheet) this._position(anchor, panel, opts);
    document.addEventListener('pointerdown', this._onDown, true);
    document.addEventListener('keydown', this._onKey, true);
    window.addEventListener('resize', this._onResize);
    // Keyboard users land on the first item; touch users should not get a focus ring.
    const first = panel.querySelector('button:not(:disabled), input, select');
    if (first && !sheet && opts.focus !== false) { try { first.focus({ preventScroll: true }); } catch (_) { first.focus(); } }
    return scroller;
  }

  _position(anchor, panel, opts) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 8, top: 8, bottom: 8, right: 8, width: 0, height: 0 };
    if (opts.width) panel.style.width = `${Math.min(opts.width, vw - 8)}px`;
    if (opts.minWidth) panel.style.minWidth = `${Math.min(opts.minWidth, vw - 8)}px`;
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    let left = r.left;
    let top = opts.align === 'cover' ? r.top : r.bottom + 1;
    if (left + pw > vw - 4) left = Math.max(4, vw - 4 - pw);
    let maxH = vh - top - 6;
    if (ph > maxH && opts.align !== 'cover' && r.top - 6 > maxH + 40) {
      // more room above the anchor
      maxH = Math.min(ph, r.top - 6);
      top = r.top - 1 - maxH;
    }
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(4, top))}px`;
    panel.style.maxHeight = `${Math.max(120, Math.round(maxH))}px`;
  }

  _wireSheetDrag(handle, sheet) {
    let startY = 0, dy = 0, pid = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      pid = e.pointerId; startY = e.clientY; dy = 0;
      sheet.classList.add('is-dragging');
      try { handle.setPointerCapture(pid); } catch (_) { /* ignore */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      sheet.classList.remove('is-dragging');
      if (dy > Math.min(120, sheet.offsetHeight * 0.3)) this.close();
      else sheet.style.transform = '';
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  _onDown(e) {
    if (!this.cur) return;
    const t = e.target;
    if (this.cur.panel.contains(t)) return;
    if (this.cur.toggle && this.cur.toggle.contains && this.cur.toggle.contains(t)) {
      // Pressing the opener again toggles the popup closed (handled by the opener's click).
      this.cur.anchorToggle = true;
      return;
    }
    if (this.cur.sheet) return; // backdrop click handles sheets
    this.close();
  }

  _onKey(e) {
    if (!this.cur) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const a = this.cur.toggle || this.cur.anchor;
      this.close();
      if (a && a.focus) { try { a.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !this.cur.sheet) {
      const items = [...this.cur.panel.querySelectorAll('.menu-item:not(:disabled), .rb-gal-item:not(:disabled), .rb-swatch')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      e.preventDefault();
      items[next].focus();
    }
  }

  /** True if the popup anchored to `anchor` was just closed by pressing that anchor. */
  consumeToggle(el) {
    if (this.cur && this.cur.toggle === el && this.cur.anchorToggle) {
      this.close();
      return true;
    }
    return false;
  }

  close() {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    document.removeEventListener('pointerdown', this._onDown, true);
    document.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('resize', this._onResize);
    if (c.toggle && c.toggle.setAttribute) c.toggle.setAttribute('aria-expanded', 'false');
    const remove = () => { if (c.root.parentNode) c.root.parentNode.removeChild(c.root); };
    if (c.sheet && !prefersReducedMotion()) {
      c.panel.classList.add('is-closing');
      setTimeout(remove, 190);
    } else remove();
    if (typeof c.onClose === 'function') { try { c.onClose(); } catch (err) { console.error(err); } }
  }

  pickColor(initial, apply) {
    this.colorApply = apply;
    try { this.colorInput.value = /^#[0-9a-f]{6}$/i.test(initial || '') ? initial : '#ffffff'; } catch (_) { /* ignore */ }
    try {
      if (typeof this.colorInput.showPicker === 'function') this.colorInput.showPicker();
      else this.colorInput.click();
    } catch (_) {
      try { this.colorInput.click(); } catch (__) { /* ignore */ }
    }
  }

  destroy() {
    this.close();
    if (this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
  }
}

// ---------------------------------------------------------------------------
// Spec helpers

const L = (cmd, label, ic, extra = {}) => ({ type: 'button', size: 'large', cmd, label, icon: ic, ...extra });
const S = (cmd, label, ic, extra = {}) => ({ type: 'button', size: 'small', cmd, label, icon: ic, ...extra });
const stack = (items, extra = {}) => ({ type: 'stack', items, ...extra });
const row = (items, extra = {}) => ({ type: 'row', items, ...extra });

// ---------------------------------------------------------------------------

export class Ribbon {
  constructor(rootEl, app) {
    if (!rootEl) throw new Error('Ribbon needs a root element (#ribbon).');
    this.root = rootEl;
    this.app = app || {};
    this.appEl = document.getElementById('app') || document.body;
    this._panels = new Map();       // tabId -> { el, tab, updaters: [] , galleries: [] }
    this._tabs = new Map();         // tabId -> tab button
    this._ctxGroups = new Map();    // 'video'|'music'|'text' -> element
    this._globalUpdaters = [];
    this._active = 'home';
    this._lastRegular = 'home';
    this._ctxSig = '';
    this._ctxSet = [];
    this._statusOwnText = null;
    this._offs = [];
    this._destroyed = false;
    this._io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => this._onVisible(entries), { root: null, rootMargin: '40px' })
      : null;
    this.animator = new ThumbAnimator();
    this._galleryLoaded = false;
    this._pendingDraw = new Set();
    this.popups = new Popups(this);
    this.refresh = this.refresh.bind(this);
    this.scheduleRefresh = rafThrottle(() => { if (!this._destroyed) this.refresh(); });
    this._layoutSoon = debounce(() => this._layoutPanel(), 80);

    this._build();
    this._buildQat();
    this._buildStatus();
    this._wireAppButton();
    this._placeAppButton();
    this._subscribe();

    loadGallery().then(() => this._redrawFallbacks());
    loadPresets();

    this.refresh();
    this._layoutPanel();
    if (typeof window !== 'undefined' && typeof window.__mmBootDone === 'function') {
      try { window.__mmBootDone(); } catch (_) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- public API

  get activeTab() { return this._active; }

  /** Activate a tab by id: home, animations, effects, project, view, ctx-video, ctx-music, ctx-text. */
  activateTab(id, { focus = false } = {}) {
    if (!this._panels.has(id)) return;
    const tabBtn = this._tabs.get(id);
    if (tabBtn && tabBtn.closest('.rb-ctx') && tabBtn.closest('.rb-ctx').hidden) return;
    const prev = this._active;
    this._active = id;
    if (!id.startsWith('ctx-')) this._lastRegular = id;
    for (const [tid, p] of this._panels) {
      const active = tid === id;
      p.el.hidden = !active;
      const b = this._tabs.get(tid);
      if (b) {
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
        b.tabIndex = active ? 0 : -1;
      }
    }
    if (prev !== id) {
      this.popups.close();
      this.animator.stop();
      const p = this._panels.get(id);
      if (p && p.el) p.el.scrollLeft = 0;
    }
    this._updatePanel(id, this._context());
    this._layoutPanel();
    if (tabBtn) {
      if (focus) tabBtn.focus();
      if (isPhone() && typeof tabBtn.scrollIntoView === 'function') {
        try { tabBtn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); } catch (_) { /* old Safari */ }
      }
    }
  }

  /** Re-read state from the store/commands and update every visible control. */
  refresh() {
    if (this._destroyed) return;
    const c = this._context();
    this._updateAppState(c);
    this._updateContextTabs(c);
    this._updatePanel(this._active, c);
    for (const u of this._globalUpdaters) {
      try { u(c); } catch (err) { console.error('[ribbon] update failed:', err); }
    }
    this._updateStatusText();
  }

  destroy() {
    this._destroyed = true;
    this._offs.forEach((f) => f());
    this._offs = [];
    this.scheduleRefresh.cancel();
    this.animator.stop();
    this.popups.destroy();
    if (this._io) this._io.disconnect();
    clear(this.root);
  }

  // ---------------------------------------------------------------- commands

  get _cmds() { return this.app && this.app.commands; }

  _enabled(cmd) {
    if (!cmd) return true;
    const c = this._cmds;
    if (!c || typeof c.isEnabled !== 'function') return false;
    try { return !!c.isEnabled(cmd); } catch (err) { console.warn(`[ribbon] isEnabled(${cmd}) failed`, err); return false; }
  }

  _checked(cmd, arg, derive) {
    const c = this._cmds;
    if (c && typeof c.isChecked === 'function') {
      try { return !!c.isChecked(cmd, arg); } catch (_) { /* fall through */ }
    }
    if (typeof derive === 'function') { try { return !!derive(); } catch (_) { return false; } }
    return false;
  }

  _run(cmd, arg) {
    const c = this._cmds;
    if (!c || typeof c.run !== 'function') {
      this._toast('That isn’t available right now. Please reload the page.', 'error');
      return undefined;
    }
    let result;
    try {
      result = arg === undefined ? c.run(cmd) : c.run(cmd, arg);
    } catch (err) {
      this._fail(err);
      return undefined;
    }
    if (result && typeof result.then === 'function') {
      result.then(() => this.scheduleRefresh(), (err) => { this._fail(err); this.scheduleRefresh(); });
    }
    this.scheduleRefresh();
    return result;
  }

  _fail(err) {
    if (err && (err.name === 'AbortError' || err.handled)) return;
    console.error('[ribbon] command failed:', err);
    this._toast(friendlyError(err), 'error');
  }

  _toast(msg, type = 'info') {
    const d = this.app && this.app.dialogs;
    if (d && typeof d.toast === 'function') {
      try { d.toast(msg, { type }); return; } catch (_) { /* fall through */ }
    }
    console[type === 'error' ? 'error' : 'log'](`[Movie Maker] ${msg}`);
  }

  // ---------------------------------------------------------------- state

  _context() {
    const store = this.app.store || null;
    const project = (store && store.project) || { items: [], texts: [], music: [], aspect: '16:9', audioMix: 0, name: 'My Movie' };
    const view = (store && store.view) || { zoom: ZOOM_DEFAULT, thumbSize: 'medium', showWaveforms: true, previewSize: 'normal' };
    const sel = (store && store.selection) || { type: null, ids: [] };
    let objs = [];
    if (store && typeof store.selectedItems === 'function') {
      try { objs = store.selectedItems() || []; } catch (_) { objs = []; }
    }
    const first = objs[0] || null;
    const item = sel.type === 'item' ? first : null;
    const isTitle = !!(item && item.kind === 'title');
    const text = sel.type === 'text' ? first : null;
    const textObj = text || (isTitle ? item : null);
    const music = sel.type === 'music' ? first : null;
    return { store, project, view, sel, objs, first, item, isTitle, text, textObj, style: (textObj && textObj.style) || null, music };
  }

  _segmentDuration(item) {
    const store = this.app.store;
    if (!store || !item) return NaN;
    try {
      const tl = store.timeline;
      const seg = tl && tl.segments && tl.segments.find((s) => s.item && s.item.id === item.id);
      return seg ? seg.duration : NaN;
    } catch (_) { return NaN; }
  }

  _updateAppState(c) {
    const el = this.appEl;
    if (!el) return;
    const ps = c.view.previewSize === 'large' ? 'large' : 'normal';
    if (el.dataset.previewSize !== ps) {
      el.dataset.previewSize = ps;
      // the preview canvas changes size; let the player re-measure
      requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')); } catch (_) { /* ignore */ } });
    }
    if (el.dataset.thumbSize !== c.view.thumbSize) el.dataset.thumbSize = c.view.thumbSize || 'medium';
    const aspect = c.project.aspect || '16:9';
    if (el.dataset.aspect !== aspect) {
      el.dataset.aspect = aspect;
      const [aw, ah] = aspect.split(':').map(Number);
      if (aw > 0 && ah > 0) el.style.setProperty('--project-aspect', `${aw} / ${ah}`);
    }
    // title bar
    const name = (c.project.name && String(c.project.name).trim()) || 'My Movie';
    if (name !== this._lastName) {
      this._lastName = name;
      const t = document.getElementById('doc-title');
      if (t) {
        clear(t);
        t.append(h('span.doc-title-name', null, name), h('span.doc-title-app', null, ' - Movie Maker'));
        t.title = name;
      }
      document.title = `${name} - Movie Maker`;
      requestAnimationFrame(() => this._positionTitle());
    }
  }

  /** Keep the centered window title clear of the contextual tab labels (as Windows does). */
  _positionTitle() {
    const t = document.getElementById('doc-title');
    const bar = document.getElementById('titlebar');
    if (!t || !bar) return;
    t.style.left = '';
    t.style.maxWidth = '';
    if (isPhone()) return;
    let right = 0;
    for (const g of this._ctxGroups.values()) {
      if (g.hidden) continue;
      const lab = g.querySelector('.rb-ctx-label');
      if (lab) right = Math.max(right, lab.getBoundingClientRect().right);
    }
    if (!right) return;
    const br = bar.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    if (r.left >= right + 12) return;
    const avail = br.right - 10 - (right + 14);
    if (avail < 60) { t.style.maxWidth = '0px'; return; }
    const w = Math.min(r.width, avail);
    t.style.maxWidth = `${Math.floor(avail)}px`;
    t.style.left = `${Math.round(right + 14 - br.left + w / 2)}px`;
  }

  _ctxSetFor(c) {
    const set = [];
    if (c.sel.type === 'item' && c.objs.length) set.push('video');
    if (c.textObj) set.push('text');
    if (c.sel.type === 'music' && c.objs.length) set.push('music');
    return set;
  }

  _updateContextTabs(c) {
    const set = this._ctxSetFor(c);
    const sig = set.join(',');
    for (const [k, g] of this._ctxGroups) {
      const show = set.includes(k);
      if (g.hidden === show) {
        g.hidden = !show;
        if (show) {
          g.classList.remove('is-entering');
          void g.offsetWidth; // restart the entrance animation
          g.classList.add('is-entering');
        }
      }
    }
    if (this.appEl) this.appEl.dataset.ctx = sig;
    if (sig === this._ctxSig) return;
    requestAnimationFrame(() => this._positionTitle());
    const prevSet = this._ctxSet;
    this._ctxSig = sig;
    this._ctxSet = set;
    const activeIsCtx = this._active.startsWith('ctx-');
    const activeCtxKind = activeIsCtx ? this._active.slice(4) : null;
    let preferred = null;
    if (set.includes('text')) preferred = 'ctx-text';
    else if (set.includes('music')) preferred = 'ctx-music';
    else if (set.includes('video')) preferred = 'ctx-video';
    const newlyAppeared = preferred && !prevSet.includes(preferred.slice(4));
    if (activeIsCtx && !set.includes(activeCtxKind)) {
      // The active contextual tab disappeared.
      this.activateTab(preferred || this._lastRegular || 'home');
      return;
    }
    if (preferred && newlyAppeared) {
      // Visual items on the Animations / Visual Effects tabs: stay where the user is working.
      const keep = preferred === 'ctx-video' && (this._active === 'animations' || this._active === 'effects');
      if (!keep) this.activateTab(preferred);
    }
  }

  // ---------------------------------------------------------------- subscriptions

  _subscribe() {
    const { store, player } = this.app;
    if (store && typeof store.addEventListener === 'function') {
      for (const type of ['change', 'selection', 'view', 'media']) this._offs.push(on(store, type, this.scheduleRefresh));
    }
    if (player && typeof player.addEventListener === 'function') {
      this._offs.push(on(player, 'play', this.scheduleRefresh));
      this._offs.push(on(player, 'pause', this.scheduleRefresh));
      this._offs.push(on(player, 'ended', this.scheduleRefresh));
      this._offs.push(on(player, 'durationchange', this.scheduleRefresh));
      const statusTick = rafThrottle(() => this._updateStatusText());
      this._offs.push(on(player, 'timeupdate', statusTick));
    }
    this._offs.push(watchLayout(() => {
      this.popups.close();
      this.animator.stop();
      this._placeAppButton();
      this._layoutPanel();
      this.refresh();
    }));
    const onResize = () => { this._layoutSoon(); this._positionTitle(); };
    this._offs.push(on(window, 'resize', onResize));
    const fsChange = () => this.scheduleRefresh();
    this._offs.push(on(document, 'fullscreenchange', fsChange));
    this._offs.push(on(document, 'webkitfullscreenchange', fsChange));
  }

  // ---------------------------------------------------------------- build: tabs & panels

  _build() {
    clear(this.root);
    this.root.classList.add('ribbon');
    const tabs = h('div.rb-tabs', { role: 'tablist', 'aria-label': 'Ribbon tabs' });
    this.tabsEl = tabs;
    const minBtn = h('button.rb-icon-btn', {
      type: 'button', title: 'Minimize the ribbon', 'aria-label': 'Minimize the ribbon',
      onclick: () => this._toggleMinimized(),
    }, icon('chevron-up', 14));
    this.minBtn = minBtn;
    const helpBtn = h('button.rb-icon-btn', {
      type: 'button', title: 'Help', 'aria-label': 'Help',
      onclick: () => this._run('help'),
    }, icon('help', 16));
    this.helpBtn = helpBtn;
    this.tabrow = h('div.rb-tabrow', null, tabs, h('div.rb-tabrow-end', null, minBtn, helpBtn));
    this.body = h('div.rb-body');
    this.root.append(this.tabrow, this.body);

    const spec = this._spec();
    let ctxWrap = null;
    for (const tab of spec) {
      const panelId = `rb-panel-${tab.id}`;
      const tabId = `rb-tab-${tab.id}`;
      const btn = h('button.rb-tab', {
        type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId, 'aria-selected': 'false', tabindex: '-1',
        dataset: { tab: tab.id },
        onclick: () => {
          if (this.appEl.classList.contains('is-ribbon-min')) this._toggleMinimized(false);
          this.activateTab(tab.id);
        },
        ondblclick: () => { if (!isPhone()) this._toggleMinimized(); },
        onkeydown: (e) => this._tabKey(e),
      },
      tab.ctx ? h('span.rb-tab-ctx-label', null, tab.ctxLabel) : null,
      h('span.rb-tab-text', null, tab.label));
      this._tabs.set(tab.id, btn);
      if (tab.ctx) {
        ctxWrap = h(`div.rb-ctx.rb-ctx-${tab.ctx}`, { hidden: true, dataset: { ctx: tab.ctx, label: tab.ctxLabel } },
          h('span.rb-ctx-label', { 'aria-hidden': 'true' }, tab.ctxLabel), btn);
        btn.setAttribute('aria-label', `${tab.ctxLabel}: ${tab.label}`);
        this._ctxGroups.set(tab.ctx, ctxWrap);
        tabs.appendChild(ctxWrap);
      } else {
        tabs.appendChild(btn);
      }
      const panel = h('div.rb-panel', { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, hidden: true, dataset: { tab: tab.id } });
      const rec = { el: panel, updaters: [], galleries: [], tab };
      for (const group of tab.groups) {
        const body = h('div.rb-group-body');
        const g = h('div.rb-group', { role: 'group', 'aria-label': group.label, class: group.className || '' },
          body, h('div.rb-group-caption', null, group.label));
        for (const item of group.items) this._mount(body, item, rec);
        panel.appendChild(g);
      }
      // Wheel over a desktop panel that overflows scrolls it horizontally.
      panel.addEventListener('wheel', (e) => {
        if (isPhone() || panel.scrollWidth <= panel.clientWidth + 1) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { panel.scrollLeft += e.deltaY; e.preventDefault(); }
      }, { passive: false });
      this._panels.set(tab.id, rec);
      this.body.appendChild(panel);
    }
    this.activateTab('home');
  }

  _tabKey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const visible = [...this.tabsEl.querySelectorAll('.rb-tab')].filter((b) => !b.closest('[hidden]'));
    const i = visible.indexOf(e.currentTarget);
    let next = i;
    if (e.key === 'ArrowLeft') next = i <= 0 ? visible.length - 1 : i - 1;
    else if (e.key === 'ArrowRight') next = (i + 1) % visible.length;
    else if (e.key === 'Home') next = 0;
    else next = visible.length - 1;
    e.preventDefault();
    const b = visible[next];
    if (b) this.activateTab(b.dataset.tab, { focus: true });
  }

  _toggleMinimized(force) {
    const el = this.appEl;
    const min = typeof force === 'boolean' ? force : !el.classList.contains('is-ribbon-min');
    el.classList.toggle('is-ribbon-min', min);
    this.minBtn.title = min ? 'Expand the ribbon' : 'Minimize the ribbon';
    this.minBtn.setAttribute('aria-label', this.minBtn.title);
    clear(this.minBtn).appendChild(icon(min ? 'chevron-down' : 'chevron-up', 14));
    if (!min) this._layoutPanel();
    requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')); } catch (_) { /* ignore */ } });
  }

  _updatePanel(id, c) {
    const p = this._panels.get(id);
    if (!p) return;
    for (const u of p.updaters) {
      try { u(c); } catch (err) { console.error('[ribbon] control update failed:', err); }
    }
  }

  // Fit galleries into the available width (desktop); condense or scroll when still too wide.
  _layoutPanel() {
    const p = this._panels.get(this._active);
    if (!p) return;
    const panel = p.el;
    panel.classList.remove('is-condensed', 'is-scroll');
    if (isPhone()) {
      for (const g of p.galleries) g.setCols(g.prefCols, true);
      return;
    }
    if (!panel.clientWidth) return; // not laid out yet (hidden)
    for (const g of p.galleries) g.setCols(g.prefCols, true);
    let over = panel.scrollWidth - panel.clientWidth;
    let guard = 64;
    while (over > 0 && guard-- > 0) {
      let best = null;
      for (const g of p.galleries) if (g.cols > g.minCols && (!best || g.cols > best.cols)) best = g;
      if (!best) break;
      best.setCols(best.cols - 1, true);
      over -= TILE_STEP_X;
    }
    if (panel.scrollWidth > panel.clientWidth + 1) panel.classList.add('is-condensed');
    if (panel.scrollWidth > panel.clientWidth + 1) panel.classList.add('is-scroll');
    for (const g of p.galleries) g.setCols(g.cols, false);
  }

  // ---------------------------------------------------------------- control factory

  _mount(parent, spec, rec) {
    if (!spec) return;
    if (spec.type === 'stack' || spec.type === 'row') {
      const el = h(spec.type === 'stack' ? 'div.rb-stack' : 'div.rb-row', { class: spec.className || '' });
      for (const s of spec.items) this._mount(el, s, rec);
      parent.appendChild(el);
      return;
    }
    let ctl;
    switch (spec.type) {
      case 'button': ctl = this._button(spec); break;
      case 'split': ctl = this._split(spec); break;
      case 'menu': ctl = this._menuButton(spec); break;
      case 'gallery': ctl = this._gallery(spec, rec); break;
      case 'select': ctl = this._select(spec); break;
      case 'slider': ctl = this._slider(spec); break;
      case 'combo': ctl = this._combo(spec); break;
      case 'color': ctl = this._color(spec); break;
      default: console.warn('[ribbon] unknown control', spec); return;
    }
    const els = Array.isArray(ctl.el) ? ctl.el : [ctl.el];
    for (const el of els) {
      if (spec.phoneHide) el.classList.add('rb-phone-hide');
      if (spec.className) el.classList.add(...spec.className.split(/\s+/).filter(Boolean));
      parent.appendChild(el);
    }
    if (ctl.update) rec.updaters.push(ctl.update);
  }

  _cmdOf(spec, c) { return typeof spec.cmd === 'function' ? spec.cmd(c) : spec.cmd; }

  _isOn(spec, c) {
    if (typeof spec.enabled === 'function') {
      try { if (!spec.enabled(c)) return false; } catch (_) { return false; }
      if (!spec.cmd || spec.run) return true;
    }
    if (spec.run && !spec.cmd) return true;
    return this._enabled(this._cmdOf(spec, c));
  }

  _btnContent(spec, size) {
    // Optional short label for the phone layouts (CSS picks the right one).
    const label = spec.phoneLabel
      ? h('span.rb-label', null, h('span.rb-l-full', null, spec.label), h('span.rb-l-short', null, spec.phoneLabel))
      : h('span.rb-label', null, spec.label);
    return [icon(spec.icon, size === 'large' ? 32 : 16), label];
  }

  _tooltip(spec) {
    return spec.title || (spec.shortcut ? `${spec.label} (${spec.shortcut})` : spec.label);
  }

  _button(spec) {
    const size = spec.size || 'small';
    const el = h(`button.rb-btn.rb-${size}`, {
      type: 'button',
      title: this._tooltip(spec),
      'aria-label': spec.ariaLabel || spec.label,
      class: spec.iconOnly ? 'is-icon-only' : '',
      dataset: { cmd: typeof spec.cmd === 'string' ? spec.cmd : (spec.id || '') },
    }, this._btnContent(spec, size));
    const toggle = !!(spec.check || spec.checked);
    if (toggle) el.setAttribute('aria-pressed', 'false');
    let lastC = null;
    el.addEventListener('click', () => {
      const c = lastC || this._context();
      if (spec.run) { try { spec.run(c); } catch (err) { this._fail(err); } this.scheduleRefresh(); return; }
      const arg = typeof spec.argFn === 'function' ? spec.argFn(this._context()) : spec.arg;
      this._run(this._cmdOf(spec, c), arg);
    });
    const update = (c) => {
      lastC = c;
      el.disabled = !this._isOn(spec, c);
      if (toggle) {
        let on1;
        if (typeof spec.checked === 'function') on1 = !!spec.checked(c);
        else on1 = this._checked(this._cmdOf(spec, c), spec.arg, spec.derive ? () => spec.derive(c) : null);
        el.classList.toggle('is-checked', on1);
        el.setAttribute('aria-pressed', on1 ? 'true' : 'false');
      }
      if (typeof spec.labelFn === 'function') {
        const l = spec.labelFn(c);
        const span = el.querySelector('.rb-l-full') || el.querySelector('.rb-label');
        if (span && span.textContent !== l) { span.textContent = l; el.setAttribute('aria-label', l); }
      }
      if (typeof spec.titleFn === 'function') el.title = spec.titleFn(c);
    };
    return { el, update };
  }

  _menuContent(items, { large = false } = {}) {
    const menu = h('div.menu', { role: 'menu' });
    const c = this._context();
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { menu.appendChild(h('hr.menu-sep')); continue; }
      if (it.heading) { menu.appendChild(h('div.menu-heading', null, it.heading)); continue; }
      const big = large || !!it.desc;
      const enabled = it.run ? (typeof it.enabled === 'function' ? it.enabled(c) : true) : this._enabled(it.cmd);
      let checked = false;
      if (typeof it.checked === 'function') { try { checked = !!it.checked(c); } catch (_) { checked = false; } }
      const btn = h('button.menu-item', {
        type: 'button', role: checked ? 'menuitemradio' : 'menuitem', class: [big ? 'is-large' : '', checked ? 'is-checked' : ''],
        disabled: !enabled, 'aria-checked': checked ? 'true' : null,
        onclick: () => {
          this.popups.close();
          if (it.run) { try { it.run(this._context()); } catch (err) { this._fail(err); } this.scheduleRefresh(); return; }
          this._run(it.cmd, it.arg);
        },
      },
      it.icon ? icon(it.icon, big ? 32 : 16) : h('span', { style: 'width:16px;flex:none' }),
      h('span.menu-text', null, h('span.menu-label', null, it.label), it.desc ? h('span.menu-desc', null, it.desc) : null));
      menu.appendChild(btn);
    }
    return menu;
  }

  _openMenu(anchor, title, items, opts = {}) {
    if (this.popups.consumeToggle(anchor)) return;
    let list = typeof items === 'function' ? items() : items;
    // A bottom sheet already shows the title; drop a heading that would repeat it.
    if (isPhone()) list = list.filter((it) => !(it && it.heading && it.heading === title));
    const content = this._menuContent(list, opts);
    this.popups.open(anchor, content, { title, minWidth: opts.minWidth || 200 });
  }

  _split(spec) {
    const size = spec.size || 'large';
    const main = h('button.rb-btn.rb-split-main', {
      type: 'button', title: this._tooltip(spec), 'aria-label': spec.label,
      onclick: () => this._run(spec.cmd, spec.arg),
    }, icon(spec.icon, size === 'large' ? 32 : 16), size === 'large' ? h('span.rb-label.rb-label-phone', null, spec.phoneLabel || spec.label) : h('span.rb-label', null, spec.label));
    const menuBtn = h('button.rb-btn.rb-split-menu', {
      type: 'button', title: `${spec.label} options`, 'aria-label': `${spec.label} options`, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => {
        const run = () => this._openMenu(menuBtn, spec.label, spec.items, { large: size === 'large', minWidth: 260 });
        if (spec.beforeMenu) Promise.resolve(spec.beforeMenu()).then(run, run); else run();
      },
    }, size === 'large' ? h('span.rb-label', null, spec.label, ' ', this._caret()) : this._caret());
    const el = h(`div.rb-split.rb-${size}-split`, { role: 'group', 'aria-label': spec.label }, main, menuBtn);
    const update = (c) => {
      const mainOn = this._enabled(spec.cmd);
      const items = typeof spec.items === 'function' ? spec.items() : spec.items;
      const anyOn = items.some((it) => it && it !== '-' && !it.heading && (it.run || this._enabled(it.cmd)));
      main.disabled = !mainOn;
      menuBtn.disabled = !anyOn;
      el.classList.toggle('is-disabled', !mainOn && !anyOn);
      void c;
    };
    return { el, update };
  }

  _caret() {
    const svg = icon('caret-down', 8);
    svg.classList.add('rb-caret');
    return svg;
  }

  _menuButton(spec) {
    const size = spec.size || 'large';
    const el = h(`button.rb-btn.rb-${size}`, {
      type: 'button', title: this._tooltip(spec), 'aria-label': spec.label, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => this._openMenu(el, spec.label, spec.items, { minWidth: 180 }),
    }, icon(spec.icon, size === 'large' ? 32 : 16), h('span.rb-label', null, spec.label, ' ', this._caret()));
    const update = (c) => {
      const items = typeof spec.items === 'function' ? spec.items() : spec.items;
      el.disabled = typeof spec.enabled === 'function' ? !spec.enabled(c)
        : !items.some((it) => it && it !== '-' && !it.heading && (it.run || this._enabled(it.cmd)));
      if (typeof spec.iconFn === 'function') {
        const name = spec.iconFn(c);
        if (name !== el.dataset.icon) {
          el.dataset.icon = name;
          el.replaceChild(icon(name, size === 'large' ? 32 : 16), el.firstChild);
        }
      }
    };
    return { el, update };
  }

  // ---- value controls

  _fieldShell(spec, control, extraClass = '') {
    const kids = [];
    if (spec.icon) kids.push(icon(spec.icon, 16));
    if (spec.label) kids.push(h('span.rb-field-label', { class: spec.labelWidth ? 'is-fixed' : '', style: spec.labelWidth ? { '--label-w': `${spec.labelWidth}px` } : null }, spec.label));
    kids.push(control);
    return h('div.rb-field', { class: extraClass, title: spec.title || spec.label }, kids);
  }

  _select(spec) {
    const sel = h('select.rb-select', { 'aria-label': spec.label, style: spec.width ? { width: `${spec.width}px` } : null });
    const baseOptions = typeof spec.options === 'function' ? spec.options() : spec.options;
    for (const o of baseOptions) sel.appendChild(h('option', { value: o.value, style: o.style || null }, o.label));
    const el = this._fieldShell(spec, sel, 'rb-select-field');
    let lastC = null;
    sel.addEventListener('change', () => {
      const c = lastC || this._context();
      const raw = sel.value;
      const arg = spec.toArg ? spec.toArg(raw, c) : raw;
      if (arg === undefined) return;
      this._run(this._cmdOf(spec, c), arg);
    });
    const update = (c) => {
      lastC = c;
      const on1 = this._isOn(spec, c);
      sel.disabled = !on1;
      el.classList.toggle('is-disabled', !on1);
      let v = spec.get ? spec.get(c) : undefined;
      const match = spec.match ? spec.match(v, baseOptions) : null;
      if (match != null) v = match;
      const val = v == null ? '' : String(v);
      // custom value not in the list → add a temporary option
      let opt = [...sel.options].find((o) => o.value === val);
      [...sel.querySelectorAll('option[data-custom]')].forEach((o) => { if (o !== opt) o.remove(); });
      if (!opt && val !== '') {
        opt = h('option', { value: val, dataset: { custom: '1' } }, spec.customLabel ? spec.customLabel(v) : val);
        sel.appendChild(opt);
      }
      if (val === '') {
        if (!sel.querySelector('option[data-blank]')) sel.insertBefore(h('option', { value: '', dataset: { blank: '1' }, disabled: true }, ''), sel.firstChild);
      } else {
        const b = sel.querySelector('option[data-blank]');
        if (b) b.remove();
      }
      if (sel.value !== val) sel.value = val;
    };
    return { el, update };
  }

  _slider(spec) {
    const range = h('input.rb-range', {
      type: 'range', min: String(spec.min), max: String(spec.max), step: String(spec.step || 1),
      'aria-label': spec.label, style: spec.width ? { width: `${spec.width}px` } : null,
    });
    const out = h('span.rb-value', { 'aria-hidden': 'true' });
    const wrapKids = [];
    if (spec.ends) wrapKids.push(h('span.rb-range-end', { title: spec.ends[2] || '' }, icon(spec.ends[0], 16)));
    wrapKids.push(range);
    if (spec.ends) wrapKids.push(h('span.rb-range-end', { title: spec.ends[3] || '' }, icon(spec.ends[1], 16)));
    if (!spec.noValue) wrapKids.push(out);
    const wrap = h('span.rb-range-wrap', null, wrapKids);
    const el = this._fieldShell(spec, wrap, spec.block ? 'rb-slider-field is-block' : 'rb-slider-field');
    let dragging = false;
    let lastC = null;
    const fmt = (v) => (spec.format ? spec.format(v) : String(v));
    const send = () => {
      const c = lastC || this._context();
      const v = Number(range.value);
      out.textContent = fmt(v);
      range.setAttribute('aria-valuetext', fmt(v));
      this._run(this._cmdOf(spec, c), spec.toArg ? spec.toArg(v, c) : v);
    };
    range.addEventListener('pointerdown', () => { dragging = true; });
    const endDrag = () => { if (dragging) { dragging = false; this.scheduleRefresh(); } };
    range.addEventListener('pointerup', endDrag);
    range.addEventListener('pointercancel', endDrag);
    range.addEventListener('blur', endDrag);
    range.addEventListener('input', send);
    range.addEventListener('dblclick', () => {
      if (spec.reset == null || range.disabled) return;
      range.value = String(spec.reset);
      send();
    });
    const update = (c) => {
      lastC = c;
      const on1 = this._isOn(spec, c);
      range.disabled = !on1;
      el.classList.toggle('is-disabled', !on1);
      if (dragging) return;
      const raw = spec.get ? spec.get(c) : undefined;
      const v = Number.isFinite(+raw) && raw !== null && raw !== '' ? clamp(+raw, spec.min, spec.max) : (spec.reset != null ? spec.reset : spec.min);
      if (String(range.value) !== String(v)) range.value = String(v);
      out.textContent = on1 || Number.isFinite(+raw) ? fmt(Number(range.value)) : '';
      range.setAttribute('aria-valuetext', fmt(Number(range.value)));
    };
    return { el, update };
  }

  _combo(spec) {
    const input = h('input.rb-input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done',
      'aria-label': spec.label, style: spec.inputWidth ? { '--input-w': `${spec.inputWidth}px` } : null,
    });
    const kids = [input];
    let btn = null;
    if (spec.presets && spec.presets.length) {
      btn = h('button.rb-combo-btn', {
        type: 'button', 'aria-label': `${spec.label} presets`, title: `${spec.label} presets`, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        onclick: () => {
          const c = this._context();
          const cur = spec.get ? spec.get(c) : NaN;
          this._openMenu(btn, spec.label, spec.presets.map((v) => ({
            label: spec.presetLabel ? spec.presetLabel(v) : `${fmtSeconds(v)} s`,
            run: () => this._run(this._cmdOf(spec, this._context()), v),
            checked: () => Number.isFinite(cur) && Math.abs(cur - v) < 0.005,
          })), { minWidth: 120 });
        },
      }, icon('caret-down', 9));
      kids.push(btn);
    }
    if (spec.unit) kids.push(h('span.rb-unit', null, spec.unit));
    const combo = h('span.rb-combo', null, kids);
    const el = this._fieldShell(spec, combo, 'rb-combo-field');
    let lastC = null;
    let editing = false;
    let selKey = '';
    const selectionKey = () => {
      const st = this.app.store;
      const sel = st && st.selection;
      return sel ? `${sel.type}|${(sel.ids || []).join(',')}` : '';
    };
    const current = () => (spec.get ? spec.get(lastC || this._context()) : NaN);
    const show = (v) => { input.value = Number.isFinite(v) ? fmtSeconds(v, spec.time) : ''; };
    const commit = () => {
      // The selection changed while typing (e.g. the user tapped another clip): don't apply
      // the half-typed value to the newly selected item.
      if (selKey !== selectionKey()) { lastC = this._context(); show(current()); return; }
      const c = lastC || this._context();
      const v = parseSeconds(input.value);
      const cur = current();
      if (!Number.isFinite(v)) {
        if (input.value.trim() !== '') this._toast(`Enter ${spec.label.toLowerCase()} in seconds, for example 3.5`, 'error');
        show(cur);
        return;
      }
      const clamped = clamp(v, spec.min != null ? spec.min : 0, spec.max != null ? spec.max : 36000);
      if (Number.isFinite(cur) && Math.abs(cur - clamped) < 0.0005) { show(cur); return; }
      this._run(this._cmdOf(spec, c), clamped);
    };
    let skipBlurCommit = false;
    input.addEventListener('focus', () => { editing = true; try { input.select(); } catch (_) { /* ignore */ } });
    input.addEventListener('input', () => { editing = true; });
    input.addEventListener('blur', () => {
      editing = false;
      if (!skipBlurCommit) commit();
      skipBlurCommit = false;
      this.scheduleRefresh();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); skipBlurCommit = true; input.blur(); skipBlurCommit = false; editing = false; }
      else if (e.key === 'Escape') { e.preventDefault(); show(current()); skipBlurCommit = true; input.blur(); skipBlurCommit = false; editing = false; }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = spec.step || 0.25;
        const base = Number.isFinite(parseSeconds(input.value)) ? parseSeconds(input.value) : (current() || 0);
        const next = clamp(Math.round((base + (e.key === 'ArrowUp' ? step : -step)) / step) * step, spec.min != null ? spec.min : 0, spec.max != null ? spec.max : 36000);
        show(next);
        this._run(this._cmdOf(spec, lastC || this._context()), next);
      }
    });
    const update = (c) => {
      lastC = c;
      const on1 = this._isOn(spec, c);
      input.disabled = !on1;
      if (btn) btn.disabled = !on1;
      el.classList.toggle('is-disabled', !on1);
      if (editing && document.activeElement === input) return;
      // Remember which selection the shown value belongs to (see commit()).
      selKey = selectionKey();
      const v = spec.get ? spec.get(c) : NaN;
      show(Number.isFinite(v) ? v : NaN);
    };
    return { el, update };
  }

  _color(spec) {
    const size = spec.size || 'small';
    const bar = h('span.rb-swatch-bar');
    const el = h(`button.rb-btn.rb-${size}.rb-color`, {
      type: 'button', title: this._tooltip(spec), 'aria-label': spec.label, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    }, icon(spec.icon, size === 'large' ? 32 : 16), h('span.rb-label', null, spec.label), this._caret(), bar);
    let lastC = null;
    const apply = (color) => {
      const c = lastC || this._context();
      if (typeof spec.apply === 'function') { try { spec.apply(color, c); } catch (err) { this._fail(err); } this.scheduleRefresh(); return; }
      this._run(this._cmdOf(spec, c), spec.toArg ? spec.toArg(color, c) : color);
    };
    el.addEventListener('click', () => {
      if (this.popups.consumeToggle(el)) return;
      const c = this._context();
      const cur = spec.get ? spec.get(c) : null;
      const pal = h('div.rb-palette', { role: 'listbox', 'aria-label': spec.label });
      const swatch = (col) => h('button.rb-swatch', {
        type: 'button', role: 'option', title: col, 'aria-label': col, 'aria-selected': sameColor(col, cur) ? 'true' : 'false',
        class: sameColor(col, cur) ? 'is-checked' : '', style: { '--swatch': col },
        onclick: () => { this.popups.close(); apply(col); },
      });
      pal.appendChild(h('div.rb-palette-head', null, 'Theme colors'));
      PALETTE_ROWS.forEach((r) => r.forEach((col) => pal.appendChild(swatch(col))));
      pal.appendChild(h('div.rb-palette-head', null, 'Standard colors'));
      STANDARD_COLORS.forEach((col) => pal.appendChild(swatch(col)));
      const actions = h('div.rb-palette-actions');
      if (spec.allowNone) {
        actions.appendChild(h('button.menu-item', {
          type: 'button', class: cur == null ? 'is-checked' : '',
          onclick: () => { this.popups.close(); apply(null); },
        }, h('span.rb-swatch.is-none', { style: 'width:16px;height:16px;flex:none' }), h('span', null, spec.noneLabel || 'No color')));
      }
      actions.appendChild(h('button.menu-item', {
        type: 'button',
        onclick: () => { this.popups.close(); this.popups.pickColor(cur, (col) => apply(col)); },
      }, icon('background-color', 16), h('span', null, 'More colors…')));
      pal.appendChild(actions);
      this.popups.open(el, pal, { title: spec.label });
    });
    const update = (c) => {
      lastC = c;
      el.disabled = !this._isOn(spec, c);
      const cur = spec.get ? spec.get(c) : null;
      bar.style.setProperty('--swatch', cur || 'transparent');
      bar.classList.toggle('is-none', !cur);
    };
    return { el, update };
  }

  // ---- galleries

  _tile(kind, entry, cmd, variant, { onPick } = {}) {
    const [cw, ch] = TILE[variant] || TILE.ribbon;
    const scale = variant === 'sheet' ? Math.min(1.5, dpr()) : dpr();
    const canvas = h('canvas', { width: Math.round(cw * scale), height: Math.round(ch * scale), 'aria-hidden': 'true' });
    const kids = [canvas];
    if (variant !== 'ribbon') kids.push(h('span.rb-gal-name', null, entry.name));
    const el = h('button.rb-gal-item', {
      type: 'button', title: entry.name, 'aria-label': entry.name, 'aria-pressed': 'false',
      dataset: { id: entry.id },
    }, kids);
    canvas._thumb = { kind, entry, drawn: false };
    el.addEventListener('click', () => {
      this.animator.stop(canvas);
      if (onPick) onPick(entry);
      this._run(cmd, entry.id);
    });
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !el.disabled) this.animator.start(canvas, kind, entry); });
    el.addEventListener('pointerleave', () => this.animator.stop(canvas));
    el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && !el.disabled) this.animator.start(canvas, kind, entry); });
    el.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') this.animator.stop(canvas); });
    el.addEventListener('pointercancel', () => this.animator.stop(canvas));
    el.addEventListener('focus', () => { if (!el.matches(':hover')) this.animator.start(canvas, kind, entry); });
    el.addEventListener('blur', () => this.animator.stop(canvas));
    this._observe(canvas);
    return { el, canvas, id: entry.id, entry };
  }

  _observe(canvas) {
    if (this._io) this._io.observe(canvas);
    else this._drawCanvas(canvas);
  }

  _onVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this._io.unobserve(e.target);
      this._drawCanvas(e.target);
    }
  }

  _drawCanvas(canvas) {
    const t = canvas._thumb;
    if (!t) return;
    if (!this._galleryLoaded) { this._pendingDraw.add(canvas); return; }
    t.drawn = true;
    drawThumb(canvas, t.kind, t.entry);
  }

  _redrawFallbacks() {
    this._galleryLoaded = true;
    for (const cv of [...this._pendingDraw]) { if (cv.isConnected) this._drawCanvas(cv); }
    this._pendingDraw.clear();
    for (const cv of [..._fallbackDrawn]) {
      if (!cv.isConnected) { _fallbackDrawn.delete(cv); continue; }
      this._drawCanvas(cv);
    }
  }

  _gallery(spec, rec) {
    const { kind, list, cmd } = spec;
    const items = h('div.rb-gal-items');
    const tiles = list.map((entry) => this._tile(kind, entry, cmd, 'ribbon'));
    for (const t of tiles) items.appendChild(t.el);
    const view = h('div.rb-gal-view', null, items);
    let rowIdx = 0;
    const g = { prefCols: spec.cols || 6, minCols: spec.minCols || 3, cols: spec.cols || 6, setCols: null };
    const perRow = () => Math.max(1, g.cols);
    const rows = () => Math.max(1, Math.ceil(tiles.length / perRow()));
    const up = h('button', { type: 'button', title: 'Previous row', 'aria-label': `Previous row of ${spec.label}`, onclick: () => page(-1) }, icon('chevron-up', 11));
    const down = h('button', { type: 'button', title: 'Next row', 'aria-label': `Next row of ${spec.label}`, onclick: () => page(1) }, icon('chevron-down', 11));
    const more = h('button', {
      type: 'button', title: `More ${spec.label.toLowerCase()}`, 'aria-label': `Show all ${spec.label.toLowerCase()}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      onclick: () => this._openGallery(spec, wrap, more),
    }, icon('gallery-expand', 11));
    const wrap = h('div.rb-gallery', { role: 'group', 'aria-label': spec.label }, view, h('div.rb-gal-scroll', null, up, down, more));
    const launchCanvas = h('canvas', { width: Math.round(TILE.launch[0] * dpr()), height: Math.round(TILE.launch[1] * dpr()), 'aria-hidden': 'true' });
    const launch = h('button.rb-btn.rb-gal-launch', {
      type: 'button', title: spec.label, 'aria-label': spec.label, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      onclick: () => this._openGallery(spec, launch, launch),
    }, launchCanvas, h('span.rb-label', null, spec.phoneLabel || spec.label));
    let launchId = null;
    let lastChecked;

    const rowStep = () => {
      // Measure the real distance between rows (touch layouts use a larger row gap).
      const n = perRow();
      if (tiles.length > n) {
        const d = tiles[n].el.offsetTop - tiles[0].el.offsetTop;
        if (d > 0) return d;
      }
      return TILE_STEP_Y;
    };
    const applyRow = () => {
      rowIdx = clamp(rowIdx, 0, rows() - 1);
      items.style.transform = rowIdx ? `translateY(${-rowIdx * rowStep()}px)` : '';
      up.disabled = rowIdx <= 0 || wrap.classList.contains('is-disabled');
      down.disabled = rowIdx >= rows() - 1 || wrap.classList.contains('is-disabled');
    };
    const page = (d) => { rowIdx += d; applyRow(); };
    const showChecked = () => {
      if (lastChecked == null) return;
      const idx = tiles.findIndex((t) => t.id === lastChecked);
      if (idx >= 0) rowIdx = Math.floor(idx / perRow());
    };
    g.setCols = (n, measuring) => {
      g.cols = Math.max(g.minCols, Math.min(n, tiles.length));
      view.style.setProperty('--gal-w', `${g.cols * TILE_STEP_X + 4}px`);
      if (!measuring) { showChecked(); applyRow(); }
    };
    g.setCols(g.cols, false);
    rec.galleries.push(g);

    const update = (c) => {
      const enabled = this._enabled(cmd);
      wrap.classList.toggle('is-disabled', !enabled);
      let checkedId = null;
      for (const t of tiles) {
        const ck = this._checked(cmd, t.id, spec.derive ? () => spec.derive(c, t.id) : null);
        if (t.el.disabled === enabled) t.el.disabled = !enabled;
        t.el.classList.toggle('is-checked', ck);
        t.el.setAttribute('aria-pressed', ck ? 'true' : 'false');
        if (ck && checkedId == null) checkedId = t.id;
      }
      more.disabled = false;
      launch.disabled = !enabled;
      if (checkedId !== lastChecked) {
        lastChecked = checkedId;
        showChecked();
      }
      applyRow();
      const showId = checkedId != null ? checkedId : (list[0] && list[0].id);
      if (showId !== launchId) {
        launchId = showId;
        const entry = list.find((e) => e.id === showId);
        if (entry) {
          launchCanvas._thumb = { kind, entry, drawn: false };
          launch.title = `${spec.label}: ${entry.name}`;
          this._observe(launchCanvas);
        }
      }
    };
    return { el: [wrap, launch], update };
  }

  _openGallery(spec, anchor, toggleEl) {
    if (this.popups.consumeToggle(toggleEl)) return;
    const { kind, list, cmd } = spec;
    const phone = isPhone();
    const variant = phone ? 'sheet' : 'full';
    const content = h('div.rb-gal-full');
    const enabled = this._enabled(cmd);
    const groups = groupsOfList(list);
    const showHeadings = groups.size > 1;
    const created = [];
    for (const [name, entries] of groups) {
      const itemsEl = h('div.rb-gal-full-items', { role: 'group', 'aria-label': name });
      for (const entry of entries) {
        const t = this._tile(kind, entry, cmd, variant, { onPick: () => this.popups.close() });
        t.el.disabled = !enabled;
        const ck = this._checked(cmd, entry.id, spec.derive ? () => spec.derive(this._context(), entry.id) : null);
        t.el.classList.toggle('is-checked', ck);
        t.el.setAttribute('aria-pressed', ck ? 'true' : 'false');
        itemsEl.appendChild(t.el);
        created.push(t);
      }
      content.appendChild(h('div.rb-gal-full-group', null, showHeadings ? h('div.rb-gal-full-heading', null, name) : null, itemsEl));
    }
    const cols = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(list.length * 1.6))));
    this.popups.open(phone ? null : anchor, content, {
      sheet: phone, title: spec.label, className: 'rb-popup-gallery', align: 'cover',
      width: cols * 78 + 26, focus: true, toggle: toggleEl,
      onClose: () => {
        this.animator.stop();
        // These tiles are gone: stop observing / queueing them.
        for (const t of created) {
          if (this._io) this._io.unobserve(t.canvas);
          this._pendingDraw.delete(t.canvas);
          _fallbackDrawn.delete(t.canvas);
        }
      },
    });
    // Bring the current choice into view.
    const sel = created.find((t) => t.el.classList.contains('is-checked'));
    if (sel) { try { sel.el.scrollIntoView({ block: 'center' }); } catch (_) { /* ignore */ } }
  }

  // ---------------------------------------------------------------- quick access toolbar

  _buildQat() {
    const qat = document.getElementById('qat');
    if (!qat) return;
    clear(qat);
    const mk = (cmd, label, ic, tip, cls = '') => {
      const b = h('button.qat-btn', {
        type: 'button', title: tip || label, 'aria-label': label, class: cls, dataset: { cmd },
        onclick: () => this._run(cmd),
      }, icon(ic, 16), h('span.qat-label', null, label));
      return b;
    };
    const save = mk('saveProject', 'Save project', 'save', 'Save project (Ctrl+S)', 'qat-desktop');
    const undo = mk('undo', 'Undo', 'undo', 'Undo (Ctrl+Z)');
    const redo = mk('redo', 'Redo', 'redo', 'Redo (Ctrl+Y)');
    const movie = mk('saveMovie', 'Save', 'save-movie', 'Save movie', 'qat-phone qat-save-movie');
    movie.setAttribute('aria-label', 'Save movie');
    qat.append(save, undo, redo, movie);
    this._globalUpdaters.push((c) => {
      const store = c.store;
      save.disabled = !this._enabled('saveProject');
      undo.disabled = !this._enabled('undo');
      redo.disabled = !this._enabled('redo');
      movie.disabled = !this._enabled('saveMovie');
      const ul = store && store.undoLabel, rl = store && store.redoLabel;
      undo.title = ul && !undo.disabled ? `Undo ${ul} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
      redo.title = rl && !redo.disabled ? `Redo ${rl} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    });
  }

  // ---------------------------------------------------------------- app button

  _wireAppButton() {
    const btn = document.getElementById('app-menu-btn');
    if (!btn) return;
    this.appBtn = btn;
    this.appBtnHome = btn.parentNode;
    if (btn._mmWired) return;
    btn._mmWired = true;
    btn.addEventListener('click', () => {
      const d = this.app.dialogs;
      if (d && typeof d.openAppMenu === 'function') {
        try {
          const r = d.openAppMenu();
          if (r && typeof r.catch === 'function') r.catch((err) => this._fail(err));
        } catch (err) { this._fail(err); }
      } else {
        this._toast('The menu isn’t available right now. Please reload the page.', 'error');
      }
    });
  }

  _placeAppButton() {
    const btn = this.appBtn;
    if (!btn) return;
    if (isPhone()) {
      const home = document.getElementById('titlebar') || this.appBtnHome;
      if (home && btn.parentNode !== home) home.insertBefore(btn, home.firstChild);
    } else if (btn.parentNode !== this.tabrow) {
      this.tabrow.insertBefore(btn, this.tabrow.firstChild);
    }
  }

  // ---------------------------------------------------------------- status bar

  _buildStatus() {
    const host = document.getElementById('status-controls');
    if (!host) return;
    clear(host);
    const sizes = [['small', 'Small thumbnails', 'thumb-small'], ['medium', 'Medium thumbnails', 'thumb-medium'], ['large', 'Large thumbnails', 'thumb-large']];
    const sizeBtns = sizes.map(([v, label, ic]) => {
      const b = h('button.status-btn', {
        type: 'button', title: label, 'aria-label': label, 'aria-pressed': 'false',
        onclick: () => this._setThumbSize(v),
      }, icon(ic, 16));
      b._value = v;
      return b;
    });
    const range = h('input.rb-range', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Storyboard zoom', title: 'Zoom' });
    const toPos = (z) => Math.round((Math.log(clamp(z, ZOOM_MIN, ZOOM_MAX) / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 100);
    const toZoom = (p) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, clamp(p, 0, 100) / 100);
    let dragging = false;
    range.addEventListener('pointerdown', () => { dragging = true; });
    range.addEventListener('pointerup', () => { dragging = false; });
    range.addEventListener('input', () => this._setZoom(toZoom(Number(range.value))));
    range.addEventListener('dblclick', () => this._setZoom(ZOOM_DEFAULT));
    const zOut = h('button.status-btn', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this._run('zoomOut') }, icon('zoom-out', 16));
    const zIn = h('button.status-btn', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this._run('zoomIn') }, icon('zoom-in', 16));
    host.append(...sizeBtns, h('span.status-sep'), zOut, range, zIn);
    this._globalUpdaters.push((c) => {
      for (const b of sizeBtns) {
        const ck = c.view.thumbSize === b._value;
        b.classList.toggle('is-checked', ck);
        b.setAttribute('aria-pressed', ck ? 'true' : 'false');
      }
      zOut.disabled = !this._enabled('zoomOut') || num(c.view.zoom, ZOOM_DEFAULT) <= ZOOM_MIN + 1e-6;
      zIn.disabled = !this._enabled('zoomIn') || num(c.view.zoom, ZOOM_DEFAULT) >= ZOOM_MAX - 1e-6;
      if (!dragging) range.value = String(toPos(num(c.view.zoom, ZOOM_DEFAULT)));
      range.title = `Zoom: ${Math.round(num(c.view.zoom, ZOOM_DEFAULT))} px per second`;
    });
  }

  _setZoom(z) {
    const store = this.app.store;
    if (store && typeof store.setView === 'function') store.setView({ zoom: clamp(z, ZOOM_MIN, ZOOM_MAX) });
  }

  _setThumbSize(v) {
    if (this._cmds && this._enabled('setThumbSize')) this._run('setThumbSize', v);
    else if (this.app.store && typeof this.app.store.setView === 'function') this.app.store.setView({ thumbSize: v });
  }

  _setPreviewSize(v) {
    if (this._cmds && this._enabled('setPreviewSize')) this._run('setPreviewSize', v);
    else if (this.app.store && typeof this.app.store.setView === 'function') this.app.store.setView({ previewSize: v });
  }

  _updateStatusText() {
    const el = document.getElementById('status-text');
    if (!el) return;
    // If another module writes its own status text, leave it alone.
    if (this._statusOwnText !== null && el.textContent !== this._statusOwnText) return;
    const store = this.app.store;
    if (!store || !store.project) return;
    const p = store.project;
    const sel = store.selection || { type: null, ids: [] };
    const first = sel.ids && sel.ids.length ? sel.ids[0] : null;
    // Runs on every playback frame: compute plain numbers first, build a string only on change.
    let kind = 0, idx = -1, total = 0;
    if (sel.type === 'text' && first) {
      kind = 1; total = p.texts.length;
      for (let i = 0; i < total; i++) if (p.texts[i].id === first) { idx = i; break; }
    } else if (sel.type === 'music' && first) {
      kind = 2; total = p.music.length;
      for (let i = 0; i < total; i++) if (p.music[i].id === first) { idx = i; break; }
    } else if (p.items.length) {
      kind = 3; total = p.items.length;
      if (sel.type === 'item' && first) {
        for (let i = 0; i < total; i++) if (p.items[i].id === first) { idx = i; break; }
      }
      if (idx < 0) {
        const player = this.app.player;
        const t = player ? num(player.currentTime, 0) : 0;
        idx = 0;
        try {
          const segs = store.timeline.segments;
          for (let i = 0; i < segs.length; i++) { if (t >= segs[i].start - 1e-6) idx = i; else break; }
        } catch (_) { idx = 0; }
      }
    }
    const multi = sel.type === 'item' && sel.ids.length > 1 ? sel.ids.length : 0;
    const st = this._statusState || (this._statusState = { kind: -1, idx: -2, total: -1, multi: -1 });
    if (st.kind === kind && st.idx === idx && st.total === total && st.multi === multi && this._statusOwnText !== null) return;
    st.kind = kind; st.idx = idx; st.total = total; st.multi = multi;
    let text = '';
    if (kind === 1 && idx >= 0) text = `Text ${idx + 1} of ${total}`;
    else if (kind === 2 && idx >= 0) text = `Audio ${idx + 1} of ${total}`;
    else if (kind === 3) text = `Item ${Math.max(0, idx) + 1} of ${total}${multi ? ` (${multi} selected)` : ''}`;
    if (el.textContent !== text) el.textContent = text;
    this._statusOwnText = text;
  }

  // ---------------------------------------------------------------- full screen preview

  _isFullscreen() {
    const d = document;
    const fs = d.fullscreenElement || d.webkitFullscreenElement;
    return !!fs || (this.appEl && this.appEl.classList.contains('is-pseudo-fullscreen'));
  }

  _toggleFullscreen() {
    const c = this._cmds;
    try {
      if (c && typeof c.list === 'function' && c.list().includes('fullscreen')) { this._run('fullscreen'); return; }
    } catch (_) { /* use the built-in implementation */ }
    const d = document;
    const fsEl = d.fullscreenElement || d.webkitFullscreenElement;
    if (fsEl) {
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      if (exit) { try { const r = exit.call(d); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ } }
      return;
    }
    if (this.appEl.classList.contains('is-pseudo-fullscreen')) { this._pseudoFullscreen(false); return; }
    const pane = document.getElementById('preview-pane');
    if (!pane) return;
    const req = pane.requestFullscreen || pane.webkitRequestFullscreen;
    if (req) {
      try {
        const r = req.call(pane);
        if (r && typeof r.catch === 'function') r.catch(() => this._pseudoFullscreen(true));
        return;
      } catch (_) { /* fall back */ }
    }
    this._pseudoFullscreen(true);
  }

  _pseudoFullscreen(onState) {
    const el = this.appEl;
    el.classList.toggle('is-pseudo-fullscreen', onState);
    if (onState) {
      const exit = h('button.pv-fs-exit', { type: 'button', title: 'Exit full screen', 'aria-label': 'Exit full screen', onclick: () => this._pseudoFullscreen(false) }, icon('exit-fullscreen', 22));
      document.body.appendChild(exit);
      this._fsExit = exit;
      this._fsKey = on(document, 'keydown', (e) => { if (e.key === 'Escape') this._pseudoFullscreen(false); });
    } else {
      if (this._fsExit && this._fsExit.parentNode) this._fsExit.parentNode.removeChild(this._fsExit);
      this._fsExit = null;
      if (this._fsKey) { this._fsKey(); this._fsKey = null; }
    }
    requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')); } catch (_) { /* ignore */ } });
    this.scheduleRefresh();
  }

  // ---------------------------------------------------------------- the ribbon layout

  _spec() {
    const self = this;
    const isAspect = (a) => (c) => c.project.aspect === a;
    const textStyleKey = (key) => (c) => (c.style ? c.style[key] : undefined);
    const textSet = (key) => (v) => ({ key, value: v });
    const textOn = (c) => !!c.textObj && self._enabled('textSet');

    const saveMovieItems = () => {
      const list = exportPresets.map((p) => ({
        cmd: 'saveMovie', arg: p.id, label: p.name,
        desc: p.height ? `${p.height}p${p.id === 'recommended' ? ' • best for most people' : ''}` : '',
        icon: PRESET_ICONS[p.id] || 'save-movie',
      }));
      return [{ heading: 'Save movie' }, ...list];
    };

    return [
      // ------------------------------------------------------------- Home
      {
        id: 'home', label: 'Home',
        groups: [
          {
            label: 'Clipboard', className: 'rb-phone-last', // phones: adding media comes first
            items: [
              L('paste', 'Paste', 'paste', { shortcut: 'Ctrl+V' }),
              stack([S('cut', 'Cut', 'cut', { shortcut: 'Ctrl+X' }), S('copy', 'Copy', 'copy', { shortcut: 'Ctrl+C' })]),
            ],
          },
          {
            label: 'Add',
            items: [
              L('addMedia', 'Add videos and photos', 'add-videos', { title: 'Add videos and photos from your device', phoneLabel: 'Add videos & photos' }),
              {
                type: 'split', size: 'large', cmd: 'addMusic', label: 'Add music', icon: 'music-add', phoneLabel: 'Add music',
                title: 'Add music to the beginning of your project',
                items: [
                  { cmd: 'addMusic', label: 'Add music…', desc: 'Add music to the beginning of the project', icon: 'music-add' },
                  { cmd: 'addMusicAtPlayhead', label: 'Add music at the current point…', desc: 'Add music starting at the current point', icon: 'music-at' },
                ],
              },
              stack([
                S('webcam', 'Webcam video', 'webcam', { title: 'Record a video with your camera', phoneLabel: 'Webcam' }),
                S('narration', 'Record narration', 'narration', { title: 'Record narration with your microphone', phoneLabel: 'Narration' }),
                S('snapshot', 'Snapshot', 'snapshot', { title: 'Take a snapshot of the current frame' }),
              ]),
              stack([
                S('addTitle', 'Title', 'title', { title: 'Add a title before the selected item' }),
                S('addCaption', 'Caption', 'caption', { title: 'Add a caption at the current point' }),
                S('addCredits', 'Credits', 'credits', { title: 'Add credits at the end of the movie' }),
              ]),
            ],
          },
          {
            label: 'AutoMovie themes',
            items: [{ type: 'gallery', kind: 'automovie', list: AUTOMOVIE_THEMES, cmd: 'autoMovie', label: 'AutoMovie themes', phoneLabel: 'AutoMovie', cols: 7, minCols: 3 }],
          },
          {
            label: 'Editing',
            items: [
              stack([S('rotateLeft', 'Rotate left', 'rotate-left'), S('rotateRight', 'Rotate right', 'rotate-right')]),
              stack([S('remove', 'Remove', 'remove', { shortcut: 'Delete' }), S('selectAll', 'Select all', 'select-all', { shortcut: 'Ctrl+A' })]),
            ],
          },
          {
            label: 'Share',
            items: [{
              type: 'split', size: 'large', cmd: 'saveMovie', label: 'Save movie', icon: 'save-movie',
              title: 'Save movie with the recommended settings', items: saveMovieItems, beforeMenu: () => loadPresets(),
            }],
          },
        ],
      },

      // ------------------------------------------------------------- Animations
      {
        id: 'animations', label: 'Animations',
        groups: [
          {
            label: 'Transitions',
            items: [
              {
                type: 'gallery', kind: 'transition', list: TRANSITIONS, cmd: 'setTransition', label: 'Transitions', cols: 9, minCols: 3,
                derive: (c, id) => !!(c.item && c.item.transition && c.item.transition.type === id),
              },
              stack([
                {
                  type: 'combo', cmd: 'setTransitionDuration', label: 'Duration', icon: 'duration', unit: 's', presets: TRANSITION_DURATIONS,
                  min: 0.05, max: 10, step: 0.25, labelWidth: 50,
                  get: (c) => (c.item && c.item.transition ? num(c.item.transition.duration, DEFAULT_TRANSITION_DURATION) : NaN),
                  title: 'Transition duration in seconds',
                },
                S('applyTransitionAll', 'Apply to all', 'apply-all', { title: 'Apply this transition to all items' }),
              ]),
            ],
          },
          {
            label: 'Pan and zoom',
            items: [
              {
                type: 'gallery', kind: 'panzoom', list: PANZOOM, cmd: 'setPanZoom', label: 'Pan and zoom', cols: 6, minCols: 3,
                derive: (c, id) => !!(c.item && c.item.panZoom === id),
              },
              stack([S('applyPanZoomAll', 'Apply to all', 'apply-all', { title: 'Apply this pan and zoom to all items' })]),
            ],
          },
        ],
      },

      // ------------------------------------------------------------- Visual Effects
      {
        id: 'effects', label: 'Visual Effects',
        groups: [
          {
            label: 'Effects',
            items: [
              {
                type: 'gallery', kind: 'effect', list: EFFECTS, cmd: 'setEffect', label: 'Visual effects', phoneLabel: 'Effects', cols: 10, minCols: 3,
                derive: (c, id) => !!(c.item && c.item.effect === id),
              },
              stack([
                S('applyEffectAll', 'Apply to all', 'apply-all', { title: 'Apply this effect to all items' }),
                {
                  type: 'slider', cmd: 'setBrightness', label: 'Brightness', icon: 'brightness', min: -100, max: 100, step: 1, reset: 0, width: 110,
                  get: (c) => (c.item ? num(c.item.brightness, 0) : NaN),
                  format: (v) => (v > 0 ? `+${v}` : String(v)),
                  title: 'Brightness (double-click to reset)',
                },
              ]),
            ],
          },
        ],
      },

      // ------------------------------------------------------------- Project
      {
        id: 'project', label: 'Project',
        groups: [
          {
            label: 'Audio',
            items: [
              {
                type: 'slider', cmd: 'setAudioMix', label: 'Audio mix', icon: 'audio-mix', min: -100, max: 100, step: 5, reset: 0, width: 96, block: true,
                ends: ['film', 'music', 'Video sound', 'Music'],
                get: (c) => Math.round(num(c.project.audioMix, 0) * 100),
                toArg: (v) => v / 100,
                format: (v) => (v === 0 ? 'Equal' : v < 0 ? `More video (${-v}%)` : `More music (${v}%)`),
                title: 'Balance between the sound of your videos and the music (double-click to reset)',
              },
              L('emphasize', 'Emphasize narration', 'emphasize-narration', { arg: 'narration', check: true, derive: () => false }),
              L('emphasize', 'Emphasize video', 'emphasize-video', { arg: 'video', check: true, derive: (c) => num(c.project.audioMix, 0) <= -0.5 }),
              L('emphasize', 'Emphasize music', 'emphasize-music', { arg: 'music', check: true, derive: (c) => num(c.project.audioMix, 0) >= 0.5 }),
              L('fitToMusic', 'Fit to music', 'fit-to-music', { title: 'Change the duration of photos so the movie ends with the music' }),
            ],
          },
          {
            label: 'Aspect ratio',
            items: Object.keys(ASPECTS).map((a) => {
              const meta = {
                '16:9': ['Widescreen (16:9)', 'aspect-wide'], '4:3': ['Standard (4:3)', 'aspect-standard'],
                '9:16': ['Portrait (9:16)', 'aspect-portrait'], '1:1': ['Square (1:1)', 'aspect-square'],
              }[a] || [a, 'aspect-wide'];
              return L('setAspect', meta[0], meta[1], { arg: a, checked: isAspect(a) });
            }),
          },
        ],
      },

      // ------------------------------------------------------------- View
      {
        id: 'view', label: 'View',
        groups: [
          {
            label: 'Zoom',
            items: [
              L('zoomIn', 'Zoom in', 'zoom-in'),
              L('zoomOut', 'Zoom out', 'zoom-out'),
              L(null, 'Reset', 'zoom-reset', {
                id: 'zoomReset', title: 'Reset the storyboard zoom', run: () => self._setZoom(ZOOM_DEFAULT),
                enabled: (c) => !!c.store && Math.abs(num(c.view.zoom, ZOOM_DEFAULT) - ZOOM_DEFAULT) > 0.01,
              }),
            ],
          },
          {
            label: 'Thumbnails',
            items: [{
              type: 'menu', size: 'large', label: 'Thumbnail size', icon: 'thumb-medium',
              iconFn: (c) => `thumb-${c.view.thumbSize || 'medium'}`,
              enabled: (c) => !!c.store,
              items: [
                { label: 'Small', icon: 'thumb-small', run: () => self._setThumbSize('small'), checked: (c) => c.view.thumbSize === 'small' },
                { label: 'Medium', icon: 'thumb-medium', run: () => self._setThumbSize('medium'), checked: (c) => c.view.thumbSize === 'medium' },
                { label: 'Large', icon: 'thumb-large', run: () => self._setThumbSize('large'), checked: (c) => c.view.thumbSize === 'large' },
              ],
            }],
          },
          {
            label: 'Show',
            items: [L('toggleWaveforms', 'Waveforms', 'waveform', { checked: (c) => !!c.view.showWaveforms, title: 'Show audio waveforms on the storyboard' })],
          },
          {
            label: 'Preview',
            items: [
              {
                type: 'menu', size: 'large', label: 'Preview size', icon: 'preview-size',
                enabled: (c) => !!c.store,
                items: [
                  { label: 'Normal', icon: 'preview-size', run: () => self._setPreviewSize('normal'), checked: (c) => c.view.previewSize !== 'large' },
                  { label: 'Large', icon: 'fullscreen', run: () => self._setPreviewSize('large'), checked: (c) => c.view.previewSize === 'large' },
                ],
              },
              L(null, 'Preview full screen', 'fullscreen', {
                id: 'fullscreen', run: () => self._toggleFullscreen(), checked: () => self._isFullscreen(),
                labelFn: () => (self._isFullscreen() ? 'Exit full screen' : 'Preview full screen'), phoneLabel: 'Full screen',
              }),
            ],
          },
        ],
      },

      // ------------------------------------------------------------- Video Tools › Edit
      {
        id: 'ctx-video', label: 'Edit', ctx: 'video', ctxLabel: 'Video Tools',
        groups: [
          {
            label: 'Audio',
            items: [stack([
              {
                type: 'slider', cmd: 'setVolume', label: 'Video volume', icon: 'volume', min: 0, max: 100, step: 1, reset: 100, width: 90, labelWidth: 78,
                get: (c) => (c.item && c.item.kind === 'video' ? Math.round(num(c.item.volume, 1) * 100) : NaN),
                toArg: (v) => v / 100, format: (v) => `${v}%`,
              },
              {
                type: 'select', cmd: 'setFadeIn', label: 'Fade in', icon: 'fade-in', options: FADE_OPTIONS, labelWidth: 78, width: 84,
                get: (c) => (c.item && c.item.kind === 'video' ? c.item.fadeIn || 'none' : null),
              },
              {
                type: 'select', cmd: 'setFadeOut', label: 'Fade out', icon: 'fade-out', options: FADE_OPTIONS, labelWidth: 78, width: 84,
                get: (c) => (c.item && c.item.kind === 'video' ? c.item.fadeOut || 'none' : null),
              },
            ])],
          },
          {
            label: 'Adjust',
            items: [
              stack([
                {
                  type: 'select', cmd: 'setSpeed', label: 'Speed', icon: 'speed', labelWidth: 56, width: 76,
                  options: SPEEDS.map((s) => ({ value: String(s), label: `${s}x` })),
                  get: (c) => (c.item && c.item.kind === 'video' ? num(c.item.speed, 1) : null),
                  match: (v, opts) => { const o = opts.find((x) => Math.abs(Number(x.value) - v) < 1e-6); return o ? o.value : (v == null ? null : String(v)); },
                  customLabel: (v) => `${v}x`,
                  toArg: (v) => Number(v),
                },
                {
                  type: 'combo', cmd: 'setDuration', label: 'Duration', icon: 'duration', unit: 's', presets: ITEM_DURATIONS, min: 0.1, max: 3600, step: 0.5, labelWidth: 56,
                  get: (c) => {
                    if (!c.item) return NaN;
                    if (c.item.kind === 'video') return self._segmentDuration(c.item);
                    return num(c.item.duration, NaN);
                  },
                  title: 'How long the photo or title is shown (seconds)',
                },
                {
                  type: 'color', cmd: 'setBackground', label: 'Background color', icon: 'background-color',
                  get: (c) => (c.isTitle ? c.item.background || '#000000' : null),
                  title: 'Background color of the title',
                },
              ]),
            ],
          },
          {
            label: 'Editing',
            items: [
              L('trimTool', 'Trim tool', 'trim', { title: 'Trim the beginning and end of the video' }),
              L('split', 'Split', 'split', { shortcut: 'M', title: 'Split the item at the current point (M)' }),
              stack([
                S('setStartPoint', 'Set start point', 'set-start', { title: 'Trim the video so it starts at the current point' }),
                S('setEndPoint', 'Set end point', 'set-end', { title: 'Trim the video so it ends at the current point' }),
              ]),
            ],
          },
        ],
      },

      // ------------------------------------------------------------- Music Tools › Options
      {
        id: 'ctx-music', label: 'Options', ctx: 'music', ctxLabel: 'Music Tools',
        groups: [
          {
            label: 'Audio',
            items: [stack([
              {
                type: 'slider', cmd: 'musicVolume', label: 'Music volume', icon: 'volume', min: 0, max: 100, step: 1, reset: 100, width: 90, labelWidth: 80,
                get: (c) => (c.music ? Math.round(num(c.music.volume, 1) * 100) : NaN),
                toArg: (v) => v / 100, format: (v) => `${v}%`,
              },
              {
                type: 'select', cmd: 'musicFadeIn', label: 'Fade in', icon: 'fade-in', options: FADE_OPTIONS, labelWidth: 80, width: 84,
                get: (c) => (c.music ? c.music.fadeIn || 'none' : null),
              },
              {
                type: 'select', cmd: 'musicFadeOut', label: 'Fade out', icon: 'fade-out', options: FADE_OPTIONS, labelWidth: 80, width: 84,
                get: (c) => (c.music ? c.music.fadeOut || 'none' : null),
              },
            ])],
          },
          {
            label: 'Editing',
            items: [
              L('musicSplit', 'Split', 'split', { title: 'Split the music at the current point' }),
              stack([
                {
                  type: 'combo', cmd: 'musicStartTime', label: 'Start time', icon: 'start-time', time: true, min: 0, max: 36000, step: 0.5, inputWidth: 70, labelWidth: 62,
                  get: (c) => (c.music ? num(c.music.start, 0) : NaN),
                  title: 'When the music starts in the movie',
                },
                S('musicStartTime', 'Set start time', 'playhead', { title: 'Start the music at the current point' }),
                S('remove', 'Remove', 'remove', { shortcut: 'Delete', title: 'Remove the selected music' }),
              ]),
              stack([
                S('musicSetStartPoint', 'Set start point', 'set-start', { title: 'Trim the music so it starts at the current point' }),
                S('musicSetEndPoint', 'Set end point', 'set-end', { title: 'Trim the music so it ends at the current point' }),
              ]),
            ],
          },
        ],
      },

      // ------------------------------------------------------------- Text Tools › Format
      {
        id: 'ctx-text', label: 'Format', ctx: 'text', ctxLabel: 'Text Tools',
        groups: [
          {
            label: 'Clipboard', className: 'rb-phone-hide',
            items: [
              L('paste', 'Paste', 'paste', { shortcut: 'Ctrl+V' }),
              stack([S('cut', 'Cut', 'cut', { shortcut: 'Ctrl+X' }), S('copy', 'Copy', 'copy', { shortcut: 'Ctrl+C' })]),
            ],
          },
          {
            label: 'Font',
            items: [
              stack([
                row([
                  {
                    type: 'select', cmd: 'textSet', label: 'Font', options: FONTS.map((f) => ({ ...f, style: { fontFamily: f.value } })), width: 128,
                    enabled: textOn,
                    get: textStyleKey('font'),
                    match: (v, opts) => {
                      if (!v) return null;
                      const head = String(v).split(',')[0].trim().replace(/["']/g, '').toLowerCase();
                      const o = opts.find((x) => x.value === v) || opts.find((x) => x.value.split(',')[0].trim().toLowerCase() === head);
                      return o ? o.value : v;
                    },
                    customLabel: (v) => String(v).split(',')[0].replace(/["']/g, '').trim(),
                    toArg: textSet('font'),
                  },
                  {
                    type: 'select', cmd: 'textSet', label: 'Size', options: TEXT_SIZES.map((s) => ({ value: String(s), label: String(s) })), width: 52,
                    enabled: textOn,
                    get: (c) => (c.style ? num(c.style.size, 8) : null),
                    match: (v) => (v == null ? null : String(Math.round(v * 10) / 10)),
                    toArg: (v) => ({ key: 'size', value: Number(v) }),
                    title: 'Text size (percent of the movie height)',
                  },
                ]),
                row([
                  S('textSet', 'Bold', 'bold', { iconOnly: true, enabled: textOn, argFn: (c) => ({ key: 'bold', value: !(c.style && c.style.bold) }), checked: (c) => !!(c.style && c.style.bold), shortcut: 'Ctrl+B' }),
                  S('textSet', 'Italic', 'italic', { iconOnly: true, enabled: textOn, argFn: (c) => ({ key: 'italic', value: !(c.style && c.style.italic) }), checked: (c) => !!(c.style && c.style.italic), shortcut: 'Ctrl+I' }),
                  S('textSet', 'Grow font', 'font-grow', {
                    iconOnly: true, enabled: textOn, title: 'Increase font size',
                    argFn: (c) => ({ key: 'size', value: nextSize(c.style ? c.style.size : 8, 1) }),
                  }),
                  S('textSet', 'Shrink font', 'font-shrink', {
                    iconOnly: true, enabled: textOn, title: 'Decrease font size',
                    argFn: (c) => ({ key: 'size', value: nextSize(c.style ? c.style.size : 8, -1) }),
                  }),
                  {
                    type: 'color', cmd: 'textSet', label: 'Font color', icon: 'text-color', className: 'is-icon-only',
                    enabled: textOn, get: textStyleKey('color'), toArg: textSet('color'),
                  },
                ]),
                {
                  type: 'slider', cmd: 'textSet', label: 'Transparency', icon: 'transparency', min: 0, max: 100, step: 5, reset: 0, width: 84,
                  enabled: textOn,
                  get: (c) => (c.style ? Math.round((1 - num(c.style.opacity, 1)) * 100) : NaN),
                  toArg: (v) => ({ key: 'opacity', value: Math.round((1 - v / 100) * 100) / 100 }),
                  format: (v) => `${v}%`,
                },
              ]),
            ],
          },
          {
            label: 'Paragraph',
            items: [
              stack([
                row([
                  S('textSet', 'Align left', 'align-left', { iconOnly: true, enabled: textOn, arg: { key: 'align', value: 'left' }, checked: (c) => !!c.style && c.style.align === 'left' }),
                  S('textSet', 'Center', 'align-center', { iconOnly: true, enabled: textOn, arg: { key: 'align', value: 'center' }, checked: (c) => !!c.style && c.style.align === 'center' }),
                  S('textSet', 'Align right', 'align-right', { iconOnly: true, enabled: textOn, arg: { key: 'align', value: 'right' }, checked: (c) => !!c.style && c.style.align === 'right' }),
                ]),
                {
                  type: 'select', cmd: 'textSet', label: 'Position', options: VALIGN_OPTIONS, width: 80, labelWidth: 48,
                  enabled: textOn, get: textStyleKey('valign'), toArg: textSet('valign'),
                },
              ]),
              L('textEdit', 'Edit text', 'edit-text', { title: 'Edit the text in the preview' }),
            ],
          },
          {
            label: 'Adjust',
            items: [stack([
              {
                type: 'color', label: 'Background color', icon: 'background-color', allowNone: true, noneLabel: 'No background',
                cmd: (c) => (c.isTitle ? 'setBackground' : 'textSet'),
                get: (c) => (c.isTitle ? c.item.background || '#000000' : (c.style ? c.style.background : null)),
                apply: (color, c) => {
                  if (c.isTitle) self._run('setBackground', color || '#000000');
                  else self._run('textSet', { key: 'background', value: color || null });
                },
              },
              {
                type: 'combo', label: 'Start time', icon: 'start-time', time: true, min: 0, max: 36000, step: 0.5, inputWidth: 70, labelWidth: 70,
                cmd: 'textStartTime',
                get: (c) => (c.text ? num(c.text.start, 0) : NaN),
              },
              {
                type: 'combo', label: 'Text duration', icon: 'text-duration', unit: 's', presets: TEXT_DURATIONS, min: 0.1, max: 3600, step: 0.5, labelWidth: 70,
                cmd: (c) => (c.isTitle && !self._enabled('textDuration') ? 'setDuration' : 'textDuration'),
                get: (c) => (c.textObj ? num(c.textObj.duration, NaN) : NaN),
              },
            ])],
          },
          {
            label: 'Effects',
            items: [{
              type: 'gallery', kind: 'text', list: TEXT_EFFECTS, cmd: 'textEffect', label: 'Text effects', cols: 6, minCols: 3,
              derive: (c, id) => !!(c.textObj && ((c.text ? c.text.effect : c.textObj.textEffect) || 'none') === id),
            }],
          },
          {
            label: 'Outline',
            items: [stack([
              {
                type: 'select', cmd: 'textSet', label: 'Outline size', icon: 'outline', options: OUTLINE_OPTIONS, width: 80,
                enabled: textOn, get: textStyleKey('outline'), toArg: textSet('outline'),
              },
              {
                type: 'color', cmd: 'textSet', label: 'Outline color', icon: 'outline-color',
                enabled: textOn, get: textStyleKey('outlineColor'), toArg: textSet('outlineColor'),
              },
            ])],
          },
        ],
      },
    ];
  }
}

function nextSize(cur, dir) {
  const v = num(cur, 8);
  if (dir > 0) { const n = TEXT_SIZES.find((s) => s > v + 1e-6); return n != null ? n : Math.min(50, v + 4); }
  const sizes = TEXT_SIZES.slice().reverse();
  const n = sizes.find((s) => s < v - 1e-6);
  return n != null ? n : Math.max(1, v - 1);
}

export default Ribbon;
