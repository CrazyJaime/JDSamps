// Movie Maker (web) — AutoMovie themes (Home tab › "AutoMovie themes" gallery).
//
// Like the original, applying a theme in one step (one undo step):
//   • puts the theme's transition (with the theme's duration) in front of every item but the first,
//   • sets the theme's pan & zoom on every photo and its visual effect on every video and photo,
//   • adds an opening title (the project name, theme style) unless the movie already starts with a
//     title (an existing opening title is restyled instead),
//   • adds end credits when the movie has none (existing credits are restyled and kept at the end),
//   • and, when the music is longer than the pictures, stretches photo / title durations so the
//     movie ends together with the music (the same math as Project › Fit to music).
//
// Pure module (no DOM): works in browsers and in node.

import * as model from './model.js';
import * as catalog from './catalog.js';

const EPS = 0.05;                 // "at the end of the visuals" tolerance (seconds)
export const MIN_FIT_DURATION = 0.5; // shortest photo/title Fit to music will produce (seconds)
const MAX_FIT_DURATION = 24 * 3600;

const FALLBACK_TRANSITION_DURATION = 1.5;
const FALLBACK_TITLE_DURATION = 7;
const FALLBACK_CREDITS_DURATION = 7;
const FALLBACK_CREDITS_TEXT = 'CREDITS\nDirector\nStarring\nLocation';

/** Used when the catalog is missing a theme or a field. */
const BUILTIN_THEME = Object.freeze({
  id: 'default',
  name: 'Default',
  transition: 'crossfade',
  transitionDuration: FALLBACK_TRANSITION_DURATION,
  panZoom: 'auto',
  effect: 'none',
  titleEffect: 'fade',
  creditsEffect: 'scroll',
  titleBackground: '#000000',
  creditsBackground: '#000000',
  titleStyle: Object.freeze({}),
  creditsStyle: Object.freeze({}),
});

const STYLE_KEYS = ['font', 'size', 'bold', 'italic', 'color', 'outline', 'outlineColor', 'align', 'valign', 'opacity', 'background'];

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function finite(v, def) { return typeof v === 'number' && Number.isFinite(v) ? v : def; }
function round3(v) { return Math.round(v * 1000) / 1000; }

function catalogList(name) {
  const list = catalog[name];
  return Array.isArray(list) && list.length ? list : null;
}

/** id if it exists in the catalog list (or the catalog is unavailable), otherwise fallback. */
function knownId(listName, id, fallback) {
  if (typeof id !== 'string' || !id) return fallback;
  const list = catalogList(listName);
  if (!list) return id;
  return list.some((e) => e && e.id === id) ? id : fallback;
}

function defaultStyle(kind) {
  if (typeof model.defaultTextStyle === 'function') return model.defaultTextStyle(kind);
  return {
    font: 'Segoe UI, Arial, sans-serif', size: kind === 'title' ? 9 : 6, bold: false, italic: false,
    color: '#ffffff', outline: 'none', outlineColor: '#000000', align: 'center', valign: 'middle',
    opacity: 1, background: null,
  };
}

/** defaultTextStyle(kind) overlaid with the theme's (TextStyle-only) keys, validated by the model. */
function themedStyle(kind, themeStyle) {
  const s = defaultStyle(kind);
  if (isObj(themeStyle)) {
    for (const k of STYLE_KEYS) if (themeStyle[k] !== undefined) s[k] = themeStyle[k];
  }
  try {
    // The factories validate every TextStyle field (sizes, enums, colors).
    if (kind === 'title' && typeof model.createVisualItem === 'function') return model.createVisualItem('title', { style: s }).style;
    if (kind !== 'title' && typeof model.createTextItem === 'function') return model.createTextItem(kind, { style: s }).style;
  } catch (_) { /* fall through */ }
  return s;
}

/**
 * The theme for an id with every field filled in (unknown id → the 'default' theme).
 * Ids that the catalogs do not know are replaced with safe defaults.
 */
