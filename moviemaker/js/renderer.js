// renderer.js — composites one frame of the movie onto a 2D canvas.
//
// Contract:
//   renderFrame(ctx, t, { project, timeline, width, height, getSource, getMedia, quality, hideTextIds })
//   drawSegment(ctx, segment, source, localT, w, h, opts)
//   activeSegmentsAt(timeline, t) -> Segment[]   (1, or 2 = [prev, cur] during a transition)
//   sourceTimeAt(segment, t) -> seconds into the source media of a video segment
//
// Drawing happens in the user space 0..width × 0..height of ctx. When ctx has an identity
// transform but its canvas has a different pixel size, the frame is scaled to fill the
// canvas (so callers may pass either CSS or device sizes). Scratch layers are module-level
// and reused; nothing is allocated per frame apart from what the browser APIs require.

import { drawTransition } from './transitions.js';
import {
  applyEffect, applyEffectTransform, cssFilterFor, drawEffectOverlay, effectKind,
  panZoomRect, Scratch, ctxScaleOf, supportsCtxFilter, warnOnce,
} from './effects.js';
import { drawText } from './text.js';

const EMPTY = Object.freeze({});
const END_HOLD = 0.05; // seconds the last frame stays visible past the end of the visuals

function clamp01(v) { return v <= 0 ? 0 : v >= 1 ? 1 : v; }

function hasId(set, id) {
  if (!set || id == null) return false;
  if (typeof set.has === 'function') return set.has(id);
  if (Array.isArray(set)) return set.includes(id);
  return false;
}

// ---------------------------------------------------------------------------
// Timeline queries

const _active = [null, null];
let _activeN = 0;

function collectActive(timeline, t) {
  _active[0] = null; _active[1] = null; _activeN = 0;
  const segs = timeline && timeline.segments;
  if (!segs || !segs.length || Number.isNaN(t)) return 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s || !(s.duration > 0)) continue;
    if (t >= s.start && t < s.end) {
      if (_activeN < 2) _active[_activeN++] = s;
      else { _active[0] = _active[1]; _active[1] = s; }
    }
  }
  if (_activeN === 0) {
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (s && s.duration > 0) {
        if (t >= s.end && t <= s.end + END_HOLD) { _active[0] = s; _activeN = 1; }
        break;
      }
    }
  }
  return _activeN;
}

/** Segments visible at time t: [] , [seg] or [prev, cur] during a transition overlap. */
export function activeSegmentsAt(timeline, t) {
  const n = collectActive(timeline, +t);
  return n === 2 ? [_active[0], _active[1]] : n === 1 ? [_active[0]] : [];
}

/** Seconds into the source media for a video segment at timeline time t (clamped to the trim). */
export function sourceTimeAt(segment, t) {
  if (!segment) return 0;
  const item = segment.item || EMPTY;
  const dur = segment.duration > 0 ? segment.duration : 0;
  let local = (+t || 0) - (+segment.start || 0);
  if (local < 0) local = 0; else if (local > dur) local = dur;
  if (item.kind !== 'video') return local;
  const speed = item.speed > 0 ? +item.speed : 1;
  const sIn = +segment.sourceIn || 0;
  let st = sIn + local * speed;
  const sOut = +segment.sourceOut;
  if (sOut > sIn) st = Math.min(st, Math.max(sIn, sOut - 1e-3));
  return st;
}

// ---------------------------------------------------------------------------
// Source geometry

const _dims = { w: 0, h: 0 };

function sourceDims(src) {
  let w = 0, h = 0;
  try {
    if (typeof src.videoWidth === 'number') {
      if (typeof src.readyState === 'number' && src.readyState < 2) return false; // no current frame yet
      w = src.videoWidth; h = src.videoHeight;
    } else if (typeof src.naturalWidth === 'number') {
      if (src.complete === false) return false;
      w = src.naturalWidth; h = src.naturalHeight;
    } else if (typeof src.displayWidth === 'number') { // VideoFrame
      w = src.displayWidth; h = src.displayHeight;
    } else {
      w = src.width; h = src.height; // ImageBitmap, canvas, OffscreenCanvas
    }
  } catch (_) {
    return false;
  }
  if (!(w > 0 && h > 0)) return false;
  _dims.w = w; _dims.h = h;
  return true;
}

