// transitions.js — transition drawing.
//
// Contract:
//   drawTransition(ctx, type, p /*0..1*/, drawFrom(ctx), drawTo(ctx), w, h, opts?)
// drawFrom / drawTo each draw a complete, opaque w×h frame into the ctx they are given
// (honouring its current transform, clip and globalAlpha). opts (optional):
//   { from: CanvasImageSource, to: CanvasImageSource }  pre-rendered frames (same
//   content as the callbacks, any pixel size) — used by pixel-based transitions
//   (pixelate, blur, shatter) to avoid re-rendering. Without them those transitions
//   render the callbacks into internal scratch layers.
// Unknown types fall back to a crossfade. Nothing here allocates per frame except
// the occasional CanvasGradient.

import { Scratch, deviceRectOf, drawBlurred, downscaleTo, ctxScaleOf, warnOnce } from './effects.js';

const TAU = Math.PI * 2;
const EMPTY = Object.freeze({});

function clamp01(v) { return v <= 0 ? 0 : v >= 1 ? 1 : v; }
function smooth(p) { p = clamp01(p); return p * p * (3 - 2 * p); }
function easeInOut(p) { p = clamp01(p); return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
function easeIn(p) { p = clamp01(p); return p * p; }
function noop() { /* nothing */ }

function full(ctx, fn) { ctx.save(); fn(ctx); ctx.restore(); }

function fillAlpha(ctx, color, alpha, w, h) {
  if (alpha <= 0.002) return;
  ctx.save();
  ctx.globalAlpha *= Math.min(1, alpha);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Generic shape reveal: B appears inside a growing shape (or A shrinks inside one).

function reveal(ctx, A, B, pathFn, e, w, h) {
  if (e <= 0) { full(ctx, A); return; }
  if (e >= 1) { full(ctx, B); return; }
  full(ctx, A);
  ctx.save();
  ctx.beginPath();
  pathFn(ctx, e, w, h);
  ctx.clip();
  B(ctx);
  ctx.restore();
}

function shrink(ctx, A, B, pathFn, e, w, h) {
  if (e <= 0) { full(ctx, A); return; }
  if (e >= 1) { full(ctx, B); return; }
  full(ctx, B);
  ctx.save();
  ctx.beginPath();
  pathFn(ctx, 1 - e, w, h);
  ctx.clip();
  A(ctx);
  ctx.restore();
}

// --- path builders (module-level functions: no closures per frame) -----------------

function circlePath(ctx, e, w, h) {
  ctx.arc(w / 2, h / 2, Math.max(0.01, e * Math.hypot(w, h) / 2 * 1.02), 0, TAU);
}

function diamondPath(ctx, e, w, h) {
  const cx = w / 2, cy = h / 2, rx = e * w * 1.02, ry = e * h * 1.02;
  ctx.moveTo(cx, cy - ry); ctx.lineTo(cx + rx, cy); ctx.lineTo(cx, cy + ry); ctx.lineTo(cx - rx, cy); ctx.closePath();
}

const HEART = (() => {
  const n = 72, pts = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU, s = Math.sin(t);
    const x = 16 * s * s * s;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    pts[i * 2] = x / 17; pts[i * 2 + 1] = (y - 2.5) / 17;
  }
  return pts;
})();

function heartPath(ctx, e, w, h) {
  const s = e * 2.5 * Math.hypot(w, h) / 2, cx = w / 2, cy = h / 2;
  for (let i = 0; i < HEART.length; i += 2) {
    const x = cx + HEART[i] * s, y = cy + HEART[i + 1] * s;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function starPath(ctx, e, w, h) {
  const ro = e * 2.25 * Math.hypot(w, h) / 2, ri = ro * 0.5, cx = w / 2, cy = h / 2;
  const rot = -Math.PI / 2 + e * 0.6;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro, a = rot + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function crossPath(ctx, e, w, h) {
  ctx.rect(0, h / 2 - (e * h) / 2, w, e * h);
  ctx.rect(w / 2 - (e * w) / 2, 0, e * w, h);
}

function splitHPath(ctx, e, w, h) { ctx.rect(0, h / 2 - (e * h) / 2, w, e * h); }
function splitVPath(ctx, e, w, h) { ctx.rect(w / 2 - (e * w) / 2, 0, e * w, h); }
function diagBoxPath(ctx, e, w, h) { ctx.rect(0, 0, e * w, e * h); }

function clockPath(ctx, e, w, h) {
  const cx = w / 2, cy = h / 2, R = Math.hypot(w, h);
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + TAU * e);
  ctx.closePath();
}

function wheelPath(ctx, e, w, h) {
  const cx = w / 2, cy = h / 2, R = Math.hypot(w, h);
  for (let k = 0; k < 4; k++) {
    const a0 = -Math.PI / 2 + (k * Math.PI) / 2;
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0, a0 + (Math.PI / 2) * e);
    ctx.closePath();
  }
}

function fanPath(ctx, e, w, h) {
  const cx = w / 2, R = Math.hypot(w / 2, h) * 1.05;
  ctx.moveTo(cx, h);
  ctx.arc(cx, h, R, Math.PI, Math.PI + Math.PI * e);
  ctx.closePath();
}

function blindsHPath(ctx, e, w, h) {
  const n = 8, sh = h / n;
  for (let i = 0; i < n; i++) ctx.rect(0, i * sh, w, sh * e);
}

function blindsVPath(ctx, e, w, h) {
  const n = 10, sw = w / n;
  for (let i = 0; i < n; i++) ctx.rect(i * sw, 0, sw * e, h);
}

function checkerPath(ctx, e, w, h) {
  const cols = 8, rows = Math.max(2, Math.round((cols * h) / w));
  const cw = w / cols, ch = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const phase = (r + c) % 2;
      const q = clamp01((e - phase * 0.4) / 0.6);
      if (q > 0) ctx.rect(c * cw, r * ch, cw * q, ch);
    }
  }
}

