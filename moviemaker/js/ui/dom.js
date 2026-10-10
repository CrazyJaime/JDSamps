// ui/dom.js — tiny DOM helpers shared by every UI module of Movie Maker (web).
//
//   h(tag, props, ...children)   create an element (see h() below for the props it understands)
//   on(target, type, fn, opts)   addEventListener that returns an "off" function
//   qs(sel, root) / qsa(sel, root)
//   clamp(v, min, max), debounce(fn, ms), rafThrottle(fn)
//   isPhone() / isPhoneLandscape() / isCompact() / watchLayout(cb)   responsive helpers
//   longPress(el, cb, opts)      press-and-hold on touch/pen/mouse via Pointer Events
//   backGuard(app, onBack)       Android Back / iOS swipe-back closes a transient surface
//   icon(name, size), iconSVG(name)   re-exported from ./icons.js
//
// Layout queries (keep in sync with css/moviemaker.css):
//   PHONE_QUERY            portrait phone layout from the architecture contract
//   PHONE_LANDSCAPE_QUERY  landscape phone layout (preview left, storyboard right, compact ribbon)
// isPhone() is true for BOTH phone layouts (any "phone-class" screen); use isPhoneLandscape()
// to tell them apart. isCompact() is an alias of isPhone() kept for readability in ribbon code.

export { icon, iconSVG, hasIcon, ICON_NAMES } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'title']);

// Properties that must be assigned as DOM properties rather than attributes.
const PROP_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'textContent', 'innerText',
  'indeterminate', 'muted', 'volume', 'currentTime', 'playbackRate', 'tabIndex', 'multiple', 'readOnly',
  'defaultValue', 'scrollTop', 'scrollLeft', 'srcObject', 'playsInline', 'autoplay', 'loop', 'controls']);

/**
 * Create an element.
 *   tag:   'div', 'button.rb-btn.is-large', 'svg:path' (namespace prefix) or a known SVG tag name.
 *          "tag.class1.class2#id" shorthand is supported.
 *   props: null or an object:
 *     class / className  string | string[] | {name: bool}
 *     style              string | {prop: value}  (custom properties '--x' supported)
 *     dataset            {key: value}
 *     on / events        {type: handler}   or  onclick / onClick / onPointerDown … (function values)
 *     ref                function(el) called after creation
 *     html               trusted static markup only (icons); never pass user text here
 *     value, checked, disabled, hidden, textContent, …   assigned as properties
 *     anything else      setAttribute (true → "", false/null/undefined → skipped)
 *   children: strings/numbers (text), Nodes, arrays (flattened), null/undefined/false (skipped).
 */
export function h(tag, props, ...children) {
  let name = String(tag || 'div');
  let ns = null;
  if (name.startsWith('svg:')) { ns = SVG_NS; name = name.slice(4); }
  let id = '';
  const classes = [];
  if (/[.#]/.test(name)) {
    const parts = name.split(/(?=[.#])/);
    name = parts.shift() || 'div';
    for (const p of parts) {
      if (p[0] === '.') classes.push(p.slice(1));
      else if (p[0] === '#') id = p.slice(1);
    }
  }
  if (!ns && SVG_TAGS.has(name) && name !== 'title') ns = SVG_NS;
  const el = ns ? document.createElementNS(ns, name) : document.createElement(name);
  if (id) el.id = id;
  if (classes.length) el.setAttribute('class', classes.join(' '));

  // Allow h('div', 'text') / h('div', node) shorthand when props is really a child.
  if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) applyProps(el, props);
  appendChildren(el, children);
  if (props && typeof props.ref === 'function') props.ref(el);
  return el;
}

function applyProps(el, props) {
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (key === 'ref' || v === undefined) continue;
    if (key === 'class' || key === 'className') {
      const cls = classString(v);
      if (cls) {
        const prev = el.getAttribute('class');
        el.setAttribute('class', prev ? `${prev} ${cls}` : cls);
      }
    } else if (key === 'style') {
      if (typeof v === 'string') el.style.cssText = v;
      else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          if (v[k] == null || v[k] === false) continue;
          if (k.startsWith('--') || k.includes('-')) el.style.setProperty(k, String(v[k]));
          else el.style[k] = v[k];
        }
      }
    } else if (key === 'dataset') {
      if (v && typeof v === 'object') for (const k of Object.keys(v)) if (v[k] != null) el.dataset[k] = String(v[k]);
    } else if (key === 'on' || key === 'events') {
      if (v && typeof v === 'object') for (const type of Object.keys(v)) if (typeof v[type] === 'function') el.addEventListener(type, v[type]);
    } else if (key === 'html') {
      if (v != null) el.innerHTML = String(v);
    } else if (key.length > 2 && key[0] === 'o' && key[1] === 'n' && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v);
    } else if (PROP_KEYS.has(key) && !(el instanceof SVGElement)) {
      try { el[key] = v; } catch (_) { /* read-only in this browser */ }
    } else if (v === true) {
      el.setAttribute(key, '');
    } else if (v === false || v === null) {
      // skip
    } else {
      el.setAttribute(key, String(v));
    }
  }
}

