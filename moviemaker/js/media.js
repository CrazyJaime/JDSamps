// Movie Maker (web) — media import: file picking, type detection, metadata,
// thumbnails, filmstrips and waveform peaks. Everything runs locally.

import { uid } from './model.js';

export const ACCEPT_VISUAL = 'video/*,image/*';
export const ACCEPT_AUDIO = 'audio/*,video/*'; // music may come from a video file's soundtrack

export const PEAKS_PER_SECOND = 20;
export const THUMB_MAX_W = 160;
export const THUMB_MAX_H = 240;
export const FILMSTRIP_MAX = 8;

const METADATA_TIMEOUT = 15000;
const SEEK_TIMEOUT = 3000;
const FIRST_SEEK_TIMEOUT = 5000;
const IMAGE_TIMEOUT = 20000;
const DECODE_TIMEOUT = 60000;
const FOCUS_CANCEL_DELAY = 2500;
const MAX_IMAGE_SIDE = 3840;           // phones can't hold 48MP bitmaps; downscale big photos
const MAX_IMAGE_PIXELS = 3840 * 2880;
const AUTO_PEAKS_MAX_BYTES = 150 * 1024 * 1024;   // auto-compute video waveform below this size
const PEAKS_MAX_BYTES = 600 * 1024 * 1024;        // never try to decode more than this
const PEAKS_MAX_SECONDS = 3 * 3600;
const PEAKS_SAMPLE_RATES = [8000, 22050, 44100];
const JPEG_QUALITY = 0.72;

/** Error with a message that can be shown to the user as-is. */
export class MediaImportError extends Error {
  constructor(message, { code = 'unsupported', fileName = '', cause } = {}) {
    super(message);
    this.name = 'MediaImportError';
    this.code = code;
    this.fileName = fileName;
    this.friendly = true;
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------
const EXT_MIME = {
  // video
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp', '3gpp': 'video/3gpp', '3g2': 'video/3gpp2', ogv: 'video/ogg',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t', flv: 'video/x-flv',
  // image
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', dib: 'image/bmp', heic: 'image/heic', heif: 'image/heif', hif: 'image/heif',
  avif: 'image/avif', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', wave: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  wma: 'audio/x-ms-wma', aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff', caf: 'audio/x-caf',
  amr: 'audio/amr', mka: 'audio/x-matroska',
};
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-unknown',
  'application/unknown', 'application/force-download']);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function typeFromMime(mime) {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/ogg') return 'audio';
  if (m === 'application/mp4') return 'video';
  return null;
}

/**
 * Synchronous best-effort detection from MIME type, then file extension.
 * Returns { type: 'video'|'image'|'audio', mime } or null.
 */
export function detectMediaType(file) {
  if (!file) return null;
  const rawMime = String(file.type || '').toLowerCase().split(';')[0].trim();
  const ext = extOf(file.name);
  if (!GENERIC_MIMES.has(rawMime)) {
    const type = typeFromMime(rawMime);
    if (type) return { type, mime: rawMime };
  }
  const extMime = EXT_MIME[ext];
  if (extMime) return { type: typeFromMime(extMime), mime: extMime };
  return null;
}

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Magic-byte sniffing for files with no usable MIME type or extension. */
async function sniffType(file) {
  let bytes;
  try {
    bytes = new Uint8Array(await readArrayBuffer(file.slice(0, 64)));
  } catch (_) { return null; }
  if (bytes.length < 4) return null;
  const head = ascii(bytes, 0, 64);
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image', mime: 'image/jpeg' };
  if (b[0] === 0x89 && head.slice(1, 4) === 'PNG') return { type: 'image', mime: 'image/png' };
  if (head.startsWith('GIF8')) return { type: 'image', mime: 'image/gif' };
  if (head.startsWith('RIFF')) {
    const kind = head.slice(8, 12);
    if (kind === 'WEBP') return { type: 'image', mime: 'image/webp' };
    if (kind === 'WAVE') return { type: 'audio', mime: 'audio/wav' };
    if (kind === 'AVI ') return { type: 'video', mime: 'video/x-msvideo' };
  }
  if (head.slice(4, 8) === 'ftyp') {
    const brand = head.slice(8, 12);
    const brands = head.slice(8, 40);
    if (/avif|avis/.test(brands)) return { type: 'image', mime: 'image/avif' };
    if (/heic|heix|hevc|hevx|heim|heis/.test(brand)) return { type: 'image', mime: 'image/heic' };
    if (/mif1|msf1/.test(brand)) return { type: 'image', mime: 'image/heif' };
    if (brand === 'qt  ') return { type: 'video', mime: 'video/quicktime' };
    if (/M4A |M4B |M4P /.test(brand)) return { type: 'audio', mime: 'audio/mp4' };
    if (brand.startsWith('3g')) return { type: 'video', mime: 'video/3gpp' };
    return { type: 'video', mime: 'video/mp4' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return head.includes('webm') ? { type: 'video', mime: 'video/webm' } : { type: 'video', mime: 'video/x-matroska' };
  }
  if (head.startsWith('OggS')) {
    return head.includes('theora') ? { type: 'video', mime: 'video/ogg' } : { type: 'audio', mime: 'audio/ogg' };
  }
  if (head.startsWith('fLaC')) return { type: 'audio', mime: 'audio/flac' };
  if (head.startsWith('ID3')) return { type: 'audio', mime: 'audio/mpeg' };
  if (head.startsWith('FORM') && /AIF[FC]/.test(head.slice(8, 12))) return { type: 'audio', mime: 'audio/aiff' };
  if (head.startsWith('#!AMR')) return { type: 'audio', mime: 'audio/amr' };
  if (head.startsWith('caff')) return { type: 'audio', mime: 'audio/x-caf' };
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { type: 'video', mime: 'video/x-ms-wmv' };
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) return { type: 'video', mime: 'video/mpeg' };
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { type: 'audio', mime: 'audio/aac' };
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { type: 'audio', mime: 'audio/mpeg' };
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg/i.test(head) || (/^\s*<\?xml/i.test(head) && /svg/i.test(head))) {
    return { type: 'image', mime: 'image/svg+xml' };
  }
  if (head.startsWith('BM') && bytes.length >= 26) return { type: 'image', mime: 'image/bmp' };
  return null;
}