function normRotation(r) {
  r = Math.round((+r || 0) / 90) * 90;
  r %= 360;
  if (r < 0) r += 360;
  return r;
}

const _crop = { sx: 0, sy: 0, sw: 0, sh: 0 };
const _box = { x: 0, y: 0, w: 0, h: 0 };

/** "contain" rect of an rw×rh image in w×h, snapped to device pixels (scale = px per unit). */
function containRect(rw, rh, w, h, scale, out) {
  const k = Math.min(w / rw, h / rh);
  let dw = rw * k, dh = rh * k;
  let dx = (w - dw) / 2, dy = (h - dh) / 2;
  const tol = 1.01 / (scale || 1);
  if (Math.abs(dw - w) < tol) { dx = 0; dw = w; } else {
    const x0 = Math.round(dx * scale) / scale, x1 = Math.round((dx + dw) * scale) / scale;
    dx = x0; dw = Math.max(1 / scale, x1 - x0);
  }
  if (Math.abs(dh - h) < tol) { dy = 0; dh = h; } else {
    const y0 = Math.round(dy * scale) / scale, y1 = Math.round((dy + dh) * scale) / scale;
    dy = y0; dh = Math.max(1 / scale, y1 - y0);
  }
  out.x = dx; out.y = dy; out.w = dw; out.h = dh;
  return out;
}

// ---------------------------------------------------------------------------
// Placeholder (missing / not yet decoded media)

function drawFilmIcon(ctx, cx, cy, s) {
  const bw = s * 1.5, bh = s, x = cx - bw / 2, y = cy - bh / 2, r = s * 0.1;
  ctx.fillStyle = '#4d4d4d';
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + bw, y, x + bw, y + bh, r);
  ctx.arcTo(x + bw, y + bh, x, y + bh, r);
  ctx.arcTo(x, y + bh, x, y, r);
  ctx.arcTo(x, y, x + bw, y, r);
  ctx.closePath();
  ctx.fill();
  // sprocket holes
  ctx.fillStyle = '#2b2b2b';
  const n = 6, hw = bw / (n * 2), hh = bh * 0.11, gap = (bw - n * hw) / (n + 1);
  for (let i = 0; i < n; i++) {
    const hx = x + gap + i * (hw + gap);
    ctx.fillRect(hx, y + bh * 0.06, hw, hh);
    ctx.fillRect(hx, y + bh - bh * 0.06 - hh, hw, hh);
  }
  // play triangle
  ctx.fillStyle = '#8f8f8f';
  const t = bh * 0.22;
  ctx.beginPath();
  ctx.moveTo(cx - t * 0.8, cy - t);
  ctx.lineTo(cx + t * 1.1, cy);
  ctx.lineTo(cx - t * 0.8, cy + t);
  ctx.closePath();
  ctx.fill();
}

let _labelCache = { key: '', text: '' };
function fitLabel(ctx, text, maxW) {
  const key = text + '|' + Math.round(maxW) + '|' + ctx.font;
  if (_labelCache.key === key) return _labelCache.text;
  let out = text;
  if (ctx.measureText(out).width > maxW) {
    const chars = Array.from(text);
    let lo = 0, hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    out = chars.slice(0, lo).join('') + '…';
  }
  _labelCache = { key, text: out };
  return out;
}

function drawPlaceholder(ctx, item, getMedia, w, h, scale) {
  let media = null;
  if (item.mediaId && typeof getMedia === 'function') {
    try { media = getMedia(item.mediaId) || null; } catch (_) { media = null; }
  }
  let r = _box;
  r.x = 0; r.y = 0; r.w = w; r.h = h;
  if (media && media.width > 0 && media.height > 0) {
    const rot = normRotation(item.rotation);
    const swap = rot === 90 || rot === 270;
    r = containRect(swap ? media.height : media.width, swap ? media.width : media.height, w, h, scale, _box);
  }
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const label = media ? (media.name || '') : (item.mediaId ? 'Media not found' : '');
  const s = Math.min(r.w, r.h) * 0.3;
  if (s < 4) return;
  const cy = r.y + r.h / 2 - (label ? s * 0.2 : 0);
  drawFilmIcon(ctx, r.x + r.w / 2, cy, s);
  if (label && r.h > 48) {
    const fs = Math.max(9, Math.min(r.h * 0.05, 22));
    ctx.font = Math.round(fs) + 'px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#a0a0a0';
    ctx.fillText(fitLabel(ctx, label, r.w * 0.9), r.x + r.w / 2, cy + s * 0.65);
  }
}

