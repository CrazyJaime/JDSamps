// gallery.js — little animated preview tiles for the ribbon galleries.
//
// Contract:
//   renderGalleryThumb(canvas, kind /*'transition'|'panzoom'|'effect'|'text'|'automovie'*/, id, p /*0..1*/)
//
// Tiles are drawn at the canvas's own pixel size (callers handle devicePixelRatio by sizing
// canvas.width/height). Two procedural sample "photos" (a blue-sky landscape and an orange
// sunset) are painted with gradients once per size and cached. Every tile goes through the
// real renderer pieces (drawSegment / drawTransition / drawText) so it matches the output.
// When p is not a number a representative still frame is drawn.

import { drawTransition } from './transitions.js';
import { drawSegment } from './renderer.js';
import { drawText } from './text.js';
import { Scratch, resolvePanZoom, effectKind, FADE_MAX, warnOnce } from './effects.js';
import { AUTOMOVIE_THEMES, byId } from './catalog.js';

const TAU = Math.PI * 2;
const DEFAULT_P = { transition: 0.45, panzoom: 0.7, effect: 0.5, text: 0.25, automovie: 0.5 };
// Transitions that are (almost) a blank frame at their midpoint get an earlier still.
const BLANK_MID = new Set(['fade-black', 'fade-white', 'flash', 'letterbox', 'flip']);

function stillP(kind, id) {
  if (kind === 'transition' && BLANK_MID.has(id)) return 0.3;
  if (kind === 'automovie') {
    const theme = byId(AUTOMOVIE_THEMES, id);
    if (theme && BLANK_MID.has(theme.transition)) return 0.3;
  }
  return DEFAULT_P[kind] != null ? DEFAULT_P[kind] : 0.5;
}

// ---------------------------------------------------------------------------
// Sample photos

const _photos = new Map(); // key → Scratch
const PHOTO_SCALE = 1.5;   // painted larger than the tile so pan & zoom stays crisp

function paintLandscape(c, w, h) {
  const sky = c.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#2c69c4');
  sky.addColorStop(0.6, '#7fbcef');
  sky.addColorStop(1, '#d5ecfb');
  c.fillStyle = sky;
  c.fillRect(0, 0, w, h);
  // sun glow
  const sx = w * 0.78, sy = h * 0.2, sr = Math.min(w, h) * 0.09;
  const glow = c.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr * 3);
  glow.addColorStop(0, 'rgba(255,255,235,0.95)');
  glow.addColorStop(0.3, 'rgba(255,250,210,0.45)');
  glow.addColorStop(1, 'rgba(255,250,210,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#fffbe6';
  c.beginPath(); c.arc(sx, sy, sr, 0, TAU); c.fill();
  // clouds
  c.fillStyle = 'rgba(255,255,255,0.92)';
  const cloud = (x, y, s) => {
    c.beginPath();
    c.arc(x, y, s, 0, TAU); c.arc(x + s * 1.1, y - s * 0.45, s * 1.15, 0, TAU);
    c.arc(x + s * 2.3, y, s * 0.95, 0, TAU); c.arc(x + s * 1.2, y + s * 0.25, s, 0, TAU);
    c.fill();
  };
  cloud(w * 0.12, h * 0.2, h * 0.055);
  cloud(w * 0.46, h * 0.12, h * 0.04);
  // far hills
  c.fillStyle = '#6f9fb8';
  c.beginPath();
  c.moveTo(0, h * 0.6);
  c.bezierCurveTo(w * 0.2, h * 0.42, w * 0.35, h * 0.5, w * 0.5, h * 0.55);
  c.bezierCurveTo(w * 0.7, h * 0.4, w * 0.85, h * 0.48, w, h * 0.52);
  c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fill();
  // mid hill
  const mid = c.createLinearGradient(0, h * 0.5, 0, h);
  mid.addColorStop(0, '#5fae45');
  mid.addColorStop(1, '#2f7a28');
  c.fillStyle = mid;
  c.beginPath();
  c.moveTo(0, h * 0.7);
  c.bezierCurveTo(w * 0.25, h * 0.55, w * 0.55, h * 0.62, w * 0.75, h * 0.7);
  c.bezierCurveTo(w * 0.88, h * 0.74, w * 0.95, h * 0.68, w, h * 0.66);
  c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fill();
  // near hill
  const near = c.createLinearGradient(0, h * 0.7, 0, h);
  near.addColorStop(0, '#8ccf55');
  near.addColorStop(1, '#4b9a33');
  c.fillStyle = near;
  c.beginPath();
  c.moveTo(0, h * 0.86);
  c.bezierCurveTo(w * 0.3, h * 0.74, w * 0.6, h * 0.8, w, h * 0.9);
  c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fill();
  // tree
  const tx = w * 0.27, ty = h * 0.66, ts = h * 0.12;
  c.fillStyle = '#5b3b1e';
  c.fillRect(tx - ts * 0.08, ty - ts * 0.2, ts * 0.16, ts * 0.75);
  c.fillStyle = '#2d6b23';
  c.beginPath(); c.arc(tx, ty - ts * 0.45, ts * 0.5, 0, TAU); c.fill();
  c.fillStyle = '#3d8a2c';
  c.beginPath(); c.arc(tx - ts * 0.15, ty - ts * 0.55, ts * 0.3, 0, TAU); c.fill();
  // red house
  const hx = w * 0.64, hy = h * 0.66, hs = h * 0.09;
  c.fillStyle = '#f4efe6';
  c.fillRect(hx, hy - hs, hs * 1.4, hs);
  c.fillStyle = '#c4382e';
  c.beginPath(); c.moveTo(hx - hs * 0.15, hy - hs); c.lineTo(hx + hs * 0.7, hy - hs * 1.7); c.lineTo(hx + hs * 1.55, hy - hs); c.closePath(); c.fill();
  c.fillStyle = '#3a4a5c';
  c.fillRect(hx + hs * 0.55, hy - hs * 0.6, hs * 0.3, hs * 0.6);
}