function circlesPath(ctx, e, w, h) {
  const cols = 8, rows = Math.max(2, Math.round((cols * h) / w));
  const cw = w / cols, ch = h / rows, R = (Math.hypot(cw, ch) / 2) * 1.04;
  const maxD = Math.hypot(0.5, 0.5);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nx = (c + 0.5) / cols - 0.5, ny = (r + 0.5) / rows - 0.5;
      const d = Math.hypot(nx, ny) / maxD;
      const q = clamp01(e * 1.6 - d * 0.6);
      if (q <= 0) continue;
      const x = (c + 0.5) * cw, y = (r + 0.5) * ch;
      ctx.moveTo(x + R * q, y);
      ctx.arc(x, y, R * q, 0, TAU);
    }
  }
}

// Random orders (bars, dissolve) are generated once and cached.
let _barsOrder = null;
function barsPath(ctx, e, w, h) {
  const n = 24;
  if (!_barsOrder) _barsOrder = shuffled(n, 11);
  const bw = w / n, count = e * n;
  const whole = Math.floor(count);
  for (let k = 0; k < whole && k < n; k++) ctx.rect(_barsOrder[k] * bw, 0, bw, h);
  if (whole < n) {
    const frac = count - whole;
    if (frac > 0) ctx.rect(_barsOrder[whole] * bw, 0, bw, h * frac);
  }
}

function shuffled(n, seed) {
  const a = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  const rand = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// --- polygon clipping (half-plane, preallocated buffers) -------------------------

const _polyA = new Float64Array(24);
const _polyB = new Float64Array(24);

function rectPoly(out, w, h) {
  out[0] = 0; out[1] = 0; out[2] = w; out[3] = 0; out[4] = w; out[5] = h; out[6] = 0; out[7] = h;
  return 4;
}

/** Sutherland–Hodgman against a*x + b*y <= c. Returns vertex count written to out. */
function clipPoly(inp, n, a, b, c, out) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = inp[i * 2], y1 = inp[i * 2 + 1], x2 = inp[j * 2], y2 = inp[j * 2 + 1];
    const d1 = a * x1 + b * y1 - c, d2 = a * x2 + b * y2 - c;
    if (d1 <= 0) { out[m * 2] = x1; out[m * 2 + 1] = y1; m++; }
    if ((d1 < 0 && d2 > 0) || (d1 > 0 && d2 < 0)) {
      const t = d1 / (d1 - d2);
      out[m * 2] = x1 + (x2 - x1) * t; out[m * 2 + 1] = y1 + (y2 - y1) * t; m++;
    }
  }
  return m;
}

function polyPath(ctx, pts, n) {
  for (let i = 0; i < n; i++) {
    if (i === 0) ctx.moveTo(pts[0], pts[1]); else ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
  }
  if (n) ctx.closePath();
}

function halfPlanePath(ctx, a, b, c, w, h) {
  const n = clipPoly(_polyA, rectPoly(_polyA, w, h), a, b, c, _polyB);
  polyPath(ctx, _polyB, n);
}

function diagDownPath(ctx, e, w, h) { halfPlanePath(ctx, 1 / w, 1 / h, 2 * e, w, h); }
function diagUpPath(ctx, e, w, h) { halfPlanePath(ctx, 1 / w, -1 / h, 2 * e - 1, w, h); }

