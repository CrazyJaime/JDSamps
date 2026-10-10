// Movie Maker (web) — persistence: IndexedDB projects + media blobs, autosave,
// single-file project export/import (.wlmmweb). Every failure surfaces as an Error
// with a friendly message; nothing here should crash the app.

import { normalizeProject, uid } from './model.js';

export const DB_NAME = 'wlmm-web';
export const DB_VERSION = 1;
export const PROJECT_FILE_EXT = '.wlmmweb';
export const PROJECT_FILE_FORMAT = 'wlmmweb';
const LAST_KEY = 'wlmm-web:lastProjectId';
const EXPORTED_KEY = 'wlmm-web:exportedAt';            // { projectId: ms } of "Export project file"
const NOTICE_KEY = 'wlmm-web:storageNoticeShown';      // the Safari eviction notice was shown
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

// Safari has had bugs storing Blob/File objects in IndexedDB ("UnknownError: Error preparing
// Blob/File data to be stored"); fall back to raw bytes for the rest of the session.
let storeBlobsAsBytes = false;

/** Test hooks (tests/core-media.js): engines without that bug can't reach the raw-bytes path. */
export const __test = Object.freeze({
  setBlobsAsBytes(on) { storeBlobsAsBytes = !!on; },
  get blobsAsBytes() { return storeBlobsAsBytes; },
});

function isBlobProblem(err) {
  const name = (err && err.name) || '';
  return name === 'DataCloneError' || name === 'UnknownError' || /blob|file|clone/i.test(String(err && err.message));
}

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
  const meta = {
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
  // What the <video> element reported about an audio track (media.js); lets a later waveform
  // decode tell "no soundtrack" from "can't decode it here".
  if (typeof m.hasAudioHint === 'boolean') meta.hasAudioHint = m.hasAudioHint;
  return meta;
}

/** Everything about a media record's metadata that a save may need to write (no project ids). */
function metaKey(meta) {
  return [meta.name, meta.duration, meta.width, meta.height, meta.hasAudio ? 1 : 0, meta.thumb.length,
    meta.filmstrip.length, meta.peaks ? meta.peaks.length : -1].join('|');
}

function metaSignature(meta, projectIds) {
  return `${metaKey(meta)}|${projectIds.slice().sort().join(',')}`;
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

// Per-session cache of what is stored: mediaId -> { runtime: metaKey of the runtime record last
// written or checked, projectIds: the record's project ids }. Lets a save skip media that has not
// changed, which matters when media is stored as raw bytes: reading such a record pulls the whole
// file into memory.
const writtenMedia = new Map();

// Stores with autosave on (enableAutosave): their undo/redo history and clipboard decide which
// media a save of their project keeps (Store.mediaInUse). Value = number of live controllers.
const liveStores = new Map();

/** Media ids a save of `project` keeps attached: the ones it uses, plus the ones undo may bring back. */
function keepSet(project, media, opts) {
  const keep = referencedMediaIds(project);
  let extra = opts && opts.keep;
  if (!extra) {
    for (const s of liveStores.keys()) {
      if (s && s.project && s.project.id === project.id && typeof s.mediaInUse === 'function') {
        try { extra = s.mediaInUse(); } catch (_) { extra = null; }
        break;
      }
    }
  }
  if (extra && typeof extra[Symbol.iterator] === 'function') {
    for (const id of extra) if (media.has(id)) keep.add(id);
  }
  return keep;
}

/** Run one transaction; fn(tx) issues the requests and returns a box its callbacks fill in. */
function runTx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(stores, mode); } catch (err) { reject(err); return; }
    const done = txDone(tx);
    let box;
    try {
      box = fn(tx);
    } catch (err) {
      try { tx.abort(); } catch (_) { /* ignore */ }
      done.catch(() => {});
      reject(err);
      return;
    }
    done.then(() => resolve(box), reject);
  });
}

// Saves run one after another, each writing the state captured when it was requested, so a
// slower earlier save can never overwrite a newer one.
let saveChain = Promise.resolve();

