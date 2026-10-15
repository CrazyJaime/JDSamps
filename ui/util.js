// ui/util.js — small DOM/format helpers. Never use innerHTML with page-derived data.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const wallNow = () => performance.timeOrigin + performance.now();

export function clone(templateId) {
  const t = document.getElementById(templateId);
  return t.content.firstElementChild.cloneNode(true);
}

/** Write text only when it changed (avoids layout work at 60 fps). */
export function setText(el, text) {
  const s = String(text);
  if (el.textContent !== s) el.textContent = s;
}

export function toggleAttr(el, name, on) {
  setAttr(el, name, on ? 'true' : 'false');
}

// Compare-first writers: every attribute write is a DOM mutation (and an accessibility-tree update)
// even when the value is the same, and snapshots arrive at 30 Hz per deck.
export function setAttr(el, name, value) {
  const s = String(value);
  if (el.getAttribute(name) !== s) el.setAttribute(name, s);
}
export function setHidden(el, hidden) {
  if (el.hidden !== !!hidden) el.hidden = !!hidden;
}
export function setClass(el, className) {
  if (el.className !== className) el.className = className;
}
const styles = new WeakMap();
/** Inline style property, compared with the last value written (the browser normalises what it reads back). */
export function setStyle(el, prop, value) {
  let last = styles.get(el);
  if (!last) styles.set(el, (last = {}));
  if (last[prop] === value) return;
  last[prop] = value;
  el.style.setProperty(prop, value);
}

/** While the page is hidden the UI only stores snapshots; strips apply the latest one when it shows. */
export const pageHidden = () => document.visibilityState === 'hidden';

const FOCUSABLE = 'button:not([disabled]):not([hidden]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/**
 * Modal focus handling for an overlay shown and hidden through its `hidden` attribute: focus moves
 * in when it opens, Tab and Shift+Tab cycle inside it, and focus goes back to where it was on close.
 */
export function trapFocus(el) {
  let back = null;
  const items = () => $$(FOCUSABLE, el).filter((e) => !e.closest('[hidden]'));
  new MutationObserver(() => {
    if (!el.hidden && !back) {
      back = document.activeElement || document.body;
      const first = items()[0];
      if (first) first.focus(); else { el.tabIndex = -1; el.focus(); }
    } else if (el.hidden && back) {
      const to = back;
      back = null;
      if (el.contains(document.activeElement) || document.activeElement === document.body) to.focus && to.focus();
    }
  }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const list = items();
    e.preventDefault();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement), n = list.length;
    list[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? n - 1 : 1)) % n].focus();
  });
}

export const fmtBpm = (b) => (b ? b.toFixed(1) : '—');
export const fmtPct = (p) => `${p < 0 ? '−' : '+'}${Math.abs(p * 100).toFixed(2)}%`;
export const fmtDb = (db) => (db === -Infinity || db < -99 ? '−∞' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`);
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
