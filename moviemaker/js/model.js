// Movie Maker (web) — data model: constants, factories, timeline math.
// Pure module: no DOM access, imports cleanly in node.

export const ASPECTS = { '16:9': 16 / 9, '4:3': 4 / 3, '9:16': 9 / 16, '1:1': 1 };
export const FADE_SPEEDS = { none: 0, slow: 2, medium: 1, fast: 0.5 }; // seconds
export const SPEEDS = [0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8];
export const DEFAULT_IMAGE_DURATION = 7;
export const DEFAULT_TITLE_DURATION = 7;
export const DEFAULT_CAPTION_DURATION = 3.5;
export const DEFAULT_TRANSITION_DURATION = 1.5;

export const PROJECT_VERSION = 1;
export const DEFAULT_FONT = 'Segoe UI, Arial, sans-serif';
export const DEFAULT_CREDITS_TEXT = 'CREDITS\nDirector\nStarring\nLocation';
export const DEFAULT_CREDITS_DURATION = 7;

const FADE_VALUES = ['none', 'slow', 'medium', 'fast'];
const ROTATIONS = [0, 90, 180, 270];
const OUTLINES = ['none', 'thin', 'medium', 'thick'];
const ALIGNS = ['left', 'center', 'right'];
const VALIGNS = ['top', 'middle', 'bottom'];