export function resolveTheme(themeId) {
  const list = catalogList('AUTOMOVIE_THEMES') || [];
  const raw = list.find((t) => t && t.id === themeId)
    || list.find((t) => t && t.id === 'default')
    || list[0]
    || BUILTIN_THEME;
  const t = { ...BUILTIN_THEME, ...(isObj(raw) ? raw : {}) };
  return {
    id: typeof t.id === 'string' && t.id ? t.id : 'default',
    name: typeof t.name === 'string' && t.name ? t.name : 'AutoMovie',
    transition: knownId('TRANSITIONS', t.transition, 'crossfade'),
    transitionDuration: Math.min(10, Math.max(0.1, finite(t.transitionDuration,
      finite(model.DEFAULT_TRANSITION_DURATION, FALLBACK_TRANSITION_DURATION)))),
    panZoom: knownId('PANZOOM', t.panZoom, 'auto'),
    effect: knownId('EFFECTS', t.effect, 'none'),
    titleEffect: knownId('TEXT_EFFECTS', t.titleEffect, 'fade'),
    creditsEffect: knownId('TEXT_EFFECTS', t.creditsEffect, 'scroll'),
    titleBackground: typeof t.titleBackground === 'string' && t.titleBackground ? t.titleBackground : '#000000',
    titleStyle: isObj(t.titleStyle) ? t.titleStyle : {},
    creditsStyle: isObj(t.creditsStyle) ? t.creditsStyle : {},
    titleDuration: Math.max(1, finite(t.titleDuration, finite(model.DEFAULT_TITLE_DURATION, FALLBACK_TITLE_DURATION))),
    creditsDuration: Math.max(1, finite(t.creditsDuration, finite(model.DEFAULT_CREDITS_DURATION, FALLBACK_CREDITS_DURATION))),
  };
}

/** End of the last visual segment (0 when there are no visual items). */
export function visualsEnd(timeline) {
  const segs = timeline && timeline.segments;
  return segs && segs.length ? segs[segs.length - 1].end : 0;
}

/** End of the music track (narration does not count; WLMM fits to the music). */
function musicEnd(timeline) {
  let end = 0;
  for (const m of (timeline && timeline.music) || []) {
    if (m && m.item && m.item.kind !== 'narration' && m.end > end) end = m.end;
  }
  return end;
}

const isAdjustable = (it) => !!it && (it.kind === 'image' || it.kind === 'title');

function speedOf(item) { return item && Number.isFinite(item.speed) && item.speed > 0 ? item.speed : 1; }

function segmentIndexAt(timeline, t) {
  if (typeof model.segmentIndexAt === 'function') return model.segmentIndexAt(timeline, t);
  const segs = timeline.segments;
  for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start && t < segs[i].end) return i;
  return -1;
}

/**
 * Captions & credits travel with the pictures (as in WLMM, where a caption belongs to its clip):
 * remember, for every text, the visual item it starts on and its offset into that item — or, for
 * texts at/after the end of the pictures (end credits), the offset from that end.
 * Call before a structural edit (insert, remove, reorder, durations, transitions, trims) and pass
 * the result to reanchorTexts() afterwards.
 */
export function anchorTexts(project, mediaMap) {
  const out = [];
  if (!project || !Array.isArray(project.texts) || !project.texts.length) return out;
  const tl = model.computeTimeline(project, mediaMap);
  const visEnd = visualsEnd(tl);
  for (const x of tl.texts) {
    const t = x.item;
    if (!t || !t.id) continue;
    if (!tl.segments.length || x.start >= visEnd - EPS) {
      out.push({ id: t.id, end: true, offset: Math.max(0, x.start - visEnd) });
      continue;
    }
    const i = segmentIndexAt(tl, x.start);
    if (i < 0) continue;
    const seg = tl.segments[i];
    const offset = x.start - seg.start;
    const a = { id: t.id, itemId: seg.item.id, offset, duration: seg.duration, ratio: seg.duration > 0 ? offset / seg.duration : 0 };
    // On a video, remember the frame (source time) so trims and speed changes keep the caption on it.
    if (seg.item.kind === 'video') a.src = seg.sourceIn + offset * speedOf(seg.item);
    out.push(a);
  }
  return out;
}

/**
 * Put texts back on the item they were anchored to (same offset, or the same fraction of the item
 * when its length changed); end texts follow the end of the pictures. Texts whose item was removed
 * keep their time. Mutates project.texts; returns how many moved.
 */
export function reanchorTexts(project, mediaMap, anchors) {
  if (!project || !Array.isArray(anchors) || !anchors.length) return 0;
  const tl = model.computeTimeline(project, mediaMap);
  const visEnd = visualsEnd(tl);
  const segById = new Map();
  for (const s of tl.segments) segById.set(s.item.id, s);
  let moved = 0;
  for (const a of anchors) {
    const t = project.texts.find((x) => x && x.id === a.id);
    if (!t) continue;
    let start;
    if (a.end) {
      start = visEnd + a.offset;
    } else {
      const seg = segById.get(a.itemId);
      if (!seg) continue;
      let off;
      if (Math.abs(seg.duration - a.duration) < 1e-6 && (!Number.isFinite(a.src) || Math.abs(seg.sourceIn + a.offset * speedOf(seg.item) - a.src) < 1e-6)) {
        off = a.offset;
      } else if (Number.isFinite(a.src) && seg.item.kind === 'video') {
        // Same frame of the video; a frame that was trimmed away clamps to the nearest edge.
        off = Math.min(Math.max(0, (a.src - seg.sourceIn) / speedOf(seg.item)), Math.max(0, seg.duration - EPS));
      } else {
        off = a.ratio * seg.duration;
      }
      start = seg.start + off;
    }
    start = Math.round(Math.max(0, start) * 1e6) / 1e6;
    if (Math.abs(start - (Number.isFinite(t.start) ? t.start : 0)) > 1e-6) {
      t.start = start;
      moved++;
    }
  }
  return moved;
}