// ---------------------------------------------------------------------------
// Segment drawing

const _fx = {
  brightness: 0, localT: 0, duration: 1, quality: 'preview', x: 0, y: 0, scale: 1,
  colorDone: false, transforms: false, color: true, overlay: false,
};
const _titleArgs = { text: '', style: null, effect: 'none', localT: 0, duration: 1, w: 0, h: 0, kind: 'title' };

function drawTitleSegment(ctx, item, lt, dur, w, h, o, effect, brightness, quality, scale) {
  ctx.fillStyle = '#000000';
  ctx.fillStyle = item.background || '#000000';
  ctx.fillRect(0, 0, w, h);
  if (item.text && !hasId(o.hideTextIds, item.id)) {
    ctx.save();
    applyEffectTransform(ctx, effect, lt, dur, w, h);
    _titleArgs.text = item.text;
    _titleArgs.style = item.style || null;
    _titleArgs.effect = item.textEffect || 'none';
    _titleArgs.localT = lt;
    _titleArgs.duration = dur;
    _titleArgs.w = w; _titleArgs.h = h;
    drawText(ctx, _titleArgs);
    ctx.restore();
  }
  if (effect !== 'none' || brightness) {
    _fx.brightness = brightness; _fx.localT = lt; _fx.duration = dur; _fx.quality = quality;
    _fx.x = 0; _fx.y = 0; _fx.colorDone = false; _fx.scale = scale;
    applyEffect(ctx, effect, w, h, _fx);
  }
}

function drawVisualSegment(ctx, item, segment, source, lt, dur, w, h, o, effect, brightness, quality, scale) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!source) { drawPlaceholder(ctx, item, o.getMedia, w, h, scale); return; }
  if (!sourceDims(source)) return; // not decoded yet: keep black rather than flashing a placeholder
  const rot = normRotation(item.rotation);
  const swap = rot === 90 || rot === 270;
  const sw = _dims.w, sh = _dims.h;
  const rw = swap ? sh : sw, rh = swap ? sw : sh;
  const D = containRect(rw, rh, w, h, scale, _box);
  const dx = D.x, dy = D.y, dw = D.w, dh = D.h;

  // Pan & zoom crop in rotated space, mapped back to source space.
  panZoomRect(item.panZoom || 'none', clamp01(lt / dur), rw, rh, dw, dh, segment.index | 0, _crop);
  let cx, cy, cw, ch;
  const u0 = _crop.sx, v0 = _crop.sy, u1 = _crop.sx + _crop.sw, v1 = _crop.sy + _crop.sh;
  if (rot === 90) { cx = v0; cw = v1 - v0; cy = sh - u1; ch = u1 - u0; }
  else if (rot === 180) { cx = sw - u1; cw = u1 - u0; cy = sh - v1; ch = v1 - v0; }
  else if (rot === 270) { cx = sw - v1; cw = v1 - v0; cy = u0; ch = u1 - u0; }
  else { cx = u0; cw = u1 - u0; cy = v0; ch = v1 - v0; }
  // Keep the source rect inside the image (Safari refuses out-of-bounds rects).
  if (cx < 0) cx = 0;
  if (cy < 0) cy = 0;
  if (cx + cw > sw) cw = sw - cx;
  if (cy + ch > sh) ch = sh - cy;
  if (!(cw > 0 && ch > 0)) return;

  const css = cssFilterFor(effect, brightness);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  applyEffectTransform(ctx, effect, lt, dur, w, h);
  if (css) ctx.filter = css;
  ctx.imageSmoothingEnabled = true;
  ctx.translate(dx + dw / 2, dy + dh / 2);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  const W = swap ? dh : dw, H = swap ? dw : dh;
  try {
    ctx.drawImage(source, cx, cy, cw, ch, -W / 2, -H / 2, W, H);
  } catch (err) {
    // e.g. a closed ImageBitmap or a video in an error state
    ctx.restore();
    warnOnce('drawImage', err);
    drawPlaceholder(ctx, item, o.getMedia, w, h, scale);
    return;
  }
  ctx.restore();

  if (effect !== 'none' || (!css && brightness)) {
    _fx.brightness = brightness; _fx.localT = lt; _fx.duration = dur; _fx.quality = quality;
    _fx.colorDone = !!css; _fx.scale = scale;
    if (effectKind(effect) === 'transform') {
      // Content may have moved outside its letterbox rect (spin / ease); brightness keeps
      // black black, so post-process the whole frame.
      _fx.x = 0; _fx.y = 0;
      applyEffect(ctx, effect, w, h, _fx);
    } else {
      _fx.x = dx; _fx.y = dy;
      applyEffect(ctx, effect, dw, dh, _fx);
    }
  }
}

