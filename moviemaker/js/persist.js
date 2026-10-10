// Movie Maker (web) — persistence: IndexedDB projects + media blobs, autosave,
// single-file project export/import (.wlmmweb). Every failure surfaces as an Error
// with a friendly message; nothing here should crash the app.

import { normalizeProject, uid } from './model.js';

export const DB_NAME = 'wlmm-web';
export const DB_VERSION = 1;
export const PROJECT_FILE_EXT = '.wlmmweb';
export const PROJECT_FILE_FORMAT = 'wlmmweb';
const LAST_KEY = 'wlmm-web:lastProjectId';
const OPEN_TIMEOUT = 10000;
const CHUNK = 3 * 512 * 1024;           // export: bytes per base64 chunk (multiple of 3)
const READ_CHUNK = 2 * 1024 * 1024;     // import: bytes read per step

/** Error whose message is safe to show to the user. */
export class PersistError extends Error {
  constructor(message, { code = 'error', cause } = {}) {
    super(message);
    this.name = 'PersistError';
    this.code = code;
    this.friendly = true;
    if (cause !== undefined) this.cause = cause;
  }
}

function friendly(err, action = 'save the project') {
  if (err && err.friendly) return err;
  const name = (err && err.name) || '';
  const msg = String((err && err.message) || err || '');
  if (name === 'QuotaExceededError' || /quota|storage.*(full|exceed)|disk/i.test(msg)) {
    return new PersistError(
      `There isn't enough storage space on this device to ${action}. Delete old projects or free up space, `
      + 'or use “Export project file” to keep a copy.', { code: 'quota', cause: err },
    );
  }
  if (name === 'InvalidStateError' || name === 'SecurityError' || /private|not allowed|denied|unavailable/i.test(msg)) {
    return new PersistError(
      `This browser doesn't allow Movie Maker to ${action} here (private browsing can block storage). `
      + 'Use “Export project file” to keep your work.', { code: 'unavailable', cause: err },
    );
  }
  if (name === 'VersionError') {
    return new PersistError(`A newer version of Movie Maker is open in another tab. Close it and try to ${action} again.`,
      { code: 'version', cause: err });
  }
  return new PersistError(`Movie Maker couldn't ${action}${msg ? ` (${msg})` : ''}.`, { code: 'error', cause: err });
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
let dbPromise = null;

function getIDB() {
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB;
  } catch (_) { /* some private modes throw on access */ }
  return null;
}

function openDB() {
  if (dbPromise) return dbPromise;
  const idb = getIDB();
  if (!idb) {
    return Promise.reject(new PersistError(
      "This browser doesn't support saving projects (IndexedDB is unavailable, possibly due to private browsing). "
      + 'Use “Export project file” to keep your work.', { code: 'unavailable' },
    ));
  }
  dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    let nudge = 0;
    let timer = 0;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearInterval(nudge);
      clearTimeout(timer);
      fn(v);
    };
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      done(reject, friendly(err, 'open its project storage'));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        const ps = db.createObjectStore('projects', { keyPath: 'id' });
        ps.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('media')) {
        const ms = db.createObjectStore('media', { keyPath: 'id' });
        ms.createIndex('projectIds', 'projectIds', { multiEntry: true });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { try { db.close(); } catch (_) { /* ignore */ } return; }
      db.onversionchange = () => { try { db.close(); } catch (_) { /* ignore */ } dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      done(resolve, db);
    };
    req.onerror = () => {
      const err = req.error;
      done(reject, friendly(err, 'open its project storage'));
    };
    req.onblocked = () => {
      // Another tab holds an old version; we'll succeed when it closes, or time out.
    };
    // Safari 14 sometimes never answers the first open() until IndexedDB is poked.
    if (typeof idb.databases === 'function') {
      nudge = setInterval(() => { try { idb.databases().catch(() => {}); } catch (_) { /* ignore */ } }, 250);
    }
    timer = setTimeout(() => done(reject, new PersistError(
      "Movie Maker's project storage isn't responding. Close other Movie Maker tabs and reload the page.",
      { code: 'timeout' },
    )), OPEN_TIMEOUT);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

// Safari has had bugs storing Blob/File objects in IndexedDB; fall back to raw bytes.
let storeBlobsAsBytes = false;

function readArrayBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('Could not read the file'));
    fr.readAsArrayBuffer(blob);
  });
}

