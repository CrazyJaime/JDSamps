// ui/hold.js — press-and-hold guard for destructive buttons (eject, stop recording).
// Primary pointer button (captured) or Enter/Space on the focused button; the button carries
// .holding while the hold runs, and CSS draws the progress over --hold.

/**
 * @param {HTMLElement} el
 * @param {{ms:number, onHold:()=>void, onShort?:()=>void, needsHold?:()=>boolean, onPress?:()=>void}} o
 *   needsHold() is asked on each press; when it returns false, onPress fires at once instead.
 * @returns {{start:()=>void, cancel:(short?:boolean)=>void}} for keyboard shortcuts that drive the same hold.
 */
export function bindHold(el, { ms, onHold, onShort, needsHold = () => true, onPress }) {
  let timer = 0;
  const start = () => {
    if (timer) return;
    if (!needsHold()) { onPress && onPress(); return; }
    el.style.setProperty('--hold', `${ms}ms`);
    el.classList.add('holding');
    timer = setTimeout(() => { timer = 0; el.classList.remove('holding'); onHold(); }, ms);
  };
  const cancel = (short = false) => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    el.classList.remove('holding');
    if (short && onShort) onShort();
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || el.disabled) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    start();
  });
  el.addEventListener('pointerup', () => cancel(true));
  el.addEventListener('pointercancel', () => cancel());
  el.addEventListener('lostpointercapture', () => cancel());
  // Capture suppresses pointerleave, so dragging off the button is checked by position.
  el.addEventListener('pointermove', (e) => {
    if (!timer) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) cancel();
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (!e.repeat) start();
  });
  el.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') cancel(true); });
  el.addEventListener('blur', () => cancel());
  return { start, cancel };
}