function diagCrossPath(ctx, e, w, h) {
  const L = Math.hypot(w, h), hw = (e * (w * h)) / L * 1.02, ang = Math.atan2(h, w);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(ang);
  ctx.rect(-L, -hw, 2 * L, 2 * hw);
  ctx.rotate(-2 * ang);
  ctx.rect(-L, -hw, 2 * L, 2 * hw);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Transitions

function crossfade(ctx, p, A, B) {
  const e = smooth(p);
  if (e >= 1) { full(ctx, B); return; }
  full(ctx, A);
  if (e > 0) { ctx.save(); ctx.globalAlpha *= e; B(ctx); ctx.restore(); }
}

function fadeThrough(ctx, p, A, B, w, h, color) {
  if (p < 0.5) { full(ctx, A); fillAlpha(ctx, color, smooth(p * 2), w, h); }
  else { full(ctx, B); fillAlpha(ctx, color, smooth((1 - p) * 2), w, h); }
}

// Linear wipe with a soft (feathered) edge.
function bandRect(ctx, dir, u0, u1, w, h) {
  if (u1 <= u0) return;
  switch (dir) {
    case 'left': ctx.rect(w - u1, 0, u1 - u0, h); break;
    case 'right': ctx.rect(u0, 0, u1 - u0, h); break;
    case 'up': ctx.rect(0, h - u1, w, u1 - u0); break;
    default: ctx.rect(0, u0, w, u1 - u0); break;
  }
}

function wipe(ctx, p, A, B, w, h, dir) {
  const e = smooth(p);
  if (e <= 0) { full(ctx, A); return; }
  if (e >= 1) { full(ctx, B); return; }
  const size = dir === 'left' || dir === 'right' ? w : h;
  const f = size * 0.08;
  const X = e * (size + f);
  full(ctx, A);
  if (X - f > 0) {
    ctx.save(); ctx.beginPath(); bandRect(ctx, dir, 0, Math.min(size, X - f), w, h); ctx.clip(); B(ctx); ctx.restore();
  }
  const N = 5;
  for (let k = 0; k < N; k++) {
    const u0 = Math.max(0, X - f + (k * f) / N), u1 = Math.min(size, X - f + ((k + 1) * f) / N);
    if (u1 <= u0) continue;
    ctx.save();
    ctx.beginPath(); bandRect(ctx, dir, u0, u1, w, h); ctx.clip();
    ctx.globalAlpha *= 1 - (k + 0.5) / N;
    B(ctx);
    ctx.restore();
  }
}

function edgeShadow(ctx, x0, y0, x1, y1, w, h, alpha) {
  if (alpha <= 0.01) return;
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,' + Math.round(alpha * 100) / 100 + ')');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.max(Math.abs(x1 - x0), x0 === x1 ? w : 0), Math.max(Math.abs(y1 - y0), y0 === y1 ? h : 0));
  ctx.restore();
}

function dirVec(dir) {
  // unit vector of motion for 'left' | 'right' | 'up' | 'down'
  return dir === 'left' ? -1 : dir === 'right' ? 1 : dir === 'up' ? -2 : 2;
}

function slide(ctx, p, A, B, w, h, dir) {
  const e = easeInOut(p);
  if (e >= 1) { full(ctx, B); return; }
  full(ctx, A);
  if (e <= 0) return;
  const v = dirVec(dir);
  const dx = v === -1 ? (1 - e) * w : v === 1 ? -(1 - e) * w : 0;
  const dy = v === -2 ? (1 - e) * h : v === 2 ? -(1 - e) * h : 0;
  const s = Math.min(w, h) * 0.05, sa = 0.4 * Math.sin(Math.PI * e);
  if (v === -1) edgeShadow(ctx, dx - s, 0, dx, 0, w, h, sa);
  else if (v === 1) edgeShadow(ctx, w + dx + s, 0, w + dx, 0, w, h, sa);
  else if (v === -2) edgeShadow(ctx, 0, dy - s, 0, dy, w, h, sa);
  else edgeShadow(ctx, 0, h + dy + s, 0, h + dy, w, h, sa);
  ctx.save(); ctx.translate(dx, dy); B(ctx); ctx.restore();
}

function push(ctx, p, A, B, w, h, dir) {
  const e = easeInOut(p);
  if (e <= 0) { full(ctx, A); return; }
  if (e >= 1) { full(ctx, B); return; }
  const v = dirVec(dir);
  const ox = v === -1 ? -e * w : v === 1 ? e * w : 0;
  const oy = v === -2 ? -e * h : v === 2 ? e * h : 0;
  const nx = v === -1 ? w : v === 1 ? -w : 0;
  const ny = v === -2 ? h : v === 2 ? -h : 0;
  ctx.save(); ctx.translate(ox, oy); A(ctx); ctx.restore();
  ctx.save(); ctx.translate(ox + nx, oy + ny); B(ctx); ctx.restore();
}

function revealSlide(ctx, p, A, B, w, h, dir) {
  const e = easeInOut(p);
  if (e <= 0) { full(ctx, A); return; }
  if (e >= 1) { full(ctx, B); return; }
  full(ctx, B);
  const ox = dir === 'left' ? -e * w : e * w;
  const s = Math.min(w, h) * 0.05, sa = 0.45 * Math.sin(Math.PI * e);
  if (dir === 'left') edgeShadow(ctx, w + ox + s, 0, w + ox, 0, w, h, sa);
  else edgeShadow(ctx, ox - s, 0, ox, 0, w, h, sa);
  ctx.save(); ctx.translate(ox, 0); A(ctx); ctx.restore();
}

function zoomIn(ctx, p, A, B, w, h) {
  const e = easeInOut(p);
  if (e >= 1) { full(ctx, B); return; }
  full(ctx, A);
  if (e <= 0) return;
  const s = 0.08 + 0.92 * e;
  ctx.save();
  ctx.globalAlpha *= clamp01(e * 2.2);
  ctx.translate(w / 2, h / 2); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
  B(ctx);
  ctx.restore();
}