/**
 * Fit to music: scale photo and title durations (proportionally, never below minDuration)
 * so the movie ends together with the music. End credits (credits starting at the end of the
 * pictures) are taken into account and moved so they still follow the pictures.
 * MUTATES `project` (call it inside store.update, or on a copy for a dry run).
 *
 * opts.allowShrink (default true): false only ever lengthens (AutoMovie).
 * opts.extraTail: seconds of end credits that will be added after the pictures.
 * Returns { ok, changed, reason?, target, musicEnd, visualsEnd, scale }.
 *   reason: 'no-music' | 'no-photos' | 'music-shorter' (allowShrink false) | 'videos-longer'
 */
export function fitVisualsToMusic(project, mediaMap, opts = {}) {
  const allowShrink = opts.allowShrink !== false;
  const minDuration = Math.max(0.05, finite(opts.minDuration, MIN_FIT_DURATION));
  const extraTail = Math.max(0, finite(opts.extraTail, 0));
  if (!project || !Array.isArray(project.items)) return { ok: false, changed: false, reason: 'no-photos' };
  const tl = model.computeTimeline(project, mediaMap);
  const mEnd = musicEnd(tl);
  const visEnd = visualsEnd(tl);
  if (!(mEnd > 0)) return { ok: false, changed: false, reason: 'no-music', musicEnd: 0, visualsEnd: visEnd };
  const adjustable = project.items.filter(isAdjustable);
  if (!adjustable.length) return { ok: false, changed: false, reason: 'no-photos', musicEnd: mEnd, visualsEnd: visEnd };

  const endCredits = tl.texts.filter((x) => x.item && x.item.kind === 'credits' && x.start >= visEnd - EPS);
  let tail = extraTail;
  for (const x of endCredits) tail = Math.max(tail, x.end - visEnd);
  const target = mEnd - tail;
  const base = { ok: true, changed: false, target, musicEnd: mEnd, visualsEnd: visEnd, scale: 1 };
  if (!allowShrink && target <= visEnd + 0.01) return { ...base, ok: false, reason: 'music-shorter' };
  if (Math.abs(target - visEnd) < 0.005) return base;
  if (!(target > 0)) return { ...base, ok: false, reason: 'videos-longer' };

  // Probe on shallow copies so the real items are only touched once the answer is known.
  const probe = { items: project.items.map((it) => ({ ...it })), texts: [], music: [] };
  const probeAdj = probe.items.filter(isAdjustable);
  const baseDur = probeAdj.map((it) => (finite(it.duration, 0) > 0 ? it.duration : minDuration));
  const durAt = (i, k) => Math.min(MAX_FIT_DURATION, Math.max(minDuration, baseDur[i] * k));
  const endAt = (k) => {
    for (let i = 0; i < probeAdj.length; i++) probeAdj[i].duration = durAt(i, k);
    return visualsEnd(model.computeTimeline(probe, mediaMap));
  };

  if (endAt(0) > target + 0.01) return { ...base, ok: false, reason: 'videos-longer', minEnd: endAt(0) };
  let lo = 0;
  let hi = 1;
  while (endAt(hi) < target && hi < 1e7) { lo = hi; hi *= 2; }
  if (endAt(hi) < target - 0.01) return { ...base, ok: false, reason: 'too-long' };
  // visuals end is monotonic (non-decreasing) in k: bisect.
  for (let i = 0; i < 80 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (endAt(mid) < target) lo = mid; else hi = mid;
  }
  const k = hi;
  for (let i = 0; i < adjustable.length; i++) adjustable[i].duration = round3(durAt(i, k));

  // Rounding to milliseconds can leave a few ms; settle them on the last photo/title.
  const last = adjustable[adjustable.length - 1];
  let newEnd = visualsEnd(model.computeTimeline(project, mediaMap));
  for (let pass = 0; pass < 4 && Math.abs(target - newEnd) >= 0.0005; pass++) {
    const next = round3(Math.max(minDuration, last.duration + (target - newEnd)));
    if (next === last.duration) break;
    last.duration = next;
    newEnd = visualsEnd(model.computeTimeline(project, mediaMap));
  }

  const shift = newEnd - visEnd;
  for (const x of endCredits) x.item.start = round3(Math.max(0, x.item.start + shift));
  return { ...base, changed: true, visualsEnd: newEnd, scale: k };
}