function paintSunset(c, w, h) {
  const hz = h * 0.6;
  const sky = c.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#2b1d55');
  sky.addColorStop(0.35, '#8e3266');
  sky.addColorStop(0.7, '#e8743a');
  sky.addColorStop(1, '#ffc96b');
  c.fillStyle = sky;
  c.fillRect(0, 0, w, hz);
  // sun
  const sx = w * 0.58, sr = Math.min(w, h) * 0.17;
  const glow = c.createRadialGradient(sx, hz, sr * 0.6, sx, hz, sr * 3.2);
  glow.addColorStop(0, 'rgba(255,236,160,0.9)');
  glow.addColorStop(1, 'rgba(255,170,90,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, w, hz);
  c.save();
  c.beginPath(); c.rect(0, 0, w, hz); c.clip();
  const sun = c.createLinearGradient(0, hz - sr, 0, hz);
  sun.addColorStop(0, '#fff6c4');
  sun.addColorStop(1, '#ffb347');
  c.fillStyle = sun;
  c.beginPath(); c.arc(sx, hz, sr, 0, TAU); c.fill();
  c.restore();
  // sea
  const sea = c.createLinearGradient(0, hz, 0, h);
  sea.addColorStop(0, '#8a3b4f');
  sea.addColorStop(0.4, '#4a2447');
  sea.addColorStop(1, '#1b1230');
  c.fillStyle = sea;
  c.fillRect(0, hz, w, h - hz);
  // sun reflection
  c.fillStyle = 'rgba(255,214,140,0.75)';
  for (let i = 0; i < 7; i++) {
    const y = hz + (h - hz) * (0.06 + i * 0.12);
    const rw = sr * (1.1 - i * 0.12);
    c.fillRect(sx - rw / 2, y, rw, Math.max(1, h * 0.012));
  }
  // headland silhouette with a palm
  c.fillStyle = '#1a0f22';
  c.beginPath();
  c.moveTo(0, hz - h * 0.05);
  c.bezierCurveTo(w * 0.12, hz - h * 0.09, w * 0.22, hz - h * 0.02, w * 0.32, hz + h * 0.02);
  c.lineTo(w * 0.32, h); c.lineTo(0, h); c.closePath(); c.fill();
  const px = w * 0.13, py = hz - h * 0.07;
  c.strokeStyle = '#1a0f22';
  c.lineWidth = Math.max(1, h * 0.018);
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(px, py); c.quadraticCurveTo(px + w * 0.02, py - h * 0.18, px + w * 0.05, py - h * 0.3); c.stroke();
  const tx = px + w * 0.05, ty = py - h * 0.3;
  c.lineWidth = Math.max(1, h * 0.012);
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI * 0.95 + i * (Math.PI * 0.95 / 5);
    c.beginPath();
    c.moveTo(tx, ty);
    c.quadraticCurveTo(tx + Math.cos(a) * w * 0.06, ty + Math.sin(a) * h * 0.08 - h * 0.03,
      tx + Math.cos(a) * w * 0.1, ty + Math.sin(a) * h * 0.1 + h * 0.04);
    c.stroke();
  }
  // a couple of birds
  c.lineWidth = Math.max(1, h * 0.008);
  const bird = (x, y, s) => { c.beginPath(); c.moveTo(x - s, y); c.quadraticCurveTo(x - s / 2, y - s * 0.6, x, y); c.quadraticCurveTo(x + s / 2, y - s * 0.6, x + s, y); c.stroke(); };
  bird(w * 0.78, h * 0.22, w * 0.025);
  bird(w * 0.86, h * 0.28, w * 0.018);
}

