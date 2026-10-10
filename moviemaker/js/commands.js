// Movie Maker (web) — command registry (docs/ARCHITECTURE.md › Commands).
//
// Every editing action of the ribbon, storyboard, preview, keyboard and app menu is a named
// command here. Mutating commands are exactly ONE store.update() (one undo step) with a human
// label; continuous controls (sliders, color pickers, steppers) pass a coalesceKey so a drag is a
// single undo step. Commands never throw at their callers: problems are reported with a friendly
// toast and run() resolves/returns undefined.
//
//   createCommands(app) -> { run(name, arg), isEnabled(name), isChecked(name, arg), list() }

import * as model from './model.js';
import * as catalog from './catalog.js';
import { applyAutoMovie, fitVisualsToMusic, anchorTexts, reanchorTexts } from './automovie.js';

const EDGE_GUARD = 0.1;            // split / set start / end point must be this far from an edge (s)
const MIN_ITEM_DURATION = 0.1;     // photos / titles / captions (s)
const MAX_ITEM_DURATION = 3600;
const MIN_TRANSITION = 0.05;
const MAX_TRANSITION = 60;
const ZOOM_MIN = 5;
const ZOOM_MAX = 400;
const ZOOM_STEP = 1.5;
const PEAKS_BG_MAX_BYTES = 200 * 1024 * 1024;
const FADES = ['none', 'slow', 'medium', 'fast'];
const THUMB_SIZES = ['small', 'medium', 'large'];
const PREVIEW_SIZES = ['normal', 'large'];
const ALIGNS = ['left', 'center', 'right'];
const VALIGNS = ['top', 'middle', 'bottom'];
const OUTLINES = ['none', 'thin', 'medium', 'thick'];
const ACCEPT_VISUAL_FALLBACK = 'video/*,image/*';
const ACCEPT_AUDIO_FALLBACK = 'audio/*,video/*';
const PROJECT_ACCEPT = '.wlmmweb,application/json';

const DEFAULT_IMAGE_DURATION = num(model.DEFAULT_IMAGE_DURATION, 7);
const DEFAULT_TITLE_DURATION = num(model.DEFAULT_TITLE_DURATION, 7);
const DEFAULT_CAPTION_DURATION = num(model.DEFAULT_CAPTION_DURATION, 3.5);
const DEFAULT_TRANSITION_DURATION = num(model.DEFAULT_TRANSITION_DURATION, 1.5);
const DEFAULT_CREDITS_TEXT = typeof model.DEFAULT_CREDITS_TEXT === 'string'
  ? model.DEFAULT_CREDITS_TEXT : 'CREDITS\nDirector\nStarring\nLocation';
const ASPECTS = model.ASPECTS || { '16:9': 16 / 9, '4:3': 4 / 3, '9:16': 9 / 16, '1:1': 1 };

const MSG = {
  exporting: 'Please wait until your movie has finished saving.',
  trimming: 'Finish trimming first (Save trim or Cancel).',
  selectItem: 'Select a video, photo or title in the storyboard first.',
  selectPicture: 'Select a video or photo in the storyboard first.',
  selectVideo: 'Select a video in the storyboard first.',
  selectMusic: 'Select music in the storyboard first.',
  selectText: 'Select a title, caption or credits first.',
  selectCaption: 'Select a caption or credits first.',
  edge: 'Move the playhead a little further from the beginning or end of the item.',
  generic: 'Something went wrong. Please try again.',
};

// ---------------------------------------------------------------------------------------------
// small pure helpers

function num(v, def) { return typeof v === 'number' && Number.isFinite(v) ? v : def; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Number from a number or a string ("1.5", "1,5", "01:05.37", "2x"); NaN when not a number. */
function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  if (!t) return NaN;
  if (t.includes(':')) {
    if (typeof model.parseTime === 'function') return model.parseTime(t);
    let total = 0;
    for (const part of t.split(':')) {
      const n = Number(part.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) return NaN;
      total = total * 60 + n;
    }
    return total;
  }
  const n = parseFloat(t.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function deepClone(v) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch (_) { /* fall back */ }
  }
  return JSON.parse(JSON.stringify(v));
}

function isFileLike(f) {
  return !!f && typeof f === 'object' && typeof f.size === 'number' && typeof f.slice === 'function';
}

function fileList(v) {
  if (!v) return [];
  if (isFileLike(v)) return [v];
  if (typeof v.length === 'number' || typeof v[Symbol.iterator] === 'function') {
    try { return Array.from(v).filter(isFileLike); } catch (_) { return []; }
  }
  return [];
}

function isColor(v) { return typeof v === 'string' && v.trim().length > 0 && v.length < 64; }

function sameColor(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
}

function friendlyError(message) {
  const e = new Error(message);
  e.friendly = true;
  return e;
}

/** Entry of a catalog list for id, or (when the catalog is unavailable) a stand-in. */
function catalogHas(listName, id) {
  if (typeof id !== 'string' || !id) return false;
  const list = catalog[listName];
  if (!Array.isArray(list) || !list.length) return true;
  if (typeof catalog.byId === 'function') return !!catalog.byId(list, id);
  return list.some((e) => e && e.id === id);
}

function segIndexAt(timeline, t) {
  if (typeof model.segmentIndexAt === 'function') return model.segmentIndexAt(timeline, t);
  const segs = timeline && timeline.segments;
  if (!segs || !segs.length || !Number.isFinite(t)) return -1;
  for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start && t < segs[i].end) return i;
  const last = segs[segs.length - 1];
  if (t >= last.end && t <= last.end + 1e-6) return segs.length - 1;
  return t < segs[0].start ? 0 : -1;
}

function visualsEndOf(timeline) {
  const segs = timeline && timeline.segments;
  return segs && segs.length ? segs[segs.length - 1].end : 0;
}

function musicLength(item, media) {
  if (typeof model.musicDuration === 'function') return model.musicDuration(item, media);
  const d = media && media.duration > 0 ? media.duration : 0;
  const sIn = Math.max(0, item.trimStart || 0);
  const sOut = item.trimEnd == null ? d : Math.min(item.trimEnd, d || item.trimEnd);
  return Math.max(0, sOut - Math.min(sIn, sOut));
}

function newId(prefix) { return model.uid(prefix); }

function collectionOf(p, type) {
  if (type === 'item') return p.items;
  if (type === 'text') return p.texts;
  if (type === 'music') return p.music;
  return [];
}

// TextStyle keys → validator (returns undefined when invalid) and undo label.
const STYLE_KEYS = {
  font: { label: 'Change font', coalesce: false, check: (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined) },
  size: { label: 'Change font size', coalesce: true, check: (v) => { const n = toNum(v); return Number.isFinite(n) && n > 0 ? clamp(n, 1, 50) : undefined; } },
  bold: { label: 'Bold', coalesce: false, check: (v) => (typeof v === 'boolean' ? v : undefined) },
  italic: { label: 'Italic', coalesce: false, check: (v) => (typeof v === 'boolean' ? v : undefined) },
  color: { label: 'Change font color', coalesce: true, check: (v) => (isColor(v) ? v.trim() : undefined) },
  outline: { label: 'Change outline size', coalesce: false, check: (v) => (OUTLINES.includes(v) ? v : undefined) },
  outlineColor: { label: 'Change outline color', coalesce: true, check: (v) => (isColor(v) ? v.trim() : undefined) },
  align: { label: 'Align text', coalesce: false, check: (v) => (ALIGNS.includes(v) ? v : undefined) },
  valign: { label: 'Change text position', coalesce: false, check: (v) => (VALIGNS.includes(v) ? v : undefined) },
  opacity: { label: 'Change transparency', coalesce: true, check: (v) => { const n = toNum(v); return Number.isFinite(n) ? clamp(n, 0, 1) : undefined; } },
  background: { label: 'Change text background', coalesce: true, check: (v) => (v === null || v === '' || v === 'none' ? null : (isColor(v) ? v.trim() : undefined)) },
};

// ---------------------------------------------------------------------------------------------

