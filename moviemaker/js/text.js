// text.js — title / caption / credits layout and animated drawing.
//
// Contract:
//   drawText(ctx, { text, style, effect, localT, duration, w, h, kind })
//   measureTextBox(ctx, { text, style, w, h }) -> { x, y, width, height }
//
// Font size = style.size % of the frame height. Lines wrap to the frame width minus a
// 5% safe margin on each side. Every TEXT_EFFECTS id animates an "in" phase at the start
// and an "out" phase at the end of the item; 'scroll' (credits) and 'ticker' move over the
// whole duration.

export const DEFAULT_TEXT_STYLE = Object.freeze({
  font: 'Segoe UI, Arial, sans-serif',
  size: 8,
  bold: false,
  italic: false,
  color: '#ffffff',
  outline: 'none',
  outlineColor: '#000000',
  align: 'center',
  valign: 'middle',
  opacity: 1,
  background: null,
});

const OUTLINE = { none: 0, thin: 0.045, medium: 0.08, thick: 0.13 }; // relative to font px (each side)
const LINE_HEIGHT = 1.22;
const MARGIN_X = 0.05;   // of frame width
const MARGIN_Y = 0.06;   // of frame height
const TAU = Math.PI * 2;
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
  '-apple-system', 'blinkmacsystemfont']);

function clamp01(v) { return v <= 0 ? 0 : v >= 1 ? 1 : v; }
function smooth(p) { p = clamp01(p); return p * p * (3 - 2 * p); }
function easeOutCubic(p) { p = clamp01(p); const q = 1 - p; return 1 - q * q * q; }
function easeInCubic(p) { p = clamp01(p); return p * p * p; }
function easeOutBack(p) { p = clamp01(p); const c1 = 1.70158, c3 = c1 + 1; const q = p - 1; return 1 + c3 * q * q * q + c1 * q * q; }
function easeOutBounce(p) {
  p = clamp01(p);
  const n1 = 7.5625, d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) { p -= 1.5 / d1; return n1 * p * p + 0.75; }
  if (p < 2.5 / d1) { p -= 2.25 / d1; return n1 * p * p + 0.9375; }
  p -= 2.625 / d1; return n1 * p * p + 0.984375;
}

function sv(style, key) {
  const v = style ? style[key] : undefined;
  return v === undefined || v === null || v === '' ? DEFAULT_TEXT_STYLE[key] : v;
}

// --- font strings ---------------------------------------------------------------