/** Cached sample photo canvas for a tile of w×h ('A' landscape, 'B' sunset). */
function photo(which, w, h) {
  const pw = Math.max(8, Math.round(w * PHOTO_SCALE)), ph = Math.max(8, Math.round(h * PHOTO_SCALE));
  const key = which + ':' + pw + 'x' + ph;
  let s = _photos.get(key);
  if (s && s.canvas) return s.canvas;
  if (_photos.size >= 16) _photos.clear();
  s = new Scratch(false);
  if (!s.ensure(pw, ph, true)) return null;
  if (which === 'B') paintSunset(s.ctx, pw, ph); else paintLandscape(s.ctx, pw, ph);
  _photos.set(key, s);
  return s.canvas;
}

function drawPhoto(ctx, which, w, h) {
  const img = photo(which, w, h);
  if (img) ctx.drawImage(img, 0, 0, w, h);
  else { ctx.fillStyle = which === 'B' ? '#c8643c' : '#5d9ad6'; ctx.fillRect(0, 0, w, h); }
}

// ---------------------------------------------------------------------------
// Fake segment pushed through the real renderer

const D = 3; // seconds of the virtual sample clip
const _item = {
  id: '__gallery__', kind: 'image', mediaId: null, duration: D,
  transition: { type: 'none', duration: 0 }, panZoom: 'none', effect: 'none', brightness: 0, rotation: 0,
};
const _seg = { item: _item, index: 0, start: 0, end: D, duration: D, transitionIn: null, sourceIn: 0, sourceOut: D };
const _opts = { quality: 'preview', getMedia: null, hideTextIds: null, scale: 1 };
const _gA = new Scratch(false);
const _gB = new Scratch(false);
let _gw = 1, _gh = 1;
const _drawA = (c) => { if (_gA.canvas) c.drawImage(_gA.canvas, 0, 0, _gw, _gh); };
const _drawB = (c) => { if (_gB.canvas) c.drawImage(_gB.canvas, 0, 0, _gw, _gh); };
const _trOpts = { from: null, to: null };

function segmentInto(ctx, which, panZoom, effect, index, localT, w, h) {
  _item.panZoom = panZoom || 'none';
  _item.effect = effect || 'none';
  _seg.index = index;
  drawSegment(ctx, _seg, photo(which, w, h), localT, w, h, _opts);
}

/** Effects' sample time: fades are shown mid-fade at the default p. */
function effectTime(id, q) {
  const fd = Math.min(FADE_MAX, D * 0.5);
  if (effectKind(id) === 'fade') return id.indexOf('-in-') >= 0 ? q * fd : D - fd + q * fd;
  return q * D;
}

// ---------------------------------------------------------------------------
// Tiles

function thumbTransition(ctx, id, q, w, h) {
  if (id === 'none') {
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w / 2, h); ctx.clip(); drawPhoto(ctx, 'A', w, h); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(w / 2, 0, w / 2, h); ctx.clip(); drawPhoto(ctx, 'B', w, h); ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(w / 2 - Math.max(0.5, w / 160), 0, Math.max(1, w / 80), h);
    return;
  }
  const A = _gA.ensure(w, h, true), B = _gB.ensure(w, h, true);
  if (!A || !B) { drawPhoto(ctx, q < 0.5 ? 'A' : 'B', w, h); return; }
  drawPhoto(A.ctx, 'A', w, h);
  drawPhoto(B.ctx, 'B', w, h);
  _gw = w; _gh = h;
  _trOpts.from = A.canvas; _trOpts.to = B.canvas;
  drawTransition(ctx, id, q, _drawA, _drawB, w, h, _trOpts);
  _trOpts.from = null; _trOpts.to = null;
}

