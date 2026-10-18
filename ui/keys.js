// ui/keys.js — performance keyboard map (physical keys via e.code).
// Captured at the window so a focused button never also reacts to Space.

const ROLL = { KeyV: 0.125, KeyB: 0.25, KeyN: 0.5, KeyM: 1 };
const KILL = { KeyQ: 'kill.hi', KeyA: 'kill.mid', KeyZ: 'kill.low' };
const SLIDER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

export function bindKeys({ getStrip, selectSlot, conn, master, toggleHelp, closePanels }) {
  const held = new Map();
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  // Tap = toggle, hold ≥ 250 ms = momentary (same feel as the on-screen pads).
  const latchDown = (code, strip, key) => {
    const wasOn = !!strip.d.params[key];
    held.set(code, { at: performance.now(), wasOn, strip, key });
    if (!wasOn) strip.set(key, true, true); // held until the release decides
  };
  const latchUp = (code) => {
    const h = held.get(code);
    if (!h) return;
    held.delete(code);
    if (h.wasOn || performance.now() - h.at >= 250) h.strip.set(h.key, false);
    else h.strip.set(h.key, true); // a tap latches it on: no longer held
  };

  window.addEventListener('keydown', (e) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    // A focused knob or fader keeps its own arrow/Home/End/Page keys.
    if (SLIDER_KEYS.has(e.key) && e.target instanceof Element && e.target.closest('[role="slider"]')) return;
    // '?' by character, before the physical map: it is Shift+KeyM on AZERTY.
    if (e.key === '?') { toggleHelp(); e.preventDefault(); return; }
    const c = e.code;
    if (/^Digit[1-6]$/.test(c)) { selectSlot(Number(c.slice(5))); e.preventDefault(); return; }
    if (c === 'Escape') { closePanels(); return; }
    if (c === 'BracketLeft') { master.nudgeXf(-0.05); e.preventDefault(); return; }
    if (c === 'BracketRight') { master.nudgeXf(0.05); e.preventDefault(); return; }
    if (c === 'Backslash') { master.setXf(0.5); e.preventDefault(); return; }
    if (c === 'KeyR' && e.shiftKey) { if (!e.repeat) { held.set(c, { hold: master.recHold }); master.recHold.start(); } e.preventDefault(); return; }
    const strip = getStrip();
    if (!strip) return;
    const d = strip.d;
    const once = !e.repeat;
    let handled = true;
    switch (c) {
      case 'Space':
        if (once) strip.act(e.shiftKey ? 'syncPlay' : 'playToggle');
        break;
      case 'KeyC': if (once) { held.set(c, { cue: true, strip }); strip.act('cueDown'); } break;
      case 'KeyS': if (once) { if (e.shiftKey) strip.act('master'); else strip.act('sync', { on: !d.sync.on }); } break;
      case 'KeyK': if (once) strip.toggle('keyLock'); break;
      case 'KeyT': if (once) { if (e.shiftKey) strip.act('tap1'); else strip.act('tap', { wallMs: performance.timeOrigin + e.timeStamp }); } break;
      case 'KeyQ': case 'KeyA': case 'KeyZ': if (once) latchDown(c, strip, KILL[c]); break;
      case 'KeyF': if (once) latchDown(c, strip, 'fx.on'); break;
      case 'KeyV': case 'KeyB': case 'KeyN': case 'KeyM': if (once) { held.set(c, { roll: true, strip }); strip.rollDown(c, ROLL[c]); } break;
      case 'ArrowLeft': case 'ArrowRight': if (once) { held.set(c, { nudge: true, strip }); strip.nudgeDown(c, c === 'ArrowLeft' ? -1 : 1, e.shiftKey); } break;
      // Beat jump back / forward; with Shift, a smaller / bigger jump.
      case 'Comma': case 'Period': if (once) { const dir = c === 'Comma' ? -1 : 1; if (e.shiftKey) strip.jumpSize(dir); else strip.beatJump(dir); } break;
      case 'ArrowUp': strip.nudgePitch(0.001); break;
      case 'ArrowDown': strip.nudgePitch(-0.001); break;
      case 'KeyR': if (once) { held.set(c, { hold: strip.recHold }); strip.recHold.start(); } break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  window.addEventListener('keyup', (e) => {
    const c = e.code;
    if (c === 'Space') { if (!typing(e.target)) e.preventDefault(); return; }
    const h = held.get(c);
    if (!h) return;
    if (h.cue) { held.delete(c); h.strip.act('cueUp'); }
    else if (h.roll) { held.delete(c); h.strip.rollUp(c); }
    else if (h.nudge) { held.delete(c); h.strip.nudgeUp(c); }
    else if (h.hold) { held.delete(c); h.hold.cancel(true); }
    else latchUp(c);
    e.preventDefault();
  }, true);

  // Releasing everything if the window loses focus mid-hold avoids stuck rolls/nudges.
  window.addEventListener('blur', () => {
    for (const [c, h] of held) {
      if (h.cue) h.strip.act('cueUp');
      else if (h.roll) h.strip.rollUp(c);
      else if (h.nudge) h.strip.nudgeUp(c);
      else if (h.hold) h.hold.cancel();
      else latchUp(c);
    }
    held.clear();
  });
}
