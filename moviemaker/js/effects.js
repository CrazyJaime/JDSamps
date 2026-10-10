// effects.js — visual effects (ctx.filter with GPU-composite / pixel fallbacks),
// brightness, motion fades, mirror/spin transforms and pan & zoom math.
//
// Public contract:
//   supportsCtxFilter() -> boolean
//   applyEffect(ctx, effectId, w, h, { brightness, localT, duration, ... })   post-process region
//   panZoomRect(panZoomId, p, srcW, srcH, dstW, dstH, index, out?) -> {sx,sy,sw,sh}
//
// Additional helpers used by renderer.js / transitions.js / gallery.js:
//   cssFilterFor(effectId, brightness)  draw-time CSS filter string or null
//   applyEffectTransform(ctx, effectId, localT, duration, w, h)
//   drawEffectOverlay(ctx, effectId, localT, duration, w, h)
//   Scratch, deviceRectOf(), drawBlurred(), overrideCtxFilterSupport()

const HAS_DOC = typeof document !== 'undefined' && typeof document.createElement === 'function';
const HAS_OFFSCREEN = typeof OffscreenCanvas === 'function';
const TAU = Math.PI * 2;
const EMPTY = Object.freeze({});

function clamp01(v) { return v <= 0 ? 0 : v >= 1 ? 1 : v; }
function smooth(p) { p = clamp01(p); return p * p * (3 - 2 * p); }

