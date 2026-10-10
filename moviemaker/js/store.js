// Movie Maker (web) — Store: project state, selection, view state, undo/redo, events.
// Works in browsers and in node (EventTarget / CustomEvent / structuredClone exist in node 17+).

import { createProject, computeTimeline, normalizeProject } from './model.js';

export const UNDO_LIMIT = 100;
export const COALESCE_MS = 800;

const DEFAULT_VIEW = Object.freeze({
  zoom: 40,
  thumbSize: 'medium',
  showWaveforms: true,
  previewSize: 'normal',
});
const THUMB_SIZES = ['small', 'medium', 'large'];
const PREVIEW_SIZES = ['normal', 'large'];
const SEL_TYPES = ['item', 'text', 'music'];

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function clone(v) {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

function makeEvent(type, detail) {
  if (typeof CustomEvent === 'function') return new CustomEvent(type, { detail });
  const e = new Event(type);
  e.detail = detail;
  return e;
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.project = createProject();
    this.media = new Map();
    this.selection = { type: null, ids: [] };
    this.view = { ...DEFAULT_VIEW };
    this.clipboard = null;
    this._undo = [];
    this._redo = [];
    this._timeline = null;
    this._lastCoalesce = null; // { key, time }
    this._updating = false;
  }

  // ---------- events ----------
  _emit(type, detail) {
    try {
      this.dispatchEvent(makeEvent(type, detail));
    } catch (err) {
      // A listener throwing must never corrupt the store state.
      if (typeof console !== 'undefined') console.error(`Store "${type}" listener failed:`, err);
    }
  }

  // ---------- timeline ----------
  get timeline() {
    if (!this._timeline) this._timeline = computeTimeline(this.project, this.media);
    return this._timeline;
  }

  invalidate() { this._timeline = null; }

  // ---------- mutations ----------
  update(mutator, { label = '', coalesceKey } = {}) {
    if (typeof mutator !== 'function') throw new TypeError('Store.update needs a mutator function');
    if (this._updating) {
      // Nested update inside a mutator: just apply it as part of the outer step.
      mutator(this.project);
      return;
    }
    const t = now();
    const coalesce = !!coalesceKey && !!this._lastCoalesce && this._lastCoalesce.key === coalesceKey
      && (t - this._lastCoalesce.time) <= COALESCE_MS && this._undo.length > 0;
    const before = clone(this.project);
    this._updating = true;
    let result;
    try {
      result = mutator(this.project);
    } catch (err) {
      // Roll back a half-applied mutation so the project never ends up inconsistent.
      this.project = before;
      this._timeline = null;
      this._updating = false;
      throw err;
    }
    this._updating = false;
    if (!coalesce) {
      this._undo.push({ project: before, label, selection: clone(this.selection) });
      if (this._undo.length > UNDO_LIMIT) this._undo.splice(0, this._undo.length - UNDO_LIMIT);
    }
    this._redo.length = 0;
    this._lastCoalesce = coalesceKey ? { key: coalesceKey, time: t } : null;
    this.project.updatedAt = Date.now();
    this._timeline = null;
    const pruned = this._pruneSelection();
    this._emit('change', { label });
    if (pruned) this._emit('selection', { ...this.selection, ids: this.selection.ids.slice() });
    return result;
  }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  get undoLabel() { return this._undo.length ? this._undo[this._undo.length - 1].label : ''; }
  get redoLabel() { return this._redo.length ? this._redo[this._redo.length - 1].label : ''; }

  undo() {
    if (!this._undo.length) return false;
    const entry = this._undo.pop();
    this._redo.push({ project: clone(this.project), label: entry.label, selection: clone(this.selection) });
    this.project = entry.project;
    this._afterHistory('undo', entry.selection);
    return true;
  }

  redo() {
    if (!this._redo.length) return false;
    const entry = this._redo.pop();
    this._undo.push({ project: clone(this.project), label: entry.label, selection: clone(this.selection) });
    this.project = entry.project;
    this._afterHistory('redo', entry.selection);
    return true;
  }

  _afterHistory(label, selection) {
    this._lastCoalesce = null;
    this._timeline = null;
    // Undo/redo is a modification too: the restored snapshot keeps its content but not its old
    // time, so "Modified" and the project list order never go back in time.
    this.project.updatedAt = Date.now();
    let selChanged = false;
    if (selection && (selection.type !== this.selection.type
      || selection.ids.join('|') !== this.selection.ids.join('|'))) {
      this.selection = { type: selection.type, ids: selection.ids.slice() };
      selChanged = true;
    }
    if (this._pruneSelection()) selChanged = true;
    this._emit('change', { label });
    if (selChanged) this._emit('selection', { ...this.selection, ids: this.selection.ids.slice() });
  }

  /** Load a project (and optionally its media). Clears undo/redo. */
  replaceProject(project, mediaMap) {
    let p;
    if (!project || typeof project !== 'object') p = createProject();
    else {
      let normalized;
      try { normalized = normalizeProject(project); } catch (_) { normalized = createProject(); }
      // Fill any missing fields, but keep the caller's top-level object identity when possible.
      try { p = Object.assign(project, normalized); } catch (_) { p = normalized; }
    }
    this.project = p;
    if (mediaMap) {
      const next = mediaMap instanceof Map ? mediaMap : new Map(Object.entries(mediaMap));
      for (const [id, m] of this.media) {
        if (!next.has(id) || next.get(id) !== m) revokeUrl(m);
      }
      this.media = new Map(next);
    }
    this._undo.length = 0;
    this._redo.length = 0;
    this._lastCoalesce = null;
    this._timeline = null;
    const hadSel = this.selection.type !== null || this.selection.ids.length > 0;
    this.selection = { type: null, ids: [] };
    if (mediaMap) this._emit('media', { added: [...this.media.keys()], reason: 'load' });
    this._emit('change', { label: 'load' });
    if (hadSel) this._emit('selection', { type: null, ids: [] });
  }

  // ---------- media ----------
  addMedia(media) {
    if (!media || !media.id) throw new TypeError('addMedia needs a media record with an id');
    const prev = this.media.get(media.id);
    if (prev && prev !== media) revokeUrl(prev);
    this.media.set(media.id, media);
    this._timeline = null;
    this._emit('media', { added: [media.id] });
    return media;
  }

  removeMedia(id) {
    const m = this.media.get(id);
    if (!m) return false;
    this.media.delete(id);
    revokeUrl(m);
    this._timeline = null;
    this._emit('media', { removed: [id] });
    return true;
  }

  getMedia(id) { return id ? this.media.get(id) : undefined; }

  /**
   * Ids of the media that can still appear in this project: used by the project, by any undo/redo
   * step, or by the clipboard. Everything else in `media` is unreachable (persist.js uses this to
   * drop removed media from storage).
   */
  mediaInUse() {
    const ids = new Set();
    const addProject = (p) => {
      if (!p) return;
      for (const it of p.items || []) if (it && it.mediaId) ids.add(it.mediaId);
      for (const m of p.music || []) if (m && m.mediaId) ids.add(m.mediaId);
    };
    addProject(this.project);
    for (const e of this._undo) addProject(e && e.project);
    for (const e of this._redo) addProject(e && e.project);
    const c = this.clipboard;
    if (c && typeof c === 'object') {
      for (const o of Array.isArray(c.objs) ? c.objs : []) if (o && typeof o.mediaId === 'string' && o.mediaId) ids.add(o.mediaId);
      for (const m of Array.isArray(c.media) ? c.media : []) if (m && typeof m.id === 'string' && m.id) ids.add(m.id);
    }
    return ids;
  }

  /** Notify listeners that a media record was mutated in place (e.g. peaks computed). */
  touchMedia(id) {
    if (!this.media.has(id)) return;
    this._timeline = null;
    this._emit('media', { updated: [id] });
  }

  // ---------- selection ----------
  select(type, ids) {
    let t = SEL_TYPES.includes(type) ? type : null;
    let list = ids == null ? [] : (Array.isArray(ids) ? ids : [ids]);
    list = [...new Set(list.filter((x) => typeof x === 'string' && x))];
    if (t) {
      const coll = this._collection(t);
      list = list.filter((id) => coll.some((o) => o.id === id));
    }
    if (!t || !list.length) { t = null; list = []; }
    if (t === this.selection.type && list.join('|') === this.selection.ids.join('|')) return;
    this.selection = { type: t, ids: list };
    // A slider drag on another object is a new undo step: never merge edits across selections.
    this._lastCoalesce = null;
    this._emit('selection', { type: t, ids: list.slice() });
  }

  clearSelection() { this.select(null, []); }

  isSelected(id) { return this.selection.ids.includes(id); }

  selectedItems() {
    const { type, ids } = this.selection;
    if (!type || !ids.length) return [];
    const coll = this._collection(type);
    const out = [];
    // Preserve storyboard/collection order.
    for (const o of coll) if (ids.includes(o.id)) out.push(o);
    return out;
  }

  find(id) {
    if (!id) return null;
    const p = this.project;
    let i = p.items.findIndex((o) => o.id === id);
    if (i >= 0) return { type: 'item', obj: p.items[i], index: i };
    i = p.texts.findIndex((o) => o.id === id);
    if (i >= 0) return { type: 'text', obj: p.texts[i], index: i };
    i = p.music.findIndex((o) => o.id === id);
    if (i >= 0) return { type: 'music', obj: p.music[i], index: i };
    return null;
  }

  _collection(type) {
    if (type === 'item') return this.project.items;
    if (type === 'text') return this.project.texts;
    if (type === 'music') return this.project.music;
    return [];
  }

  /** Drop ids that no longer exist. Returns true if the selection changed. */
  _pruneSelection() {
    const { type, ids } = this.selection;
    if (!type) return false;
    const coll = this._collection(type);
    const kept = ids.filter((id) => coll.some((o) => o.id === id));
    if (kept.length === ids.length) return false;
    this.selection = kept.length ? { type, ids: kept } : { type: null, ids: [] };
    return true;
  }

  // ---------- view ----------
  setView(partial) {
    if (!partial || typeof partial !== 'object') return;
    const next = { ...this.view };
    if ('zoom' in partial && Number.isFinite(+partial.zoom)) next.zoom = Math.min(400, Math.max(5, +partial.zoom));
    if ('thumbSize' in partial && THUMB_SIZES.includes(partial.thumbSize)) next.thumbSize = partial.thumbSize;
    if ('showWaveforms' in partial) next.showWaveforms = !!partial.showWaveforms;
    if ('previewSize' in partial && PREVIEW_SIZES.includes(partial.previewSize)) next.previewSize = partial.previewSize;
    // Allow other modules to keep extra view keys (forward compatible).
    for (const k of Object.keys(partial)) {
      if (!(k in DEFAULT_VIEW)) next[k] = partial[k];
    }
    const changed = Object.keys(next).filter((k) => next[k] !== this.view[k]);
    if (!changed.length) return;
    this.view = next;
    this._emit('view', { changed, view: { ...next } });
  }
}

function revokeUrl(m) {
  try {
    if (m && m.url && typeof m.url === 'string' && m.url.startsWith('blob:') && typeof URL !== 'undefined'
      && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(m.url);
    }
  } catch (_) { /* ignore */ }
}