function zoomOut(ctx, p, A, B, w, h) {
  const e = easeInOut(p);
  if (e <= 0) { full(ctx, A); return; }
  full(ctx, B);
  if (e >= 1) return;
  const s = 1 - 0.92 * e;
  ctx.save();
  ctx.globalAlpha *= 1 - smooth((e - 0.45) / 0.55);
  ctx.translate(w / 2, h / 2); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
  A(ctx);
  ctx.restore();
}

function barnDoors(ctx, p, A, B, w, h) {
  const e = easeInOut(p);
  if (e <= 0) { full(ctx, A); return; }
  full(ctx, B);
  if (e >= 1) return;
  const off = (e * w) / 2;
  const s = Math.min(w, h) * 0.04, sa = 0.4 * Math.sin(Math.PI * e);
  edgeShadow(ctx, w / 2 - off + s, 0, w / 2 - off, 0, w, h, sa);
  edgeShadow(ctx, w / 2 + off - s, 0, w / 2 + off, 0, w, h, sa);
  ctx.save(); ctx.translate(-off, 0); ctx.beginPath(); ctx.rect(0, 0, w / 2, h); ctx.clip(); A(ctx); ctx.restore();
  ctx.save(); ctx.translate(off, 0); ctx.beginPath(); ctx.rect(w / 2, 0, w / 2, h); ctx.clip(); A(ctx); ctx.restore();
}

// Rough dissolve: random blocks switch over (cached shuffled order).
let _dissolve = { cols: 0, rows: 0, order: null };
function dissolve(ctx, p, A, B, w, h) {
  if (p <= 0) { full(ctx, A); return; }
  if (p >= 1) { full(ctx, B); return; }
  const cols = 64, rows = Math.max(8, Math.min(160, Math.round((cols * h) / w)));
  if (_dissolve.cols !== cols || _dissolve.rows !== rows) _dissolve = { cols, rows, order: shuffled(cols * rows, 1234) };
  const order = _dissolve.order, n = cols * rows, m = Math.floor(p * n);
  const cw = w / cols, ch = h / rows;
  full(ctx, A);
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < m; i++) {
    const idx = order[i], c = idx % cols, r = (idx - c) / cols;
    ctx.rect(c * cw, r * ch, cw, ch);
  }
  ctx.clip();
  B(ctx);
  ctx.restore();
}

// --- page curl (flat-fold approximation of a curling page) ---------------------

function pageCurl(ctx, p, A, B, w, h) {
  const e = easeInOut(p);
  if (e <= 0) { full(ctx, A); return; }
  if (e >= 1) { full(ctx, B); return; }
  const L = Math.hypot(w, h), dx = w / L, dy = h / L;
  const s = L * (1 - e);          // fold line: dot(X, d) = s ; peeled side: dot > s
  const k = 0.55;                 // the flap is squashed (curl approximation)
  full(ctx, B);
  // Shadow on the revealed frame along the fold.
  const fx = s * dx, fy = s * dy, sh = L * 0.07;
  const g = ctx.createLinearGradient(fx, fy, fx + dx * sh, fy + dy * sh);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  // Only the band between the fold and the end of the gradient needs filling.
  let nb = clipPoly(_polyA, rectPoly(_polyA, w, h), -dx, -dy, -s, _polyB);
  nb = clipPoly(_polyB, nb, dx, dy, s + sh, _polyA);
  if (nb >= 3) { ctx.save(); ctx.fillStyle = g; ctx.beginPath(); polyPath(ctx, _polyA, nb); ctx.fill(); ctx.restore(); }
  // Unpeeled part of the old frame.
  let n = clipPoly(_polyA, rectPoly(_polyA, w, h), dx, dy, s, _polyB);
  if (n >= 3) {
    ctx.save(); ctx.beginPath(); polyPath(ctx, _polyB, n); ctx.clip(); A(ctx); ctx.restore();
  }
  // The flap: the peeled region reflected (and squashed) over the fold line.
  n = clipPoly(_polyA, rectPoly(_polyA, w, h), -dx, -dy, -s, _polyB);
  const tipDist = k * (L - s);
  if (n < 3 || tipDist < 0.5) return;
  const m11 = 1 - (1 + k) * dx * dx, m12 = -(1 + k) * dx * dy, m22 = 1 - (1 + k) * dy * dy;
  const tx = (1 + k) * s * dx, ty = (1 + k) * s * dy;
  for (let i = 0; i < n; i++) {
    const x = _polyB[i * 2], y = _polyB[i * 2 + 1];
    _polyB[i * 2] = m11 * x + m12 * y + tx;
    _polyB[i * 2 + 1] = m12 * x + m22 * y + ty;
  }
  // soft drop shadow of the flap onto the old frame
  ctx.save();
  ctx.translate(-dx * L * 0.012, dy * L * 0.006);
  ctx.globalAlpha *= 0.28;
  ctx.fillStyle = '#000';
  ctx.beginPath(); polyPath(ctx, _polyB, n); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); polyPath(ctx, _polyB, n); ctx.clip();
  const tx2 = fx - dx * tipDist, ty2 = fy - dy * tipDist;
  const pg = ctx.createLinearGradient(fx, fy, tx2, ty2);
  pg.addColorStop(0, '#8d8d8d');
  pg.addColorStop(0.18, '#e9e9e9');
  pg.addColorStop(0.55, '#ffffff');
  pg.addColorStop(1, '#cfcfcf');
  ctx.fillStyle = pg;
  ctx.fillRect(0, 0, w, h);
  // faint see-through of the print on the back of the page
  ctx.transform(m11, m12, m12, m22, tx, ty);
  ctx.globalAlpha *= 0.16;
  A(ctx);
  ctx.restore();
}