function recordBlob(rec) {
  if (!rec) return null;
  if (rec.blob && typeof rec.blob.size === 'number') return rec.blob;
  if (rec.bytes) return new Blob([rec.bytes], { type: rec.mime || '' });
  return null;
}

function mediaMeta(m) {
  return {
    type: m.type,
    name: m.name || '',
    mime: m.mime || (m.blob && m.blob.type) || '',
    duration: Number.isFinite(m.duration) ? m.duration : 0,
    width: m.width || 0,
    height: m.height || 0,
    hasAudio: !!m.hasAudio,
    thumb: m.thumb || '',
    filmstrip: Array.isArray(m.filmstrip) ? m.filmstrip : [],
    peaks: Array.isArray(m.peaks) ? m.peaks : null,
  };
}

function metaSignature(meta, projectIds) {
  return [meta.name, meta.duration, meta.width, meta.height, meta.hasAudio ? 1 : 0, meta.thumb.length,
    meta.filmstrip.length, meta.peaks ? meta.peaks.length : -1, projectIds.slice().sort().join(',')].join('|');
}

function referencedMediaIds(project) {
  const ids = new Set();
  for (const it of project.items || []) if (it && it.mediaId) ids.add(it.mediaId);
  for (const m of project.music || []) if (m && m.mediaId) ids.add(m.mediaId);
  return ids;
}

function toMap(mediaMap) {
  if (!mediaMap) return new Map();
  if (mediaMap instanceof Map) return mediaMap;
  return new Map(Object.entries(mediaMap));
}

function projectThumb(project, mediaMap) {
  for (const it of project.items || []) {
    if (it.kind === 'title') continue;
    const m = mediaMap.get(it.mediaId);
    if (m && m.thumb) return m.thumb;
  }
  return '';
}

function plainProject(project) {
  // Strip anything non-cloneable (functions, DOM refs) defensively.
  try { return structuredClone(project); } catch (_) { return JSON.parse(JSON.stringify(project)); }
}

// per-session cache: mediaId -> metadata signature last written
const writtenMedia = new Map();

/**
 * Save the project and any media it uses. Media blobs are written once; later saves
 * only touch metadata that changed (e.g. waveform peaks computed later).
 */