/**
 * Save the project and any media it uses. Media blobs are written once; later saves
 * only touch metadata that changed (e.g. waveform peaks computed later). Media that the project
 * no longer uses is detached from it (and deleted when no other project uses it); media that
 * undo/redo or the clipboard may bring back stays while the project's store has autosave on.
 * opts.keep: extra media ids to keep attached (overrides the store lookup).
 * The project and media map are captured synchronously, when saveProject is called.
 */
export function saveProject(project, mediaMap, opts = {}) {
  if (!project || !project.id) return Promise.reject(new PersistError('There is no project to save.', { code: 'invalid' }));
  let snapshot;
  let media;
  let keep;
  try {
    snapshot = plainProject(project);
    media = new Map(toMap(mediaMap));
    keep = keepSet(snapshot, media, opts);
  } catch (err) {
    return Promise.reject(friendly(err, 'save the project'));
  }
  const job = saveChain.then(() => writeProject(snapshot, media, keep));
  saveChain = job.catch(() => {});
  return job;
}

async function writeProject(project, media, keep) {
  const db = await openDB();
  const record = {
    id: project.id,
    name: project.name || 'My Movie',
    updatedAt: project.updatedAt || Date.now(),
    thumb: projectThumb(project, media),
    project,
  };
  try {
    if (storeBlobsAsBytes) await writeBytesMode(db, record, media, keep);
    else await writeBlobMode(db, record, media, keep);
  } catch (err) {
    if (!storeBlobsAsBytes && isBlobProblem(err)) {
      storeBlobsAsBytes = true;
      try {
        await writeBytesMode(db, record, media, keep);
        return;
      } catch (err2) {
        throw friendly(err2, 'save the project');
      }
    }
    throw friendly(err, 'save the project');
  }
}

/** Normal path: project + every media record in ONE transaction (Blobs are stored by reference). */
function writeBlobMode(db, record, media, keep) {
  const pid = record.id;
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(['projects', 'media'], 'readwrite');
    } catch (err) { reject(err); return; }
    const done = txDone(tx);
    const ms = tx.objectStore('media');
    const pending = new Map(); // id -> cache entry, committed to writtenMedia on success
    const dropped = [];
    try {
      tx.objectStore('projects').put(record);
      for (const id of keep) {
        const m = media.get(id);
        if (!m || !m.blob) continue;
        const meta = mediaMeta(m);
        const runtime = metaKey(meta);
        const get = ms.get(id);
        get.onsuccess = () => {
          const existing = get.result;
          const projectIds = existing && Array.isArray(existing.projectIds) ? existing.projectIds.slice() : [];
          if (!projectIds.includes(pid)) projectIds.push(pid);
          if (existing) {
            // Never lose data computed earlier (e.g. peaks) when the runtime record lacks it.
            if (!meta.peaks && Array.isArray(existing.peaks)) meta.peaks = existing.peaks;
            if (!meta.thumb && existing.thumb) meta.thumb = existing.thumb;
            if (!meta.filmstrip.length && Array.isArray(existing.filmstrip)) meta.filmstrip = existing.filmstrip;
            const oldSig = metaSignature(mediaMeta(existing), Array.isArray(existing.projectIds) ? existing.projectIds : []);
            // Keep the stored blob; refresh metadata only.
            if (oldSig !== metaSignature(meta, projectIds)) ms.put({ ...existing, ...meta, projectIds });
          } else {
            ms.put({ id, projectIds, ...meta, blob: m.blob });
          }
          pending.set(id, { runtime, projectIds });
        };
      }
      // Detach media this project no longer uses; delete orphans.
      const cur = ms.index('projectIds').openCursor(IDBKeyRange.only(pid));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const rec = c.value;
        if (!keep.has(rec.id)) {
          const others = (rec.projectIds || []).filter((p) => p !== pid);
          if (others.length) c.update({ ...rec, projectIds: others });
          else c.delete();
          dropped.push(rec.id);
        }
        c.continue();
      };
    } catch (err) {
      try { tx.abort(); } catch (_) { /* ignore */ }
      done.catch(() => {});
      reject(err);
      return;
    }
    done.then(() => {
      for (const id of dropped) writtenMedia.delete(id);
      for (const [id, entry] of pending) writtenMedia.set(id, entry);
      resolve();
    }, reject);
  });
}