// --- filmstrip --------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function filmstrip(ctx, p, A, B, w, h) {
  if (p <= 0) { full(ctx, A); return; }
  if (p >= 1) { full(ctx, B); return; }
  const e = easeInOut(p);
  const s = 1 - 0.24 * Math.sin(Math.PI * p);
  const fw = w * s, fh = h * s, gap = h * 0.06 * s;
  const pitch = fh + gap, off = e * pitch;
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, w, h);
  const margin = (w - fw) / 2;
  if (margin > 2) {
    const hw = margin * 0.4, hh = Math.min(hw * 0.8, pitch / 9), holePitch = pitch / 5;
    let y = -((off % holePitch) + holePitch);
    ctx.fillStyle = '#e9e6dc';
    ctx.beginPath();
    for (; y < h + holePitch; y += holePitch) {
      roundRect(ctx, margin * 0.3, y, hw, hh, hh * 0.25);
      roundRect(ctx, w - margin * 0.3 - hw, y, hw, hh, hh * 0.25);
    }
    ctx.fill();
  }
  const x = (w - fw) / 2, yA = (h - fh) / 2 - off, yB = yA + pitch;
  if (yA + fh > 0) { ctx.save(); ctx.translate(x, yA); ctx.scale(s, s); A(ctx); ctx.restore(); }
  if (yB < h) { ctx.save(); ctx.translate(x, yB); ctx.scale(s, s); B(ctx); ctx.restore(); }
}

function letterbox(ctx, p, A, B, w, h) {
  const first = p < 0.5;
  full(ctx, first ? A : B);
  const q = first ? smooth(p * 2) : smooth((1 - p) * 2);
  const bh = (q * h) / 2 * 1.01;
  if (bh <= 0.1) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, bh);
  ctx.fillRect(0, h - bh, w, bh);
}

function flash(ctx, p, A, B, w, h) {
  const mix = smooth((p - 0.42) / 0.16);
  if (mix >= 1) full(ctx, B);
  else {
    full(ctx, A);
    if (mix > 0) { ctx.save(); ctx.globalAlpha *= mix; B(ctx); ctx.restore(); }
  }
  const peak = Math.max(0, 1 - Math.abs(2 * p - 1) * 1.5);
  fillAlpha(ctx, '#ffffff', Math.pow(peak, 1.3), w, h);
}

function flip(ctx, p, A, B, w, h) {
  const e = easeInOut(p);
  if (e <= 0) { full(ctx, A); return; }
  if (e >= 1) { full(ctx, B); return; }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const sx = Math.abs(Math.cos(Math.PI * e));
  if (sx < 0.004) return;
  const sy = 1 - 0.1 * Math.sin(Math.PI * e);
  ctx.save();
  ctx.translate(w / 2, h / 2); ctx.scale(sx, sy); ctx.translate(-w / 2, -h / 2);
  (e < 0.5 ? A : B)(ctx);
  fillAlpha(ctx, '#000', (1 - sx) * 0.55, w, h);
  ctx.restore();
}

function cube(ctx, p, A, B, w, h) {
  const e = easeInOut(p);
  if (e <= 0) { full(ctx, A); return; }
  if (e >= 1) { full(ctx, B); return; }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const vs = 1 - 0.12 * Math.sin(Math.PI * e);
  const aw = w * (1 - e), bw = w * e, oy = (h * (1 - vs)) / 2;
  if (aw > 0.5) {
    ctx.save(); ctx.translate(0, oy); ctx.scale(aw / w, vs); A(ctx); fillAlpha(ctx, '#000', e * 0.55, w, h); ctx.restore();
  }
  if (bw > 0.5) {
    ctx.save(); ctx.translate(aw, oy); ctx.scale(bw / w, vs); B(ctx); fillAlpha(ctx, '#000', (1 - e) * 0.55, w, h); ctx.restore();
  }
}

function roll(ctx, p, A, B, w, h) {
  const e = easeIn(p);
  if (e <= 0) { full(ctx, A); return; }
  full(ctx, B);
  if (p >= 1) return;
  // the revealed frame starts in the shadow of the rolling one
  fillAlpha(ctx, '#000', 0.45 * (1 - smooth(p)), w, h);
  ctx.save();
  ctx.translate(0, h); ctx.rotate(-e * Math.PI * 0.55); ctx.translate(0, -h);
  A(ctx);
  ctx.restore();
}