// ---------------------------------------------------------------------------
// Small async helpers
// ---------------------------------------------------------------------------
function readArrayBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('Could not read the file'));
    fr.readAsArrayBuffer(blob);
  });
}

function withTimeout(promise, ms, onTimeoutValue) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeoutValue), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Wait for one of `okTypes` (resolves with the event type) or one of `errTypes`
 * (rejects). Resolves 'timeout' after `ms`. Listeners are always removed.
 */
function waitFor(target, okTypes, errTypes, ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      for (const t of okTypes) target.removeEventListener(t, onOk);
      for (const t of errTypes) target.removeEventListener(t, onErr);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onOk = (e) => { cleanup(); resolve(e.type); };
    const onErr = (e) => { cleanup(); reject(target.error || e); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    for (const t of okTypes) target.addEventListener(t, onOk);
    for (const t of errTypes) target.addEventListener(t, onErr);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort);
    }
    timer = setTimeout(() => { cleanup(); resolve('timeout'); }, ms);
  });
}

function abortError() {
  try { return new DOMException('The import was cancelled.', 'AbortError'); } catch (_) {
    const e = new Error('The import was cancelled.');
    e.name = 'AbortError';
    return e;
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

// ---------------------------------------------------------------------------
// Canvas helpers (thumbnails / placeholders)
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function releaseCanvas(c) {
  // iOS keeps canvas backing stores alive until resized; free memory eagerly.
  try { c.width = 0; c.height = 0; } catch (_) { /* ignore */ }
}

/** Thumbnail size: ~160px wide for landscape, at most 240px tall for portrait. */
export function thumbSize(w, h) {
  if (!(w > 0) || !(h > 0)) return { width: THUMB_MAX_W, height: Math.round(THUMB_MAX_W * 9 / 16) };
  const s = Math.min(THUMB_MAX_W / w, THUMB_MAX_H / h);
  return { width: Math.max(2, Math.round(w * s)), height: Math.max(2, Math.round(h * s)) };
}

function toJpeg(canvas, q = JPEG_QUALITY) {
  try {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url && url.startsWith('data:image/jpeg')) return url;
    return canvas.toDataURL();
  } catch (_) { return ''; }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    const fallback = () => {
      try {
        const url = canvas.toDataURL(type, quality);
        resolve(dataUrlToBlob(url));
      } catch (_) { resolve(null); }
    };
    if (typeof canvas.toBlob === 'function') {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : fallback()), type, quality);
      } catch (_) { fallback(); }
    } else fallback();
  });
}

export function dataUrlToBlob(url) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url || '');
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type: mime });
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Self-drawn placeholder tile (no external artwork). kind: 'video'|'audio'|'image'. */
export function placeholderThumb(kind, peaks = null, w = THUMB_MAX_W, h = 90) {
  if (typeof document === 'undefined') return '';
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const g = ctx.createLinearGradient(0, 0, 0, h);
  if (kind === 'audio') { g.addColorStop(0, '#5fbf4a'); g.addColorStop(1, '#2f7f24'); }
  else { g.addColorStop(0, '#3a4250'); g.addColorStop(1, '#1b1f27'); }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  if (kind === 'audio') {
    if (peaks && peaks.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      const bars = Math.min(w, peaks.length);
      const per = peaks.length / bars;
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        let m = 0;
        const s = Math.floor(i * per);
        const e = Math.max(s + 1, Math.floor((i + 1) * per));
        for (let j = s; j < e && j < peaks.length; j++) if (peaks[j] > m) m = peaks[j];
        const bh = Math.max(1, m * h * 0.8);
        ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
      }
    }
    // music note glyph
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, h * 0.04);
    const cx = w / 2, cy = h / 2, r = h * 0.1;
    ctx.beginPath(); ctx.ellipse(cx - r * 1.6, cy + h * 0.18, r * 1.2, r * 0.9, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + r * 1.6, cy + h * 0.12, r * 1.2, r * 0.9, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy + h * 0.18); ctx.lineTo(cx - r * 0.5, cy - h * 0.25);
    ctx.lineTo(cx + r * 2.7, cy - h * 0.31); ctx.lineTo(cx + r * 2.7, cy + h * 0.12);
    ctx.stroke();
  } else {
    // film strip perforations + play triangle
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    const ph = h * 0.08, pw = w * 0.05;
    for (let x = pw * 0.5; x < w; x += pw * 2) {
      ctx.fillRect(x, h * 0.04, pw, ph);
      ctx.fillRect(x, h - h * 0.04 - ph, pw, ph);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(w / 2 - h * 0.12, h / 2 - h * 0.16);
    ctx.lineTo(w / 2 + h * 0.16, h / 2);
    ctx.lineTo(w / 2 - h * 0.12, h / 2 + h * 0.16);
    ctx.closePath();
    ctx.fill();
  }
  const url = toJpeg(c, 0.8);
  releaseCanvas(c);
  return url;
}

