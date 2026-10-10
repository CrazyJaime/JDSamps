// ui/dialogs.js — Movie Maker (web): modal dialogs & phone bottom sheets, toasts, progress,
// the application ("file") menu, Save movie (export), webcam video and narration recording,
// the Trim tool, Options, About and Help.
//
//   export class Dialogs {
//     constructor(app)                       // touches only the DOM (built before the player etc.)
//     open({ title, body, buttons, sheet })  -> Promise<value>   (+ .close(value), .el on the promise)
//     confirm(msg, opts?) -> Promise<boolean>     promptText(title, value, opts?) -> Promise<string|null>
//     notify(title, msg, { type }) -> Promise      toast(msg, { type, timeout, action, onClick })
//     progress(title, opts?) -> { set(p, text), close(), signal }
//     openAppMenu(); openExport(presetId); openWebcam(); openNarration(); openTrim(itemId);
//     openAbout(); openProjects(); openOptions(); openHelp()
//     // project helpers (used by the app menu when a command is missing, by drag & drop, …)
//     loadProjectById(id), newProject(), saveProject(), saveProjectAs(), renameProject(id?, name?),
//     importProjectFromFile(file?), exportProjectFile()
//     // Android Back / iOS swipe-back for transient surfaces (ui/dom.js backGuard uses these)
//     pushBack(onBack) -> token|null      releaseBack(token)
//     // Trim tool state for a ribbon Trim tab ('mm-trim' window event: detail = trimState | null)
//     get trimState -> { itemId, name, start, end, duration } | null
//     trimSetPoint('start'|'end'), trimSetValue('start'|'end', seconds), trimFinish(save)
//     get isModalOpen / isMenuOpen / trimActive
//   }
//   export function getOption(name) / setOption(name, value)   // 'photoDuration' | 'transitionDuration'
//
// Styling uses the shared classes documented in css/moviemaker.css (.dlg-backdrop, .dlg, .dlg-sheet,
// .dlg-title, .dlg-body, .dlg-buttons, .btn, .toast, .app-menu, .progress, .trim-panel …). A small
// zero-specificity fallback stylesheet (<style id="dlg-style">) keeps everything usable even if the
// main stylesheet lacks a rule; classes prefixed "mmd-" are private to this module.

import * as dom from './dom.js';
import { createProject, formatTime, uid, DEFAULT_IMAGE_DURATION, DEFAULT_TRANSITION_DURATION } from '../model.js';
import * as exporterMod from '../exporter.js';
import { anchorTexts, reanchorTexts } from '../automovie.js';

export const APP_VERSION = '1.0.0';

const h = dom.h;
const LS_PREFIX = 'wlmm-web:';
const APP_ICON_URL = new URL('../../icons/icon.svg', import.meta.url).href;

// ---------------------------------------------------------------------------
// Small helpers

const PHONE_Q = '(max-width: 760px), (pointer: coarse) and (max-width: 1024px) and (orientation: portrait)';
const PHONE_LAND_Q = '(pointer: coarse) and (orientation: landscape) and (max-height: 520px)';

function mq(q) {
  try { return typeof matchMedia === 'function' && matchMedia(q).matches; } catch (_) { return false; }
}
function isPhoneLayout() {
  if (typeof dom.isPhone === 'function') { try { return !!dom.isPhone(); } catch (_) { /* fall through */ } }
  return mq(PHONE_Q) || mq(PHONE_LAND_Q);
}
function isPhoneLandscapeLayout() {
  if (typeof dom.isPhoneLandscape === 'function') { try { return !!dom.isPhoneLandscape(); } catch (_) { /* fall through */ } }
  return mq(PHONE_LAND_Q);
}
const isCoarse = () => mq('(pointer: coarse)');
const reducedMotion = () => mq('(prefers-reduced-motion: reduce)');

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
function isAppleWebKit() {
  return typeof navigator !== 'undefined' && /Apple/.test(navigator.vendor || '');
}
function isMac() {
  if (typeof navigator === 'undefined') return false;
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  return /Mac|iPhone|iPad|iPod/i.test(p);
}

function icon(name, size = 16) {
  try {
    if (typeof dom.icon === 'function' && (typeof dom.hasIcon !== 'function' || dom.hasIcon(name))) return dom.icon(name, size);
  } catch (_) { /* fall through */ }
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('viewBox', '0 0 32 32');
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
function clampNum(v, lo, hi) { const n = Number(v); if (!Number.isFinite(n)) return lo; return n < lo ? lo : n > hi ? hi : n; }
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
let _uidN = 0;
function domId(prefix) { _uidN += 1; return `mmd-${prefix}-${_uidN.toString(36)}`; }

function lsGet(key) { try { return localStorage.getItem(LS_PREFIX + key); } catch (_) { return null; } }
function lsSet(key, v) {
  try {
    if (v === null || v === undefined) localStorage.removeItem(LS_PREFIX + key);
    else localStorage.setItem(LS_PREFIX + key, String(v));
  } catch (_) { /* storage blocked */ }
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p2(mm)}:${p2(ss)}` : `${p2(mm)}:${p2(ss)}`;
}

function fmtBytes(n) {
  if (!(n > 0)) return '0 MB';
  const mb = n / (1024 * 1024);
  if (mb < 1) return 'less than 1 MB';
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** "about 12 MB" / "under 1 MB" for estimates. */
function fmtEstimate(n) {
  return n > 0 && n < 1024 * 1024 ? 'under 1 MB' : `about ${fmtBytes(n)}`;
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86400000);
  let time = '';
  try { time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (_) { time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return d.toDateString(); }
}

function fileStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
}

function safeName(s, fallback = 'My Movie') {
  const v = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return v || fallback;
}

function baseMime(m) { return String(m || '').split(';')[0].trim().toLowerCase(); }

function extForMime(mime, kind = 'video') {
  const b = baseMime(mime);
  if (kind === 'audio') {
    if (b === 'audio/mp4' || b === 'audio/aac' || b === 'audio/x-m4a') return 'm4a';
    if (b === 'audio/ogg') return 'ogg';
    if (b === 'audio/mpeg') return 'mp3';
    if (b === 'audio/wav' || b === 'audio/wave') return 'wav';
    return 'webm';
  }
  if (b === 'video/mp4') return 'mp4';
  if (b === 'video/quicktime') return 'mov';
  if (b === 'video/x-matroska') return 'mkv';
  return 'webm';
}

function pickRecorderType(candidates) {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (_) { /* ignore */ }
  }
  return '';
}

const CAM_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
const CAM_TYPES_APPLE = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
const MIC_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
const MIC_TYPES_APPLE = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'];

function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const t of stream.getTracks()) { try { t.stop(); } catch (_) { /* ignore */ } }
}

function makeFile(blob, name) {
  try { return new File([blob], name, { type: blob.type || '', lastModified: Date.now() }); } catch (_) {
    try { blob.name = name; } catch (__) { /* ignore */ }
    return blob;
  }
}

function errorMessage(err, fallback) {
  if (!err) return fallback;
  if (err.friendly && err.message) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

function deviceErrorMessage(err, what) {
  const name = (err && err.name) || '';
  const thing = what === 'camera' ? 'camera' : 'microphone';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return `Movie Maker isn't allowed to use your ${thing}. Allow ${thing} access for this site in your browser's settings, then try again.`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return what === 'camera' ? 'No webcam was found. Connect a camera and try again.' : 'No microphone was found. Connect a microphone and try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return `Your ${thing} couldn't be started. It may be in use by another app — close it and try again.`;
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return `The ${thing} can only be used when Movie Maker is opened over a secure (https) connection.`;
  }
  return `Your ${thing} couldn't be started${err && err.message ? ` (${err.message})` : ''}.`;
}

function isTextField(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const t = (el.type || 'text').toLowerCase();
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(t);
}

/** A field the user types into (brings up the on-screen keyboard): not a select, checkbox, button … */
function isTypingField(el) {
  return isTextField(el) && el.tagName !== 'SELECT';
}

/** Select all of a field's text (setSelectionRange is the reliable form on iOS). */
function selectAllText(input) {
  if (!input) return;
  try { input.select(); } catch (_) { /* ignore */ }
  try {
    const n = String(input.value || '').length;
    if (n && typeof input.setSelectionRange === 'function') input.setSelectionRange(0, n);
  } catch (_) { /* type=number etc. have no selection */ }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), '
  + 'textarea:not([disabled]), video[controls], audio[controls], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
    if (el.hidden || el.closest('[hidden]') || el.closest('[inert]')) return false;
    const r = el.getClientRects();
    return r.length > 0;
  });
}

function focusEl(el) {
  if (!el || typeof el.focus !== 'function') return;
  try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) { /* ignore */ } }
}

// Parts of the window locked while the Trim tool is open (the clip is temporarily untrimmed, so
// nothing may edit or save the project until Save trim / Cancel).
const TRIM_LOCKED = ['ribbon', 'storyboard-pane', 'qat', 'app-menu-btn'];

/** Drop the store's cached timeline after a direct (event-less) project mutation. */
function invalidateTimeline(store) {
  if (!store) return;
  if (typeof store.invalidate === 'function') store.invalidate();
  else if ('_timeline' in store) store._timeline = null;
}

// ---------------------------------------------------------------------------
// History entries used to catch Android Back / iOS swipe-back (see Dialogs#pushBack).

/** Identifies this page load, so entries left over from an earlier load are never mistaken for ours. */
const BACK_SID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function historyUsable() {
  return typeof history !== 'undefined' && typeof history.pushState === 'function' && typeof history.go === 'function';
}

/** How many of our back-catching entries sit at/below this history state (0 = the app's own entry). */
function backDepth(state) {
  if (!state || typeof state !== 'object' || !state.mmDialog || state.mmSid !== BACK_SID) return 0;
  const d = Number(state.mmDepth);
  return Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
}

function makeEvent(type, detail) {
  if (typeof CustomEvent === 'function') return new CustomEvent(type, { detail });
  const e = new Event(type);
  e.detail = detail;
  return e;
}

// ---------------------------------------------------------------------------
// Options (File menu › Options), stored per browser in localStorage.

export const OPTION_DEFAULTS = Object.freeze({
  photoDuration: DEFAULT_IMAGE_DURATION,
  transitionDuration: DEFAULT_TRANSITION_DURATION,
});
const OPTION_LIMITS = { photoDuration: [0.5, 60], transitionDuration: [0.25, 5] };

/** Current value of an option ('photoDuration' | 'transitionDuration'), in seconds. */
export function getOption(name) {
  if (!Object.prototype.hasOwnProperty.call(OPTION_DEFAULTS, name)) return undefined;
  const raw = lsGet(`opt:${name}`);
  const v = raw === null ? NaN : parseFloat(raw);
  const [lo, hi] = OPTION_LIMITS[name];
  return Number.isFinite(v) && v >= lo && v <= hi ? v : OPTION_DEFAULTS[name];
}