export function createCommands(app) {
  if (!app || !app.store) throw new TypeError('createCommands needs app.store');
  const store = app.store;

  // ------------------------------------------------------------------ environment helpers

  const dialogs = () => app.dialogs || null;
  const player = () => app.player || null;

  function toast(msg, type = 'info') {
    const d = dialogs();
    if (d && typeof d.toast === 'function') {
      try { d.toast(msg, { type }); return; } catch (_) { /* fall through */ }
    }
    if (typeof console !== 'undefined') (type === 'error' ? console.error : console.info)(`[Movie Maker] ${msg}`);
  }

  function messageOf(err, fallback = MSG.generic) {
    return err && err.friendly && err.message ? err.message : fallback;
  }

  function report(err, fallback) {
    if (!err || err.name === 'AbortError' || err.handled) return;
    if (typeof console !== 'undefined') console.error('[commands]', err);
    toast(messageOf(err, fallback), 'error');
  }

  const exporting = () => !!app.exporting;
  const trimActive = () => { try { return !!(app.dialogs && app.dialogs.trimActive); } catch (_) { return false; } };

  /** Why a command of this kind can't run right now ('' = it can). */
  function busyReason(kind) {
    if (kind === 'app') return '';
    if (exporting()) return MSG.exporting;
    if (kind === 'edit' && trimActive()) return MSG.trimming;
    return '';
  }

  function now() {
    const p = player();
    let t = 0;
    try { t = p ? Number(p.currentTime) : 0; } catch (_) { t = 0; }
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  function timelineDuration() {
    try { const tl = store.timeline; return tl && tl.duration > 0 ? tl.duration : 0; } catch (_) { return 0; }
  }

  function seek(t) {
    const p = player();
    if (!p || typeof p.seek !== 'function') return undefined;
    try {
      const r = p.seek(t);
      if (r && typeof r.catch === 'function') r.catch(() => {});
      return r;
    } catch (_) { return undefined; }
  }

  function getMedia(id) {
    if (!id) return undefined;
    if (typeof store.getMedia === 'function') return store.getMedia(id);
    return store.media && store.media.get ? store.media.get(id) : undefined;
  }

  /** Option from File menu › Options (app.options), then localStorage, then the default. */
  function option(name, def, lo, hi) {
    let v = NaN;
    try { v = app.options ? Number(app.options[name]) : NaN; } catch (_) { v = NaN; }
    if (!(v >= lo && v <= hi)) {
      for (const key of [`wlmm-web:opt:${name}`, `wlmm.${name}`]) {
        try {
          const ls = typeof localStorage !== 'undefined' ? localStorage : null;
          const raw = ls ? ls.getItem(key) : null;
          const n = raw == null ? NaN : parseFloat(raw);
          if (n >= lo && n <= hi) { v = n; break; }
        } catch (_) { /* storage blocked */ }
      }
    }
    return v >= lo && v <= hi ? v : def;
  }
  const photoDuration = () => option('photoDuration', DEFAULT_IMAGE_DURATION, MIN_ITEM_DURATION, MAX_ITEM_DURATION);
  const transitionDuration = () => option('transitionDuration', DEFAULT_TRANSITION_DURATION, MIN_TRANSITION, 30);

  // ------------------------------------------------------------------ selection helpers

  const selection = () => store.selection || { type: null, ids: [] };

  function selectedOf(type) {
    const s = selection();
    if (s.type !== type || !s.ids || !s.ids.length) return [];
    try {
      if (typeof store.selectedItems === 'function') return store.selectedItems() || [];
    } catch (_) { /* fall through */ }
    return collectionOf(store.project, type).filter((o) => s.ids.includes(o.id));
  }
  const selVisual = () => selectedOf('item');
  const selPictures = () => selVisual().filter((i) => i.kind === 'video' || i.kind === 'image');
  const selVideos = () => selVisual().filter((i) => i.kind === 'video');
  const selStills = () => selVisual().filter((i) => i.kind === 'image' || i.kind === 'title');
  const selTitles = () => selVisual().filter((i) => i.kind === 'title');
  const selTexts = () => selectedOf('text');
  const selMusic = () => selectedOf('music');
  /** Captions/credits or title items the Text Tools act on. */
  function textTargets() {
    const texts = selTexts();
    if (texts.length) return { type: 'text', objs: texts };
    const titles = selTitles();
    if (titles.length) return { type: 'item', objs: titles };
    return { type: null, objs: [] };
  }

  function select(type, ids) {
    try { store.select(type, ids); } catch (err) { if (typeof console !== 'undefined') console.warn('[commands] select failed', err); }
  }

  /**
   * store.update for edits that move pictures in time (insert, remove, reorder, durations,
   * transitions, trims, speed): captions travel with the picture they are on and end credits stay
   * after the pictures, like in WLMM.
   */
  function structuralUpdate(mutator, opts) {
    return store.update((p) => {
      let anchors = null;
      try { anchors = anchorTexts(p, store.media); } catch (_) { anchors = null; }
      const r = mutator(p);
      if (anchors && anchors.length) reanchorTexts(p, store.media, anchors);
      return r;
    }, opts);
  }

  /**
   * One undo step that edits the objects with `ids` in a collection.
   * opts.same(obj) → true when obj already has the wanted value (all same → no undo step).
   */
  function editObjs(type, objs, label, apply, { same, coalesceKey, structural = false } = {}) {
    const ids = objs.map((o) => o.id);
    if (!ids.length) return false;
    if (typeof same === 'function' && objs.every((o) => same(o))) return false;
    (structural ? structuralUpdate : store.update.bind(store))((p) => {
      const coll = collectionOf(p, type);
      for (const id of ids) {
        const o = coll.find((x) => x.id === id);
        if (o) apply(o, p);
      }
    }, { label, coalesceKey });
    return true;
  }

  // ------------------------------------------------------------------ storyboard positions

  /** Index just after the last selected visual item, or -1 without a visual selection. */
  function indexAfterSelection() {
    const s = selection();
    if (s.type !== 'item' || !s.ids.length) return -1;
    let last = -1;
    store.project.items.forEach((it, i) => { if (s.ids.includes(it.id)) last = i; });
    return last >= 0 ? last + 1 : -1;
  }

  /**
   * Storyboard index for time t. mode 'nearest': before/after the item under t depending on which
   * half t is in; 'after': after the item under t.
   */
  function indexAtTime(t, mode = 'nearest') {
    const tl = store.timeline;
    const segs = tl.segments;
    if (!segs.length) return 0;
    const i = segIndexAt(tl, t);
    if (i < 0) return t <= 0 ? 0 : segs.length;
    const seg = segs[i];
    if (mode === 'after') return i + 1;
    return t - seg.start < seg.duration / 2 ? i : i + 1;
  }

  /** After the selection, else at the playhead (mode 'nearest' | 'after') or at the end ('end'). */
  function insertIndex(mode = 'nearest') {
    const a = indexAfterSelection();
    if (a >= 0) return a;
    const n = store.project.items.length;
    if (!n || mode === 'end') return n;
    return indexAtTime(now(), mode);
  }

  /**
   * The visual segment an at-playhead command (split, set start/end point) works on:
   * a selected item under the playhead, else (nothing selected) the item under the playhead.
   * Returns { seg } or { error }.
   */
  function segmentForPlayhead(t, accept, wrongKindMsg) {
    const tl = store.timeline;
    const s = selection();
    if (s.type === 'item' && s.ids.length) {
      const chosen = tl.segments.filter((seg) => s.ids.includes(seg.item.id));
      const usable = chosen.filter((seg) => accept(seg.item));
      if (!usable.length) return { error: wrongKindMsg };
      const under = usable.filter((seg) => t >= seg.start - 1e-6 && t <= seg.end + 1e-6);
      if (!under.length) {
        return { error: usable.length === 1 ? 'Move the playhead onto the selected item first.' : 'Move the playhead onto one of the selected items first.' };
      }
      return { seg: under[under.length - 1] }; // the incoming one during a transition
    }
    if (s.type && s.type !== 'item') return { error: wrongKindMsg };
    const i = segIndexAt(tl, t);
    if (i < 0) return { error: 'Move the playhead onto an item in the storyboard first.' };
    if (!accept(tl.segments[i].item)) return { error: wrongKindMsg };
    return { seg: tl.segments[i] };
  }

  function musicForPlayhead(t) {
    const tl = store.timeline;
    const s = selection();
    if (s.type !== 'music' || !s.ids.length) return { error: MSG.selectMusic };
    const chosen = tl.music.filter((m) => s.ids.includes(m.item.id));
    const under = chosen.filter((m) => t >= m.start - 1e-6 && t <= m.end + 1e-6);
    if (!under.length) return { error: 'Move the playhead onto the selected music first.' };
    return { entry: under[under.length - 1] };
  }

  // ------------------------------------------------------------------ media import

  function revoke(m) {
    try {
      if (app.media && typeof app.media.revokeMedia === 'function') app.media.revokeMedia(m);
      else if (m && typeof m.url === 'string' && m.url.startsWith('blob:') && typeof URL !== 'undefined') URL.revokeObjectURL(m.url);
    } catch (_) { /* ignore */ }
  }

  function reportFailures(failures) {
    if (!failures.length) return;
    const msgOf = (f) => messageOf(f.err, `“${(f.file && f.file.name) || 'A file'}” couldn’t be added.`);
    if (failures.length <= 3) {
      for (const f of failures) toast(msgOf(f), 'error');
    } else {
      toast(`${failures.length} files couldn’t be added. ${msgOf(failures[0])}`, 'error');
    }
  }

  /** Import files with a (cancelable) progress dialog. Resolves { media, canceled }. */
  async function importFiles(files, title) {
    const list = fileList(files);
    if (!list.length) return { media: [], canceled: false };
    const api = app.media;
    if (!api || (typeof api.importFiles !== 'function' && typeof api.importFile !== 'function')) {
      throw friendlyError('Adding files isn’t available right now. Please reload the page.');
    }
    const d = dialogs();
    let prog = null;
    if (d && typeof d.progress === 'function') {
      try {
        prog = d.progress(title, {
          delay: list.length > 1 ? 150 : 700,
          text: list.length > 1 ? `${list.length} files` : (list[0].name || ''),
        });
      } catch (_) { prog = null; }
    }
    const signal = prog && prog.signal ? prog.signal : undefined;
    const failures = [];
    let media = [];
    try {
      const onProgress = (p, text) => { if (prog && typeof prog.set === 'function') { try { prog.set(p, text); } catch (_) { /* ignore */ } } };
      const onError = (file, err) => { failures.push({ file, err }); };
      if (typeof api.importFiles === 'function') {
        media = await api.importFiles(list, { signal, onProgress, onError });
      } else {
        for (let i = 0; i < list.length; i++) {
          if (signal && signal.aborted) break;
          try {
            media.push(await api.importFile(list[i], { signal, onProgress: (p, text) => onProgress((i + p) / list.length, text) }));
          } catch (err) {
            if (err && err.name === 'AbortError') break;
            onError(list[i], err);
          }
        }
      }
    } finally {
      if (prog && typeof prog.close === 'function') { try { prog.close(); } catch (_) { /* ignore */ } }
    }
    media = (Array.isArray(media) ? media : []).filter((m) => m && m.id);
    if (signal && signal.aborted) {
      for (const m of media) revoke(m);
      return { media: [], canceled: true };
    }
    reportFailures(failures);
    return { media, canceled: false };
  }

  /** The editor may have become busy (export / trim) while a picker or import was open. */
  function stillEditable(media) {
    const why = busyReason('edit');
    if (!why) return true;
    for (const m of media || []) if (!getMedia(m.id)) revoke(m);
    toast(why, 'error');
    return false;
  }

  /** Background work for new media: decode audio for playback and compute waveform peaks. */
  function afterMediaAdded(list) {
    const a = app.audio;
    if (a && typeof a.prepare === 'function') {
      try {
        const r = a.prepare(store.project, store);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (_) { /* audio is optional */ }
    }
    const api = app.media;
    if (!api || typeof api.computePeaks !== 'function') return;
    for (const m of list || []) {
      if (!m || m.type === 'image' || m.hasAudio === false) continue;
      if (Array.isArray(m.peaks) && m.peaks.length) continue;
      if (m.blob && m.blob.size > PEAKS_BG_MAX_BYTES) continue;
      let job;
      try { job = api.computePeaks(m); } catch (_) { continue; }
      Promise.resolve(job).then((peaks) => {
        if (!Array.isArray(peaks) || !peaks.length) return;
        if (!(Array.isArray(m.peaks) && m.peaks.length)) m.peaks = peaks;
        if (getMedia(m.id) !== m) return;
        if (typeof store.touchMedia === 'function') store.touchMedia(m.id);
        else store.addMedia(m);
      }).catch(() => {});
    }
  }

  function newVisualItem(m) {
    const transition = { type: 'none', duration: transitionDuration() };
    if (m.type === 'video') {
      return model.createVisualItem('video', { mediaId: m.id, trimStart: 0, trimEnd: null, transition });
    }
    return model.createVisualItem('image', { mediaId: m.id, duration: photoDuration(), transition });
  }

  /** End of the music that starts at `from` (back-to-back pieces included). Narration is ignored. */
  function musicChainEnd(p, from) {
    const tl = model.computeTimeline({ items: [], texts: [], music: p.music }, store.media);
    let cursor = from;
    for (let guard = 0; guard <= tl.music.length; guard++) {
      let moved = false;
      for (const m of tl.music) {
        if (m.item.kind === 'narration') continue;
        if (m.start <= cursor + 0.01 && m.end > cursor + 0.01) { cursor = m.end; moved = true; }
      }
      if (!moved) break;
    }
    return cursor;
  }

  /** Music items for media placed back to back from `start` (null = WLMM "beginning"). Mutates p. */
  function placeMusic(p, mediaList, start, kind = 'music') {
    let cursor = start == null ? musicChainEnd(p, 0) : Math.max(0, start);
    const ids = [];
    for (const m of mediaList) {
      const it = model.createMusicItem({ mediaId: m.id, kind, start: round3(cursor) });
      p.music.push(it);
      ids.push(it.id);
      cursor += musicLength(it, m);
    }
    return ids;
  }

  function pickFiles(accept) {
    const api = app.media;
    if (!api || typeof api.pickFiles !== 'function') throw friendlyError('Choosing files isn’t available right now. Please reload the page.');
    return api.pickFiles(accept, true);
  }

  // ------------------------------------------------------------------ Home › Add

  async function addMedia(files) {
    let list = fileList(files);
    // pickFiles is called synchronously (first await) so it stays inside the user gesture.
    if (!list.length) list = fileList(await pickFiles((app.media && app.media.ACCEPT_VISUAL) || ACCEPT_VISUAL_FALLBACK));
    if (!list.length) return false;
    const { media } = await importFiles(list, list.length > 1 ? 'Adding videos and photos' : 'Adding a video or photo');
    if (!media.length || !stillEditable(media)) return false;
    const visual = media.filter((m) => m.type === 'video' || m.type === 'image');
    const audio = media.filter((m) => m.type === 'audio');
    for (const m of media) store.addMedia(m);
    const items = visual.map(newVisualItem);
    let at = insertIndex('end');
    let musicIds = [];
    structuralUpdate((p) => {
      at = clamp(at, 0, p.items.length);
      p.items.splice(at, 0, ...items);
      if (audio.length) musicIds = placeMusic(p, audio, null);
    }, { label: items.length ? (items.length === 1 ? `Add ${visual[0].type === 'video' ? 'video' : 'photo'}` : 'Add videos and photos') : 'Add music' });
    if (items.length) select('item', items.map((i) => i.id));
    else if (musicIds.length) select('music', musicIds);
    afterMediaAdded(media);
    return items.map((i) => i.id).concat(musicIds);
  }

  async function addMusic(files, atPlayhead) {
    let list = fileList(files);
    if (!list.length) list = fileList(await pickFiles((app.media && app.media.ACCEPT_AUDIO) || ACCEPT_AUDIO_FALLBACK));
    if (!list.length) return false;
    const { media } = await importFiles(list, 'Adding music');
    if (!media.length || !stillEditable(media)) return false;
    const usable = [];
    for (const m of media) {
      if (m.type === 'image') {
        toast(`“${m.name || 'That file'}” is a picture, not music. Use Add videos and photos for pictures.`, 'error');
        revoke(m);
      } else if (m.type === 'video' && m.hasAudio === false) {
        toast(`“${m.name || 'That video'}” has no sound that can be used as music.`, 'error');
        revoke(m);
      } else {
        usable.push(m);
      }
    }
    if (!usable.length) return false;
    for (const m of usable) store.addMedia(m);
    const start = atPlayhead ? now() : null;
    let ids = [];
    store.update((p) => { ids = placeMusic(p, usable, start); },
      { label: atPlayhead ? 'Add music at the current point' : 'Add music' });
    select('music', ids);
    afterMediaAdded(usable);
    return ids;
  }

  async function webcam() {
    const d = dialogs();
    if (!d || typeof d.openWebcam !== 'function') { toast('Recording webcam video isn’t available right now.', 'error'); return false; }
    const file = await d.openWebcam();
    if (!isFileLike(file)) return false;
    const { media } = await importFiles([file], 'Adding webcam video');
    const m = media.find((x) => x.type === 'video' || x.type === 'image');
    for (const x of media) if (x !== m) revoke(x);
    if (!m || !stillEditable([m])) return false;
    store.addMedia(m);
    const item = newVisualItem(m);
    let at = insertIndex('nearest');
    structuralUpdate((p) => { at = clamp(at, 0, p.items.length); p.items.splice(at, 0, item); }, { label: 'Add webcam video' });
    select('item', item.id);
    afterMediaAdded([m]);
    return item.id;
  }

  async function narration() {
    const d = dialogs();
    if (!d || typeof d.openNarration !== 'function') { toast('Recording narration isn’t available right now.', 'error'); return false; }
    const file = await d.openNarration();
    if (!isFileLike(file)) return false;
    // The dialog puts the playhead back where recording started.
    const start = now();
    const { media } = await importFiles([file], 'Adding narration');
    const m = media.find((x) => x.type === 'audio' || x.type === 'video');
    for (const x of media) if (x !== m) revoke(x);
    if (!m || !stillEditable([m])) return false;
    store.addMedia(m);
    let ids = [];
    store.update((p) => { ids = placeMusic(p, [m], start, 'narration'); }, { label: 'Record narration' });
    select('music', ids);
    afterMediaAdded([m]);
    return ids[0];
  }

  async function snapshot() {
    const ex = app.exporter;
    if (!ex || typeof ex.snapshot !== 'function') { toast('Snapshots aren’t available right now.', 'error'); return false; }
    if (!(timelineDuration() > 0)) { toast('Add some videos or photos before taking a snapshot.'); return false; }
    const t = now();
    const at0 = insertIndex('after');
    const blob = await ex.snapshot(t);
    if (!blob || typeof blob.size !== 'number' || !blob.size) throw friendlyError('The snapshot couldn’t be taken. Please try again.');
    const name = `Snapshot ${stamp()}.png`;
    let file = blob;
    try { file = new File([blob], name, { type: blob.type || 'image/png', lastModified: Date.now() }); } catch (_) {
      try { Object.defineProperty(blob, 'name', { value: name }); } catch (__) { /* keep the blob */ }
    }
    const { media } = await importFiles([file], 'Adding snapshot');
    const m = media.find((x) => x.type === 'image');
    for (const x of media) if (x !== m) revoke(x);
    if (!m || !stillEditable([m])) return false;
    store.addMedia(m);
    const item = newVisualItem(m);
    let at = at0;
    structuralUpdate((p) => { at = clamp(at, 0, p.items.length); p.items.splice(at, 0, item); }, { label: 'Add snapshot' });
    select('item', item.id);
    return item.id;
  }

  /** Inline editing of a title / caption / credits on the preview (falls back to a dialog). */
  function startTextEdit(id) {
    const pv = app.preview;
    if (pv && typeof pv.editText === 'function') {
      try { if (pv.editText(id) !== false) return true; } catch (err) { if (typeof console !== 'undefined') console.warn('[commands] editText failed', err); }
    }
    return false;
  }

  function seekToShow(start, duration) {
    const p = player();
    if (!p) return;
    const t = now();
    if (t >= start && t < start + duration) return;
    seek(start + Math.min(0.5, duration / 2));
  }

  function addTitle() {
    const s = selection();
    let at = 0;
    if (s.type === 'item' && s.ids.length) {
      const idx = store.project.items.findIndex((i) => s.ids.includes(i.id));
      if (idx >= 0) at = idx;
    }
    const name = typeof store.project.name === 'string' && store.project.name.trim() ? store.project.name : 'My Movie';
    const item = model.createVisualItem('title', {
      text: name,
      duration: DEFAULT_TITLE_DURATION,
      transition: { type: 'none', duration: transitionDuration() },
    });
    structuralUpdate((p) => { p.items.splice(clamp(at, 0, p.items.length), 0, item); }, { label: 'Add title' });
    select('item', item.id);
    const seg = store.timeline.segments.find((x) => x.item.id === item.id);
    if (seg) seekToShow(seg.start, seg.duration);
    startTextEdit(item.id);
    return item.id;
  }

  function addCaption() {
    const tl = store.timeline;
    const limit = visualsEndOf(tl) || tl.duration;
    if (!(limit > 0)) { toast('Add some videos or photos first, then add a caption.'); return false; }
    const start = clamp(now(), 0, Math.max(0, limit - EDGE_GUARD));
    const it = model.createTextItem('caption', { start: round3(start), duration: DEFAULT_CAPTION_DURATION });
    store.update((p) => { p.texts.push(it); }, { label: 'Add caption' });
    select('text', it.id);
    seekToShow(it.start, it.duration);
    startTextEdit(it.id);
    return it.id;
  }

  function addCredits() {
    const tl = store.timeline;
    let start = visualsEndOf(tl);
    // More credits go after the credits that already follow the pictures.
    for (const x of tl.texts) {
      if (x.item.kind === 'credits' && x.start >= start - 0.05) start = Math.max(start, x.end);
    }
    const it = model.createTextItem('credits', { text: DEFAULT_CREDITS_TEXT, start: round3(start), effect: 'scroll' });
    store.update((p) => { p.texts.push(it); }, { label: 'Add credits' });
    select('text', it.id);
    seekToShow(it.start, it.duration);
    startTextEdit(it.id);
    return it.id;
  }

  // ------------------------------------------------------------------ AutoMovie

  function autoMovie(themeId) {
    if (!store.project.items.length) { toast('Add some videos and photos first, then choose an AutoMovie theme.'); return false; }
    const res = applyAutoMovie(store, typeof themeId === 'string' ? themeId : 'default');
    if (!res || !res.ok) {
      toast(res && res.reason === 'empty' ? 'Add some videos and photos first, then choose an AutoMovie theme.' : 'The AutoMovie theme couldn’t be applied.', 'error');
      return false;
    }
    const done = [];
    if (res.titleAdded && res.creditsAdded) done.push('added an opening title and credits');
    else if (res.titleAdded) done.push('added an opening title');
    else if (res.creditsAdded) done.push('added credits');
    if (res.fitted) done.push('fit your photos to the music');
    const what = done.length ? ` — ${done.join(' and ')}` : '';
    toast(`AutoMovie theme “${res.themeName}” applied${what}. Choose Undo to go back.`, 'success');
    return res;
  }

  // ------------------------------------------------------------------ clipboard & editing

  function copy() {
    const s = selection();
    if (!s.type || !s.ids.length) return false;
    const objs = selectedOf(s.type);
    if (!objs.length) return false;
    const mediaIds = [...new Set(objs.map((o) => o.mediaId).filter(Boolean))];
    store.clipboard = {
      type: s.type,
      objs: deepClone(objs),
      // Keep the media so the copy can be pasted into another project too.
      media: mediaIds.map(getMedia).filter(Boolean),
      at: Date.now(),
    };
    return true;
  }

  function clipboardValid() {
    const c = store.clipboard;
    return !!(c && ['item', 'text', 'music'].includes(c.type) && Array.isArray(c.objs) && c.objs.length);
  }

  function remove(label = 'Remove') {
    const s = selection();
    if (!s.type || !s.ids.length) return false;
    const type = s.type;
    const ids = s.ids.slice();
    if (!collectionOf(store.project, type).some((o) => ids.includes(o.id))) return false;
    (type === 'item' ? structuralUpdate : store.update.bind(store))((p) => {
      const kept = collectionOf(p, type).filter((o) => !ids.includes(o.id));
      if (type === 'item') p.items = kept;
      else if (type === 'text') p.texts = kept;
      else p.music = kept;
    }, { label });
    select(null, []);
    return true;
  }

  function cut() {
    if (!copy()) return false;
    return remove('Cut');
  }

  function paste() {
    if (!clipboardValid()) return false;
    const clip = store.clipboard;
    // Media of a copy from another project.
    for (const m of clip.media || []) {
      if (!m || !m.id || getMedia(m.id)) continue;
      // Opening another project revoked its object URL: make a fresh one.
      try {
        if (m.blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') m.url = URL.createObjectURL(m.blob);
      } catch (_) { /* keep the old url */ }
      store.addMedia(m);
    }
    const copies = clip.objs.map((o) => {
      const src = deepClone(o);
      if (clip.type === 'item') return model.createVisualItem(src.kind, { ...src, id: newId('item') });
      if (clip.type === 'text') return model.createTextItem(src.kind, { ...src, id: newId('text') });
      return model.createMusicItem({ ...src, id: newId('music') });
    });
    const ids = copies.map((c) => c.id);
    if (clip.type === 'item') {
      let at = insertIndex('nearest');
      structuralUpdate((p) => { at = clamp(at, 0, p.items.length); p.items.splice(at, 0, ...copies); }, { label: 'Paste' });
    } else {
      const t = now();
      const first = Math.min(...copies.map((c) => num(c.start, 0)));
      for (const c of copies) c.start = round3(Math.max(0, t + (num(c.start, 0) - first)));
      store.update((p) => { (clip.type === 'text' ? p.texts : p.music).push(...copies); }, { label: 'Paste' });
    }
    select(clip.type, ids);
    if (clip.type !== 'text') afterMediaAdded(clip.media || []);
    return ids;
  }

  function selectAll() {
    const ids = store.project.items.map((i) => i.id);
    if (!ids.length) return false;
    select('item', ids);
    return true;
  }

  function rotate(dir) {
    const objs = selPictures();
    if (!objs.length) { toast(MSG.selectPicture); return false; }
    return editObjs('item', objs, dir < 0 ? 'Rotate left' : 'Rotate right', (o) => {
      const r = [0, 90, 180, 270].includes(o.rotation) ? o.rotation : 0;
      o.rotation = (r + (dir < 0 ? 270 : 90)) % 360;
    });
  }

  function moveItem(arg) {
    const id = arg && arg.id;
    const items = store.project.items;
    const from = items.findIndex((i) => i.id === id);
    if (from < 0) return false;
    const want = toNum(arg.toIndex);
    if (!Number.isFinite(want)) return false;
    const to = clamp(Math.round(want), 0, items.length - 1);
    if (to === from) return false;
    structuralUpdate((p) => {
      const f = p.items.findIndex((i) => i.id === id);
      if (f < 0) return;
      const [it] = p.items.splice(f, 1);
      p.items.splice(clamp(to, 0, p.items.length), 0, it);
    }, { label: 'Move' });
    return true;
  }

  function moveTimed(type, arg) {
    const id = arg && arg.id;
    const found = collectionOf(store.project, type).find((o) => o.id === id);
    if (!found) return false;
    const start = toNum(arg.start);
    if (!Number.isFinite(start)) return false;
    const s = round3(Math.max(0, start));
    if (Math.abs(s - num(found.start, 0)) < 1e-4) return false;
    store.update((p) => {
      const o = collectionOf(p, type).find((x) => x.id === id);
      if (o) o.start = s;
    }, { label: type === 'music' ? (found.kind === 'narration' ? 'Move narration' : 'Move music') : (found.kind === 'credits' ? 'Move credits' : 'Move caption') });
    return true;
  }

  // ------------------------------------------------------------------ Animations / Visual Effects

  function setTransition(id) {
    if (!catalogHas('TRANSITIONS', id)) { if (typeof console !== 'undefined') console.warn(`[commands] unknown transition "${id}"`); return false; }
    const objs = selVisual();
    if (!objs.length) { toast(MSG.selectItem); return false; }
    const def = transitionDuration();
    return editObjs('item', objs, id === 'none' ? 'Remove transition' : 'Apply transition', (o) => {
      const d = o.transition && num(o.transition.duration, 0) > 0 ? o.transition.duration : def;
      o.transition = { type: id, duration: d };
    }, { same: (o) => !!o.transition && o.transition.type === id && num(o.transition.duration, 0) > 0, structural: true });
  }

  function setTransitionDuration(v) {
    const n = toNum(v);
    if (!(n > 0)) return false;
    const d = round3(clamp(n, MIN_TRANSITION, MAX_TRANSITION));
    const objs = selVisual();
    if (!objs.length) { toast(MSG.selectItem); return false; }
    return editObjs('item', objs, 'Change transition duration', (o) => {
      o.transition = { type: (o.transition && o.transition.type) || 'none', duration: d };
    }, { same: (o) => !!o.transition && Math.abs(num(o.transition.duration, -1) - d) < 1e-6, coalesceKey: 'transitionDuration', structural: true });
  }

  function applyToAll(label, srcList, targetFilter, read, write, emptyMsg, structural = false) {
    const src = srcList[0];
    if (!src) { toast(emptyMsg); return false; }
    const value = read(src);
    const targets = store.project.items.filter(targetFilter);
    return editObjs('item', targets, label, (o) => write(o, deepClone(value)),
      { same: (o) => JSON.stringify(read(o)) === JSON.stringify(value), structural });
  }

  function applyTransitionAll() {
    return applyToAll('Apply transition to all', selVisual(), () => true,
      (o) => ({ type: (o.transition && o.transition.type) || 'none', duration: o.transition && num(o.transition.duration, 0) > 0 ? o.transition.duration : transitionDuration() }),
      (o, v) => { o.transition = v; }, MSG.selectItem, true);
  }

  function setPanZoom(id) {
    if (!catalogHas('PANZOOM', id)) { if (typeof console !== 'undefined') console.warn(`[commands] unknown pan and zoom "${id}"`); return false; }
    const objs = selPictures();
    if (!objs.length) { toast(selTitles().length ? 'Pan and zoom works on photos and videos.' : MSG.selectPicture); return false; }
    return editObjs('item', objs, id === 'none' ? 'Remove pan and zoom' : 'Apply pan and zoom', (o) => { o.panZoom = id; },
      { same: (o) => o.panZoom === id });
  }

  function applyPanZoomAll() {
    return applyToAll('Apply pan and zoom to all', selPictures(), (i) => i.kind === 'video' || i.kind === 'image',
      (o) => o.panZoom || 'none', (o, v) => { o.panZoom = v; }, MSG.selectPicture);
  }

  function setEffect(id) {
    if (!catalogHas('EFFECTS', id)) { if (typeof console !== 'undefined') console.warn(`[commands] unknown effect "${id}"`); return false; }
    const objs = selVisual();
    if (!objs.length) { toast(MSG.selectItem); return false; }
    return editObjs('item', objs, id === 'none' ? 'Remove visual effect' : 'Apply visual effect', (o) => { o.effect = id; },
      { same: (o) => o.effect === id });
  }

  function applyEffectAll() {
    return applyToAll('Apply visual effect to all', selVisual(), () => true,
      (o) => o.effect || 'none', (o, v) => { o.effect = v; }, MSG.selectItem);
  }

  function setBrightness(v) {
    const n = toNum(v);
    if (!Number.isFinite(n)) return false;
    const b = Math.round(clamp(n, -100, 100));
    const objs = selVisual();
    if (!objs.length) { toast(MSG.selectItem); return false; }
    return editObjs('item', objs, 'Change brightness', (o) => { o.brightness = b; },
      { same: (o) => o.brightness === b, coalesceKey: 'brightness' });
  }

  // ------------------------------------------------------------------ Project tab

  function setAspect(a) {
    if (typeof a !== 'string' || !Object.prototype.hasOwnProperty.call(ASPECTS, a)) return false;
    if (store.project.aspect === a) return false;
    store.update((p) => { p.aspect = a; }, { label: 'Change aspect ratio' });
    return true;
  }

  function setAudioMix(v) {
    const n = toNum(v);
    if (!Number.isFinite(n)) return false;
    const mix = Math.round(clamp(n, -1, 1) * 100) / 100;
    if (Math.abs(num(store.project.audioMix, 0) - mix) < 1e-9) return false;
    store.update((p) => { p.audioMix = mix; }, { label: 'Change audio mix', coalesceKey: 'audioMix' });
    return true;
  }

  const narrationEmphasized = (p) => p.emphasize === 'narration' || p.duckMusic === true;

  function emphasize(what) {
    const p0 = store.project;
    if (what === 'video' || what === 'music') {
      const mix = what === 'video' ? -0.6 : 0.6;
      if (Math.abs(num(p0.audioMix, 0) - mix) < 1e-9 && !narrationEmphasized(p0)) return false;
      store.update((p) => {
        p.audioMix = mix;
        if ('emphasize' in p) delete p.emphasize;
        if ('duckMusic' in p) p.duckMusic = false;
      }, { label: what === 'video' ? 'Emphasize video' : 'Emphasize music' });
      return true;
    }
    if (what === 'narration') {
      const on = narrationEmphasized(p0);
      store.update((p) => {
        if (on) {
          delete p.emphasize;
          if ('duckMusic' in p) p.duckMusic = false;
        } else {
          // Narration plays on the music bus: lean the mix away from the video sound and let the
          // audio engine turn the music down while narration plays.
          p.emphasize = 'narration';
          p.audioMix = 0.4;
        }
      }, { label: on ? 'Stop emphasizing narration' : 'Emphasize narration' });
      if (!on && !p0.music.some((m) => m.kind === 'narration')) {
        toast('Music will be turned down while narration plays. Use Record narration on the Home tab to add some.');
      }
      return true;
    }
    return false;
  }

  function fitToMusic() {
    const trial = deepClone(store.project);
    const res = fitVisualsToMusic(trial, store.media, { allowShrink: true });
    if (!res.ok) {
      const msg = {
        'no-music': 'Add music first, then choose Fit to music.',
        'no-photos': 'Fit to music changes how long photos and titles are shown. Add some photos first.',
        'videos-longer': 'The music is shorter than your videos, so the photos can’t be fitted to it. Trim your videos or add more music.',
      }[res.reason] || 'The photos couldn’t be fitted to the music.';
      toast(msg);
      return false;
    }
    if (!res.changed) { toast('Your movie already ends with the music.'); return false; }
    structuralUpdate((p) => { fitVisualsToMusic(p, store.media, { allowShrink: true }); }, { label: 'Fit to music' });
    return true;
  }

  // ------------------------------------------------------------------ View tab

  function zoom(factor) {
    const z = num(store.view && store.view.zoom, 40);
    const next = clamp(z * factor, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(next - z) < 1e-9) return false;
    store.setView({ zoom: next });
    return true;
  }

  // ------------------------------------------------------------------ Video Tools › Edit

  function setVolume(v) {
    let n = toNum(v);
    if (!Number.isFinite(n)) return false;
    if (n > 1) n /= 100; // percent
    const vol = Math.round(clamp(n, 0, 1) * 100) / 100;
    const objs = selVideos();
    if (!objs.length) { toast(MSG.selectVideo); return false; }
    return editObjs('item', objs, 'Change video volume', (o) => { o.volume = vol; },
      { same: (o) => Math.abs(num(o.volume, 1) - vol) < 1e-9, coalesceKey: 'volume' });
  }

  function setFade(key, v, objsFn, type, label, emptyMsg) {
    if (!FADES.includes(v)) return false;
    const objs = objsFn();
    if (!objs.length) { toast(emptyMsg); return false; }
    return editObjs(type, objs, label, (o) => { o[key] = v; }, { same: (o) => o[key] === v });
  }

  function setSpeed(v) {
    const n = toNum(v);
    if (!(n > 0)) return false;
    const speed = clamp(n, 0.01, 64);
    const objs = selVideos();
    if (!objs.length) { toast(MSG.selectVideo); return false; }
    return editObjs('item', objs, 'Change speed', (o) => { o.speed = speed; },
      { same: (o) => Math.abs(num(o.speed, 1) - speed) < 1e-9, structural: true });
  }

  function setDuration(v) {
    const n = toNum(v);
    if (!(n > 0)) return false;
    const d = round3(clamp(n, MIN_ITEM_DURATION, MAX_ITEM_DURATION));
    const objs = selStills();
    if (!objs.length) {
      toast(selVideos().length ? 'Duration can be changed for photos and titles. To shorten a video, use the Trim tool.' : 'Select a photo or title in the storyboard first.');
      return false;
    }
    return editObjs('item', objs, 'Change duration', (o) => { o.duration = d; },
      { same: (o) => Math.abs(num(o.duration, 0) - d) < 1e-9, coalesceKey: 'duration', structural: true });
  }

  function split() {
    const t = now();
    const r = segmentForPlayhead(t, () => true, MSG.selectItem);
    if (r.error) { toast(r.error); return false; }
    const seg = r.seg;
    const item = seg.item;
    const local = t - seg.start;
    if (!(seg.duration >= 2 * EDGE_GUARD) || local < EDGE_GUARD || seg.duration - local < EDGE_GUARD) {
      toast('Move the playhead a little further from the beginning or end of the item to split it.');
      return false;
    }
    const speed = item.speed > 0 ? item.speed : 1;
    const srcSplit = seg.sourceIn + local * speed;
    const secondId = newId('item');
    const def = transitionDuration();
    store.update((p) => {
      const idx = p.items.findIndex((i) => i.id === item.id);
      if (idx < 0) return;
      const a = p.items[idx];
      const b = deepClone(a);
      b.id = secondId;
      if (a.kind === 'video') {
        a.trimEnd = srcSplit;          // first half ends at the split…
        b.trimStart = srcSplit;        // …second half starts there and keeps the original end
        a.fadeOut = 'none';
        b.fadeIn = 'none';
      } else {
        a.duration = local;
        b.duration = seg.duration - local;
      }
      // The two halves play back to back.
      b.transition = { type: 'none', duration: a.transition && num(a.transition.duration, 0) > 0 ? a.transition.duration : def };
      p.items.splice(idx + 1, 0, b);
    }, { label: 'Split' });
    select('item', secondId);
    return secondId;
  }

  function trimTool() {
    const d = dialogs();
    const video = selVideos()[0];
    if (!video) { toast(selVisual().length ? 'The Trim tool works on videos. Select a video in the storyboard first.' : MSG.selectVideo); return false; }
    if (!d || typeof d.openTrim !== 'function') { toast('The Trim tool isn’t available right now.', 'error'); return false; }
    return d.openTrim(video.id);
  }

  function setPoint(which) {
    const t = now();
    const r = segmentForPlayhead(t, (it) => it.kind === 'video', 'Set start point and Set end point work on videos. Select a video first.');
    if (r.error) { toast(r.error); return false; }
    const seg = r.seg;
    const local = t - seg.start;
    if (local < EDGE_GUARD || seg.duration - local < EDGE_GUARD) { toast(MSG.edge); return false; }
    const speed = seg.item.speed > 0 ? seg.item.speed : 1;
    const src = seg.sourceIn + local * speed;
    const id = seg.item.id;
    structuralUpdate((p) => {
      const o = p.items.find((i) => i.id === id);
      if (!o) return;
      if (which === 'start') o.trimStart = src;
      else o.trimEnd = src;
    }, { label: which === 'start' ? 'Set start point' : 'Set end point' });
    if (which === 'start') {
      // The frame that was under the playhead is now the first frame of the item.
      const ns = store.timeline.segments.find((x) => x.item.id === id);
      if (ns) seek(ns.start);
    }
    return true;
  }

  function setBackground(color) {
    if (!isColor(color)) return false;
    const objs = selTitles();
    if (!objs.length) {
      if (selTexts().length) return textSet({ key: 'background', value: color });
      toast('Select a title in the storyboard first.');
      return false;
    }
    const c = color.trim();
    return editObjs('item', objs, 'Change background color', (o) => { o.background = c; },
      { same: (o) => sameColor(o.background, c), coalesceKey: 'titleBackground' });
  }

  // ------------------------------------------------------------------ Music Tools › Options

  function musicVolume(v) {
    let n = toNum(v);
    if (!Number.isFinite(n)) return false;
    if (n > 1) n /= 100;
    const vol = Math.round(clamp(n, 0, 1) * 100) / 100;
    const objs = selMusic();
    if (!objs.length) { toast(MSG.selectMusic); return false; }
    return editObjs('music', objs, 'Change music volume', (o) => { o.volume = vol; },
      { same: (o) => Math.abs(num(o.volume, 1) - vol) < 1e-9, coalesceKey: 'musicVolume' });
  }

  function musicStartTime(v) {
    const explicit = v !== undefined && v !== null && v !== '';
    const t = explicit ? toNum(v) : now();
    if (!Number.isFinite(t)) return false;
    const start = round3(Math.max(0, t));
    const objs = selMusic();
    if (!objs.length) { toast(MSG.selectMusic); return false; }
    const delta = start - num(objs[0].start, 0);
    if (Math.abs(delta) < 1e-4) return false;
    return editObjs('music', objs, 'Change music start time', (o) => { o.start = round3(Math.max(0, num(o.start, 0) + delta)); },
      { coalesceKey: explicit ? 'musicStart' : undefined });
  }

  function musicPoint(which) {
    const t = now();
    const r = musicForPlayhead(t);
    if (r.error) { toast(r.error); return false; }
    const { entry } = r;
    const local = t - entry.start;
    const len = entry.end - entry.start;
    if (local < EDGE_GUARD || len - local < EDGE_GUARD) { toast(MSG.edge); return false; }
    const id = entry.item.id;
    const src = Math.max(0, num(entry.item.trimStart, 0)) + local;
    if (which === 'split') {
      const secondId = newId('music');
      store.update((p) => {
        const idx = p.music.findIndex((m) => m.id === id);
        if (idx < 0) return;
        const a = p.music[idx];
        const b = deepClone(a);
        b.id = secondId;
        b.start = round3(entry.start + local);
        b.trimStart = src;
        a.trimEnd = src;
        a.fadeOut = 'none';
        b.fadeIn = 'none';
        p.music.splice(idx + 1, 0, b);
      }, { label: 'Split music' });
      select('music', secondId);
      return secondId;
    }
    store.update((p) => {
      const o = p.music.find((m) => m.id === id);
      if (!o) return;
      // Like WLMM: the start time in the movie stays; the start/end point moves within the song.
      if (which === 'start') o.trimStart = src;
      else o.trimEnd = src;
    }, { label: which === 'start' ? 'Set music start point' : 'Set music end point' });
    return true;
  }

  // ------------------------------------------------------------------ Text Tools › Format

  function textSet(arg) {
    if (!isObj(arg)) return false;
    const changes = {};
    const pairs = 'key' in arg ? [[arg.key, arg.value]] : Object.entries(arg);
    for (const [key, value] of pairs) {
      const spec = STYLE_KEYS[key];
      if (!spec) continue;
      const v = spec.check(value);
      if (v !== undefined) changes[key] = v;
    }
    const keys = Object.keys(changes);
    if (!keys.length) return false;
    const { type, objs } = textTargets();
    if (!objs.length) { toast(MSG.selectText); return false; }
    const label = keys.length === 1 ? STYLE_KEYS[keys[0]].label : 'Change text format';
    const coalesceKey = keys.length === 1 && STYLE_KEYS[keys[0]].coalesce ? `textSet:${keys[0]}` : undefined;
    return editObjs(type, objs, label, (o) => {
      const kind = type === 'text' ? o.kind : 'title';
      const base = isObj(o.style) ? o.style : (typeof model.defaultTextStyle === 'function' ? model.defaultTextStyle(kind) : {});
      o.style = { ...base, ...changes };
    }, { same: (o) => isObj(o.style) && keys.every((k) => o.style[k] === changes[k]), coalesceKey });
  }

  function textEdit(text) {
    const { type, objs } = textTargets();
    const target = objs[0];
    if (!target) { toast(MSG.selectText); return false; }
    if (text !== undefined && text !== null) {
      const value = String(text);
      if (value === target.text) return false;
      return editObjs(type, [target], 'Edit text', (o) => { o.text = value; });
    }
    if (startTextEdit(target.id)) return true;
    const d = dialogs();
    if (d && typeof d.promptText === 'function') {
      return Promise.resolve(d.promptText('Edit text', target.text || '', { label: 'Text', okLabel: 'OK' })).then((v) => {
        if (typeof v !== 'string' || busyReason('edit')) return false;
        const o = store.find ? store.find(target.id) : null;
        if (!o) return false;
        if (v === o.obj.text) return false;
        return editObjs(o.type, [o.obj], 'Edit text', (x) => { x.text = v; });
      });
    }
    return false;
  }

  function textDuration(v) {
    const n = toNum(v);
    if (!(n > 0)) return false;
    const d = round3(clamp(n, MIN_ITEM_DURATION, MAX_ITEM_DURATION));
    const { type, objs } = textTargets();
    if (!objs.length) { toast(MSG.selectText); return false; }
    return editObjs(type, objs, 'Change text duration', (o) => { o.duration = d; },
      { same: (o) => Math.abs(num(o.duration, 0) - d) < 1e-9, coalesceKey: 'textDuration', structural: type === 'item' });
  }

  function textStartTime(v) {
    const explicit = v !== undefined && v !== null && v !== '';
    const t = explicit ? toNum(v) : now();
    if (!Number.isFinite(t)) return false;
    const start = round3(Math.max(0, t));
    const objs = selTexts();
    if (!objs.length) {
      toast(selTitles().length ? 'A title’s place is set by its position in the storyboard. Drag it to move it.' : MSG.selectCaption);
      return false;
    }
    const delta = start - num(objs[0].start, 0);
    if (Math.abs(delta) < 1e-4) return false;
    return editObjs('text', objs, 'Change text start time', (o) => { o.start = round3(Math.max(0, num(o.start, 0) + delta)); },
      { coalesceKey: explicit ? 'textStart' : undefined });
  }

  function textEffect(id) {
    if (!catalogHas('TEXT_EFFECTS', id)) { if (typeof console !== 'undefined') console.warn(`[commands] unknown text effect "${id}"`); return false; }
    const { type, objs } = textTargets();
    if (!objs.length) { toast(MSG.selectText); return false; }
    const key = type === 'text' ? 'effect' : 'textEffect';
    return editObjs(type, objs, id === 'none' ? 'Remove text effect' : 'Apply text effect', (o) => { o[key] = id; },
      { same: (o) => o[key] === id });
  }

  // ------------------------------------------------------------------ playback

  function playerCall(fn) {
    const p = player();
    if (!p) return undefined;
    return fn(p);
  }

  function itemStep(dir) {
    const tl = store.timeline;
    const segs = tl.segments;
    if (!segs.length) return false;
    const t = now();
    let target;
    if (dir > 0) {
      const next = segs.find((s) => s.start > t + 0.01);
      target = next ? next.start : tl.duration;
    } else {
      // Within the first quarter second of an item, go to the previous one.
      let prev = 0;
      for (const s of segs) if (s.start < t - 0.25) prev = s.start;
      target = prev;
    }
    seek(target);
    return true;
  }

  // ------------------------------------------------------------------ projects

  function projectHasContent() {
    const p = store.project;
    return !!(p && (p.items.length || p.texts.length || p.music.length));
  }

  async function newProject() {
    const d = dialogs();
    if (projectHasContent() && d && typeof d.confirm === 'function') {
      const name = store.project.name || 'My Movie';
      const ok = await d.confirm(`Start a new project?\n\n“${name}” is saved on this device. You can open it again with Open project.`,
        { title: 'New project', okLabel: 'New project' });
      if (!ok) return false;
    }
    if (exporting()) { toast(MSG.exporting, 'error'); return false; }
    if (d && typeof d.newProject === 'function') { await d.newProject(); return true; }
    const persist = app.persist;
    if (persist && typeof persist.saveProject === 'function' && projectHasContent()) {
      try { await persist.saveProject(store.project, store.media); } catch (_) { /* reported by autosave */ }
    }
    const p = player();
    if (p && p.playing) { try { p.pause(); } catch (_) { /* ignore */ } }
    store.replaceProject(model.createProject(), new Map());
    if (persist && typeof persist.setLastProjectId === 'function') {
      try { await persist.setLastProjectId(null); } catch (_) { /* ignore */ }
    }
    return true;
  }

  async function openProject() {
    const d = dialogs();
    if (d && typeof d.openProjects === 'function') return d.openProjects();
    toast('Opening projects isn’t available right now.', 'error');
    return false;
  }

  async function saveProject() {
    const d = dialogs();
    if (d && typeof d.saveProject === 'function') return d.saveProject();
    const persist = app.persist;
    if (!persist || typeof persist.saveProject !== 'function') { toast('Saving projects isn’t available in this browser.', 'error'); return false; }
    try {
      await persist.saveProject(store.project, store.media);
      if (typeof persist.setLastProjectId === 'function') { try { await persist.setLastProjectId(store.project.id); } catch (_) { /* ignore */ } }
    } catch (err) {
      toast(messageOf(err, 'The project couldn’t be saved.'), 'error');
      return false;
    }
    toast('Project saved', 'success');
    return true;
  }

  async function saveProjectAs() {
    const d = dialogs();
    if (d && typeof d.saveProjectAs === 'function') return d.saveProjectAs();
    const persist = app.persist;
    if (!persist || typeof persist.saveProject !== 'function') { toast('Saving projects isn’t available in this browser.', 'error'); return false; }
    if (!d || typeof d.promptText !== 'function') return saveProject();
    const name = await d.promptText('Save project as', store.project.name || 'My Movie');
    if (typeof name !== 'string') return false;
    const clean = name.trim() || store.project.name || 'My Movie';
    const copyP = deepClone(store.project);
    copyP.id = newId('proj');
    copyP.name = clean;
    copyP.createdAt = Date.now();
    copyP.updatedAt = Date.now();
    try {
      await persist.saveProject(copyP, store.media);
    } catch (err) {
      toast(messageOf(err, 'The project couldn’t be saved.'), 'error');
      return false;
    }
    store.replaceProject(copyP, store.media);
    if (typeof persist.setLastProjectId === 'function') { try { await persist.setLastProjectId(copyP.id); } catch (_) { /* ignore */ } }
    toast(`Saved as “${clean}”.`, 'success');
    return true;
  }

  async function importProjectFile(file) {
    const d = dialogs();
    if (d && typeof d.importProjectFromFile === 'function') return d.importProjectFromFile(isFileLike(file) ? file : undefined);
    const persist = app.persist;
    if (!persist || typeof persist.importProjectFile !== 'function') { toast('Importing projects isn’t available right now.', 'error'); return false; }
    let f = isFileLike(file) ? file : null;
    if (!f) {
      const files = await (app.media && typeof app.media.pickFiles === 'function' ? app.media.pickFiles(PROJECT_ACCEPT, false) : []);
      f = fileList(files)[0] || null;
    }
    if (!f) return false;
    const prog = d && typeof d.progress === 'function' ? d.progress('Importing project', { cancelable: false }) : null;
    try {
      const res = await persist.importProjectFile(f, { onProgress: (p) => { if (prog && prog.set) prog.set(p); } });
      if (exporting()) { toast(MSG.exporting, 'error'); return false; }
      const p = player();
      if (p && p.playing) { try { p.pause(); } catch (_) { /* ignore */ } }
      store.replaceProject(res.project, res.media);
      if (typeof persist.setLastProjectId === 'function') { try { await persist.setLastProjectId(res.project.id); } catch (_) { /* ignore */ } }
      toast(`Imported “${res.project.name || 'My Movie'}”.`, 'success');
      return true;
    } catch (err) {
      toast(messageOf(err, 'That project file couldn’t be imported.'), 'error');
      return false;
    } finally {
      if (prog && prog.close) prog.close();
    }
  }

  async function downloadFile(blob, name) {
    try {
      const mod = await import('./exporter.js');
      if (mod && typeof mod.downloadBlob === 'function') { await mod.downloadBlob(blob, name); return; }
    } catch (_) { /* plain link below */ }
    if (typeof document === 'undefined' || typeof URL === 'undefined') throw friendlyError('Saving files isn’t available here.');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
  }

  async function exportProjectFile() {
    const d = dialogs();
    if (d && typeof d.exportProjectFile === 'function') return d.exportProjectFile();
    const persist = app.persist;
    if (!persist || typeof persist.exportProjectFile !== 'function') { toast('Exporting projects isn’t available right now.', 'error'); return false; }
    const prog = d && typeof d.progress === 'function' ? d.progress('Export project file', { cancelable: false }) : null;
    try {
      const blob = await persist.exportProjectFile(store.project, store.media, { onProgress: (p) => { if (prog && prog.set) prog.set(p); } });
      const base = String(store.project.name || 'My Movie').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'My Movie';
      const name = typeof persist.projectFileName === 'function' ? persist.projectFileName(store.project) : `${base}.wlmmweb`;
      if (prog && prog.close) prog.close();
      await downloadFile(blob, name);
      toast(`“${name}” is ready.`, 'success');
      return true;
    } catch (err) {
      toast(messageOf(err, 'The project file couldn’t be created.'), 'error');
      return false;
    } finally {
      if (prog && prog.close) prog.close();
    }
  }

  function saveMovie(presetId) {
    if (!store.project.items.length) { toast('Add some videos or photos before saving a movie.'); return false; }
    const d = dialogs();
    if (!d || typeof d.openExport !== 'function') { toast('Saving movies isn’t available right now.', 'error'); return false; }
    return d.openExport(typeof presetId === 'string' && presetId ? presetId : 'recommended');
  }

  function dialogCall(method, missing) {
    const d = dialogs();
    if (d && typeof d[method] === 'function') return d[method]();
    toast(missing, 'error');
    return false;
  }

  // ------------------------------------------------------------------ registry

  const firstVisual = () => selVisual()[0] || null;
  const firstVideo = () => selVideos()[0] || null;
  const firstMusic = () => selMusic()[0] || null;
  const firstText = () => textTargets().objs[0] || null;
  const hasItems = () => store.project.items.length > 0;
  const hasDuration = () => timelineDuration() > 0;
  const hasSelection = () => { const s = selection(); return !!s.type && s.ids.length > 0 && selectedOf(s.type).length > 0; };
  const hasVisualSel = () => selVisual().length > 0;
  const hasMusicSel = () => selMusic().length > 0;
  const hasTextTarget = () => textTargets().objs.length > 0;
  const viewVal = (k, def) => (store.view && store.view[k] !== undefined ? store.view[k] : def);

  /** name → { kind, run(arg), enabled?(), checked?(arg) }. kind: edit | nav | view | project | app */
  const C = {
    addMedia: { kind: 'edit', run: (files) => addMedia(files) },
    addMusic: { kind: 'edit', run: (files) => addMusic(files, false) },
    addMusicAtPlayhead: { kind: 'edit', run: (files) => addMusic(files, true) },
    webcam: { kind: 'edit', run: () => webcam() },
    narration: { kind: 'edit', run: () => narration() },
    snapshot: { kind: 'edit', run: () => snapshot(), enabled: () => hasDuration() && !!(app.exporter && typeof app.exporter.snapshot === 'function') },
    addTitle: { kind: 'edit', run: () => addTitle() },
    addCaption: { kind: 'edit', run: () => addCaption(), enabled: () => hasItems() && hasDuration() },
    addCredits: { kind: 'edit', run: () => addCredits() },
    autoMovie: { kind: 'edit', run: (id) => autoMovie(id), enabled: hasItems, checked: () => false },

    cut: { kind: 'edit', run: () => cut(), enabled: hasSelection },
    copy: { kind: 'edit', run: () => copy(), enabled: hasSelection },
    paste: { kind: 'edit', run: () => paste(), enabled: clipboardValid },
    remove: { kind: 'edit', run: () => remove(), enabled: hasSelection },
    selectAll: { kind: 'view', run: () => selectAll(), enabled: hasItems },
    rotateLeft: { kind: 'edit', run: () => rotate(-1), enabled: () => selPictures().length > 0 },
    rotateRight: { kind: 'edit', run: () => rotate(1), enabled: () => selPictures().length > 0 },
    moveItem: { kind: 'edit', run: (a) => moveItem(a), enabled: () => store.project.items.length > 1 },
    moveText: { kind: 'edit', run: (a) => moveTimed('text', a), enabled: () => store.project.texts.length > 0 },
    moveMusic: { kind: 'edit', run: (a) => moveTimed('music', a), enabled: () => store.project.music.length > 0 },

    setTransition: {
      kind: 'edit', run: (id) => setTransition(id), enabled: hasVisualSel,
      checked: (id) => { const o = firstVisual(); return !!(o && o.transition && (o.transition.type || 'none') === id); },
    },
    setTransitionDuration: { kind: 'edit', run: (v) => setTransitionDuration(v), enabled: hasVisualSel },
    applyTransitionAll: { kind: 'edit', run: () => applyTransitionAll(), enabled: hasVisualSel },
    setPanZoom: {
      kind: 'edit', run: (id) => setPanZoom(id), enabled: () => selPictures().length > 0,
      checked: (id) => { const o = selPictures()[0]; return !!o && (o.panZoom || 'none') === id; },
    },
    applyPanZoomAll: { kind: 'edit', run: () => applyPanZoomAll(), enabled: () => selPictures().length > 0 },
    setEffect: {
      kind: 'edit', run: (id) => setEffect(id), enabled: hasVisualSel,
      checked: (id) => { const o = firstVisual(); return !!o && (o.effect || 'none') === id; },
    },
    applyEffectAll: { kind: 'edit', run: () => applyEffectAll(), enabled: hasVisualSel },
    setBrightness: { kind: 'edit', run: (v) => setBrightness(v), enabled: hasVisualSel },

    setAspect: { kind: 'edit', run: (a) => setAspect(a), checked: (a) => store.project.aspect === a },
    setAudioMix: { kind: 'edit', run: (v) => setAudioMix(v) },
    emphasize: {
      kind: 'edit', run: (w) => emphasize(w),
      checked: (w) => {
        const p = store.project;
        const mix = num(p.audioMix, 0);
        if (w === 'narration') return narrationEmphasized(p);
        if (w === 'video') return mix <= -0.5;
        if (w === 'music') return mix >= 0.5;
        return false;
      },
    },
    fitToMusic: {
      kind: 'edit', run: () => fitToMusic(),
      enabled: () => store.project.music.some((m) => m.kind !== 'narration') && store.project.items.some((i) => i.kind === 'image' || i.kind === 'title'),
    },

    zoomIn: { kind: 'view', run: () => zoom(ZOOM_STEP), enabled: () => num(viewVal('zoom', 40), 40) < ZOOM_MAX - 1e-9 },
    zoomOut: { kind: 'view', run: () => zoom(1 / ZOOM_STEP), enabled: () => num(viewVal('zoom', 40), 40) > ZOOM_MIN + 1e-9 },
    setThumbSize: {
      kind: 'view', run: (v) => { if (!THUMB_SIZES.includes(v)) return false; store.setView({ thumbSize: v }); return true; },
      checked: (v) => viewVal('thumbSize', 'medium') === v,
    },
    toggleWaveforms: {
      kind: 'view', run: (v) => { store.setView({ showWaveforms: typeof v === 'boolean' ? v : !viewVal('showWaveforms', true) }); return true; },
      checked: () => !!viewVal('showWaveforms', true),
    },
    setPreviewSize: {
      kind: 'view', run: (v) => { if (!PREVIEW_SIZES.includes(v)) return false; store.setView({ previewSize: v }); return true; },
      checked: (v) => viewVal('previewSize', 'normal') === v,
    },

    setVolume: { kind: 'edit', run: (v) => setVolume(v), enabled: () => selVideos().length > 0 },
    setFadeIn: {
      kind: 'edit', run: (v) => setFade('fadeIn', v, selVideos, 'item', 'Change fade in', MSG.selectVideo), enabled: () => selVideos().length > 0,
      checked: (v) => { const o = firstVideo(); return !!o && (o.fadeIn || 'none') === v; },
    },
    setFadeOut: {
      kind: 'edit', run: (v) => setFade('fadeOut', v, selVideos, 'item', 'Change fade out', MSG.selectVideo), enabled: () => selVideos().length > 0,
      checked: (v) => { const o = firstVideo(); return !!o && (o.fadeOut || 'none') === v; },
    },
    setSpeed: {
      kind: 'edit', run: (v) => setSpeed(v), enabled: () => selVideos().length > 0,
      checked: (v) => { const o = firstVideo(); const n = toNum(v); return !!o && Number.isFinite(n) && Math.abs(num(o.speed, 1) - n) < 1e-6; },
    },
    setDuration: { kind: 'edit', run: (v) => setDuration(v), enabled: () => selStills().length > 0 },
    split: {
      kind: 'edit', run: () => split(),
      enabled: () => { const s = selection(); return hasItems() && hasDuration() && (s.type === 'item' || !s.type); },
    },
    trimTool: { kind: 'edit', run: () => trimTool(), enabled: () => selVideos().length > 0 },
    setStartPoint: { kind: 'edit', run: () => setPoint('start'), enabled: () => selVideos().length > 0 },
    setEndPoint: { kind: 'edit', run: () => setPoint('end'), enabled: () => selVideos().length > 0 },
    setBackground: {
      kind: 'edit', run: (c) => setBackground(c), enabled: () => selTitles().length > 0,
      checked: (c) => { const o = selTitles()[0]; return !!o && sameColor(o.background || '#000000', c); },
    },

    musicVolume: { kind: 'edit', run: (v) => musicVolume(v), enabled: hasMusicSel },
    musicFadeIn: {
      kind: 'edit', run: (v) => setFade('fadeIn', v, selMusic, 'music', 'Change music fade in', MSG.selectMusic), enabled: hasMusicSel,
      checked: (v) => { const o = firstMusic(); return !!o && (o.fadeIn || 'none') === v; },
    },
    musicFadeOut: {
      kind: 'edit', run: (v) => setFade('fadeOut', v, selMusic, 'music', 'Change music fade out', MSG.selectMusic), enabled: hasMusicSel,
      checked: (v) => { const o = firstMusic(); return !!o && (o.fadeOut || 'none') === v; },
    },
    musicStartTime: { kind: 'edit', run: (v) => musicStartTime(v), enabled: hasMusicSel },
    musicSetStartPoint: { kind: 'edit', run: () => musicPoint('start'), enabled: hasMusicSel },
    musicSetEndPoint: { kind: 'edit', run: () => musicPoint('end'), enabled: hasMusicSel },
    musicSplit: { kind: 'edit', run: () => musicPoint('split'), enabled: hasMusicSel },

    textSet: {
      kind: 'edit', run: (a) => textSet(a), enabled: hasTextTarget,
      checked: (a) => {
        const o = firstText();
        if (!o || !isObj(a) || !('key' in a) || !STYLE_KEYS[a.key] || !isObj(o.style)) return false;
        const v = STYLE_KEYS[a.key].check(a.value);
        return v !== undefined && (typeof v === 'string' && typeof o.style[a.key] === 'string' ? sameColor(o.style[a.key], v) : o.style[a.key] === v);
      },
    },
    textEdit: { kind: 'edit', run: (t) => textEdit(t), enabled: hasTextTarget },
    textDuration: { kind: 'edit', run: (v) => textDuration(v), enabled: hasTextTarget },
    textStartTime: { kind: 'edit', run: (v) => textStartTime(v), enabled: () => selTexts().length > 0 },
    textEffect: {
      kind: 'edit', run: (id) => textEffect(id), enabled: hasTextTarget,
      checked: (id) => {
        const { type, objs } = textTargets();
        const o = objs[0];
        if (!o) return false;
        return ((type === 'text' ? o.effect : o.textEffect) || 'none') === id;
      },
    },

    undo: { kind: 'edit', run: () => (store.canUndo ? store.undo() : false), enabled: () => !!store.canUndo },
    redo: { kind: 'edit', run: () => (store.canRedo ? store.redo() : false), enabled: () => !!store.canRedo },

    play: { kind: 'nav', run: () => playerCall((p) => p.play()), enabled: hasDuration },
    pause: { kind: 'nav', run: () => playerCall((p) => p.pause()), enabled: () => { const p = player(); return !!(p && p.playing); } },
    togglePlay: {
      kind: 'nav', run: () => playerCall((p) => (typeof p.toggle === 'function' ? p.toggle() : (p.playing ? p.pause() : p.play()))),
      enabled: () => { const p = player(); return !!(p && p.playing) || hasDuration(); },
      checked: () => { const p = player(); return !!(p && p.playing); },
    },
    seek: {
      kind: 'nav', enabled: hasDuration,
      run: (t) => { const n = toNum(t); if (!Number.isFinite(n)) return false; return seek(clamp(n, 0, timelineDuration())); },
    },
    prevFrame: { kind: 'nav', run: () => playerCall((p) => p.stepFrame(-1)), enabled: hasDuration },
    nextFrame: { kind: 'nav', run: () => playerCall((p) => p.stepFrame(1)), enabled: hasDuration },
    goStart: { kind: 'nav', run: () => seek(0), enabled: hasDuration },
    goEnd: { kind: 'nav', run: () => seek(timelineDuration()), enabled: hasDuration },
    prevItem: { kind: 'nav', run: () => itemStep(-1), enabled: hasItems },
    nextItem: { kind: 'nav', run: () => itemStep(1), enabled: hasItems },

    newProject: { kind: 'project', run: () => newProject() },
    openProject: { kind: 'project', run: () => openProject() },
    saveProject: { kind: 'project', run: () => saveProject() },
    saveProjectAs: { kind: 'project', run: () => saveProjectAs() },
    importProjectFile: { kind: 'project', run: (f) => importProjectFile(f) },
    exportProjectFile: { kind: 'project', run: () => exportProjectFile() },
    saveMovie: { kind: 'project', run: (id) => saveMovie(id), enabled: hasItems },
    about: { kind: 'app', run: () => dialogCall('openAbout', 'About isn’t available right now.') },
    help: { kind: 'app', run: () => dialogCall('openHelp', 'Help isn’t available right now.') },
  };

  const names = Object.freeze(Object.keys(C));

  return {
    run(name, arg) {
      const c = Object.prototype.hasOwnProperty.call(C, name) ? C[name] : null;
      if (!c) {
        if (typeof console !== 'undefined') console.warn(`[commands] unknown command "${name}"`);
        return undefined;
      }
      const why = busyReason(c.kind);
      if (why) { toast(why, 'error'); return undefined; }
      let r;
      try {
        r = c.run(arg);
      } catch (err) {
        report(err);
        return undefined;
      }
      if (r && typeof r.then === 'function') {
        return r.then((v) => v, (err) => { report(err); return undefined; });
      }
      return r;
    },

    isEnabled(name) {
      const c = Object.prototype.hasOwnProperty.call(C, name) ? C[name] : null;
      if (!c) return false;
      if (busyReason(c.kind)) return false;
      if (!c.enabled) return true;
      try { return !!c.enabled(); } catch (err) {
        if (typeof console !== 'undefined') console.warn(`[commands] isEnabled(${name}) failed`, err);
        return false;
      }
    },

    isChecked(name, arg) {
      const c = Object.prototype.hasOwnProperty.call(C, name) ? C[name] : null;
      if (!c || !c.checked) return false;
      try { return !!c.checked(arg); } catch (_) { return false; }
    },

    list() { return names.slice(); },
  };
}

export default createCommands;