// ---------------------------------------------------------------------------
// Warnings: never spam the console from a 60 fps loop.
const _warned = new Set();
export function warnOnce(key, err) {
  if (_warned.has(key) || _warned.size > 64) return;
  _warned.add(key);
  try { console.warn('[movie maker] ' + key + ':', err && err.message ? err.message : err); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Feature detection

let _filterHtml = null;     // ctx.filter works on <canvas>
let _filterOff = false;     // ctx.filter works on OffscreenCanvas
let _useOffscreen = false;  // scratch canvases may be OffscreenCanvas
let _filterOverride = null; // test hook

function filterWorks(canvas) {
  try {
    const c = canvas.getContext('2d', { willReadFrequently: true });
    // Old Safari: no 'filter' on the prototype; assigning would only create an expando.
    if (!c || !('filter' in c)) return false;
    c.filter = 'blur(1px)';
    if (typeof c.filter !== 'string' || c.filter.indexOf('blur') < 0) return false;
    // Real rendering test: an inverted black fill must come out white.
    c.filter = 'invert(1)';
    c.fillStyle = '#000';
    c.fillRect(0, 0, canvas.width, canvas.height);
    const d = c.getImageData(1, 1, 1, 1).data;
    c.filter = 'none';
    return d[0] > 200 && d[1] > 200 && d[2] > 200;
  } catch (_) {
    return false;
  }
}

function detect() {
  if (_filterHtml !== null) return;
  _filterHtml = false;
  let html = null;
  if (HAS_DOC) {
    try { html = document.createElement('canvas'); html.width = 4; html.height = 4; } catch (_) { html = null; }
  }
  if (html) _filterHtml = filterWorks(html);
  if (HAS_OFFSCREEN) {
    try {
      const oc = new OffscreenCanvas(4, 4);
      const c = oc.getContext('2d');
      if (c && typeof c.drawImage === 'function') {
        _filterOff = filterWorks(oc);
        // Only use OffscreenCanvas scratch layers when they behave like <canvas>.
        _useOffscreen = !html || _filterOff === _filterHtml;
        if (!html) _filterHtml = _filterOff;
      }
    } catch (_) { _useOffscreen = false; }
  }
}

/** True when CanvasRenderingContext2D.filter actually renders (Safari < 18 lacks it). */
export function supportsCtxFilter() {
  if (_filterOverride !== null) return _filterOverride;
  detect();
  return _filterHtml === true;
}

/** Test/diagnostic hook: force ctx.filter support on/off (null = auto-detect). */
export function overrideCtxFilterSupport(value) {
  _filterOverride = value === true || value === false ? value : null;
}

// ---------------------------------------------------------------------------
// Scratch canvases (module-level, reused; never allocated per frame)

function makeCanvas(w, h) {
  detect();
  if (_useOffscreen) {
    try { return new OffscreenCanvas(w, h); } catch (_) { /* fall through */ }
  }
  if (HAS_DOC) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return null;
}

/**
 * A lazily created, reusable scratch canvas.
 *   const s = new Scratch(); const ok = s.ensure(w, h); s.ctx.drawImage(...)
 * exact=true keeps the canvas exactly w×h; exact=false only grows it (callers use a
 * sub-rectangle), which avoids reallocations when sizes vary from frame to frame.
 */
export class Scratch {
  constructor(readback = false) {
    this.readback = readback;
    this.canvas = null;
    this.ctx = null;
    this.failed = false;
  }
  ensure(w, h, exact = true) {
    if (this.failed) return null;
    w = Math.max(1, Math.min(8192, Math.ceil(w)));
    h = Math.max(1, Math.min(8192, Math.ceil(h)));
    if (!this.canvas) {
      try {
        this.canvas = makeCanvas(w, h);
        this.ctx = this.canvas
          ? this.canvas.getContext('2d', this.readback ? { willReadFrequently: true } : undefined)
          : null;
      } catch (err) {
        this.canvas = null; this.ctx = null;
        warnOnce('scratch canvas', err);
      }
      if (!this.ctx) { this.failed = true; this.canvas = null; return null; }
    } else if (exact) {
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    } else if (this.canvas.width < w || this.canvas.height < h) {
      const nw = Math.max(w, this.canvas.width), nh = Math.max(h, this.canvas.height);
      this.canvas.width = nw; this.canvas.height = nh;
    }
    resetCtx(this.ctx);
    return this;
  }
}

/** Reset the drawing state we rely on (does not touch clip/save stack). */
export function resetCtx(c) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  if (supportsCtxFilter() && 'filter' in c) c.filter = 'none';
  c.imageSmoothingEnabled = true;
}

/**
 * Draw the sub-rectangle (0,0,w,h) of a reused scratch canvas scaled up into dst. When
 * enlarging, sampling is inset by half a pixel so bilinear filtering never reads stale
 * pixels lying outside the sub-rectangle.
 */
function drawUp(dst, src, w, h, dx, dy, dw, dh) {
  if (w > 2 && h > 2 && (dw > w || dh > h)) dst.drawImage(src, 0.5, 0.5, w - 1, h - 1, dx, dy, dw, dh);
  else dst.drawImage(src, 0, 0, w, h, dx, dy, dw, dh);
}

// ---------------------------------------------------------------------------
// Device-pixel mapping of a user-space rectangle (handles DPR transforms)

const _dr = { x: 0, y: 0, w: 0, h: 0, sx: 1, sy: 1 };
let _hintScale = 0; // device px per unit supplied by applyEffect(opts.scale) for old browsers

/** Map the user-space rect (x,y,w,h) of ctx to an integer device-pixel rect clamped to the canvas. */
export function deviceRectOf(ctx, x, y, w, h, out = _dr, hintScaleX = 0, hintScaleY = 0) {
  const hx = hintScaleX || _hintScale || 1;
  let a = hx, d = hintScaleY || hx, e = 0, f = 0;
  if (typeof ctx.getTransform === 'function') {
    try { const m = ctx.getTransform(); a = m.a; d = m.d; e = m.e; f = m.f; } catch (_) { /* keep hint */ }
  }
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  let x0 = x * a + e, x1 = (x + w) * a + e, y0 = y * d + f, y1 = (y + h) * d + f;
  if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
  if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(cw, Math.round(x1)); y1 = Math.min(ch, Math.round(y1));
  out.x = x0; out.y = y0; out.w = Math.max(0, x1 - x0); out.h = Math.max(0, y1 - y0);
  out.sx = Math.abs(a) || 1; out.sy = Math.abs(d) || 1;
  return out;
}

// ---------------------------------------------------------------------------
// Color matrices (3×4, offsets in 0..255 units) mirroring the CSS filter functions

function opMatrix(name, v) {
  const m = new Float32Array(12);
  m[0] = m[5] = m[10] = 1;
  let s, c, sn;
  switch (name) {
    case 'grayscale':
      s = 1 - Math.min(1, v);
      m.set([0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s, 0,
        0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s, 0,
        0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s, 0]);
      break;
    case 'sepia':
      s = 1 - Math.min(1, v);
      m.set([0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s, 0,
        0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s, 0,
        0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s, 0]);
      break;
    case 'saturate':
      s = v;
      m.set([0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0,
        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0,
        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0]);
      break;
    case 'hue-rotate':
      c = Math.cos(v * Math.PI / 180); sn = Math.sin(v * Math.PI / 180);
      m.set([0.213 + c * 0.787 - sn * 0.213, 0.715 - c * 0.715 - sn * 0.715, 0.072 - c * 0.072 + sn * 0.928, 0,
        0.213 - c * 0.213 + sn * 0.143, 0.715 + c * 0.285 + sn * 0.140, 0.072 - c * 0.072 - sn * 0.283, 0,
        0.213 - c * 0.213 - sn * 0.787, 0.715 - c * 0.715 + sn * 0.715, 0.072 + c * 0.928 + sn * 0.072, 0]);
      break;
    case 'brightness':
      m[0] = m[5] = m[10] = v;
      break;
    case 'contrast':
      m[0] = m[5] = m[10] = v;
      m[3] = m[7] = m[11] = (0.5 - 0.5 * v) * 255;
      break;
    case 'invert':
      s = Math.min(1, v);
      m[0] = m[5] = m[10] = 1 - 2 * s;
      m[3] = m[7] = m[11] = s * 255;
      break;
    default:
      break;
  }
  return m;
}

/** out = a ∘ b  (b applied first). */
function matMul(a, b) {
  const out = new Float32Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j];
    }
    out[i * 4 + 3] = a[i * 4] * b[3] + a[i * 4 + 1] * b[7] + a[i * 4 + 2] * b[11] + a[i * 4 + 3];
  }
  return out;
}