// ---------------------------------------------------------------------------
// File picking (works on iOS / Android: the input lives in the DOM while open)
// ---------------------------------------------------------------------------
let activePick = null;

/**
 * Open the system file picker. Must be called from a user gesture.
 * Resolves with the chosen files, or [] when the user cancels.
 */
export function pickFiles(accept = ACCEPT_VISUAL, multiple = true) {
  if (typeof document === 'undefined') return Promise.resolve([]);
  // Only one picker at a time; a stale one (e.g. iOS never reported its cancel) resolves empty.
  if (activePick) activePick([]);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.multiple = !!multiple;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    // Not display:none — some mobile browsers won't fire 'change' for hidden inputs.
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    (document.body || document.documentElement).appendChild(input);

    let done = false;
    let focusTimer = 0;
    let armTimer = 0;
    const finish = (files) => {
      if (done) return;
      done = true;
      clearTimeout(focusTimer);
      clearTimeout(armTimer);
      input.removeEventListener('change', onChange);
      input.removeEventListener('input', onChange);
      input.removeEventListener('cancel', onCancel);
      window.removeEventListener('focus', onFocusBack);
      document.removeEventListener('visibilitychange', onVisibility);
      if (activePick === finish) activePick = null;
      // Remove a moment later so late 'change' handlers on old WebKit still find the input.
      setTimeout(() => { try { input.remove(); } catch (_) { /* ignore */ } }, 1000);
      resolve(files);
    };
    const onChange = () => {
      const files = Array.from(input.files || []);
      if (files.length) finish(files);
      else finish([]);
    };
    const onCancel = () => finish([]);
    // Fallback cancel detection for browsers without the 'cancel' event: the page
    // regains focus / visibility when the picker closes. 'change' normally fires
    // before that; give slow pickers (cloud files, iOS video compression) time.
    const onFocusBack = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (done) return;
        const files = Array.from(input.files || []);
        finish(files);
      }, FOCUS_CANCEL_DELAY);
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocusBack(); };

    input.addEventListener('change', onChange);
    input.addEventListener('input', onChange);
    input.addEventListener('cancel', onCancel);
    activePick = finish;
    // Arm focus detection shortly after opening, so the click's own focus churn is ignored.
    armTimer = setTimeout(() => {
      if (done) return;
      window.addEventListener('focus', onFocusBack);
      document.addEventListener('visibilitychange', onVisibility);
    }, 300);
    try {
      input.click();
    } catch (_) {
      finish([]);
    }
  });
}

// ---------------------------------------------------------------------------
// Hidden host for probe elements (some mobile browsers only decode frames for
// elements that are in the document)
// ---------------------------------------------------------------------------
let probeHost = null;
function getProbeHost() {
  if (probeHost && probeHost.isConnected) return probeHost;
  probeHost = document.createElement('div');
  probeHost.setAttribute('aria-hidden', 'true');
  probeHost.className = 'mm-import-probe';
  probeHost.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;'
    + 'pointer-events:none;z-index:-1;';
  (document.body || document.documentElement).appendChild(probeHost);
  return probeHost;
}

function createProbeVideo() {
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.setAttribute('muted', '');
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.preload = 'metadata';
  v.style.cssText = 'width:160px;height:90px;';
  getProbeHost().appendChild(v);
  return v;
}

function disposeElement(el) {
  try { el.pause(); } catch (_) { /* ignore */ }
  try {
    el.removeAttribute('src');
    el.load();
  } catch (_) { /* ignore */ }
  try { el.remove(); } catch (_) { /* ignore */ }
}

/**
 * Some files (MediaRecorder WebM, streamed MP4) report an Infinity/NaN duration until
 * the element seeks past the end. Returns a finite duration in seconds, or 0.
 */
async function resolveDuration(el, signal) {
  let d = el.duration;
  if (Number.isFinite(d) && d > 0) return d;
  const finite = new Promise((resolve) => {
    const check = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        el.removeEventListener('durationchange', check);
        el.removeEventListener('timeupdate', check);
        el.removeEventListener('seeked', check);
        resolve(true);
      }
    };
    el.addEventListener('durationchange', check);
    el.addEventListener('timeupdate', check);
    el.addEventListener('seeked', check);
    setTimeout(() => {
      el.removeEventListener('durationchange', check);
      el.removeEventListener('timeupdate', check);
      el.removeEventListener('seeked', check);
      resolve(false);
    }, 5000);
  });
  try { el.currentTime = 1e7; } catch (_) { /* ignore */ }
  await finite;
  throwIfAborted(signal);
  d = el.duration;
  if (!(Number.isFinite(d) && d > 0)) {
    try {
      if (el.seekable && el.seekable.length) d = el.seekable.end(el.seekable.length - 1);
      if (!(Number.isFinite(d) && d > 0) && el.buffered && el.buffered.length) d = el.buffered.end(el.buffered.length - 1);
    } catch (_) { /* ignore */ }
  }
  const back = waitFor(el, ['seeked'], [], 2000);
  try { el.currentTime = 0; } catch (_) { /* ignore */ }
  await back;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Make sure a frame is decodable. iOS may need preload=auto, load() or a muted play()/pause(). */