function badge(ctx, w, h, panZoomId) {
  if (panZoomId === 'none') return;
  const r = Math.max(5, Math.min(w, h) * 0.17), pad = r * 0.35;
  const cx = w - r - pad, cy = h - r - pad;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, r * 0.2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const s = r * 0.5;
  if (panZoomId === 'auto') {
    ctx.font = 'bold ' + Math.round(r * 1.1) + 'px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A', cx, cy + r * 0.05);
  } else if (panZoomId.indexOf('pan-') === 0) {
    const dir = panZoomId.slice(4);
    const ax = dir === 'left' ? -1 : dir === 'right' ? 1 : 0, ay = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    ctx.beginPath();
    ctx.moveTo(cx - ax * s, cy - ay * s); ctx.lineTo(cx + ax * s, cy + ay * s);
    ctx.moveTo(cx + ax * s - (ax * 0.55 + ay * 0.55) * s, cy + ay * s - (ay * 0.55 - ax * 0.55) * s);
    ctx.lineTo(cx + ax * s, cy + ay * s);
    ctx.lineTo(cx + ax * s - (ax * 0.55 - ay * 0.55) * s, cy + ay * s - (ay * 0.55 + ax * 0.55) * s);
    ctx.stroke();
  } else {
    // "+" zoom in / "−" zoom out; a dot marks the side the zoom is anchored to.
    const zin = panZoomId.indexOf('zoom-in') === 0;
    const side = panZoomId.split('-')[2];
    const dx = side === 'left' ? -1 : side === 'right' ? 1 : 0, dy = side === 'top' ? -1 : side === 'bottom' ? 1 : 0;
    const g = side ? s * 0.7 : s;
    const gx = cx - dx * r * 0.18, gy = cy - dy * r * 0.18;
    ctx.beginPath();
    ctx.moveTo(gx - g, gy); ctx.lineTo(gx + g, gy);
    if (zin) { ctx.moveTo(gx, gy - g); ctx.lineTo(gx, gy + g); }
    ctx.stroke();
    if (side) {
      ctx.beginPath(); ctx.arc(cx + dx * r * 0.66, cy + dy * r * 0.66, r * 0.15, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

function thumbPanZoom(ctx, id, q, w, h) {
  segmentInto(ctx, 'A', id, 'none', 0, q * D, w, h);
  badge(ctx, w, h, id === 'auto' ? 'auto' : resolvePanZoom(id, 0));
}

function thumbEffect(ctx, id, q, w, h) {
  segmentInto(ctx, 'A', 'none', id, 0, effectTime(id, q), w, h);
}

const _textArgs = { text: 'Abc', style: null, effect: 'none', localT: 0, duration: D, w: 0, h: 0, kind: 'caption' };
const TEXT_STYLE = {
  font: 'Segoe UI, Arial, sans-serif', size: 34, bold: true, italic: false, color: '#ffffff',
  outline: 'thin', outlineColor: '#1b1b1b', align: 'center', valign: 'middle', opacity: 1, background: null,
};

function thumbText(ctx, id, q, w, h) {
  drawPhoto(ctx, 'B', w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, w, h);
  _textArgs.effect = id || 'none';
  _textArgs.style = TEXT_STYLE;
  _textArgs.localT = id === 'scroll' || id === 'ticker' ? q * D : q * D * 0.5;
  _textArgs.w = w; _textArgs.h = h;
  drawText(ctx, _textArgs);
}

function thumbAutoMovie(ctx, id, q, w, h) {
  const theme = byId(AUTOMOVIE_THEMES, id) || AUTOMOVIE_THEMES[0];
  const A = _gA.ensure(w, h, true), B = _gB.ensure(w, h, true);
  if (!A || !B) { drawPhoto(ctx, 'A', w, h); return; }
  // The outgoing clip is near its end, the incoming one just started.
  segmentInto(A.ctx, 'A', theme.panZoom, theme.effect, 0, D * (0.75 + 0.25 * q), w, h);
  segmentInto(B.ctx, 'B', theme.panZoom, theme.effect, 1, D * 0.25 * q, w, h);
  _gw = w; _gh = h;
  _trOpts.from = A.canvas; _trOpts.to = B.canvas;
  drawTransition(ctx, theme.transition || 'crossfade', q, _drawA, _drawB, w, h, _trOpts);
  _trOpts.from = null; _trOpts.to = null;
}

/**
 * Draw a gallery preview tile into `canvas` (uses canvas.width/height as its pixel size).
 * kind: 'transition' | 'panzoom' | 'effect' | 'text' | 'automovie'; p: 0..1 animation phase.
 */
export function renderGalleryThumb(canvas, kind, id, p) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const w = canvas.width | 0, h = canvas.height | 0;
  if (w < 2 || h < 2) return;
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch (_) { ctx = null; }
  if (!ctx) return;
  let q = typeof p === 'number' && p >= 0 && p <= 1 ? p : stillP(kind, id);
  if (typeof p === 'number' && p > 1) q = 1;
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    _opts.scale = 1;
    switch (kind) {
      case 'transition': thumbTransition(ctx, id || 'none', q, w, h); break;
      case 'panzoom': thumbPanZoom(ctx, id || 'none', q, w, h); break;
      case 'effect': thumbEffect(ctx, id || 'none', q, w, h); break;
      case 'text': thumbText(ctx, id || 'none', q, w, h); break;
      case 'automovie': thumbAutoMovie(ctx, id, q, w, h); break;
      default: drawPhoto(ctx, 'A', w, h); break;
    }
  } catch (err) {
    warnOnce('gallery thumbnail', err);
    try { ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, w, h); } catch (_) { /* ignore */ }
  } finally {
    ctx.restore();
  }
}