const _familyCache = new Map();
/** Quote every non-generic family name so the canvas font shorthand always parses. */
function safeFamily(family) {
  let out = _familyCache.get(family);
  if (out) return out;
  const parts = String(family || '').split(',');
  const res = [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    if (/^["'].*["']$/.test(p)) p = p.slice(1, -1);
    p = p.replace(/["\\]/g, '');
    if (!p) continue;
    res.push(GENERIC.has(p.toLowerCase()) ? p : '"' + p + '"');
  }
  if (!res.some((f) => GENERIC.has(f.toLowerCase()))) res.push('sans-serif');
  out = res.join(', ');
  if (_familyCache.size > 64) _familyCache.clear();
  _familyCache.set(family, out);
  return out;
}

function fontPx(style, h) {
  let size = +sv(style, 'size');
  if (!(size > 0)) size = DEFAULT_TEXT_STYLE.size;
  if (size > 80) size = 80;
  return Math.max(4, (size / 100) * h);
}

function fontString(style, px) {
  return (sv(style, 'italic') ? 'italic ' : '') + (sv(style, 'bold') ? 'bold ' : '') +
    (Math.round(px * 10) / 10) + 'px ' + safeFamily(sv(style, 'font'));
}

// --- layout cache -----------------------------------------------------------------

const LAYOUT_CACHE = 32;
const _layouts = [];
const HAS_FONTS = typeof document !== 'undefined' && !!document.fonts;

function splitChars(s) { return Array.from(s); }

function wrapParagraph(ctx, para, maxW, lines) {
  const words = para.split(' ');
  let line = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (line === null) {
      line = word;
    } else {
      const test = line + ' ' + word;
      if (ctx.measureText(test).width <= maxW) { line = test; continue; }
      lines.push(line);
      line = word;
    }
    // A single word wider than the frame: break it by characters.
    if (line.length > 1 && ctx.measureText(line).width > maxW) {
      let chars = splitChars(line);
      while (chars.length > 1 && ctx.measureText(chars.join('')).width > maxW) {
        let lo = 1, hi = chars.length - 1, fit = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (ctx.measureText(chars.slice(0, mid).join('')).width <= maxW) { fit = mid; lo = mid + 1; } else hi = mid - 1;
        }
        lines.push(chars.slice(0, fit).join(''));
        chars = chars.slice(fit);
      }
      line = chars.join('');
    }
  }
  lines.push(line === null ? '' : line);
}

function layoutText(ctx, text, font, maxW) {
  for (let i = 0; i < _layouts.length; i++) {
    const e = _layouts[i];
    if (e.text === text && e.font === font && Math.abs(e.maxW - maxW) < 0.5) {
      for (let j = i; j > 0; j--) _layouts[j] = _layouts[j - 1];
      _layouts[0] = e;
      return e;
    }
  }
  ctx.font = font;
  const lines = [];
  const paras = text.replace(/\r\n?/g, '\n').split('\n');
  for (const para of paras) wrapParagraph(ctx, para, maxW, lines);
  const widths = new Float32Array(lines.length);
  let blockW = 0, chars = 0;
  for (let i = 0; i < lines.length; i++) {
    const lw = lines[i] ? ctx.measureText(lines[i]).width : 0;
    widths[i] = lw;
    if (lw > blockW) blockW = lw;
    chars += splitChars(lines[i]).length;
  }
  const entry = { text, font, maxW, lines, widths, blockW, chars };
  // Do not cache metrics measured while web fonts are still loading.
  if (!(HAS_FONTS && document.fonts.status === 'loading')) {
    if (_layouts.length >= LAYOUT_CACHE) _layouts.pop();
    _layouts.unshift(entry);
  }
  return entry;
}

// --- geometry -----------------------------------------------------------------------

const _g = { px: 0, lh: 0, blockW: 0, blockH: 0, left: 0, top: 0, af: 0.5, padX: 0, padY: 0, layout: null, font: '' };

function geometry(ctx, text, style, w, h, noWrap) {
  const px = fontPx(style, h);
  const font = fontString(style, px);
  const mx = w * MARGIN_X, my = h * MARGIN_Y;
  const maxW = noWrap ? 1e7 : Math.max(px, w - 2 * mx);
  const L = layoutText(ctx, text, font, maxW);
  const lh = px * LINE_HEIGHT;
  const blockW = L.blockW, blockH = L.lines.length * lh;
  const align = sv(style, 'align'), valign = sv(style, 'valign');
  const af = align === 'left' ? 0 : align === 'right' ? 1 : 0.5;
  const left = align === 'left' ? mx : align === 'right' ? w - mx - blockW : (w - blockW) / 2;
  const top = valign === 'top' ? my : valign === 'bottom' ? h - my - blockH : (h - blockH) / 2;
  _g.px = px; _g.lh = lh; _g.blockW = blockW; _g.blockH = blockH;
  _g.left = left; _g.top = top; _g.af = af; _g.layout = L; _g.font = font;
  _g.padX = px * 0.35; _g.padY = px * 0.15;
  return _g;
}

// --- animation ---------------------------------------------------------------------

const _a = { alpha: 1, dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, pvx: 0, pvy: 0, clip: false, clip0: 0, clip1: 0, chars: -1, bars: 0, top: NaN, left: NaN };

function animate(effect, localT, duration, g, w, h) {
  const a = _a;
  a.alpha = 1; a.dx = 0; a.dy = 0; a.sx = 1; a.sy = 1; a.rot = 0;
  a.pvx = g.left + g.blockW / 2; a.pvy = g.top + g.blockH / 2;
  a.clip = false; a.clip0 = 0; a.clip1 = 0; a.chars = -1; a.bars = 0; a.top = NaN; a.left = NaN;
  const D = duration;
  const io = Math.min(1.0, Math.max(0.25, D * 0.25));
  const pin = clamp01(localT / io);                 // 0 → 1 during the in phase
  const pout = clamp01((D - localT) / io);          // 1 → 0 during the out phase
  const left = g.left, top = g.top, bw = g.blockW, bh = g.blockH, px = g.px;
  switch (effect) {
    case 'fade':
      a.alpha = Math.min(smooth(pin), smooth(pout));
      break;
    case 'fly-left':
      if (pin < 1) a.dx = -(1 - easeOutCubic(pin)) * (left + bw + px);
      else if (pout < 1) a.dx = easeInCubic(1 - pout) * (w - left + px);
      break;
    case 'fly-right':
      if (pin < 1) a.dx = (1 - easeOutCubic(pin)) * (w - left + px);
      else if (pout < 1) a.dx = -easeInCubic(1 - pout) * (left + bw + px);
      break;
    case 'fly-up':
      if (pin < 1) a.dy = (1 - easeOutCubic(pin)) * (h - top + px);
      else if (pout < 1) a.dy = -easeInCubic(1 - pout) * (top + bh + px);
      break;
    case 'fly-down':
      if (pin < 1) a.dy = -(1 - easeOutCubic(pin)) * (top + bh + px);
      else if (pout < 1) a.dy = easeInCubic(1 - pout) * (h - top + px);
      break;
    case 'zoom-in':
      if (pin < 1) { a.sx = a.sy = 0.2 + 0.8 * easeOutCubic(pin); a.alpha = smooth(pin * 1.4); }
      else if (pout < 1) { a.sx = a.sy = 1 + 1.4 * easeInCubic(1 - pout); a.alpha = smooth(pout); }
      break;
    case 'zoom-out':
      if (pin < 1) { a.sx = a.sy = 2.6 - 1.6 * easeOutCubic(pin); a.alpha = smooth(pin * 1.4); }
      else if (pout < 1) { a.sx = a.sy = 0.25 + 0.75 * smooth(pout); a.alpha = smooth(pout); }
      break;
    case 'typewriter': {
      const reveal = Math.min(D * 0.6, Math.max(0.6, g.layout.chars * 0.055));
      a.chars = Math.floor(g.layout.chars * clamp01(localT / reveal) + 1e-6);
      if (localT >= reveal) a.chars = -1;
      a.alpha = smooth(pout);
      break;
    }
    case 'stretch':
      if (pin < 1) { a.sy = Math.max(0.001, easeOutBack(pin)); a.sx = 1 + 0.6 * (1 - pin); a.alpha = smooth(pin * 2); }
      else if (pout < 1) { a.sy = Math.max(0.001, smooth(pout)); a.sx = 1 + 0.6 * (1 - pout); a.alpha = smooth(pout * 2); }
      break;
    case 'swing': {
      const sd = Math.min(1.6, Math.max(0.4, D * 0.4));
      const x = clamp01(localT / sd);
      a.pvx = left + bw / 2; a.pvy = top - g.padY;
      a.rot = x < 1 ? -(Math.PI / 2.1) * Math.exp(-3.2 * x) * Math.cos(3.4 * Math.PI * x) * (1 - x) : 0;
      a.alpha = Math.min(smooth(x * 6), smooth(pout));
      break;
    }
    case 'wipe': {
      const x0 = left - g.padX, full = bw + 2 * g.padX;
      if (pin < 1) { a.clip = true; a.clip0 = x0; a.clip1 = x0 + full * smooth(pin); }
      else if (pout < 1) { a.clip = true; a.clip0 = x0 + full * smooth(1 - pout); a.clip1 = x0 + full; }
      break;
    }
    case 'scroll':
      a.top = h - (h + bh) * clamp01(localT / D);
      break;
    case 'ticker':
      a.left = w - (w + bw) * clamp01(localT / D);
      break;
    case 'cinematic': {
      const bin = smooth(localT / Math.max(0.3, io * 1.2));
      a.bars = Math.min(bin, smooth(pout));
      const tin = clamp01((localT - io * 0.35) / io);
      a.alpha = Math.min(smooth(tin), smooth(pout));
      a.sx = a.sy = 1.06 - 0.06 * easeOutCubic(tin);
      break;
    }
    case 'spin':
      if (pin < 1) { const e = easeOutCubic(pin); a.rot = -(1 - e) * TAU; a.sx = a.sy = 0.15 + 0.85 * e; a.alpha = smooth(pin * 2); }
      else if (pout < 1) { a.alpha = smooth(pout); a.sx = a.sy = 0.6 + 0.4 * pout; }
      break;
    case 'bounce': {
      const bd = Math.min(1.4, Math.max(0.4, D * 0.35));
      const x = clamp01(localT / bd);
      if (x < 1) a.dy = -(1 - easeOutBounce(x)) * (top + bh + px);
      a.alpha = smooth(pout);
      break;
    }
    default:
      break;
  }
  return a;
}

// --- drawing -------------------------------------------------------------------------

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Draw (animated) text into the frame 0..w × 0..h of ctx.
 * args: { text, style, effect, localT, duration, w, h, kind }
 */
export function drawText(ctx, args) {
  if (!ctx || !args) return;
  const text = args.text == null ? '' : String(args.text);
  if (!text.trim()) return;
  const w = +args.w || 0, h = +args.h || 0;
  if (!(w > 0 && h > 0)) return;
  const style = args.style || DEFAULT_TEXT_STYLE;
  const effect = args.effect || 'none';
  const duration = args.duration > 0 ? +args.duration : 1;
  let localT = +args.localT || 0;
  if (localT < 0) localT = 0; else if (localT > duration) localT = duration;

  ctx.save();
  try {
    const g = geometry(ctx, text, style, w, h, effect === 'ticker');
    const a = animate(effect, localT, duration, g, w, h);
    const top = Number.isNaN(a.top) ? g.top : a.top;
    const left = Number.isNaN(a.left) ? g.left : a.left;
    // movement for scroll/ticker shifts the pivot along with the block
    a.pvx += left - g.left; a.pvy += top - g.top;

    ctx.globalCompositeOperation = 'source-over';
    if (a.bars > 0) {
      const bh = h * 0.115 * a.bars;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, bh);
      ctx.fillRect(0, h - bh, w, bh);
    }
    let opacity = +sv(style, 'opacity');
    if (!(opacity >= 0)) opacity = 1;
    const alpha = clamp01(opacity) * clamp01(a.alpha);
    if (alpha <= 0.002 || a.chars === 0) return;
    ctx.globalAlpha *= alpha;

    if (a.dx || a.dy) ctx.translate(a.dx, a.dy);
    if (a.rot || a.sx !== 1 || a.sy !== 1) {
      ctx.translate(a.pvx, a.pvy);
      if (a.rot) ctx.rotate(a.rot);
      ctx.scale(Math.max(1e-4, a.sx), Math.max(1e-4, a.sy));
      ctx.translate(-a.pvx, -a.pvy);
    }
    if (a.clip) {
      if (a.clip1 - a.clip0 <= 0.5) return;
      ctx.beginPath();
      ctx.rect(a.clip0 + (left - g.left), top - g.padY - g.px, a.clip1 - a.clip0, g.blockH + 2 * (g.padY + g.px));
      ctx.clip();
    }

    const bg = style && style.background;
    if (bg) {
      ctx.fillStyle = '#000';
      ctx.fillStyle = bg;
      roundRectPath(ctx, left - g.padX, top - g.padY, g.blockW + 2 * g.padX, g.blockH + 2 * g.padY, g.px * 0.18);
      ctx.fill();
    }

    ctx.font = g.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = sv(style, 'color');
    const ow = OUTLINE[sv(style, 'outline')] || 0;
    if (ow > 0) {
      ctx.strokeStyle = '#000000';
      ctx.strokeStyle = sv(style, 'outlineColor');
      ctx.lineWidth = Math.max(1, g.px * ow * 2);
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
    }
    const L = g.layout;
    let remaining = a.chars;
    for (let i = 0; i < L.lines.length; i++) {
      let line = L.lines[i];
      if (!line) continue;
      if (remaining >= 0) {
        if (remaining === 0) break;
        const chars = Array.from(line);
        if (chars.length > remaining) { line = chars.slice(0, remaining).join(''); remaining = 0; } else remaining -= chars.length;
      }
      const lx = left + (g.blockW - L.widths[i]) * g.af;
      const ly = top + g.lh * (i + 0.5);
      if (ly < -g.lh || ly > h + g.lh) continue; // off-screen (scrolling credits)
      if (ow > 0) ctx.strokeText(line, lx, ly);
      ctx.fillText(line, lx, ly);
    }
  } catch (err) {
    try { console.warn('[movie maker] text:', err && err.message ? err.message : err); } catch (_) { /* ignore */ }
  } finally {
    ctx.restore();
  }
}

/**
 * Static (non-animated) box of the text block, including the background padding.
 * Used for hit-testing and positioning the inline editor. Empty text yields a box
 * the size of one line so there is always something to tap.
 */
export function measureTextBox(ctx, args) {
  const out = { x: 0, y: 0, width: 0, height: 0 };
  if (!ctx || !args) return out;
  const w = +args.w || 0, h = +args.h || 0;
  if (!(w > 0 && h > 0)) return out;
  const style = args.style || DEFAULT_TEXT_STYLE;
  const raw = args.text == null ? '' : String(args.text);
  const empty = !raw.trim();
  ctx.save();
  try {
    const g = geometry(ctx, empty ? 'M' : raw, style, w, h, false);
    let left = g.left, bw = g.blockW;
    if (empty) {
      bw = Math.max(bw, w * 0.3);
      left = g.af === 0 ? w * MARGIN_X : g.af === 1 ? w - w * MARGIN_X - bw : (w - bw) / 2;
    }
    out.x = left - g.padX;
    out.y = g.top - g.padY;
    out.width = bw + 2 * g.padX;
    out.height = g.blockH + 2 * g.padY;
  } catch (_) {
    out.x = w * 0.1; out.y = h * 0.4; out.width = w * 0.8; out.height = h * 0.2;
  } finally {
    ctx.restore();
  }
  return out;
}

/** Font size in pixels for a style in a frame of height h (helper for inline editors). */
export function textFontPx(style, h) { return fontPx(style, h); }

/** CSS font shorthand used for a style at frame height h (helper for inline editors). */
export function textFontCss(style, h) { return fontString(style, fontPx(style, h)); }