export async function saveProject(project, mediaMap) {
  if (!project || !project.id) throw new PersistError('There is no project to save.', { code: 'invalid' });
  const media = toMap(mediaMap);
  const keep = new Set(referencedMediaIds(project));
  for (const id of media.keys()) keep.add(id); // media still in the session (undo may bring it back)
  const db = await openDB();
  const projectRecord = {
    id: project.id,
    name: project.name || 'My Movie',
    updatedAt: project.updatedAt || Date.now(),
    thumb: projectThumb(project, media),
    project: plainProject(project),
  };
  // Prepare byte fallbacks before the transaction (no awaits allowed inside it).
  const bytes = new Map();
  if (storeBlobsAsBytes) {
    for (const id of keep) {
      const m = media.get(id);
      if (m && m.blob && !writtenMedia.has(id)) {
        try { bytes.set(id, await readArrayBuffer(m.blob)); } catch (err) { throw friendly(err, 'read a media file'); }
      }
    }
  }
  const attempt = () => new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(['projects', 'media'], 'readwrite');
    } catch (err) { reject(err); return; }
    const done = txDone(tx);
    const ps = tx.objectStore('projects');
    const ms = tx.objectStore('media');
    const pending = new Map(); // id -> signature, committed to writtenMedia on success
    try {
      ps.put(projectRecord);
      for (const id of keep) {
        const m = media.get(id);
        if (!m || !m.blob) continue;
        const meta = mediaMeta(m);
        const get = ms.get(id);
        get.onsuccess = () => {
          const existing = get.result;
          const projectIds = existing && Array.isArray(existing.projectIds) ? existing.projectIds.slice() : [];
          if (!projectIds.includes(project.id)) projectIds.push(project.id);
          if (existing) {
            // Never lose data computed earlier (e.g. peaks) when the runtime record lacks it.
            if (!meta.peaks && Array.isArray(existing.peaks)) meta.peaks = existing.peaks;
            if (!meta.thumb && existing.thumb) meta.thumb = existing.thumb;
            if (!meta.filmstrip.length && Array.isArray(existing.filmstrip)) meta.filmstrip = existing.filmstrip;
          }
          const sig = metaSignature(meta, projectIds);
          if (existing) {
            const oldSig = metaSignature(mediaMeta(existing), Array.isArray(existing.projectIds) ? existing.projectIds : []);
            if (oldSig === sig) { pending.set(id, sig); return; }
            // Keep the stored blob; refresh metadata only.
            ms.put({ ...existing, ...meta, projectIds });
          } else {
            const rec = { id, projectIds, ...meta, blob: null };
            if (bytes.has(id)) rec.bytes = bytes.get(id);
            else rec.blob = m.blob;
            ms.put(rec);
          }
          pending.set(id, sig);
        };
      }
      // Detach media this project no longer uses; delete orphans.
      const cur = ms.index('projectIds').openCursor(IDBKeyRange.only(project.id));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const rec = c.value;
        if (!keep.has(rec.id)) {
          const others = (rec.projectIds || []).filter((p) => p !== project.id);
          if (others.length) c.update({ ...rec, projectIds: others });
          else c.delete();
          writtenMedia.delete(rec.id);
        }
        c.continue();
      };
    } catch (err) {
      try { tx.abort(); } catch (_) { /* ignore */ }
      reject(err);
      return;
    }
    done.then(() => {
      for (const [id, sig] of pending) writtenMedia.set(id, sig);
      resolve();
    }, reject);
  });
  try {
    await attempt();
  } catch (err) {
    const name = (err && err.name) || '';
    const blobProblem = !storeBlobsAsBytes && (name === 'DataCloneError' || name === 'UnknownError'
      || /blob|file|clone/i.test(String(err && err.message)));
    if (blobProblem) {
      storeBlobsAsBytes = true;
      return saveProject(project, mediaMap);
    }
    throw friendly(err, 'save the project');
  }
}

function runtimeMedia(rec) {
  const blob = recordBlob(rec);
  if (!blob) return null;
  let url = '';
  try { url = URL.createObjectURL(blob); } catch (_) { url = ''; }
  return {
    id: rec.id,
    type: rec.type,
    name: rec.name || '',
    mime: rec.mime || blob.type || '',
    blob,
    url,
    duration: Number.isFinite(rec.duration) ? rec.duration : 0,
    width: rec.width || 0,
    height: rec.height || 0,
    hasAudio: !!rec.hasAudio,
    thumb: rec.thumb || '',
    filmstrip: Array.isArray(rec.filmstrip) ? rec.filmstrip : [],
    peaks: Array.isArray(rec.peaks) ? rec.peaks : null,
  };
}