async function ensureFrameReady(v, signal) {
  if (v.readyState >= 2) return true;
  try { v.preload = 'auto'; } catch (_) { /* ignore */ }
  // (No load() here: it would reset the element and lose a duration fixed by resolveDuration.)
  await waitFor(v, ['loadeddata', 'canplay'], [], 2500, signal);
  if (v.readyState >= 2) return true;
  try {
    // iOS only decodes frames after playback started once (muted inline playback is allowed).
    const p = v.play();
    if (p && typeof p.then === 'function') await withTimeout(p.catch(() => {}), 2500);
    if (v.readyState < 2) await waitFor(v, ['loadeddata', 'canplay', 'timeupdate', 'playing'], [], 2000, signal);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
  }
  try { v.pause(); } catch (_) { /* ignore */ }
  return v.readyState >= 2;
}

async function seekTo(v, t, timeout, signal) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2 && !v.seeking) return true;
  const p = waitFor(v, ['seeked'], [], timeout, signal);
  try { v.currentTime = t; } catch (_) { return false; }
  const r = await p;
  if (r === 'timeout') return false;
  // Safari can report 'seeked' before the new frame is ready to paint.
  if (typeof v.requestVideoFrameCallback === 'function') {
    await withTimeout(new Promise((res) => {
      try { v.requestVideoFrameCallback(() => res()); } catch (_) { res(); }
    }), 150);
  }
  return true;
}

function filmstripTimes(duration) {
  // ~2 frames per second for short clips, 8 for anything 4s or longer.
  const n = Math.max(1, Math.min(FILMSTRIP_MAX, Math.round(duration * 2)));
  const times = [];
  for (let i = 0; i < n; i++) times.push(Math.min(duration - 0.01, ((i + 0.5) * duration) / n));
  return times.map((t) => Math.max(0, t));
}

/** Capture the thumbnail + filmstrip frames from a loaded video element. */
async function captureFrames(v, duration, report, signal) {
  const { width, height } = thumbSize(v.videoWidth, v.videoHeight);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const out = { thumb: '', filmstrip: [] };
  if (!ctx) { releaseCanvas(canvas); return out; }
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'medium';
  const draw = () => {
    try {
      if (v.readyState < 2) return '';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(v, 0, 0, width, height);
      return toJpeg(canvas);
    } catch (_) { return ''; }
  };
  const times = filmstripTimes(duration);
  const thumbTime = Math.min(duration * 0.05, 0.5);
  const total = times.length + 1;
  let failures = 0;
  let last = '';
  for (let i = 0; i < total; i++) {
    throwIfAborted(signal);
    const t = i === 0 ? thumbTime : times[i - 1];
    let frame = '';
    if (failures < 2) {
      const ok = await seekTo(v, t, i === 0 ? FIRST_SEEK_TIMEOUT : SEEK_TIMEOUT, signal);
      if (ok || v.readyState >= 2) frame = draw();
      if (!ok) failures++;
      else failures = 0;
    }
    if (!frame) frame = last;
    if (i === 0) out.thumb = frame;
    else if (frame) out.filmstrip.push(frame);
    if (frame) last = frame;
    if (report) report(0.25 + 0.6 * ((i + 1) / total), 'Creating thumbnails');
  }
  releaseCanvas(canvas);
  if (!out.thumb && out.filmstrip.length) out.thumb = out.filmstrip[0];
  return out;
}

