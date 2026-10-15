// ui/keys.js — performance keyboard map (physical keys via e.code).
// Captured at the window so a focused button never also reacts to Space.

const ROLL = { KeyV: 0.125, KeyB: 0.25, KeyN: 0.5, KeyM: 1 };
const KILL = { KeyQ: 'kill.hi', KeyA: 'kill.mid', KeyZ: 'kill.low' };

export function bindKeys({ getStrip, selectSlot, conn, master, toggleHelp, closePanels }) {
  const held = new Map();
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  // Tap = toggle, hold ≥ 250 ms = momentary (same feel as the on-screen pads).
  const latchDown = (code, strip, key) => {
    const wasOn = !!strip.d.params[key];
    held.set(code, { at: performance.now(), wasOn, strip, key });
    if (!wasOn) strip.set(key, true);
  };
  const latchUp = (code) => {
    const h = held.get(code);
    if (!h) return;
    held.delete(code);
    if (h.wasOn || performance.now() - h.at >= 250) h.strip.set(h.key, false);
  };

  window.addEventListener('keydown', (e) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const c = e.code;
    if (/^Digit[1-6]$/.test(c)) { selectSlot(Number(c.slice(5))); e.preventDefault(); return; }
    if (c === 'Slash' && e.shiftKey) { toggleHelp(); e.preventDefault(); return; }
    if (c === 'Escape') { closePanels(); return; }
    if (c === 'BracketLeft') { master.nudgeXf(-0.05); e.preventDefault(); return; }
    if (c === 'BracketRight') { master.nudgeXf(0.05); e.preventDefault(); return; }
    if (c === 'Backslash') { master.setXf(0.5); e.preventDefault(); return; }
    if (c === 'KeyR' && e.shiftKey) { if (!e.repeat) master.toggleMixRec(); e.preventDefault(); return; }
    const strip = getStrip();
    if (!strip) return;
    const d = strip.d;
    const once = !e.repeat;
    let handled = true;
    switch (c) {
      case 'Space':
        if (once) strip.act(e.shiftKey ? 'syncPlay' : d.playing ? 'pause' : 'play');
        break;
      case 'KeyC': if (once) { held.set(c, { cue: true, strip }); strip.act('cueDown'); } break;
      case 'KeyS': if (once) { if (e.shiftKey) strip.act('master'); else strip.act('sync', { on: !d.sync.on }); } break;
      case 'KeyK': if (once) strip.toggle('keyLock'); break;
      case 'KeyT': if (once) { if (e.shiftKey) strip.act('tap1'); else strip.act('tap', { wallMs: performance.timeOrigin + performance.now() }); } break;
      case 'KeyQ': case 'KeyA': case 'KeyZ': if (once) latchDown(c, strip, KILL[c]); break;
      case 'KeyF': if (once) latchDown(c, strip, 'fx.on'); break;
      case 'KeyV': case 'KeyB': case 'KeyN': case 'KeyM': if (once) { held.set(c, { roll: true, strip }); strip.act('rollStart', { beats: ROLL[c] }); } break;
      case 'ArrowLeft': case 'ArrowRight': if (once) { held.set(c, { nudge: true, strip }); strip.act('nudge', { dir: c === 'ArrowLeft' ? -1 : 1, fine: e.shiftKey }); } break;
      case 'ArrowUp': strip.nudgePitch(0.001); break;
      case 'ArrowDown': strip.nudgePitch(-0.001); break;
      case 'KeyR': if (once) strip.act(d.rec.state === 'recording' ? 'recStop' : 'recStart'); break;
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
    else if (h.roll) { held.delete(c); h.strip.act('rollEnd'); }
    else if (h.nudge) { held.delete(c); h.strip.act('nudge', { dir: 0 }); }
    else latchUp(c);
    e.preventDefault();
  }, true);

  // Releasing everything if the window loses focus mid-hold avoids stuck rolls/nudges.
  window.addEventListener('blur', () => {
    for (const [c, h] of held) {
      if (h.cue) h.strip.act('cueUp');
      else if (h.roll) h.strip.act('rollEnd');
      else if (h.nudge) h.strip.act('nudge', { dir: 0 });
      else latchUp(c);
    }
    held.clear();
  });
}