/**
 * The AutoMovie edit on a project (mutates it). Prefer applyAutoMovie(), which wraps it in one
 * undo step; this is exported for previews/tests.
 */
export function autoMovieEdit(project, mediaMap, theme, opts = {}) {
  const p = project;
  // Captions stay on their pictures and end credits after the pictures, whatever happens below.
  const anchors = anchorTexts(p, mediaMap);

  // 1. opening title
  let titleAdded = false;
  let titleId = null;
  const first = p.items[0];
  if (first && first.kind === 'title') {
    first.style = themedStyle('title', theme.titleStyle);
    first.textEffect = theme.titleEffect;
    first.background = theme.titleBackground;
    titleId = first.id;
  } else {
    const name = typeof opts.titleText === 'string' && opts.titleText.trim() ? opts.titleText
      : (typeof p.name === 'string' && p.name.trim() ? p.name : 'My Movie');
    const title = model.createVisualItem('title', {
      text: name,
      duration: theme.titleDuration,
      background: theme.titleBackground,
      style: themedStyle('title', theme.titleStyle),
      textEffect: theme.titleEffect,
      transition: { type: 'none', duration: theme.transitionDuration },
    });
    p.items.unshift(title);
    titleAdded = true;
    titleId = title.id;
  }

  // 2. transitions, pan & zoom, effects
  let transitions = 0;
  for (let i = 0; i < p.items.length; i++) {
    const it = p.items[i];
    if (i > 0) {
      it.transition = { type: theme.transition, duration: theme.transitionDuration };
      if (theme.transition !== 'none') transitions++;
    }
    if (it.kind === 'image') it.panZoom = theme.panZoom;
    if (it.kind === 'image' || it.kind === 'video') it.effect = theme.effect;
  }

  // 3. texts back on their pictures (end credits at the new end), restyle every credits item
  reanchorTexts(p, mediaMap, anchors);
  const credits = p.texts.filter((t) => t && t.kind === 'credits');
  for (const c of credits) {
    c.style = themedStyle('credits', theme.creditsStyle);
    c.effect = theme.creditsEffect;
  }

  // 4. stretch photos to the music (never shorten in AutoMovie)
  const creditsDuration = theme.creditsDuration;
  const fit = fitVisualsToMusic(p, mediaMap, {
    allowShrink: false,
    extraTail: credits.length ? 0 : creditsDuration,
    minDuration: opts.minDuration,
  });
  // Stretched photos carry their captions along.
  if (fit && fit.changed) reanchorTexts(p, mediaMap, anchors);

  // 5. end credits when there are none
  let creditsAdded = false;
  let creditsId = null;
  if (!credits.length) {
    const end = visualsEnd(model.computeTimeline(p, mediaMap));
    const text = typeof opts.creditsText === 'string' && opts.creditsText ? opts.creditsText
      : (typeof model.DEFAULT_CREDITS_TEXT === 'string' ? model.DEFAULT_CREDITS_TEXT : FALLBACK_CREDITS_TEXT);
    const c = model.createTextItem('credits', {
      text,
      start: round3(end),
      duration: creditsDuration,
      style: themedStyle('credits', theme.creditsStyle),
      effect: theme.creditsEffect,
    });
    p.texts.push(c);
    creditsAdded = true;
    creditsId = c.id;
  }

  return {
    ok: true,
    theme: theme.id,
    themeName: theme.name,
    titleAdded,
    titleId,
    creditsAdded,
    creditsId,
    transitions,
    fitted: !!(fit && fit.ok && fit.changed),
  };
}

/**
 * Apply an AutoMovie theme to the store's project as ONE undo step.
 * opts: { label?, titleText?, creditsText?, minDuration? }
 * Returns the summary from autoMovieEdit, or { ok:false, reason:'empty' } for an empty project.
 */
export function applyAutoMovie(store, themeId, opts = {}) {
  if (!store || typeof store.update !== 'function' || !store.project) {
    throw new TypeError('applyAutoMovie needs the app store');
  }
  const theme = resolveTheme(themeId);
  const items = Array.isArray(store.project.items) ? store.project.items : [];
  if (!items.length) return { ok: false, reason: 'empty', theme: theme.id, themeName: theme.name };
  const label = typeof opts.label === 'string' && opts.label ? opts.label : `AutoMovie theme: ${theme.name}`;
  return store.update((p) => autoMovieEdit(p, store.media, theme, opts), { label });
}

export default applyAutoMovie;