/** Load a project and its media (with fresh object URLs). */
export async function loadProject(id) {
  let db;
  try { db = await openDB(); } catch (err) { throw friendly(err, 'open the project'); }
  try {
    const tx = db.transaction(['projects', 'media'], 'readonly');
    const done = txDone(tx);
    const rec = await reqP(tx.objectStore('projects').get(id));
    if (!rec || !rec.project) {
      throw new PersistError("That project couldn't be found. It may have been deleted.", { code: 'not-found' });
    }
    const project = normalizeProject(rec.project);
    const ids = referencedMediaIds(project);
    const ms = tx.objectStore('media');
    const records = await Promise.all([...ids].map((mid) => reqP(ms.get(mid)).catch(() => null)));
    // Also bring back media attached to this project but not currently referenced (undo history of the session).
    const extra = await reqP(ms.index('projectIds').getAll(IDBKeyRange.only(id))).catch(() => []);
    await done.catch(() => {});
    const media = new Map();
    for (const r of [...records, ...(extra || [])]) {
      if (!r || media.has(r.id)) continue;
      const m = runtimeMedia(r);
      if (m) {
        media.set(m.id, m);
        writtenMedia.set(m.id, metaSignature(mediaMeta(r), Array.isArray(r.projectIds) ? r.projectIds : []));
      }
    }
    return { project, media };
  } catch (err) {
    throw friendly(err, 'open the project');
  }
}

/** [{id, name, updatedAt, thumb}] newest first. */
export async function listProjects() {
  let db;
  try { db = await openDB(); } catch (err) { throw friendly(err, 'list your projects'); }
  try {
    const tx = db.transaction('projects', 'readonly');
    const out = [];
    await new Promise((resolve, reject) => {
      const req = tx.objectStore('projects').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(); return; }
        const v = c.value || {};
        const p = v.project || {};
        out.push({
          id: v.id,
          name: v.name || p.name || 'My Movie',
          updatedAt: v.updatedAt || p.updatedAt || 0,
          thumb: v.thumb || '',
          itemCount: Array.isArray(p.items) ? p.items.length : 0,
        });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } catch (err) {
    throw friendly(err, 'list your projects');
  }
}

/** Delete a project and any media no other project uses. */
export async function deleteProject(id) {
  let db;
  try { db = await openDB(); } catch (err) { throw friendly(err, 'delete the project'); }
  try {
    const tx = db.transaction(['projects', 'media'], 'readwrite');
    const done = txDone(tx);
    tx.objectStore('projects').delete(id);
    const cur = tx.objectStore('media').index('projectIds').openCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      const rec = c.value;
      const others = (rec.projectIds || []).filter((p) => p !== id);
      if (others.length) c.update({ ...rec, projectIds: others });
      else c.delete();
      writtenMedia.delete(rec.id);
      c.continue();
    };
    await done;
    try {
      if ((await getLastProjectId()) === id) await setLastProjectId(null);
    } catch (_) { /* ignore */ }
  } catch (err) {
    throw friendly(err, 'delete the project');
  }
}

export async function getLastProjectId() {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(LAST_KEY)) || null;
  } catch (_) { return null; }
}

export async function setLastProjectId(id) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (id) localStorage.setItem(LAST_KEY, String(id));
    else localStorage.removeItem(LAST_KEY);
  } catch (_) { /* storage blocked: ignore */ }
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistentStorage() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
      if (typeof navigator.storage.persisted === 'function' && await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (_) { /* ignore */ }
  return false;
}

/** { usage, quota } in bytes, or null when unknown. */
export async function storageEstimate() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    }
  } catch (_) { /* ignore */ }
  return null;
}

function isEmptyProject(p) {
  return !p || ((!p.items || !p.items.length) && (!p.texts || !p.texts.length) && (!p.music || !p.music.length));
}

function emit(store, type, detail) {
  try {
    const ev = typeof CustomEvent === 'function' ? new CustomEvent(type, { detail }) : Object.assign(new Event(type), { detail });
    store.dispatchEvent(ev);
  } catch (_) { /* ignore */ }
}

/**
 * Debounced autosave on store 'change' / 'media'. Also saves immediately when the
 * page is hidden (phones kill background tabs). Emits 'persist' on the store:
 * {detail:{ok:true, projectId, savedAt}} or {detail:{ok:false, error}} (errors are
 * de-duplicated until a save succeeds). Returns a controller.
 */
