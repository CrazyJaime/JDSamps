// agent/agent-main.js — JD Samps player-assist agent (page MAIN world, every frame, document_start).
// Registers media elements the page plays (including detached `new Audio()` objects) and, only
// when a deck asks, sets their playbackRate (with preservesPitch=false) so the engine can refill a
// deck's buffer. Silent until its first command. Talks to agent-relay.js through window
// CustomEvents carrying JSON strings (objects do not cross JS worlds reliably).
(() => {
  const KEY = Symbol.for('jdsamps.agent');
  if (window[KEY]) return;
  Object.defineProperty(window, KEY, { value: true });

  // Per element: the page's own settings before a deck touched it, recent rate changes the page
  // made itself, and whether the agent gave the element back to a page that insists on its rate.
  const info = new WeakMap();
  let refs = [];
  const st = { active: false, enforcing: false, target: 1, seq: 0, dog: 0 };
  const out = { last: '', at: -1e9, timer: 0, queued: false };

  const live = () => { refs = refs.filter((r) => { const el = r.deref(); return !!el && (el.isConnected || !!el.currentSrc); }); return refs.map((r) => r.deref()); };
  const emit = (s) => window.dispatchEvent(new CustomEvent('jds-agent-status', { detail: s }));

  function status() {
    const els = live();
    let playing = false, audible = 0, main = null;
    for (const el of els) {
      if (el.paused) continue;
      playing = true;
      if (!el.muted && el.volume > 0) { if (!audible++) main = el; } else if (!audible) main = el;
    }
    return {
      t: 'status', hasMedia: els.length > 0, playing, rate: main ? main.playbackRate : 1, preservesPitch: main ? main.preservesPitch !== false : true,
      muted: main ? main.muted : false, volume: main ? main.volume : 1, audible, count: els.length, seq: st.seq,
    };
  }

  // At most four statuses a second, and only when something changed.
  function flush() {
    out.timer = 0; out.queued = false;
    const s = JSON.stringify(status());
    if (s === out.last) return;
    out.last = s; out.at = performance.now();
    emit(s);
  }
  function report() {
    if (!st.active || out.timer || out.queued) return;
    const wait = out.at + 250 - performance.now();
    if (wait > 0) out.timer = setTimeout(flush, wait);
    else { out.queued = true; queueMicrotask(flush); }
  }

  function apply(el) {
    const x = info.get(el);
    if (!x || x.off) return;
    try {
      if (!x.base) x.base = { rate: el.playbackRate, dflt: el.defaultPlaybackRate, pp: el.preservesPitch };
      if (el.preservesPitch !== false) el.preservesPitch = false;
      el.defaultPlaybackRate = st.target;
      if (Math.abs(el.playbackRate - st.target) > 1e-6) el.playbackRate = st.target;
    } catch (_) { /* element in a bad state: ignore */ }
  }

  /** Put back the page's own settings: its rate from before the deck, unless it has set a new one. */
  function restore(el, x, rate = x.base.rate) {
    try { el.defaultPlaybackRate = x.base.dflt; el.preservesPitch = x.base.pp; el.playbackRate = rate; } catch (_) {}
  }

  function onRate(e) {
    const el = e.currentTarget, x = info.get(el);
    if (st.enforcing && x && !x.off && Math.abs(el.playbackRate - st.target) > 1e-6) {
      // The page changed the rate itself. Re-apply (players reset it on load), but give the element
      // back to a page that keeps resetting it instead of fighting it forever.
      const t = performance.now();
      x.ext = x.ext.filter((v) => t - v < 2000);
      x.ext.push(t);
      if (x.ext.length < 3) apply(el);
      else {
        x.off = true;
        const rate = el.playbackRate;
        restore(el, x, rate);
        emit(JSON.stringify({ t: 'external-rate', rate }));
      }
    }
    report();
  }

  function register(el) {
    if (!(el instanceof HTMLMediaElement) || info.has(el)) return;
    info.set(el, { base: null, ext: [], off: false });
    refs.push(new WeakRef(el));
    el.addEventListener('ratechange', onRate);
    for (const ev of ['play', 'playing', 'pause', 'emptied', 'loadedmetadata', 'volumechange']) {
      el.addEventListener(ev, () => { if (st.enforcing && (ev === 'playing' || ev === 'loadedmetadata')) apply(el); report(); });
    }
    if (st.enforcing) apply(el);
    report();
  }

  const scan = () => { try { for (const el of document.querySelectorAll('audio, video')) register(el); } catch (_) {} };

  function release() {
    clearTimeout(st.dog);
    st.enforcing = false; st.target = 1;
    for (const el of live()) {
      const x = info.get(el);
      if (!x) continue;
      if (x.base && !x.off) restore(el, x);
      x.base = null; x.ext = []; x.off = false;
    }
    report();
  }

  const proto = HTMLMediaElement.prototype;
  for (const name of ['play', 'pause', 'load']) {
    const orig = proto[name];
    proto[name] = { [name](...args) { try { register(this); } catch (_) {} return orig.apply(this, args); } }[name];
  }
  // Players poll currentTime/paused for their progress bars: that finds elements that were
  // already playing before a late injection.
  for (const prop of ['currentTime', 'paused']) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (d && d.get && d.configurable) {
      Object.defineProperty(proto, prop, {
        ...d,
        get() { if (!info.has(this)) { try { register(this); } catch (_) {} } return d.get.call(this); },
      });
    }
  }

  window.addEventListener('jds-agent-cmd', (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 200) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    const seq = Number.isSafeInteger(m.seq) && m.seq >= 0 ? m.seq : null;
    if (m.t === 'query') {
      // Always answered, and at once.
      st.active = true; scan();
      clearTimeout(out.timer);
      Object.assign(out, { last: '', at: -1e9, timer: 0 });
      report();
    } else if (m.t === 'rate') {
      if (typeof m.rate !== 'number' || !Number.isFinite(m.rate) || m.rate < 0.5 || m.rate > 2) return;
      // A new command takes back elements the agent gave up on; a keep-alive (same rate and seq) does not.
      const fresh = m.rate !== st.target || (seq != null && seq !== st.seq);
      st.active = true; st.target = m.rate; st.enforcing = true;
      if (seq != null) st.seq = seq;
      // The engine re-sends the rate at least every second while it needs it: without that, let go.
      clearTimeout(st.dog);
      st.dog = setTimeout(release, 3000);
      scan();
      for (const el of live()) {
        const x = info.get(el);
        if (fresh && x) { x.off = false; x.ext = []; }
        apply(el);
      }
      report();
    } else if (m.t === 'release') {
      if (seq != null) st.seq = seq;
      release();
    }
  });
})();