/** Store an option (null resets it). Fires window 'mm-options' {detail:{name, value}}. */
export function setOption(name, value) {
  if (!Object.prototype.hasOwnProperty.call(OPTION_DEFAULTS, name)) return;
  if (value === null || value === undefined) lsSet(`opt:${name}`, null);
  else {
    const [lo, hi] = OPTION_LIMITS[name];
    lsSet(`opt:${name}`, clampNum(value, lo, hi));
  }
  try { window.dispatchEvent(makeEvent('mm-options', { name, value: getOption(name) })); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Fallback + private styles

const STYLE = `
:where(#dialog-root){position:relative;z-index:1000}
:where(.dlg-backdrop){position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(15,30,55,.32)}
:where(.dlg-backdrop.is-closing){opacity:0;transition:opacity .14s ease}
:where(.dlg){position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:460px;max-width:100%;max-height:100%;padding:0 7px 7px;border:1px solid #4e6c94;border-radius:7px;background:linear-gradient(135deg,#c9dcf3,#b1cbea 45%,#c6daf2);box-shadow:0 18px 50px rgba(10,25,50,.45);color:#15283f;font:12px/1.45 "Segoe UI",Tahoma,system-ui,-apple-system,sans-serif}
:where(.dlg-wide){width:640px}
:where(.dlg-narrow){width:340px}
:where(.dlg-title){display:flex;align-items:center;gap:8px;min-height:32px;margin:0;padding:4px 2px 4px 4px;font-size:13px;font-weight:400}
:where(.dlg-close){margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:42px;height:20px;padding:0;border:1px solid #6a2b25;border-radius:0 0 4px 4px;background:linear-gradient(#e9a99c,#c2412d);color:#fff;cursor:pointer}
:where(.dlg-close) svg{width:12px;height:12px}
:where(.dlg-body){flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px 8px;border:1px solid #8ea6c4;border-bottom:0;background:#fff;color:#1b1b1b}
:where(.dlg-buttons){display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:10px 12px;border:1px solid #8ea6c4;border-top-color:#dfdfdf;background:#f0f0f0}
:where(.btn){display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:80px;height:25px;padding:0 12px;border:1px solid #707070;border-radius:3px;background:linear-gradient(#f2f2f2,#ebebeb 49%,#ddd 50%,#cfcfcf);color:#000;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
:where(.btn:disabled){color:#8d8d8d;border-color:#adb2b5;background:#f4f4f4;cursor:default}
:where(.btn-primary){border-color:#3399ff;box-shadow:inset 0 0 0 1px #9fd5ff}
:where(.btn) svg{width:16px;height:16px}
:where(.hint){color:#5e7491;font-size:11.5px;line-height:1.35}
:where(.field){display:flex;flex-direction:column;gap:3px;margin:0 0 10px}
:where(.check){display:inline-flex;align-items:center;gap:6px;min-height:22px}
:where(#toast-root){position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:1100;display:flex;flex-direction:column-reverse;align-items:center;gap:8px;width:min(520px,calc(100vw - 24px));transform:translateX(-50%);pointer-events:none}
:where(.toast){display:flex;align-items:center;gap:10px;max-width:100%;min-height:38px;box-sizing:border-box;padding:8px 12px 8px 10px;border:1px solid #8fa8c6;border-left:5px solid #2f78d1;border-radius:4px;background:linear-gradient(#fff,#eef4fb);box-shadow:0 6px 18px rgba(15,35,65,.28);color:#15283f;font-size:13px;line-height:1.35;pointer-events:auto}
:where(.toast.is-leaving){opacity:0;transition:opacity .18s ease}
:where(.toast-success){border-left-color:#3aa52f}
:where(.toast-error){border-left-color:#d2312b;background:linear-gradient(#fffafa,#fdecea)}
:where(.toast-msg){flex:1 1 auto;min-width:0}
:where(.toast) button{flex:none;border:0;background:none;color:#1a5fb4;font:inherit;font-weight:600;padding:4px 6px;border-radius:3px;cursor:pointer}
:where(.app-menu){position:fixed;left:4px;top:56px;z-index:950;display:grid;grid-template-columns:minmax(220px,260px) minmax(220px,300px);grid-template-rows:minmax(0,1fr) auto;max-height:calc(100vh - 80px);border:1px solid #5b7aa3;border-top:3px solid #1d5bb4;background:#fff;box-shadow:0 6px 18px rgba(20,40,70,.28)}
:where(.app-menu-items){display:flex;flex-direction:column;padding:4px;overflow:auto;border-right:1px solid #d5dfeb}
:where(.app-menu-item){display:flex;align-items:center;gap:10px;min-height:42px;padding:4px 10px 4px 6px;border:1px solid transparent;border-radius:3px;background:transparent;text-align:left;font:inherit;font-size:12.5px;color:#15283f;cursor:pointer}
:where(.app-menu-item) svg{width:32px;height:32px;flex:none}
:where(.app-menu-item:hover),:where(.app-menu-item:focus-visible){border-color:#e8c46a;background:linear-gradient(#fffbec,#fde8a8);outline:none}
:where(.app-menu-sep){height:1px;margin:3px 6px 3px 46px;border:0;background:#dfe6ef}
:where(.app-menu-side){display:flex;flex-direction:column;min-height:0;overflow:auto;padding:4px 6px}
:where(.app-menu-heading){padding:6px 6px 5px;margin-bottom:3px;border-bottom:1px solid #d5dfeb;color:#3e6aa8;font-weight:600}
:where(.app-menu-recent){display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;min-height:34px;padding:4px 8px;border:1px solid transparent;border-radius:3px;background:transparent;text-align:left;font:inherit;color:#15283f;cursor:pointer}
:where(.app-menu-recent:hover),:where(.app-menu-recent:focus-visible){border-color:#e8c46a;background:linear-gradient(#fffbec,#fde8a8);outline:none}
:where(.app-menu-empty){padding:10px 8px;color:#5e7491}
:where(.app-menu-footer){grid-column:1 / -1;display:flex;justify-content:flex-end;gap:6px;padding:6px 8px;border-top:1px solid #d5dfeb;background:linear-gradient(#f3f6fa,#e4ebf4)}
:where(.progress){position:relative;width:100%;height:16px;overflow:hidden;box-sizing:border-box;border:1px solid #a3a3a3;border-radius:2px;background:linear-gradient(#f3f3f3,#e1e1e1)}
:where(.progress>.progress-bar){position:absolute;left:0;top:0;bottom:0;width:calc(var(--p,0) * 100%);background:linear-gradient(90deg,#2fb32f,#5fd65f)}
:where(.progress-text){margin-top:6px;color:#5e7491;font-size:12px;font-variant-numeric:tabular-nums}
:where(.trim-panel){display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:6px 10px;border:1px solid #8fa8c6;border-top:3px solid #f4c542;background:linear-gradient(#fff,#f2f6fc 55%,#dfe9f6);box-shadow:0 6px 18px rgba(20,40,70,.28);font-size:12px}
:where(.trim-field){display:inline-flex;align-items:center;gap:6px}
:where(.trim-actions){display:inline-flex;gap:6px;margin-left:auto}
@media (max-width:760px),(pointer:coarse) and (max-width:1024px) and (orientation:portrait){
  :where(.dlg-backdrop.is-sheet){align-items:flex-end;padding:0}
  :where(.dlg-sheet){width:100%;max-height:88vh;border-radius:14px 14px 0 0;padding-bottom:env(safe-area-inset-bottom,0px)}
  :where(.btn){min-height:44px;font-size:15px}
  :where(.app-menu){left:0;right:0;top:0;bottom:0;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;max-height:none;overflow:auto}
}

/* ---- private (mmd-) ---- */
.mmd-menu-layer{position:fixed;inset:0;z-index:940;background:transparent}
.mmd-menu-layer .app-menu{z-index:941}
.app-menu-item.mmd-has-sub{position:relative;padding-right:24px}
.app-menu-item.mmd-has-sub::after{content:"";position:absolute;right:10px;top:50%;margin-top:-4px;border:4px solid transparent;border-left:5px solid #4d5b6b}
.app-menu-item.is-active{border-color:#e8c46a;background:linear-gradient(#fffbec,#fde8a8)}
.app-menu-recent.is-current small::after{content:" · open now";color:#3aa52f}
.app-menu-recent .mmd-recent-name{font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.app-menu-recent.mmd-recent{flex-direction:row;align-items:center;gap:8px;padding-left:5px}
.mmd-recent-thumb{flex:none;display:flex;align-items:center;justify-content:center;width:48px;height:27px;overflow:hidden;border-radius:2px;background:#1b1f24;color:#c9d6e6}
.mmd-recent-thumb img{width:100%;height:100%;object-fit:cover}
.mmd-recent-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.mmd-menu-note{margin-right:auto;align-self:center;color:#5e7491;font-size:11px}
.mmd-menu-head{display:none}
.mmd-dlg-msg{display:flex;gap:12px;align-items:flex-start}
.mmd-dlg-msg>svg{flex:none;width:32px;height:32px}
.mmd-dlg-msg p{margin:0 0 8px;white-space:pre-line}
.mmd-prompt input{width:100%;box-sizing:border-box}
.mmd-prompt textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:4.5em;font:inherit;line-height:1.35}
.mmd-spin{display:inline-block;width:16px;height:16px;border:2px solid rgba(47,120,209,.25);border-top-color:#2f78d1;border-radius:50%;animation:mmd-spin .8s linear infinite;vertical-align:-3px}
@keyframes mmd-spin{to{transform:rotate(360deg)}}
.mmd-loading{display:flex;align-items:center;gap:8px;padding:16px 4px;color:#5e7491}
.mmd-error-text{color:#a3170d}
.progress.is-indeterminate>.progress-bar{width:30%}
/* projects */
.mmd-projects{display:flex;flex-direction:column;gap:4px;min-height:120px}
.mmd-proj{display:flex;align-items:stretch;gap:4px;border:1px solid #e1e8f1;border-radius:4px;background:#fff}
.mmd-proj.is-current{border-color:#9cc3ec;background:#f4f9ff}
.mmd-proj-open{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:10px;padding:6px;border:1px solid transparent;border-radius:3px;background:transparent;text-align:left;font:inherit;color:inherit;cursor:pointer}
.mmd-proj-open:hover,.mmd-proj-open:focus-visible{border-color:#e8c46a;background:linear-gradient(#fffbec,#fde8a8);outline:none}
.mmd-proj-thumb{flex:none;width:96px;height:54px;border-radius:2px;background:#1b1f24 center/cover no-repeat;display:flex;align-items:center;justify-content:center;overflow:hidden}
.mmd-proj-thumb img{width:100%;height:100%;object-fit:cover}
.mmd-proj-text{min-width:0;display:flex;flex-direction:column;gap:2px}
.mmd-proj-name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mmd-proj-meta{color:#5e7491;font-size:11.5px}
.mmd-proj-act{flex:none;align-self:center;min-width:0;width:34px;padding:0}
.mmd-proj-act:last-child{margin-right:6px}
.mmd-empty{padding:24px 8px;text-align:center;color:#5e7491}
/* export */
.mmd-presets{display:flex;flex-direction:column;gap:2px;margin:0 0 12px}
.mmd-preset{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid transparent;border-radius:3px;cursor:pointer}
.mmd-preset:hover{background:#f2f7fd}
.mmd-preset.is-checked{border-color:#9cc3ec;background:#eaf3fd}
.mmd-preset input{margin:0;flex:none;accent-color:#2f78d1}
.mmd-preset-text{display:flex;flex-direction:column}
.mmd-preset-text small{color:#5e7491;font-size:11.5px}
.mmd-export-summary{margin:10px 0 6px;padding:8px 10px;border-radius:3px;background:#f2f6fb;color:#1e395b}
.mmd-export-summary b{font-variant-numeric:tabular-nums}
.mmd-export-live{display:flex;flex-direction:column;gap:8px}
.mmd-export-screen{position:relative;align-self:center;max-width:100%;background:#000;border:1px solid #3a4452;box-shadow:0 1px 4px rgba(0,0,0,.25)}
.mmd-export-screen canvas{display:block;width:100%;height:100%}
.mmd-export-stats{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;color:#5e7491;font-variant-numeric:tabular-nums}
.mmd-export-pct{font-size:13px;color:#15283f}
.mmd-export-msg{min-height:1.4em;color:#8a5a00}
.mmd-export-warning{color:#8a5a00;font-size:12px}
.mmd-export-warning svg{vertical-align:-2px}
.mmd-export-msg:empty{display:none}
.mmd-saved{display:flex;flex-direction:column;gap:8px}
.mmd-saved video{width:100%;max-height:46vh;background:#000;border-radius:2px}
.mmd-file-line{color:#5e7491;word-break:break-word}
/* recording */
.mmd-cam{display:flex;flex-direction:column;gap:10px}
.mmd-cam-stage{position:relative;width:100%;aspect-ratio:16/9;max-height:52vh;background:#000;border-radius:3px;overflow:hidden}
@supports not (aspect-ratio:1/1){.mmd-cam-stage{height:0;padding-top:56.25%}}
.mmd-cam-stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.mmd-cam-stage video.is-mirrored{transform:scaleX(-1)}
.mmd-cam-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;padding:16px;text-align:center;color:#e7eef7;font-size:14px;background:rgba(0,0,0,.35)}
.mmd-cam-msg.is-error{color:#ffd9d6}
.mmd-cam-rec{position:absolute;left:10px;top:10px;display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:12px;background:rgba(0,0,0,.55);color:#fff;font-weight:600;font-size:12px}
.mmd-rec-dot{width:10px;height:10px;border-radius:50%;background:#e3372c;animation:mmd-blink 1s steps(2,start) infinite}
@keyframes mmd-blink{to{visibility:hidden}}
.mmd-cam-bar{display:flex;align-items:center;justify-content:center;gap:16px;min-height:56px}
.mmd-cam-bar .mmd-cam-switch{position:absolute;left:0}
.mmd-cam-bar{position:relative}
.mmd-cam-time{position:absolute;right:0;font-variant-numeric:tabular-nums;font-size:14px;color:#1e395b}
.mmd-rec-btn{position:relative;width:56px;height:56px;padding:0;border:3px solid #c9d3df;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);cursor:pointer}
.mmd-rec-btn:disabled{opacity:.45;cursor:default}
.mmd-rec-btn .mmd-rec-shape{position:absolute;left:50%;top:50%;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:#e3372c;transition:all .15s ease}
.mmd-rec-btn.is-recording .mmd-rec-shape{width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:4px}
.mmd-rec-btn:focus-visible{outline:2px solid #3399ff;outline-offset:2px}
.mmd-narr{display:flex;flex-direction:column;gap:10px}
.mmd-narr-top{display:flex;align-items:center;gap:10px}
.mmd-narr-top svg{width:32px;height:32px;flex:none}
.mmd-narr-status{font-size:14px;color:#1e395b}
.mmd-meter{position:relative;height:12px;border:1px solid #9fb2c8;border-radius:2px;background:linear-gradient(90deg,#e9f7e9,#fdf6dc 70%,#fde3df);overflow:hidden}
.mmd-meter-fill{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:0 50%;transform:scaleX(0);background:linear-gradient(90deg,#3aa52f,#9bd63a 60%,#f4c542 80%,#e3372c)}
.mmd-meter-peak{position:absolute;top:0;bottom:0;width:2px;left:0;background:#1e395b}
.mmd-narr audio{width:100%}
.mmd-narr .check{font-size:12.5px}
.dlg-backdrop.mmd-dock{background:rgba(15,30,55,.12)}
@media (min-width:761px){.dlg-backdrop.mmd-dock:not(.is-sheet){align-items:flex-end;justify-content:flex-end;padding:0 18px 40px 12px}}
/* keys / about */
.mmd-keys{width:100%;border-collapse:collapse;margin:4px 0 12px}
.mmd-keys td{padding:4px 6px;border-bottom:1px solid #eef2f7;vertical-align:top}
.mmd-keys td:first-child{white-space:nowrap;width:1%}
.mmd-keys kbd{display:inline-block;min-width:16px;padding:1px 5px;border:1px solid #b9c6d6;border-bottom-width:2px;border-radius:3px;background:#f7f9fc;font:11px/1.4 Consolas,Menlo,monospace;text-align:center}
.mmd-help ul{margin:4px 0 12px;padding-left:20px}
.mmd-help li{margin:3px 0}
.mmd-about{display:flex;gap:16px;align-items:flex-start}
.mmd-about img{flex:none;width:72px;height:72px}
.mmd-about h3{margin:0 0 2px!important;font-size:18px!important;font-weight:400!important;color:#1b3d6b}
.mmd-caps{margin:8px 0 0;padding:0;list-style:none}
.mmd-caps li{display:flex;gap:6px;align-items:center;margin:3px 0}
.mmd-caps svg{width:14px;height:14px;flex:none}
.mmd-opt-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mmd-opt-row input{width:90px}
/* trim tool */
.trim-panel.mmd-trim{position:fixed;z-index:900;display:flex;flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:8px;box-sizing:border-box;margin:0;overflow:auto;overscroll-behavior:contain}
.mmd-trim.is-sheet{left:0;right:0;bottom:0;max-height:66vh;padding:8px 12px calc(10px + env(safe-area-inset-bottom,0px));border-radius:14px 14px 0 0;box-shadow:0 -8px 24px rgba(20,40,70,.3)}
.mmd-trim.is-docked{border-radius:0}
.mmd-trim-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.mmd-trim-head .mmd-trim-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1e395b;flex:1 1 auto}
.mmd-trim-len{font-variant-numeric:tabular-nums;color:#5e7491}
.mmd-trim.has-ribbon-tab .mmd-trim-head{align-items:center}
.mmd-trim.has-ribbon-tab .mmd-trim-play{flex:none;min-width:0;width:32px;padding:0}
.mmd-trim-track{position:relative;flex:none;height:64px;margin:8px 24px;touch-action:none;-webkit-user-select:none;user-select:none;cursor:pointer}
.mmd-trim-strip{position:absolute;inset:0;display:flex;overflow:hidden;border-radius:3px;background:#1b1f24 repeating-linear-gradient(90deg,#26303b 0 40px,#1b1f24 40px 44px)}
.mmd-trim-strip img{flex:1 1 0;min-width:0;height:100%;object-fit:cover;pointer-events:none;border-right:2px solid #10141a}
.mmd-trim-shade{position:absolute;top:0;bottom:0;background:rgba(10,15,25,.66);pointer-events:none}
.mmd-trim-range{position:absolute;top:-3px;bottom:-3px;box-sizing:border-box;border:3px solid #f4c542;border-left-width:0;border-right-width:0;pointer-events:none}
.mmd-trim-pos{position:absolute;top:-8px;bottom:-8px;width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.7);pointer-events:none}
.mmd-trim-handle{position:absolute;top:-6px;bottom:-6px;width:18px;box-sizing:border-box;border:1px solid #9a7a10;background:linear-gradient(#ffe48a,#f4c542);cursor:ew-resize;touch-action:none;outline:none}
.mmd-trim-handle.is-start{margin-left:-18px;border-radius:6px 0 0 6px}
.mmd-trim-handle.is-end{border-radius:0 6px 6px 0}
.mmd-trim-handle::before{content:"";position:absolute;top:-8px;bottom:-8px;left:-14px;right:-14px}
.mmd-trim-handle::after{content:"";position:absolute;left:50%;top:50%;width:6px;height:18px;margin:-9px 0 0 -3px;border-left:2px solid rgba(90,67,0,.6);border-right:2px solid rgba(90,67,0,.6);box-sizing:border-box}
.mmd-trim-handle:focus-visible{box-shadow:0 0 0 2px #3399ff}
.mmd-trim-handle.is-dragging{background:linear-gradient(#fff1bd,#f7d05e)}
.mmd-trim-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px}
.mmd-trim-group{display:inline-flex;align-items:center;gap:8px}
.mmd-trim-group .trim-field{white-space:nowrap}
.mmd-trim-controls .trim-field input{width:84px;text-align:right;font-variant-numeric:tabular-nums}
.mmd-trim-controls .trim-actions .mmd-trim-play{min-width:0;width:32px;flex:0 0 auto;padding:0}
.mmd-trim-play svg{width:16px;height:16px}
#app.mmd-trim-mode #ribbon,#app.mmd-trim-mode #storyboard-pane,#app.mmd-trim-mode #qat,#app.mmd-trim-mode #app-menu-btn{pointer-events:none}
#app.mmd-trim-mode #qat,#app.mmd-trim-mode #app-menu-btn{opacity:.5}
#app.mmd-trim-mode #ribbon,#app.mmd-trim-mode #storyboard-pane{opacity:.55;filter:grayscale(.4)}
#app.mmd-trim-mode.mmd-trim-ribbon-own #ribbon{pointer-events:auto;opacity:1;filter:none}
.mmd-trim-ribbon{position:fixed;z-index:905;margin:0;pointer-events:none}
.mmd-trim-ribbon .rb-tabrow{background:transparent}
.mmd-trim-ribbon .rb-ctx.mmd-trim-ctx{position:absolute;left:64px;bottom:0;height:100%;margin:0;pointer-events:auto}
.mmd-trim-ribbon .rb-tab{cursor:default}
.mmd-trim-ribbon .rb-body{pointer-events:auto;box-shadow:inset 0 1px 0 #fff,0 2px 6px rgba(20,40,70,.18)}
.mmd-trim-ribbon .rb-field{height:24px}
.mmd-trim-ribbon .mmd-trim-rb-label{min-width:64px}
.mmd-trim-ribbon .mmd-trim-num{width:70px;text-align:right;font-variant-numeric:tabular-nums}
.mmd-trim-ribbon .rb-large{min-width:56px}
.mmd-trim-ribbon .rb-btn:focus-visible{outline:1px dotted #15283f;outline-offset:-3px}
#app.mmd-trim-ribbon-on #ribbon .rb-ctx,#app.mmd-trim-ribbon-on #ribbon .rb-body{visibility:hidden}
@media (max-width:760px),(pointer:coarse) and (max-width:1024px) and (orientation:portrait){
  .mmd-menu-head{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #d5dfeb;font-size:17px;font-weight:600;color:#1b3d6b}
  .mmd-menu-head img{width:28px;height:28px}
  .mmd-proj-thumb{width:80px;height:45px}
  .mmd-recent-thumb{width:64px;height:36px}
  .mmd-proj-act{width:44px;height:44px}
  .mmd-preset{padding:8px;min-height:44px}
  .mmd-cam-stage{max-height:46vh}
  .mmd-trim-track{height:72px;margin:10px 26px}
  .mmd-trim-group{display:flex;width:100%}
  .mmd-trim-group .trim-field{flex:1 1 auto;min-width:0}
  .mmd-trim-group .trim-field span:first-child{min-width:82px}
  .mmd-trim-controls .trim-field input{width:88px}
  .mmd-trim-group .btn{flex:0 0 auto;padding:0 12px}
  .mmd-trim-controls .trim-actions .mmd-trim-play{flex:0 0 52px;width:52px}
  .dlg-buttons .btn.mmd-btn-wide{flex:1 1 100%;order:-1}
  .mmd-menu-note{display:none}
  .app-menu.mmd-app-menu{display:flex;flex-direction:column;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  .app-menu.mmd-app-menu>.app-menu-items,.app-menu.mmd-app-menu>.app-menu-side{flex:none;overflow:visible}
  .app-menu.mmd-app-menu>.app-menu-side{scroll-margin-top:60px;padding-bottom:12px}
  .app-menu.mmd-app-menu>.mmd-menu-head{position:sticky;top:0;z-index:2;flex:none;background:#fff}
  .app-menu.mmd-app-menu>.app-menu-footer{position:sticky;bottom:0;z-index:2;flex:none;margin-top:auto}
  .mmd-about img{width:56px;height:56px}
}
@media (prefers-reduced-motion:reduce){.mmd-spin,.mmd-rec-dot{animation:none}}
`;

function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('dlg-style')) return;
  const style = document.createElement('style');
  style.id = 'dlg-style';
  style.textContent = STYLE;
  (document.head || document.documentElement).appendChild(style);
}

function ensureRoot(id, attrs) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    (document.body || document.documentElement).appendChild(el);
  }
  return el;
}

// ---------------------------------------------------------------------------

export class Dialogs {
  constructor(app) {
    this.app = app || {};
    injectStyle();
    this.root = ensureRoot('dialog-root');
    this.toastRoot = ensureRoot('toast-root', { 'aria-live': 'polite', 'aria-atomic': 'false' });
    if (!this.toastRoot.hasAttribute('aria-live')) this.toastRoot.setAttribute('aria-live', 'polite');
    this._stack = [];
    this._toasts = [];
    this._menu = null;
    this._trim = null;
    this._inertOn = false;
    // Back handling (see pushBack): live tokens, the depth of the current history entry, and our
    // own traversal in flight (if any).
    this._backStack = [];
    this._histDepth = 0;
    this._histBusy = false;
    this._histTarget = 0;
    this._histSyncTimer = 0;
    this._histBusyTimer = 0;
    this._exportOpen = false;
    this._onKey = this._onKey.bind(this);
    this._onPop = this._onPop.bind(this);
    document.addEventListener('keydown', this._onKey, true);
    window.addEventListener('popstate', this._onPop);
  }

  // ------------------------------------------------------------------ state

  get isModalOpen() { return this._stack.length > 0 || !!this._menu; }
  get isMenuOpen() { return !!this._menu; }
  get trimActive() { return !!this._trim; }
  get openCount() { return this._stack.length; }

  // ------------------------------------------------------------------ core dialog