// --- transitions that need the frames as images --------------------------------------

const _layers = [new Scratch(false), new Scratch(false)];
const _mix = new Scratch(false);
const _tdr = { x: 0, y: 0, w: 0, h: 0, sx: 1, sy: 1 };

function frameCanvas(which, cb, ctx, w, h, opts) {
  const given = which === 0 ? opts.from : opts.to;
  if (given && given.width > 0 && given.height > 0) return given;
  const sc = Math.min(4, Math.max(0.1, ctxScaleOf(ctx)));
  const lw = Math.max(1, Math.round(w * sc)), lh = Math.max(1, Math.round(h * sc));
  const s = _layers[which].ensure(lw, lh, true);
  if (!s) return null;
  s.ctx.setTransform(lw / w, 0, 0, lh / h, 0, 0);
  s.ctx.fillStyle = '#000';
  s.ctx.fillRect(0, 0, w, h);
  cb(s.ctx);
  return s.canvas;
}

/** Mix two frame canvases into the _mix scratch (device-sized). Returns canvas or null. */
function mixFrames(ca, cb, t) {
  const cw = ca.width, ch = ca.height;
  const s = _mix.ensure(cw, ch, true);
  if (!s) return null;
  s.ctx.globalAlpha = 1;
  s.ctx.drawImage(ca, 0, 0, cw, ch);
  if (t > 0) {
    s.ctx.globalAlpha = Math.min(1, t);
    s.ctx.drawImage(cb, 0, 0, cb.width, cb.height, 0, 0, cw, ch);
    s.ctx.globalAlpha = 1;
  }
  return s.canvas;
}

function pixelate(ctx, p, A, B, w, h, opts) {
  const tri = 1 - Math.abs(2 * p - 1);
  const mix = smooth((p - 0.3) / 0.4);
  const ca = frameCanvas(0, A, ctx, w, h, opts), cb = frameCanvas(1, B, ctx, w, h, opts);
  if (!ca || !cb) { crossfade(ctx, p, A, B); return; }
  const cw = ca.width, ch = ca.height;
  const block = 1 + (Math.max(4, Math.min(cw, ch) / 14) - 1) * smooth(tri);
  if (block < 1.6) { crossfade(ctx, mix, A, B); return; }
  const m = mixFrames(ca, cb, mix);
  if (!m) { crossfade(ctx, mix, A, B); return; }
  const r = downscaleTo(m, 0, 0, cw, ch, cw / block, ch / block);
  if (!r) { crossfade(ctx, mix, A, B); return; }
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(r.canvas, 0, 0, r.w, r.h, 0, 0, w, h);
  ctx.restore();
}

function blurT(ctx, p, A, B, w, h, opts) {
  const tri = 1 - Math.abs(2 * p - 1);
  const mix = smooth((p - 0.25) / 0.5);
  const ca = frameCanvas(0, A, ctx, w, h, opts), cb = frameCanvas(1, B, ctx, w, h, opts);
  if (!ca || !cb) { crossfade(ctx, p, A, B); return; }
  const m = mixFrames(ca, cb, mix);
  if (!m) { crossfade(ctx, mix, A, B); return; }
  const dr = deviceRectOf(ctx, 0, 0, w, h, _tdr, ca.width / w, ca.height / h);
  const radius = Math.min(dr.w, dr.h) * 0.03 * smooth(tri);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath(); ctx.rect(dr.x, dr.y, dr.w, dr.h); ctx.clip();
  drawBlurred(ctx, m, 0, 0, m.width, m.height, dr.x, dr.y, dr.w, dr.h, radius);
  ctx.restore();
}

// --- shatter ------------------------------------------------------------------------

let _shards = null;
function buildShards() {
  const cols = 6, rows = 4, rand = mulberry32(4242);
  const vx = new Float32Array((cols + 1) * (rows + 1)), vy = new Float32Array((cols + 1) * (rows + 1));
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const i = r * (cols + 1) + c;
      const jx = c > 0 && c < cols ? (rand() - 0.5) * 0.7 / cols : 0;
      const jy = r > 0 && r < rows ? (rand() - 0.5) * 0.7 / rows : 0;
      vx[i] = c / cols + jx; vy[i] = r / rows + jy;
    }
  }
  const list = [];
  const maxD = Math.hypot(0.5, 0.5);
  const add = (a, b, c) => {
    const pts = new Float32Array([vx[a], vy[a], vx[b], vy[b], vx[c], vy[c]]);
    const cx = (pts[0] + pts[2] + pts[4]) / 3, cy = (pts[1] + pts[3] + pts[5]) / 3;
    const dxn = cx - 0.5, dyn = cy - 0.5, d = Math.hypot(dxn, dyn) || 1e-3;
    const speed = 0.45 + rand() * 0.55;
    list.push({
      pts, cx, cy,
      minx: Math.min(pts[0], pts[2], pts[4]), maxx: Math.max(pts[0], pts[2], pts[4]),
      miny: Math.min(pts[1], pts[3], pts[5]), maxy: Math.max(pts[1], pts[3], pts[5]),
      vx: (dxn / d) * speed + (rand() - 0.5) * 0.2,
      vy: (dyn / d) * speed - 0.25 - rand() * 0.2,
      spin: (rand() - 0.5) * 5,
      delay: (d / maxD) * 0.4 + rand() * 0.08,
    });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i00 = r * (cols + 1) + c, i10 = i00 + 1, i01 = i00 + cols + 1, i11 = i01 + 1;
      if ((r + c) % 2) { add(i00, i10, i11); add(i00, i11, i01); } else { add(i00, i10, i01); add(i10, i11, i01); }
    }
  }
  return list;
}