/**
 * Raw-bytes fallback: one media record per transaction, so at most one file is in memory at a
 * time (phones kill a tab that holds several videos at once). Media that is stored and unchanged
 * is skipped without reading it back.
 */
async function writeBytesMode(db, record, media, keep) {
  const pid = record.id;
  for (const id of keep) {
    const m = media.get(id);
    if (!m || !m.blob) continue;
    const meta = mediaMeta(m);
    const runtime = metaKey(meta);
    const cached = writtenMedia.get(id);
    if (cached && cached.runtime === runtime && cached.projectIds.includes(pid)) continue;
    await writeMediaBytes(db, id, m, meta, runtime, pid);
  }
  // The project goes in after its media, so it never points at a file that isn't stored.
  await runTx(db, ['projects'], 'readwrite', (tx) => { tx.objectStore('projects').put(record); });
  // Detach media this project no longer uses (keys only: no file is read to find them).
  const attached = await runTx(db, ['media'], 'readonly', (tx) => {
    const box = { ids: [] };
    const idx = tx.objectStore('media').index('projectIds');
    const range = IDBKeyRange.only(pid);
    if (typeof idx.getAllKeys === 'function') {
      const r = idx.getAllKeys(range);
      r.onsuccess = () => { box.ids = Array.isArray(r.result) ? r.result : []; };
    } else {
      const c = idx.openKeyCursor(range);
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return;
        box.ids.push(cur.primaryKey);
        cur.continue();
      };
    }
    return box;
  });
  for (const id of attached.ids) {
    if (keep.has(id)) continue;
    await runTx(db, ['media'], 'readwrite', (tx) => {
      const ms = tx.objectStore('media');
      const get = ms.get(id);
      get.onsuccess = () => {
        const rec = get.result;
        if (!rec) return;
        const others = (rec.projectIds || []).filter((p) => p !== pid);
        if (others.length) ms.put({ ...rec, projectIds: others });
        else ms.delete(id);
      };
    });
    writtenMedia.delete(id);
  }
}

async function writeMediaBytes(db, id, m, meta, runtime, pid) {
  // Stored already? Ask for the key only, never for the (possibly huge) value.
  const probe = await runTx(db, ['media'], 'readonly', (tx) => {
    const box = { found: false };
    const ms = tx.objectStore('media');
    const req = typeof ms.getKey === 'function' ? ms.getKey(id) : ms.count(id);
    req.onsuccess = () => {
      const r = req.result;
      box.found = typeof r === 'number' ? r > 0 : r !== undefined && r !== null;
    };
    return box;
  });
  if (probe.found) {
    const box = await runTx(db, ['media'], 'readwrite', (tx) => {
      const out = { entry: null, gone: false };
      const ms = tx.objectStore('media');
      const get = ms.get(id);
      get.onsuccess = () => {
        const existing = get.result;
        if (!existing) { out.gone = true; return; }
        const projectIds = Array.isArray(existing.projectIds) ? existing.projectIds.slice() : [];
        if (!projectIds.includes(pid)) projectIds.push(pid);
        const merged = { ...meta };
        if (!merged.peaks && Array.isArray(existing.peaks)) merged.peaks = existing.peaks;
        if (!merged.thumb && existing.thumb) merged.thumb = existing.thumb;
        if (!merged.filmstrip.length && Array.isArray(existing.filmstrip)) merged.filmstrip = existing.filmstrip;
        const oldSig = metaSignature(mediaMeta(existing), Array.isArray(existing.projectIds) ? existing.projectIds : []);
        if (oldSig !== metaSignature(merged, projectIds)) ms.put({ ...existing, ...merged, projectIds });
        out.entry = { runtime, projectIds };
      };
      return out;
    });
    if (box.entry) { writtenMedia.set(id, box.entry); return; }
    if (!box.gone) return;
  }
  let bytes;
  try { bytes = await readArrayBuffer(m.blob); } catch (err) { throw friendly(err, 'read a media file'); }
  await runTx(db, ['media'], 'readwrite', (tx) => {
    tx.objectStore('media').put({ id, projectIds: [pid], ...meta, blob: null, bytes });
  });
  bytes = null;
  writtenMedia.set(id, { runtime, projectIds: [pid] });
}