function audioTrackHint(v) {
  try {
    if (v.audioTracks && typeof v.audioTracks.length === 'number') return v.audioTracks.length > 0;
    if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
    if (typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount > 0) return true;
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Load a video URL and read metadata + frames. Resolves
 * { kind:'video'|'audio', duration, width, height, hasAudioHint, thumb, filmstrip }.
 * Rejects with { code } on unsupported / timeout.
 */
async function probeVideo(url, report, signal) {
  const v = createProbeVideo();
  try {
    const loaded = waitFor(v, ['loadedmetadata'], ['error'], METADATA_TIMEOUT, signal);
    v.src = url;
    try { v.load(); } catch (_) { /* ignore */ }
    let r;
    try {
      r = await loaded;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      const e = new Error('unsupported');
      e.code = 'unsupported';
      throw e;
    }
    if (r === 'timeout') {
      const e = new Error('timeout');
      e.code = 'timeout';
      throw e;
    }
    if (report) report(0.15, 'Reading video');
    const duration = await resolveDuration(v, signal);
    let w = v.videoWidth;
    let h = v.videoHeight;
    const ready = await ensureFrameReady(v, signal);
    if (!w || !h) { w = v.videoWidth; h = v.videoHeight; }
    const hasAudioHint = audioTrackHint(v);
    if (!w || !h) {
      if (duration > 0 && !ready && v.error) {
        const e = new Error('unsupported');
        e.code = 'unsupported';
        throw e;
      }
      // No picture track: an audio-only file in a video container.
      return { kind: 'audio', duration, width: 0, height: 0, hasAudioHint, thumb: '', filmstrip: [] };
    }
    const frames = duration > 0 ? await captureFrames(v, duration, report, signal) : { thumb: '', filmstrip: [] };
    return { kind: 'video', duration, width: w, height: h, hasAudioHint, thumb: frames.thumb, filmstrip: frames.filmstrip };
  } finally {
    disposeElement(v);
  }
}

/** Duration of an audio URL via an <audio> element; 0 if unknown. Rejects on decode error. */
async function probeAudioDuration(url, signal) {
  const a = document.createElement('audio');
  a.preload = 'metadata';
  a.muted = true;
  try {
    const loaded = waitFor(a, ['loadedmetadata'], ['error'], 10000, signal);
    a.src = url;
    try { a.load(); } catch (_) { /* ignore */ }
    const r = await loaded;
    if (r === 'timeout') return 0;
    return await resolveDuration(a, signal);
  } finally {
    disposeElement(a);
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
let exifSupport = null;
/** Modern engines (Chrome 81+, Safari 13.1+, Firefox 77+) apply EXIF orientation to <img> and drawImage. */
function browserAppliesExif() {
  if (exifSupport === null) {
    try {
      exifSupport = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        && CSS.supports('image-orientation', 'from-image');
    } catch (_) { exifSupport = false; }
  }
  return exifSupport;
}

/** Read the EXIF orientation (1..8) from a JPEG; 1 if absent. */
export async function readExifOrientation(blob) {
  try {
    const buf = await readArrayBuffer(blob.slice(0, 128 * 1024));
    const view = new DataView(buf);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 <= view.byteLength) {
      const marker = view.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) return 1;
      const size = view.getUint16(off + 2);
      if (marker === 0xffe1 && off + 10 <= view.byteLength && view.getUint32(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10;
        if (tiff + 8 > view.byteLength) return 1;
        const little = view.getUint16(tiff) === 0x4949;
        const ifd = tiff + view.getUint32(tiff + 4, little);
        if (ifd + 2 > view.byteLength) return 1;
        const entries = view.getUint16(ifd, little);
        for (let i = 0; i < entries; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > view.byteLength) return 1;
          if (view.getUint16(e, little) === 0x0112) {
            const o = view.getUint16(e + 8, little);
            return o >= 1 && o <= 8 ? o : 1;
          }
        }
        return 1;
      }
      if (marker === 0xffda) return 1; // start of scan: no EXIF before image data
      off += 2 + size;
    }
  } catch (_) { /* ignore */ }
  return 1;
}

/** Transform ctx so drawing the raw (w×h) image yields the upright picture. */
function applyOrientation(ctx, o, w, h) {
  // w, h = raw image size in output units
  switch (o) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    default: break;
  }
}

function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    let timer = 0;
    const done = (fn, v) => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => done(reject, abortError());
    img.onload = () => done(resolve, img);
    img.onerror = () => done(reject, Object.assign(new Error('decode'), { code: 'unsupported' }));
    if (signal) signal.addEventListener('abort', onAbort);
    timer = setTimeout(() => done(reject, Object.assign(new Error('timeout'), { code: 'timeout' })), IMAGE_TIMEOUT);
    img.src = url;
  });
}

const ALPHA_MIMES = new Set(['image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/x-icon']);
const NON_PORTABLE_MIMES = new Set(['image/heic', 'image/heif', 'image/tiff', 'image/bmp', 'image/x-icon']);