let uidCounter = 0;
/** Short unique id, e.g. "item-lq3k9a-4f2x". */
export function uid(prefix = 'id') {
  uidCounter = (uidCounter + 1) % 1679616; // 36^4
  let rand = '';
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      rand = a[0].toString(36);
    }
  } catch (_) { /* ignore */ }
  if (!rand) rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}-${Date.now().toString(36)}${uidCounter.toString(36)}-${rand.slice(0, 5)}`;
}

// ---------- small validation helpers ----------
function num(v, def, min = -Infinity, max = Infinity) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function oneOf(v, list, def) { return list.includes(v) ? v : def; }
function str(v, def) { return typeof v === 'string' ? v : def; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ---------- text styles ----------
/** Default TextStyle per text kind ('title' | 'caption' | 'credits'). */
export function defaultTextStyle(kind) {
  const base = {
    font: DEFAULT_FONT,
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
  };
  if (kind === 'caption') {
    return { ...base, size: 6, bold: true, outline: 'thin', outlineColor: '#000000', valign: 'bottom' };
  }
  if (kind === 'credits') {
    return { ...base, size: 6, bold: false, valign: 'middle' };
  }
  // title
  return { ...base, size: 9 };
}

/** Optional fraction key: a finite number in lo..hi, else undefined (null / invalid → absent). */
function optFrac(v, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return undefined;
  return v;
}

function normalizeStyle(style, kind) {
  const d = defaultTextStyle(kind);
  if (!isObj(style)) return d;
  const out = normalizeBaseStyle(style, d);
  // Free placement from dragging on the preview: centre (x, y) and wrap width w, as fractions
  // of the frame. Absent → align / valign placement and the default wrap width.
  const x = optFrac(style.x, 0, 1), y = optFrac(style.y, 0, 1), w = optFrac(style.w, 0.05, 1);
  if (x !== undefined && y !== undefined) { out.x = x; out.y = y; }
  if (w !== undefined) out.w = w;
  return out;
}

function normalizeBaseStyle(style, d) {
  return {
    font: str(style.font, d.font) || d.font,
    size: num(style.size, d.size, 1, 50),
    bold: typeof style.bold === 'boolean' ? style.bold : d.bold,
    italic: typeof style.italic === 'boolean' ? style.italic : d.italic,
    color: str(style.color, d.color),
    outline: oneOf(style.outline, OUTLINES, d.outline),
    outlineColor: str(style.outlineColor, d.outlineColor),
    align: oneOf(style.align, ALIGNS, d.align),
    valign: oneOf(style.valign, VALIGNS, d.valign),
    opacity: num(style.opacity, d.opacity, 0, 1),
    background: typeof style.background === 'string' && style.background ? style.background : null,
  };
}

function normalizeTransition(tr) {
  const t = isObj(tr) ? tr : {};
  const type = typeof t.type === 'string' && t.type ? t.type : 'none';
  return { type, duration: num(t.duration, DEFAULT_TRANSITION_DURATION, 0, 60) };
}

// ---------- factories ----------
export function createProject(name = 'My Movie') {
  const now = Date.now();
  return {
    version: PROJECT_VERSION,
    id: uid('proj'),
    name: typeof name === 'string' && name.trim() ? name : 'My Movie',
    aspect: '16:9',
    audioMix: 0,
    items: [],
    texts: [],
    music: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** kind: 'video' | 'image' | 'title'. Every field is filled with a default. */
export function createVisualItem(kind, props = {}) {
  const k = oneOf(kind, ['video', 'image', 'title'], 'image');
  const p = isObj(props) ? props : {};
  const item = {
    id: typeof p.id === 'string' && p.id ? p.id : uid('item'),
    kind: k,
    mediaId: k === 'title' ? null : (typeof p.mediaId === 'string' ? p.mediaId : null),
    trimStart: num(p.trimStart, 0, 0),
    trimEnd: p.trimEnd === null || p.trimEnd === undefined ? null : num(p.trimEnd, null, 0),
    speed: num(p.speed, 1, 0.01, 64),
    volume: num(p.volume, 1, 0, 1),
    fadeIn: oneOf(p.fadeIn, FADE_VALUES, 'none'),
    fadeOut: oneOf(p.fadeOut, FADE_VALUES, 'none'),
    duration: num(p.duration, k === 'title' ? DEFAULT_TITLE_DURATION : DEFAULT_IMAGE_DURATION, 0.01),
    background: str(p.background, '#000000'),
    text: str(p.text, k === 'title' ? 'My Movie' : ''),
    style: normalizeStyle(p.style, 'title'),
    textEffect: str(p.textEffect, k === 'title' ? 'fade' : 'none') || 'none',
    transition: normalizeTransition(p.transition),
    panZoom: str(p.panZoom, 'none') || 'none',
    effect: str(p.effect, 'none') || 'none',
    brightness: num(p.brightness, 0, -100, 100),
    rotation: ROTATIONS.includes(p.rotation) ? p.rotation : 0,
  };
  if (item.trimEnd !== null && item.trimEnd <= item.trimStart) item.trimEnd = null;
  return item;
}

/** kind: 'caption' | 'credits'. */
export function createTextItem(kind, props = {}) {
  const k = oneOf(kind, ['caption', 'credits'], 'caption');
  const p = isObj(props) ? props : {};
  return {
    id: typeof p.id === 'string' && p.id ? p.id : uid('text'),
    kind: k,
    text: str(p.text, k === 'credits' ? DEFAULT_CREDITS_TEXT : 'Enter text here'),
    start: num(p.start, 0, 0),
    duration: num(p.duration, k === 'credits' ? DEFAULT_CREDITS_DURATION : DEFAULT_CAPTION_DURATION, 0.1),
    style: normalizeStyle(p.style, k),
    effect: str(p.effect, k === 'credits' ? 'scroll' : 'none') || 'none',
  };
}

export function createMusicItem(props = {}) {
  const p = isObj(props) ? props : {};
  const item = {
    id: typeof p.id === 'string' && p.id ? p.id : uid('music'),
    mediaId: typeof p.mediaId === 'string' ? p.mediaId : null,
    kind: p.kind === 'narration' ? 'narration' : 'music',
    start: num(p.start, 0, 0),
    trimStart: num(p.trimStart, 0, 0),
    trimEnd: p.trimEnd === null || p.trimEnd === undefined ? null : num(p.trimEnd, null, 0),
    volume: num(p.volume, 1, 0, 1),
    fadeIn: oneOf(p.fadeIn, FADE_VALUES, 'none'),
    fadeOut: oneOf(p.fadeOut, FADE_VALUES, 'none'),
  };
  if (item.trimEnd !== null && item.trimEnd <= item.trimStart) item.trimEnd = null;
  return item;
}

/**
 * Bring a (possibly older / hand-edited / imported) project object up to the current
 * shape, filling every missing field with defaults. Returns a new object.
 */
export function normalizeProject(raw) {
  if (!isObj(raw)) throw new Error('This file does not contain a valid Movie Maker project.');
  const base = createProject(str(raw.name, 'My Movie'));
  const project = {
    version: PROJECT_VERSION,
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    name: base.name,
    aspect: Object.prototype.hasOwnProperty.call(ASPECTS, raw.aspect) ? raw.aspect : '16:9',
    audioMix: num(raw.audioMix, 0, -1, 1),
    items: [],
    texts: [],
    music: [],
    createdAt: num(raw.createdAt, base.createdAt, 0),
    updatedAt: num(raw.updatedAt, base.updatedAt, 0),
  };
  // Optional "Emphasize narration" setting (commands.js sets it, audio.js ducks music under
  // narration while it is on). Kept only when set, so plain projects stay unchanged.
  if (raw.emphasize === 'narration') project.emphasize = 'narration';
  if (raw.duckMusic === true) project.duckMusic = true;
  const seen = new Set();
  const fresh = (obj, prefix) => {
    if (!obj.id || seen.has(obj.id)) obj.id = uid(prefix);
    seen.add(obj.id);
    return obj;
  };
  if (Array.isArray(raw.items)) {
    for (const it of raw.items) {
      if (!isObj(it)) continue;
      project.items.push(fresh(createVisualItem(it.kind, it), 'item'));
    }
  }
  if (Array.isArray(raw.texts)) {
    for (const it of raw.texts) {
      if (!isObj(it)) continue;
      project.texts.push(fresh(createTextItem(it.kind, it), 'text'));
    }
  }
  if (Array.isArray(raw.music)) {
    for (const it of raw.music) {
      if (!isObj(it)) continue;
      project.music.push(fresh(createMusicItem(it), 'music'));
    }
  }
  return project;
}

// ---------- durations ----------
function videoSourceRange(item, media) {
  const mediaDur = media && Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
  if (!mediaDur) return { sourceIn: 0, sourceOut: 0, mediaDur: 0 };
  const sIn = Math.min(Math.max(0, item.trimStart || 0), mediaDur);
  let sOut = item.trimEnd === null || item.trimEnd === undefined || !Number.isFinite(item.trimEnd)
    ? mediaDur : Math.min(item.trimEnd, mediaDur);
  if (sOut < sIn) sOut = sIn;
  return { sourceIn: sIn, sourceOut: sOut, mediaDur };
}

/** Seconds the item occupies on the timeline (before transition overlaps). */
export function itemDuration(item, media) {
  if (!item) return 0;
  if (item.kind === 'video') {
    const { sourceIn, sourceOut } = videoSourceRange(item, media);
    const speed = Number.isFinite(item.speed) && item.speed > 0 ? item.speed : 1;
    return Math.max(0, (sourceOut - sourceIn) / speed);
  }
  return Number.isFinite(item.duration) && item.duration > 0 ? item.duration : 0;
}

/** Length of a music item on the timeline, in seconds. */
export function musicDuration(item, media) {
  if (!item) return 0;
  const mediaDur = media && Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
  const sIn = Math.max(0, item.trimStart || 0);
  let sOut;
  if (item.trimEnd === null || item.trimEnd === undefined || !Number.isFinite(item.trimEnd)) sOut = mediaDur;
  else sOut = mediaDur ? Math.min(item.trimEnd, mediaDur) : item.trimEnd;
  return Math.max(0, sOut - Math.min(sIn, sOut));
}

function getMediaFrom(mediaMap, id) {
  if (!mediaMap || !id) return undefined;
  if (typeof mediaMap.get === 'function') return mediaMap.get(id);
  return mediaMap[id];
}

/**
 * WLMM timeline semantics. Segment i starts at segments[i-1].end - transIn.duration,
 * where transIn.duration = min(item.transition.duration, prev.duration/2, cur.duration/2),
 * null when the type is 'none' or i == 0.
 */
export function computeTimeline(project, mediaMap) {
  const segments = [];
  const items = project && Array.isArray(project.items) ? project.items : [];
  let prev = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const media = item.kind === 'title' ? undefined : getMediaFrom(mediaMap, item.mediaId);
    const duration = itemDuration(item, media);
    let transitionIn = null;
    let start = 0;
    if (prev) {
      start = prev.end;
      const tr = item.transition;
      if (tr && tr.type && tr.type !== 'none') {
        const d = Math.max(0, Math.min(
          Number.isFinite(tr.duration) ? tr.duration : DEFAULT_TRANSITION_DURATION,
          prev.duration / 2,
          duration / 2,
        ));
        if (d > 0) {
          transitionIn = { type: tr.type, duration: d };
          start = prev.end - d;
        }
      }
    }
    let sourceIn = 0;
    let sourceOut = duration;
    if (item.kind === 'video') {
      const r = videoSourceRange(item, media);
      sourceIn = r.sourceIn;
      sourceOut = r.sourceOut;
    }
    const seg = {
      item, index: i, start, end: start + duration, duration, transitionIn, sourceIn, sourceOut,
    };
    segments.push(seg);
    prev = seg;
  }
  let duration = prev ? prev.end : 0;

  const texts = [];
  const textItems = project && Array.isArray(project.texts) ? project.texts : [];
  for (const t of textItems) {
    const start = Math.max(0, Number.isFinite(t.start) ? t.start : 0);
    const end = start + Math.max(0, Number.isFinite(t.duration) ? t.duration : 0);
    texts.push({ item: t, start, end });
    if (end > duration) duration = end;
  }
  texts.sort((a, b) => a.start - b.start);

  const music = [];
  const musicItems = project && Array.isArray(project.music) ? project.music : [];
  for (const m of musicItems) {
    const start = Math.max(0, Number.isFinite(m.start) ? m.start : 0);
    const end = start + musicDuration(m, getMediaFrom(mediaMap, m.mediaId));
    music.push({ item: m, start, end });
    if (end > duration) duration = end;
  }
  music.sort((a, b) => a.start - b.start);

  return { duration, segments, texts, music };
}

/** Index of the visual segment at time t (the incoming one during an overlap), or -1. */
export function segmentIndexAt(timeline, t) {
  const segs = timeline && timeline.segments;
  if (!segs || !segs.length || !Number.isFinite(t)) return -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (t >= segs[i].start && t < segs[i].end) return i;
  }
  const last = segs[segs.length - 1];
  if (t >= last.end && t <= last.end + 1e-6) return segs.length - 1;
  return t < segs[0].start ? 0 : -1;
}

/** "MM:SS.ss" like WLMM, e.g. 65.37 → "01:05.37". Hours fold into minutes. */
export function formatTime(t) {
  const v = Number.isFinite(t) && t > 0 ? t : 0;
  let cs = Math.round(v * 100);
  const m = Math.floor(cs / 6000);
  cs -= m * 6000;
  const s = Math.floor(cs / 100);
  cs -= s * 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Parse "MM:SS.ss", "H:MM:SS", "SS.s" or a plain number of seconds. Returns NaN if invalid. */
export function parseTime(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : NaN;
  if (typeof s !== 'string') return NaN;
  const parts = s.trim().replace(',', '.').split(':');
  if (!parts.length || parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    if (!/^\d*\.?\d+$|^\d+\.?$/.test(p)) return NaN;
    total = total * 60 + Number(p);
  }
  return total;
}
