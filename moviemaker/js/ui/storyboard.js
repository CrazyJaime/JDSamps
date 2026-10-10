// ui/storyboard.js — the storyboard of Movie Maker (web).
//
// Desktop: a Windows Live Movie Maker style *wrapped timeline*. Time maps to rows as wide as the
// pane; visual items are filmstrip blocks (width = duration × view.zoom) that wrap across rows,
// with a green music/narration lane and an orange caption/credits lane under every row, a
// transition marker in front of items that have one, a pan & zoom marker, and a black playhead
// with a draggable handle.
// Phone: a single horizontal filmstrip lane with the playhead fixed in the middle; scrolling the
// strip seeks the movie (and playback scrolls the strip), music and caption lanes below.
//
// export class Storyboard { constructor(rootEl, app); refresh(); scrollToTime(t); destroy(); }
// Also exported for tests: StripLayout, packLanes, cachedImageUrl.

import { formatTime } from '../model.js';
import * as Icons from './icons.js';

const PHONE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 1024px)';
const PHONE_LANDSCAPE_QUERY = '(pointer: coarse) and (orientation: landscape) and (max-height: 520px)';
const COARSE_QUERY = '(pointer: coarse)';

const ZOOM_MIN = 5;
const ZOOM_MAX = 400;
const LONG_PRESS_MS = 350;
const MOUSE_DRAG_PX = 5;
const TOUCH_SLOP_PX = 9;
const ARMED_DRAG_PX = 6;
const SNAP_PX = 8;
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 26;
const MAX_TILES_PER_PIECE = 240;

const ITEM_HEIGHTS = {
  desktop: { small: 46, medium: 66, large: 96 },
  phone: { small: 46, medium: 58, large: 76 },
};
// Phones grow the strip into free vertical space, up to these heights.
const PHONE_ITEM_MAX = { small: 64, medium: 96, large: 124 };

// ---------------------------------------------------------------------------------------------
// Small helpers

function mql(query) {
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null; } catch (_) { return null; }
}
function mqMatches(query) { const m = mql(query); return !!(m && m.matches); }
function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

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
  try {
    if (typeof Icons.icon === 'function') return Icons.icon(name, size);
  } catch (_) { /* fall through */ }
  const s = el('span', 'sb-ic-fallback');
  s.style.width = s.style.height = `${size}px`;
  return s;
}

function svgEl(markup, size) {
  const holder = document.createElement('span');
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false">${markup}</svg>`;
  return holder.firstChild;
}

const PZ_SVG = '<rect x="1" y="3" width="14" height="10" rx="1" fill="rgba(0,0,0,.55)" stroke="#fff" stroke-width="1.2"/>'
  + '<rect x="4.5" y="5.5" width="6" height="4.5" fill="none" stroke="#ffd34d" stroke-width="1.2" stroke-dasharray="1.6 1"/>'
  + '<path d="M11 10.5l2.6 2" stroke="#ffd34d" stroke-width="1.4" stroke-linecap="round"/>';
const PLUS_SVG = '<path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
const WARN_SVG = '<path d="M8 1.5L15 14H1z" fill="#ffd21f" stroke="#7a5600" stroke-width="1"/><path d="M8 6v4" stroke="#33404f" stroke-width="1.6"/><circle cx="8" cy="12" r=".9" fill="#33404f"/>';

function vibrate(ms) {
  try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms); } catch (_) { /* ignore */ }
}