  /**
   * Low-level dialog. Returns a handle:
   *   { el, body, promise, close(value), setTitle(t), setBody(node), setButtons(list), setDismissible(v),
   *     onEscape, closed }
   * opts: title, body (Node|string), buttons [{label, value, primary, danger, icon, disabled, close,
   *       onClick(handle, el) → false keeps it open}], sheet (true / false / undefined = phone only),
   *       className, size 'wide'|'narrow', dismissible (default true), cancelValue (default null),
   *       backdropClass, initialFocus (element), onClose(value), role.
   */
  _create(opts = {}) {
    this._closeMenu();
    const id = domId('dlg');
    const phone = isPhoneLayout();
    const sheet = opts.sheet === true ? true : opts.sheet === false ? false : phone;
    const backdrop = h('div', { class: ['dlg-backdrop', sheet ? 'is-sheet' : '', opts.backdropClass || ''], role: 'presentation' });
    const titleText = h('span', { class: 'dlg-title-text', id: `${id}-title` }, opts.title || 'Movie Maker');
    const closeBtn = h('button', { type: 'button', class: 'dlg-close', 'aria-label': 'Close', title: 'Close' }, icon('close', 12));
    const titleEl = h('div', { class: 'dlg-title' }, titleText, closeBtn);
    const body = h('div', { class: 'dlg-body' });
    const buttonsEl = h('div', { class: 'dlg-buttons' });
    const sizeClass = opts.size === 'wide' ? 'dlg-wide' : opts.size === 'narrow' ? 'dlg-narrow' : '';
    const dlg = h('div', {
      class: ['dlg', sheet ? 'dlg-sheet' : '', sizeClass, opts.className || ''],
      role: opts.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`, tabindex: '-1',
    }, titleEl, body, buttonsEl);
    backdrop.appendChild(dlg);

    let resolveFn = null;
    const handle = {
      id, el: dlg, backdrop, body, titleEl, buttonsEl, sheet,
      dismissible: opts.dismissible !== false,
      cancelValue: Object.prototype.hasOwnProperty.call(opts, 'cancelValue') ? opts.cancelValue : null,
      onEscape: null,
      onClose: typeof opts.onClose === 'function' ? opts.onClose : null,
      closed: false,
      primaryBtn: null,
      returnFocus: document.activeElement,
      promise: null,
      backToken: null,
    };
    handle.promise = new Promise((r) => { resolveFn = r; });
    handle.close = (value) => this._close(handle, value, resolveFn);
    handle.setTitle = (t) => { titleText.textContent = t || 'Movie Maker'; };
    handle.setBody = (node) => {
      clear(body);
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) node.forEach((n) => body.appendChild(typeof n === 'string' ? h('p', null, n) : n));
      else body.appendChild(typeof node === 'string' ? h('p', null, node) : node);
      body.scrollTop = 0;
    };
    handle.setButtons = (list) => this._renderButtons(handle, list || []);
    handle.setDismissible = (v) => { handle.dismissible = !!v; closeBtn.hidden = !v; };

    closeBtn.addEventListener('click', () => { if (handle.dismissible) handle.close(handle.cancelValue); });
    handle.setBody(opts.body);
    handle.setButtons(opts.buttons || []);
    handle.setDismissible(handle.dismissible);

    // Backdrop tap closes non-critical dialogs (only when the press started on the backdrop).
    let downOnBackdrop = false;
    backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === backdrop; });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && downOnBackdrop && handle.dismissible && handle === this._top()) handle.close(handle.cancelValue);
      downOnBackdrop = false;
    });
    if (sheet) this._enableSwipeDown(handle);

    this.root.appendChild(backdrop);
    this._stack.push(handle);
    this._setInert(true);
    const onBack = () => {
      if (handle.closed) return;
      if (handle.onEscape) handle.onEscape();
      else if (handle.dismissible) handle.close(handle.cancelValue);
      if (!handle.closed) handle.backToken = this._pushBack(onBack); // still open (busy): keep catching Back
    };
    handle.backToken = this._pushBack(onBack);

    // Initial focus: an explicit element, else (desktop) the first control, else the dialog itself.
    const focusTarget = opts.initialFocus
      || (!isCoarse() ? (focusables(body)[0] || handle.primaryBtn || focusables(buttonsEl)[0]) : null)
      || dlg;
    // A text field is focused right away: iOS only opens the on-screen keyboard for a focus() made
    // while the user's tap is being handled (dialogs are built synchronously from the tap). Other
    // targets wait a frame (the sheet is laid out by then); the frame also retries a refused focus.
    const typing = isTypingField(focusTarget);
    if (typing) focusEl(focusTarget);
    requestAnimationFrame(() => {
      if (handle.closed || (typing && document.activeElement === focusTarget)) return;
      focusEl(focusTarget);
    });
    return handle;
  }

  _renderButtons(handle, list) {
    const el = handle.buttonsEl;
    clear(el);
    handle.primaryBtn = null;
    for (const b of list) {
      if (!b) continue;
      const btn = h('button', {
        type: 'button',
        class: ['btn', b.primary ? 'btn-primary' : '', b.danger ? 'btn-danger' : '', b.className || ''],
        disabled: !!b.disabled, title: b.title || undefined,
      }, b.icon ? icon(b.icon, 16) : null, h('span', null, b.label));
      btn.addEventListener('click', () => {
        if (handle.closed || btn.disabled) return;
        let r;
        if (typeof b.onClick === 'function') {
          try { r = b.onClick(handle, btn); } catch (err) { this._reportError(err); return; }
        }
        const finish = (res) => {
          if (res === false || b.close === false || handle.closed) return;
          handle.close(Object.prototype.hasOwnProperty.call(b, 'value') ? b.value : b.label);
        };
        if (r && typeof r.then === 'function') r.then(finish, (err) => this._reportError(err));
        else finish(r);
      });
      if (typeof b.ref === 'function') b.ref(btn);
      if (b.primary && !handle.primaryBtn) handle.primaryBtn = btn;
      el.appendChild(btn);
    }
    el.hidden = el.children.length === 0;
  }

  _close(handle, value, resolve) {
    if (handle.closed) return;
    handle.closed = true;
    const wasTop = this._top() === handle;
    const i = this._stack.indexOf(handle);
    if (i >= 0) this._stack.splice(i, 1);
    this._releaseBack(handle.backToken);
    if (handle.onClose) { try { handle.onClose(value); } catch (err) { console.error(err); } }
    const bd = handle.backdrop;
    const remove = () => { if (bd.parentNode) bd.parentNode.removeChild(bd); };
    if (reducedMotion()) remove();
    else { bd.classList.add('is-closing'); setTimeout(remove, 160); }
    if (!this._stack.length && !this._menu) this._setInert(false);
    if (wasTop) {
      // Back to whatever opened this dialog (inside the dialog below it, if there is one).
      const rf = handle.returnFocus;
      const top = this._top();
      const usable = rf && rf.isConnected && rf !== document.body;
      if (top) focusEl(usable && top.el.contains(rf) ? rf : top.el);
      else if (usable && !this._menu) focusEl(rf);
    }
    resolve(value);
  }

  _top() { return this._stack.length ? this._stack[this._stack.length - 1] : null; }

  _setInert(onFlag) {
    const appEl = document.getElementById('app');
    if (!appEl || this._inertOn === onFlag) return;
    this._inertOn = onFlag;
    if ('inert' in HTMLElement.prototype) appEl.inert = onFlag;
    // Lets the stylesheet move toasts out of the way of bottom sheets (phones).
    document.documentElement.classList.toggle('mm-modal-open', !!onFlag);
  }

  _enableSwipeDown(handle) {
    const grip = handle.titleEl;
    let startY = 0, dy = 0, pid = null, t0 = 0;
    grip.style.touchAction = 'none';
    grip.addEventListener('pointerdown', (e) => {
      if (!handle.dismissible || e.target.closest('button') || !isPhoneLayout()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pid = e.pointerId; startY = e.clientY; dy = 0; t0 = now();
      try { grip.setPointerCapture(pid); } catch (_) { /* ignore */ }
      handle.el.style.transition = 'none';
    });
    grip.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      dy = Math.max(0, e.clientY - startY);
      handle.el.style.transform = dy ? `translateY(${dy}px)` : '';
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      const v = dy / Math.max(1, now() - t0);
      handle.el.style.transition = 'transform .18s ease';
      if (dy > 90 || (dy > 30 && v > 0.6)) {
        handle.el.style.transform = 'translateY(100%)';
        handle.close(handle.cancelValue);
      } else {
        handle.el.style.transform = '';
      }
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------------ Back button / swipe-back
  //
  // Android Back / iOS swipe-back closes the top dialog, menu, trim tool, ribbon sheet, … instead
  // of leaving the app. Every such surface holds a token on _backStack; the i-th token owns the
  // history entry at depth i + 1 above the app's own entry (depth 0). Our entries carry
  // { mmDialog, mmSid, mmDepth }, so where we are is always read from history.state rather than
  // from a count of expected popstate events.
  //
  //  - pushBack() pushes an entry right away (inside the user's tap) when there are fewer entries
  //    than tokens and none of our own traversals is in flight;
  //  - releaseBack() only drops the token. History is reconciled after the current task, so a
  //    surface that closes because the next one opens (menu item → dialog, sheet → dialog) simply
  //    hands its entry over — no history.back() racing a pushState();
  //  - _syncHistory() steps back over surplus entries (only when the current entry is really ours)
  //    and waits for that popstate before pushing anything else;
  //  - popstate: landing below the expected depth means the user pressed Back — the topmost
  //    affected surfaces close; landing on a stale entry of ours (Forward) steps back again.

  /** Let Back close a surface: returns a token for releaseBack(), or null (desktop / no history API). */
  pushBack(fn) { return this._pushBack(fn); }

  /** The surface closed by other means: give its history entry back (no-op after Back fired it). */
  releaseBack(token) { this._releaseBack(token); }

  _pushBack(fn) {
    if (!isCoarse() || !historyUsable()) return null;
    const token = { fn: typeof fn === 'function' ? fn : () => {}, popped: false };
    this._backStack.push(token);
    if (!this._histBusy && this._histDepth < this._backStack.length) {
      this._fillHistory();
      if (this._histDepth < this._backStack.length) {
        // pushState refused (e.g. rate limited): without an entry Back can't be caught.
        this._backStack.splice(this._backStack.indexOf(token), 1);
        token.popped = true;
        return null;
      }
    }
    return token;
  }

  _releaseBack(token) {
    if (!token || token.popped) return;
    token.popped = true;
    const i = this._backStack.indexOf(token);
    if (i < 0) return;
    this._backStack.splice(i, 1);
    this._scheduleHistorySync();
  }

  /** Push entries until there is one per live token. */
  _fillHistory() {
    while (this._histDepth < this._backStack.length) {
      const depth = this._histDepth + 1;
      try { history.pushState({ mmDialog: Date.now(), mmSid: BACK_SID, mmDepth: depth }, ''); } catch (_) { return; }
      this._histDepth = depth;
    }
  }

  _scheduleHistorySync() {
    if (this._histSyncTimer) return;
    this._histSyncTimer = setTimeout(() => { this._histSyncTimer = 0; this._syncHistory(); }, 0);
  }

  _syncHistory() {
    if (this._histBusy || !historyUsable()) return;
    const want = this._backStack.length;
    if (this._histDepth > want) {
      // Never step back from an entry that isn't ours: that would leave Movie Maker.
      const actual = backDepth(history.state);
      if (actual !== this._histDepth) {
        this._histDepth = actual;
        if (actual <= want) { this._fillHistory(); return; }
      }
      const n = this._histDepth - want;
      this._histBusy = true;
      this._histTarget = want;
      try { history.go(-n); } catch (_) { this._histBusy = false; return; }
      // Should the traversal never be reported, don't wait forever: trust history.state.
      clearTimeout(this._histBusyTimer);
      this._histBusyTimer = setTimeout(() => {
        if (!this._histBusy) return;
        this._histBusy = false;
        this._histDepth = backDepth(history.state);
        this._syncHistory();
      }, 2500);
    } else if (this._histDepth < want) {
      this._fillHistory();
      // Tokens that still have no entry (pushState refused) can't be reached by Back.
      while (this._backStack.length > this._histDepth) { const t = this._backStack.pop(); t.popped = true; }
    }
  }

  _onPop(e) {
    const depth = backDepth(e && 'state' in e ? e.state : history.state);
    // Where we expected to be: the target of our own step back (anything below it is an extra
    // Back by the user), else the entry we were on.
    const from = this._histBusy ? this._histTarget : this._histDepth;
    if (this._histBusy) { this._histBusy = false; clearTimeout(this._histBusyTimer); }
    this._histDepth = depth;
    if (depth < from) {
      // The entries at depths depth+1 … from were popped: close the surfaces that own them,
      // topmost first (like pressing Escape repeatedly). A token released a moment ago (its
      // entry not yet given back) is no longer on the stack, so nothing else closes by mistake.
      const tokens = this._backStack.splice(depth, from - depth).reverse();
      for (const token of tokens) {
        token.popped = true;
        try { token.fn(); } catch (err) { console.error(err); }
      }
    }
    // Re-push for surfaces still open (busy dialogs, ones opened while we were stepping back), or
    // step back off a stale entry the user moved forward onto.
    this._syncHistory();
  }

  _onKey(e) {
    const top = this._top();
    if (top) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopPropagation();
        if (top.onEscape) top.onEscape();
        else if (top.dismissible) top.close(top.cancelValue);
        return;
      }
      if (e.key === 'Tab') { this._trapTab(e, top.el); return; }
      if (e.key === 'Enter' && !e.isComposing && top.primaryBtn && !top.primaryBtn.disabled
        && e.target && e.target.tagName === 'INPUT' && isTextField(e.target) && top.el.contains(e.target)) {
        e.preventDefault();
        top.primaryBtn.click();
      }
      return;
    }
    if (this._menu) { this._menuKey(e); return; }
    if (this._trim) this._trimKey(e);
  }

  _trapTab(e, container) {
    const list = focusables(container);
    if (!list.length) { e.preventDefault(); focusEl(container); return; }
    const first = list[0], last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); focusEl(last); }
    else if (!e.shiftKey && (active === last || !container.contains(active))) { e.preventDefault(); focusEl(first); }
  }

  // ------------------------------------------------------------------ public dialog API

  /** Generic dialog: resolves with the clicked button's value (cancelValue/null when dismissed). */
  open(opts = {}) {
    const handle = this._create(opts);
    const p = handle.promise;
    p.close = handle.close;
    p.el = handle.el;
    p.handle = handle;
    return p;
  }

  /** OK / Cancel question. Resolves true / false. */
  confirm(msg, opts = {}) {
    const body = h('div', { class: 'mmd-dlg-msg' }, icon(opts.danger ? 'warning' : 'help', 32),
      h('div', null, ...(String(msg || '').split('\n\n').map((t) => h('p', null, t)))));
    const handle = this._create({
      title: opts.title || 'Movie Maker', body, size: 'narrow', cancelValue: false,
      buttons: [
        { label: opts.okLabel || 'OK', value: true, primary: true, danger: !!opts.danger },
        { label: opts.cancelLabel || 'Cancel', value: false },
      ],
    });
    if (!isCoarse()) {
      // Destructive questions start on Cancel so Enter can't delete by accident.
      const btns = handle.buttonsEl.querySelectorAll('.btn');
      const target = opts.danger ? btns[btns.length - 1] : handle.primaryBtn;
      if (target) requestAnimationFrame(() => { if (!handle.closed) focusEl(target); });
    }
    return handle.promise.then((v) => v === true);
  }

  /**
   * Ask for a line of text. Resolves the trimmed text, or null when canceled.
   * opts.multiline: a <textarea> where Return adds a new line (titles, captions, credits);
   * Ctrl/⌘+Enter or OK finishes. Lines keep their inner spaces; only the ends are trimmed.
   */
  promptText(title, value = '', opts = {}) {
    const inputId = domId('prompt');
    const multiline = !!opts.multiline;
    const text = value == null ? '' : String(value);
    const input = multiline
      ? h('textarea', {
        id: inputId, rows: String(Math.min(8, Math.max(3, text.split('\n').length + 1))), autocomplete: 'off',
        spellcheck: 'true', maxlength: String(opts.maxLength || 2000), enterkeyhint: 'enter',
      })
      : h('input', {
        type: 'text', id: inputId, value: text, autocomplete: 'off',
        spellcheck: 'false', maxlength: String(opts.maxLength || 120), enterkeyhint: 'done',
      });
    if (multiline) input.value = text;
    const body = h('div', { class: ['mmd-prompt field', multiline ? 'mmd-prompt-multi' : ''] },
      h('label', { for: inputId }, opts.label || title || 'Name'), input,
      opts.hint ? h('div', { class: 'hint' }, opts.hint)
        : multiline && !isCoarse() ? h('div', { class: 'hint' }, `Press Enter for a new line, ${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl'}+Enter to finish.`) : null);
    const finish = (hd) => { hd.close(input.value.trim()); };
    const handle = this._create({
      title: title || 'Movie Maker', body, size: 'narrow', initialFocus: input,
      buttons: [
        { label: opts.okLabel || 'OK', primary: true, onClick: (hd) => { finish(hd); return false; } },
        { label: 'Cancel', value: null },
      ],
    });
    if (multiline) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); finish(handle); }
      });
    }
    // Still inside the caller's tap: select now (see _create), and once more after layout should
    // the browser have dropped the selection.
    if (document.activeElement === input) selectAllText(input);
    requestAnimationFrame(() => {
      if (handle.closed || document.activeElement !== input) return;
      if (input.selectionStart === input.selectionEnd) selectAllText(input);
    });
    return handle.promise.then((v) => (typeof v === 'string' ? v : null));
  }

  /** A message with one OK button. type: 'info' | 'error' | 'warning' | 'success'. */
  notify(title, msg, { type = 'info', okLabel = 'OK' } = {}) {
    const iconName = type === 'error' ? 'error' : type === 'warning' ? 'warning' : type === 'success' ? 'check' : 'info';
    const body = h('div', { class: 'mmd-dlg-msg' }, icon(iconName, 32),
      h('div', null, ...(String(msg || '').split('\n\n').map((t) => h('p', null, t)))));
    return this._create({ title: title || 'Movie Maker', body, size: 'narrow', buttons: [{ label: okLabel, value: true, primary: true }] }).promise;
  }

  // ------------------------------------------------------------------ toasts

  /**
   * Show a toast. opts: type 'info'|'success'|'error'|'warning', timeout ms (0 = until closed),
   * action {label, onClick} (button), onClick (tap anywhere on the toast).
   * Returns { close(), el }.
   */
  toast(msg, opts = {}) {
    const type = ['info', 'success', 'error', 'warning'].includes(opts.type) ? opts.type : 'info';
    const text = String(msg == null ? '' : msg);
    const dup = this._toasts.find((t) => t.text === text && t.type === type && !t.closed);
    if (dup) { dup.restart(); return dup.api; }
    const iconName = type === 'error' ? 'error' : type === 'success' ? 'check' : type === 'warning' ? 'warning' : 'info';
    const el = h('div', {
      class: ['toast', `toast-${type === 'warning' ? 'info' : type}`, type === 'warning' ? 'toast-warning' : ''],
      role: type === 'error' ? 'alert' : 'status',
    }, icon(iconName, 18), h('span', { class: 'toast-msg' }, text));
    const action = opts.action && opts.action.label ? opts.action : null;
    if (action) {
      const b = h('button', { type: 'button', class: 'toast-action' }, action.label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        try { if (typeof action.onClick === 'function') action.onClick(); } catch (err) { this._reportError(err); }
      });
      el.appendChild(b);
    }
    const sticky = opts.timeout === 0;
    if (sticky || type === 'error') {
      const x = h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', title: 'Dismiss' }, icon('close', 12));
      x.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      el.appendChild(x);
    }
    if (typeof opts.onClick === 'function') {
      el.style.cursor = 'pointer';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
    }
    el.addEventListener('click', () => {
      if (typeof opts.onClick === 'function') {
        try { opts.onClick(); } catch (err) { this._reportError(err); }
      }
      close();
    });
    el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute('role') === 'button') { e.preventDefault(); el.click(); } });

    const timeout = Number.isFinite(opts.timeout) ? opts.timeout : (type === 'error' ? 7000 : action ? 9000 : 4000);
    let timer = 0;
    let hovering = false;
    const entry = { el, text, type, closed: false, restart: null, api: null };
    const arm = () => { clearTimeout(timer); if (timeout > 0 && !hovering) timer = setTimeout(close, timeout); };
    function close() {
      if (entry.closed) return;
      entry.closed = true;
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, reducedMotion() ? 0 : 200);
    }
    entry.restart = arm;
    entry.api = { close, el };
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hovering = true; clearTimeout(timer); } });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hovering = false; arm(); } });
    this.toastRoot.appendChild(el);
    this._toasts = this._toasts.filter((t) => !t.closed);
    this._toasts.push(entry);
    while (this._toasts.filter((t) => !t.closed).length > 4) {
      const oldest = this._toasts.find((t) => !t.closed);
      if (!oldest) break;
      oldest.api.close();
    }
    arm();
    return entry.api;
  }

  // ------------------------------------------------------------------ progress

  /**
   * Cancelable progress dialog. Shown after `delay` ms (default 150) so quick jobs don't flash.
   * set(p 0..1 | null (indeterminate), text?), close(), signal (aborted by Cancel / Escape).
   */
  progress(title, opts = {}) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const cancelable = opts.cancelable !== false;
    const state = { p: null, text: opts.text || '' };
    const bar = h('div', { class: 'progress-bar' });
    const track = h('div', { class: 'progress is-indeterminate', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
    const textEl = h('div', { class: 'progress-text' }, state.text);
    const body = h('div', { class: 'mmd-progress' }, track, textEl);
    let handle = null;
    let closed = false;
    const apply = () => {
      const p = state.p;
      if (p === null || !Number.isFinite(p)) {
        track.classList.add('is-indeterminate');
        track.removeAttribute('aria-valuenow');
        bar.style.width = '';
      } else {
        const v = clampNum(p, 0, 1);
        track.classList.remove('is-indeterminate');
        track.style.setProperty('--p', String(v));
        bar.style.width = `${(v * 100).toFixed(1)}%`;
        track.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      }
      textEl.textContent = state.text || '';
    };
    const cancel = () => {
      if (closed) return;
      if (ctrl) { try { ctrl.abort(); } catch (_) { /* ignore */ } }
      api.close();
    };
    const show = () => {
      if (closed || handle) return;
      handle = this._create({
        title: title || 'Movie Maker', body, size: 'narrow', dismissible: false, cancelValue: null,
        buttons: cancelable ? [{ label: 'Cancel', onClick: () => { cancel(); return false; } }] : [],
      });
      handle.onEscape = cancelable ? cancel : () => {};
      apply();
    };
    const delay = Number.isFinite(opts.delay) ? opts.delay : 150;
    const timer = delay > 0 ? setTimeout(show, delay) : 0;
    if (delay <= 0) show();
    const api = {
      set(p, text) {
        state.p = p === null || p === undefined ? null : Number(p);
        if (text !== undefined) state.text = text;
        if (handle) apply();
      },
      setTitle(t) { if (handle) handle.setTitle(t); },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (handle) handle.close(null);
      },
      get signal() { return ctrl ? ctrl.signal : undefined; },
      get canceled() { return !!(ctrl && ctrl.signal.aborted); },
    };
    apply();
    return api;
  }

  // ------------------------------------------------------------------ helpers

  _reportError(err, fallback = 'Something went wrong. Please try again.') {
    if (!err || err.name === 'AbortError' || err.handled) return;
    console.error('[Movie Maker]', err);
    this.toast(errorMessage(err, fallback), { type: 'error' });
  }

  _hasCommand(name) {
    const c = this.app && this.app.commands;
    if (!c || typeof c.run !== 'function') return false;
    if (typeof c.list !== 'function') return true;
    try { return c.list().includes(name); } catch (_) { return false; }
  }

  /** Run a command (preferred), else the local fallback. Errors become toasts. */
  _cmd(name, arg, fallback) {
    let p;
    try {
      if (this._hasCommand(name)) p = arg === undefined ? this.app.commands.run(name) : this.app.commands.run(name, arg);
      else if (typeof fallback === 'function') p = fallback();
      else { this.toast('That isn’t available right now. Please reload the page.', { type: 'error' }); return Promise.resolve(); }
    } catch (err) { this._reportError(err); return Promise.resolve(); }
    return Promise.resolve(p).catch((err) => this._reportError(err));
  }

  async _flushAutosave() {
    const a = this.app && this.app.autosave;
    if (a && typeof a.flush === 'function') {
      try { await a.flush(); } catch (_) { /* reported through the store's 'persist' event */ }
    }
  }

  _pausePlayer() {
    const p = this.app && this.app.player;
    try { if (p && p.playing) p.pause(); } catch (_) { /* ignore */ }
  }

  _projectHasContent() {
    const p = this.app.store && this.app.store.project;
    return !!(p && ((p.items && p.items.length) || (p.texts && p.texts.length) || (p.music && p.music.length)));
  }

  _timelineDuration() {
    try { const tl = this.app.store.timeline; return tl && tl.duration > 0 ? tl.duration : 0; } catch (_) { return 0; }
  }

  /**
   * After an explicit save (Save project, Save project as, a finished Save movie): ask the browser
   * to keep our data under storage pressure. This is the only place engines that show a permission
   * prompt for it (Firefox) are asked. Not awaited.
   */
  _askPersistentStorage() {
    const persist = this.app.persist;
    if (!persist || typeof persist.requestPersistentStorage !== 'function') return;
    try { Promise.resolve(persist.requestPersistentStorage({ userAction: true })).catch(() => {}); } catch (_) { /* ignore */ }
  }

  /** Public alias of _offerFile (commands.snapshot's "Save picture" uses it). */
  offerFile(blob, name, message) { return this._offerFile(blob, name, message); }

  /** Offer a generated file: direct download on desktop, a tap-to-save dialog on phones (gesture). */
  async _offerFile(blob, name, message) {
    const dl = exporterMod.downloadBlob;
    if (typeof dl !== 'function') throw new Error('Saving files isn’t available.');
    if (!isCoarse() && !isIOS()) {
      try { await dl(blob, name); this.toast(`“${name}” is downloading.`, { type: 'success' }); return; } catch (_) { /* fall back to the dialog */ }
    }
    await this.open({
      title: 'Movie Maker', size: 'narrow',
      body: h('div', { class: 'mmd-dlg-msg' }, icon('check', 32), h('div', null, h('p', null, message || 'Your file is ready.'),
        h('p', { class: 'mmd-file-line' }, `${name} · ${fmtBytes(blob.size)}`))),
      buttons: [
        { label: isIOS() ? 'Save / Share' : 'Download', primary: true, icon: 'download', onClick: (hd) => { dl(blob, name).then(() => hd.close(true), (err) => this._reportError(err)); return false; } },
        { label: 'Close', value: null },
      ],
    });
  }

  // ------------------------------------------------------------------ projects

  /** Open a saved project (saving the current one first). Resolves true when loaded. */
  async loadProjectById(id, { quiet = false } = {}) {
    const app = this.app, persist = app.persist, store = app.store;
    if (!persist || typeof persist.loadProject !== 'function' || !store) {
      this.toast('Projects can’t be opened right now.', { type: 'error' });
      return false;
    }
    if (app.exporting) { this.toast('Please wait until your movie has finished saving.', { type: 'error' }); return false; }
    if (store.project && store.project.id === id) {
      if (!quiet) this.toast(`“${store.project.name}” is already open.`);
      return true;
    }
    if (this._trim) this._trimFinish(false);
    const prog = this.progress('Opening project', { cancelable: false, delay: 300, text: 'Loading your videos and photos…' });
    try {
      await this._flushAutosave();
      const { project, media } = await persist.loadProject(id);
      this._pausePlayer();
      store.replaceProject(project, media);
      if (typeof persist.setLastProjectId === 'function') await persist.setLastProjectId(project.id);
      prog.close();
      if (!quiet) this.toast(`Opened “${project.name}”.`, { type: 'success', timeout: 2500 });
      return true;
    } catch (err) {
      prog.close();
      this._reportError(err, 'The project couldn’t be opened.');
      return false;
    }
  }

  /** Start a new, empty project (the current one stays saved). */
  async newProject() {
    const app = this.app;
    if (app.exporting) { this.toast('Please wait until your movie has finished saving.', { type: 'error' }); return; }
    if (this._trim) this._trimFinish(false);
    await this._flushAutosave();
    this._pausePlayer();
    app.store.replaceProject(createProject(), new Map());
    if (app.persist && typeof app.persist.setLastProjectId === 'function') await app.persist.setLastProjectId(null);
  }

  /** Save now (projects are also saved automatically). */
  async saveProject() {
    const { persist, store } = this.app;
    if (!persist || typeof persist.saveProject !== 'function') { this.toast('Saving projects isn’t available in this browser.', { type: 'error' }); return false; }
    const prog = this.progress('Saving project', { cancelable: false, delay: 400 });
    try {
      await persist.saveProject(store.project, store.media);
      if (typeof persist.setLastProjectId === 'function') await persist.setLastProjectId(store.project.id);
      prog.close();
      this._askPersistentStorage();
      this.toast('Your project has been saved on this device.', { type: 'success', timeout: 2500 });
      return true;
    } catch (err) {
      prog.close();
      this._reportError(err, 'The project couldn’t be saved.');
      return false;
    }
  }

  /** Save a copy under a new name and continue working on the copy. */
  async saveProjectAs() {
    const { persist, store } = this.app;
    if (!persist || typeof persist.saveProject !== 'function') { this.toast('Saving projects isn’t available in this browser.', { type: 'error' }); return false; }
    const name = await this.promptText('Save project as', `${store.project.name || 'My Movie'}`, { label: 'Project name', okLabel: 'Save' });
    if (name === null) return false;
    const clean = name.trim() || store.project.name || 'My Movie';
    try {
      await this._flushAutosave();
      let copy;
      try { copy = structuredClone(store.project); } catch (_) { copy = JSON.parse(JSON.stringify(store.project)); }
      copy.id = uid('proj');
      copy.name = clean;
      copy.createdAt = Date.now();
      copy.updatedAt = Date.now();
      await persist.saveProject(copy, store.media);
      store.replaceProject(copy, store.media);
      if (typeof persist.setLastProjectId === 'function') await persist.setLastProjectId(copy.id);
      this._askPersistentStorage();
      this.toast(`Saved as “${clean}”.`, { type: 'success', timeout: 2500 });
      return true;
    } catch (err) {
      this._reportError(err, 'The project couldn’t be saved.');
      return false;
    }
  }

  /**
   * Rename a project: the open one (id omitted), or one saved on this device. Asks for the name
   * straight away (inside the user's tap, so phones show the keyboard). Resolves true when renamed.
   */
  async renameProject(id, knownName) {
    const { persist, store } = this.app;
    const cur = store && store.project;
    const isCur = !id || !!(cur && cur.id === id);
    if (isCur && !cur) return false;
    if (isCur && this._trim) { this.toast('Finish trimming first (Save trim or Cancel), then rename the project.'); return false; }
    const oldName = String((isCur ? cur.name : knownName) || 'My Movie');
    const next = await this.promptText('Rename project', oldName, { label: 'Project name', okLabel: 'Rename' });
    if (next === null) return false;
    const name = next.trim();
    if (!name || name === oldName) return false;
    if (isCur) {
      if (store.project !== cur) return false; // another project was opened meanwhile
      store.update((p) => { p.name = name; }, { label: 'Rename project' });
      await this._flushAutosave(); // lists of saved projects show the new name right away
      return true;
    }
    if (!persist || typeof persist.loadProject !== 'function' || typeof persist.saveProject !== 'function') {
      this.toast('Projects can’t be renamed right now.', { type: 'error' });
      return false;
    }
    let loaded = null;
    try {
      loaded = await persist.loadProject(id);
      loaded.project.name = name;
      loaded.project.updatedAt = Date.now();
      await persist.saveProject(loaded.project, loaded.media);
      return true;
    } catch (err) {
      this._reportError(err, 'The project couldn’t be renamed.');
      return false;
    } finally {
      // Loading made object URLs for its media; nothing shows them.
      if (loaded && loaded.media && typeof loaded.media.values === 'function') {
        for (const m of loaded.media.values()) {
          if (m && m.url) { try { URL.revokeObjectURL(m.url); } catch (_) { /* ignore */ } }
        }
      }
    }
  }

  /**
   * Safari's storage policy (it may delete stored projects after a while without use): explain it
   * and offer Export project file. `message` is persist.storageEvictionRisk().message.
   */
  async openStorageAdvice(message) {
    const text = String(message || 'This browser may delete projects stored on this device if you don’t use Movie Maker for a while. Use Export project file to keep a copy.');
    const v = await this.open({
      title: 'Keep your projects safe', size: 'narrow',
      body: h('div', { class: 'mmd-dlg-msg' }, icon('info', 32), h('div', null, h('p', null, text))),
      buttons: [
        { label: 'Export project file', value: 'export', primary: true },
        { label: 'Close', value: null },
      ],
    });
    if (v === 'export') return this.exportProjectFile();
    return false;
  }

  /** Import a .wlmmweb project file (asks for one when no file is given). */
  async importProjectFromFile(file) {
    const { persist, store, media } = this.app;
    if (!persist || typeof persist.importProjectFile !== 'function') { this.toast('Importing projects isn’t available.', { type: 'error' }); return false; }
    if (!file) {
      if (!media || typeof media.pickFiles !== 'function') return false;
      const files = await media.pickFiles('.wlmmweb,application/json', false);
      file = files && files[0];
      if (!file) return false;
    }
    if (this.app.exporting) { this.toast('Please wait until your movie has finished saving.', { type: 'error' }); return false; }
    const prog = this.progress('Importing project', { cancelable: false, delay: 200, text: file.name || '' });
    try {
      await this._flushAutosave();
      const res = await persist.importProjectFile(file, { onProgress: (p) => prog.set(p) });
      if (this._trim) this._trimFinish(false);
      this._pausePlayer();
      store.replaceProject(res.project, res.media);
      if (typeof persist.setLastProjectId === 'function') await persist.setLastProjectId(res.project.id);
      prog.close();
      this.toast(`Imported “${res.project.name}”.`, { type: 'success' });
      return true;
    } catch (err) {
      prog.close();
      this._reportError(err, 'That project file couldn’t be imported.');
      return false;
    }
  }

  /** Export the current project (with its media) as a single .wlmmweb file. */
  async exportProjectFile() {
    const { persist, store } = this.app;
    if (!persist || typeof persist.exportProjectFile !== 'function') { this.toast('Exporting projects isn’t available.', { type: 'error' }); return false; }
    const prog = this.progress('Export project file', { cancelable: false, delay: 0, text: 'Packing your videos, photos and music…' });
    try {
      const blob = await persist.exportProjectFile(store.project, store.media, { onProgress: (p) => prog.set(p) });
      prog.close();
      const name = typeof persist.projectFileName === 'function' ? persist.projectFileName(store.project) : `${safeName(store.project.name)}.wlmmweb`;
      await this._offerFile(blob, name, 'Your project file is ready. Keep it to move this project to another device or browser.');
      return true;
    } catch (err) {
      prog.close();
      this._reportError(err, 'The project file couldn’t be created.');
      return false;
    }
  }

  async _saveSnapshotFile() {
    const ex = this.app.exporter;
    if (!ex || typeof ex.snapshot !== 'function') return;
    const blob = await ex.snapshot();
    await this._offerFile(blob, `${safeName(this.app.store.project.name)} ${fileStamp()}.png`, 'Your snapshot is ready.');
  }

  /** "Open project" dialog: saved projects with thumbnails; open or delete. */
  async openProjects() {
    const { persist, store } = this.app;
    const list = h('div', { class: 'mmd-projects', role: 'list' },
      h('div', { class: 'mmd-loading' }, h('span', { class: 'mmd-spin' }), 'Loading your projects…'));
    const handle = this._create({
      title: 'Open project', size: 'wide', body: list, className: 'mmd-projects-dlg',
      buttons: [
        { label: 'Import project file…', icon: 'folder-open', value: 'import' },
        { label: 'Close', value: null },
      ],
    });
    const render = async () => {
      let projects = [];
      try {
        if (!persist || typeof persist.listProjects !== 'function') throw new Error('Saving projects isn’t available in this browser.');
        projects = await persist.listProjects();
      } catch (err) {
        clear(list).appendChild(h('div', { class: 'mmd-empty mmd-error-text' }, errorMessage(err, 'Your projects couldn’t be listed.')));
        return;
      }
      if (handle.closed) return;
      clear(list);
      if (!projects.length) {
        list.appendChild(h('div', { class: 'mmd-empty' }, 'You don’t have any saved projects yet. Projects are saved on this device automatically as you work.'));
        return;
      }
      const curId = store && store.project && store.project.id;
      for (const p of projects) {
        const isCur = p.id === curId;
        const thumb = h('span', { class: 'mmd-proj-thumb' }, p.thumb ? h('img', { src: p.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : icon('film', 32));
        const meta = [fmtDate(p.updatedAt) ? `Modified ${fmtDate(p.updatedAt)}` : '', Number.isFinite(p.itemCount) ? `${p.itemCount} item${p.itemCount === 1 ? '' : 's'}` : '', isCur ? 'open now' : '']
          .filter(Boolean).join(' · ');
        // An exported project file survives the browser clearing this device's storage (Safari).
        const exported = Number(p.exportedAt) > 0 && fmtDate(p.exportedAt) ? `Last exported ${fmtDate(p.exportedAt)}` : 'Not exported yet';
        const openBtn = h('button', { type: 'button', class: 'mmd-proj-open', 'aria-label': `Open ${p.name}` }, thumb,
          h('span', { class: 'mmd-proj-text' }, h('span', { class: 'mmd-proj-name' }, p.name || 'My Movie'), h('span', { class: 'mmd-proj-meta' }, meta),
            h('span', { class: 'mmd-proj-meta mmd-proj-export' }, exported)));
        openBtn.addEventListener('click', () => handle.close({ open: p.id }));
        const del = h('button', { type: 'button', class: 'btn btn-icon mmd-proj-act mmd-proj-del', 'aria-label': `Delete ${p.name}`, title: 'Delete project' }, icon('trash', 16));
        del.addEventListener('click', async () => {
          const ok = await this.confirm(isCur
            ? `“${p.name}” is open right now. Delete it anyway?\n\nA new, empty project will be started. This can’t be undone.`
            : `Delete “${p.name}”?\n\nThis can’t be undone.`, { title: 'Delete project', okLabel: 'Delete', danger: true });
          if (!ok) return;
          try {
            if (isCur) {
              await this._flushAutosave();
              this._pausePlayer();
              store.replaceProject(createProject(), new Map());
            }
            await persist.deleteProject(p.id);
            this.toast(`“${p.name}” was deleted.`, { timeout: 2500 });
          } catch (err) {
            this._reportError(err, 'The project couldn’t be deleted.');
          }
          if (!handle.closed) render();
        });
        const ren = h('button', { type: 'button', class: 'btn btn-icon mmd-proj-act mmd-proj-ren', 'aria-label': `Rename ${p.name}`, title: 'Rename project' }, icon('edit', 16));
        ren.addEventListener('click', async () => {
          const done = await this.renameProject(p.id, p.name);
          if (done && !handle.closed) render();
        });
        list.appendChild(h('div', { class: ['mmd-proj', isCur ? 'is-current' : ''], role: 'listitem' }, openBtn, ren, del));
      }
    };
    render();
    const result = await handle.promise;
    if (result === 'import') { await this.importProjectFromFile(); return undefined; }
    if (result && typeof result === 'object' && result.open) { await this.loadProjectById(result.open); }
    return undefined;
  }

  // ------------------------------------------------------------------ app menu

  /** The blue "file" menu (toggles). Resolves when it closes. */
  openAppMenu() {
    if (this._menu) { this._closeMenu(); return Promise.resolve(); }
    if (this._stack.length) return Promise.resolve();
    const app = this.app;
    const btn = document.getElementById('app-menu-btn');
    const layer = h('div', { class: 'mmd-menu-layer', role: 'presentation' });
    const head = h('div', { class: 'mmd-menu-head' }, h('img', { src: APP_ICON_URL, alt: '' }), h('span', null, 'Movie Maker'));
    const items = h('div', { class: 'app-menu-items', role: 'menu', 'aria-label': 'Movie Maker menu' });
    const side = h('div', { class: 'app-menu-side', 'aria-live': 'polite' });
    const footer = h('div', { class: 'app-menu-footer' });
    const menu = h('div', { class: 'app-menu mmd-app-menu', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Movie Maker menu' }, head, items, side, footer);
    layer.appendChild(menu);

    let resolveFn;
    const done = new Promise((r) => { resolveFn = r; });
    const m = { layer, menu, items, side, btn, resolve: resolveFn, returnFocus: document.activeElement, sideMode: '', backToken: null };
    this._menu = m;

    const hasContent = this._timelineDuration() > 0;
    const run = (fn) => () => { this._closeMenu(); try { const r = fn(); if (r && r.catch) r.catch((err) => this._reportError(err)); } catch (err) { this._reportError(err); } };
    const entries = [
      { label: 'New project', icon: 'new', run: run(() => this._cmd('newProject', undefined, () => this.newProject())) },
      { label: 'Open project', icon: 'folder-open', run: run(() => this.openProjects()) },
      { label: 'Save project', icon: 'save-project', run: run(() => this._cmd('saveProject', undefined, () => this.saveProject())) },
      { label: 'Save project as', icon: 'save-as', run: run(() => this._cmd('saveProjectAs', undefined, () => this.saveProjectAs())) },
      { label: 'Rename project', icon: 'edit', run: run(() => this.renameProject()) },
      'sep',
      { label: 'Import project file', icon: 'folder-open', run: run(() => this._cmd('importProjectFile', undefined, () => this.importProjectFromFile())) },
      { label: 'Export project file', icon: 'export', run: run(() => this._cmd('exportProjectFile', undefined, () => this.exportProjectFile())) },
      'sep',
      { label: 'Save movie', icon: 'save-movie', sub: 'movie' },
      { label: 'Snapshot', icon: 'snapshot', disabled: !hasContent, run: run(() => this._cmd('snapshot', undefined, () => this._saveSnapshotFile())) },
      'sep',
      app.installPrompt ? { label: 'Install Movie Maker', icon: 'download', run: run(() => this._install()) } : null,
      { label: 'Options', icon: 'settings', run: run(() => this.openOptions()) },
      { label: 'About Movie Maker', icon: 'info', run: run(() => this.openAbout()) },
      { label: 'Help', icon: 'help', run: run(() => this.openHelp()) },
    ];
    let movieItem = null;
    for (const e of entries) {
      if (!e) continue;
      if (e === 'sep') { items.appendChild(h('hr', { class: 'app-menu-sep', role: 'separator' })); continue; }
      const b = h('button', {
        type: 'button', class: ['app-menu-item', e.sub ? 'mmd-has-sub' : ''], role: 'menuitem', disabled: !!e.disabled,
        'aria-haspopup': e.sub ? 'true' : undefined,
      }, icon(e.icon, 32), h('span', { class: 'app-menu-label' }, e.label));
      if (e.sub) {
        movieItem = b;
        let lastPointer = '';
        b.addEventListener('pointerdown', (ev) => { lastPointer = ev.pointerType || ''; });
        b.addEventListener('pointerenter', (ev) => { if (ev.pointerType === 'mouse') this._menuSide('movie'); });
        b.addEventListener('click', () => {
          if (lastPointer === 'mouse') { this._closeMenu(); this.openExport('recommended'); return; }
          this._menuSide('movie');
          const first = side.querySelector('button');
          if (first) {
            focusEl(first);
            if (isPhoneLayout() && typeof side.scrollIntoView === 'function') { try { side.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { /* ignore */ } }
          }
          lastPointer = '';
        });
      } else {
        b.addEventListener('pointerenter', (ev) => { if (ev.pointerType === 'mouse' && m.sideMode !== 'recent') this._menuSide('recent'); });
        b.addEventListener('click', e.run);
      }
      items.appendChild(b);
    }
    m.movieItem = movieItem;

    footer.appendChild(h('span', { class: 'mmd-menu-note' }, 'Your projects are saved on this device.'));
    // (Options is an item in the list above; the footer only closes the menu.)
    const closeBtn = h('button', { type: 'button', class: 'btn' }, 'Close');
    closeBtn.addEventListener('click', () => this._closeMenu());
    footer.append(closeBtn);

    layer.addEventListener('pointerdown', (e) => { m.downOnLayer = e.target === layer; });
    layer.addEventListener('click', (e) => { if (e.target === layer && m.downOnLayer) this._closeMenu(); });

    this.root.appendChild(layer);
    this._setInert(true);
    if (btn) btn.setAttribute('aria-expanded', 'true');
    m.backToken = this._pushBack(() => { if (this._menu === m) this._closeMenu(true); });
    this._menuSide('recent');
    requestAnimationFrame(() => { if (this._menu === m) focusEl(items.querySelector('.app-menu-item:not(:disabled)')); });
    return done;
  }

  _closeMenu(fromBack = false) {
    const m = this._menu;
    if (!m) return;
    this._menu = null;
    if (!fromBack) this._releaseBack(m.backToken);
    if (m.layer.parentNode) m.layer.parentNode.removeChild(m.layer);
    if (m.btn) m.btn.setAttribute('aria-expanded', 'false');
    if (!this._stack.length) this._setInert(false);
    if (m.returnFocus && m.returnFocus.isConnected && m.returnFocus !== document.body && !this._stack.length) focusEl(m.returnFocus);
    m.resolve();
  }

  _menuSide(mode) {
    const m = this._menu;
    if (!m || m.sideMode === mode) return;
    m.sideMode = mode;
    if (m.movieItem) m.movieItem.classList.toggle('is-active', mode === 'movie');
    const side = clear(m.side);
    if (mode === 'movie') {
      side.appendChild(h('div', { class: 'app-menu-heading' }, 'Save movie'));
      const store = this.app.store;
      const formats = typeof exporterMod.supportedFormats === 'function' ? exporterMod.supportedFormats() : [];
      if (!formats.length) {
        side.appendChild(h('div', { class: 'app-menu-empty' }, 'Saving movies isn’t supported in this browser. Please use the latest Chrome, Edge, Firefox or Safari.'));
        return;
      }
      if (!(this._timelineDuration() > 0)) {
        side.appendChild(h('div', { class: 'app-menu-empty' }, 'Add some videos or photos first, then save your movie here.'));
      }
      for (const preset of exporterMod.EXPORT_PRESETS || []) {
        const size = this._presetSize(preset.id, store);
        const perMin = size ? this._estimateBytes(size.width, size.height, 60) : 0;
        const b = h('button', { type: 'button', class: 'app-menu-recent', role: 'menuitem' },
          h('span', { class: 'mmd-recent-name' }, preset.name),
          h('small', null, size ? `${size.width} × ${size.height} · ${fmtEstimate(perMin)} per minute` : ''));
        b.addEventListener('click', () => { this._closeMenu(); this.openExport(preset.id); });
        side.appendChild(b);
      }
      return;
    }
    side.appendChild(h('div', { class: 'app-menu-heading' }, 'Recent projects'));
    const holder = h('div', null, h('div', { class: 'app-menu-empty' }, h('span', { class: 'mmd-spin' }), ' Loading…'));
    side.appendChild(holder);
    const persist = this.app.persist;
    if (!persist || typeof persist.listProjects !== 'function') { clear(holder).appendChild(h('div', { class: 'app-menu-empty' }, 'Saving projects isn’t available.')); return; }
    if (!m.recentP) m.recentP = persist.listProjects();
    m.recentP.then((list) => {
      if (this._menu !== m || m.sideMode !== 'recent') return;
      clear(holder);
      const curId = this.app.store && this.app.store.project && this.app.store.project.id;
      if (!list.length) { holder.appendChild(h('div', { class: 'app-menu-empty' }, 'Projects you work on appear here.')); return; }
      for (const p of list.slice(0, 10)) {
        // Picture + name + date + size, so projects that share a name ("My Movie") can be told apart.
        const meta = [fmtDate(p.updatedAt), Number.isFinite(p.itemCount) && p.itemCount > 0 ? `${p.itemCount} item${p.itemCount === 1 ? '' : 's'}` : '']
          .filter(Boolean).join(' · ');
        const thumb = h('span', { class: 'mmd-recent-thumb', 'aria-hidden': 'true' },
          p.thumb ? h('img', { src: p.thumb, alt: '', decoding: 'async', draggable: 'false' }) : icon('film', 18));
        const b = h('button', { type: 'button', class: ['app-menu-recent', 'mmd-recent', p.id === curId ? 'is-current' : ''], role: 'menuitem' },
          thumb, h('span', { class: 'mmd-recent-text' }, h('span', { class: 'mmd-recent-name' }, p.name || 'My Movie'), h('small', null, meta)));
        b.addEventListener('click', () => { this._closeMenu(); this.loadProjectById(p.id); });
        holder.appendChild(b);
      }
    }, (err) => {
      if (this._menu !== m || m.sideMode !== 'recent') return;
      clear(holder).appendChild(h('div', { class: 'app-menu-empty mmd-error-text' }, errorMessage(err, 'Your projects couldn’t be listed.')));
    });
  }

  _menuKey(e) {
    const m = this._menu;
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); e.stopPropagation(); this._closeMenu(); return; }
    if (e.key === 'Tab') { this._trapTab(e, m.menu); return; }
    const inItems = m.items.contains(document.activeElement);
    const inSide = m.side.contains(document.activeElement);
    const list = inSide ? Array.from(m.side.querySelectorAll('button')) : Array.from(m.items.querySelectorAll('.app-menu-item:not(:disabled)'));
    const idx = list.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = list[(idx + 1) % list.length] || list[0];
    else if (e.key === 'ArrowUp') next = list[(idx - 1 + list.length) % list.length] || list[list.length - 1];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else if (e.key === 'ArrowRight' && inItems) {
      if (document.activeElement === m.movieItem) this._menuSide('movie');
      next = m.side.querySelector('button');
    } else if (e.key === 'ArrowLeft' && inSide) next = m.sideMode === 'movie' ? m.movieItem : m.items.querySelector('.app-menu-item');
    if (next) { e.preventDefault(); focusEl(next); }
  }

  async _install() {
    const ev = this.app.installPrompt;
    if (!ev || typeof ev.prompt !== 'function') {
      this.toast('To install Movie Maker, use your browser’s menu: “Install app” or “Add to Home Screen”.');
      return;
    }
    try {
      ev.prompt();
      const choice = ev.userChoice ? await ev.userChoice : null;
      if (choice && choice.outcome === 'accepted') this.app.installPrompt = null;
    } catch (err) {
      this.toast('To install Movie Maker, use your browser’s menu: “Install app” or “Add to Home Screen”.');
    }
  }

  // ------------------------------------------------------------------ Save movie

  _presetSize(presetId, store) {
    try {
      if (this.app.exporter && typeof this.app.exporter.sizeFor === 'function') return this.app.exporter.sizeFor(presetId);
      if (typeof exporterMod.exportSize === 'function' && store) return exporterMod.exportSize(presetId, store.project, store.media);
    } catch (_) { /* fall through */ }
    const preset = (exporterMod.EXPORT_PRESETS || []).find((p) => p.id === presetId);
    const hgt = preset ? preset.height : 720;
    const aspect = { '16:9': 16 / 9, '4:3': 4 / 3, '9:16': 9 / 16, '1:1': 1 }[store && store.project && store.project.aspect] || 16 / 9;
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    return aspect >= 1 ? { width: even(hgt * aspect), height: even(hgt) } : { width: even(hgt), height: even(hgt / aspect) };
  }

  _estimateBytes(width, height, seconds, fps = 30) {
    const vbps = typeof exporterMod.videoBitrate === 'function'
      ? exporterMod.videoBitrate(width, height, fps)
      : Math.min(12e6, Math.max(400e3, width * height * fps * 0.12));
    return ((vbps + 128000) * seconds) / 8;
  }

  /**
   * WLMM "Save movie": choose settings & file type → real-time recording with a live preview,
   * progress and Cancel → "Your movie has been saved" (Play / Download or Share / Close).
   * Resolves with the movie Blob, or null.
   */
  async openExport(presetId) {
    const app = this.app;
    if (app.exporting || this._exportOpen || (app.exporter && app.exporter.busy)) {
      this.toast('Your movie is already being saved.', { type: 'info' });
      return null;
    }
    this._closeMenu();
    if (this._trim) this._trimFinish(false);
    if (!app.exporter || typeof app.exporter.exportMovie !== 'function' || !app.store) {
      this.toast('Saving movies isn’t available right now. Please reload the page.', { type: 'error' });
      return null;
    }
    const formats = typeof exporterMod.supportedFormats === 'function' ? exporterMod.supportedFormats() : [];
    if (typeof MediaRecorder === 'undefined' || !formats.length) {
      await this.notify('Save movie', 'Saving movies isn’t supported in this browser.\n\nYou can keep editing — your project is saved on this device. To save the movie as a video file, open Movie Maker in the latest Chrome, Edge, Firefox or Safari.', { type: 'error' });
      return null;
    }
    const duration = this._timelineDuration();
    if (!(duration > 0.05)) {
      await this.notify('Save movie', 'Add some videos or photos to your project before saving a movie.', { type: 'info' });
      return null;
    }
    this._pausePlayer();
    const presets = exporterMod.EXPORT_PRESETS || [];
    let preset = presets.some((p) => p.id === presetId) ? presetId : (presets.some((p) => p.id === lsGet('export:preset')) ? lsGet('export:preset') : 'recommended');
    let format = formats.find((f) => f.mime === lsGet('export:mime')) || formats[0];
    const store = app.store;
    const project = store.project;
    const phone = isCoarse() || isPhoneLayout();
    const groupName = domId('preset');
    const pickerSupported = typeof window.showSaveFilePicker === 'function' && !isCoarse() && window.top === window.self;

    this._exportOpen = true;
    let resultUrl = '';
    let mirrorRaf = 0;
    const handle = this._create({
      title: 'Save movie', size: 'wide', className: 'mmd-export-dlg', cancelValue: null,
      onClose: () => {
        this._exportOpen = false;
        if (mirrorRaf) cancelAnimationFrame(mirrorRaf);
        mirrorRaf = 0;
        if (resultUrl) { const u = resultUrl; resultUrl = ''; setTimeout(() => { try { URL.revokeObjectURL(u); } catch (_) { /* ignore */ } }, 1000); }
      },
    });

    // ---- settings view
    const showSettings = () => {
      handle.setTitle('Save movie');
      handle.setDismissible(true);
      handle.onEscape = null;
      const list = h('div', { class: 'mmd-presets', role: 'radiogroup', 'aria-label': 'Movie settings' });
      const rows = [];
      const summary = h('div', { class: 'mmd-export-summary' });
      const updateSummary = () => {
        const size = this._presetSize(preset, store);
        summary.textContent = '';
        summary.append('Movie length ', h('b', null, formatTime(duration)), ' · ', `${size.width} × ${size.height}`, ' · Estimated file size ',
          h('b', null, fmtEstimate(this._estimateBytes(size.width, size.height, duration))));
        for (const r of rows) r.row.classList.toggle('is-checked', r.input.checked);
      };
      for (const p of presets) {
        const size = this._presetSize(p.id, store);
        const input = h('input', { type: 'radio', name: groupName, value: p.id, checked: p.id === preset });
        const row = h('label', { class: 'mmd-preset' }, input, h('span', { class: 'mmd-preset-text' },
          h('span', null, p.name), h('small', null, `${size.width} × ${size.height} · ${fmtEstimate(this._estimateBytes(size.width, size.height, duration))}`)));
        input.addEventListener('change', () => { if (input.checked) { preset = p.id; lsSet('export:preset', preset); updateSummary(); } });
        rows.push({ row, input });
        list.appendChild(row);
      }
      const selId = domId('fmt');
      const select = h('select', { id: selId });
      for (const f of formats) select.appendChild(h('option', { value: f.mime, selected: f.mime === format.mime }, f.label || f.ext.toUpperCase()));
      select.addEventListener('change', () => { format = formats.find((f) => f.mime === select.value) || formats[0]; lsSet('export:mime', format.mime); });
      const note = phone
        ? `Keep this screen on and Movie Maker open until it finishes. Your movie is recorded in real time, so saving takes about as long as the movie plays (${fmtClock(duration)}).`
        : `Keep this tab open and visible until it finishes. Your movie is recorded in real time, so saving takes about as long as the movie plays (${fmtClock(duration)}).`;
      handle.setBody(h('div', null,
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Choose how your movie will be saved'), list),
        h('div', { class: 'field' }, h('label', { for: selId }, 'File type'), select),
        summary,
        h('p', { class: 'hint' }, note)));
      updateSummary();
      handle.setButtons([
        { label: 'Cancel', value: null },
        { label: 'Save', primary: true, icon: 'save-movie', onClick: () => { startExport(); return false; } },
      ]);
      if (!isCoarse()) requestAnimationFrame(() => { const c = list.querySelector('input:checked'); if (c) focusEl(c); });
    };

    // ---- export run
    const startExport = () => {
      const fmt = format;
      const ext = fmt.ext || extForMime(fmt.mime);
      const fileName = typeof exporterMod.movieFileName === 'function' ? exporterMod.movieFileName(project, ext) : `${safeName(project.name)}.${ext}`;
      if (pickerSupported) {
        // Desktop Chromium: ask where to save first, like Windows Live Movie Maker did.
        let picked;
        try {
          picked = window.showSaveFilePicker({
            suggestedName: fileName,
            types: [{ description: fmt.label || 'Video file', accept: { [baseMime(fmt.mime) || 'video/webm']: [`.${ext}`] } }],
          });
        } catch (err) { picked = Promise.reject(err); }
        picked.then((fh) => run(fmt, fileName, fh), (err) => {
          if (err && err.name === 'AbortError') return; // stay on the settings
          run(fmt, fileName, null);
        });
        return;
      }
      run(fmt, fileName, null);
    };

    const run = (fmt, fileName, fileHandle) => {
      if (handle.closed) return;
      const ctrl = new AbortController();
      const size = this._presetSize(preset, store);
      const aspect = size.width / size.height;
      handle.setTitle('Saving movie');
      handle.setDismissible(false);
      const canvas = h('canvas', { width: '2', height: '2', 'aria-hidden': 'true' });
      const screenW = phone ? Math.min(window.innerWidth - 40, 360) : 360;
      // Short screens (phones in landscape): leave room for the progress, times and Cancel.
      const maxScreenH = Math.max(80, Math.min(aspect >= 1 ? 360 : 220, (window.innerHeight || 600) - 290));
      const sw = Math.max(120, Math.min(screenW, maxScreenH * aspect));
      const screen = h('div', { class: 'mmd-export-screen', style: { width: `${Math.round(sw)}px`, height: `${Math.round(sw / aspect)}px` } }, canvas);
      const bar = h('div', { class: 'progress-bar' });
      const track = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Saving progress' }, bar);
      const pct = h('div', { class: 'mmd-export-pct' }, 'Getting ready…');
      const elapsedEl = h('span', null, 'Elapsed 00:00');
      const remainEl = h('span', null, `Remaining about ${fmtClock(duration)}`);
      const msgEl = h('div', { class: 'mmd-export-msg', role: 'status' });
      handle.setBody(h('div', { class: 'mmd-export-live' }, screen, pct, track, h('div', { class: 'mmd-export-stats' }, elapsedEl, remainEl), msgEl,
        h('p', { class: 'hint' }, phone ? 'Keep this screen on until it finishes.' : 'Keep this tab open until it finishes.')));
      let cancelBtn = null;
      const cancel = () => {
        if (ctrl.signal.aborted) return;
        ctrl.abort();
        if (cancelBtn) cancelBtn.disabled = true;
        pct.textContent = 'Canceling…';
      };
      // Cancel sits where Save was: ignore the second click of a double-click on Save.
      const armedAt = now() + 700;
      handle.setButtons([{ label: 'Cancel', onClick: () => { if (now() >= armedAt) cancel(); return false; }, ref: (b) => { cancelBtn = b; } }]);
      handle.onEscape = cancel;

      // Live mirror of the export canvas (every other frame, no allocations per frame).
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(2, Math.round(sw * dpr));
      canvas.height = Math.max(2, Math.round((sw / aspect) * dpr));
      const mctx = canvas.getContext('2d');
      if (mctx) { mctx.fillStyle = '#000'; mctx.fillRect(0, 0, canvas.width, canvas.height); }
      let tick = 0;
      const player = app.player;
      const mirror = () => {
        mirrorRaf = requestAnimationFrame(mirror);
        if ((++tick & 1) || !mctx || !player) return;
        const src = player.output;
        if (!src || src === player.canvas || !(src.width > 2)) return;
        try { mctx.drawImage(src, 0, 0, canvas.width, canvas.height); } catch (_) { /* not ready */ }
      };
      mirrorRaf = requestAnimationFrame(mirror);

      const started = now();
      let lastP = 0;
      let transientMsg = false;
      let soundWarning = '';
      const onProgress = (p, t, info) => {
        if (handle.closed) return;
        lastP = p;
        const state = info && info.state;
        track.style.setProperty('--p', String(p));
        bar.style.width = `${(p * 100).toFixed(1)}%`;
        track.setAttribute('aria-valuenow', String(Math.round(p * 100)));
        if (state === 'preparing') pct.textContent = 'Getting ready…';
        else if (state === 'finalizing' || state === 'done') pct.textContent = 'Finishing…';
        else if (!ctrl.signal.aborted) pct.textContent = `Saving movie: ${Math.floor(p * 100)}%`;
        const el = (now() - started) / 1000;
        elapsedEl.textContent = `Elapsed ${fmtClock(el)}`;
        const tt = Number.isFinite(t) ? t : p * duration;
        remainEl.textContent = state === 'finalizing' || state === 'done' ? 'Almost done' : `Remaining about ${fmtClock(Math.max(0, duration - tt))}`;
        const msg = info && typeof info.message === 'string' ? info.message.trim() : '';
        if (msg) {
          msgEl.textContent = msg;
          // "Preparing the sound…" only matters until recording starts; warnings stay up.
          transientMsg = state === 'preparing';
          if (state === 'warning') soundWarning = msg;
        } else if (transientMsg && (state === 'preparing' || state === 'recording')) {
          // A blank 'preparing' message, or recording starting, clears the preparing note.
          msgEl.textContent = soundWarning;
          transientMsg = false;
        } else if (state === 'resumed') {
          msgEl.textContent = soundWarning;
        }
      };

      app.exporting = true;
      let promise;
      try {
        promise = app.exporter.exportMovie({ presetId: preset, mime: fmt.mime, fps: 30, onProgress, signal: ctrl.signal });
      } catch (err) { promise = Promise.reject(err); }
      Promise.resolve(promise).then(async (blob) => {
        app.exporting = false;
        if (mirrorRaf) { cancelAnimationFrame(mirrorRaf); mirrorRaf = 0; }
        if (handle.closed) return;
        let savedTo = '';
        if (fileHandle) {
          pct.textContent = 'Writing the file…';
          try {
            const w = await fileHandle.createWritable();
            await w.write(blob);
            await w.close();
            savedTo = fileHandle.name || fileName;
          } catch (err) {
            console.warn('Movie Maker: could not write the chosen file.', err);
            savedTo = '';
          }
        }
        showSaved(blob, savedTo ? savedTo : fileName, !!savedTo, size, soundWarning);
        this._askPersistentStorage();
      }, (err) => {
        app.exporting = false;
        if (mirrorRaf) { cancelAnimationFrame(mirrorRaf); mirrorRaf = 0; }
        if (handle.closed) return;
        if ((err && (err.name === 'AbortError' || err.code === 'aborted')) || ctrl.signal.aborted) {
          handle.close(null);
          this.toast('Saving the movie was canceled.');
          return;
        }
        console.warn('[Movie Maker] export failed', err);
        showError(err, lastP);
      });
    };

    // ---- result views
    const showSaved = (blob, fileName, writtenToDisk, size, warning = '') => {
      handle.setTitle('Movie Maker');
      handle.setDismissible(true);
      handle.onEscape = null;
      if (resultUrl) { try { URL.revokeObjectURL(resultUrl); } catch (_) { /* ignore */ } }
      resultUrl = URL.createObjectURL(blob);
      const video = h('video', { controls: true, playsinline: true, preload: 'metadata', hidden: true, src: resultUrl });
      video.setAttribute('playsinline', '');
      handle.setBody(h('div', { class: 'mmd-saved' },
        h('div', { class: 'mmd-dlg-msg' }, icon('check', 32), h('div', null,
          h('p', null, 'Your movie has been saved.'),
          h('p', { class: 'mmd-file-line' }, `${fileName} · ${size.width} × ${size.height} · ${fmtBytes(blob.size)}`),
          warning ? h('p', { class: 'mmd-export-warning', role: 'note' }, icon('warning', 14), ' ', warning) : null,
          writtenToDisk ? null : h('p', { class: 'hint' }, isIOS()
            ? 'Tap Save / Share, then choose “Save Video” to keep it in Photos, or “Save to Files”.'
            : phone ? 'Tap Save to device to put the file in your downloads or gallery.' : 'Click Download to put the file on your computer.'))),
        video));
      const file = makeFile(blob, fileName);
      let canShare = false;
      try { canShare = !isIOS() && isCoarse() && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }); } catch (_) { canShare = false; }
      const dl = exporterMod.downloadBlob;
      const buttons = [
        { label: 'Play', icon: 'play', onClick: () => { video.hidden = false; this._pausePlayer(); const p = video.play(); if (p && p.catch) p.catch(() => {}); return false; } },
      ];
      if (!writtenToDisk && typeof dl === 'function') {
        buttons.push({
          label: isIOS() ? 'Save / Share' : phone ? 'Save to device' : 'Download', icon: 'download', primary: true, className: 'mmd-btn-wide',
          onClick: () => {
            dl(blob, fileName).then((res) => {
              if (res === 'downloaded') this.toast(phone ? 'Your movie is being saved to your downloads.' : `“${fileName}” is downloading.`, { type: 'success' });
              else if (res === 'shared') this.toast('Your movie was shared.', { type: 'success' });
            }, (err) => this._reportError(err, 'The movie file couldn’t be saved.'));
            return false;
          },
        });
      }
      if (canShare) {
        buttons.push({
          label: 'Share', icon: 'share',
          onClick: () => {
            navigator.share({ files: [file], title: project.name || 'My Movie' }).catch((err) => {
              if (err && err.name !== 'AbortError') this.toast('The movie couldn’t be shared. Use Save to device instead.', { type: 'error' });
            });
            return false;
          },
        });
      }
      buttons.push({ label: 'Close', value: blob, primary: writtenToDisk });
      handle.setButtons(buttons);
      handle.cancelValue = blob;
    };

    const showError = (err, p) => {
      handle.setTitle('Movie Maker');
      handle.setDismissible(true);
      handle.onEscape = null;
      const msg = errorMessage(err, 'Something went wrong while saving your movie.');
      handle.setBody(h('div', { class: 'mmd-dlg-msg' }, icon('error', 32), h('div', null,
        h('p', null, 'Your movie couldn’t be saved.'),
        h('p', { class: 'mmd-error-text' }, msg),
        h('p', { class: 'hint' }, p > 0.02
          ? 'Tips: choose a lower resolution such as “For email”, close other apps and tabs, and keep Movie Maker on screen while it saves.'
          : 'Tips: try another file type or a lower resolution, or update your browser.'))));
      handle.setButtons([
        { label: 'Try again', primary: true, onClick: () => { showSettings(); return false; } },
        { label: 'Close', value: null },
      ]);
    };

    showSettings();
    return handle.promise.then((v) => (v instanceof Blob ? v : null));
  }

  // ------------------------------------------------------------------ webcam

  /** Record a webcam video. Resolves a File ("Webcam video <date>.webm|mp4") or null. */
  async openWebcam() {
    this._closeMenu();
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md || typeof md.getUserMedia !== 'function') {
      await this.notify('Webcam video', window.isSecureContext === false
        ? 'The webcam can only be used when Movie Maker is opened over a secure (https) connection.'
        : 'This browser doesn’t let web pages use the webcam. Please try the latest Chrome, Edge, Firefox or Safari.', { type: 'error' });
      return null;
    }
    if (typeof MediaRecorder === 'undefined') {
      await this.notify('Webcam video', 'This browser can’t record video. Please use the latest Chrome, Edge, Firefox or Safari.', { type: 'error' });
      return null;
    }
    this._pausePlayer();

    const live = h('video', { class: 'mmd-cam-live', autoplay: true, muted: true, playsinline: true, 'aria-label': 'Webcam preview' });
    live.muted = true;
    live.setAttribute('playsinline', '');
    live.setAttribute('muted', '');
    const review = h('video', { class: 'mmd-cam-review', controls: true, playsinline: true, preload: 'metadata', hidden: true, 'aria-label': 'Recorded video' });
    review.setAttribute('playsinline', '');
    const msg = h('div', { class: 'mmd-cam-msg' }, h('span', { class: 'mmd-spin' }), h('span', null, 'Starting webcam…'));
    const recBadge = h('div', { class: 'mmd-cam-rec', hidden: true }, h('span', { class: 'mmd-rec-dot' }), h('span', null, 'REC'));
    const stage = h('div', { class: 'mmd-cam-stage' }, live, review, msg, recBadge);
    const timeEl = h('span', { class: 'mmd-cam-time', 'aria-live': 'off' }, '00:00');
    const recBtn = h('button', { type: 'button', class: 'mmd-rec-btn', 'aria-label': 'Start recording', title: 'Start recording', disabled: true }, h('span', { class: 'mmd-rec-shape' }));
    const switchBtn = h('button', { type: 'button', class: 'btn mmd-cam-switch', hidden: true, title: 'Switch camera' }, icon('webcam', 16), h('span', null, 'Switch'));
    const bar = h('div', { class: 'mmd-cam-bar' }, switchBtn, recBtn, timeEl);

    let stream = null, recorder = null, chunks = [], blob = null, reviewUrl = '', timer = 0, recStart = 0, recSecs = 0;
    let facing = 'user';
    let state = 'starting';
    let starting = 0;
    let canSwitch = false;

    const cleanup = () => {
      clearInterval(timer);
      timer = 0;
      document.removeEventListener('visibilitychange', onVis);
      if (recorder && recorder.state !== 'inactive') { recorder.ondataavailable = null; recorder.onstop = null; try { recorder.stop(); } catch (_) { /* ignore */ } }
      recorder = null;
      stopStream(stream);
      stream = null;
      try { live.srcObject = null; } catch (_) { /* ignore */ }
      if (reviewUrl) { try { URL.revokeObjectURL(reviewUrl); } catch (_) { /* ignore */ } reviewUrl = ''; }
      chunks = [];
    };
    const handle = this._create({
      title: 'Webcam video', className: 'mmd-cam-dlg', body: h('div', { class: 'mmd-cam' }, stage, bar),
      buttons: [{ label: 'Cancel', value: null }], cancelValue: null, onClose: cleanup,
    });

    const showMsg = (text, isError) => {
      clear(msg);
      if (!isError) msg.appendChild(h('span', { class: 'mmd-spin' }));
      msg.appendChild(h('span', null, text));
      msg.classList.toggle('is-error', !!isError);
      msg.hidden = false;
    };
    const setLiveButtons = () => handle.setButtons([{ label: 'Cancel', value: null }]);

    const startStream = async () => {
      const token = ++starting;
      state = 'starting';
      recBtn.disabled = true;
      showMsg('Starting webcam…');
      stopStream(stream);
      stream = null;
      const audio = { echoCancellation: true, noiseSuppression: true };
      const attempts = [
        { video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio },
        { video: { facingMode: { ideal: facing } }, audio: true },
        { video: true, audio: true },
        { video: { facingMode: { ideal: facing } }, audio: false },
      ];
      let lastErr = null;
      let s = null;
      for (const c of attempts) {
        try { s = await md.getUserMedia(c); break; } catch (err) {
          lastErr = err;
          if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(err && err.name)) break;
        }
      }
      if (token !== starting || handle.closed) { stopStream(s); return; }
      if (!s) { state = 'error'; showMsg(deviceErrorMessage(lastErr, 'camera'), true); return; }
      stream = s;
      if (!s.getAudioTracks().length) this.toast('No microphone was found, so the video will be recorded without sound.');
      const vt = s.getVideoTracks()[0];
      let mode = facing;
      try { const st = vt && typeof vt.getSettings === 'function' ? vt.getSettings() : null; if (st && st.facingMode) mode = st.facingMode; } catch (_) { /* ignore */ }
      live.classList.toggle('is-mirrored', mode !== 'environment');
      live.srcObject = s;
      try { await live.play(); } catch (_) { /* autoplay muted normally works */ }
      if (token !== starting || handle.closed) return;
      msg.hidden = true;
      state = 'live';
      recBtn.disabled = false;
      try {
        const devs = typeof md.enumerateDevices === 'function' ? await md.enumerateDevices() : [];
        const cams = devs.filter((d) => d.kind === 'videoinput').length;
        canSwitch = cams > 1 || (cams === 0 && isCoarse());
      } catch (_) { canSwitch = isCoarse(); }
      if (state === 'live') switchBtn.hidden = !canSwitch;
    };

    const tick = () => {
      recSecs = (now() - recStart) / 1000;
      timeEl.textContent = fmtClock(recSecs);
    };

    const startRec = () => {
      if (!stream || state !== 'live') return;
      chunks = [];
      const type = pickRecorderType(isAppleWebKit() ? CAM_TYPES_APPLE : CAM_TYPES);
      try {
        recorder = type ? new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2500000 }) : new MediaRecorder(stream);
      } catch (_) {
        try { recorder = new MediaRecorder(stream); } catch (err) {
          showMsg('This browser couldn’t start recording. Please try again.', true);
          return;
        }
      }
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { if (state === 'recording') { this.toast('Recording stopped unexpectedly.', { type: 'error' }); stopRec(); } };
      recorder.onstop = () => { onStopped(); };
      try { recorder.start(1000); } catch (err) { showMsg('This browser couldn’t start recording. Please try again.', true); return; }
      state = 'recording';
      recStart = now();
      recSecs = 0;
      timeEl.textContent = '00:00';
      recBadge.hidden = false;
      recBtn.classList.add('is-recording');
      recBtn.setAttribute('aria-label', 'Stop recording');
      recBtn.title = 'Stop recording';
      switchBtn.disabled = true;
      timer = setInterval(tick, 250);
    };

    const stopRec = () => {
      if (state !== 'recording') return;
      state = 'stopping';
      clearInterval(timer);
      timer = 0;
      tick();
      recBtn.disabled = true;
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); else onStopped(); } catch (_) { onStopped(); }
    };

    const onStopped = async () => {
      if (handle.closed) return;
      const type = baseMime((recorder && recorder.mimeType) || (chunks[0] && chunks[0].type) || 'video/webm') || 'video/webm';
      let b = new Blob(chunks, { type });
      chunks = [];
      recBadge.hidden = true;
      recBtn.classList.remove('is-recording');
      recBtn.setAttribute('aria-label', 'Start recording');
      recBtn.title = 'Start recording';
      switchBtn.disabled = false;
      if (!b.size) {
        this.toast('Nothing was recorded. Please try again.', { type: 'error' });
        state = 'live';
        recBtn.disabled = false;
        return;
      }
      if (/webm/.test(type) && typeof exporterMod.fixWebmDuration === 'function') {
        try { b = await exporterMod.fixWebmDuration(b, recSecs); } catch (_) { /* keep as is */ }
      }
      if (handle.closed) return;
      blob = b;
      showReview();
    };

    const showReview = () => {
      state = 'review';
      if (reviewUrl) { try { URL.revokeObjectURL(reviewUrl); } catch (_) { /* ignore */ } }
      reviewUrl = URL.createObjectURL(blob);
      review.src = reviewUrl;
      review.hidden = false;
      live.hidden = true;
      recBtn.hidden = true;
      switchBtn.hidden = true;
      timeEl.textContent = `Length ${fmtClock(recSecs)}`;
      handle.setButtons([
        { label: 'Retake', onClick: () => { retake(); return false; } },
        { label: 'Cancel', value: null },
        {
          label: 'Use video', primary: true,
          onClick: (hd) => {
            const ext = extForMime(blob.type, 'video');
            hd.close(makeFile(blob, `Webcam video ${fileStamp()}.${ext}`));
            return false;
          },
        },
      ]);
    };

    const retake = () => {
      try { review.pause(); } catch (_) { /* ignore */ }
      review.removeAttribute('src');
      try { review.load(); } catch (_) { /* ignore */ }
      if (reviewUrl) { try { URL.revokeObjectURL(reviewUrl); } catch (_) { /* ignore */ } reviewUrl = ''; }
      blob = null;
      review.hidden = true;
      live.hidden = false;
      recBtn.hidden = false;
      timeEl.textContent = '00:00';
      setLiveButtons();
      const alive = stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
      if (alive) { state = 'live'; recBtn.disabled = false; switchBtn.hidden = !canSwitch; } else startStream();
    };

    const onVis = () => { if (document.hidden && state === 'recording') stopRec(); };
    document.addEventListener('visibilitychange', onVis);
    recBtn.addEventListener('click', () => { if (state === 'live') startRec(); else if (state === 'recording') stopRec(); });
    switchBtn.addEventListener('click', () => {
      if (state !== 'live' && state !== 'error') return;
      facing = facing === 'user' ? 'environment' : 'user';
      startStream();
    });

    startStream();
    const result = await handle.promise;
    return result && typeof result === 'object' && typeof result.size === 'number' ? result : null;
  }

  // ------------------------------------------------------------------ narration

  /**
   * Record narration from the microphone (optionally while the movie plays from the playhead,
   * like WLMM). Resolves a File ("Narration <n>.webm|m4a|ogg") or null. The playhead is put back
   * where recording started, so the narration can be inserted there.
   */
  async openNarration() {
    this._closeMenu();
    const app = this.app;
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md || typeof md.getUserMedia !== 'function') {
      await this.notify('Record narration', window.isSecureContext === false
        ? 'The microphone can only be used when Movie Maker is opened over a secure (https) connection.'
        : 'This browser doesn’t let web pages use the microphone. Please try the latest Chrome, Edge, Firefox or Safari.', { type: 'error' });
      return null;
    }
    if (typeof MediaRecorder === 'undefined') {
      await this.notify('Record narration', 'This browser can’t record sound. Please use the latest Chrome, Edge, Firefox or Safari.', { type: 'error' });
      return null;
    }
    // Created inside the click that opened us, so iOS lets it run (level meter only; never audible).
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let meterCtx = null;
    try { meterCtx = Ctx ? new Ctx() : null; if (meterCtx && meterCtx.state === 'suspended') meterCtx.resume().catch(() => {}); } catch (_) { meterCtx = null; }
    this._pausePlayer();
    const player = app.player || null;
    const startAt = player ? player.currentTime : 0;
    const music = (app.store && app.store.project && app.store.project.music) || [];
    const n = music.filter((m) => m && m.kind === 'narration').length + 1;
    const hasMovie = this._timelineDuration() > 0;

    const statusEl = h('div', { class: 'mmd-narr-status' }, 'Starting microphone…');
    const fill = h('div', { class: 'mmd-meter-fill' });
    const peak = h('div', { class: 'mmd-meter-peak' });
    const meter = h('div', { class: 'mmd-meter', role: 'meter', 'aria-label': 'Microphone level', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill, peak);
    const timeEl = h('span', { class: 'mmd-cam-time' }, '00:00');
    const recBtn = h('button', { type: 'button', class: 'mmd-rec-btn', 'aria-label': 'Start recording', title: 'Start recording', disabled: true }, h('span', { class: 'mmd-rec-shape' }));
    const playAlong = h('input', { type: 'checkbox', checked: hasMovie, disabled: !hasMovie });
    const muteMovie = h('input', { type: 'checkbox', checked: true, disabled: !hasMovie });
    const review = h('audio', { controls: true, preload: 'metadata', hidden: true });
    const where = h('p', { class: 'hint' }, `Your narration will start at ${formatTime(startAt)} in the movie.`);
    const body = h('div', { class: 'mmd-narr' },
      h('div', { class: 'mmd-narr-top' }, icon('narration', 32), statusEl),
      meter,
      h('div', { class: 'mmd-cam-bar' }, recBtn, timeEl),
      h('label', { class: 'check' }, playAlong, 'Play the movie while recording'),
      h('label', { class: 'check' }, muteMovie, 'Mute the movie’s sound while recording (no headphones)'),
      review, where);

    let stream = null, recorder = null, chunks = [], blob = null, reviewUrl = '', timer = 0, recStart = 0, recSecs = 0, raf = 0;
    let state = 'starting';
    let analyser = null, srcNode = null, buf = null, bytes = null;
    let movieMuted = false, moviePlaying = false;
    let peakV = 0, peakAt = 0, lastLevel = -1;

    const restoreMovie = async () => {
      if (moviePlaying && player) { try { player.pause(); } catch (_) { /* ignore */ } }
      moviePlaying = false;
      if (movieMuted && app.audio && 'outputMuted' in app.audio) { try { app.audio.outputMuted = false; } catch (_) { /* ignore */ } }
      movieMuted = false;
      if (player) { try { await player.seek(startAt); } catch (_) { /* ignore */ } }
    };
    const cleanup = () => {
      clearInterval(timer);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener('visibilitychange', onVis);
      if (recorder && recorder.state !== 'inactive') { recorder.ondataavailable = null; recorder.onstop = null; try { recorder.stop(); } catch (_) { /* ignore */ } }
      recorder = null;
      try { if (srcNode) srcNode.disconnect(); } catch (_) { /* ignore */ }
      stopStream(stream);
      stream = null;
      if (meterCtx && typeof meterCtx.close === 'function') { meterCtx.close().catch(() => {}); }
      meterCtx = null;
      if (reviewUrl) { try { URL.revokeObjectURL(reviewUrl); } catch (_) { /* ignore */ } reviewUrl = ''; }
      restoreMovie();
    };
    const handle = this._create({
      title: 'Record narration', body, className: 'mmd-narr-dlg', backdropClass: 'mmd-dock', size: 'narrow',
      buttons: [{ label: 'Cancel', value: null }], cancelValue: null, onClose: cleanup,
    });

    const meterLoop = () => {
      raf = requestAnimationFrame(meterLoop);
      if (!analyser) return;
      let level = 0;
      if (buf) {
        analyser.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) { const a = buf[i] < 0 ? -buf[i] : buf[i]; if (a > level) level = a; }
      } else if (bytes) {
        analyser.getByteTimeDomainData(bytes);
        for (let i = 0; i < bytes.length; i++) { const a = Math.abs(bytes[i] - 128) / 128; if (a > level) level = a; }
      }
      // perceptual-ish scale: -48 dB..0 dB → 0..1
      const db = level > 1e-5 ? 20 * Math.log10(level) : -100;
      const v = clampNum((db + 48) / 48, 0, 1);
      const t = now();
      if (v >= peakV || t - peakAt > 1200) { peakV = v; peakAt = t; }
      const q = Math.round(v * 100);
      if (q !== lastLevel) {
        lastLevel = q;
        fill.style.transform = `scaleX(${v.toFixed(3)})`;
        peak.style.left = `${(peakV * 100).toFixed(1)}%`;
        meter.setAttribute('aria-valuenow', String(q));
      }
    };

    const startMic = async () => {
      let s = null, lastErr = null;
      const attempts = [{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }, { audio: true }];
      for (const c of attempts) {
        try { s = await md.getUserMedia(c); break; } catch (err) {
          lastErr = err;
          if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError', 'NotFoundError'].includes(err && err.name)) break;
        }
      }
      if (handle.closed) { stopStream(s); return; }
      if (!s) { state = 'error'; statusEl.textContent = deviceErrorMessage(lastErr, 'microphone'); statusEl.classList.add('mmd-error-text'); return; }
      stream = s;
      if (meterCtx) {
        try {
          srcNode = meterCtx.createMediaStreamSource(s);
          analyser = meterCtx.createAnalyser();
          analyser.fftSize = 1024;
          srcNode.connect(analyser);
          // Older WebKit only processes nodes that reach the destination: route through silence.
          const mute = meterCtx.createGain();
          mute.gain.value = 0;
          analyser.connect(mute);
          mute.connect(meterCtx.destination);
          if (typeof analyser.getFloatTimeDomainData === 'function') buf = new Float32Array(analyser.fftSize);
          else bytes = new Uint8Array(analyser.fftSize);
          if (meterCtx.state === 'suspended') meterCtx.resume().catch(() => {});
          raf = requestAnimationFrame(meterLoop);
        } catch (_) { analyser = null; }
      }
      state = 'ready';
      statusEl.textContent = 'Ready. Press the red button to start recording.';
      recBtn.disabled = false;
    };

    const tick = () => { recSecs = (now() - recStart) / 1000; timeEl.textContent = fmtClock(recSecs); };

    const startRec = () => {
      if (!stream || state !== 'ready') return;
      chunks = [];
      const type = pickRecorderType(isAppleWebKit() ? MIC_TYPES_APPLE : MIC_TYPES);
      try { recorder = type ? new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 128000 }) : new MediaRecorder(stream); } catch (_) {
        try { recorder = new MediaRecorder(stream); } catch (err) { statusEl.textContent = 'This browser couldn’t start recording.'; return; }
      }
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => { onStopped(); };
      try { recorder.start(1000); } catch (err) { statusEl.textContent = 'This browser couldn’t start recording.'; return; }
      state = 'recording';
      recStart = now();
      recSecs = 0;
      timeEl.textContent = '00:00';
      statusEl.textContent = 'Recording… press the button again to stop.';
      recBtn.classList.add('is-recording');
      recBtn.setAttribute('aria-label', 'Stop recording');
      recBtn.title = 'Stop recording';
      playAlong.disabled = true;
      muteMovie.disabled = true;
      timer = setInterval(tick, 250);
      if (playAlong.checked && player && hasMovie) {
        if (muteMovie.checked && app.audio && 'outputMuted' in app.audio) { try { app.audio.outputMuted = true; movieMuted = true; } catch (_) { /* ignore */ } }
        moviePlaying = true;
        Promise.resolve(player.play()).catch(() => {});
      }
    };

    const stopRec = () => {
      if (state !== 'recording') return;
      state = 'stopping';
      clearInterval(timer);
      timer = 0;
      tick();
      recBtn.disabled = true;
      restoreMovie();
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); else onStopped(); } catch (_) { onStopped(); }
    };

    const onStopped = async () => {
      if (handle.closed) return;
      const type = baseMime((recorder && recorder.mimeType) || (chunks[0] && chunks[0].type) || 'audio/webm') || 'audio/webm';
      let b = new Blob(chunks, { type: type.startsWith('video/') ? type.replace('video/', 'audio/') : type });
      chunks = [];
      recBtn.classList.remove('is-recording');
      recBtn.setAttribute('aria-label', 'Start recording');
      recBtn.title = 'Start recording';
      if (!b.size) {
        this.toast('Nothing was recorded. Please try again.', { type: 'error' });
        state = 'ready';
        recBtn.disabled = false;
        playAlong.disabled = !hasMovie;
        muteMovie.disabled = !hasMovie;
        statusEl.textContent = 'Ready. Press the red button to start recording.';
        return;
      }
      if (/webm/.test(b.type) && typeof exporterMod.fixWebmDuration === 'function') {
        try { b = await exporterMod.fixWebmDuration(b, recSecs); } catch (_) { /* keep */ }
      }
      if (handle.closed) return;
      blob = b;
      showReview();
    };

    const showReview = () => {
      state = 'review';
      if (reviewUrl) { try { URL.revokeObjectURL(reviewUrl); } catch (_) { /* ignore */ } }
      reviewUrl = URL.createObjectURL(blob);
      review.src = reviewUrl;
      review.hidden = false;
      recBtn.hidden = true;
      statusEl.textContent = `Recorded ${fmtClock(recSecs)}. Listen to it, then choose Use narration.`;
      timeEl.textContent = '';
      handle.setButtons([
        { label: 'Retake', onClick: () => { retake(); return false; } },
        { label: 'Cancel', value: null },
        {
          label: 'Use narration', primary: true,
          onClick: (hd) => { hd.close(makeFile(blob, `Narration ${n}.${extForMime(blob.type, 'audio')}`)); return false; },
        },
      ]);
    };

    const retake = () => {
      try { review.pause(); } catch (_) { /* ignore */ }
      review.removeAttribute('src');
      try { review.load(); } catch (_) { /* ignore */ }
      if (reviewUrl) { try { URL.revokeObjectURL(reviewUrl); } catch (_) { /* ignore */ } reviewUrl = ''; }
      blob = null;
      review.hidden = true;
      recBtn.hidden = false;
      recBtn.disabled = false;
      playAlong.disabled = !hasMovie;
      muteMovie.disabled = !hasMovie;
      timeEl.textContent = '00:00';
      state = 'ready';
      statusEl.textContent = 'Ready. Press the red button to start recording.';
      handle.setButtons([{ label: 'Cancel', value: null }]);
    };

    const onVis = () => { if (document.hidden && state === 'recording') stopRec(); };
    document.addEventListener('visibilitychange', onVis);
    recBtn.addEventListener('click', () => { if (state === 'ready') startRec(); else if (state === 'recording') stopRec(); });

    startMic();
    const result = await handle.promise;
    // The playhead is back at startAt (restoreMovie) before the caller inserts the narration.
    if (player) { try { await player.seek(startAt); } catch (_) { /* ignore */ } }
    return result && typeof result === 'object' && typeof result.size === 'number' ? result : null;
  }

  // ------------------------------------------------------------------ trim tool

  /**
   * WLMM Trim tool for a video item. The storyboard area (desktop) or a bottom sheet (phone) shows a
   * filmstrip with start/end handles; the preview plays only the chosen range. Save trim commits one
   * undo step via store.update; Cancel leaves the project untouched.
   */
  async openTrim(itemId) {
    const app = this.app;
    const store = app.store;
    if (!store || !app.player) return false;
    const lookup = () => {
      const found = typeof store.find === 'function' ? store.find(itemId) : null;
      return found && found.type === 'item' ? found.obj : (store.project.items || []).find((i) => i.id === itemId);
    };
    let item = lookup();
    if (!item) { this.toast('Select a video in the storyboard first, then choose Trim tool.'); return false; }
    if (item.kind !== 'video') {
      this.toast('Only videos can be trimmed. To change how long a photo or title is shown, use Duration on the Edit tab.');
      return false;
    }
    const media = typeof store.getMedia === 'function' ? store.getMedia(item.mediaId) : null;
    const D = media && media.duration > 0 ? media.duration : 0;
    if (!media || !(D > 0.2)) { this.toast('This video can’t be trimmed because its file is missing or too short.', { type: 'error' }); return false; }
    if (app.exporting) { this.toast('Please wait until your movie has finished saving.', { type: 'error' }); return false; }
    if (this._trim) {
      if (this._trim.itemId === itemId) { focusEl(this._trim.saveBtn); return this._trim.promise; }
      this._trimFinish(false);
    }
    if (this._trimOpening) return false;
    this._closeMenu();
    const player = app.player;
    if (player.playing) player.pause();

    // Save pending edits first, then pause autosave while the clip is temporarily untrimmed
    // (the half-done state must never be written to disk).
    const persist = app.persist;
    const autosaveWas = app.autosave || null;
    this._trimOpening = true;
    try { await this._flushAutosave(); } finally { this._trimOpening = false; }
    item = lookup();
    if (!item || item.kind !== 'video' || this._trim || app.exporting) return false;
    if (autosaveWas && typeof autosaveWas.disable === 'function') { try { autosaveWas.disable(); } catch (_) { /* ignore */ } }

    const MIN_LEN = 0.1;
    const orig = { trimStart: item.trimStart || 0, trimEnd: item.trimEnd === undefined ? null : item.trimEnd };
    const origTime = player.currentTime;
    let start = clampNum(orig.trimStart, 0, Math.max(0, D - MIN_LEN));
    let end = orig.trimEnd === null || !Number.isFinite(orig.trimEnd) ? D : clampNum(orig.trimEnd, start + MIN_LEN, D);
    const speed = item.speed > 0 ? item.speed : 1;

    // Show the whole source clip in the preview while trimming (no undo entry, no events).
    item.trimStart = 0;
    item.trimEnd = null;
    invalidateTimeline(store);
    let seg = null;
    const findSeg = () => {
      const tl = store.timeline;
      seg = tl && tl.segments ? tl.segments.find((s) => s.item && s.item.id === itemId) : null;
    };
    findSeg();
    const segStart = () => (seg ? seg.start : 0);
    const srcIn = () => (seg && Number.isFinite(seg.sourceIn) ? seg.sourceIn : 0);
    const tOf = (s) => segStart() + (s - srcIn()) / speed;
    const sOf = (t) => srcIn() + (t - segStart()) * speed;

    // ---- DOM
    const panel = h('div', { class: 'trim-panel mmd-trim', role: 'region', 'aria-label': 'Trim tool' });
    const lenEl = h('span', { class: 'mmd-trim-len' });
    const head = h('div', { class: 'mmd-trim-head' }, h('span', { class: 'trim-title' }, 'Trim'), h('span', { class: 'mmd-trim-name' }, media.name || 'Video'), lenEl);
    const strip = h('div', { class: 'mmd-trim-strip' });
    const frames = Array.isArray(media.filmstrip) && media.filmstrip.length ? media.filmstrip : (media.thumb ? [media.thumb] : []);
    for (const src of frames) strip.appendChild(h('img', { src, alt: '', draggable: 'false' }));
    const shadeL = h('div', { class: 'mmd-trim-shade' });
    const shadeR = h('div', { class: 'mmd-trim-shade' });
    const range = h('div', { class: 'mmd-trim-range' });
    const pos = h('div', { class: 'mmd-trim-pos' });
    const hStart = h('div', { class: 'mmd-trim-handle is-start', role: 'slider', tabindex: '0', 'aria-label': 'Start point', 'aria-valuemin': '0' });
    const hEnd = h('div', { class: 'mmd-trim-handle is-end', role: 'slider', tabindex: '0', 'aria-label': 'End point', 'aria-valuemax': String(D.toFixed(2)) });
    const track = h('div', { class: 'mmd-trim-track' }, strip, shadeL, shadeR, range, pos, hStart, hEnd);
    const startId = domId('ts'), endId = domId('te');
    const startIn = h('input', { type: 'number', id: startId, step: '0.01', min: '0', max: String(D.toFixed(2)), inputmode: 'decimal' });
    const endIn = h('input', { type: 'number', id: endId, step: '0.01', min: '0', max: String(D.toFixed(2)), inputmode: 'decimal' });
    const playBtn = h('button', { type: 'button', class: 'btn btn-icon mmd-trim-play', 'aria-label': 'Play', title: 'Play' }, icon('play', 16));
    const setStartBtn = h('button', { type: 'button', class: 'btn' }, icon('set-start', 16), h('span', null, 'Set start point'));
    const setEndBtn = h('button', { type: 'button', class: 'btn' }, icon('set-end', 16), h('span', null, 'Set end point'));
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary mmd-trim-save' }, icon('check', 16), h('span', null, 'Save trim'));
    const cancelBtn = h('button', { type: 'button', class: 'btn mmd-trim-cancel' }, h('span', null, 'Cancel'));
    const startGroup = h('div', { class: 'mmd-trim-group' }, h('label', { class: 'trim-field', for: startId }, h('span', null, 'Start point'), startIn, h('span', null, 's')), setStartBtn);
    const endGroup = h('div', { class: 'mmd-trim-group' }, h('label', { class: 'trim-field', for: endId }, h('span', null, 'End point'), endIn, h('span', null, 's')), setEndBtn);
    const actions = h('div', { class: 'trim-actions' }, playBtn, saveBtn, cancelBtn);
    const controls = h('div', { class: 'mmd-trim-controls' }, startGroup, endGroup, actions);
    panel.append(head, track, controls);

    // Desktop: the "Trim Tool › Trim" contextual ribbon tab of Windows Live Movie Maker (Start point /
    // End point, Set start point / Set end point, and Exit: Save trim / Cancel), shown over the
    // ribbon while the filmstrip with the handles stays over the storyboard. Phones keep everything
    // in the bottom sheet.
    const rStartId = domId('rts'), rEndId = domId('rte');
    const rStartIn = h('input', { type: 'number', id: rStartId, class: 'rb-input mmd-trim-num', step: '0.01', min: '0', max: String(D.toFixed(2)), inputmode: 'decimal' });
    const rEndIn = h('input', { type: 'number', id: rEndId, class: 'rb-input mmd-trim-num', step: '0.01', min: '0', max: String(D.toFixed(2)), inputmode: 'decimal' });
    const rbBtn = (iconName, label, size, cls, title) => h('button', { type: 'button', class: ['rb-btn', size === 32 ? 'rb-large' : 'rb-small', cls], title: title || label },
      icon(iconName, size), h('span', { class: 'rb-label' }, label));
    const rSetStart = rbBtn('set-start', 'Set start point', 16, 'mmd-trim-rb-setstart', 'Set start point (I)');
    const rSetEnd = rbBtn('set-end', 'Set end point', 16, 'mmd-trim-rb-setend', 'Set end point (O)');
    const rSave = rbBtn('check', 'Save trim', 32, 'mmd-trim-save', 'Save trim (keep the new start and end points)');
    const rCancel = rbBtn('close', 'Cancel', 32, 'mmd-trim-cancel', 'Cancel (Esc)');
    const rGroup = (caption, ...kids) => h('div', { class: 'rb-group', role: 'group', 'aria-label': caption },
      h('div', { class: 'rb-group-body' }, ...kids), h('div', { class: 'rb-group-caption', 'aria-hidden': 'true' }, caption));
    const rField = (id, label, input) => h('div', { class: 'rb-field' }, h('label', { class: 'rb-field-label mmd-trim-rb-label', for: id }, label), input, h('span', { 'aria-hidden': 'true' }, 's'));
    const rTab = h('div', { class: 'rb-ctx rb-ctx-video mmd-trim-ctx', 'data-label': 'Trim Tool' },
      h('span', { class: 'rb-ctx-label', 'aria-hidden': 'true' }, 'Trim Tool'),
      h('button', { type: 'button', class: 'rb-tab is-active', role: 'tab', 'aria-selected': 'true', tabindex: '-1' }, 'Trim'));
    const rTabrow = h('div', { class: 'rb-tabrow' }, h('div', { class: 'rb-tabs', role: 'tablist', 'aria-label': 'Trim Tool' }, rTab));
    const rBody = h('div', { class: 'rb-body' }, h('div', { class: 'rb-panel', role: 'tabpanel', 'aria-label': 'Trim' },
      rGroup('Trim',
        h('div', { class: 'rb-stack' }, rField(rStartId, 'Start point:', rStartIn), rField(rEndId, 'End point:', rEndIn)),
        h('div', { class: 'rb-stack' }, rSetStart, rSetEnd)),
      rGroup('Exit', rSave, rCancel)));
    const ribbonTab = h('div', { class: 'ribbon mmd-trim-ribbon', role: 'region', 'aria-label': 'Trim Tool' }, rTabrow, rBody);
    let ribbonMode = false;

    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });
    const st = {
      itemId, item, orig, origTime, panel, ribbonTab, saveBtn, promise, resolve: resolveFn, autosaveWas, persist,
      offs: [], ro: null, backToken: null, finished: false, duration: D, name: media.name || 'Video', api: null,
      get start() { return start; }, get end() { return end; },
    };
    this._trim = st;

    // ---- geometry
    let trackW = 0;
    const measure = () => { trackW = track.clientWidth || 1; };
    const xOf = (s) => (s / D) * trackW;
    let lastPosX = -1;
    const render = () => {
      measure();
      const xs = xOf(start), xe = xOf(end);
      shadeL.style.left = '0px';
      shadeL.style.width = `${xs}px`;
      shadeR.style.left = `${xe}px`;
      shadeR.style.width = `${Math.max(0, trackW - xe)}px`;
      range.style.left = `${xs}px`;
      range.style.width = `${Math.max(0, xe - xs)}px`;
      hStart.style.left = `${xs}px`;
      hEnd.style.left = `${xe}px`;
      hStart.setAttribute('aria-valuemax', (end - MIN_LEN).toFixed(2));
      hStart.setAttribute('aria-valuenow', start.toFixed(2));
      hStart.setAttribute('aria-valuetext', formatTime(start));
      hEnd.setAttribute('aria-valuemin', (start + MIN_LEN).toFixed(2));
      hEnd.setAttribute('aria-valuenow', end.toFixed(2));
      hEnd.setAttribute('aria-valuetext', formatTime(end));
      for (const inp of [startIn, rStartIn]) if (document.activeElement !== inp) inp.value = start.toFixed(2);
      for (const inp of [endIn, rEndIn]) if (document.activeElement !== inp) inp.value = end.toFixed(2);
      lenEl.textContent = `Length ${formatTime((end - start) / speed)} of ${formatTime(D / speed)}`;
      lastPosX = -1;
      updatePos();
      this._trimNotify(st);
    };
    const updatePos = () => {
      const s = clampNum(sOf(player.currentTime), 0, D);
      const x = Math.round(xOf(s));
      if (x === lastPosX) return;
      lastPosX = x;
      pos.style.left = `${x}px`;
    };
    const applyLoop = () => { player.loopRange = { start: tOf(start), end: tOf(end) }; };
    let seekPending = false, seekTo = 0;
    const seekSource = (s) => {
      seekTo = tOf(clampNum(s, 0, D));
      if (seekPending) return;
      seekPending = true;
      requestAnimationFrame(() => { seekPending = false; if (this._trim === st) player.seek(seekTo); });
    };
    const setStart = (s, seek = true) => { start = clampNum(s, 0, end - MIN_LEN); render(); applyLoop(); if (seek) seekSource(start); };
    const setEnd = (s, seek = true) => { end = clampNum(s, start + MIN_LEN, D); render(); applyLoop(); if (seek) seekSource(end); };

    // ---- placement: over the storyboard pane (desktop, phone landscape) or a bottom sheet; on
    // desktop the trim controls move to the Trim ribbon tab.
    const appEl = document.getElementById('app');
    const setRibbonMode = (on) => {
      if (on === ribbonMode) return;
      // Keep keyboard focus on the same control when it moves between the two places.
      const a = document.activeElement;
      const twin = new Map([[startIn, rStartIn], [endIn, rEndIn], [setStartBtn, rSetStart], [setEndBtn, rSetEnd], [saveBtn, rSave], [cancelBtn, rCancel]]);
      let refocus = null;
      for (const [p, r] of twin) { if (a === (on ? p : r)) refocus = on ? r : p; }
      ribbonMode = on;
      // The tab is part of the trim panel (fixed over the ribbon); the panel over the storyboard
      // keeps the filmstrip, its handles and Play.
      if (on) {
        panel.insertBefore(ribbonTab, panel.firstChild);
        if (controls.parentNode) controls.parentNode.removeChild(controls);
        head.appendChild(playBtn);
      } else {
        if (ribbonTab.parentNode) ribbonTab.parentNode.removeChild(ribbonTab);
        actions.insertBefore(playBtn, actions.firstChild);
        panel.appendChild(controls);
      }
      panel.classList.toggle('has-ribbon-tab', on);
      if (appEl) appEl.classList.toggle('mmd-trim-ribbon-on', on);
      if (refocus) focusEl(refocus);
    };
    const placeRibbon = () => {
      const rb = document.getElementById('ribbon');
      const rr = rb ? rb.getBoundingClientRect() : null;
      // The ribbon may draw the Trim tab itself (app.ribbon.showsTrimTab, driven by trimState and
      // the 'mm-trim' event); then the overlay isn't needed.
      const own = !!(this.app.ribbon && this.app.ribbon.showsTrimTab === true);
      const on = !own && !isPhoneLayout() && !!rr && rr.width >= 420 && rr.height >= 80;
      setRibbonMode(on);
      if (!on) return;
      ribbonTab.style.left = `${Math.round(rr.left)}px`;
      ribbonTab.style.top = `${Math.round(rr.top)}px`;
      ribbonTab.style.width = `${Math.round(rr.width)}px`;
      // The Trim tab takes the place of the contextual tab the ribbon shows (Video Tools › Edit),
      // else follows the last tab.
      let x = 64;
      const vis = (el) => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
      const ctxs = Array.from(rb.querySelectorAll('.rb-ctx')).filter(vis);
      if (ctxs.length) x = ctxs[0].getBoundingClientRect().left - rr.left;
      else {
        const tabs = Array.from(rb.querySelectorAll('.rb-tab')).filter(vis);
        if (tabs.length) x = tabs[tabs.length - 1].getBoundingClientRect().right - rr.left + 4;
      }
      rTab.style.left = `${Math.max(0, Math.round(x))}px`;
      // Line the tab body up with the ribbon's own (hidden underneath).
      const realBody = rb.querySelector('.rb-body');
      const br = vis(realBody) ? realBody.getBoundingClientRect() : null;
      rTabrow.style.height = br && br.top > rr.top ? `${Math.round(br.top - rr.top)}px` : '';
      rBody.style.height = br && br.height > 40 ? `${Math.round(br.height)}px` : '';
    };
    const place = () => {
      const pane = document.getElementById('storyboard-pane');
      const r = pane ? pane.getBoundingClientRect() : null;
      const sheet = (isPhoneLayout() && !isPhoneLandscapeLayout()) || !r || r.width < 200 || r.height < 120;
      panel.classList.toggle('is-sheet', sheet);
      panel.classList.toggle('is-docked', !sheet);
      if (sheet) {
        setRibbonMode(false);
        panel.style.left = ''; panel.style.top = ''; panel.style.width = ''; panel.style.maxHeight = '';
      } else {
        placeRibbon();
        // Docked at the top of the storyboard pane (which is dimmed and locked underneath).
        panel.style.left = `${Math.round(r.left)}px`;
        panel.style.top = `${Math.round(r.top)}px`;
        panel.style.width = `${Math.round(r.width)}px`;
        panel.style.maxHeight = `${Math.round(r.height)}px`;
      }
      render();
    };

    // ---- pointer interaction
    const dragHandle = (el, which) => {
      let pid = null;
      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        pid = e.pointerId;
        try { el.setPointerCapture(pid); } catch (_) { /* ignore */ }
        el.classList.add('is-dragging');
        if (player.playing) player.pause();
        measure();
        focusEl(el);
      });
      el.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
        const rect = track.getBoundingClientRect();
        const s = ((e.clientX - rect.left) / Math.max(1, rect.width)) * D;
        if (which === 'start') setStart(s); else setEnd(s);
      });
      const up = (e) => {
        if (e.pointerId !== pid) return;
        pid = null;
        el.classList.remove('is-dragging');
        applyLoop();
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('keydown', (e) => {
        const big = e.shiftKey ? 1 : 0.1;
        let v = which === 'start' ? start : end;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= big;
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += big;
        else if (e.key === 'PageDown') v -= 1;
        else if (e.key === 'PageUp') v += 1;
        else if (e.key === 'Home') v = which === 'start' ? 0 : start + MIN_LEN;
        else if (e.key === 'End') v = which === 'start' ? end - MIN_LEN : D;
        else return;
        e.preventDefault();
        e.stopPropagation();
        if (player.playing) player.pause();
        if (which === 'start') setStart(v); else setEnd(v);
      });
    };
    dragHandle(hStart, 'start');
    dragHandle(hEnd, 'end');
    // Tap / drag on the filmstrip scrubs the preview inside the range.
    let scrubId = null;
    const scrubAt = (e) => {
      const rect = track.getBoundingClientRect();
      const s = ((e.clientX - rect.left) / Math.max(1, rect.width)) * D;
      seekSource(clampNum(s, start, end));
    };
    track.addEventListener('pointerdown', (e) => {
      if (e.target === hStart || e.target === hEnd) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      scrubId = e.pointerId;
      try { track.setPointerCapture(scrubId); } catch (_) { /* ignore */ }
      if (player.playing) player.pause();
      scrubAt(e);
    });
    track.addEventListener('pointermove', (e) => { if (e.pointerId === scrubId) scrubAt(e); });
    const scrubEnd = (e) => { if (e.pointerId === scrubId) scrubId = null; };
    track.addEventListener('pointerup', scrubEnd);
    track.addEventListener('pointercancel', scrubEnd);

    const fieldCommit = (input, which) => {
      const v = parseFloat(String(input.value).replace(',', '.'));
      if (!Number.isFinite(v)) { render(); return; }
      if (which === 'start') setStart(v); else setEnd(v);
    };
    for (const [inp, which] of [[startIn, 'start'], [endIn, 'end'], [rStartIn, 'start'], [rEndIn, 'end']]) {
      inp.addEventListener('change', () => fieldCommit(inp, which));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fieldCommit(inp, which); } });
      inp.addEventListener('blur', () => render());
    }
    // Set start / end point: at the playhead (source time of the frame shown in the preview).
    const setPoint = (which) => {
      if (this._trim !== st) return;
      if (which === 'start') setStart(sOf(player.currentTime), false); else setEnd(sOf(player.currentTime), false);
    };
    for (const b of [setStartBtn, rSetStart]) b.addEventListener('click', () => setPoint('start'));
    for (const b of [setEndBtn, rSetEnd]) b.addEventListener('click', () => setPoint('end'));
    const syncPlay = () => {
      const playing = player.playing;
      clear(playBtn).appendChild(icon(playing ? 'pause' : 'play', 16));
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      playBtn.title = playing ? 'Pause' : 'Play';
    };
    playBtn.addEventListener('click', () => {
      if (player.playing) { player.pause(); return; }
      applyLoop();
      const s = sOf(player.currentTime);
      const go = () => Promise.resolve(player.play()).catch((err) => this._reportError(err));
      if (s < start - 0.01 || s >= end - 0.03) player.seek(tOf(start)).then(go, go);
      else go();
    });
    for (const b of [saveBtn, rSave]) b.addEventListener('click', () => this._trimFinish(true));
    for (const b of [cancelBtn, rCancel]) b.addEventListener('click', () => this._trimFinish(false));
    st.api = {
      setPoint,
      setStart: (v) => setStart(clampNum(v, 0, D)),
      setEnd: (v) => setEnd(clampNum(v, 0, D)),
    };

    // Small source-time badge on the preview (not exported).
    let badgeCs = -1, badgeText = '';
    player.setOverlayHook((ctx, t, w, hgt) => {
      const s = clampNum(sOf(t), 0, D);
      const cs = Math.round(s * 100);
      if (cs !== badgeCs) { badgeCs = cs; badgeText = `Trim  ${formatTime(s)}`; }
      const fs = Math.max(10, Math.round(hgt * 0.045));
      ctx.font = `600 ${fs}px "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(badgeText).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(fs * 0.5, fs * 0.5, tw + fs, fs * 1.6);
      ctx.fillStyle = (s < start - 0.005 || s > end + 0.005) ? '#ffb4a8' : '#ffe48a';
      ctx.fillText(badgeText, fs, fs * 0.8);
    });

    // ---- wiring
    // A ribbon that draws the Trim tab itself stays usable (it disables its other tabs); otherwise
    // the ribbon is locked like the storyboard.
    const ribbonOwnTab = !!(app.ribbon && app.ribbon.showsTrimTab === true);
    st.locked = TRIM_LOCKED.filter((id) => !(ribbonOwnTab && id === 'ribbon'));
    if (appEl) appEl.classList.add('mmd-trim-mode');
    if (appEl && ribbonOwnTab) appEl.classList.add('mmd-trim-ribbon-own');
    for (const id of st.locked) {
      const el = document.getElementById(id);
      if (el && 'inert' in HTMLElement.prototype) { st[`inert-${id}`] = el.inert; el.inert = true; }
    }
    st.offs.push(this._listen(player, 'timeupdate', updatePos));
    st.offs.push(this._listen(player, 'play', syncPlay));
    st.offs.push(this._listen(player, 'pause', syncPlay));
    st.offs.push(this._listen(window, 'resize', place));
    st.offs.push(this._listen(store, 'change', () => {
      // The clip was removed or the project replaced by something else (load, undo): leave trim
      // mode without touching the (new) project objects.
      const live = (store.project.items || []).find((i) => i.id === itemId);
      if (live !== item) this._trimFinish(false, { gone: true });
    }));
    if (typeof ResizeObserver === 'function') {
      const pane = document.getElementById('storyboard-pane');
      st.ro = new ResizeObserver(() => place());
      if (pane) st.ro.observe(pane);
      const rb = document.getElementById('ribbon');
      if (rb) st.ro.observe(rb);
      st.ro.observe(track);
    }
    if (typeof dom.watchLayout === 'function') { try { st.offs.push(dom.watchLayout(() => place())); } catch (_) { /* ignore */ } }
    st.backToken = this._pushBack(() => { if (this._trim === st) this._trimFinish(false, { fromBack: true }); });

    this.root.appendChild(panel);
    place();
    applyLoop();
    player.seek(tOf(start));
    syncPlay();
    requestAnimationFrame(() => { if (this._trim === st) { place(); focusEl(isCoarse() ? panel : hStart); } });
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    return promise;
  }

  _listen(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    target.addEventListener(type, fn, opts);
    return () => { try { target.removeEventListener(type, fn, opts); } catch (_) { /* ignore */ } };
  }

  _trimKey(e) {
    const st = this._trim;
    if (!st) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      this._trimFinish(false);
    }
  }

  /** Leave trim mode. save=true commits the new range as one undo step. */
  _trimFinish(save, { gone = false, fromBack = false } = {}) {
    const st = this._trim;
    if (!st || st.finished) return;
    st.finished = true;
    this._trim = null;
    const app = this.app, store = app.store, player = app.player;
    const item = st.item;
    const D = (() => { const m = store.getMedia ? store.getMedia(item.mediaId) : null; return m && m.duration > 0 ? m.duration : 0; })();
    // Restore the original trim first so the undo snapshot holds the real "before" state.
    if (!gone) {
      item.trimStart = st.orig.trimStart;
      item.trimEnd = st.orig.trimEnd;
      invalidateTimeline(store);
    }
    for (const off of st.offs) { try { off(); } catch (_) { /* ignore */ } }
    if (st.ro) { try { st.ro.disconnect(); } catch (_) { /* ignore */ } }
    if (!fromBack) this._releaseBack(st.backToken);
    try { if (player.playing) player.pause(); } catch (_) { /* ignore */ }
    try { player.loopRange = null; } catch (_) { /* ignore */ }
    try { player.setOverlayHook(null); } catch (_) { /* ignore */ }
    const appEl = document.getElementById('app');
    if (appEl) appEl.classList.remove('mmd-trim-mode', 'mmd-trim-ribbon-on', 'mmd-trim-ribbon-own');
    if (st.ribbonTab && st.ribbonTab.parentNode) st.ribbonTab.parentNode.removeChild(st.ribbonTab);
    for (const id of st.locked || TRIM_LOCKED) {
      const el = document.getElementById(id);
      if (el && 'inert' in HTMLElement.prototype) el.inert = !!st[`inert-${id}`];
    }
    if (st.panel.parentNode) st.panel.parentNode.removeChild(st.panel);

    let changed = false;
    if (save && !gone) {
      const r2 = (v) => Math.round(v * 100) / 100;
      const ns = r2(st.start);
      const ne = D && st.end >= D - 0.005 ? null : r2(st.end);
      const os = st.orig.trimStart || 0;
      const oe = st.orig.trimEnd;
      changed = Math.abs(ns - os) > 1e-6 || (ne === null) !== (oe === null || oe === undefined) || (ne !== null && Math.abs(ne - oe) > 1e-6);
      if (changed) {
        store.update((p) => {
          // Captions stay on the frames they were placed on (as with Set start/end point).
          let anchors = null;
          try { anchors = anchorTexts(p, store.media); } catch (_) { anchors = null; }
          const it = p.items.find((i) => i.id === st.itemId);
          if (it) { it.trimStart = ns; it.trimEnd = ne; }
          if (anchors && anchors.length) { try { reanchorTexts(p, store.media, anchors); } catch (_) { /* keep times */ } }
        }, { label: 'Trim' });
      }
    }
    // Autosave back on (a fresh controller — the paused one was disabled).
    if (st.autosaveWas && st.persist && typeof st.persist.enableAutosave === 'function') {
      try { app.autosave = st.persist.enableAutosave(store); } catch (err) { console.warn(err); }
    }
    // Playhead: start of the trimmed clip after saving, where it was after canceling.
    try {
      if (changed) {
        const seg = store.timeline.segments.find((s) => s.item && s.item.id === st.itemId);
        player.seek(seg ? seg.start : st.origTime);
      } else if (!gone) {
        player.seek(Math.min(st.origTime, player.duration));
        player.renderNow();
      } else player.renderNow();
    } catch (_) { /* ignore */ }
    if (changed) this.toast('Trim saved.', { type: 'success', timeout: 1800 });
    focusEl(document.getElementById('storyboard-pane'));
    this._trimNotify(null);
    st.resolve(changed);
  }

  /**
   * The Trim tool's state while it is open, else null:
   * { itemId, name, start, end, duration } — source seconds of the clip being trimmed.
   * Changes are announced with a window 'mm-trim' event ({ detail: trimState }; detail null when
   * the tool closes), so a ribbon can show the Trim tab's Start point / End point values.
   */
  get trimState() {
    const st = this._trim;
    if (!st || st.finished) return null;
    return { itemId: st.itemId, name: st.name, start: st.start, end: st.end, duration: st.duration };
  }

  /** Trim tool: Set start point / Set end point ('start' | 'end') at the playhead. */
  trimSetPoint(which) {
    const st = this._trim;
    if (!st || st.finished || !st.api) return false;
    st.api.setPoint(which === 'end' ? 'end' : 'start');
    return true;
  }

  /** Trim tool: type a start or end point ('start' | 'end', source seconds). */
  trimSetValue(which, seconds) {
    const st = this._trim;
    const v = Number(seconds);
    if (!st || st.finished || !st.api || !Number.isFinite(v)) return false;
    if (which === 'end') st.api.setEnd(v); else st.api.setStart(v);
    return true;
  }

  /** Trim tool: Save trim (true) or Cancel (false). */
  trimFinish(save) {
    if (!this._trim) return false;
    this._trimFinish(!!save);
    return true;
  }

  _trimNotify(st) {
    if (st && (st !== this._trim || st.finished)) return;
    if (st) {
      // One event per frame at most while a handle is dragged.
      if (this._trimEvtRaf) return;
      const fire = () => { this._trimEvtRaf = 0; if (this._trim === st) this._emitTrim(this.trimState); };
      this._trimEvtRaf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fire) : setTimeout(fire, 16);
      return;
    }
    if (this._trimEvtRaf) { try { cancelAnimationFrame(this._trimEvtRaf); } catch (_) { clearTimeout(this._trimEvtRaf); } this._trimEvtRaf = 0; }
    this._emitTrim(null);
  }

  _emitTrim(detail) {
    try { window.dispatchEvent(makeEvent('mm-trim', detail)); } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------------ options / about / help

  openOptions() {
    const mk = (name, label, step, hint) => {
      const id = domId('opt');
      const [lo, hi] = OPTION_LIMITS[name];
      const input = h('input', { type: 'number', id, min: String(lo), max: String(hi), step: String(step), inputmode: 'decimal', value: String(getOption(name)) });
      return { name, input, el: h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'mmd-opt-row' }, input, h('span', null, 'seconds')), h('div', { class: 'hint' }, hint)) };
    };
    const fields = [
      mk('photoDuration', 'Photo duration', 0.5, `How long new photos are shown. Default: ${OPTION_DEFAULTS.photoDuration} seconds.`),
      mk('transitionDuration', 'Transition duration', 0.25, `Length of new transitions. Default: ${OPTION_DEFAULTS.transitionDuration} seconds.`),
    ];
    const body = h('div', null, h('h3', null, 'Defaults for new items'), ...fields.map((f) => f.el),
      h('p', { class: 'hint' }, 'These settings are kept in this browser and apply to photos and transitions you add from now on.'));
    return this.open({
      title: 'Movie Maker Options', body, size: 'narrow',
      buttons: [
        { label: 'Reset', onClick: () => { for (const f of fields) f.input.value = String(OPTION_DEFAULTS[f.name]); return false; } },
        {
          label: 'OK', primary: true, value: true,
          onClick: () => {
            for (const f of fields) {
              const v = parseFloat(String(f.input.value).replace(',', '.'));
              setOption(f.name, Number.isFinite(v) ? v : null);
            }
            return true;
          },
        },
        { label: 'Cancel', value: false },
      ],
    });
  }

  openAbout() {
    const app = this.app;
    const formats = typeof exporterMod.supportedFormats === 'function' ? exporterMod.supportedFormats() : [];
    const cap = (state, text) => h('li', null, icon(state === true ? 'check' : state === false ? 'error' : 'info', 14), h('span', null, text));
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    const caps = h('ul', { class: 'mmd-caps' },
      cap(formats.length > 0, formats.length ? `Save movie: ${formats.map((f) => f.ext.toUpperCase()).filter((v, i, a) => a.indexOf(v) === i).join(', ')}` : 'Save movie isn’t supported in this browser'),
      cap(typeof indexedDB !== 'undefined', typeof indexedDB !== 'undefined' ? 'Projects are saved on this device' : 'Projects can’t be saved in this browser'),
      cap(!!(md && md.getUserMedia), md && md.getUserMedia ? 'Webcam video and narration recording' : 'Webcam and narration need a secure (https) connection'),
      offlineCap());
    function offlineCap() {
      const swOk = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
      if (!swOk) return cap(false, 'Offline use isn’t supported in this browser');
      if (window.isSecureContext === false) return cap(false, 'Offline use needs a secure (https) connection');
      if (navigator.serviceWorker.controller) return cap(true, 'Works offline');
      return cap('info', 'Works offline after Movie Maker has been opened once more');
    }
    const storageLine = h('p', { class: 'hint' });
    const body = h('div', null,
      h('div', { class: 'mmd-about' }, h('img', { src: APP_ICON_URL, alt: '' }), h('div', null,
        h('h3', null, 'Movie Maker'),
        h('p', { class: 'hint' }, `Version ${APP_VERSION} · web edition`),
        h('p', null, 'A fan-made re-creation of Windows Live Movie Maker 2011 that runs in your web browser — on computers, tablets and phones.'),
        h('p', null, 'Your videos, photos and music never leave your device: everything is edited and saved locally.'),
        caps, storageLine,
        h('p', { class: 'hint' }, 'Movie Maker (web) is an independent fan project. It is not affiliated with, endorsed by or connected to Microsoft. Windows and Windows Live are trademarks of Microsoft Corporation.'))));
    if (app.persist && typeof app.persist.storageEstimate === 'function') {
      app.persist.storageEstimate().then((est) => {
        if (est && est.quota) storageLine.textContent = `Storage used on this device: ${fmtBytes(est.usage)} of about ${fmtBytes(est.quota)} available.`;
      }, () => {});
    }
    const buttons = [];
    if (app.installPrompt) buttons.push({ label: 'Install app', icon: 'download', onClick: () => { this._install(); return true; } });
    buttons.push({ label: 'OK', primary: true, value: true });
    return this.open({ title: 'About Movie Maker', body, buttons });
  }

  openHelp() {
    const mod = isMac() ? '⌘' : 'Ctrl';
    const k = (...keys) => h('td', null, ...keys.flatMap((x, i) => (i ? [' + ', h('kbd', null, x)] : [h('kbd', null, x)])));
    const row = (keys, text) => h('tr', null, keys, h('td', null, text));
    const keysTable = h('table', { class: 'mmd-keys' }, h('tbody', null,
      row(k('Space'), 'Play / pause'),
      row(h('td', null, h('kbd', null, '←'), ' ', h('kbd', null, '→')), 'Previous / next frame'),
      row(h('td', null, h('kbd', null, 'Home'), ' ', h('kbd', null, 'End')), 'Go to the start / end'),
      row(k(mod, 'Z'), 'Undo'),
      row(h('td', null, h('kbd', null, mod), ' + ', h('kbd', null, 'Y')), 'Redo'),
      row(h('td', null, h('kbd', null, mod), ' + ', h('kbd', null, 'X'), ' / ', h('kbd', null, 'C'), ' / ', h('kbd', null, 'V')), 'Cut / copy / paste'),
      row(k('Delete'), 'Remove the selected items'),
      row(k(mod, 'A'), 'Select all items'),
      row(k('M'), 'Split the selected item at the playhead'),
      row(h('td', null, h('kbd', null, 'I'), ' ', h('kbd', null, 'O')), 'Set start point / end point at the playhead (video, music, Trim tool)'),
      row(h('td', null, h('kbd', null, mod), ' + ', h('kbd', null, 'B'), ' / ', h('kbd', null, 'I')), 'Bold / italic (selected caption, title or credits)'),
      row(k(mod, 'S'), 'Save project'),
      row(k(mod, 'O'), 'Open project'),
      row(k('F1'), 'Help')));
    const phone = isCoarse() || isPhoneLayout();
    // A phone has no keyboard to speak of: show its gestures instead of the shortcut table.
    // Tablets (coarse pointer, wide layout) keep the table, they often have a keyboard.
    const touchPhone = isCoarse() && isPhoneLayout();
    const tap = phone ? 'Tap' : 'Click';
    const gestures = [
      'Tap a clip to select it.',
      'Press and hold a clip for Edit, Trim, Split, Duplicate and Remove.',
      'Press, hold and drag a clip to move it to another place.',
      'Pinch the storyboard with two fingers to zoom in or out.',
      'Scroll the storyboard sideways to move the playhead.',
      'Double-tap the picture to play or pause.',
      'Tap a caption or title on the picture to select it, then tap it again to edit the text. Return starts a new line; tap Done when you have finished.',
    ];
    const tips = [
      `${tap} “Add videos and photos” on the Home tab to start. ${phone ? 'Android users can also share videos and photos to the installed app.' : 'You can also drag files onto the window, or paste a picture.'}`,
      `${tap} an item in the storyboard to select it — the Video Tools, Music Tools and Text Tools tabs appear for what you selected.`,
      phone
        ? 'The storyboard is a filmstrip: scroll it sideways to move through your movie; the playhead stays in the middle.'
        : 'Drag items in the storyboard to change their order. Use the zoom slider in the status bar to see more or less detail.',
      phone
        ? 'Galleries (transitions, effects, pan and zoom) open as a sheet — tap a thumbnail to apply it.'
        : 'Point at a gallery thumbnail (transitions, effects, pan and zoom) to preview it, and click to apply it.',
      phone
        ? 'Save movie records your movie in real time: keep the screen on and Movie Maker open until it finishes.'
        : 'Save movie records your movie in real time: keep this tab open and visible until it finishes.',
      isIOS()
        ? 'Install it: in Safari tap Share, then “Add to Home Screen”. It then opens full screen, works offline, and Safari no longer deletes your projects when you haven’t used it for a while.'
        : 'Install it: open your browser’s menu and choose “Install app” or “Add to Home screen”. It then works offline.',
      'Everything stays on your device. Projects are saved automatically in this browser; use Export project file to move one to another device.',
    ];
    const body = h('div', { class: 'mmd-help' },
      h('h3', null, phone ? 'Tips for phones and tablets' : 'Getting started'),
      h('ul', null, ...tips.map((t) => h('li', null, t))),
      isCoarse() ? h('h3', null, 'Touch gestures') : null,
      isCoarse() ? h('ul', { class: 'mmd-gestures' }, ...gestures.map((t) => h('li', null, t))) : null,
      touchPhone ? null : h('h3', null, 'Keyboard shortcuts'),
      touchPhone ? null : keysTable,
      phone ? null : h('p', { class: 'hint' }, 'Shortcuts don’t apply while you are typing in a text box.'));
    return this.open({ title: 'Movie Maker Help', body, size: 'wide', buttons: [{ label: 'OK', primary: true, value: true }] });
  }

  /** Close every dialog, the menu and the trim tool (trim is canceled). */
  closeAll() {
    this._closeMenu();
    if (this._trim) this._trimFinish(false);
    for (const hd of this._stack.slice().reverse()) {
      if (hd.dismissible) hd.close(hd.cancelValue);
    }
  }
}

export default Dialogs;