export function enableAutosave(store, delayMs = 1500) {
  let timer = 0;
  let saving = null;
  let dirty = false;
  let disabled = false;
  let lastErrorMsg = '';
  let lastSavedAt = 0;
  // Project ids that have had content this session (or were loaded with content): once a project
  // is worth saving, emptying it must be saved too. Blank new projects never litter the DB.
  const worthSaving = new Set();

  const run = async () => {
    clearTimeout(timer);
    timer = 0;
    if (disabled) return;
    if (saving) { dirty = true; return saving; }
    const project = store.project;
    if (!isEmptyProject(project)) worthSaving.add(project.id);
    if (!worthSaving.has(project.id)) return;
    dirty = false;
    saving = (async () => {
      try {
        await saveProject(project, store.media);
        await setLastProjectId(project.id);
        lastSavedAt = Date.now();
        lastErrorMsg = '';
        emit(store, 'persist', { ok: true, projectId: project.id, savedAt: lastSavedAt });
      } catch (err) {
        const e = friendly(err, 'save the project');
        if (e.message !== lastErrorMsg) {
          lastErrorMsg = e.message;
          emit(store, 'persist', { ok: false, error: e });
          if (typeof console !== 'undefined') console.warn('[autosave]', e.message, err);
        }
      } finally {
        saving = null;
      }
      if (dirty && !disabled) schedule(Math.min(delayMs, 400));
    })();
    return saving;
  };
  const schedule = (ms = delayMs) => {
    if (disabled) return;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  const onChange = (e) => {
    const label = e && e.detail && e.detail.label;
    if (!isEmptyProject(store.project)) worthSaving.add(store.project.id);
    if (label === 'load') {
      // A freshly loaded/imported project: remember it as last opened (if it has content)
      // and make sure it is stored (cheap when it already is).
      if (!worthSaving.has(store.project.id)) return;
      setLastProjectId(store.project.id);
    }
    schedule();
  };
  const onMedia = () => schedule();
  const flushNow = () => {
    if (timer || dirty) run();
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };

  store.addEventListener('change', onChange);
  store.addEventListener('media', onMedia);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flushNow);
  requestPersistentStorage();

  return {
    flush: () => run(),
    disable() {
      disabled = true;
      clearTimeout(timer);
      store.removeEventListener('change', onChange);
      store.removeEventListener('media', onMedia);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', flushNow);
    },
    get saving() { return !!saving; },
    get pending() { return !!timer || dirty; },
    get lastSavedAt() { return lastSavedAt; },
    get lastError() { return lastErrorMsg; },
  };
}