async function importImage(blob, name, mime, report, signal) {
  let url = URL.createObjectURL(blob);
  let img;
  try {
    img = await loadImage(url, signal);
  } catch (err) {
    URL.revokeObjectURL(url);
    if (err && err.name === 'AbortError') throw err;
    if (/heic|heif/.test(mime)) {
      throw new MediaImportError(
        `HEIC/HEIF photos can't be opened in this browser ("${name}"). Convert the photo to JPEG, `
        + 'or on iPhone choose Settings › Camera › Formats › Most Compatible.',
        { code: 'unsupported', fileName: name, cause: err },
      );
    }
    if (err && err.code === 'timeout') {
      throw new MediaImportError(`"${name}" took too long to open. The photo may be damaged or too large.`,
        { code: 'timeout', fileName: name, cause: err });
    }
    throw new MediaImportError(`This photo format isn't supported by your browser ("${name}"). Try a JPEG or PNG file.`,
      { code: 'unsupported', fileName: name, cause: err });
  }
  if (report) report(0.4, 'Reading photo');
  const isSvg = mime === 'image/svg+xml';
  let rawW = img.naturalWidth || img.width;
  let rawH = img.naturalHeight || img.height;
  if (!rawW || !rawH) {
    if (!isSvg) {
      URL.revokeObjectURL(url);
      throw new MediaImportError(`"${name}" doesn't contain a picture that can be shown.`, { code: 'unsupported', fileName: name });
    }
    rawW = 1920;
    rawH = 1080;
  }
  const orientation = (!browserAppliesExif() && mime === 'image/jpeg') ? await readExifOrientation(blob) : 1;
  const swap = orientation >= 5;
  const w = swap ? rawH : rawW;
  const h = swap ? rawW : rawH;

  let outBlob = blob;
  let outMime = mime;
  let outW = w;
  let outH = h;
  const tooBig = w * h > MAX_IMAGE_PIXELS || Math.max(w, h) > MAX_IMAGE_SIDE;
  // Formats only some browsers decode (HEIC on Safari, TIFF, BMP): store as JPEG/PNG so the
  // project still opens on other devices after "Export project file".
  const nonPortable = NON_PORTABLE_MIMES.has(mime);
  // Rasterize vectors, bake EXIF rotation for old engines, and shrink huge photos so
  // phones don't run out of memory holding full-size bitmaps.
  if (tooBig || orientation !== 1 || isSvg || nonPortable) {
    let scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h), Math.sqrt(MAX_IMAGE_PIXELS / (w * h)));
    if (isSvg && Math.max(w, h) < 1280) scale = 1280 / Math.max(w, h);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const c = makeCanvas(cw, ch);
    const ctx = c.getContext('2d');
    if (ctx) {
      try {
        const keepAlpha = ALPHA_MIMES.has(mime);
        if (!keepAlpha) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); }
        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
        ctx.save();
        const dw = Math.round(rawW * scale);
        const dh = Math.round(rawH * scale);
        applyOrientation(ctx, orientation, dw, dh);
        ctx.drawImage(img, 0, 0, dw, dh);
        ctx.restore();
        const type = keepAlpha ? 'image/png' : 'image/jpeg';
        const b = await canvasToBlob(c, type, 0.92);
        if (b && b.size) {
          outBlob = b;
          outMime = b.type || type;
          outW = cw;
          outH = ch;
        }
      } catch (_) { /* keep the original if re-encoding fails (e.g. tainted SVG) */ }
    }
    releaseCanvas(c);
    if (outBlob !== blob) {
      URL.revokeObjectURL(url);
      url = URL.createObjectURL(outBlob);
      try { img = await loadImage(url, signal); } catch (_) { /* thumbnail from original below */ }
    }
  }
  if (report) report(0.7, 'Creating thumbnail');
  const ts = thumbSize(outW, outH);
  const tc = makeCanvas(ts.width, ts.height);
  const tctx = tc.getContext('2d');
  let thumb = '';
  if (tctx) {
    try {
      tctx.fillStyle = '#000';
      tctx.fillRect(0, 0, ts.width, ts.height);
      tctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in tctx) tctx.imageSmoothingQuality = 'high';
      if (outBlob === blob && orientation !== 1) {
        // Re-encode failed: orient the thumbnail at least.
        const dw = swap ? ts.height : ts.width;
        const dh = swap ? ts.width : ts.height;
        applyOrientation(tctx, orientation, dw, dh);
        tctx.drawImage(img, 0, 0, dw, dh);
      } else {
        tctx.drawImage(img, 0, 0, ts.width, ts.height);
      }
      thumb = toJpeg(tc);
    } catch (_) { thumb = ''; }
  }
  releaseCanvas(tc);
  if (!thumb) thumb = placeholderThumb('image');
  return {
    id: uid('media'),
    type: 'image',
    name,
    mime: outMime,
    blob: outBlob,
    url,
    duration: 0,
    width: outW,
    height: outH,
    hasAudio: false,
    thumb,
    filmstrip: thumb ? [thumb] : [],
    peaks: null,
  };
}

// ---------------------------------------------------------------------------
// Audio peaks (waveform)
// ---------------------------------------------------------------------------
function decodeWith(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e || new Error('decode failed')); } };
    try {
      const p = ctx.decodeAudioData(arrayBuffer, ok, fail); // callback form for old Safari
      if (p && typeof p.then === 'function') p.then(ok, fail);
    } catch (e) { fail(e); }
  });
}

function createDecodeContext() {
  const Offline = typeof window !== 'undefined' ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null;
  if (Offline) {
    for (const rate of PEAKS_SAMPLE_RATES) {
      try {
        // A low sample rate keeps decoded buffers small (decodeAudioData resamples to the context rate).
        return { ctx: new Offline(1, rate, rate), close: null };
      } catch (_) { /* rate not supported; try the next */ }
    }
  }
  const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  if (Ctx) {
    try {
      const ctx = new Ctx();
      return { ctx, close: () => { try { ctx.close(); } catch (_) { /* ignore */ } } };
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** Downsample an AudioBuffer to ~20 normalized (0..1) peaks per second. */
export function bufferToPeaks(buffer, perSecond = PEAKS_PER_SECOND) {
  const len = buffer.length;
  const dur = buffer.duration || len / (buffer.sampleRate || 44100);
  const n = Math.max(1, Math.ceil(dur * perSecond));
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const raw = new Float32Array(n);
  const bucket = len / n;
  const step = Math.max(1, Math.floor(bucket / 256));
  let max = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * bucket);
    const e = Math.min(len, Math.max(s + 1, Math.floor((i + 1) * bucket)));
    let m = 0;
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c];
      for (let j = s; j < e; j += step) {
        const a = data[j] < 0 ? -data[j] : data[j];
        if (a > m) m = a;
      }
    }
    raw[i] = m;
    if (m > max) max = m;
  }
  const out = new Array(n);
  const norm = max > 0 ? 1 / max : 0;
  for (let i = 0; i < n; i++) out[i] = Math.round(raw[i] * norm * 1000) / 1000;
  return out;
}