function classString(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.filter(Boolean).map(String).join(' ');
  if (typeof v === 'object') return Object.keys(v).filter((k) => v[k]).join(' ');
  return String(v);
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Remove every child of an element (fast path for re-rendering). */
export function clear(el) {
  if (!el) return el;
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** addEventListener that returns an unsubscribe function. Works with any EventTarget. */
export function on(target, type, handler, opts) {
  if (!target || typeof target.addEventListener !== 'function' || typeof handler !== 'function') return () => {};
  target.addEventListener(type, handler, opts);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try { target.removeEventListener(type, handler, opts); } catch (_) { /* ignore */ }
  };
}

/** querySelector shortcut. */
export function qs(sel, root = document) {
  return root && typeof root.querySelector === 'function' ? root.querySelector(sel) : null;
}

/** querySelectorAll as an array. */
export function qsa(sel, root = document) {
  return root && typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll(sel)) : [];
}

/** Clamp a number; NaN becomes `min`. */
export function clamp(v, min, max) {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return n < min ? min : (n > max ? max : n);
}

/**
 * Debounce: fn runs `ms` after the last call. The returned function has
 * .cancel() and .flush() (runs a pending call immediately).
 */
export function debounce(fn, ms = 150) {
  let timer = 0;
  let lastArgs = null;
  let lastThis = null;
  const run = () => {
    timer = 0;
    const args = lastArgs, self = lastThis;
    lastArgs = lastThis = null;
    fn.apply(self, args || []);
  };
  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }
  debounced.cancel = () => { if (timer) clearTimeout(timer); timer = 0; lastArgs = lastThis = null; };
  debounced.flush = () => { if (timer) { clearTimeout(timer); run(); } };
  debounced.pending = () => !!timer;
  return debounced;
}

/** Coalesce calls to one per animation frame (the last arguments win). Has .cancel(). */
export function rafThrottle(fn) {
  let id = 0;
  let lastArgs = null;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
  function throttled(...args) {
    lastArgs = args;
    if (id) return;
    id = raf(() => { id = 0; const a = lastArgs; lastArgs = null; fn(...(a || [])); });
  }
  throttled.cancel = () => { if (id) caf(id); id = 0; lastArgs = null; };
  return throttled;
}

// ---------------------------------------------------------------------------
// Responsive helpers

export const PHONE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 1024px) and (orientation: portrait)';
export const PHONE_LANDSCAPE_QUERY = '(pointer: coarse) and (orientation: landscape) and (max-height: 520px)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const _mqCache = new Map();
function mq(query) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  let m = _mqCache.get(query);
  if (!m) {
    try { m = window.matchMedia(query); } catch (_) { m = null; }
    if (m) _mqCache.set(query, m);
  }
  return m;
}

/** True for any phone layout (portrait phone, or landscape phone). */
export function isPhone() {
  const a = mq(PHONE_QUERY), b = mq(PHONE_LANDSCAPE_QUERY);
  return !!((a && a.matches) || (b && b.matches));
}

/** True only for the landscape phone layout (preview left, storyboard right). */
export function isPhoneLandscape() {
  const b = mq(PHONE_LANDSCAPE_QUERY);
  return !!(b && b.matches);
}

/** Compact ribbon (single scrolling row of 44px buttons). Same as isPhone(). */
export function isCompact() { return isPhone(); }

/** True when the device's primary pointer is coarse (finger). */
export function isTouchPrimary() {
  const m = mq('(pointer: coarse)');
  return !!(m && m.matches);
}

/** True when the user asked for reduced motion. */
export function prefersReducedMotion() {
  const m = mq(REDUCED_MOTION_QUERY);
  return !!(m && m.matches);
}

/**
 * Call cb({ phone, landscape }) whenever the layout class changes (not on every resize).
 * Returns an unsubscribe function.
 */
export function watchLayout(cb) {
  if (typeof cb !== 'function') return () => {};
  const queries = [mq(PHONE_QUERY), mq(PHONE_LANDSCAPE_QUERY)].filter(Boolean);
  let last = `${isPhone()}|${isPhoneLandscape()}`;
  const handler = () => {
    const key = `${isPhone()}|${isPhoneLandscape()}`;
    if (key === last) return;
    last = key;
    try { cb({ phone: isPhone(), landscape: isPhoneLandscape() }); } catch (err) { console.error(err); }
  };
  const offs = queries.map((m) => {
    if (typeof m.addEventListener === 'function') { m.addEventListener('change', handler); return () => m.removeEventListener('change', handler); }
    if (typeof m.addListener === 'function') { m.addListener(handler); return () => m.removeListener(handler); } // Safari < 14
    return () => {};
  });
  // Orientation changes on some iOS versions fire before media queries update; re-check on resize too.
  const offResize = on(window, 'resize', debounce(handler, 120));
  return () => { offs.forEach((f) => f()); offResize(); };
}