function firstLine(text, max = 60) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join(' / ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------------------------
// Image URL cache: filmstrip/thumb data URLs → object URLs (short strings, decoded once, cached by
// the browser's image cache). Bounded LRU; evicted URLs are revoked.

const URL_CACHE = new Map();
const URL_CACHE_MAX = 900;

export function cachedImageUrl(src) {
  if (!src || typeof src !== 'string') return '';
  if (!src.startsWith('data:')) return src;
  const hit = URL_CACHE.get(src);
  if (hit) {
    URL_CACHE.delete(src);
    URL_CACHE.set(src, hit);
    return hit;
  }
  let url = src;
  try {
    const comma = src.indexOf(',');
    const head = src.slice(5, comma);
    if (comma > 0 && /;base64$/i.test(head) && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      && typeof Blob === 'function' && typeof atob === 'function') {
      const mime = head.replace(/;base64$/i, '') || 'image/jpeg';
      const bin = atob(src.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    }
  } catch (_) { url = src; }
  URL_CACHE.set(src, url);
  if (URL_CACHE.size > URL_CACHE_MAX) {
    const oldest = URL_CACHE.keys().next().value;
    const u = URL_CACHE.get(oldest);
    URL_CACHE.delete(oldest);
    if (u && u.startsWith('blob:')) { try { URL.revokeObjectURL(u); } catch (_) { /* ignore */ } }
  }
  return url;
}

// ---------------------------------------------------------------------------------------------
// Layout math (pure; no DOM) — exported for tests.

/**
 * Greedy interval packing: entries [{item:{id}, start, end}] sorted by start → { lanes: Map(id → lane), count }.
 */
export function packLanes(entries, minGap = 1e-6) {
  const ends = [];
  const lanes = new Map();
  const list = Array.isArray(entries) ? entries.slice().sort((a, b) => a.start - b.start) : [];
  for (const e of list) {
    let k = -1;
    for (let i = 0; i < ends.length; i++) if (ends[i] <= e.start + minGap) { k = i; break; }
    if (k < 0) { k = ends.length; ends.push(0); }
    ends[k] = Math.max(e.end, e.start + 0.05);
    lanes.set(e.item.id, k);
  }
  return { lanes, count: ends.length };
}

/**
 * Maps timeline time ↔ position along the (unwrapped) strip, in px.
 * Every visual item i occupies [x0[i], x1[i]) for the time range [t0[i], t1[i]) where t1 is the
 * start of the next item (the transition overlap belongs to the incoming item). Items have a
 * minimum width and a small gap; on desktop an item that would leave a tiny sliver at the end of
 * a row is moved to the next row. Positions in gaps map to the boundary time.
 */
export class StripLayout {
  constructor({ timeline, zoom = 40, rowWidth = Infinity, gap = 4, minWidth = 28, sliver = 26 } = {}) {
    const segs = (timeline && timeline.segments) || [];
    const n = segs.length;
    this.zoom = clamp(num(zoom, 40), ZOOM_MIN, ZOOM_MAX);
    this.rowWidth = rowWidth > 0 ? rowWidth : Infinity;
    this.gap = gap;
    this.n = n;
    this.x0 = new Float64Array(n);
    this.x1 = new Float64Array(n);
    this.t0 = new Float64Array(n);
    this.t1 = new Float64Array(n);
    const W = this.rowWidth;
    let x = 0;
    for (let i = 0; i < n; i++) {
      const seg = segs[i];
      const t0 = num(seg.start, 0);
      const next = i < n - 1 ? num(segs[i + 1].start, num(seg.end, t0)) : num(seg.end, t0);
      const t1 = Math.max(t0, next);
      const w = Math.max(minWidth, (t1 - t0) * this.zoom);
      if (Number.isFinite(W) && i > 0) {
        const rowStart = Math.floor(x / W) * W;
        const rem = rowStart + W - x;
        if (w > rem) {
          const trail = (x + w) - Math.floor((x + w - 1e-6) / W) * W;
          if (rem < sliver || (w <= W && trail < sliver)) x = rowStart + W;
        }
      }
      this.x0[i] = x;
      this.x1[i] = x + w;
      this.t0[i] = t0;
      this.t1[i] = t1;
      x += w + gap;
    }
    this.visualEndX = n ? this.x1[n - 1] : 0;
    this.visualEndT = n ? this.t1[n - 1] : 0;
    const dur = Math.max(num(timeline && timeline.duration, 0), this.visualEndT);
    this.duration = dur;
    this.endX = Math.max(this.visualEndX, this.timeToX(dur));
  }

  /** Index of the item whose strip range holds time t (the incoming one at a boundary), or -1. */
  indexAtTime(t) {
    const n = this.n;
    if (!n || !(t >= this.t0[0])) return n ? 0 : -1;
    let lo = 0, hi = n - 1, r = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.t0[mid] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return r;
  }

  timeToX(t) {
    const n = this.n;
    const tt = Number.isFinite(t) && t > 0 ? t : 0;
    if (!n) return tt * this.zoom;
    if (tt >= this.t1[n - 1]) return this.x1[n - 1] + (tt - this.t1[n - 1]) * this.zoom;
    const i = this.indexAtTime(tt);
    const d = this.t1[i] - this.t0[i];
    if (!(d > 0)) return this.x0[i];
    return this.x0[i] + ((tt - this.t0[i]) / d) * (this.x1[i] - this.x0[i]);
  }

  xToTime(x) {
    const n = this.n;
    const xx = Number.isFinite(x) ? x : 0;
    if (!n) return Math.max(0, xx) / this.zoom;
    if (xx >= this.x1[n - 1]) return this.t1[n - 1] + (xx - this.x1[n - 1]) / this.zoom;
    if (xx <= this.x0[0]) return this.t0[0];
    let lo = 0, hi = n - 1, r = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.x0[mid] <= xx) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (xx >= this.x1[r]) return this.t1[r];
    const w = this.x1[r] - this.x0[r];
    return this.t0[r] + (w > 0 ? ((xx - this.x0[r]) / w) * (this.t1[r] - this.t0[r]) : 0);
  }

  /** Index where an item dropped at strip position x would be inserted (0..n). */
  insertionIndexAt(x) {
    let k = 0;
    for (let i = 0; i < this.n; i++) if ((this.x0[i] + this.x1[i]) / 2 < x) k = i + 1;
    return k;
  }

  /** Split [xa, xb) at row boundaries: cb(row, rowX, width, offsetFromXa). */
  spans(xa, xb, cb) {
    if (!(xb > xa)) return;
    const W = this.rowWidth;
    if (!Number.isFinite(W)) { cb(0, xa, xb - xa, 0); return; }
    let r = Math.floor(xa / W);
    for (;;) {
      const s = Math.max(xa, r * W);
      const e = Math.min(xb, (r + 1) * W);
      if (e - s > 0.25) cb(r, s - r * W, e - s, s - xa);
      if ((r + 1) * W >= xb) break;
      r++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Styles (complements the shared .sb-* defaults in css/moviemaker.css; everything is scoped to .sb-root)

const STYLE_ID = 'sb-style';
const STYLE = `
.sb-root{display:flex;flex-direction:column;min-width:0;min-height:0;}
.sb-root .sb-viewport{position:relative;flex:1 1 auto;display:flex;min-width:0;min-height:0;}
.sb-root .sb-scroll{position:relative;flex:1 1 auto;min-width:0;min-height:0;padding:0;overflow-x:hidden;overflow-y:auto;
  overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-gutter:stable;touch-action:pan-x pan-y;outline:none;}
.sb-root.is-phone .sb-scroll{overflow-x:auto;overflow-y:auto;scrollbar-width:none;scrollbar-gutter:auto;}
.sb-root.is-phone .sb-scroll::-webkit-scrollbar{display:none;width:0;height:0;}
.sb-root .sb-content{position:relative;min-height:100%;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}
.sb-root .sb-layer,.sb-root .sb-ghosts{position:absolute;left:0;top:0;width:0;height:0;}
.sb-root .sb-layer.is-stale{visibility:hidden;pointer-events:none;}
.sb-root .sb-track{position:absolute;border-radius:3px;pointer-events:none;}
.sb-root .sb-track-audio{background:rgba(111,191,68,.11);}
.sb-root .sb-track-text{background:rgba(245,154,58,.11);}
.sb-root .sb-item{position:absolute;box-sizing:border-box;margin:0;padding:0;border:0;border-radius:2px;overflow:hidden;flex:none;
  background:
    repeating-linear-gradient(90deg,transparent 0 3px,#e9ecf0 3px 7px) left 1px top 1px/100% var(--sb-hole,3px) no-repeat,
    repeating-linear-gradient(90deg,transparent 0 3px,#e9ecf0 3px 7px) left 1px bottom 1px/100% var(--sb-hole,3px) no-repeat,
    #20252b;
  box-shadow:0 1px 2px rgba(0,0,0,.35);cursor:default;touch-action:pan-x pan-y;-webkit-touch-callout:none;outline:none;
  transition:box-shadow .12s, opacity .12s, transform .12s;}
.sb-root .sb-item.is-cont-left{border-top-left-radius:0;border-bottom-left-radius:0;}
.sb-root .sb-item.is-cont-right{border-top-right-radius:0;border-bottom-right-radius:0;}
.sb-root .sb-frames{position:absolute;left:0;right:0;top:var(--sb-sp,6px);bottom:var(--sb-sp,6px);overflow:hidden;background:#000;}
.sb-root .sb-tile{position:absolute;top:0;height:100%;max-width:none;max-height:none;object-fit:cover;pointer-events:none;
  -webkit-user-drag:none;user-select:none;border-right:1px solid rgba(0,0,0,.55);box-sizing:border-box;}
.sb-root .sb-tail{position:absolute;box-sizing:border-box;border-radius:2px;pointer-events:none;display:flex;align-items:center;justify-content:center;
  background:repeating-linear-gradient(90deg,#0d1014 0 22px,#14181e 22px 24px);border:1px solid #39424e;box-shadow:inset 0 0 0 1px rgba(255,255,255,.04);opacity:.92;}
.sb-root .sb-tail-label{color:#c9d3df;font:600 11px/1.2 var(--font-ui,system-ui,sans-serif);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 6px;}
.sb-root .sb-slate{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0 6px;overflow:hidden;}
.sb-root .sb-slate-text{max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:1.2;pointer-events:none;}
.sb-root .sb-missing{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:4px;
  background:repeating-linear-gradient(135deg,#3a3f46 0 6px,#30353b 6px 12px);color:#f3d27a;font-size:11px;white-space:nowrap;overflow:hidden;}
.sb-root .sb-item.is-selected{box-shadow:0 0 0 2px var(--c-select,#3c8ce7),0 0 9px 2px var(--c-select-glow,rgba(70,150,240,.55));z-index:2;}
.sb-root .sb-item.is-selected .sb-frames::after{content:"";position:absolute;inset:0;background:rgba(120,180,255,.18);pointer-events:none;}
.sb-root .sb-item:focus-visible{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--c-focus,#3399ff);z-index:3;}
.sb-root .sb-item.is-armed{transform:scale(.96);box-shadow:0 0 0 2px var(--c-select,#3c8ce7),0 8px 18px rgba(0,0,0,.4);z-index:4;}
.sb-root .sb-item.is-dragging,.sb-root .sb-bar.is-dragging{opacity:.35;}
.sb-root .sb-trans-zone{position:absolute;left:0;top:0;bottom:0;pointer-events:none;
  background:linear-gradient(to top right,rgba(0,0,0,.5) 50%,rgba(255,255,255,.22) 50%);border-right:1px dashed rgba(255,255,255,.55);}
.sb-root .sb-trans{position:absolute;left:2px;top:50%;width:12px;height:12px;margin-top:-6px;box-sizing:border-box;pointer-events:none;
  border:1px solid #1d3d66;background:linear-gradient(135deg,#fff 50%,#2f74c9 50%);box-shadow:0 0 0 1px rgba(255,255,255,.6);border-radius:1px;}
.sb-root .sb-pz{position:absolute;right:3px;top:3px;line-height:0;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.6));}
.sb-root .sb-dur{position:absolute;right:3px;bottom:2px;padding:0 3px;border-radius:3px;background:rgba(0,0,0,.55);color:#fff;
  font-size:10px;line-height:13px;font-variant-numeric:tabular-nums;pointer-events:none;}
.sb-root .sb-bar{position:absolute;box-sizing:border-box;margin:0;padding:0 5px;overflow:hidden;white-space:nowrap;border-radius:3px;
  font-size:11px;color:#fff;cursor:default;touch-action:pan-x pan-y;-webkit-touch-callout:none;outline:none;display:flex;align-items:center;
  transition:box-shadow .12s, opacity .12s, transform .12s;}
.sb-root .sb-bar.sb-music{background:linear-gradient(#8fd862,var(--c-music,#6fbf44));border:1px solid var(--c-music-dark,#3f8a1f);}
.sb-root .sb-bar.sb-narration{background:linear-gradient(#72d6c4,#2fa892);border:1px solid #1b7564;}
.sb-root .sb-bar.sb-caption{background:linear-gradient(#ffc27e,var(--c-caption-bar,#f59a3a));border:1px solid var(--c-caption-dark,#b2610f);}
.sb-root .sb-bar.sb-credits{background:linear-gradient(#ffab7e,#e9692e);border:1px solid #a8420f;}
.sb-root .sb-bar.is-missing{background:repeating-linear-gradient(135deg,#9aa4ae 0 6px,#8a949e 6px 12px);border-color:#5b6670;}
.sb-root .sb-bar.is-cont-left{border-top-left-radius:0;border-bottom-left-radius:0;border-left-style:dashed;}
.sb-root .sb-bar.is-cont-right{border-top-right-radius:0;border-bottom-right-radius:0;border-right-style:dashed;}
.sb-root .sb-bar.is-selected{box-shadow:0 0 0 2px var(--c-select,#3c8ce7),0 0 7px 1px var(--c-select-glow,rgba(70,150,240,.55));z-index:2;}
.sb-root .sb-bar:focus-visible{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--c-focus,#3399ff);z-index:3;}
.sb-root .sb-bar.is-armed{transform:scaleY(1.12);box-shadow:0 0 0 2px var(--c-select,#3c8ce7),0 6px 14px rgba(0,0,0,.35);z-index:4;}
.sb-root .sb-bar.is-ghost{opacity:.92;z-index:8;pointer-events:none;box-shadow:0 0 0 2px #fff,0 4px 12px rgba(0,0,0,.35);}
.sb-root .sb-wave{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;opacity:.42;}
.sb-root .sb-bar-label{position:relative;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 1px rgba(0,0,0,.45);pointer-events:none;}
.sb-root .sb-playhead{position:absolute;left:0;top:0;width:2px;margin-left:-1px;background:var(--c-playhead,#111);z-index:6;
  pointer-events:none;will-change:transform;}
.sb-root .sb-ph-handle{position:absolute;left:-6px;top:-1px;width:14px;height:11px;background:#1b1b1b;pointer-events:auto;cursor:ew-resize;
  touch-action:none;clip-path:polygon(0 0,100% 0,100% 55%,50% 100%,0 55%);}
.sb-root .sb-ph-grip{position:absolute;left:-15px;top:-6px;width:32px;height:30px;pointer-events:auto;cursor:ew-resize;touch-action:none;}
.sb-root .sb-caret{position:absolute;left:0;top:0;width:4px;margin-left:-2px;border-radius:2px;background:var(--c-select,#3c8ce7);
  box-shadow:0 0 0 1px #fff,0 0 6px rgba(40,120,220,.6);z-index:7;pointer-events:none;}
.sb-root .sb-caret::before,.sb-root .sb-caret::after{content:"";position:absolute;left:-4px;border:6px solid transparent;}
.sb-root .sb-caret::before{top:-9px;border-top-color:var(--c-select,#3c8ce7);}
.sb-root .sb-caret::after{bottom:-9px;border-bottom-color:var(--c-select,#3c8ce7);}
.sb-root .sb-fixed-ph{position:absolute;top:calc(var(--sb-top, 26px) - 26px);bottom:0;max-height:var(--sb-ph-h, none);left:50%;width:2px;margin-left:-1px;background:var(--c-playhead,#111);z-index:6;
  pointer-events:none;display:none;}
.sb-root.is-phone .sb-fixed-ph{display:block;}
.sb-root .sb-fixed-ph::before{content:"";position:absolute;left:-6px;top:15px;border:7px solid transparent;border-top-color:var(--c-playhead,#111);border-bottom:0;}
.sb-root .sb-ph-time{position:absolute;left:50%;top:1px;transform:translateX(-50%);padding:0 6px;border-radius:7px;background:#111;color:#fff;
  font:11px/14px var(--font-ui,system-ui,sans-serif);font-variant-numeric:tabular-nums;white-space:nowrap;}
.sb-root.is-phone .sb-playhead{display:none;}
.sb-root .sb-add-tile{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;margin:0;padding:0;
  border:2px dashed #8ea4bf;border-radius:8px;background:rgba(255,255,255,.65);color:#2f6fca;cursor:pointer;touch-action:manipulation;}
.sb-root .sb-add-tile:active{background:#dceafb;}
.sb-root .sb-add-inline{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;margin:0;padding:0 12px;
  border:1px dashed #9db0c8;border-radius:4px;background:rgba(255,255,255,.7);color:#1a5fb4;font-size:13px;text-decoration:underline;cursor:pointer;}
.sb-root .sb-empty{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:stretch;justify-content:stretch;padding:12px;gap:0;background:var(--c-storyboard,#f3f4f6);}
.sb-root.is-empty .sb-fixed-ph,.sb-root.is-empty .sb-playhead{display:none;}
.sb-root .sb-empty-btn{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;margin:0;padding:16px;
  min-height:120px;border:2px dashed #b4c3d6;border-radius:8px;background:rgba(255,255,255,.55);color:#1a5fb4;cursor:pointer;
  font:15px/1.35 var(--font-ui,system-ui,sans-serif);text-align:center;touch-action:manipulation;}
.sb-root .sb-empty-btn:hover{background:rgba(255,255,255,.85);border-color:#7ea4d6;}
.sb-root .sb-empty-btn:active{background:#e3eefb;}
.sb-root .sb-empty .sb-empty-btn{text-decoration:none;}
.sb-root .sb-empty-main{text-decoration:underline;font-size:16px;}
.sb-root .sb-empty-sub{color:var(--c-text-muted,#5e7491);font-size:13px;text-decoration:none;}
.sb-root .sb-empty-btn svg{width:56px;height:56px;}
.sb-root .sb-tip{position:absolute;z-index:9;padding:1px 6px;border-radius:3px;background:#1b1f24;color:#fff;font-size:11px;line-height:16px;
  white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums;}
.sb-ghost{position:fixed;left:0;top:0;z-index:900;pointer-events:none;opacity:.88;border-radius:3px;overflow:hidden;background:#20252b;
  box-shadow:0 8px 22px rgba(0,0,0,.4),0 0 0 2px var(--c-select,#3c8ce7);will-change:transform;}
.sb-ghost img{display:block;width:100%;height:100%;object-fit:cover;max-width:none;}
.sb-ghost .sb-ghost-slate{display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:#fff;font-size:11px;overflow:hidden;padding:0 4px;box-sizing:border-box;}
.sb-pop{position:fixed;z-index:950;min-width:180px;max-width:calc(100vw - 16px);margin:0;padding:4px;box-sizing:border-box;
  background:var(--c-popup-bg,#fcfdff);border:1px solid var(--c-popup-border,#8fa8c6);border-radius:6px;
  box-shadow:var(--shadow-popup,0 6px 18px rgba(20,40,70,.28));font:13px/1.3 var(--font-ui,system-ui,sans-serif);color:var(--c-text,#1e395b);}
.sb-pop .sb-pop-item{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;margin:0;padding:4px 12px 4px 8px;border:1px solid transparent;
  border-radius:4px;background:none;color:inherit;font:inherit;text-align:left;cursor:default;}
.sb-pop .sb-pop-item:hover:not(:disabled),.sb-pop .sb-pop-item:focus-visible{background:linear-gradient(var(--c-hot-top,#fffbec),var(--c-hot-bot,#fde8a8));border-color:var(--c-hot-border,#e8c46a);outline:none;}
.sb-pop .sb-pop-item:disabled{opacity:.45;}
.sb-pop .sb-pop-item svg{width:20px;height:20px;flex:none;}
@media (pointer: coarse){.sb-pop .sb-pop-item{min-height:44px;font-size:15px;}}
@media (prefers-reduced-motion: reduce){.sb-root .sb-item,.sb-root .sb-bar{transition:none;}}
`;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLE;
  (document.head || document.documentElement).appendChild(s);
}

// ---------------------------------------------------------------------------------------------

const KIND_LABEL = { video: 'Video', image: 'Photo', title: 'Title' };

export class Storyboard {
  constructor(rootEl, app) {
    if (!rootEl) throw new Error('Storyboard needs a root element (#storyboard-pane).');
    if (!app || !app.store) throw new Error('Storyboard needs app.store.');
    this.root = rootEl;
    this.app = app;
    this.store = app.store;
    injectStyles();

    this._offs = [];
    this._els = new Map();        // id → element[] (item pieces / bar pieces)
    this._focusEls = new Map();   // id → focusable element
    this._m = null;               // current layout model
    this._dirty = true;
    this._raf = 0;
    this._press = null;
    this._drag = null;
    this._pinch = null;
    this._ptrs = new Map();
    this._lastTap = null;
    this._anchorId = null;
    this._pop = null;
    this._progScroll = null;
    this._userScrollAt = -1e9;
    this._selfSeekT = null;
    this._touches = 0;
    this._staleLayer = null;
    this._lastPhRow = -1;
    this._lastTime = 0;
    this._seekRaf = 0;
    this._seekT = 0;
    this._zoomRaf = 0;
    this._zoomTarget = 0;
    this._autoRaf = 0;
    this._peaksReq = new Set();
    this._player = null;
    this._destroyed = false;
    this._phone = this._detectPhone();
    this._coarse = mqMatches(COARSE_QUERY);
    this._hasTouchEvents = typeof window !== 'undefined' && 'ontouchstart' in window;

    this._build();
    this._subscribe();
    this._bindPlayer();
    this.refresh();
  }

  // ------------------------------------------------------------------------------- public API

  /** Re-render right now. */
  refresh() {
    if (this._destroyed) return;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this._render();
  }

  /** Scroll so time t is visible (desktop: its row; phone: centered under the playhead). */
  scrollToTime(t) {
    const m = this._m;
    if (!m) return;
    const x = m.L.timeToX(clamp(num(t, 0), 0, m.duration));
    if (m.phone) { this._setScrollLeft(x); return; }
    const p = this._place(x);
    this._revealRow(p.row, true);
  }

  destroy() {
    this._destroyed = true;
    this._offs.forEach((f) => { try { f(); } catch (_) { /* ignore */ } });
    this._offs = [];
    this._unbindPlayer();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._cancelDrag();
    this._closePopover();
    if (this._ro) { try { this._ro.disconnect(); } catch (_) { /* ignore */ } }
    this.root.classList.remove('sb-root', 'is-phone', 'is-desktop');
    this.root.textContent = '';
  }

  // ------------------------------------------------------------------------------- setup

  _build() {
    const root = this.root;
    root.textContent = '';
    root.classList.add('sb-root');
    this.viewport = el('div', 'sb-viewport');
    this.scroll = el('div', 'sb-scroll');
    this.content = el('div', 'sb-content');
    this.layer = el('div', 'sb-layer');
    this.ghosts = el('div', 'sb-ghosts');
    this.caret = el('div', 'sb-caret');
    this.caret.hidden = true;
    this.playhead = el('div', 'sb-playhead', { 'aria-hidden': 'true' });
    this.phGrip = el('div', 'sb-ph-grip', { 'data-sb': 'playhead', title: 'Drag to move the playhead' });
    this.phHandle = el('div', 'sb-ph-handle', { 'data-sb': 'playhead' });
    this.playhead.append(this.phGrip, this.phHandle);
    this.tip = el('div', 'sb-tip');
    this.tip.hidden = true;
    this.content.append(this.layer, this.ghosts, this.caret, this.playhead, this.tip);
    this.scroll.append(this.content);
    this.fixedPh = el('div', 'sb-fixed-ph', { 'aria-hidden': 'true' });
    this.fixedTime = el('div', 'sb-ph-time');
    this.fixedTime.textContent = '00:00.00';
    this.fixedPh.append(this.fixedTime);
    this.viewport.append(this.scroll, this.fixedPh);
    root.append(this.viewport);
    this.root.classList.toggle('is-phone', this._phone);
    this.root.classList.toggle('is-desktop', !this._phone);
  }

  _listen(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    this._offs.push(() => target.removeEventListener(type, fn, opts));
  }

  _subscribe() {
    const s = this.store;
    this._listen(s, 'change', () => { this._closePopover(); this._schedule(); });
    this._listen(s, 'media', () => this._schedule());
    this._listen(s, 'view', () => this._schedule());
    this._listen(s, 'selection', () => this._applySelection());

    const sc = this.scroll;
    this._listen(sc, 'pointerdown', (e) => this._onPointerDown(e));
    this._listen(sc, 'pointermove', (e) => this._onPointerMove(e));
    this._listen(sc, 'pointerup', (e) => this._onPointerUp(e));
    this._listen(sc, 'pointercancel', (e) => this._onPointerCancel(e));
    this._listen(sc, 'lostpointercapture', (e) => {
      // Only our own capture (on the scroll element) ending unexpectedly cancels a drag; the
      // implicit touch capture moving from the item to the scroll element also fires this event.
      if (e.target === sc && this._drag && this._drag.pointerId === e.pointerId && !this._drag.ending) this._onPointerCancel(e);
    });
    this._listen(sc, 'contextmenu', (e) => this._onContextMenu(e));
    this._listen(sc, 'keydown', (e) => this._onKeyDown(e));
    this._listen(sc, 'scroll', () => this._onScroll(), { passive: true });
    this._listen(sc, 'wheel', (e) => this._onWheel(e), { passive: false });
    this._listen(sc, 'dragstart', (e) => e.preventDefault());
    // Touch: keep the browser from scrolling once a long-press/drag/pinch owns the gesture,
    // and handle two-finger pinch-to-zoom.
    this._listen(sc, 'touchstart', (e) => this._onTouchStart(e), { passive: false });
    this._listen(sc, 'touchmove', (e) => this._onTouchMove(e), { passive: false });
    this._listen(sc, 'touchend', (e) => this._onTouchEnd(e), { passive: true });
    this._listen(sc, 'touchcancel', (e) => this._onTouchEnd(e), { passive: true });
    // iOS Safari page-zoom gestures over the storyboard.
    this._listen(sc, 'gesturestart', (e) => e.preventDefault(), { passive: false });
    this._listen(sc, 'gesturechange', (e) => e.preventDefault(), { passive: false });

    if (typeof ResizeObserver === 'function') {
      let lastW = -1, lastH = -1;
      this._ro = new ResizeObserver(() => {
        const w = this.scroll.clientWidth, h = this.scroll.clientHeight;
        if (w === lastW && h === lastH) return;
        const widthChanged = w !== lastW;
        lastW = w; lastH = h;
        if (widthChanged || this._phone) this._schedule();
      });
      this._ro.observe(this.scroll);
    }
    this._listen(window, 'resize', () => this._onLayoutChange());
    this._listen(window, 'orientationchange', () => setTimeout(() => this._onLayoutChange(), 200));
    for (const q of [PHONE_QUERY, PHONE_LANDSCAPE_QUERY, COARSE_QUERY]) {
      const m = mql(q);
      if (!m) continue;
      const fn = () => this._onLayoutChange();
      if (typeof m.addEventListener === 'function') { m.addEventListener('change', fn); this._offs.push(() => m.removeEventListener('change', fn)); } else if (typeof m.addListener === 'function') { m.addListener(fn); this._offs.push(() => m.removeListener(fn)); }
    }
    this._listen(document, 'keydown', (e) => {
      if (e.key === 'Escape') {
        if (this._drag) { e.preventDefault(); this._cancelDrag(); }
        if (this._pop) { e.preventDefault(); this._closePopover(true); }
      }
    }, true);
  }

  _bindPlayer() {
    const p = this.app.player;
    if (!p || p === this._player || typeof p.addEventListener !== 'function') return;
    this._unbindPlayer();
    this._player = p;
    this._onTime = (e) => {
      const t = e && e.detail && Number.isFinite(e.detail.time) ? e.detail.time : this._playerTime();
      this._updatePlayhead(t);
    };
    this._onPlayState = () => this._updatePlayhead(this._playerTime());
    p.addEventListener('timeupdate', this._onTime);
    p.addEventListener('play', this._onPlayState);
    p.addEventListener('pause', this._onPlayState);
    p.addEventListener('ended', this._onPlayState);
    p.addEventListener('durationchange', this._onPlayState);
  }

  _unbindPlayer() {
    const p = this._player;
    if (!p) return;
    try {
      p.removeEventListener('timeupdate', this._onTime);
      p.removeEventListener('play', this._onPlayState);
      p.removeEventListener('pause', this._onPlayState);
      p.removeEventListener('ended', this._onPlayState);
      p.removeEventListener('durationchange', this._onPlayState);
    } catch (_) { /* ignore */ }
    this._player = null;
  }

  _detectPhone() { return mqMatches(PHONE_QUERY) || mqMatches(PHONE_LANDSCAPE_QUERY); }

  _onLayoutChange() {
    const phone = this._detectPhone();
    this._coarse = mqMatches(COARSE_QUERY);
    if (phone !== this._phone) {
      this._phone = phone;
      this._cancelDrag();
      this._closePopover();
      this.root.classList.toggle('is-phone', phone);
      this.root.classList.toggle('is-desktop', !phone);
      this.scroll.scrollTop = 0;
      this.scroll.scrollLeft = 0;
    }
    this._schedule();
  }

  _schedule() {
    this._dirty = true;
    if (this._destroyed || this._raf) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    this._raf = raf(() => { this._raf = 0; if (this._dirty) this._render(); });
  }

  // ------------------------------------------------------------------------------- app helpers

  _playerTime() {
    const p = this.app.player;
    try { return p && Number.isFinite(p.currentTime) ? p.currentTime : this._lastTime; } catch (_) { return this._lastTime; }
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

  _enabled(name) {
    const c = this._cmds();
    if (!c) return false;
    try { return typeof c.isEnabled === 'function' ? c.isEnabled(name) !== false : true; } catch (_) { return true; }
  }

  _run(name, arg) {
    const c = this._cmds();
    if (!c) { console.warn(`[storyboard] command "${name}" is not available yet`); return undefined; }
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
    if (!err || (err.name === 'AbortError')) return;
    const msg = err && err.message ? err.message : 'Something went wrong.';
    const d = this.app.dialogs;
    if (d && typeof d.toast === 'function') { try { d.toast(msg, { type: 'error' }); return; } catch (_) { /* ignore */ } }
    console.error('[storyboard]', err);
  }

  _seek(t) {
    const p = this.app.player;
    const tt = clamp(num(t, 0), 0, this._m ? this._m.duration : Infinity);
    this._lastTime = tt;
    if (p && typeof p.seek === 'function') {
      try { const r = p.seek(tt); if (r && typeof r.then === 'function') r.then(null, () => {}); } catch (err) { console.warn('[storyboard] seek failed', err); }
    } else if (this._hasCommand('seek')) {
      this._run('seek', tt);
    }
    this._updatePlayhead(tt);
  }

  /** Phones: bring a caption/credits under the fixed playhead so the preview shows the text
   *  being selected and formatted (left alone when the playhead is already inside it). */
  _revealText(id) {
    const m = this._m;
    const e = m && m.tl && (m.tl.texts || []).find((x) => x.item && x.item.id === id);
    if (!e) return;
    const p = this.app.player;
    const cur = p ? num(p.currentTime, 0) : 0;
    if (cur >= e.start && cur < e.end - 0.05) return;
    this._seek(e.start + Math.min(1, Math.max(0, (e.end - e.start) / 2)));
  }

  _seekSoon(t) {
    this._seekT = t;
    if (this._seekRaf) return;
    this._seekRaf = requestAnimationFrame(() => { this._seekRaf = 0; this._seek(this._seekT); });
  }

  _pause() {
    const p = this.app.player;
    try { if (p && p.playing) { if (typeof p.pause === 'function') p.pause(); else this._run('pause'); return true; } } catch (_) { /* ignore */ }
    return false;
  }

  // ------------------------------------------------------------------------------- layout model

  _metrics() {
    const phone = this._phone;
    const coarse = this._coarse;
    const view = this.store.view || {};
    const size = ['small', 'medium', 'large'].includes(view.thumbSize) ? view.thumbSize : 'medium';
    const itemH = ITEM_HEIGHTS[phone ? 'phone' : 'desktop'][size] + (!phone && coarse ? 6 : 0);
    const sp = itemH >= 60 ? 6 : 5;
    return {
      phone,
      size,
      itemH,
      sp,
      hole: sp >= 6 ? 3 : 2,
      laneH: phone ? 26 : (coarse ? 24 : 18),
      laneGap: phone ? 5 : 3,
      gap: phone ? 3 : 4,
      minW: phone ? 34 : 28,
      rowGap: phone ? 0 : 18,
      padT: phone ? 26 : 12,
      padB: phone ? 14 : 28,
      padX: phone ? 0 : 12,
    };
  }

  _computeModel() {
    const store = this.store;
    const project = store.project || { items: [], texts: [], music: [] };
    let tl;
    try { tl = store.timeline; } catch (err) { console.error('[storyboard] timeline failed', err); tl = null; }
    if (!tl) tl = { duration: 0, segments: [], texts: [], music: [] };
    const met = this._metrics();
    const cw = this.scroll.clientWidth;
    if (!(cw > 0)) return null;
    const zoom = clamp(num(store.view && store.view.zoom, 40), ZOOM_MIN, ZOOM_MAX);
    let padL, padR, W;
    if (met.phone) {
      padL = Math.round(cw / 2);
      padR = cw - padL;
      W = Infinity;
    } else {
      padL = met.padX;
      padR = met.padX;
      W = Math.max(120, cw - padL - padR);
    }
    const L = new StripLayout({ timeline: tl, zoom, rowWidth: W, gap: met.gap, minWidth: met.minW, sliver: 26 });
    const audio = packLanes(tl.music || []);
    const text = packLanes(tl.texts || []);
    const aCount = (project.music && project.music.length) ? Math.max(1, audio.count) : 0;
    const tCount = (project.texts && project.texts.length) ? Math.max(1, text.count) : 0;
    const laneBlock = met.laneH + met.laneGap;
    if (met.phone) {
      // Phone portrait panes are tall: grow the filmstrip into the free height (bigger, easier
      // touch targets, like phone editors) and keep what is still left over balanced above and
      // below the strip instead of leaving a blank block under it.
      const ch = this.scroll.clientHeight;
      const lanesH = (aCount + tCount) * laneBlock;
      const size = met.size;
      const cap = PHONE_ITEM_MAX[size] || PHONE_ITEM_MAX.medium;
      const avail = Math.floor(ch - met.padT - met.padB - lanesH - 2);
      if (ch > 0 && avail > met.itemH) {
        met.itemH = Math.min(cap, avail);
        met.sp = met.itemH >= 60 ? (met.itemH >= 90 ? 7 : 6) : 5;
        met.hole = met.sp >= 6 ? 3 : 2;
      }
      const extra = ch - (met.padT + met.itemH + lanesH + met.padB);
      if (ch > 0 && extra > 12) met.padT += Math.floor(extra * 0.42);
    }
    const rowH = met.itemH + (aCount + tCount) * laneBlock;
    const rowPitch = rowH + met.rowGap;
    const items = project.items || [];
    const addTileW = met.phone ? met.itemH : 0;
    let stripLen = L.endX;
    if (met.phone) stripLen = Math.max(stripLen, L.visualEndX + met.gap * 2 + addTileW);
    const rows = met.phone ? 1 : Math.max(1, Math.ceil((L.endX + 2) / W));
    const contentW = met.phone ? Math.ceil(padL + stripLen + padR) : cw;
    const contentH = Math.ceil(met.padT + rows * rowPitch - met.rowGap + met.padB);
    const bounds = [0];
    for (const seg of tl.segments || []) { bounds.push(seg.start); bounds.push(seg.end); }
    return {
      ...met, cw, zoom, padL, padR, W, L, tl, project, items, rows, rowH, rowPitch, aCount, tCount,
      audioLanes: audio.lanes, textLanes: text.lanes, laneBlock, contentW, contentH,
      duration: Math.max(num(tl.duration, 0), L.visualEndT), bounds,
    };
  }

  _rowTop(r) { const m = this._m; return m.padT + r * m.rowPitch; }
  _audioTop(r, k) { const m = this._m; return this._rowTop(r) + m.itemH + m.laneGap + k * m.laneBlock; }
  _textTop(r, k) { const m = this._m; return this._rowTop(r) + m.itemH + m.laneGap + (m.aCount + k) * m.laneBlock; }

  /** Strip x → { row, left, top } in content coordinates. */
  _place(x) {
    const m = this._m;
    if (m.phone) return { row: 0, left: m.padL + x, top: m.padT };
    let row = Math.floor(x / m.W);
    if (row >= m.rows) row = m.rows - 1;
    if (row < 0) row = 0;
    const rx = clamp(x - row * m.W, 0, m.W);
    return { row, left: m.padL + rx, top: this._rowTop(row) };
  }

  _contentPoint(clientX, clientY) {
    const r = this.content.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  _rowAtY(y) {
    const m = this._m;
    return clamp(Math.floor((y - m.padT + m.rowGap / 2) / m.rowPitch), 0, m.rows - 1);
  }

  _stripXAt(x, y) {
    const m = this._m;
    if (m.phone) return x - m.padL;
    const row = this._rowAtY(y);
    return row * m.W + clamp(x - m.padL, 0, m.W);
  }

  _timeAtClient(clientX, clientY) {
    const m = this._m;
    if (!m) return 0;
    const p = this._contentPoint(clientX, clientY);
    return clamp(m.L.xToTime(this._stripXAt(p.x, p.y)), 0, m.duration);
  }

  // ------------------------------------------------------------------------------- rendering

  _render() {
    if (this._destroyed) return;
    this._bindPlayer();
    if (this._drag || this._press) { this._dirty = true; return; }
    const phone = this._detectPhone();
    if (phone !== this._phone) {
      this._phone = phone;
      this.root.classList.toggle('is-phone', phone);
      this.root.classList.toggle('is-desktop', !phone);
    }
    const m = this._computeModel();
    if (!m) { this._dirty = true; this._m = null; return; }
    this._dirty = false;

    // Remember focus so keyboard users keep their place across re-renders.
    const ae = document.activeElement;
    const focusId = ae && this.content.contains(ae) && ae.dataset ? ae.dataset.id : null;
    const prevScrollTop = this.scroll.scrollTop;

    this._m = m;
    this._els = new Map();
    this._focusEls = new Map();
    const frag = document.createDocumentFragment();
    this.content.style.width = `${m.contentW}px`;
    this.content.style.height = `${m.contentH}px`;
    this.root.style.setProperty('--sb-sp', `${m.sp}px`);
    this.root.style.setProperty('--sb-top', `${m.padT}px`);
    this.root.style.setProperty('--sb-ph-h', `${Math.round(26 + m.rowH + 10)}px`);
    this.root.style.setProperty('--sb-hole', `${m.hole}px`);

    const project = m.project;
    const empty = !project.items.length && !project.texts.length && !project.music.length;
    this.root.classList.toggle('is-empty', empty);
    if (this._emptyEl) { this._emptyEl.remove(); this._emptyEl = null; }
    if (empty) {
      this._emptyEl = this._buildEmptyState();
      this.viewport.appendChild(this._emptyEl);
      this.content.style.height = '0px';
      this.content.style.width = '0px';
    } else {
      this._buildTracks(frag);
      this._buildItems(frag);
      this._buildTail(frag);
      this._buildBars(frag, 'music');
      this._buildBars(frag, 'text');
      this._buildAddButtons(frag);
    }
    if (this._touches > 0 && !this._staleLayer) {
      // Fingers are down (pinch-zoom re-renders): the elements they started on must stay in the
      // document, or their touchmove/touchend events would no longer reach us. Keep that layer,
      // hidden and inert, until the touches end, and render into a fresh one.
      const old = this.layer;
      old.classList.add('is-stale');
      this._staleLayer = old;
      this.layer = el('div', 'sb-layer');
      this.content.insertBefore(this.layer, old);
    }
    this.layer.replaceChildren ? this.layer.replaceChildren(frag) : (this.layer.textContent = '', this.layer.appendChild(frag));
    this.playhead.hidden = empty;
    this.fixedPh.style.visibility = empty ? 'hidden' : '';
    this.playhead.style.height = `${m.rowH + 6}px`;
    this._applySelection();
    if (!m.phone) this.scroll.scrollTop = prevScrollTop;
    this._lastPhRow = -1;
    this._updatePlayhead(this._playerTime(), { reveal: false, force: true });
    if (focusId) {
      const f = this._focusEls.get(focusId);
      if (f) { try { f.focus({ preventScroll: true }); } catch (_) { f.focus(); } }
    }
    this._requestPeaks();
  }

  _buildEmptyState() {
    const wrap = el('div', 'sb-empty');
    const btn = el('button', 'sb-empty-btn', { type: 'button', 'data-sb-btn': 'add' });
    btn.appendChild(iconEl('add-videos', 56));
    const main = el('span', 'sb-empty-main');
    main.textContent = 'Click here to browse for videos and photos';
    btn.appendChild(main);
    if (!this._coarse && !this._phone) {
      const sub = el('span', 'sb-empty-sub');
      sub.textContent = 'or drag them here';
      btn.appendChild(sub);
    }
    btn.addEventListener('click', () => this._run('addMedia'));
    wrap.appendChild(btn);
    return wrap;
  }

  _buildTracks(frag) {
    const m = this._m;
    if (!m.aCount && !m.tCount) return;
    const width = m.phone ? Math.max(m.L.endX, m.contentW - m.padL - m.padR) + m.padR : m.W;
    const left = m.phone ? m.padL : m.padL;
    for (let r = 0; r < m.rows; r++) {
      if (m.aCount) {
        const t = el('div', 'sb-track sb-track-audio');
        t.style.cssText = `left:${left}px;top:${this._audioTop(r, 0)}px;width:${width}px;height:${m.aCount * m.laneBlock - m.laneGap}px`;
        frag.appendChild(t);
      }
      if (m.tCount) {
        const t = el('div', 'sb-track sb-track-text');
        t.style.cssText = `left:${left}px;top:${this._textTop(r, 0)}px;width:${width}px;height:${m.tCount * m.laneBlock - m.laneGap}px`;
        frag.appendChild(t);
      }
    }
  }

  _media(id) {
    if (!id) return undefined;
    try { return this.store.getMedia ? this.store.getMedia(id) : (this.store.media && this.store.media.get(id)); } catch (_) { return undefined; }
  }

  _buildItems(frag) {
    const m = this._m;
    const segs = m.tl.segments || [];
    const n = segs.length;
    const fine = !this._coarse && !m.phone;
    const projectAspect = { '16:9': 16 / 9, '4:3': 4 / 3, '9:16': 9 / 16, '1:1': 1 }[m.project.aspect] || 16 / 9;
    const frameH = m.itemH - 2 * m.sp;
    for (let i = 0; i < n; i++) {
      const seg = segs[i];
      const item = seg.item;
      if (!item) continue;
      const media = item.kind === 'title' ? null : this._media(item.mediaId);
      const missing = item.kind !== 'title' && !media;
      const x0 = m.L.x0[i], x1 = m.L.x1[i];
      const w = x1 - x0;
      const dur = num(seg.duration, 0);
      const rot = [90, 180, 270].includes(item.rotation) ? item.rotation : 0;
      let aspect = projectAspect;
      if (media && media.width > 0 && media.height > 0) aspect = media.width / media.height;
      if (rot === 90 || rot === 270) aspect = 1 / aspect;
      aspect = clamp(aspect, 0.4, 3);
      const tw = Math.max(16, Math.round(frameH * aspect));
      const frames = media ? ((Array.isArray(media.filmstrip) && media.filmstrip.length) ? media.filmstrip : (media.thumb ? [media.thumb] : [])) : [];
      const name = item.kind === 'title' ? firstLine(item.text, 80) || 'Title' : (media ? media.name || 'Untitled' : 'Missing file');
      const trans = seg.transitionIn && seg.transitionIn.type && seg.transitionIn.type !== 'none' ? seg.transitionIn : null;
      const pxPerSec = m.L.t1[i] > m.L.t0[i] ? w / (m.L.t1[i] - m.L.t0[i]) : m.zoom;
      const els = [];
      let pieceIndex = 0;
      const pieceCount = this._countSpans(x0, x1);
      m.L.spans(x0, x1, (row, rx, pw, off) => {
        const first = pieceIndex === 0;
        const last = pieceIndex === pieceCount - 1;
        pieceIndex++;
        const p = el('div', `sb-item sb-kind-${item.kind}${first ? '' : ' is-cont-left'}${last ? '' : ' is-cont-right'}`, {
          'data-sb': 'item', 'data-id': item.id, 'data-index': i,
        });
        p.style.cssText = `left:${(m.phone ? m.padL : m.padL) + rx}px;top:${this._rowTop(row)}px;width:${pw}px;height:${m.itemH}px`;
        const fr = el('div', 'sb-frames');
        if (item.kind === 'title') {
          const slate = el('div', 'sb-slate');
          slate.style.background = item.background || '#000';
          if (first) {
            const tx = el('span', 'sb-slate-text');
            const st = item.style || {};
            tx.textContent = firstLine(item.text, 120) || ' ';
            tx.style.color = st.color || '#fff';
            tx.style.fontFamily = st.font || 'inherit';
            tx.style.fontWeight = st.bold ? '700' : '400';
            tx.style.fontStyle = st.italic ? 'italic' : 'normal';
            tx.style.fontSize = `${Math.max(10, Math.round(frameH * 0.24))}px`;
            slate.appendChild(tx);
          }
          fr.appendChild(slate);
        } else if (missing || !frames.length) {
          const ms = el('div', 'sb-missing');
          if (first && pw > 40) {
            ms.appendChild(svgEl(WARN_SVG, 14));
            const t = el('span');
            t.textContent = missing ? 'Missing file' : (item.kind === 'video' ? 'Video' : 'Photo');
            ms.appendChild(t);
          }
          fr.appendChild(ms);
        } else {
          this._buildTiles(fr, item, seg, media, frames, i, off, pw, tw, frameH, rot);
        }
        p.appendChild(fr);
        if (first && trans) {
          const zw = Math.min(pw, Math.max(4, trans.duration * pxPerSec));
          const zone = el('div', 'sb-trans-zone');
          zone.style.width = `${zw}px`;
          p.appendChild(zone);
          p.appendChild(el('span', 'sb-trans', { title: fine ? `Transition: ${trans.type}` : null }));
        }
        if (first && item.kind !== 'title' && item.panZoom && item.panZoom !== 'none' && pw >= 24) {
          const pz = el('span', 'sb-pz');
          pz.appendChild(svgEl(PZ_SVG, 15));
          if (fine) pz.title = `Pan and zoom: ${item.panZoom}`;
          p.appendChild(pz);
        }
        if (first && m.phone && pw >= 50) {
          const d = el('span', 'sb-dur');
          d.textContent = dur >= 60 ? formatTime(dur).replace(/^0/, '') : `${dur.toFixed(1)}s`;
          p.appendChild(d);
        }
        if (first) {
          p.setAttribute('role', 'button');
          p.setAttribute('tabindex', '-1');
          p.setAttribute('aria-pressed', 'false');
          let label = `${KIND_LABEL[item.kind] || 'Item'} ${i + 1} of ${n}: ${name}, ${formatTime(dur)}`;
          if (trans) label += `, transition ${trans.type}`;
          if (item.panZoom && item.panZoom !== 'none' && item.kind !== 'title') label += ', pan and zoom';
          if (item.effect && item.effect !== 'none') label += `, effect ${item.effect}`;
          if (missing) label += ' (file missing)';
          p.setAttribute('aria-label', label);
          if (fine) p.title = `${name}\nDuration: ${formatTime(dur)}`;
          this._focusEls.set(item.id, p);
        } else {
          p.setAttribute('aria-hidden', 'true');
          if (fine) p.title = `${name}\nDuration: ${formatTime(dur)}`;
        }
        els.push(p);
        frag.appendChild(p);
      });
      this._els.set(item.id, els);
    }
  }

  _countSpans(xa, xb) {
    let c = 0;
    this._m.L.spans(xa, xb, () => { c++; });
    return c;
  }

  _buildTiles(fr, item, seg, media, frames, index, off, pw, tw, frameH, rot) {
    const m = this._m;
    const nF = frames.length;
    const k0 = Math.floor(off / tw);
    let k1 = Math.ceil((off + pw) / tw);
    if (k1 - k0 > MAX_TILES_PER_PIECE) k1 = k0 + MAX_TILES_PER_PIECE;
    const isVideo = item.kind === 'video';
    const mediaDur = media && media.duration > 0 ? media.duration : 0;
    const speed = item.speed > 0 ? item.speed : 1;
    const x0 = m.L.x0[index], x1 = m.L.x1[index];
    for (let k = k0; k < k1; k++) {
      let fi = 0;
      if (isVideo && nF > 1 && mediaDur > 0) {
        // Each tile shows the frame at its left edge (the first tile shows the first frame).
        const xc = Math.min(x1, x0 + k * tw + 0.5);
        const local = Math.max(0, m.L.xToTime(xc) - seg.start);
        const src = clamp(num(seg.sourceIn, 0) + local * speed, 0, mediaDur);
        fi = clamp(Math.floor((src / mediaDur) * nF), 0, nF - 1);
      }
      const img = document.createElement('img');
      img.className = 'sb-tile';
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.src = cachedImageUrl(frames[fi]);
      const left = k * tw - off;
      if (rot === 90 || rot === 270) {
        img.style.cssText = `left:${left + (tw - frameH) / 2}px;top:${(frameH - tw) / 2}px;width:${frameH}px;height:${tw}px;transform:rotate(${rot}deg)`;
      } else {
        img.style.cssText = `left:${left}px;width:${tw}px${rot === 180 ? ';transform:rotate(180deg)' : ''}`;
      }
      fr.appendChild(img);
    }
  }

  /** Desktop: when captions/credits or music run past the last picture, the movie shows black
   *  there. Draw that stretch in the item track as a black slate (WLMM showed credits as a black
   *  clip), so a wrapped row isn't just empty space above a lone credits bar. Not interactive. */
  _buildTail(frag) {
    const m = this._m;
    if (m.phone || !m.L.n) return;
    const xa = m.L.visualEndX + m.gap;
    const xb = m.L.endX;
    if (!(xb - xa > 6)) return;
    const tStart = m.L.visualEndT;
    const credits = (m.tl.texts || []).some((e) => e.item && e.item.kind === 'credits' && e.end > tStart + 0.05);
    const label = credits ? 'Credits' : '';
    m.L.spans(xa, xb, (row, rx, pw) => {
      if (pw < 3) return;
      const d = el('div', 'sb-tail', { 'aria-hidden': 'true' });
      d.style.cssText = `left:${m.padL + rx}px;top:${this._rowTop(row)}px;width:${pw}px;height:${m.itemH}px`;
      if (label && pw >= 44) { const sp = el('span', 'sb-tail-label'); sp.textContent = label; d.appendChild(sp); }
      frag.appendChild(d);
    });
  }

  _buildBars(frag, which) {
    const m = this._m;
    const entries = which === 'music' ? (m.tl.music || []) : (m.tl.texts || []);
    const lanes = which === 'music' ? m.audioLanes : m.textLanes;
    const fine = !this._coarse && !m.phone;
    const showWaves = !!(this.store.view && this.store.view.showWaveforms);
    const total = entries.length;
    entries.forEach((e, idx) => {
      const item = e.item;
      if (!item) return;
      const lane = lanes.get(item.id) || 0;
      const xa = m.L.timeToX(e.start);
      const xb = Math.max(xa + 8, m.L.timeToX(e.end));
      const dur = Math.max(0, e.end - e.start);
      let cls, label, kindName, media = null;
      if (which === 'music') {
        media = this._media(item.mediaId);
        const narr = item.kind === 'narration';
        cls = narr ? 'sb-bar sb-narration' : 'sb-bar sb-music';
        if (!media) cls += ' is-missing';
        kindName = narr ? 'Narration' : 'Music';
        label = media ? (media.name || kindName) : `${kindName} (missing file)`;
      } else {
        const credits = item.kind === 'credits';
        cls = credits ? 'sb-bar sb-caption sb-credits' : 'sb-bar sb-caption';
        kindName = credits ? 'Credits' : 'Caption';
        label = firstLine(item.text, 80) || kindName;
      }
      const els = [];
      let pieceIndex = 0;
      const pieceCount = this._countSpans(xa, xb);
      m.L.spans(xa, xb, (row, rx, pw, off) => {
        const first = pieceIndex === 0;
        const last = pieceIndex === pieceCount - 1;
        pieceIndex++;
        const b = el('div', `${cls}${first ? '' : ' is-cont-left'}${last ? '' : ' is-cont-right'}`, {
          'data-sb': which, 'data-id': item.id,
        });
        const top = which === 'music' ? this._audioTop(row, lane) : this._textTop(row, lane);
        b.style.cssText = `left:${m.padL + rx}px;top:${top}px;width:${pw}px;height:${m.laneH}px;line-height:${m.laneH - 2}px`;
        if (which === 'music' && showWaves && media && Array.isArray(media.peaks) && media.peaks.length && pw >= 4) {
          const cv = this._waveCanvas(media, item, e, xa + off, pw, m.laneH - 2);
          if (cv) b.appendChild(cv);
        }
        if (pw >= 18) {
          const lb = el('span', 'sb-bar-label');
          lb.textContent = label;
          b.appendChild(lb);
        }
        if (first) {
          b.setAttribute('role', 'button');
          b.setAttribute('tabindex', '-1');
          b.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-label', `${kindName} ${idx + 1} of ${total}: ${label}, starts at ${formatTime(e.start)}, ${formatTime(dur)} long`);
          this._focusEls.set(item.id, b);
        } else {
          b.setAttribute('aria-hidden', 'true');
        }
        if (fine) b.title = `${label}\nStart: ${formatTime(e.start)}  Duration: ${formatTime(dur)}`;
        els.push(b);
        frag.appendChild(b);
      });
      this._els.set(item.id, els);
    });
  }

  _waveCanvas(media, item, entry, stripX, pw, h) {
    if (!(h > 2)) return null;
    const peaks = media.peaks;
    const mediaDur = media.duration > 0 ? media.duration : 0;
    if (!mediaDur) return null;
    const pps = peaks.length / mediaDur;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = Math.max(1, Math.round(pw));
    const cv = document.createElement('canvas');
    cv.className = 'sb-wave';
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = item.kind === 'narration' ? '#0b4d40' : '#1c4f0b';
    const L = this._m.L;
    const trim = num(item.trimStart, 0);
    const mid = h / 2;
    let tPrev = L.xToTime(stripX);
    for (let c = 0; c < w; c++) {
      const tNext = L.xToTime(stripX + c + 1);
      const s0 = trim + (tPrev - entry.start);
      const s1 = trim + (tNext - entry.start);
      tPrev = tNext;
      let i0 = Math.floor(s0 * pps);
      let i1 = Math.ceil(s1 * pps);
      if (i1 <= i0) i1 = i0 + 1;
      if (i0 < 0) i0 = 0;
      if (i1 > peaks.length) i1 = peaks.length;
      let pk = 0;
      for (let j = i0; j < i1; j++) { const v = peaks[j]; if (v > pk) pk = v; }
      if (pk <= 0.01) continue;
      const bh = Math.max(1, Math.min(1, pk) * (h - 2) * 0.82);
      ctx.fillRect(c, mid - bh / 2, 1, bh);
    }
    return cv;
  }

  _buildAddButtons(frag) {
    const m = this._m;
    if (m.phone) {
      const b = el('button', 'sb-add-tile', { type: 'button', 'data-sb-btn': 'add', 'aria-label': 'Add videos and photos', title: 'Add videos and photos' });
      const size = m.itemH;
      const left = m.padL + (m.L.n ? m.L.visualEndX + m.gap * 2 : 0);
      b.style.cssText = `left:${left}px;top:${m.padT}px;width:${size}px;height:${size}px`;
      b.appendChild(svgEl(PLUS_SVG, Math.round(size * 0.45)));
      b.addEventListener('click', () => this._run('addMedia'));
      frag.appendChild(b);
    } else if (!m.L.n) {
      const b = el('button', 'sb-add-inline', { type: 'button', 'data-sb-btn': 'add' });
      b.style.cssText = `left:${m.padL}px;top:${m.padT}px;width:${Math.min(m.W, 380)}px;height:${m.itemH}px`;
      b.appendChild(iconEl('add-videos', 24));
      const t = el('span');
      t.textContent = 'Click here to browse for videos and photos';
      b.appendChild(t);
      b.addEventListener('click', () => this._run('addMedia'));
      frag.appendChild(b);
    }
  }

  _requestPeaks() {
    const m = this._m;
    const api = this.app.media;
    if (!m || !this.store.view || !this.store.view.showWaveforms || !api || typeof api.computePeaks !== 'function') return;
    for (const e of m.tl.music || []) {
      const media = this._media(e.item && e.item.mediaId);
      if (!media || media.peaks || this._peaksReq.has(media.id) || !media.blob) continue;
      this._peaksReq.add(media.id);
      setTimeout(() => {
        if (this._destroyed) return;
        let p;
        try { p = api.computePeaks(media); } catch (_) { return; }
        Promise.resolve(p).then((peaks) => {
          if (this._destroyed || !peaks || !peaks.length) return;
          if (!media.peaks) media.peaks = peaks;
          if (typeof this.store.touchMedia === 'function') this.store.touchMedia(media.id);
          else this._schedule();
        }, () => { /* no waveform for this file */ });
      }, 250);
    }
  }

  // ------------------------------------------------------------------------------- selection

  _applySelection() {
    const sel = this.store.selection || { type: null, ids: [] };
    const ids = new Set(sel.ids || []);
    for (const [id, els] of this._els) {
      const on = ids.has(id);
      for (const e of els) {
        if (e.classList.contains('is-selected') !== on) e.classList.toggle('is-selected', on);
      }
      const f = this._focusEls.get(id);
      if (f) f.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // Roving tabindex: the first selected visual item (or the first item) is the tab stop.
    const m = this._m;
    let stop = null;
    if (sel.type === 'item' && sel.ids && sel.ids.length) stop = this._focusEls.get(sel.ids[0]);
    else if (sel.type && sel.ids && sel.ids.length) stop = this._focusEls.get(sel.ids[0]);
    if (!stop && m && m.items.length) stop = this._focusEls.get(m.items[0].id);
    for (const f of this._focusEls.values()) {
      const t = f === stop ? '0' : '-1';
      if (f.getAttribute('tabindex') !== t) f.setAttribute('tabindex', t);
    }
  }

  _selectItem(id, e) {
    const store = this.store;
    const sel = store.selection || { type: null, ids: [] };
    const multi = !this._phone && e && (e.ctrlKey || e.metaKey);
    const range = !this._phone && e && e.shiftKey;
    const items = (store.project && store.project.items) || [];
    if (range && sel.type === 'item' && sel.ids.length) {
      const anchor = this._anchorId && items.some((it) => it.id === this._anchorId) ? this._anchorId : sel.ids[0];
      const a = items.findIndex((it) => it.id === anchor);
      const b = items.findIndex((it) => it.id === id);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        store.select('item', items.slice(lo, hi + 1).map((it) => it.id));
        return;
      }
    }
    if (multi && sel.type === 'item') {
      const next = sel.ids.includes(id) ? sel.ids.filter((x) => x !== id) : sel.ids.concat(id);
      this._anchorId = id;
      store.select(next.length ? 'item' : null, next);
      return;
    }
    this._anchorId = id;
    store.select('item', [id]);
  }

  // ------------------------------------------------------------------------------- playhead

  /**
   * Move the playhead to time t. Desktop: reveal its row when it changes row (always while
   * playing; when paused only if the user has not just scrolled away). Phone: scroll the strip
   * so t sits under the fixed playhead, unless the user is touching/scrolling it.
   */
  _updatePlayhead(t, { reveal = true, force = false } = {}) {
    const m = this._m;
    this._lastTime = num(t, 0);
    if (!m) return;
    const tt = clamp(this._lastTime, 0, Math.max(m.duration, 0));
    const x = m.L.timeToX(tt);
    if (m.phone) {
      const txt = formatTime(tt);
      if (this.fixedTime.textContent !== txt) this.fixedTime.textContent = txt;
      // Skip while a finger is on the strip, and for the echo of our own scroll-driven seek
      // (the strip is already there; re-syncing would snap it out of gaps between items).
      const echo = this._selfSeekT !== null && Math.abs(tt - this._selfSeekT) < 1e-3;
      if (!echo) this._selfSeekT = null;
      if (force || (!this._press && !this._drag && !echo)) this._setScrollLeft(x);
      return;
    }
    const p = this._place(x);
    this.playhead.style.transform = `translate3d(${p.left}px,${p.top - 4}px,0)`;
    const changed = p.row !== this._lastPhRow;
    this._lastPhRow = p.row;
    if (!reveal || !changed || this._drag || (this._press && this._press.hit.kind === 'playhead')) return;
    if (this._isPlaying() || nowMs() - this._userScrollAt > 1200) this._revealRow(p.row, false);
  }

  _revealRow(row, center) {
    const m = this._m;
    if (!m || m.phone) return;
    const sc = this.scroll;
    const top = this._rowTop(row) - 8;
    const bottom = this._rowTop(row) + m.rowH + 8;
    const vh = sc.clientHeight;
    if (!(vh > 0)) return;
    if (top >= sc.scrollTop && bottom <= sc.scrollTop + vh) return;
    let target = top;
    if (center) target = top - Math.max(0, (vh - (bottom - top)) / 2);
    else if (bottom > sc.scrollTop + vh && top > sc.scrollTop) target = Math.min(top, bottom - vh);
    this._progScrollTop = Math.max(0, Math.round(target));
    sc.scrollTop = this._progScrollTop;
  }

  _setScrollLeft(x) {
    const sc = this.scroll;
    const m = this._m;
    // The model knows the scroll range; avoid forcing layout reads on every playback frame.
    const max = m && m.phone ? Math.max(0, m.contentW - m.cw) : Math.max(0, sc.scrollWidth - sc.clientWidth);
    const v = clamp(Math.round(x), 0, max);
    if (Math.abs(sc.scrollLeft - v) < 0.5) { this._progScroll = v; return; }
    this._progScroll = v;
    sc.scrollLeft = v;
  }

  _onScroll() {
    const m = this._m;
    if (!m) return;
    if (!m.phone) {
      if (this._progScrollTop != null && Math.abs(this.scroll.scrollTop - this._progScrollTop) < 2) { this._progScrollTop = null; return; }
      this._progScrollTop = null;
      this._userScrollAt = nowMs();
      this._closePopover();
      return;
    }
    const sl = this.scroll.scrollLeft;
    if (this._progScroll != null && Math.abs(sl - this._progScroll) < 1.5) return;
    this._progScroll = null;
    if (this._drag || this._pinchActive()) return;
    this._closePopover();
    this._userScrollAt = nowMs();
    if (this._isPlaying()) this._pause();
    const t = clamp(m.L.xToTime(sl), 0, m.duration);
    const txt = formatTime(t);
    if (this.fixedTime.textContent !== txt) this.fixedTime.textContent = txt;
    this._lastTime = t;
    this._selfSeekT = t;
    this._seekSoon(t);
  }

  _onWheel(e) {
    const m = this._m;
    if (!m) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
      const base = this._zoomRaf ? this._zoomTarget : m.zoom;
      this._zoomTo(base * Math.exp(-clamp(dy, -200, 200) * 0.0035));
      return;
    }
    if (m.phone) {
      // Mouse wheels scroll the single-lane strip sideways.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.scroll.scrollHeight <= this.scroll.clientHeight + 1) {
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
        this.scroll.scrollLeft += dy;
      }
      if (this._isPlaying()) this._pause();
    }
  }

  _zoomTo(z) {
    this._zoomTarget = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (this._zoomRaf) return;
    this._zoomRaf = requestAnimationFrame(() => {
      this._zoomRaf = 0;
      const zt = Math.round(this._zoomTarget * 100) / 100;
      if (typeof this.store.setView === 'function') this.store.setView({ zoom: zt });
    });
  }

  // ------------------------------------------------------------------------------- pointer input

  _hitFromTarget(target) {
    if (!target || !target.closest) return { kind: 'blank' };
    const btn = target.closest('[data-sb-btn]');
    if (btn) return { kind: 'button', el: btn };
    const e = target.closest('[data-sb]');
    if (!e || !this.content.contains(e)) return { kind: 'blank' };
    const kind = e.getAttribute('data-sb');
    if (kind === 'playhead') return { kind: 'playhead', el: e };
    const id = e.getAttribute('data-id');
    if (!id) return { kind: 'blank' };
    if (kind === 'item') return { kind: 'item', id, el: e, index: +e.getAttribute('data-index') || 0 };
    if (kind === 'music' || kind === 'text') return { kind, id, el: e };
    return { kind: 'blank' };
  }

  _onPointerDown(e) {
    if (!this._m) return;
    const hit = this._hitFromTarget(e.target);
    if (hit.kind === 'button') return;
    if (e.target === this.scroll && (e.offsetX > this.scroll.clientWidth || e.offsetY > this.scroll.clientHeight)) return; // scrollbar
    if (e.pointerType !== 'mouse') {
      if (e.isPrimary && !this._pinch) this._ptrs.clear(); // a primary pointer means no others are down
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._ptrs.size >= 2 && !this._hasTouchEvents) { this._startPointerPinch(); return; }
    }
    if (this._pinchActive()) return;
    if (this._press || this._drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this._phone && this._isPlaying()) this._pause();
    const press = {
      pointerId: e.pointerId, type: e.pointerType || 'mouse', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      hit, time: nowMs(), armed: false, cancelled: false, timer: 0, wasPlaying: false, mods: { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey },
      sl0: this.scroll.scrollLeft, panned: false,
    };
    this._press = press;
    if (hit.kind === 'playhead') {
      e.preventDefault();
      press.wasPlaying = this._pause();
      this._capture(e.pointerId);
      return;
    }
    if (press.type === 'mouse') {
      this._capture(e.pointerId);
      return;
    }
    if (hit.kind === 'item' || hit.kind === 'music' || hit.kind === 'text') {
      press.timer = setTimeout(() => this._arm(press), LONG_PRESS_MS);
    }
  }

  _capture(pointerId) {
    try { this.scroll.setPointerCapture(pointerId); } catch (_) { /* ignore */ }
  }

  _arm(press) {
    if (this._press !== press || press.cancelled) return;
    press.timer = 0;
    press.armed = true;
    vibrate(10);
    const els = this._els.get(press.hit.id) || [];
    for (const x of els) x.classList.add('is-armed');
  }

  _disarm(press) {
    if (!press) return;
    if (press.timer) { clearTimeout(press.timer); press.timer = 0; }
    if (press.hit && press.hit.id) {
      const els = this._els.get(press.hit.id) || [];
      for (const x of els) x.classList.remove('is-armed');
    }
  }

  _onPointerMove(e) {
    if (this._ptrs.has(e.pointerId)) this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinch && this._pinch.pointer) { this._updatePointerPinch(); return; }
    const p = this._press;
    if (!p || e.pointerId !== p.pointerId) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this._drag) { this._dragMove(e.clientX, e.clientY); return; }
    const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
    const dist = Math.hypot(dx, dy);
    if (p.hit.kind === 'playhead') {
      this._seekSoon(this._timeAtClient(e.clientX, e.clientY));
      this._updatePlayheadAtClient(e.clientX, e.clientY);
      return;
    }
    const draggable = p.hit.kind === 'item' || p.hit.kind === 'music' || p.hit.kind === 'text';
    if (p.type === 'mouse') {
      if (draggable && dist > MOUSE_DRAG_PX) this._startDrag(e);
      else if (!draggable && this._phone && (p.panned || dist > MOUSE_DRAG_PX)) {
        // Mouse in the phone-style strip (narrow window): drag the empty area to scroll.
        p.panned = true;
        this.scroll.scrollLeft = p.sl0 - dx;
      }
      return;
    }
    if (!p.armed) {
      if (dist > TOUCH_SLOP_PX) { p.cancelled = true; this._disarm(p); }
      return;
    }
    if (dist > ARMED_DRAG_PX) this._startDrag(e);
  }

  _updatePlayheadAtClient(cx, cy) {
    const t = this._timeAtClient(cx, cy);
    this._lastTime = t;
    const m = this._m;
    if (!m || m.phone) return;
    const pl = this._place(m.L.timeToX(t));
    this.playhead.style.transform = `translate3d(${pl.left}px,${pl.top - 4}px,0)`;
  }

  _onPointerUp(e) {
    this._ptrs.delete(e.pointerId);
    if (this._pinch && this._pinch.pointer) { if (this._ptrs.size < 2) this._endPinch(); return; }
    const p = this._press;
    if (!p || e.pointerId !== p.pointerId) return;
    this._disarm(p);
    this._press = null;
    if (this._drag) { this._finishDrag(e.clientX, e.clientY); this._flushDirty(); return; }
    if (p.hit.kind === 'playhead') {
      this._seek(this._timeAtClient(e.clientX, e.clientY));
      if (p.wasPlaying) this._resume();
      this._flushDirty();
      return;
    }
    const dist = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
    if (p.armed) {
      this._flushDirty();
      if (dist <= ARMED_DRAG_PX) this._openPopoverFor(p.hit, e.clientX, e.clientY, false);
      return;
    }
    if (p.cancelled || p.panned || dist > (p.type === 'mouse' ? MOUSE_DRAG_PX : TOUCH_SLOP_PX)) { this._flushDirty(); return; }
    this._tap(p, e);
    this._flushDirty();
  }

  _onPointerCancel(e) {
    this._ptrs.delete(e.pointerId);
    if (this._pinch && this._pinch.pointer && this._ptrs.size < 2) this._endPinch();
    const p = this._press;
    if (!p || e.pointerId !== p.pointerId) return;
    this._disarm(p);
    this._press = null;
    if (this._drag) this._cancelDrag();
    if (p.hit.kind === 'playhead' && p.wasPlaying) this._resume();
    this._flushDirty();
  }

  _resume() {
    const p = this.app.player;
    try { if (p && !p.playing && typeof p.play === 'function') { const r = p.play(); if (r && r.catch) r.catch(() => {}); } } catch (_) { /* ignore */ }
  }

  _flushDirty() {
    if (this._dirty && !this._press && !this._drag) this._schedule();
  }

  _tap(p, e) {
    const hit = p.hit;
    const t = nowMs();
    const last = this._lastTap;
    const dbl = !!(last && hit.id && last.id === hit.id && t - last.time < DOUBLE_TAP_MS
      && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_PX);
    this._lastTap = dbl ? null : { id: hit.id || null, time: t, x: e.clientX, y: e.clientY };
    const mods = p.mods || {};
    const plain = !(mods.ctrlKey || mods.metaKey || mods.shiftKey);
    if (p.type === 'mouse' && hit.el && hit.id) {
      const f = this._focusEls.get(hit.id);
      if (f) { try { f.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
    }
    if (hit.kind === 'item') {
      if (dbl) { this._openContext({ kind: 'item', id: hit.id }); return; }
      this._selectItem(hit.id, mods);
      if (!this._phone && plain) this._seek(this._timeAtClient(e.clientX, e.clientY));
      return;
    }
    if (hit.kind === 'music' || hit.kind === 'text') {
      if (dbl) { this._openContext({ kind: hit.kind, id: hit.id }); return; }
      this.store.select(hit.kind, [hit.id]);
      if (!this._phone && plain) this._seek(this._timeAtClient(e.clientX, e.clientY));
      else if (this._phone && hit.kind === 'text') this._revealText(hit.id);
      return;
    }
    // Blank area: clear the selection and (desktop) move the playhead there.
    if (typeof this.store.select === 'function') this.store.select(null, []);
    if (!this._phone) this._seek(this._timeAtClient(e.clientX, e.clientY));
  }

  _onContextMenu(e) {
    const hit = this._hitFromTarget(e.target);
    if (hit.kind === 'item' || hit.kind === 'music' || hit.kind === 'text') {
      e.preventDefault();
      // Touch long-press is handled by our own pointer logic (popover on release).
      if (e.pointerType === 'touch' || (this._press && this._press.type !== 'mouse')) return;
      if (this._drag) return;
      this._ensureSelected(hit);
      this._openPopoverFor(hit, e.clientX, e.clientY, e.button === -1 || (e.clientX === 0 && e.clientY === 0));
    } else if (this._press && this._press.type !== 'mouse') {
      e.preventDefault();
    }
  }

  _ensureSelected(hit) {
    const sel = this.store.selection || { type: null, ids: [] };
    const type = hit.kind === 'item' ? 'item' : hit.kind;
    if (sel.type === type && sel.ids.includes(hit.id)) return;
    this.store.select(type, [hit.id]);
  }

  // ------------------------------------------------------------------------------- touch (pinch, scroll lock)

  _pinchActive() { return !!this._pinch; }

  _onTouchStart(e) {
    this._touches = e.touches ? e.touches.length : 1;
    if (this._pinch && !this._pinch.pointer && this._touches < 2) this._endPinch(); // missed touchend
    if (e.touches && e.touches.length >= 2 && this._m) {
      const a = e.touches[0], b = e.touches[1];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (d < 10) return;
      if (this._drag) this._cancelDrag();
      if (this._press) { this._disarm(this._press); this._press = null; }
      this._pinch = { pointer: false, d0: d, z0: this._m.zoom };
      if (e.cancelable) e.preventDefault();
    }
  }

  _onTouchMove(e) {
    if (this._pinch && !this._pinch.pointer && e.touches && e.touches.length >= 2) {
      if (e.cancelable) e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (d > 0 && this._pinch.d0 > 0) this._zoomTo(this._pinch.z0 * (d / this._pinch.d0));
      return;
    }
    if ((this._press && this._press.armed) || this._drag || (this._press && this._press.hit.kind === 'playhead')) {
      if (e.cancelable) e.preventDefault();
    }
  }

  _onTouchEnd(e) {
    this._touches = e.touches ? e.touches.length : 0;
    if (this._pinch && !this._pinch.pointer && this._touches < 2) this._endPinch();
    if (this._touches === 0) this._dropStaleLayer();
  }

  _dropStaleLayer() {
    const old = this._staleLayer;
    if (!old) return;
    this._staleLayer = null;
    if (old.parentNode) old.parentNode.removeChild(old);
  }

  _startPointerPinch() {
    if (!this._m) return;
    const pts = [...this._ptrs.values()];
    if (pts.length < 2) return;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (d < 10) return;
    if (this._drag) this._cancelDrag();
    if (this._press) { this._disarm(this._press); this._press = null; }
    this._pinch = { pointer: true, d0: d, z0: this._m.zoom };
  }

  _updatePointerPinch() {
    const pts = [...this._ptrs.values()];
    if (pts.length < 2 || !this._pinch) return;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (d > 0 && this._pinch.d0 > 0) this._zoomTo(this._pinch.z0 * (d / this._pinch.d0));
  }

  _endPinch() {
    this._pinch = null;
    this._ptrs.clear();
    this._schedule();
  }

  // ------------------------------------------------------------------------------- drag & drop

  _startDrag(e) {
    const p = this._press;
    const m = this._m;
    if (!p || !m || this._drag) return;
    const hit = p.hit;
    this._closePopover();
    this._capture(e.pointerId);
    if (hit.kind === 'item') {
      const items = m.items;
      const from = items.findIndex((it) => it.id === hit.id);
      if (from < 0) return;
      const sel = this.store.selection || { type: null, ids: [] };
      if (!(sel.type === 'item' && sel.ids.includes(hit.id))) this.store.select('item', [hit.id]);
      this._drag = { kind: 'item', id: hit.id, from, ins: from, pointerId: e.pointerId, ghost: this._makeGhost(hit.id), cx: e.clientX, cy: e.clientY };
    } else {
      const entry = (hit.kind === 'music' ? m.tl.music : m.tl.texts).find((x) => x.item && x.item.id === hit.id);
      if (!entry) return;
      this.store.select(hit.kind, [hit.id]);
      const tAt = this._timeAtClient(p.x0, p.y0);
      this._drag = {
        kind: hit.kind, id: hit.id, origStart: entry.start, start: entry.start, dur: Math.max(0, entry.end - entry.start),
        grab: tAt - entry.start, pointerId: e.pointerId, cx: e.clientX, cy: e.clientY, ghostEls: [],
      };
    }
    this._disarm(p);
    for (const x of this._els.get(hit.id) || []) x.classList.add('is-dragging');
    vibrate(p.type === 'mouse' ? 0 : 10);
    this._dragMove(e.clientX, e.clientY);
    this._startAutoScroll();
  }

  _makeGhost(id) {
    const m = this._m;
    const els = this._els.get(id) || [];
    const src = els[0];
    const g = el('div', 'sb-ghost');
    const h = Math.round(m.itemH * 0.8);
    let w = h * 1.5;
    if (src) {
      w = Math.min(Math.max(48, parseFloat(src.style.width) || w), 140);
      const img = src.querySelector('img.sb-tile');
      const slate = src.querySelector('.sb-slate');
      if (img) {
        const i2 = document.createElement('img');
        i2.src = img.src;
        i2.alt = '';
        i2.draggable = false;
        g.appendChild(i2);
      } else if (slate) {
        const s = el('div', 'sb-ghost-slate');
        s.style.background = slate.style.background || '#000';
        const tx = slate.querySelector('.sb-slate-text');
        s.textContent = tx ? tx.textContent : '';
        g.appendChild(s);
      }
    }
    g.style.width = `${Math.round(w)}px`;
    g.style.height = `${h}px`;
    g._w = w;
    g._h = h;
    document.body.appendChild(g);
    return g;
  }

  _dragMove(cx, cy) {
    const d = this._drag;
    const m = this._m;
    if (!d || !m) return;
    d.cx = cx;
    d.cy = cy;
    const pt = this._contentPoint(cx, cy);
    if (d.kind === 'item') {
      if (d.ghost) d.ghost.style.transform = `translate3d(${Math.round(cx - d.ghost._w / 2)}px,${Math.round(cy - d.ghost._h - 14)}px,0)`;
      const sx = this._stripXAt(pt.x, pt.y);
      let ins = m.L.insertionIndexAt(sx);
      if (!m.phone && pt.y > this._rowTop(m.rows - 1) + m.rowH + m.rowGap) ins = m.L.n;
      d.ins = ins;
      const bx = ins < m.L.n ? m.L.x0[ins] - m.gap / 2 : m.L.x1[m.L.n - 1] + m.gap / 2;
      let pl = this._place(Math.max(0, bx));
      if (!m.phone && ins < m.L.n && ins > 0 && m.L.x0[ins] % m.W < 1 && m.L.x0[ins] > 0) {
        // Item starts a new row: show the caret after the previous item instead.
        pl = this._place(m.L.x1[ins - 1] + m.gap / 2);
        if (pl.left > m.padL + m.W) pl.left = m.padL + m.W;
      }
      this.caret.hidden = false;
      this.caret.style.height = `${m.itemH + 8}px`;
      this.caret.style.transform = `translate3d(${pl.left}px,${pl.top - 4}px,0)`;
      return;
    }
    // Music / caption bar: horizontal move with snapping.
    const tp = clamp(m.L.xToTime(this._stripXAt(pt.x, pt.y)), 0, Math.max(m.duration, 0) + 3600);
    let start = Math.max(0, tp - d.grab);
    start = this._snap(start, d.dur);
    d.start = start;
    this._drawBarGhost(d);
  }

  _snap(start, dur) {
    const m = this._m;
    const L = m.L;
    const xs = L.timeToX(start);
    const xe = L.timeToX(start + dur);
    let best = start, bestD = SNAP_PX + 0.01;
    const cands = m.bounds.concat([this._lastTime]);
    for (const c of cands) {
      if (!Number.isFinite(c)) continue;
      const xc = L.timeToX(c);
      const d1 = Math.abs(xc - xs);
      if (d1 < bestD) { bestD = d1; best = c; }
      const d2 = Math.abs(xc - xe);
      if (d2 < bestD && c - dur >= 0) { bestD = d2; best = c - dur; }
    }
    return Math.max(0, best);
  }

  _drawBarGhost(d) {
    const m = this._m;
    const lanes = d.kind === 'music' ? m.audioLanes : m.textLanes;
    const lane = lanes.get(d.id) || 0;
    const src = (this._els.get(d.id) || [])[0];
    const cls = src ? src.className.replace(/\bis-(selected|dragging|armed|cont-left|cont-right)\b/g, '').trim() : 'sb-bar';
    const label = src ? (src.querySelector('.sb-bar-label') || {}).textContent || '' : '';
    const xa = m.L.timeToX(d.start);
    const xb = Math.max(xa + 8, m.L.timeToX(d.start + d.dur));
    let i = 0;
    let firstPl = null;
    m.L.spans(xa, xb, (row, rx, pw) => {
      let g = d.ghostEls[i];
      if (!g) {
        g = el('div', '');
        const lb = el('span', 'sb-bar-label');
        g.appendChild(lb);
        this.ghosts.appendChild(g);
        d.ghostEls[i] = g;
      }
      g.className = `${cls} is-ghost`;
      g.firstChild.textContent = pw >= 18 ? label : '';
      const top = d.kind === 'music' ? this._audioTop(row, lane) : this._textTop(row, lane);
      g.style.cssText = `left:${m.padL + rx}px;top:${top}px;width:${pw}px;height:${m.laneH}px;line-height:${m.laneH - 2}px`;
      if (!firstPl) firstPl = { left: m.padL + rx, top };
      i++;
    });
    for (let j = d.ghostEls.length - 1; j >= i; j--) { d.ghostEls[j].remove(); d.ghostEls.length = j; }
    if (firstPl) {
      this.tip.hidden = false;
      this.tip.textContent = `Start: ${formatTime(d.start)}`;
      this.tip.style.left = `${Math.max(0, firstPl.left)}px`;
      this.tip.style.top = `${Math.max(0, firstPl.top - 20)}px`;
    }
  }

  _finishDrag(cx, cy) {
    const d = this._drag;
    if (!d) return;
    if (Number.isFinite(cx)) this._dragMove(cx, cy);
    d.ending = true;
    this._endDragVisuals();
    this._drag = null;
    if (d.kind === 'item') {
      const toIndex = d.ins > d.from ? d.ins - 1 : d.ins;
      if (toIndex !== d.from) this._moveItem(d.id, toIndex);
    } else if (Math.abs(d.start - d.origStart) > 0.004) {
      this._moveTimed(d.kind, d.id, Math.round(d.start * 1000) / 1000);
    }
    this._schedule();
  }

  _cancelDrag() {
    if (!this._drag) return;
    this._drag.ending = true;
    this._endDragVisuals();
    this._drag = null;
    if (this._press) { this._disarm(this._press); this._press = null; }
    this._schedule();
  }

  _endDragVisuals() {
    const d = this._drag;
    if (!d) return;
    this._stopAutoScroll();
    if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
    if (d.ghostEls) d.ghostEls.forEach((g) => g.remove());
    this.caret.hidden = true;
    this.tip.hidden = true;
    for (const x of this._els.get(d.id) || []) x.classList.remove('is-dragging', 'is-armed');
    try { this.scroll.releasePointerCapture(d.pointerId); } catch (_) { /* ignore */ }
  }

  _moveItem(id, toIndex) {
    if (this._hasCommand('moveItem')) { this._run('moveItem', { id, toIndex }); return; }
    // Fallback when the command registry is not available.
    this.store.update((p) => {
      const from = p.items.findIndex((it) => it.id === id);
      if (from < 0) return;
      const [it] = p.items.splice(from, 1);
      p.items.splice(clamp(toIndex, 0, p.items.length), 0, it);
    }, { label: 'Move' });
  }

  _moveTimed(kind, id, start) {
    const name = kind === 'music' ? 'moveMusic' : 'moveText';
    if (this._hasCommand(name)) { this._run(name, { id, start }); return; }
    this.store.update((p) => {
      const coll = kind === 'music' ? p.music : p.texts;
      const o = coll.find((x) => x.id === id);
      if (o) o.start = Math.max(0, start);
    }, { label: 'Move' });
  }

  _startAutoScroll() {
    if (this._autoRaf) return;
    const step = () => {
      this._autoRaf = 0;
      const d = this._drag;
      if (!d) return;
      const sc = this.scroll;
      const r = sc.getBoundingClientRect();
      const edge = this._phone ? 48 : 40;
      let moved = false;
      if (this._phone || (this._m && this._m.phone)) {
        const left = d.cx - r.left, right = r.right - d.cx;
        let v = 0;
        if (left < edge) v = -Math.pow((edge - Math.max(0, left)) / edge, 2) * 18;
        else if (right < edge) v = Math.pow((edge - Math.max(0, right)) / edge, 2) * 18;
        if (v) { const b = sc.scrollLeft; this._progScroll = null; sc.scrollLeft = b + v; moved = sc.scrollLeft !== b; }
      } else {
        const top = d.cy - r.top, bottom = r.bottom - d.cy;
        let v = 0;
        if (top < edge) v = -Math.pow((edge - Math.max(0, top)) / edge, 2) * 16;
        else if (bottom < edge) v = Math.pow((edge - Math.max(0, bottom)) / edge, 2) * 16;
        if (v) { const b = sc.scrollTop; sc.scrollTop = b + v; moved = sc.scrollTop !== b; }
      }
      if (moved) this._dragMove(d.cx, d.cy);
      this._autoRaf = requestAnimationFrame(step);
    };
    this._autoRaf = requestAnimationFrame(step);
  }

  _stopAutoScroll() {
    if (this._autoRaf) cancelAnimationFrame(this._autoRaf);
    this._autoRaf = 0;
  }

  // ------------------------------------------------------------------------------- keyboard

  _onKeyDown(e) {
    const hit = this._hitFromTarget(e.target);
    if (hit.kind !== 'item' && hit.kind !== 'music' && hit.kind !== 'text') return;
    const key = e.key;
    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this._ensureSelected(hit);
      this._openContext({ kind: hit.kind, id: hit.id });
      return;
    }
    if (key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      this._ensureSelected(hit);
      const r = hit.el.getBoundingClientRect();
      this._openPopoverFor(hit, r.left + Math.min(r.width / 2, 40), r.top + r.height / 2, true);
      return;
    }
    if (hit.kind !== 'item') return;
    const items = (this.store.project && this.store.project.items) || [];
    const idx = items.findIndex((it) => it.id === hit.id);
    if (idx < 0) return;
    let next = -1;
    if (key === 'ArrowLeft' || key === 'ArrowUp') next = Math.max(0, idx - 1);
    else if (key === 'ArrowRight' || key === 'ArrowDown') next = Math.min(items.length - 1, idx + 1);
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const id = items[next].id;
    if (e.shiftKey) {
      const anchorId = this._anchorId && items.some((it) => it.id === this._anchorId) ? this._anchorId : hit.id;
      this._anchorId = anchorId;
      const a = items.findIndex((it) => it.id === anchorId);
      const lo = Math.min(a, next), hi = Math.max(a, next);
      this.store.select('item', items.slice(lo, hi + 1).map((it) => it.id));
    } else {
      this._anchorId = id;
      this.store.select('item', [id]);
    }
    const seg = this._m && this._m.tl.segments[next];
    if (seg) this._seek(seg.start + (seg.transitionIn ? seg.transitionIn.duration : 0));
    const f = this._focusEls.get(id);
    if (f) {
      try { f.focus({ preventScroll: true }); } catch (_) { f.focus(); }
      this._revealElement(f);
    }
  }

  _revealElement(node) {
    const sc = this.scroll;
    const r = node.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    if (this._phone) return; // the seek scrolls the strip
    if (r.top < s.top) sc.scrollTop -= (s.top - r.top) + 10;
    else if (r.bottom > s.bottom) sc.scrollTop += (r.bottom - s.bottom) + 10;
  }

  // ------------------------------------------------------------------------------- context actions

  _contextTab(target) {
    if (target.kind === 'music') return 'music';
    if (target.kind === 'text') return 'text';
    const found = this.store.find ? this.store.find(target.id) : null;
    if (found && found.obj && found.obj.kind === 'title') return 'text';
    return 'edit';
  }

  /** Double-click/double-tap/Enter: open the matching contextual ribbon tab (and edit text inline). */
  _openContext(target) {
    const tab = this._contextTab(target);
    try { window.dispatchEvent(new CustomEvent('ribbon-tab', { detail: { tab } })); } catch (_) { /* ignore */ }
    const rb = this.app.ribbon;
    if (rb && typeof rb.activateTab === 'function') {
      const id = tab === 'edit' ? 'ctx-video' : `ctx-${tab}`;
      setTimeout(() => {
        try { if (!rb.activeTab || rb.activeTab !== id) rb.activateTab(id); } catch (_) { /* ignore */ }
      }, 40);
    }
    if (tab === 'text') {
      const pv = this.app.preview;
      if (pv && typeof pv.editText === 'function') {
        try { pv.editText(target.id); } catch (err) { console.warn('[storyboard] inline text editing failed', err); }
      }
    }
  }

  _openPopoverFor(hit, cx, cy, viaKeyboard) {
    if (!hit || !hit.id) return;
    this._closePopover();
    this._ensureSelected(hit);
    // Split works at the playhead: put it where the user pressed (inside the item).
    // (On phones the playhead stays fixed in the middle, so Split uses the current position.)
    if (!viaKeyboard && this._m && !this._m.phone && hit.kind !== 'text') {
      const t = this._timeAtClient(cx, cy);
      if (Number.isFinite(t)) this._seek(t);
    }
    const found = this.store.find ? this.store.find(hit.id) : null;
    const obj = found && found.obj;
    const actions = [];
    const tab = this._contextTab(hit);
    actions.push({ label: 'Edit', icon: tab === 'text' ? 'edit-text' : 'edit', run: () => this._openContext({ kind: hit.kind, id: hit.id }) });
    if (hit.kind === 'item') {
      if (obj && obj.kind === 'video') actions.push({ label: 'Trim', icon: 'trim', cmd: 'trimTool', run: () => this._run('trimTool') });
      actions.push({ label: 'Split', icon: 'split', cmd: 'split', run: () => this._run('split') });
    } else if (hit.kind === 'music') {
      actions.push({ label: 'Split', icon: 'split', cmd: 'musicSplit', run: () => this._run('musicSplit') });
    }
    actions.push({ label: 'Duplicate', icon: 'copy', cmd: 'copy', run: () => { this._run('copy'); this._run('paste'); } });
    actions.push({ label: 'Remove', icon: 'remove', cmd: 'remove', run: () => this._run('remove') });

    const pop = el('div', 'sb-pop', { role: 'menu', 'aria-label': 'Storyboard item actions' });
    for (const a of actions) {
      const b = el('button', 'sb-pop-item', { type: 'button', role: 'menuitem' });
      b.appendChild(iconEl(a.icon, 20));
      const s = el('span');
      s.textContent = a.label;
      b.appendChild(s);
      if (a.cmd && !this._enabled(a.cmd)) b.disabled = true;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._closePopover();
        a.run();
      });
      pop.appendChild(b);
    }
    pop.addEventListener('keydown', (ev) => {
      const btns = [...pop.querySelectorAll('button:not(:disabled)')];
      const i = btns.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); (btns[(i + 1) % btns.length] || btns[0]).focus(); } else if (ev.key === 'ArrowUp') { ev.preventDefault(); (btns[(i - 1 + btns.length) % btns.length] || btns[0]).focus(); } else if (ev.key === 'Tab') { ev.preventDefault(); } else if (ev.key === 'Escape') { ev.preventDefault(); this._closePopover(true); }
      ev.stopPropagation();
    });
    pop.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    document.body.appendChild(pop);
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = clamp(cx - pw / 2, 8, Math.max(8, vw - pw - 8));
    let top = cy - ph - 16;
    if (top < 8) top = Math.min(cy + 18, Math.max(8, vh - ph - 8));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    const returnFocus = viaKeyboard ? document.activeElement : null;
    const onDown = (ev) => { if (!pop.contains(ev.target)) this._closePopover(); };
    const onResize = () => this._closePopover();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
    this._pop = {
      el: pop,
      returnFocus,
      off: () => {
        document.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('blur', onResize);
      },
    };
    if (viaKeyboard) {
      const b = pop.querySelector('button:not(:disabled)');
      if (b) b.focus();
    }
  }

  _closePopover(restoreFocus) {
    const p = this._pop;
    if (!p) return;
    this._pop = null;
    p.off();
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    if (restoreFocus && p.returnFocus && p.returnFocus.isConnected) {
      try { p.returnFocus.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    }
  }
}