const peakJobs = new Map();

/**
 * Decode the media's sound and return waveform peaks (~20/s, 0..1), or null if the
 * file has no decodable audio. Updates media.peaks / media.hasAudio (and a missing
 * duration) in place. Concurrent calls for the same media share one decode.
 */
export function computePeaks(media, audioCtx) {
  if (!media || media.type === 'image' || !media.blob) return Promise.resolve(null);
  if (Array.isArray(media.peaks) && media.peaks.length) return Promise.resolve(media.peaks);
  const key = media.id || media;
  if (peakJobs.has(key)) return peakJobs.get(key);
  const job = (async () => {
    if (media.blob.size > PEAKS_MAX_BYTES) return null;
    if (media.duration > PEAKS_MAX_SECONDS) return null;
    let holder = null;
    let ctx = null;
    if (typeof window !== 'undefined') {
      holder = createDecodeContext();
      ctx = holder ? holder.ctx : null;
    }
    if (!ctx && audioCtx && typeof audioCtx.decodeAudioData === 'function') ctx = audioCtx;
    if (!ctx) return null;
    try {
      const data = await readArrayBuffer(media.blob);
      const buffer = await withTimeout(decodeWith(ctx, data), DECODE_TIMEOUT, null);
      if (!buffer || !buffer.length || !buffer.numberOfChannels) {
        if (media.type === 'video') media.hasAudio = false;
        return null;
      }
      if (!(media.duration > 0) && buffer.duration > 0) media.duration = buffer.duration;
      const peaks = bufferToPeaks(buffer);
      media.peaks = peaks;
      media.hasAudio = true;
      return peaks;
    } catch (_) {
      if (media.type === 'video') media.hasAudio = false;
      return null;
    } finally {
      if (holder && holder.close) holder.close();
    }
  })();
  peakJobs.set(key, job);
  job.finally(() => peakJobs.delete(key));
  return job;
}

// ---------------------------------------------------------------------------
// Video & audio import
// ---------------------------------------------------------------------------
const MP4_COMPATIBLE = new Set(['video/quicktime', 'video/3gpp', 'video/3gpp2', 'video/x-m4v', 'application/mp4']);

