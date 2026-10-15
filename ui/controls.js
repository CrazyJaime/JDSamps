// ui/controls.js — knob, fader, pad and segmented controls tuned for live use:
// vertical drag (Shift = fine), wheel, double-click = default, arrow keys when focused.
// External updates are ignored while the user is dragging and for HOLD_MS after any local change
// (unless the echo matches what was sent), so stale engine snapshots never fight the hand.
import { clamp } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const ARC = 270;
const HOLD_MS = 250;     // ignore engine values this long after a local change
const WHEEL_PX = 48;     // wheel travel per step: about 50 px of trackpad, one notch of a mouse
const LINE_PX = 16;      // deltaMode 1 (lines) in pixels
const CLICK_SLOP = 3;    // px a press may wander and still count as a click for double-click reset
const polar = (cx, cy, r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
function arcPath(r, from, to) {
  const [x1, y1] = polar(32, 32, r, from), [x2, y2] = polar(32, 32, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0, sweep = to > from ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

class Continuous {
  /** o.wheel = false: no scroll-wheel control; o.reset = false: no double-click reset. */
  constructor(el, o) {
    this.el = el;
    this.o = { min: 0, max: 1, step: 0.01, fine: 0.002, format: (v) => v.toFixed(2), wheel: true, reset: true, ...o };
    this.value = this.o.value ?? this.o.def ?? this.o.min;
    this.dragging = false;
    this.sent = this.value;
    this.heldUntil = 0;
    this.wheelPx = 0;
    this.wheelAt = 0;
    el.setAttribute('role', 'slider');
    el.tabIndex = 0;
    el.setAttribute('aria-label', this.o.label || '');
    el.setAttribute('aria-valuemin', String(this.o.min));
    el.setAttribute('aria-valuemax', String(this.o.max));
    // Double-click resets only when both presses were still clicks: a tap followed by a quick
    // re-grab and drag also raises dblclick, and must never throw the control to its default.
    let press = null;
    const dirty = [true, true];
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      press = { x: e.clientX, y: e.clientY, v: this.value };
      dirty.shift(); dirty.push(false);
    });
    el.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP) dirty[1] = true;
    });
    const release = () => { if (press && this.value !== press.v) dirty[1] = true; press = null; };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('dblclick', () => {
      if (this.o.reset && !dirty[0] && !dirty[1]) this.commit(this.o.def ?? this.o.min);
    });
    if (this.o.wheel) el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('keydown', (e) => {
      const big = (this.o.max - this.o.min) / 10;
      const d = { ArrowUp: this.o.step, ArrowRight: this.o.step, ArrowDown: -this.o.step, ArrowLeft: -this.o.step, PageUp: big, PageDown: -big }[e.key];
      if (d != null) { e.preventDefault(); e.stopPropagation(); this.commit(this.value + (e.shiftKey ? d / 5 : d)); }
      else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); this.commit(this.o.min); }
      else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); this.commit(this.o.max); }
    });
  }

  /**
   * Vertical wheel only: a sideways swipe is not taken (no preventDefault), so it still scrolls
   * the deck row. Browsers deliver Shift+wheel as deltaX, so with Shift (fine) either axis counts.
   * Small trackpad deltas accumulate; at most one step per event, so a mouse notch is one step.
   */
  wheel(e) {
    let d = e.deltaY;
    if (Math.abs(d) <= Math.abs(e.deltaX)) { if (!e.shiftKey) return; d = e.deltaX; }
    if (!d) return;
    e.preventDefault();
    const px = d * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? window.innerHeight || 800 : 1);
    const now = performance.now();
    if (now - this.wheelAt > 250 || Math.sign(px) !== Math.sign(this.wheelPx)) this.wheelPx = 0;
    this.wheelAt = now;
    this.wheelPx += px;
    if (Math.abs(this.wheelPx) < WHEEL_PX) return;
    this.wheelPx = 0;
    this.commit(this.value - Math.sign(px) * (e.shiftKey ? this.o.fine : this.o.step));
  }

  commit(v) {
    const nv = clamp(v, this.o.min, this.o.max);
    if (nv === this.value) return;
    this.value = nv;
    this.sent = nv;
    this.heldUntil = performance.now() + HOLD_MS;
    this.render();
    this.o.onChange && this.o.onChange(nv);
  }

  /** Engine value. Ignored mid-drag, and just after a local change until it echoes back. */
  set(v) {
    if (this.dragging || typeof v !== 'number') return;
    if (this.heldUntil) {
      if (Math.abs(v - this.sent) <= 1e-9 * (this.o.max - this.o.min)) { this.heldUntil = 0; return; }
      if (performance.now() < this.heldUntil) return;
      this.heldUntil = 0;
    }
    if (v === this.value) return;
    this.value = clamp(v, this.o.min, this.o.max);
    this.render();
  }

  aria() {
    this.el.setAttribute('aria-valuenow', this.value.toFixed(3));
    this.el.setAttribute('aria-valuetext', this.o.format(this.value));
  }

  /** Pointer drag along an axis: pixelsForRange = drag distance for the full range. */
  bindDrag(target, axis, pixelsForRange) {
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.el.classList.add('active');
      let last = axis === 'y' ? e.clientY : e.clientX;
      const move = (ev) => {
        const pos = axis === 'y' ? ev.clientY : ev.clientX;
        const px = axis === 'y' ? last - pos : pos - last;
        last = pos;
        const range = this.o.max - this.o.min;
        this.commit(this.value + (px / pixelsForRange) * range * (ev.shiftKey ? 0.15 : 1));
      };
      const up = () => {
        this.dragging = false;
        this.el.classList.remove('active');
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  }
}

