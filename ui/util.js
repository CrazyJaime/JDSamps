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
  const v = on ? 'true' : 'false';
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

export const fmtBpm = (b) => (b ? b.toFixed(1) : '—');
export const fmtPct = (p) => `${p < 0 ? '−' : '+'}${Math.abs(p * 100).toFixed(2)}%`;
export const fmtDb = (db) => (db === -Infinity || db < -99 ? '−∞' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`);
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