/**
 * Draw one segment as a complete opaque w×h frame: black letterbox, content fitted with
 * "contain", rotation, pan & zoom, visual effect, brightness and (for titles) the
 * animated title text.
 * opts: { quality: 'preview'|'export', getMedia, hideTextIds, scale? (device px per unit) }
 */
export function drawSegment(ctx, segment, source, localT, w, h, opts) {
  if (!ctx || !(w > 0) || !(h > 0)) return;
  const o = opts || EMPTY;
  const item = segment && segment.item;
  ctx.save();
  try {
    ctx.globalCompositeOperation = 'source-over';
    if (supportsCtxFilter()) ctx.filter = 'none';
    if (!item) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); return; }
    const dur = segment.duration > 0 ? segment.duration : (item.duration > 0 ? item.duration : 1);
    let lt = +localT || 0;
    if (lt < 0) lt = 0; else if (lt > dur) lt = dur;
    const effect = item.effect || 'none';
    let brightness = +item.brightness || 0;
    if (brightness > 100) brightness = 100; else if (brightness < -100) brightness = -100;
    const quality = o.quality === 'export' ? 'export' : 'preview';
    const scale = o.scale > 0 ? o.scale : ctxScaleOf(ctx);
    if (item.kind === 'title') drawTitleSegment(ctx, item, lt, dur, w, h, o, effect, brightness, quality, scale);
    else drawVisualSegment(ctx, item, segment, source, lt, dur, w, h, o, effect, brightness, quality, scale);
    if (effectKind(effect) === 'fade') drawEffectOverlay(ctx, effect, lt, dur, w, h);
  } catch (err) {
    warnOnce('drawSegment', err);
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Frame rendering

const _segOpts = { quality: 'preview', getMedia: null, hideTextIds: null, scale: 1 };
const _textArgs = { text: '', style: null, effect: 'none', localT: 0, duration: 1, w: 0, h: 0, kind: 'caption' };
const _layerA = new Scratch(false);
const _layerB = new Scratch(false);
const _trOpts = { from: null, to: null, quality: 'preview' };
let _cbW = 1, _cbH = 1;
const _drawFrom = (c) => { if (_layerA.canvas) c.drawImage(_layerA.canvas, 0, 0, _cbW, _cbH); };
const _drawTo = (c) => { if (_layerB.canvas) c.drawImage(_layerB.canvas, 0, 0, _cbW, _cbH); };

function sourceFor(getSource, seg) {
  if (!seg || !seg.item || seg.item.kind === 'title' || typeof getSource !== 'function') return null;
  try { return getSource(seg) || null; } catch (err) { warnOnce('getSource', err); return null; }
}

function renderTransition(ctx, t, w, h, scale, getSource) {
  const prev = _active[0], cur = _active[1];
  const tr = cur.transitionIn;
  if (!tr || !(tr.duration > 0) || !tr.type || tr.type === 'none') {
    drawSegment(ctx, cur, sourceFor(getSource, cur), t - cur.start, w, h, _segOpts);
    return;
  }
  const p = clamp01((t - cur.start) / tr.duration);
  const lw = Math.max(1, Math.round(w * scale)), lh = Math.max(1, Math.round(h * scale));
  const A = _layerA.ensure(lw, lh, true), B = _layerB.ensure(lw, lh, true);
  if (!A || !B) {
    // No scratch canvases available: degrade to an alpha crossfade.
    drawSegment(ctx, prev, sourceFor(getSource, prev), t - prev.start, w, h, _segOpts);
    ctx.save();
    ctx.globalAlpha = p;
    drawSegment(ctx, cur, sourceFor(getSource, cur), t - cur.start, w, h, _segOpts);
    ctx.restore();
    return;
  }
  const savedScale = _segOpts.scale;
  _segOpts.scale = lw / w;
  A.ctx.setTransform(lw / w, 0, 0, lh / h, 0, 0);
  B.ctx.setTransform(lw / w, 0, 0, lh / h, 0, 0);
  drawSegment(A.ctx, prev, sourceFor(getSource, prev), t - prev.start, w, h, _segOpts);
  drawSegment(B.ctx, cur, sourceFor(getSource, cur), t - cur.start, w, h, _segOpts);
  _segOpts.scale = savedScale;
  _cbW = w; _cbH = h;
  _trOpts.from = A.canvas; _trOpts.to = B.canvas; _trOpts.quality = _segOpts.quality;
  drawTransition(ctx, tr.type, p, _drawFrom, _drawTo, w, h, _trOpts);
  _trOpts.from = null; _trOpts.to = null;
}

function drawOverlayTexts(ctx, timeline, t, w, h, hide) {
  const texts = timeline && timeline.texts;
  if (!texts || !texts.length) return;
  for (let i = 0; i < texts.length; i++) {
    const e = texts[i];
    const item = e && e.item;
    if (!item || !(t >= e.start && t < e.end) || hasId(hide, item.id)) continue;
    _textArgs.text = item.text;
    _textArgs.style = item.style || null;
    _textArgs.effect = item.effect || 'none';
    _textArgs.localT = t - e.start;
    _textArgs.duration = e.end - e.start;
    _textArgs.w = w; _textArgs.h = h;
    _textArgs.kind = item.kind || 'caption';
    drawText(ctx, _textArgs);
  }
}

/**
 * Render the movie frame at time t (seconds).
 * opts: { project, timeline, width, height, getSource(segment), getMedia(id),
 *         quality: 'preview'|'export', hideTextIds?: Set<string> }
 */
export function renderFrame(ctx, t, opts) {
  if (!ctx || !opts) return;
  const canvas = ctx.canvas;
  let w = +opts.width, h = +opts.height;
  if (!(w > 0 && h > 0)) { w = canvas ? canvas.width : 0; h = canvas ? canvas.height : 0; }
  if (!(w > 0 && h > 0)) return;
  t = +t || 0;
  ctx.save();
  try {
    let scale = 1;
    let m = null;
    if (typeof ctx.getTransform === 'function') { try { m = ctx.getTransform(); } catch (_) { m = null; } }
    if (m) {
      const identity = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
      if (identity && canvas && (Math.abs(canvas.width - w) > 1 || Math.abs(canvas.height - h) > 1)) {
        ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
        scale = canvas.width / w;
      } else {
        scale = Math.hypot(m.a, m.b) || 1;
      }
    } else if (canvas && canvas.width > 0) {
      scale = canvas.width / w;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (supportsCtxFilter()) ctx.filter = 'none';
    const quality = opts.quality === 'export' ? 'export' : 'preview';
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = quality === 'export' ? 'high' : 'medium';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    _segOpts.quality = quality;
    _segOpts.getMedia = typeof opts.getMedia === 'function' ? opts.getMedia : null;
    _segOpts.hideTextIds = opts.hideTextIds || null;
    _segOpts.scale = scale;

    const n = collectActive(opts.timeline, t);
    if (n === 1) {
      const seg = _active[0];
      drawSegment(ctx, seg, sourceFor(opts.getSource, seg), t - seg.start, w, h, _segOpts);
    } else if (n === 2) {
      renderTransition(ctx, t, w, h, scale, opts.getSource);
    }
    drawOverlayTexts(ctx, opts.timeline, t, w, h, opts.hideTextIds);
  } catch (err) {
    warnOnce('renderFrame', err);
  } finally {
    _segOpts.getMedia = null;
    _segOpts.hideTextIds = null;
    ctx.restore();
  }
}