function compileOps(ops) {
  let m = opMatrix('none', 0);
  let css = '';
  for (const [name, v] of ops) {
    m = matMul(opMatrix(name, v), m);
    css += (css ? ' ' : '') + name + '(' + (name === 'hue-rotate' ? v + 'deg' : v) + ')';
  }
  return { matrix: m, css };
}

function grayMatrix(wr, wg, wb, contrast = 1) {
  const m = new Float32Array(12);
  for (let i = 0; i < 3; i++) {
    m[i * 4] = wr * contrast; m[i * 4 + 1] = wg * contrast; m[i * 4 + 2] = wb * contrast;
    m[i * 4 + 3] = (0.5 - 0.5 * contrast) * 255;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Effect definitions

function matrixDef(ops, extra) {
  const { matrix, css } = compileOps(ops);
  return Object.assign({ kind: 'matrix', matrix, css }, extra || null);
}

const DEFS = {
  none: { kind: 'none' },
  // Black and white
  bw: matrixDef([['grayscale', 1]]),
  'bw-orange': { kind: 'matrix', matrix: grayMatrix(0.50, 0.42, 0.08, 1.06), css: null },
  'bw-red': { kind: 'matrix', matrix: grayMatrix(0.70, 0.28, 0.02, 1.14), css: null },
  'bw-yellow': { kind: 'matrix', matrix: grayMatrix(0.36, 0.56, 0.08, 1.03), css: null },
  sepia: matrixDef([['sepia', 1]]),
  cyan: matrixDef([['grayscale', 1], ['sepia', 1], ['hue-rotate', 150], ['saturate', 1.6]]),
  threshold: { kind: 'pixel', fn: 'threshold' },
  // Artistic
  invert: matrixDef([['invert', 1]]),
  posterize: { kind: 'pixel', fn: 'posterize' },
  edge: { kind: 'pixel', fn: 'edge' },
  emboss: { kind: 'pixel', fn: 'emboss' },
  pixelate: { kind: 'pixelate' },
  // Cinematic
  blur: { kind: 'blur' },
  warm: matrixDef([['sepia', 0.32], ['saturate', 1.35], ['brightness', 1.04]]),
  cool: matrixDef([['hue-rotate', 180], ['sepia', 0.3], ['hue-rotate', -180], ['saturate', 1.1], ['brightness', 1.02]]),
  vivid: matrixDef([['saturate', 1.7], ['contrast', 1.08]]),
  vintage: matrixDef([['sepia', 0.55], ['contrast', 0.86], ['brightness', 1.07], ['saturate', 0.85]], { vignette: 0.55 }),
  'film-age': matrixDef([['sepia', 0.85], ['contrast', 1.12], ['brightness', 0.97]], { vignette: 0.75, film: true }),
  // Motions and fades
  'fade-in-black': { kind: 'fade', color: '#000000', dir: 'in' },
  'fade-out-black': { kind: 'fade', color: '#000000', dir: 'out' },
  'fade-in-white': { kind: 'fade', color: '#ffffff', dir: 'in' },
  'fade-out-white': { kind: 'fade', color: '#ffffff', dir: 'out' },
  'spin-360': { kind: 'transform', t: 'spin' },
  'ease-in': { kind: 'transform', t: 'ease-in' },
  'ease-out': { kind: 'transform', t: 'ease-out' },
  // Mirror
  'mirror-h': { kind: 'transform', t: 'mirror-h' },
  'mirror-v': { kind: 'transform', t: 'mirror-v' },
};

/** Effect kind: 'none'|'matrix'|'pixel'|'blur'|'pixelate'|'fade'|'transform'. Unknown ids → 'none'. */
export function effectKind(effectId) {
  const d = DEFS[effectId];
  return d ? d.kind : 'none';
}

/** Max duration of a motion fade (seconds). */
export const FADE_MAX = 1.5;

/** WLMM brightness (-100..100) → multiplicative factor (0.15..2). */
export function brightnessFactor(b) {
  b = +b || 0;
  if (b > 100) b = 100; else if (b < -100) b = -100;
  return b >= 0 ? 1 + b / 100 : 1 + (b / 100) * 0.85;
}

function fmt(n) { return Math.round(n * 1000) / 1000; }

/**
 * CSS filter string that can be applied while drawing the source, when ctx.filter is
 * supported and the effect + brightness are fully expressible as CSS filters.
 * Returns null otherwise (callers then post-process with applyEffect()).
 */
export function cssFilterFor(effectId, brightness = 0) {
  if (!supportsCtxFilter()) return null;
  const d = DEFS[effectId] || DEFS.none;
  const k = brightnessFactor(brightness);
  if (d.kind === 'matrix') {
    if (!d.css) return null;
    return k === 1 ? d.css : d.css + ' brightness(' + fmt(k) + ')';
  }
  if (d.kind === 'none' || d.kind === 'fade' || d.kind === 'transform') {
    return k === 1 ? null : 'brightness(' + fmt(k) + ')';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transform effects (mirror, spin, ease) — applied as a ctx transform before drawing

/** Apply the effect's geometric transform to ctx (frame 0..w × 0..h). Returns true when one was applied. */
export function applyEffectTransform(ctx, effectId, localT, duration, w, h) {
  const d = DEFS[effectId];
  if (!d || d.kind !== 'transform') return false;
  setTransformFor(ctx, d.t, duration > 0 ? clamp01(localT / duration) : 0, 0, 0, w, h);
  return true;
}

function setTransformFor(ctx, t, p, x, y, w, h) {
  const cx = x + w / 2, cy = y + h / 2;
  switch (t) {
    case 'mirror-h':
      ctx.translate(2 * cx, 0); ctx.scale(-1, 1);
      break;
    case 'mirror-v':
      ctx.translate(0, 2 * cy); ctx.scale(1, -1);
      break;
    case 'spin': {
      const s = 1 - 0.3 * Math.sin(Math.PI * p);
      ctx.translate(cx, cy); ctx.rotate(TAU * smooth(p)); ctx.scale(s, s); ctx.translate(-cx, -cy);
      break;
    }
    case 'ease-in': {
      const s = 1 + 0.22 * smooth(p);
      ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
      break;
    }
    case 'ease-out': {
      const s = 1.22 - 0.22 * smooth(p);
      ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Overlays: motion fades

/** Draw the time-based overlay part of an effect (fades) over the user-space rect. */
export function drawEffectOverlay(ctx, effectId, localT, duration, w, h, x = 0, y = 0) {
  const d = DEFS[effectId];
  if (!d || d.kind !== 'fade') return;
  const dur = duration > 0 ? duration : 1;
  const fd = Math.max(0.05, Math.min(FADE_MAX, dur * 0.5));
  const a = d.dir === 'in'
    ? 1 - smooth(localT / fd)
    : smooth((localT - (dur - fd)) / fd);
  if (a <= 0.002) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha *= Math.min(1, a);
  ctx.fillStyle = d.color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Region post-processing building blocks

const _proc = new Scratch(true);
const _copy = new Scratch(false);
const _chainA = new Scratch(false);
const _chainB = new Scratch(false);

/** Copy a device-pixel rect of ctx's canvas into the _copy scratch (top-left aligned). */
function copyRegion(ctx, dr) {
  const s = _copy.ensure(dr.w, dr.h, false);
  if (!s) return null;
  s.ctx.drawImage(ctx.canvas, dr.x, dr.y, dr.w, dr.h, 0, 0, dr.w, dr.h);
  return s;
}

function beginDevice(ctx, dr) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (supportsCtxFilter()) ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
  ctx.beginPath();
  ctx.rect(dr.x, dr.y, dr.w, dr.h);
  ctx.clip();
}

/** Re-draw the region through a CSS filter (requires ctx.filter support). */
function filterRegion(ctx, x, y, w, h, filter) {
  const dr = deviceRectOf(ctx, x, y, w, h);
  if (dr.w < 1 || dr.h < 1) return;
  const s = copyRegion(ctx, dr);
  if (!s) return;
  beginDevice(ctx, dr);
  ctx.filter = filter;
  ctx.drawImage(s.canvas, 0, 0, dr.w, dr.h, dr.x, dr.y, dr.w, dr.h);
  ctx.restore();
}

/**
 * Downscale (src sub-rect) to tw×th through successive halvings (box filtering).
 * Returns the scratch holding the result at (0,0,tw,th).
 */
function downscaleChain(src, sx, sy, sw, sh, tw, th) {
  tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
  const needW = Math.max(Math.ceil(sw / 2), tw) + 2, needH = Math.max(Math.ceil(sh / 2), th) + 2;
  if (!_chainA.ensure(needW, needH, false) || !_chainB.ensure(needW, needH, false)) return null;
  let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
  let target = _chainA;
  let last = null;
  for (let guard = 0; guard < 16; guard++) {
    const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
    if (nw >= cw && nh >= ch && last) break;
    const fw = Math.min(nw, cw), fh = Math.min(nh, ch);
    target.ctx.imageSmoothingEnabled = true;
    target.ctx.drawImage(cur, cx, cy, cw, ch, 0, 0, fw, fh);
    last = target; cur = target.canvas; cx = 0; cy = 0; cw = fw; ch = fh;
    target = target === _chainA ? _chainB : _chainA;
    if (cw <= tw && ch <= th) break;
  }
  _chainResult.s = last; _chainResult.w = cw; _chainResult.h = ch;
  _chainResult.other = last === _chainA ? _chainB : _chainA;
  return _chainResult;
}
const _chainResult = { s: null, w: 0, h: 0, other: null };

/**
 * Box-filtered downscale of (src sub-rect) to about tw×th pixels. Returns
 * { canvas, w, h } (a shared, reused result object; the image is at (0,0,w,h)) or null.
 */
export function downscaleTo(src, sx, sy, sw, sh, tw, th) {
  const r = downscaleChain(src, sx, sy, sw, sh, tw, th);
  if (!r || !r.s) return null;
  _downResult.canvas = r.s.canvas; _downResult.w = r.w; _downResult.h = r.h;
  return _downResult;
}
const _downResult = { canvas: null, w: 0, h: 0 };

/** Scale of ctx's current transform (device pixels per user unit), 1 if unknown. */
export function ctxScaleOf(ctx) {
  if (ctx && typeof ctx.getTransform === 'function') {
    try { const m = ctx.getTransform(); return Math.hypot(m.a, m.b) || 1; } catch (_) { /* ignore */ }
  }
  return 1;
}

/**
 * Draw a blurred copy of (src sub-rect) into ctx's device rect. ctx must be in device
 * space (identity transform). radius is in device pixels. Uses ctx.filter when it is
 * supported, otherwise a multi-step downscale/upscale blur (GPU, no pixel readback).
 */
export function drawBlurred(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh, radius) {
  if (!(radius >= 0.75)) { ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh); return; }
  if (supportsCtxFilter()) {
    // Sharp copy underneath so the transparent fringe of the blur does not darken edges.
    const prev = ctx.filter;
    ctx.filter = 'none';
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.filter = 'blur(' + fmt(radius) + 'px)';
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.filter = prev;
    return;
  }
  const f = Math.max(1.5, Math.min(48, radius * 0.9));
  const r = downscaleChain(src, sx, sy, sw, sh, sw / f, sh / f);
  if (!r) { ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh); return; }
  let cur = r.s.canvas, cw = r.w, ch = r.h;
  // One intermediate upscale step smooths the bilinear "tent" pattern.
  if (cw * 3 < dw && r.other) {
    const uw = Math.min(r.other.canvas.width - 1, cw * 3), uh = Math.min(r.other.canvas.height - 1, ch * 3);
    if (uw > cw && uh > ch) {
      r.other.ctx.imageSmoothingEnabled = true;
      drawUp(r.other.ctx, cur, cw, ch, 0, 0, uw, uh);
      cur = r.other.canvas; cw = uw; ch = uh;
    }
  }
  ctx.imageSmoothingEnabled = true;
  drawUp(ctx, cur, cw, ch, dx, dy, dw, dh);
}

function blurRegion(ctx, x, y, w, h) {
  const dr = deviceRectOf(ctx, x, y, w, h);
  if (dr.w < 2 || dr.h < 2) return;
  const s = copyRegion(ctx, dr);
  if (!s) return;
  const radius = Math.max(1.5, Math.min(dr.w, dr.h) * 0.012);
  beginDevice(ctx, dr);
  drawBlurred(ctx, s.canvas, 0, 0, dr.w, dr.h, dr.x, dr.y, dr.w, dr.h, radius);
  ctx.restore();
}

function pixelateRegion(ctx, x, y, w, h) {
  const dr = deviceRectOf(ctx, x, y, w, h);
  if (dr.w < 2 || dr.h < 2) return;
  const block = Math.max(2, Math.round(Math.min(dr.w, dr.h) / 36));
  const tw = Math.max(1, Math.round(dr.w / block)), th = Math.max(1, Math.round(dr.h / block));
  const s = copyRegion(ctx, dr);
  if (!s) return;
  const r = downscaleChain(s.canvas, 0, 0, dr.w, dr.h, tw, th);
  if (!r) return;
  beginDevice(ctx, dr);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(r.s.canvas, 0, 0, r.w, r.h, dr.x, dr.y, dr.w, dr.h);
  ctx.restore();
}

/** Multiplicative brightness via blend modes (works without ctx.filter, no readback). */
function brightnessComposite(ctx, x, y, w, h, k) {
  if (k === 1) return;
  ctx.save();
  if (k < 1) {
    ctx.globalCompositeOperation = 'multiply';
    if (ctx.globalCompositeOperation !== 'multiply') { ctx.restore(); return; }
    const v = Math.round(Math.max(0, k) * 255);
    ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
  } else {
    // color-dodge: Cb / (1 - Cs)  →  Cs = 1 - 1/k gives Cb * k
    ctx.globalCompositeOperation = 'color-dodge';
    if (ctx.globalCompositeOperation !== 'color-dodge') { ctx.restore(); return; }
    const v = Math.round((1 - 1 / k) * 255);
    ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
  }
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// --- pixel (getImageData) path -------------------------------------------------

let _lum = new Uint8Array(0);
const _mtmp = new Float32Array(12);
const _lut = new Uint8ClampedArray(256);

function pxMatrix(d, m) {
  const a0 = m[0], a1 = m[1], a2 = m[2], a3 = m[3];
  const b0 = m[4], b1 = m[5], b2 = m[6], b3 = m[7];
  const c0 = m[8], c1 = m[9], c2 = m[10], c3 = m[11];
  for (let i = 0, n = d.length; i < n; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = a0 * r + a1 * g + a2 * b + a3;
    d[i + 1] = b0 * r + b1 * g + b2 * b + b3;
    d[i + 2] = c0 * r + c1 * g + c2 * b + c3;
  }
}

function pxPosterize(d, k) {
  const levels = 4, step = 255 / (levels - 1);
  for (let v = 0; v < 256; v++) _lut[v] = Math.round(Math.min(255, v * k) / step) * step;
  for (let i = 0, n = d.length; i < n; i += 4) {
    d[i] = _lut[d[i]]; d[i + 1] = _lut[d[i + 1]]; d[i + 2] = _lut[d[i + 2]];
  }
}

function pxThreshold(d, k) {
  const t = 128 / k;
  for (let i = 0, n = d.length; i < n; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = l >= t ? 255 : 0;
    d[i] = v; d[i + 1] = v; d[i + 2] = v;
  }
}

function fillLum(d, n, k) {
  if (_lum.length < n) _lum = new Uint8Array(n);
  const L = _lum;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * k;
    L[j] = l > 255 ? 255 : l;
  }
  return L;
}

function pxEdge(d, w, h, k) {
  const L = fillLum(d, w * h, k);
  const gain = 1.6 / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { d[o] = d[o + 1] = d[o + 2] = 0; continue; }
      const tl = L[i - w - 1], t = L[i - w], tr = L[i - w + 1];
      const l = L[i - 1], r = L[i + 1];
      const bl = L[i + w - 1], b = L[i + w], br = L[i + w + 1];
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let v = Math.sqrt(gx * gx + gy * gy) * gain;
      if (v > 1) v = 1;
      d[o] = v * (70 + 0.85 * d[o]);
      d[o + 1] = v * (70 + 0.85 * d[o + 1]);
      d[o + 2] = v * (70 + 0.85 * d[o + 2]);
    }
  }
}

function pxEmboss(d, w, h, k) {
  const L = fillLum(d, w * h, k);
  const off = Math.max(1, Math.round(Math.min(w, h) / 360));
  const dd = off * w + off;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = i - dd, b = i + dd;
    const va = a >= 0 ? L[a] : L[i], vb = b < n ? L[b] : L[i];
    const v = 128 + (va - vb) * 2.2;
    const o = i * 4;
    d[o] = d[o + 1] = d[o + 2] = v;
  }
}

function pixelRegion(ctx, x, y, w, h, def, k, quality) {
  const dr = deviceRectOf(ctx, x, y, w, h);
  if (dr.w < 3 || dr.h < 3) return;
  const neighborhood = def.fn === 'edge' || def.fn === 'emboss';
  // Caps keep real-time export smooth on phones (pixel work is CPU-bound there).
  const maxSide = neighborhood ? (quality === 'preview' ? 560 : 960) : (quality === 'preview' ? 720 : 1280);
  const scale = Math.min(1, maxSide / Math.max(dr.w, dr.h));
  const pw = Math.max(3, Math.round(dr.w * scale)), ph = Math.max(3, Math.round(dr.h * scale));
  const s = _proc.ensure(pw + 1, ph + 1, false);
  if (!s) return;
  let img;
  try {
    s.ctx.imageSmoothingEnabled = true;
    s.ctx.drawImage(ctx.canvas, dr.x, dr.y, dr.w, dr.h, 0, 0, pw, ph);
    img = s.ctx.getImageData(0, 0, pw, ph);
  } catch (err) {
    warnOnce('pixel effect (canvas not readable)', err);
    return;
  }
  const d = img.data;
  if (def.kind === 'matrix') {
    const m = def.matrix;
    for (let i = 0; i < 12; i++) _mtmp[i] = m[i] * k;
    pxMatrix(d, _mtmp);
  } else if (def.fn === 'posterize') pxPosterize(d, k);
  else if (def.fn === 'threshold') pxThreshold(d, k);
  else if (def.fn === 'edge') pxEdge(d, pw, ph, k);
  else if (def.fn === 'emboss') pxEmboss(d, pw, ph, k);
  s.ctx.putImageData(img, 0, 0);
  beginDevice(ctx, dr);
  drawUp(ctx, s.canvas, pw, ph, dr.x, dr.y, dr.w, dr.h);
  ctx.restore();
}

// --- looks: vignette and old film -------------------------------------------------

const _vigCache = new WeakMap();
function vignetteGradient(ctx, strength) {
  let m = _vigCache.get(ctx);
  if (!m) { m = new Map(); _vigCache.set(ctx, m); }
  let g = m.get(strength);
  if (!g) {
    g = ctx.createRadialGradient(0, 0, 0.45, 0, 0, 1.45);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, 'rgba(0,0,0,' + fmt(strength * 0.35) + ')');
    g.addColorStop(1, 'rgba(0,0,0,' + fmt(strength) + ')');
    m.set(strength, g);
  }
  return g;
}

function vignette(ctx, x, y, w, h, strength) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(w / 2, h / 2);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = vignetteGradient(ctx, strength);
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

function hash01(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function filmAge(ctx, x, y, w, h, localT) {
  const frame = Math.floor(localT * 12);
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.globalCompositeOperation = 'source-over';
  // flicker
  ctx.globalAlpha = 0.03 + 0.09 * hash01(frame * 3 + 1);
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);
  // scratches
  const lw = Math.max(1, w / 700);
  const count = hash01(frame * 5 + 2) < 0.55 ? 1 : 2;
  ctx.strokeStyle = '#f2ead8';
  ctx.lineWidth = lw;
  for (let i = 0; i < count; i++) {
    const sx = x + w * hash01(frame * 7 + i * 13 + 3);
    ctx.globalAlpha = 0.18 + 0.25 * hash01(frame * 11 + i);
    ctx.beginPath();
    ctx.moveTo(sx, y);
    ctx.lineTo(sx + (hash01(frame + i * 17) - 0.5) * w * 0.01, y + h);
    ctx.stroke();
  }
  // dust specks
  ctx.fillStyle = '#1a140c';
  for (let i = 0; i < 5; i++) {
    if (hash01(frame * 19 + i * 3) < 0.45) continue;
    const px = x + w * hash01(frame * 23 + i * 7);
    const py = y + h * hash01(frame * 29 + i * 11);
    const r = Math.max(0.8, Math.min(w, h) * (0.002 + 0.004 * hash01(frame * 31 + i)));
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// --- transform as post-process (only used by standalone applyEffect callers) ------

function transformRegion(ctx, def, localT, duration, x, y, w, h) {
  const dr = deviceRectOf(ctx, x, y, w, h);
  if (dr.w < 1 || dr.h < 1) return;
  const s = copyRegion(ctx, dr);
  if (!s) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);
  setTransformFor(ctx, def.t, duration > 0 ? clamp01(localT / duration) : 0, x, y, w, h);
  ctx.drawImage(s.canvas, 0, 0, dr.w, dr.h, x, y, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Public: applyEffect

/**
 * Post-process the user-space region (opts.x|0, opts.y|0, w, h) of ctx.
 * opts: { brightness=0, localT=0, duration=1, quality='export'|'preview', x=0, y=0,
 *         colorDone=false  (color/brightness already applied with cssFilterFor()),
 *         scale  (device px per user unit; only needed where ctx.getTransform is missing),
 *         transforms=true, color=true, overlay=true }
 * The region should be in the ctx's base (non-rotated) coordinate space.
 */
export function applyEffect(ctx, effectId, w, h, opts) {
  if (!ctx || !(w > 0) || !(h > 0)) return;
  const o = opts || EMPTY;
  const def = DEFS[effectId] || DEFS.none;
  const x = +o.x || 0, y = +o.y || 0;
  const duration = o.duration > 0 ? +o.duration : 1;
  let localT = +o.localT || 0;
  if (localT < 0) localT = 0; else if (localT > duration) localT = duration;
  const quality = o.quality === 'preview' ? 'preview' : 'export';
  const k = o.colorDone ? 1 : brightnessFactor(o.brightness);
  _hintScale = o.scale > 0 ? +o.scale : 0;
  ctx.save();
  try {
    if (o.transforms !== false && def.kind === 'transform') transformRegion(ctx, def, localT, duration, x, y, w, h);
    if (o.color !== false) {
      switch (def.kind) {
        case 'matrix':
          if (!o.colorDone) {
            if (def.css && supportsCtxFilter()) filterRegion(ctx, x, y, w, h, k === 1 ? def.css : def.css + ' brightness(' + fmt(k) + ')');
            else pixelRegion(ctx, x, y, w, h, def, k, quality);
          }
          if (def.vignette) vignette(ctx, x, y, w, h, def.vignette);
          if (def.film) filmAge(ctx, x, y, w, h, localT);
          break;
        case 'pixel':
          pixelRegion(ctx, x, y, w, h, def, k, quality);
          break;
        case 'blur':
          blurRegion(ctx, x, y, w, h);
          brightnessComposite(ctx, x, y, w, h, k);
          break;
        case 'pixelate':
          pixelateRegion(ctx, x, y, w, h);
          brightnessComposite(ctx, x, y, w, h, k);
          break;
        default:
          brightnessComposite(ctx, x, y, w, h, k);
          break;
      }
    }
    if (o.overlay !== false) drawEffectOverlay(ctx, effectId, localT, duration, w, h, x, y);
  } catch (err) {
    warnOnce('effect ' + effectId, err);
  } finally {
    _hintScale = 0;
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pan & zoom

const ZMAX = 1.25;
const PAN_Z = 1.2;
// z0→z1 zoom factor, (ax, ay) anchors 0..1 inside the slack area, from → to
const PZ = {
  none: [1, 1, 0.5, 0.5, 0.5, 0.5],
  'zoom-in': [1, ZMAX, 0.5, 0.5, 0.5, 0.5],
  'zoom-out': [ZMAX, 1, 0.5, 0.5, 0.5, 0.5],
  'zoom-in-left': [1, ZMAX, 0, 0.5, 0, 0.5],
  'zoom-in-right': [1, ZMAX, 1, 0.5, 1, 0.5],
  'zoom-in-top': [1, ZMAX, 0.5, 0, 0.5, 0],
  'zoom-in-bottom': [1, ZMAX, 0.5, 1, 0.5, 1],
  'zoom-out-left': [ZMAX, 1, 0, 0.5, 0, 0.5],
  'zoom-out-right': [ZMAX, 1, 1, 0.5, 1, 0.5],
  'zoom-out-top': [ZMAX, 1, 0.5, 0, 0.5, 0],
  'zoom-out-bottom': [ZMAX, 1, 0.5, 1, 0.5, 1],
  'pan-left': [PAN_Z, PAN_Z, 1, 0.5, 0, 0.5],
  'pan-right': [PAN_Z, PAN_Z, 0, 0.5, 1, 0.5],
  'pan-up': [PAN_Z, PAN_Z, 0.5, 1, 0.5, 0],
  'pan-down': [PAN_Z, PAN_Z, 0.5, 0, 0.5, 1],
};
const AUTO_VARIANTS = ['zoom-in', 'pan-right', 'zoom-out-left', 'pan-left', 'zoom-in-right',
  'pan-down', 'zoom-out', 'zoom-in-left', 'pan-up', 'zoom-out-right', 'zoom-in-top', 'zoom-out-bottom'];

/** Resolve 'auto' to the concrete variant used for storyboard item `index`. */
export function resolvePanZoom(panZoomId, index = 0) {
  if (panZoomId === 'auto') {
    const i = Math.abs(Math.floor(+index || 0)) % AUTO_VARIANTS.length;
    return AUTO_VARIANTS[i];
  }
  return PZ[panZoomId] ? panZoomId : 'none';
}

/**
 * Source crop rectangle for pan & zoom at progress p (0..1). The crop always has the
 * aspect ratio dstW/dstH and lies inside the source (srcW×srcH). With dst equal to the
 * "contain" rectangle of the source, zoom 1 shows the entire source.
 */
export function panZoomRect(panZoomId, p, srcW, srcH, dstW, dstH, index = 0, out) {
  const r = out || { sx: 0, sy: 0, sw: 0, sh: 0 };
  srcW = +srcW || 0; srcH = +srcH || 0;
  if (!(srcW > 0 && srcH > 0)) { r.sx = 0; r.sy = 0; r.sw = srcW; r.sh = srcH; return r; }
  const aspect = dstW > 0 && dstH > 0 ? dstW / dstH : srcW / srcH;
  let bw = srcW, bh = srcW / aspect;
  if (bh > srcH) { bh = srcH; bw = srcH * aspect; }
  const bx = (srcW - bw) / 2, by = (srcH - bh) / 2;
  const v = PZ[resolvePanZoom(panZoomId, index)];
  const q = clamp01(+p || 0);
  const z = v[0] + (v[1] - v[0]) * q;
  const ax = v[2] + (v[4] - v[2]) * q;
  const ay = v[3] + (v[5] - v[3]) * q;
  const cw = bw / z, ch = bh / z;
  r.sx = bx + (bw - cw) * ax;
  r.sy = by + (bh - ch) * ay;
  r.sw = cw;
  r.sh = ch;
  return r;
}
