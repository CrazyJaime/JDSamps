// agent/agent-main.js — JD Samps player-assist agent (page MAIN world, every frame, document_start).
// Registers media elements the page plays (including detached `new Audio()` objects) and, only
// when a deck asks, sets their playbackRate (with preservesPitch=false) so the engine can refill a
// deck's buffer. Silent until its first command. Talks to agent-relay.js through window
// CustomEvents carrying JSON strings (objects do not cross JS worlds reliably).
(() => {
  const KEY = Symbol.for('jdsamps.agent');
  if (window[KEY]) return;
  Object.defineProperty(window, KEY, { value: true });

  const seen = new WeakSet();
  let refs = [];
  const st = { active: false, enforcing: false, target: 1, selfSet: 0, queued: false };

  const live = () => { refs = refs.filter((r) => { const el = r.deref(); return !!el && (el.isConnected || !!el.currentSrc); }); return refs.map((r) => r.deref()); };
  const emit = (m) => window.dispatchEvent(new CustomEvent('jds-agent-status', { detail: JSON.stringify(m) }));

  function report() {
    if (!st.active || st.queued) return;
    st.queued = true;
    queueMicrotask(() => {
      st.queued = false;
      const els = live();
      let playing = false, rate = 1, pp = true;
      for (const el of els) if (!el.paused) { playing = true; rate = el.playbackRate; pp = el.preservesPitch !== false; }
      emit({ t: 'status', hasMedia: els.length > 0, playing, rate, preservesPitch: pp, count: els.length });
    });
  }

  function apply(el) {
    try {
      if (el.preservesPitch !== false) el.preservesPitch = false;
      el.defaultPlaybackRate = st.target;
      if (Math.abs(el.playbackRate - st.target) > 1e-6) { st.selfSet++; el.playbackRate = st.target; }
    } catch (_) { /* element in a bad state: ignore */ }
  }

  function onRate(e) {
    const el = e.currentTarget;
    if (st.selfSet > 0) { st.selfSet--; report(); return; }
    if (st.enforcing && Math.abs(el.playbackRate - st.target) > 1e-6) {
      if (st.active) emit({ t: 'external-rate', rate: el.playbackRate });
      apply(el);
    }
    report();
  }

  function register(el) {
    if (!(el instanceof HTMLMediaElement) || seen.has(el)) return;
    seen.add(el);
    refs.push(new WeakRef(el));
    el.addEventListener('ratechange', onRate);
    for (const ev of ['play', 'playing', 'pause', 'emptied', 'loadedmetadata']) {
      el.addEventListener(ev, () => { if (st.enforcing && (ev === 'playing' || ev === 'loadedmetadata')) apply(el); report(); });
    }
    if (st.enforcing) apply(el);
    report();
  }

  const scan = () => { try { for (const el of document.querySelectorAll('audio, video')) register(el); } catch (_) {} };

  const proto = HTMLMediaElement.prototype;
  const origPlay = proto.play;
  proto.play = function play(...args) { try { register(this); } catch (_) {} return origPlay.apply(this, args); };
  // Players poll currentTime/paused for their progress bars: that finds elements that were
  // already playing before a late injection.
  for (const prop of ['currentTime', 'paused']) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (d && d.get && d.configurable) {
      Object.defineProperty(proto, prop, {
        ...d,
        get() { if (!seen.has(this)) { try { register(this); } catch (_) {} } return d.get.call(this); },
      });
    }
  }

  window.addEventListener('jds-agent-cmd', (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 200) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'query') {
      st.active = true; scan(); report();
    } else if (m.t === 'rate') {
      if (typeof m.rate !== 'number' || !Number.isFinite(m.rate) || m.rate < 0.5 || m.rate > 2) return;
      st.active = true; st.target = m.rate; st.enforcing = true; scan();
      for (const el of live()) apply(el);
      report();
    } else if (m.t === 'release') {
      st.enforcing = false; st.target = 1;
      for (const el of live()) {
        try {
          el.defaultPlaybackRate = 1;
          if (el.playbackRate !== 1) { st.selfSet++; el.playbackRate = 1; }
          el.preservesPitch = true;
        } catch (_) {}
      }
      report();
    }
  });
})();