function shardProgress(s, e) { return clamp01((e - s.delay) / (1 - s.delay)); }

function triPath(ctx, s, w, h) {
  const q = s.pts;
  ctx.moveTo(q[0] * w, q[1] * h); ctx.lineTo(q[2] * w, q[3] * h); ctx.lineTo(q[4] * w, q[5] * h); ctx.closePath();
}

function drawShards(ctx, img, cb, e, w, h) {
  if (!_shards) _shards = buildShards();
  const kx = img.width / w, ky = img.height / h;
  // Pieces that have not moved yet are drawn as one union (no hairline seams).
  let any = false;
  ctx.save();
  ctx.beginPath();
  for (const s of _shards) if (shardProgress(s, e) <= 0) { triPath(ctx, s, w, h); any = true; }
  if (any) { ctx.clip(); cb(ctx); }
  ctx.restore();
  const lw = Math.max(1, Math.min(w, h) / 360);
  for (const s of _shards) {
    const t = shardProgress(s, e);
    if (t <= 0 || t >= 1) continue;
    const q = t * t;
    const ox = s.vx * q * w * 0.9, oy = (s.vy * q + 1.3 * q * q) * h;
    const sc = 1 - 0.3 * q;
    const cx = s.cx * w, cy = s.cy * h;
    ctx.save();
    ctx.globalAlpha *= 1 - smooth((t - 0.5) / 0.5);
    ctx.translate(cx + ox, cy + oy); ctx.rotate(s.spin * q); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    ctx.beginPath(); triPath(ctx, s, w, h);
    ctx.save();
    ctx.clip();
    const bx = Math.max(0, s.minx * w - 1), by = Math.max(0, s.miny * h - 1);
    const bw = Math.min(w, s.maxx * w + 1) - bx, bh = Math.min(h, s.maxy * h + 1) - by;
    if (bw > 0 && bh > 0) ctx.drawImage(img, bx * kx, by * ky, bw * kx, bh * ky, bx, by, bw, bh);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.restore();
  }
}

function shatter(ctx, p, A, B, w, h, opts) {
  const e = p;
  if (e <= 0) { full(ctx, A); return; }
  if (p >= 1) { full(ctx, B); return; }
  const ca = frameCanvas(0, A, ctx, w, h, opts);
  if (!ca) { crossfade(ctx, p, A, B); return; }
  full(ctx, B);
  drawShards(ctx, ca, A, e, w, h);
}

function shatterIn(ctx, p, A, B, w, h, opts) {
  const e = 1 - p;
  if (p <= 0) { full(ctx, A); return; }
  if (e <= 0) { full(ctx, B); return; }
  const cb = frameCanvas(1, B, ctx, w, h, opts);
  if (!cb) { crossfade(ctx, p, A, B); return; }
  full(ctx, A);
  drawShards(ctx, cb, B, e, w, h);
}

// ---------------------------------------------------------------------------
// Registry