function videoError(name, code, cause) {
  if (code === 'timeout') {
    return new MediaImportError(`"${name}" took too long to open. The file may be damaged or in a format this browser can't read.`,
      { code: 'timeout', fileName: name, cause });
  }
  if (/\.(mp4|m4v|mov|qt|3gp|3g2)$/i.test(name || '')) {
    // Phone videos are MP4/MOV. Say why this one failed instead of suggesting "try an MP4".
    let h264 = 'maybe';
    try { h264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'); } catch (_) { h264 = 'maybe'; }
    if (!h264) {
      return new MediaImportError(`This video format isn't supported by your browser ("${name}"): it can't play H.264 MP4 or MOV videos. Open Movie Maker in Chrome, Edge, Safari or Firefox, or use a WebM video.`,
        { code: 'unsupported', fileName: name, cause });
    }
    return new MediaImportError(`This video format isn't supported by your browser ("${name}"). If it was recorded in HEVC (H.265), try opening Movie Maker in Safari, or convert the video to MP4 (H.264).`,
      { code: 'unsupported', fileName: name, cause });
  }
  return new MediaImportError(`This video format isn't supported by your browser ("${name}"). Try an MP4 (H.264) or WebM file.`,
    { code: 'unsupported', fileName: name, cause });
}

function audioError(name, cause) {
  return new MediaImportError(`This audio format isn't supported by your browser ("${name}"). Try an MP3, M4A, WAV or OGG file.`,
    { code: 'unsupported', fileName: name, cause });
}

async function finishAudio(record, report) {
  if (report) report(0.85, 'Reading sound');
  await computePeaks(record);
  if (!(record.duration > 0)) {
    revokeMedia(record);
    throw audioError(record.name);
  }
  record.hasAudio = true;
  record.thumb = placeholderThumb('audio', record.peaks);
  record.filmstrip = record.thumb ? [record.thumb] : [];
  return record;
}

async function importVideo(blob, name, mime, report, signal) {
  let url = URL.createObjectURL(blob);
  let probe;
  try {
    probe = await probeVideo(url, report, signal);
  } catch (err) {
    URL.revokeObjectURL(url);
    if (err && err.name === 'AbortError') throw err;
    // .mov/.3gp/.m4v often hold plain H.264/AAC that plays fine when labelled MP4.
    if (err && err.code === 'unsupported' && MP4_COMPATIBLE.has(mime)) {
      const relabeled = new Blob([blob], { type: 'video/mp4' });
      url = URL.createObjectURL(relabeled);
      try {
        probe = await probeVideo(url, report, signal);
        blob = relabeled;
        mime = 'video/mp4';
      } catch (err2) {
        URL.revokeObjectURL(url);
        if (err2 && err2.name === 'AbortError') throw err2;
        throw videoError(name, err2 && err2.code, err2);
      }
    } else {
      throw videoError(name, err && err.code, err);
    }
  }
  throwIfAborted(signal);
  const record = {
    id: uid('media'),
    type: probe.kind === 'audio' ? 'audio' : 'video',
    name,
    mime,
    blob,
    url,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudioHint !== false,
    thumb: probe.thumb,
    filmstrip: probe.filmstrip,
    peaks: null,
  };
  if (record.type === 'audio') return finishAudio(record, report);
  if (report) report(0.88, 'Reading sound');
  if (blob.size <= AUTO_PEAKS_MAX_BYTES) {
    await computePeaks(record); // sets peaks + hasAudio (false if no decodable soundtrack)
  } else if (probe.hasAudioHint === null) {
    record.hasAudio = true; // unknown: assume a soundtrack; the audio engine decides later
  }
  if (!(record.duration > 0)) {
    revokeMedia(record);
    throw new MediaImportError(`Movie Maker couldn't work out how long "${name}" is. The file may be damaged.`,
      { code: 'unsupported', fileName: name });
  }
  if (!record.thumb) record.thumb = placeholderThumb('video');
  if (!record.filmstrip.length && record.thumb) record.filmstrip = [record.thumb];
  return record;
}

async function importAudio(blob, name, mime, report, signal) {
  const url = URL.createObjectURL(blob);
  let duration = 0;
  let metaError = null;
  try {
    duration = await probeAudioDuration(url, signal);
  } catch (err) {
    if (err && err.name === 'AbortError') { URL.revokeObjectURL(url); throw err; }
    metaError = err;
  }
  throwIfAborted(signal);
  const record = {
    id: uid('media'),
    type: 'audio',
    name,
    mime,
    blob,
    url,
    duration,
    width: 0,
    height: 0,
    hasAudio: true,
    thumb: '',
    filmstrip: [],
    peaks: null,
  };
  try {
    return await finishAudio(record, report);
  } catch (err) {
    throw audioError(name, metaError || err);
  }
}

/**
 * Import one File/Blob into a Media record (see ARCHITECTURE.md).
 * opts.onProgress(p 0..1, text), opts.signal (AbortSignal).
 */
export async function importFile(file, { onProgress, signal } = {}) {
  const name = (file && file.name) || 'Untitled';
  const report = (p, text) => {
    if (typeof onProgress === 'function') {
      try { onProgress(Math.max(0, Math.min(1, p)), text); } catch (_) { /* ignore */ }
    }
  };
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new MediaImportError('Importing media needs a web browser.', { code: 'environment', fileName: name });
  }
  if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function') {
    throw new MediaImportError("That doesn't look like a file Movie Maker can open.", { code: 'unknown-type', fileName: name });
  }
  if (file.size === 0) {
    throw new MediaImportError(`"${name}" is empty.`, { code: 'empty', fileName: name });
  }
  throwIfAborted(signal);
  report(0, 'Opening');
  let det = detectMediaType(file);
  if (!det) det = await sniffType(file);
  if (!det || !det.type) {
    throw new MediaImportError(`"${name}" isn't a video, photo or music file that Movie Maker can use.`,
      { code: 'unknown-type', fileName: name });
  }
  const fileMime = String(file.type || '').toLowerCase().split(';')[0].trim();
  // Safari needs a correct MIME type on blob: URLs to play them.
  const blob = fileMime === det.mime ? file : new Blob([file], { type: det.mime });
  report(0.05, 'Opening');
  let media;
  if (det.type === 'image') media = await importImage(blob, name, det.mime, report, signal);
  else if (det.type === 'audio') media = await importAudio(blob, name, det.mime, report, signal);
  else media = await importVideo(blob, name, det.mime, report, signal);
  if (signal && signal.aborted) {
    revokeMedia(media);
    throw abortError();
  }
  report(1, 'Done');
  return media;
}

/**
 * Import several files one after another. Failures are skipped and reported through
 * opts.onError(file, err); returns the successfully imported Media records.
 * opts.onProgress(p 0..1, text) reports overall progress.
 */
export async function importFiles(files, opts = {}) {
  const list = Array.from(files || []);
  const { onProgress, onError, signal } = opts;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (signal && signal.aborted) break;
    const file = list[i];
    const label = list.length > 1 ? ` (${i + 1} of ${list.length})` : '';
    const fname = (file && file.name) || 'file';
    try {
      const media = await importFile(file, {
        signal,
        onProgress: (p, text) => {
          if (typeof onProgress === 'function') {
            try { onProgress((i + p) / list.length, `${text || 'Importing'} – ${fname}${label}`); } catch (_) { /* ignore */ }
          }
        },
      });
      out.push(media);
    } catch (err) {
      if (err && err.name === 'AbortError') break;
      const friendly = err && err.friendly ? err
        : new MediaImportError(`"${fname}" couldn't be imported.`, { code: 'unknown', fileName: fname, cause: err });
      if (typeof onError === 'function') {
        try { onError(file, friendly); } catch (_) { /* ignore */ }
      } else if (typeof console !== 'undefined') {
        console.warn(friendly.message, err);
      }
    }
  }
  if (typeof onProgress === 'function') {
    try { onProgress(1, 'Done'); } catch (_) { /* ignore */ }
  }
  return out;
}

/** Release the object URL held by a media record. */
export function revokeMedia(media) {
  if (!media) return;
  try {
    if (media.url && typeof media.url === 'string' && media.url.startsWith('blob:')) URL.revokeObjectURL(media.url);
  } catch (_) { /* ignore */ }
  media.url = '';
}