function runtimeMedia(rec) {
  const blob = recordBlob(rec);
  if (!blob) return null;
  let url = '';
  try { url = URL.createObjectURL(blob); } catch (_) { url = ''; }
  const m = {
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
  if (typeof rec.hasAudioHint === 'boolean') m.hasAudioHint = rec.hasAudioHint;
  return m;
}

/** get() that resolves null on failure without aborting the transaction. */
function getSoft(objectStore, key) {
  return new Promise((resolve) => {
    let req;
    try { req = objectStore.get(key); } catch (_) { resolve(null); return; }
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => {
      try { if (e && typeof e.preventDefault === 'function') e.preventDefault(); } catch (_) { /* ignore */ }
      resolve(null);
    };
  });
}

/**
 * Load a project and the media it uses (with fresh object URLs). Media that is attached to the
 * project but no longer used is left behind (the next save detaches it).
 */
export async function loadProject(id) {
  let db;
  try { db = await openDB(); } catch (err) { throw friendly(err, 'open the project'); }
  try {
    const tx = db.transaction(['projects', 'media'], 'readonly');
    const done = txDone(tx);
    done.catch(() => {});
    const rec = await reqP(tx.objectStore('projects').get(id));
    if (!rec || !rec.project) {
      throw new PersistError("That project couldn't be found. It may have been deleted.", { code: 'not-found' });
    }
    const project = normalizeProject(rec.project);
    const ms = tx.objectStore('media');
    const media = new Map();
    // One record at a time: a file stored as raw bytes becomes a Blob before the next one is read.
    for (const mid of referencedMediaIds(project)) {
      const r = await getSoft(ms, mid);
      if (!r) continue;
      const m = runtimeMedia(r);
      if (m) {
        media.set(m.id, m);
        writtenMedia.set(m.id, { runtime: metaKey(mediaMeta(m)), projectIds: Array.isArray(r.projectIds) ? r.projectIds.slice() : [] });
      }
    }
    await done.catch(() => {});
    return { project, media };
  } catch (err) {
    throw friendly(err, 'open the project');
  }
}

/** [{id, name, updatedAt, thumb, itemCount, exportedAt}] newest first (exportedAt 0 = never exported). */
export async function listProjects() {
  let db;
  try { db = await openDB(); } catch (err) { throw friendly(err, 'list your projects'); }
  try {
    const tx = db.transaction('projects', 'readonly');
    const out = [];
    const exported = readExportTimes();
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
          exportedAt: Number(exported[v.id]) || 0,
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
    forgetExportTime(id);
  } catch (err) {
    throw friendly(err, 'delete the project');
  }
}

function ls() {
  try { return typeof localStorage !== 'undefined' && localStorage ? localStorage : null; } catch (_) { return null; }
}

export async function getLastProjectId() {
  try {
    const s = ls();
    return (s && s.getItem(LAST_KEY)) || null;
  } catch (_) { return null; }
}

export async function setLastProjectId(id) {
  try {
    const s = ls();
    if (!s) return;
    if (id) s.setItem(LAST_KEY, String(id));
    else s.removeItem(LAST_KEY);
  } catch (_) { /* storage blocked: ignore */ }
}

// --- "Export project file" times (shown in the Projects dialog: the copy that survives the
// browser clearing its storage) -----------------------------------------------------------------
function readExportTimes() {
  try {
    const s = ls();
    const v = s ? JSON.parse(s.getItem(EXPORTED_KEY) || '{}') : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

function writeExportTimes(map) {
  try {
    const s = ls();
    if (s) s.setItem(EXPORTED_KEY, JSON.stringify(map));
  } catch (_) { /* storage blocked: ignore */ }
}

/** Remember that a project file was made for `id` (exportProjectFile does this itself). */
export function markProjectExported(id, when = Date.now()) {
  if (!id) return;
  const map = readExportTimes();
  map[id] = Number(when) || Date.now();
  writeExportTimes(map);
}

/** When a project file was last made for `id` (ms), or 0. */
export function lastExportedAt(id) {
  return Number(readExportTimes()[id]) || 0;
}

function forgetExportTime(id) {
  const map = readExportTimes();
  if (!(id in map)) return;
  delete map[id];
  writeExportTimes(map);
}

// --- persistent storage & eviction --------------------------------------------------------------
let persistAsked = false;

/** Engines that show the user a permission prompt for navigator.storage.persist() (Firefox). */
function persistPrompts() {
  try {
    const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
    return /\bFirefox\//.test(ua) && !/\bSeamonkey\//i.test(ua);
  } catch (_) { return false; }
}

/**
 * Ask the browser not to evict our data under storage pressure (best effort, at most once per
 * session). Firefox asks the user, so there it only happens with { userAction: true }: call it that
 * way from an explicit save (Save project, Save movie), never at start-up. Chrome and Safari decide
 * silently, so a plain call is fine there. Resolves true when storage is (now) persistent.
 */
export async function requestPersistentStorage({ userAction = false } = {}) {
  try {
    const s = typeof navigator !== 'undefined' ? navigator.storage : null;
    if (!s || typeof s.persist !== 'function') return false;
    if (typeof s.persisted === 'function' && await s.persisted()) return true;
    if (!userAction && persistPrompts()) return false;
    if (persistAsked) return false;
    persistAsked = true;
    return !!(await s.persist());
  } catch (_) { /* ignore */ }
  return false;
}

function isStandalone() {
  try {
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
  } catch (_) { /* ignore */ }
  try {
    if (typeof matchMedia === 'function') {
      return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => matchMedia(`(display-mode: ${m})`).matches);
    }
  } catch (_) { /* ignore */ }
  return false;
}

/**
 * Does this browser delete script-writable storage (IndexedDB, localStorage, the offline cache) on
 * its own? WebKit does after 7 days of browser use without a visit to the site (Safari on Mac,
 * every browser on iPhone / iPad) unless the app runs from the Home Screen / Dock or the storage
 * is persistent. Resolves { atRisk, ios, message }.
 */
export async function storageEvictionRisk() {
  const none = { atRisk: false, ios: false, message: '' };
  if (typeof navigator === 'undefined') return none;
  let ua = '';
  let vendor = '';
  let ios = false;
  try {
    ua = String(navigator.userAgent || '');
    vendor = String(navigator.vendor || '');
    ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  } catch (_) { return none; }
  const macSafari = !ios && vendor.indexOf('Apple') === 0 && /AppleWebKit\//.test(ua) && /Safari\//.test(ua)
    && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)\//.test(ua);
  if (!ios && !macSafari) return none;
  if (isStandalone()) return none;
  try {
    const s = navigator.storage;
    if (s && typeof s.persisted === 'function' && await s.persisted()) return none;
  } catch (_) { /* unknown: assume the default policy */ }
  const message = ios
    ? 'Safari may delete projects stored on this device if you don’t use Movie Maker for a while. '
      + 'Add Movie Maker to your Home Screen (Share › Add to Home Screen), or use Export project file to keep a copy.'
    : 'Safari may delete projects stored on this Mac if you don’t use Movie Maker for a while. '
      + 'Use Export project file in the Movie Maker menu to keep a copy, or add Movie Maker to the Dock (File › Add to Dock).';
  return { atRisk: true, ios, message };
}

let noticeChecked = false;

/** The eviction notice, once ever per browser (remembered in localStorage), else null. */
async function storageNoticeOnce() {
  if (noticeChecked) return null;
  noticeChecked = true;
  const s = ls();
  try { if (s && s.getItem(NOTICE_KEY)) return null; } catch (_) { /* show it */ }
  const risk = await storageEvictionRisk();
  if (!risk.atRisk) return null;
  try { if (s) s.setItem(NOTICE_KEY, String(Date.now())); } catch (_) { /* shown once per session then */ }
  return { kind: 'eviction', message: risk.message };
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
 * {detail:{ok:true, projectId, savedAt, notice?}} or {detail:{ok:false, error}} (errors are
 * de-duplicated until a save succeeds). `notice` ({kind:'eviction', message}) comes with the first
 * successful save once ever, in browsers that may delete stored projects on their own (Safari
 * outside the Home Screen): show it to the user. Returns a controller:
 *   flush()   → Promise, resolves once the project as it is NOW is stored (waits for a running save)
 *   disable() → stop; edits still waiting for the debounce are saved first
 */
export function enableAutosave(store, delayMs = 1500) {
  let timer = 0;
  let saving = null;   // the running save
  let queued = null;   // a save that starts as soon as the running one is done
  let disabled = false;
  let lastErrorMsg = '';
  let lastSavedAt = 0;
  // Project ids that have had content this session (or were loaded with content): once a project
  // is worth saving, emptying it must be saved too. Blank new projects never litter the DB.
  const worthSaving = new Set();

  const save = (project, keep) => (async () => {
    try {
      await saveProject(project, store.media, keep ? { keep } : undefined);
      await setLastProjectId(project.id);
      lastSavedAt = Date.now();
      lastErrorMsg = '';
      let notice = null;
      try { notice = await storageNoticeOnce(); } catch (_) { notice = null; }
      emit(store, 'persist', notice
        ? { ok: true, projectId: project.id, savedAt: lastSavedAt, notice }
        : { ok: true, projectId: project.id, savedAt: lastSavedAt });
    } catch (err) {
      const e = friendly(err, 'save the project');
      if (e.message !== lastErrorMsg) {
        lastErrorMsg = e.message;
        emit(store, 'persist', { ok: false, error: e });
        if (typeof console !== 'undefined') console.warn('[autosave]', e.message, err);
      }
    }
  })();

  const run = () => {
    clearTimeout(timer);
    timer = 0;
    if (disabled) return Promise.resolve();
    if (saving) {
      // The running save holds an older copy of the project: save again right after it, so
      // whoever waits on this (flush before New / Open project, page hide) gets today's state.
      if (!queued) queued = saving.then(() => { queued = null; return run(); });
      return queued;
    }
    const project = store.project;
    if (!isEmptyProject(project)) worthSaving.add(project.id);
    if (!worthSaving.has(project.id)) return Promise.resolve();
    // saveProject captures the project synchronously, so later edits can't leak into this save.
    saving = save(project).finally(() => { saving = null; });
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
    if (timer) run();
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };

  store.addEventListener('change', onChange);
  store.addEventListener('media', onMedia);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flushNow);
  liveStores.set(store, (liveStores.get(store) || 0) + 1);
  // No navigator.storage.persist() here: Firefox would show a permission prompt at every start.
  // Ask with requestPersistentStorage({ userAction: true }) after an explicit save instead.

  return {
    flush: () => run(),
    disable() {
      if (disabled) return;
      const unsaved = !!timer || !!queued;
      disabled = true;
      clearTimeout(timer);
      timer = 0;
      store.removeEventListener('change', onChange);
      store.removeEventListener('media', onMedia);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', flushNow);
      let keep = null;
      try { keep = typeof store.mediaInUse === 'function' ? store.mediaInUse() : null; } catch (_) { keep = null; }
      const n = (liveStores.get(store) || 1) - 1;
      if (n > 0) liveStores.set(store, n); else liveStores.delete(store);
      // Edits still waiting for the debounce: save the project as it is now (captured right here,
      // so whatever the caller changes next is not part of it).
      const project = store.project;
      if (unsaved && project && (worthSaving.has(project.id) || !isEmptyProject(project))) save(project, keep);
    },
    get saving() { return !!saving; },
    get pending() { return !!timer || !!queued; },
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
    const file = new Blob(acc ? [acc, ...parts] : parts, { type: 'application/json' });
    markProjectExported(project.id);
    return file;
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
