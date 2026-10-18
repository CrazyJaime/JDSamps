// agent/agent-main.js — JD Samps player-assist agent (page MAIN world, every frame, document_start).
// Registers media elements the page plays (including detached `new Audio()` objects) and, only
// when a deck asks, sets their playbackRate (with preservesPitch=false) so the engine can refill a
// deck's buffer, or pauses them all when the deck is ejected. While a deck is capturing the tab
// it also drops pauses the page's own script asks for, so a site that allows one playing track
// at a time cannot stop a deck's source. Silent until its first command.
// Talks to agent-relay.js through window CustomEvents carrying JSON strings (objects do not cross
// JS worlds reliably), on a channel name the relay picks at random and hands over at
// document_start, before any page script runs.
// Leaves no global behind and keeps its wrappers looking native, so pages cannot fingerprint it.
(() => {
  const HELLO = 'media-channel';

  // Per element: the page's own settings before a deck touched it, recent rate changes the page
  // made itself, and whether the agent gave the element back to a page that insists on its rate.
  const info = new WeakMap();
  let refs = [], pruneAt = 256;
  // cmdAt: when the last rate command came (the agent lets go LET_GO ms after it); letGo: when
  // (wall-clock ms) it last let go by itself, until the next command.
  const st = { active: false, enforcing: false, target: 1, seq: 0, dog: 0, cmdAt: 0, letGo: 0 };
  // The pause guard, on from the `isolate` command (a deck is capturing this tab) until the deck
  // lets the tab go: a pause the page's own script asks for is dropped. told: the one report that
  // the site keeps pausing anyway.
  const iso = { on: false, told: false };
  // Statuses up: the last one sent and when, and whether a newer one is waiting.
  const out = { last: '', at: -1e9, dirty: false, timer: 0, queued: false };

  const live = () => { refs = refs.filter((r) => { const el = r.deref(); return !!el && (el.isConnected || !!el.currentSrc); }); return refs.map((r) => r.deref()); };
  let chan = null;
  const emit = (s) => { if (chan) window.dispatchEvent(new CustomEvent(`s${chan}`, { detail: s })); };

  /** Audible: a player the user hears, or would hear if it ran. `audible` below counts these. */
  const heard = (el) => !el.muted && el.volume > 0;

  function status() {
    const els = live();
    let playing = false, audible = 0, main = null;
    for (const el of els) {
      if (el.paused) continue;
      playing = true;
      if (heard(el)) { if (!audible++) main = el; } else if (!audible) main = el;
    }
    return {
      t: 'status', hasMedia: els.length > 0, playing, rate: main ? main.playbackRate : 1, preservesPitch: main ? main.preservesPitch !== false : true,
      muted: main ? main.muted : false, volume: main ? main.volume : 1, audible, count: els.length, seq: st.seq,
      ...(st.letGo ? { selfReleased: true, releasedAt: st.letGo } : {}),
    };
  }

  // Chrome throttles timers in background tabs (to 1 Hz, then once a minute) but not events, so no
  // status waits on a timer when an event can carry it. A command is answered at once, from its own
  // message event (send). Other changes (media events) go out at most four times a second: one
  // inside that window waits for the next event (pump runs on every media event, timeupdate
  // included, and on every command), and a timer only covers the case where nothing else happens.
  function send() {
    out.dirty = false;
    const s = JSON.stringify(status());
    if (s === out.last) return;
    out.last = s; out.at = performance.now();
    emit(s);
  }
  function pump() {
    if (!out.dirty || out.queued) return;
    const wait = out.at + 250 - performance.now();
    if (wait <= 0) { out.queued = true; queueMicrotask(() => { out.queued = false; if (out.dirty) send(); }); }
    else if (!out.timer) out.timer = setTimeout(() => { out.timer = 0; pump(); }, wait);
  }
  function report() {
    if (!st.active) return;
    out.dirty = true;
    pump();
  }

  // The engine re-sends the rate at least every second while it needs it: LET_GO without it, let
  // go, and say so (selfReleased), so the engine starts again from 1x instead of taking it for a
  // refusal. LET_GO rides out an engine whose main thread stalls for seconds; a dead engine is let
  // go of at once (the relay's port drops). Checked on every event and command, so a throttled
  // timer can only make the release late, and the timer itself re-checks the clock, so a stale
  // one never lets go of a rate still in use.
  const LET_GO = 10000;
  function watchdog() {
    if (!st.enforcing) return;
    const left = st.cmdAt + LET_GO - performance.now();
    if (left <= 0) { st.letGo = performance.timeOrigin + performance.now(); release(); }
    else if (!st.dog) st.dog = setTimeout(() => { st.dog = 0; watchdog(); }, left);
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
    watchdog();
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

  // Media events matter only once a deck talks to the page (statuses, enforcing, the watchdog):
  // until the first command the agent adds no listener to any element, and from then on one
  // handler serves every event of every element. Per-element listeners and closures cost about
  // 400 B of heap per element a page ever plays, and pages that are never decked are almost all.
  const EVENTS = ['play', 'playing', 'pause', 'emptied', 'loadedmetadata', 'volumechange', 'timeupdate'];
  function onMedia(e) {
    watchdog();
    if (e.type === 'timeupdate') { pump(); return; } // about 4 a second while playing, timers or not
    if (st.enforcing && (e.type === 'playing' || e.type === 'loadedmetadata')) apply(e.currentTarget);
    report();
  }
  function wire(el) {
    el.addEventListener('ratechange', onRate);
    for (const ev of EVENTS) el.addEventListener(ev, onMedia);
  }
  function activate() {
    if (st.active) return;
    st.active = true;
    for (const el of live()) wire(el);
  }

  function register(el) {
    if (!(el instanceof HTMLMediaElement) || info.has(el)) return;
    info.set(el, { base: null, ext: [], off: false, pst: [], pauseOff: false });
    refs.push(new WeakRef(el));
    // Pages that are never decked never call live(): drop collected elements here as well.
    if (refs.length >= pruneAt) { refs = refs.filter((r) => r.deref() !== undefined); pruneAt = Math.max(256, 2 * refs.length); }
    if (!st.active) return;
    wire(el);
    watchdog();
    if (st.enforcing) apply(el);
    report();
  }

  const scan = () => { try { for (const el of document.querySelectorAll('audio, video')) register(el); } catch (_) {} };

  function release() {
    clearTimeout(st.dog);
    st.dog = 0; st.enforcing = false; st.target = 1;
    for (const el of live()) {
      const x = info.get(el);
      if (!x) continue;
      if (x.base && !x.off) restore(el, x);
      x.base = null; x.ext = []; x.off = false;
    }
    report();
  }

  // The tab has just been loaded onto a deck, so its audio goes to the capture and not to the
  // speakers: starting its player is silent to the user, and it fills the deck's buffer (the deck
  // itself stays cued). Nothing but the playing state is touched — no rate, no preservesPitch, no
  // enforcing: a start is not an assist command, and it must not engage player assist.
  function startPlayback() {
    const answer = (count, why) => { emit(JSON.stringify({ t: 'started', count, why })); };
    const els = live();
    if (els.some((el) => !el.paused && heard(el))) { answer(0, 'playing'); return; } // nothing was needed
    const cands = els.filter((el) => el.paused && heard(el));
    if (!cands.length) { answer(0, 'none'); return; }
    // Several to choose from: the longest is the track, the short ones are jingles and adverts.
    // A tie (or lengths the page has not loaded yet) is too close to call, so nothing is started.
    const len = (el) => (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0);
    const [first, second] = [...cands].sort((a, b) => len(b) - len(a));
    if (second && len(first) <= len(second)) { answer(0, 'ambiguous'); return; }
    // POSITION POLICY, the one place it lives: the playhead is left where the page had it, so a
    // track parked half-way in resumes from there (`first.currentTime = 0;` here would rewind).
    // play() is rejected when the page's autoplay policy refuses it (this call carries no user
    // activation of its own) or the media will not load. Said once, never retried.
    let p;
    try { p = nativePlay.call(first); } catch (_) { answer(0, 'refused'); return; }
    if (!p || typeof p.then !== 'function') { answer(first.paused ? 0 : 1, first.paused ? 'refused' : 'started'); return; }
    p.then(() => { answer(1, 'started'); }, () => { answer(0, 'refused'); });
  }

  // Wrappers answer toString() like the built-ins they replace.
  const native = new WeakMap(), fnToString = Function.prototype.toString;
  const asNative = { toString() { return native.has(this) ? native.get(this) : fnToString.call(this); } }.toString;
  const disguise = (fn) => {
    native.set(fn, `function ${fn.name}() { [native code] }`);
    Object.defineProperty(fn, 'toString', { value: asNative, writable: true, configurable: true });
    return fn;
  };
  disguise(asNative);

  const proto = HTMLMediaElement.prototype, nativePause = proto.pause, nativePlay = proto.play;
  for (const name of ['play', 'pause', 'load']) {
    const orig = proto[name], guarded = name === 'pause';
    proto[name] = disguise({ [name](...args) {
      try { register(this); } catch (_) {}
      if (guarded && blockPause(this)) return undefined;
      return orig.apply(this, args);
    } }[name]);
  }

  // ---------------------------------------------------------------- pause guard
  // Sites that allow one playing track at a time stop their other tabs, and whatever they use to
  // decide, they stop them by calling pause(). While a deck is capturing this tab that pause is
  // dropped: a pause from page script keeps no transient user activation, a pause the user makes
  // on the page does, and the agent's own pauses never come through this wrapper at all (they use
  // nativePause). As with a page that insists on its playback rate, the agent stops resisting
  // after PAUSE_TRIES attempts in PAUSE_WINDOW ms and says so once, so a site that keeps trying
  // and the agent never ping-pong. Wired at document_start, the only moment the prototypes can
  // still be taken before page script, and inert until the deck says `isolate`.
  const PAUSE_TRIES = 3, PAUSE_WINDOW = 2000;
  const userDid = () => { try { return !!(navigator.userActivation && navigator.userActivation.isActive); } catch (_) { return false; } };
  function blockPause(el) {
    if (!iso.on || userDid()) return false;
    let x;
    try { if (el.paused) return false; x = info.get(el); } catch (_) { return false; }
    if (!x || x.pauseOff) return false;
    const t = performance.now();
    x.pst = x.pst.filter((v) => t - v < PAUSE_WINDOW);
    x.pst.push(t);
    if (x.pst.length < PAUSE_TRIES) return true;
    x.pauseOff = true;
    if (!iso.told) { iso.told = true; emit(JSON.stringify({ t: 'external-pause' })); }
    return false;
  }

  // Tearing the source out stops a player as surely as pausing it, and costs one more wrapper.
  // Only emptying is blocked: a new source is a track change the page is entitled to make, and
  // load() is how a player re-buffers or moves to the next track, so both are left alone.
  // Taking the element out of the document is left alone as well: Chrome pauses it with its own
  // internal steps, which no JS wrapper is on the path of, and putting it back and playing it
  // again would be exactly the fight loop this guard exists to avoid.
  for (const prop of ['src', 'srcObject']) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.configurable) continue;
    const set = Object.getOwnPropertyDescriptor({ set [prop](v) {
      if (iso.on && (v == null || v === '')) {
        try { register(this); } catch (_) {}
        if (blockPause(this)) return;
      }
      d.set.call(this, v);
    } }, prop).set;
    Object.defineProperty(proto, prop, { ...d, set: disguise(set) });
  }

  /** A deck started capturing this tab (or stopped): put the guard up, or take it down. */
  function setIsolate(on) {
    if (iso.on === on) return;
    iso.on = on;
    if (!on) return;
    iso.told = false;
    for (const el of live()) { const x = info.get(el); if (x) { x.pst = []; x.pauseOff = false; } }
  }

  // Players poll currentTime/paused for their progress bars: that finds elements that were already
  // playing before a late injection (tabs open before install, which get the agent when they are
  // loaded on a deck, i.e. just before the first command). Patched only from the first command on.
  let polled = false;
  function watchPolling() {
    if (polled) return;
    polled = true;
    for (const prop of ['currentTime', 'paused']) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get || !d.configurable) continue;
      const get = Object.getOwnPropertyDescriptor({ get [prop]() { if (!info.has(this)) { try { register(this); } catch (_) {} } return d.get.call(this); } }, prop).get;
      Object.defineProperty(proto, prop, { ...d, get: disguise(get) });
    }
  }

  // Channel handshake: take the first offer (the relay's), then stop listening. Ask once in case
  // the relay ran first.
  function onOffer(e) {
    if (chan || e.defaultPrevented || typeof e.detail !== 'string' || !/^[0-9a-f]{32}$/.test(e.detail)) return;
    e.preventDefault();
    chan = e.detail;
    window.removeEventListener(HELLO, onOffer);
    window.addEventListener(`c${chan}`, onCommand);
  }
  window.addEventListener(HELLO, onOffer);
  window.dispatchEvent(new CustomEvent(HELLO));

  function onCommand(e) {
    if (typeof e.detail !== 'string' || e.detail.length > 200) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    const seq = Number.isSafeInteger(m.seq) && m.seq >= 0 ? m.seq : null;
    if (m.t === 'query' || m.t === 'rate' || m.t === 'release') watchPolling();
    if (m.t === 'query') {
      // Always answered, and at once.
      watchdog();
      activate(); scan();
      out.last = '';
      send();
    } else if (m.t === 'rate') {
      if (typeof m.rate !== 'number' || !Number.isFinite(m.rate) || m.rate < 0.5 || m.rate > 2) return;
      activate();
      // After letting go by itself the agent takes the page again only on a new command: a
      // keep-alive of the old one (an engine back from a stall) is answered with the status that
      // says it let go, and the engine starts again from 1x.
      if (st.letGo && seq != null && seq === st.seq) { send(); return; }
      st.letGo = 0;
      // A new command takes back elements the agent gave up on; a keep-alive (same rate and seq) does not.
      const fresh = m.rate !== st.target || (seq != null && seq !== st.seq);
      st.target = m.rate; st.enforcing = true;
      if (seq != null) st.seq = seq;
      st.cmdAt = performance.now();
      watchdog();
      scan();
      for (const el of live()) {
        const x = info.get(el);
        if (fresh && x) { x.off = false; x.ext = []; }
        apply(el);
      }
      send(); // the confirmation (it echoes seq), from this event: no timer can hold it back
    } else if (m.t === 'release') {
      if (seq != null) st.seq = seq;
      st.letGo = 0;
      release();
      send();
    } else if (m.t === 'isolate') {
      // A deck started capturing this tab (on) or stopped (off). Carries no seq: it is not part
      // of the rate conversation and must not disturb it.
      if (typeof m.on === 'boolean') setIsolate(m.on);
    } else if (m.t === 'stop') {
      // The deck is ejecting this tab: once its capture goes, the page plays out of the speakers.
      // Give the page its own rate back, pause every player, and say how many of them were heard
      // (0: nothing to pause here, so the tab gets muted instead).
      if (seq != null) st.seq = seq;
      st.letGo = 0;
      setIsolate(false); // the tab is leaving the deck: it is its site's again
      release();
      scan();
      let count = 0;
      for (const el of live()) {
        if (el.paused) continue;
        const was = heard(el);
        try { nativePause.call(el); } catch (_) { continue; }
        if (was && el.paused) count++;
      }
      emit(JSON.stringify({ t: 'stopped', count }));
    } else if (m.t === 'start') {
      // A deck has just taken this tab: start the player the DJ forgot to start (see startPlayback).
      scan();
      startPlayback();
    }
  }
})();