const IMPL = {
  none: (ctx, p, A, B) => full(ctx, p < 0.5 ? A : B),
  crossfade,
  'fade-black': (ctx, p, A, B, w, h) => fadeThrough(ctx, p, A, B, w, h, '#000000'),
  'fade-white': (ctx, p, A, B, w, h) => fadeThrough(ctx, p, A, B, w, h, '#ffffff'),
  dissolve,
  blur: blurT,
  'wipe-left': (ctx, p, A, B, w, h) => wipe(ctx, p, A, B, w, h, 'left'),
  'wipe-right': (ctx, p, A, B, w, h) => wipe(ctx, p, A, B, w, h, 'right'),
  'wipe-up': (ctx, p, A, B, w, h) => wipe(ctx, p, A, B, w, h, 'up'),
  'wipe-down': (ctx, p, A, B, w, h) => wipe(ctx, p, A, B, w, h, 'down'),
  'slide-left': (ctx, p, A, B, w, h) => slide(ctx, p, A, B, w, h, 'left'),
  'slide-right': (ctx, p, A, B, w, h) => slide(ctx, p, A, B, w, h, 'right'),
  'slide-up': (ctx, p, A, B, w, h) => slide(ctx, p, A, B, w, h, 'up'),
  'slide-down': (ctx, p, A, B, w, h) => slide(ctx, p, A, B, w, h, 'down'),
  'push-left': (ctx, p, A, B, w, h) => push(ctx, p, A, B, w, h, 'left'),
  'push-right': (ctx, p, A, B, w, h) => push(ctx, p, A, B, w, h, 'right'),
  'push-up': (ctx, p, A, B, w, h) => push(ctx, p, A, B, w, h, 'up'),
  'push-down': (ctx, p, A, B, w, h) => push(ctx, p, A, B, w, h, 'down'),
  'reveal-left': (ctx, p, A, B, w, h) => revealSlide(ctx, p, A, B, w, h, 'left'),
  'reveal-right': (ctx, p, A, B, w, h) => revealSlide(ctx, p, A, B, w, h, 'right'),
  'iris-in': (ctx, p, A, B, w, h) => reveal(ctx, A, B, circlePath, easeInOut(p), w, h),
  'iris-out': (ctx, p, A, B, w, h) => shrink(ctx, A, B, circlePath, easeInOut(p), w, h),
  diamond: (ctx, p, A, B, w, h) => reveal(ctx, A, B, diamondPath, easeInOut(p), w, h),
  heart: (ctx, p, A, B, w, h) => reveal(ctx, A, B, heartPath, easeIn(p), w, h),
  star: (ctx, p, A, B, w, h) => reveal(ctx, A, B, starPath, easeIn(p), w, h),
  cross: (ctx, p, A, B, w, h) => reveal(ctx, A, B, crossPath, easeInOut(p), w, h),
  circles: (ctx, p, A, B, w, h) => reveal(ctx, A, B, circlesPath, smooth(p), w, h),
  checkerboard: (ctx, p, A, B, w, h) => reveal(ctx, A, B, checkerPath, p, w, h),
  clock: (ctx, p, A, B, w, h) => reveal(ctx, A, B, clockPath, smooth(p), w, h),
  wheel: (ctx, p, A, B, w, h) => reveal(ctx, A, B, wheelPath, smooth(p), w, h),
  fan: (ctx, p, A, B, w, h) => reveal(ctx, A, B, fanPath, smooth(p), w, h),
  'blinds-h': (ctx, p, A, B, w, h) => reveal(ctx, A, B, blindsHPath, smooth(p), w, h),
  'blinds-v': (ctx, p, A, B, w, h) => reveal(ctx, A, B, blindsVPath, smooth(p), w, h),
  bars: (ctx, p, A, B, w, h) => reveal(ctx, A, B, barsPath, p, w, h),
  'split-h': (ctx, p, A, B, w, h) => reveal(ctx, A, B, splitHPath, easeInOut(p), w, h),
  'split-v': (ctx, p, A, B, w, h) => reveal(ctx, A, B, splitVPath, easeInOut(p), w, h),
  'diagonal-box': (ctx, p, A, B, w, h) => reveal(ctx, A, B, diagBoxPath, easeInOut(p), w, h),
  'diagonal-down': (ctx, p, A, B, w, h) => reveal(ctx, A, B, diagDownPath, smooth(p), w, h),
  'diagonal-up': (ctx, p, A, B, w, h) => reveal(ctx, A, B, diagUpPath, smooth(p), w, h),
  'diagonal-cross': (ctx, p, A, B, w, h) => reveal(ctx, A, B, diagCrossPath, easeInOut(p), w, h),
  'zoom-in': zoomIn,
  'zoom-out': zoomOut,
  'barn-doors': barnDoors,
  'page-curl': pageCurl,
  filmstrip,
  letterbox,
  flash,
  flip,
  cube,
  roll,
  pixelate,
  shatter,
  'shatter-in': shatterIn,
};

/** True when `type` has a dedicated implementation (unknown types crossfade). */
export function hasTransition(type) {
  return Object.prototype.hasOwnProperty.call(IMPL, type);
}

/** Ids of every implemented transition. */
export function transitionTypes() {
  return Object.keys(IMPL);
}

/**
 * Draw the transition between two frames at progress p (0 = all "from", 1 = all "to").
 * drawFrom / drawTo: (ctx) => void, each drawing a full opaque w×h frame.
 */
export function drawTransition(ctx, type, p, drawFrom, drawTo, w, h, opts) {
  if (!ctx || !(w > 0) || !(h > 0)) return;
  p = +p;
  if (!(p >= 0)) p = 0; else if (p > 1) p = 1;
  const A = typeof drawFrom === 'function' ? drawFrom : noop;
  const B = typeof drawTo === 'function' ? drawTo : noop;
  const fn = IMPL[type] || crossfade;
  ctx.save();
  try {
    fn(ctx, p, A, B, w, h, opts || EMPTY);
  } catch (err) {
    warnOnce('transition ' + type, err);
    ctx.restore();
    ctx.save();
    try { full(ctx, p < 0.5 ? A : B); } catch (_) { /* give up on this frame */ }
  } finally {
    ctx.restore();
  }
}