// ---------------------------------------------------------------------------
// Long press

/**
 * Fire cb(event) when the element is pressed and held for `ms` without moving more than
 * `tolerance` px. Works for touch, pen and mouse via Pointer Events. After a long press fires,
 * the following click is swallowed so the element's normal tap action does not also run.
 * Also suppresses the iOS/Android context menu on that element while pressing.
 * Returns an unsubscribe function.
 */
export function longPress(el, cb, { ms = 500, tolerance = 10, mouse = true } = {}) {
  if (!el || typeof cb !== 'function') return () => {};
  let timer = 0;
  let startX = 0, startY = 0, pid = null;
  let fired = false;
  const cancel = () => { if (timer) clearTimeout(timer); timer = 0; pid = null; };
  const down = (e) => {
    if (e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && (!mouse || e.button !== 0)) return;
    cancel();
    fired = false;
    pid = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    timer = setTimeout(() => {
      timer = 0;
      fired = true;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) { /* ignore */ } }
      try { cb(e); } catch (err) { console.error(err); }
    }, ms);
  };
  const move = (e) => {
    if (!timer || e.pointerId !== pid) return;
    if (Math.abs(e.clientX - startX) > tolerance || Math.abs(e.clientY - startY) > tolerance) cancel();
  };
  const up = (e) => { if (e.pointerId === pid) cancel(); };
  const click = (e) => {
    if (fired) { fired = false; e.preventDefault(); e.stopImmediatePropagation(); }
  };
  const ctx = (e) => { if (timer || fired) e.preventDefault(); };
  const offs = [
    on(el, 'pointerdown', down),
    on(el, 'pointermove', move),
    on(el, 'pointerup', up),
    on(el, 'pointercancel', cancel),
    on(el, 'pointerleave', up),
    on(el, 'click', click, true),
    on(el, 'contextmenu', ctx),
  ];
  return () => { cancel(); offs.forEach((f) => f()); };
}

// ---------------------------------------------------------------------------
// Back button / swipe-back

/**
 * Let Android Back / iOS swipe-back close a transient surface (ribbon sheet or dropdown, storyboard
 * popover, inline text editor, pseudo full screen…) instead of leaving the app. Uses the one shared
 * history back stack owned by app.dialogs (public pushBack/releaseBack, or the older
 * _pushBack/_releaseBack), so dialogs and these surfaces unwind in the right order.
 *   const release = backGuard(app, () => close({ fromBack: true }));
 *   …later, when the surface closes any other way: release();
 * onBack runs at most once; release() after Back (or twice) is a no-op. Without a back stack
 * (desktop, old dialogs module) it does nothing and release() is a no-op.
 */
export function backGuard(app, onBack) {
  const d = app && app.dialogs;
  if (!d || typeof onBack !== 'function') return () => {};
  const push = typeof d.pushBack === 'function' ? d.pushBack : (typeof d._pushBack === 'function' ? d._pushBack : null);
  const rel = typeof d.releaseBack === 'function' ? d.releaseBack : (typeof d._releaseBack === 'function' ? d._releaseBack : null);
  if (!push) return () => {};
  let done = false;
  let token = null;
  try {
    token = push.call(d, () => {
      if (done) return;
      done = true;
      try { onBack(); } catch (err) { console.error(err); }
    });
  } catch (_) { token = null; }
  return () => {
    if (done) return;
    done = true;
    if (token == null || !rel) return;
    // Releasing steps history back. Do it after the current task: a surface that closes because
    // the next one opens (menu item → dialog, one sheet → another) pushes its entry first, and a
    // history.back() queued *before* that pushState can land one entry too far (out of the app).
    setTimeout(() => { try { rel.call(d, token); } catch (_) { /* ignore */ } }, 0);
  };
}

/** Format seconds for compact UI fields: 7 → "7.00", 65.4 → "1:05.40". */
export function formatSeconds(t, digits = 2) {
  const v = Number.isFinite(t) && t > 0 ? t : 0;
  if (v < 60) return v.toFixed(digits);
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${m}:${s.toFixed(digits).padStart(digits + 3, '0')}`;
}

/** Unique id for aria relationships. */
let _idn = 0;
export function domId(prefix = 'mm') { _idn += 1; return `${prefix}-${_idn.toString(36)}`; }