// ---------------------------------------------------------------------------
// Single-file project export / import (.wlmmweb = JSON with base64 media)
// ---------------------------------------------------------------------------
function bytesToBase64(u8) {
  const STEP = 0x8000;
  const pieces = [];
  for (let i = 0; i < u8.length; i += STEP) {
    pieces.push(String.fromCharCode.apply(null, u8.subarray(i, i + STEP)));
  }
  return btoa(pieces.join(''));
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Suggested download name, e.g. "My Movie.wlmmweb". */
export function projectFileName(project) {
  const base = String((project && project.name) || 'My Movie').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'My Movie';
  return base.slice(0, 120) + PROJECT_FILE_EXT;
}

/**
 * Build a single-file project. Media is base64-encoded chunk by chunk and folded into
 * intermediate Blobs so the whole file never has to sit in one JS string.
 * opts.onProgress(p 0..1).
 */
export async function exportProjectFile(project, mediaMap, { onProgress } = {}) {
  if (!project) throw new PersistError('There is no project to export.', { code: 'invalid' });
  try {
    const media = toMap(mediaMap);
    const ids = [...referencedMediaIds(project)].filter((id) => {
      const m = media.get(id);
      return m && m.blob && typeof m.blob.size === 'number';
    });
    const total = ids.reduce((n, id) => n + media.get(id).blob.size, 0) || 1;
    let doneBytes = 0;
    const report = () => {
      if (typeof onProgress === 'function') {
        try { onProgress(Math.min(1, doneBytes / total)); } catch (_) { /* ignore */ }
      }
    };
    let acc = null;          // folded Blob
    let parts = [];
    let partsLen = 0;
    const push = (s) => {
      parts.push(s);
      partsLen += s.length;
      if (partsLen > 16 * 1024 * 1024) {
        acc = new Blob(acc ? [acc, ...parts] : parts, { type: 'application/json' });
        parts = [];
        partsLen = 0;
      }
    };
    const header = JSON.stringify({
      format: PROJECT_FILE_FORMAT,
      version: 1,
      app: 'Movie Maker (web)',
      exportedAt: Date.now(),
      project: plainProject(project),
    });
    push(`${header.slice(0, -1)},"media":[`);
    for (let i = 0; i < ids.length; i++) {
      const m = media.get(ids[i]);
      const meta = { id: m.id, ...mediaMeta(m), size: m.blob.size };
      push(`${i ? ',\n' : '\n'}${JSON.stringify(meta).slice(0, -1)},"data":"`);
      for (let off = 0; off < m.blob.size; off += CHUNK) {
        const buf = await readArrayBuffer(m.blob.slice(off, Math.min(m.blob.size, off + CHUNK)));
        push(bytesToBase64(new Uint8Array(buf)));
        doneBytes += buf.byteLength;
        report();
      }
      push('"}');
    }
    push('\n]}');
    doneBytes = total;
    report();
    return new Blob(acc ? [acc, ...parts] : parts, { type: 'application/json' });
  } catch (err) {
    throw friendly(err, 'export the project');
  }
}

/**
 * Streaming reader for .wlmmweb files: JSON structure is collected as text, but every
 * string value under a "data" key is decoded from base64 straight into Blob parts.
 */
async function parseProjectFile(file, onProgress) {
  const decoder = new TextDecoder('utf-8');
  const structure = [];
  const blobs = [];
  let mode = 'json';
  let inString = false;
  let escape = false;
  let capture = '';
  let captureOk = true;
  let lastString = null;
  let afterString = false;
  let awaitingData = false;
  let carry = '';
  let current = null;

  const flushB64 = (final) => {
    const usable = final ? carry.length : carry.length - (carry.length % 4);
    if (usable <= 0) return;
    const chunk = carry.slice(0, usable);
    carry = carry.slice(usable);
    current.push(base64ToBytes(chunk));
    if (current.length > 64) {
      // Fold parts to keep the array small and let the browser page data out.
      const b = new Blob(current);
      current.length = 0;
      current.push(b);
    }
  };

  const processText = (text) => {
    let i = 0;
    let segStart = 0;
    const n = text.length;
    while (i < n) {
      if (mode === 'b64') {
        const q = text.indexOf('"', i);
        const end = q === -1 ? n : q;
        let seg = text.slice(i, end);
        if (seg.indexOf('\\') !== -1) seg = seg.replace(/\\/g, '');
        carry += seg;
        if (carry.length >= 1024 * 1024) flushB64(false);
        if (q === -1) { i = n; segStart = n; break; }
        flushB64(true);
        blobs.push(current);
        structure.push(`@@wlmm-blob:${blobs.length - 1}"`);
        current = null;
        mode = 'json';
        i = q + 1;
        segStart = i;
        continue;
      }
      const ch = text.charCodeAt(i);
      if (inString) {
        if (escape) { escape = false; captureOk = false; }
        else if (ch === 92) escape = true;
        else if (ch === 34) { inString = false; lastString = captureOk ? capture : null; afterString = true; }
        else if (captureOk) { if (capture.length < 8) capture += text[i]; else captureOk = false; }
        i++;
        continue;
      }
      if (ch === 34) {
        if (awaitingData) {
          structure.push(text.slice(segStart, i + 1));
          awaitingData = false;
          mode = 'b64';
          current = [];
          carry = '';
          i++;
          segStart = i;
          continue;
        }
        inString = true;
        capture = '';
        captureOk = true;
        afterString = false;
        i++;
        continue;
      }
      if (ch === 32 || ch === 10 || ch === 13 || ch === 9) { i++; continue; }
      if (ch === 58) {
        awaitingData = afterString && lastString === 'data';
        afterString = false;
        i++;
        continue;
      }
      awaitingData = false;
      afterString = false;
      i++;
    }
    if (segStart < n) structure.push(text.slice(segStart));
  };

  const size = file.size;
  for (let off = 0; off < size; off += READ_CHUNK) {
    const buf = await readArrayBuffer(file.slice(off, Math.min(size, off + READ_CHUNK)));
    processText(decoder.decode(new Uint8Array(buf), { stream: off + READ_CHUNK < size }));
    if (typeof onProgress === 'function') {
      try { onProgress(Math.min(1, (off + buf.byteLength) / size) * 0.95); } catch (_) { /* ignore */ }
    }
  }
  const tail = decoder.decode();
  if (tail) processText(tail);
  if (mode === 'b64') throw new SyntaxError('Unexpected end of file');
  const manifest = JSON.parse(structure.join(''));
  return { manifest, blobs };
}

/** Read a .wlmmweb file → { project, media: Map } (media have fresh object URLs). */
export async function importProjectFile(file, { onProgress } = {}) {
  if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function') {
    throw new PersistError("That isn't a Movie Maker project file.", { code: 'invalid' });
  }
  let parsed;
  try {
    parsed = await parseProjectFile(file, onProgress);
  } catch (err) {
    if (err && (err.name === 'QuotaExceededError' || err.name === 'NotReadableError')) throw friendly(err, 'read the project file');
    throw new PersistError(`"${file.name || 'This file'}" isn't a Movie Maker project file (${PROJECT_FILE_EXT}), or it is damaged.`,
      { code: 'invalid', cause: err });
  }
  const { manifest, blobs } = parsed;
  const rawProject = manifest && (manifest.project || (manifest.items ? manifest : null));
  if (!manifest || typeof manifest !== 'object' || !rawProject
    || (manifest.format && manifest.format !== PROJECT_FILE_FORMAT)) {
    throw new PersistError(`"${file.name || 'This file'}" isn't a Movie Maker project file (${PROJECT_FILE_EXT}).`, { code: 'invalid' });
  }
  let project;
  try {
    project = normalizeProject(rawProject);
  } catch (err) {
    throw new PersistError('The project inside this file is damaged and could not be opened.', { code: 'invalid', cause: err });
  }
  // Never overwrite a project already stored on this device: import as a copy.
  try {
    const db = await openDB();
    const exists = await reqP(db.transaction('projects', 'readonly').objectStore('projects').getKey(project.id));
    if (exists !== undefined) project.id = uid('proj');
  } catch (_) { /* storage unavailable: keep the id */ }
  const media = new Map();
  for (const entry of Array.isArray(manifest.media) ? manifest.media : []) {
    if (!entry || typeof entry !== 'object' || !entry.id) continue;
    const ref = typeof entry.data === 'string' ? /^@@wlmm-blob:(\d+)$/.exec(entry.data) : null;
    if (!ref) continue;
    const parts = blobs[Number(ref[1])];
    if (!parts) continue;
    const blob = new Blob(parts, { type: entry.mime || '' });
    const m = runtimeMedia({ ...entry, blob });
    if (m) media.set(m.id, m);
  }
  if (typeof onProgress === 'function') {
    try { onProgress(1); } catch (_) { /* ignore */ }
  }
  return { project, media };
}