export class Knob extends Continuous {
  constructor(el, o) {
    super(el, o);
    el.classList.add('knob');
    const svg = svgEl('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' });
    this.track = svgEl('path', { class: 'track', d: arcPath(26, -ARC / 2, ARC / 2) });
    this.arc = svgEl('path', { class: 'val' });
    const cap = svgEl('circle', { class: 'cap', cx: 32, cy: 32, r: 17 });
    this.ptr = svgEl('line', { class: 'ptr', x1: 32, y1: 32, x2: 32, y2: 17 });
    svg.append(this.track, this.arc, cap, this.ptr);
    const label = document.createElement('span'); label.className = 'k-label'; label.textContent = this.o.label || '';
    this.readout = document.createElement('span'); this.readout.className = 'k-value';
    el.replaceChildren(svg, label, this.readout);
    this.bindDrag(svg, 'y', 180);
    this.render();
  }
  render() {
    const t = (this.value - this.o.min) / (this.o.max - this.o.min);
    const ang = -ARC / 2 + t * ARC;
    const start = this.o.bipolar ? 0 : -ARC / 2;
    this.arc.setAttribute('d', Math.abs(ang - start) < 0.5 ? '' : arcPath(26, Math.min(start, ang), Math.max(start, ang)));
    this.ptr.setAttribute('transform', `rotate(${ang.toFixed(1)} 32 32)`);
    this.readout.textContent = this.o.format(this.value);
    this.el.classList.toggle('atdef', this.value === this.o.def);
    this.aria();
  }
}

export class Fader extends Continuous {
  constructor(el, o) {
    super(el, { orientation: 'vertical', ...o });
    const rail = document.createElement('div'); rail.className = 'rail';
    this.thumb = document.createElement('div'); this.thumb.className = 'thumb';
    const parts = [rail];
    if (this.o.center) { const c = document.createElement('div'); c.className = 'center'; parts.push(c); }
    if (this.o.ticks) {
      for (const t of this.o.ticks) {
        const k = document.createElement('div'); k.className = 'tick';
        k.style.top = `calc(0.8rem + (100% - 1.6rem) * ${1 - t})`;
        parts.push(k);
      }
    }
    parts.push(this.thumb);
    if (this.o.readout) { this.readout = document.createElement('span'); this.readout.className = 'readout'; parts.push(this.readout); }
    el.replaceChildren(...parts);
    el.setAttribute('aria-orientation', this.o.orientation);
    const vertical = this.o.orientation === 'vertical';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.dragging = true;
      el.classList.add('active');
      const span = Math.max(40, (vertical ? el.clientHeight : el.clientWidth) - 24);
      let last = vertical ? e.clientY : e.clientX;
      const move = (ev) => {
        const pos = vertical ? ev.clientY : ev.clientX;
        const px = vertical ? last - pos : pos - last;
        last = pos;
        this.commit(this.value + (px / span) * (this.o.max - this.o.min) * (ev.shiftKey ? 0.15 : 1));
      };
      const up = () => {
        this.dragging = false;
        el.classList.remove('active');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    this.render();
  }
  render() {
    const t = (this.value - this.o.min) / (this.o.max - this.o.min);
    if (this.o.orientation === 'vertical') this.thumb.style.top = `calc(0.8rem + (100% - 1.6rem) * ${(1 - t).toFixed(4)})`;
    else this.thumb.style.left = `calc(0.6rem + (100% - 1.2rem) * ${t.toFixed(4)})`;
    if (this.readout) this.readout.textContent = this.o.format(this.value);
    this.aria();
  }
}

/**
 * Pad / hold button. latch=true: a tap (<250 ms) toggles, a hold is momentary.
 * latch=false: momentary only (down → on, up → off). Keyboard Space/Enter act like the pointer.
 */
export function bindPad(el, { onDown, onUp, onLatch, latch = false }) {
  let on = false, downAt = 0, wasOn = false, active = false;
  const press = () => {
    if (active) return;
    active = true;
    downAt = performance.now();
    wasOn = on;
    if (!latch || !on) { on = true; onDown && onDown(); }
    paint();
  };
  const release = () => {
    if (!active) return;
    active = false;
    const held = performance.now() - downAt >= 250;
    if (!latch || held || wasOn) { on = false; onUp && onUp(); }
    else if (onLatch) onLatch(); // a tap: stays on, no longer held
    paint();
  };
  const paint = () => { el.classList.toggle('on', on); el.setAttribute('aria-pressed', on ? 'true' : 'false'); };
  el.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); el.setPointerCapture(e.pointerId); press(); });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); press(); } });
  el.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); release(); } });
  return {
    press,
    release,
    setOn(v) { if (active) return; on = !!v; paint(); },
  };
}

export function bindSeg(el, { onSelect }) {
  const buttons = Array.from(el.querySelectorAll('button[data-v]'));
  const parse = (s) => (s === 'true' ? true : s === 'false' ? false : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s);
  for (const b of buttons) b.addEventListener('click', () => onSelect(parse(b.dataset.v)));
  return {
    set(value) {
      for (const b of buttons) {
        const v = parse(b.dataset.v) === value ? 'true' : 'false';
        if (b.getAttribute('aria-pressed') !== v) b.setAttribute('aria-pressed', v);
      }
    },
  };
}
