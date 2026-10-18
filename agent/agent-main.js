// agent/agent-main.js — JD Samps player-assist agent (page MAIN world, every frame, document_start).
// Registers media elements the page plays (including detached `new Audio()` objects) and, only
// when a deck asks, sets their playbackRate (with preservesPitch=false) so the engine can refill a
// deck's buffer, or pauses them all when the deck is ejected. While a deck is capturing the tab
// it also drops pauses the page's own script asks for, so a site that allows one playing track
// at a time cannot stop a deck's source. On a deck's `tap` command it captures the media the
// page's player appends and hands it over as blob: URLs (see "page tap"). Silent until its
// first command.
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
  // A drive of the player (see "drive") has its own end, a stop or the port going away: the
  // watchdog leaves it alone.
  const LET_GO = 10000;
  function watchdog() {
    if (!st.enforcing || drv.mode) return;
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
        if (drv.mode === 'accelerate' && el === drv.el) { drv.state = 'refused'; tapDirty(); }
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
    if (tap.on) wireTap(el);
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

  // Wrappers answer Function.prototype.toString like the built-ins they replace: one patched
  // toString, itself native-looking, knows them all, so no wrapper carries an own toString; and
  // each wrapper takes the arity of the function it replaces. Own keys stay ['length', 'name'].
  const native = new WeakMap(), fnToString = Function.prototype.toString;
  const asNative = (() => { 'use strict'; return { toString() { return native.has(this) ? native.get(this) : fnToString.call(this); } }.toString; })();
  const disguise = (fn, orig) => {
    native.set(fn, `function ${fn.name}() { [native code] }`);
    if (orig && fn.length !== orig.length) Object.defineProperty(fn, 'length', { value: orig.length });
    return fn;
  };
  Function.prototype.toString = disguise(asNative, fnToString);

  const proto = HTMLMediaElement.prototype, nativePause = proto.pause, nativePlay = proto.play;
  for (const name of ['play', 'pause', 'load']) {
    const orig = proto[name], guarded = name === 'pause';
    proto[name] = disguise({ [name](...args) {
      try { register(this); } catch (_) {}
      if (guarded && blockPause(this)) return undefined;
      return orig.apply(this, args);
    } }[name], orig);
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
      if (tap.on) { try { register(this); noteWorker(v); } catch (_) {} }
    } }, prop).set;
    Object.defineProperty(proto, prop, { ...d, set: disguise(set, d.set) });
  }

  /** A deck started capturing this tab (or stopped): put the guard up, or take it down. */
  function setIsolate(on) {
    if (iso.on === on) return;
    iso.on = on;
    if (!on) return;
    iso.told = false;
    for (const el of live()) { const x = info.get(el); if (x) { x.pst = []; x.pauseOff = false; } }
  }

  // ---------------------------------------------------------------- page tap
  // A deck that wants the whole track turns the tap on ({t:'tap', on:true}). Then the agent copies
  // every buffer the page's player appends to a SourceBuffer (the byte layer), notes the media
  // URLs it fetches (the URL layer) and watches for protected or worker-hosted media (the element
  // layer). Bytes never cross to the relay: each captured part becomes a blob: URL minted here,
  // and only that string goes up. The wrappers go in at document_start, the only moment a player
  // that keeps its own reference to appendBuffer can still be caught, but until the first tap on
  // they only call the native, with one exception: each SourceBuffer's type and its latest init
  // segment (at most 256 KB) are kept, because a player appends its init once, at the start, and
  // media captured later cannot be decoded without it. Nothing else is copied, nothing minted, no
  // listener, no global.
  // Natives taken now, before page script can replace them.
  const U8 = Uint8Array, u8set = Object.getPrototypeOf(U8.prototype).set, isView = ArrayBuffer.isView;
  const abLen = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
  const Blob_ = Blob, URL_ = URL, Headers_ = Headers, mkUrl = URL.createObjectURL, rmUrl = URL.revokeObjectURL;
  const listen = EventTarget.prototype.addEventListener, unlisten = EventTarget.prototype.removeEventListener;
  const tagOf = (x) => Object.prototype.toString.call(x);
  // Brand check (never instanceof): an ArrayBuffer from another realm, an iframe's, is one too.
  const isAB = (x) => { try { abLen.call(x); return true; } catch (_) { return false; } };

  const CAP = 600 * 2 ** 20; // bytes held per frame; past it the tap gives up rather than grow
  const INIT_MAX = 256 * 1024; // the largest init segment kept while dormant
  const tap = { on: false, bytes: 0, seq: 0, nsb: 0, gen: 0, reqs: 0, infAt: 0, told: new Set(), mimes: new Set(), srcs: new Set() };
  const sbs = new WeakMap(); // SourceBuffer -> { i, mime, skip, init }
  let known = [], knownAt = 32; // WeakRefs to the SourceBuffers in sbs, for the tap to find them
  const wiredEls = new Set(), watched = new Set(); // what carries a tap listener this session
  const handed = new Set(); // blob: URLs handed to the engine: its to read until it says forget
  const xhrs = new WeakMap();
  let pend = [], urlq = []; // parts not handed over yet (bytes or a Blob), requests not reported yet
  const tp = { at: -1e9, dirty: false, timer: 0, queued: false, last: '' };

  const fourcc = (u, i) => String.fromCharCode(u[i], u[i + 1], u[i + 2], u[i + 3]);
  /** [kind, container] of an appended buffer, from its first bytes. */
  function sniff(u) {
    const box = u.length >= 8 ? fourcc(u, 4) : '';
    if (box === 'ftyp' || box === 'moov') return ['init', 'audio/mp4'];
    if (/^(styp|moof|sidx|emsg|prft|mdat|free|skip)$/.test(box)) return ['media', 'audio/mp4'];
    if (u[0] === 0x1a && u[1] === 0x45 && u[2] === 0xdf && u[3] === 0xa3) return ['init', 'audio/webm'];
    if (u[0] === 0x1f && u[1] === 0x43 && u[2] === 0xb6 && u[3] === 0x75) return ['media', 'audio/webm'];
    if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) return ['media', 'audio/mpeg'];
    if (u[0] === 0xff && (u[1] & 0xf6) === 0xf0) return ['media', 'audio/aac'];
    if (u[0] === 0xff && (u[1] & 0xe0) === 0xe0) return ['media', 'audio/mpeg'];
    return ['media', ''];
  }
  // A deck wants sound: a video-only SourceBuffer (by its type, or an MP4 init with no sound
  // track) is left alone, so a video site does not fill the tap with pictures.
  const AUDIO_CODEC = /mp4a|opus|vorbis|flac|mp3|ac-3|ec-3|alac/i;
  const videoMime = (m) => /^video\//i.test(m) && /codecs\s*=/i.test(m) && !AUDIO_CODEC.test(m);
  function videoInit(u) {
    let vide = false;
    for (let i = 4; i + 16 <= u.length && i < 65536; i++) {
      if (u[i] !== 0x68 || fourcc(u, i) !== 'hdlr') continue;
      const h = fourcc(u, i + 12);
      if (h === 'soun') return false;
      if (h === 'vide') vide = true;
    }
    return vide;
  }

  // The byte layer. The copy is made once the native call has taken the buffer: an append the
  // browser refuses is not captured, so a player retrying it is not captured twice.
  function recOf(sb, mime = '') {
    let rec = sbs.get(sb);
    if (!rec) {
      rec = { i: tap.nsb++, mime, skip: videoMime(mime), init: null };
      sbs.set(sb, rec);
      if (known.length >= knownAt) { known = known.filter((r) => r.deref() !== undefined); knownAt = Math.max(32, 2 * known.length); }
      known.push(new WeakRef(sb));
    }
    return rec;
  }
  /** A view of an appended buffer (not a copy), by brand: it may come from another realm. */
  const viewOf = (d) => (isAB(d) ? new U8(d) : isView(d) ? new U8(d.buffer, d.byteOffset, d.byteLength) : null);
  const copyOf = (src) => { const u8 = new U8(src.length); u8set.call(u8, src); return u8; };
  /** Keep a SourceBuffer's latest init (dormant or not), or forget a stale one too big to keep. */
  function keepInit(sb, rec, src, u8) {
    rec.init = null;
    if (src.length > INIT_MAX) return;
    if (!u8) {
      u8 = copyOf(src);
      if (!rec.mime) rec.mime = sniff(u8)[1];
      if (rec.mime.includes('mp4') && videoInit(u8)) { rec.skip = true; return; }
    }
    rec.init = u8;
  }
  function dormant(sb, data) {
    const src = viewOf(data);
    if (!src || src.length < 8 || sniff(src)[0] !== 'init') return; // media is never copied while dormant
    const rec = recOf(sb);
    if (!rec.skip) keepInit(sb, rec, src, null);
  }
  function capture(sb, data) {
    const rec = recOf(sb);
    if (rec.skip) return;
    const src = viewOf(data);
    if (!src) return;
    if (tap.bytes + src.length > CAP) { tooLarge(); return; }
    const u8 = copyOf(src);
    const [kind, guess] = sniff(u8);
    if (!rec.mime) rec.mime = guess;
    if (kind === 'init' && rec.mime.includes('mp4') && videoInit(u8)) { rec.skip = true; rec.init = null; return; }
    if (kind === 'init') keepInit(sb, rec, u8, u8);
    queuePart(sb, rec, u8, kind);
  }
  function queuePart(sb, rec, u8, kind) {
    if (rec.mime) tap.mimes.add(rec.mime);
    watchSb(sb);
    tap.bytes += u8.length;
    pend.push({ u8, mime: rec.mime, kind, sb: rec.i, seq: tap.seq++ });
    handLater();
    tapDirty();
  }
  /** Tap on: the SourceBuffers still in use are reported, and their kept inits go first. */
  function tapSourceBuffers() {
    for (const r of known) {
      const sb = r.deref(), rec = sb && sbs.get(sb);
      if (!rec || rec.skip) continue;
      try { void sb.buffered; } catch (_) { continue; } // removed from its MediaSource: the player has moved on
      if (rec.mime) tap.mimes.add(rec.mime);
      if (rec.init) queuePart(sb, rec, rec.init, 'init');
    }
  }
  function tooLarge() {
    tapOff(false);
    emit(JSON.stringify({ t: 'tap-error', reason: 'none', detail: 'too large' }));
  }

  if (window.SourceBuffer) {
    const sp = SourceBuffer.prototype;
    for (const name of ['appendBuffer', 'appendBufferAsync']) {
      const orig = sp[name];
      if (typeof orig !== 'function') continue;
      sp[name] = disguise({ [name](data) {
        const r = orig.apply(this, arguments);
        try { if (tap.on) capture(this, data); else dormant(this, data); } catch (_) {}
        return r;
      } }[name], orig);
    }
  }
  if (window.MediaSource) {
    const mp = MediaSource.prototype, orig = mp.addSourceBuffer;
    mp.addSourceBuffer = disguise({ addSourceBuffer(type) {
      const sb = orig.apply(this, arguments);
      try {
        const rec = recOf(sb, String(type).slice(0, 256));
        if (tap.on && !rec.skip) { tap.mimes.add(rec.mime); watchSb(sb); tapDirty(); }
      } catch (_) {}
      return sb;
    } }.addSourceBuffer, orig);
  }

  // The URL layer: media (and manifest) requests the page makes with fetch or XMLHttpRequest,
  // with their method, Range header and size. Bodies are not taken: the engine can re-request.
  const MEDIA_EXT = /\.(m4s|m4a|m4f|mp4|mp3|aac|webm|weba|opus|ogg|oga|flac|wav|ts|cmfa)$/i, LIST_EXT = /\.(mpd|m3u8)$/i;
  function mediaKind(url, ct) {
    let p = '';
    try { p = new URL_(url).pathname; } catch (_) {}
    if (/dash\+xml|mpegurl/i.test(ct) || LIST_EXT.test(p)) return 'manifest';
    if (/^(audio|video)\//i.test(ct) || (MEDIA_EXT.test(p) && !/html|json|javascript|text\//i.test(ct))) return 'media';
    return '';
  }
  const absUrl = (u) => {
    try { const x = new URL_(String(u), document.baseURI); return /^https?:$/.test(x.protocol) && x.href.length <= 8192 ? x.href : null; } catch (_) { return null; }
  };
  const sizeOf = (v) => { const n = Number(v); return v != null && v !== '' && Number.isSafeInteger(n) && n >= 0 ? n : null; };
  function noteReq(url, method, range, size, ct, past) {
    const kind = past ? (LIST_EXT.test(url.split(/[?#]/)[0]) ? 'manifest' : 'media') : mediaKind(url, ct);
    method = String(method).toUpperCase();
    if (!kind || !/^[A-Z]{1,16}$/.test(method) || tap.reqs >= 1000) return;
    tap.reqs++;
    const r = { url, method, range: typeof range === 'string' && range.length <= 128 ? range : null, size, media: kind === 'media' };
    if (past) r.past = true;
    urlq.push(r);
    handLater();
  }

  const nFetch = window.fetch;
  if (typeof nFetch === 'function') {
    window.fetch = disguise({ fetch(input, init) {
      const p = nFetch.apply(this, arguments);
      if (tap.on) { try { watchFetch(input, init, p); } catch (_) {} }
      return p;
    } }.fetch, nFetch);
  }
  function watchFetch(input, init, p) {
    const req = tagOf(input) === '[object Request]' ? input : null;
    const url = absUrl(req ? req.url : input);
    if (!url) return;
    const method = (init && init.method) || (req && req.method) || 'GET';
    let range = null;
    try {
      const h = init && init.headers != null ? new Headers_(init.headers) : req && req.headers;
      if (h) range = h.get('range');
    } catch (_) {}
    p.then((res) => {
      if (!tap.on) return;
      try { noteReq(url, method, range, sizeOf(res.headers.get('content-length')), res.headers.get('content-type') || ''); } catch (_) {}
    }, () => {});
  }
  if (window.XMLHttpRequest) {
    const xp = XMLHttpRequest.prototype, nOpen = xp.open, nHeader = xp.setRequestHeader, nSend = xp.send;
    xp.open = disguise({ open(method, url) {
      const r = nOpen.apply(this, arguments);
      if (tap.on) { try { xhrs.set(this, { method: String(method), url: absUrl(url), range: null }); } catch (_) {} }
      return r;
    } }.open, nOpen);
    xp.setRequestHeader = disguise({ setRequestHeader(name, value) {
      const r = nHeader.apply(this, arguments);
      if (tap.on) { try { const x = xhrs.get(this); if (x && /^range$/i.test(name)) x.range = String(value); } catch (_) {} }
      return r;
    } }.setRequestHeader, nHeader);
    xp.send = disguise({ send() {
      if (tap.on) { try { if (xhrs.has(this)) listen.call(this, 'loadend', onXhrEnd); } catch (_) {} } // before: a sync XHR ends inside send
      return nSend.apply(this, arguments);
    } }.send, nSend);
  }
  function onXhrEnd() {
    const x = xhrs.get(this);
    xhrs.delete(this);
    unlisten.call(this, 'loadend', onXhrEnd);
    if (!x || !x.url || !tap.on || !this.status) return;
    noteReq(x.url, x.method, x.range, sizeOf(this.getResponseHeader('content-length')), this.getResponseHeader('content-type') || '');
  }

  // The element layer: protected media (an `encrypted` event, keys on an element, or the page
  // asking for a key system, which is passed on untouched) and MSE run from a worker, which no
  // hook in this world can see. Each is said once a session.
  function tapFail(reason, detail) {
    if (tap.told.has(reason)) return;
    tap.told.add(reason);
    emit(JSON.stringify({ t: 'tap-error', reason, detail }));
  }
  function noteWorker(v) { if (tagOf(v) === '[object MediaSourceHandle]') tapFail('worker', 'the player runs its media in a worker'); }
  if (window.Navigator && typeof Navigator.prototype.requestMediaKeySystemAccess === 'function') {
    const np = Navigator.prototype, orig = np.requestMediaKeySystemAccess;
    np.requestMediaKeySystemAccess = disguise({ requestMediaKeySystemAccess(keySystem, configs) {
      const r = orig.apply(this, arguments);
      if (tap.on) tapFail('drm', 'the page asked for a key system');
      return r;
    } }.requestMediaKeySystemAccess, orig);
  }
  const TAP_EVENTS = ['encrypted', 'progress', 'seeked', 'durationchange'];
  function onTapMedia(e) {
    if (!tap.on) return;
    if (e.type === 'encrypted') tapFail('drm', 'the media is encrypted');
    driveCheck();
    tapDirty();
  }
  function wireTap(el) {
    if (wiredEls.has(el)) return;
    wiredEls.add(el);
    for (const ev of TAP_EVENTS) listen.call(el, ev, onTapMedia);
  }
  function watchSb(sb) {
    if (watched.has(sb)) return;
    watched.add(sb);
    listen.call(sb, 'updateend', onSbUpdate);
  }
  function onSbUpdate() { driveCheck(); tapDirty(); }

  /** The player the tap reports on: the driven one; else playing and heard, loaded, longest. */
  function mainEl() {
    if (drv.el) return drv.el;
    let best = null, score = -1;
    for (const el of live()) {
      const d = Number.isFinite(el.duration) ? Math.min(el.duration, 1e6) : 0;
      const s = (el.paused ? 0 : 4) + (heard(el) ? 2 : 0) + (el.readyState > 0 ? 1 : 0) + d / 1e7;
      if (s > score) { best = el; score = s; }
    }
    return best;
  }
  const durOf = (el) => { const d = el ? el.duration : NaN; return Number.isFinite(d) && d > 0 ? d : null; };
  const rangesOf = (el) => {
    const out = [];
    try { const b = el.buffered; for (let i = 0; i < b.length && i < 64; i++) out.push([b.start(i), b.end(i)]); } catch (_) {}
    return out;
  };
  /** What the page shows without a hook: keys, worker handles, an endless stream, element sources, a preview. */
  function checkPage() {
    for (const el of live()) {
      try {
        if (el.mediaKeys) tapFail('drm', 'the player uses protected media');
        noteWorker(el.srcObject);
        // Only a player the user hears is the track: a muted decorative <audio> is not.
        const src = el.currentSrc;
        if ((heard(el) || el === drv.el) && /^https?:/i.test(src) && !tap.srcs.has(src)) { tap.srcs.add(src); const u = absUrl(src); if (u) noteReq(u, 'GET', null, null, '', true); }
      } catch (_) {}
    }
    previewCheck(mainEl());
    // An MSE player shows Infinity for a moment after its init segment, until it sets the length
    // from its manifest: only one that keeps saying so is a stream with no end.
    // Looked at again once the 3 s are up, in case nothing else happens on the page meanwhile.
    const el = mainEl(), now = performance.now();
    if (!el || el.duration !== Infinity) tap.infAt = 0;
    else if (!tap.infAt) { tap.infAt = now; setTimeout(tapDirty, 3100); }
    else if (now - tap.infAt >= 3000) tapFail('live', 'the player reports no end');
  }

  // A preview: the player holds about 30 s, and the page says it is a snippet in its own JSON (as
  // SoundCloud does: policy SNIP, snipped) or in the media's path. Looked for once a session, when
  // a length in that range first shows.
  const SNIP = /"policy"\s*:\s*"SNIP"|"snipped"\s*:\s*true/;
  function previewCheck(el) {
    const d = durOf(el);
    if (tap.snip || !d || d < 25 || d > 35) return;
    tap.snip = true;
    let flagged = /\/preview\//i.test(el.currentSrc || '');
    try { for (const sc of document.querySelectorAll('script')) { if (flagged) break; const t = sc.textContent; if (t.length <= 4e6 && SNIP.test(t)) flagged = true; } } catch (_) {}
    if (flagged) tapFail('preview', 'the page offers a 30-second preview only');
  }

  // Up: parts and requests as soon as the task that made them is over (one microtask, so a burst
  // of appends goes as one message); progress at most four times a second.
  let handing = false;
  function handLater() { if (!handing) { handing = true; queueMicrotask(handOver); } }
  function handOver() {
    handing = false;
    while (pend.length) {
      const parts = [];
      for (const p of pend.splice(0, 64)) {
        const blobUrl = mkUrl(p.blob || new Blob_([p.u8], { type: p.mime }));
        handed.add(blobUrl);
        parts.push({ blobUrl, mime: p.mime, kind: p.kind, sb: p.sb, seq: p.seq });
      }
      emit(JSON.stringify({ t: 'tap-ready', parts, duration: durOf(mainEl()) }));
    }
    while (urlq.length) emit(JSON.stringify({ t: 'tap-urls', reqs: urlq.splice(0, 16) }));
  }
  function tapDirty() { if (tap.on) { tp.dirty = true; tapPump(); } }
  function tapPump() {
    if (!tp.dirty || tp.queued) return;
    const wait = tp.at + 250 - performance.now();
    if (wait <= 0) { tp.queued = true; queueMicrotask(() => { tp.queued = false; if (tp.dirty) tapSend(); }); }
    else if (!tp.timer) tp.timer = setTimeout(() => { tp.timer = 0; tapPump(); }, wait);
  }
  function tapSend() {
    tp.dirty = false;
    if (!tap.on) return;
    checkPage();
    const el = mainEl();
    const msg = { t: 'tap-progress', bytes: tap.bytes, buffered: rangesOf(el), duration: durOf(el), mimes: [...tap.mimes].slice(0, 16) };
    if (drv.mode) msg.drive = { mode: drv.mode, state: drv.state, at: Math.max(0, drv.mode === 'seekhop' ? drv.cursor : el.currentTime) };
    const s = JSON.stringify(msg);
    if (s === tp.last) return;
    tp.last = s; tp.at = performance.now();
    emit(s);
  }

  /** The requests the page made before the tap was on, from its own resource timeline. */
  function history() {
    let list = [];
    try { list = performance.getEntriesByType('resource').slice(-500); } catch (_) {}
    const seen = new Set();
    for (const e of list) {
      if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') continue;
      const url = absUrl(e.name);
      if (!url || seen.has(url) || !mediaKind(url, '')) continue;
      seen.add(url);
      noteReq(url, 'GET', null, e.encodedBodySize > 0 ? e.encodedBodySize : null, '', true);
    }
  }

  function tapOn() {
    if (tap.on) { tapDirty(); return; }
    Object.assign(tap, { on: true, bytes: 0, reqs: 0, infAt: 0, snip: false, told: new Set(), mimes: new Set(), srcs: new Set() });
    tp.last = '';
    activate(); scan(); watchPolling();
    for (const el of live()) wireTap(el);
    tapSourceBuffers();
    history();
    checkPage();
    tapDirty();
  }
  // ---------------------------------------------------------------- drive
  // To get the whole track the deck has the player fetch all of it, while the tap captures what
  // it appends: seekhop seeks through the track in steps the size of the player's own buffering
  // goal, waiting at each until it has buffered the step; accelerate plays it fast through the
  // assist rate machinery (and its back-off), pitch unlocked. Either mutes the player; stop puts
  // back its rate, pitch, mute, volume, position and playing state. Progress goes up in
  // tap-progress.drive: running, done (all of it buffered), stalled or refused.
  // Recording a whole track from the tab's sound runs accelerate with audible (the player keeps
  // its sound), from (it starts at that place) and hold (it waits there, paused, for the next
  // accelerate), so the recording starts with the track.
  const HOP_WAIT = 3000, END_TOL = 0.3, START_TOL = 0.2;
  const drv = { mode: null, el: null, base: null, state: '', cursor: 0, hop: 0, since: 0, timer: 0 };
  // MP3 and ADTS carry no timestamps: their appends can only be placed in order, so no seek-hop.
  const NO_STAMPS = /^audio\/(mpeg|mp3|aac|x-aac)\b/i;

  /** The end of the buffered range that holds (or starts just after) t; t itself if none. */
  function bufEnd(el, t) {
    try { const b = el.buffered; for (let i = 0; i < b.length; i++) if (b.start(i) <= t + START_TOL && b.end(i) > t) return b.end(i); } catch (_) {}
    return t;
  }
  const lengthOf = (el) => { const d = el.duration; return d > 0 && d !== Infinity ? d : 0; };
  function drive(m) {
    if (m.mode === 'stop') { driveStop(); return; }
    if (!tap.on || (m.mode !== 'seekhop' && m.mode !== 'accelerate')) return;
    const el = drv.el || mainEl();
    if (!el) { emit(JSON.stringify({ t: 'tap-error', reason: 'none', detail: 'no player to drive' })); return; }
    if (!drv.mode) {
      drv.el = el;
      drv.base = { t: el.currentTime, paused: el.paused, rate: el.playbackRate, dflt: el.defaultPlaybackRate, pp: el.preservesPitch, muted: el.muted, volume: el.volume };
      drv.timer = setInterval(driveCheck, 250);
    } else if (st.enforcing) release(); // from accelerate to seekhop
    drv.mode = m.mode; drv.since = performance.now();
    if (m.mode === 'seekhop' && [...tap.mimes].some((x) => NO_STAMPS.test(x))) { drv.state = 'refused'; tapDirty(); return; }
    drv.state = 'running';
    try { el.muted = m.audible === true ? drv.base.muted : true; } catch (_) {}
    if (m.mode === 'seekhop') {
      const t = el.currentTime, step = typeof m.step === 'number' && m.step >= 0.5 && m.step <= 600 ? m.step : 0;
      drv.hop = step || Math.max(1, bufEnd(el, t) - t); // the player's buffering goal, as it shows now
      drv.cursor = 0;
      hop();
    } else {
      if (typeof m.from === 'number' && Number.isFinite(m.from) && m.from >= 0) { try { nativePause.call(el); el.currentTime = m.from; } catch (_) {} }
      accelerate(typeof m.rate === 'number' && m.rate > 1 && m.rate <= 16 ? m.rate : 8, m.hold === true);
    }
    tapDirty();
  }
  function hop() {
    const el = drv.el, dur = lengthOf(el);
    if (!dur) return; // no length yet: driveCheck waits for one
    const e = bufEnd(el, drv.cursor);
    if (e >= dur - END_TOL) { drv.state = 'done'; tapDirty(); return; }
    drv.cursor = e; drv.since = performance.now();
    try { el.currentTime = e; } catch (_) {}
    tapDirty();
  }
  // A stall is said, not final: a player that buffers again is hopped on from where it got to.
  function driveCheck() {
    if (!drv.mode || (drv.state !== 'running' && drv.state !== 'stalled')) return;
    const el = drv.el, dur = lengthOf(el), late = performance.now() - drv.since > HOP_WAIT;
    const stall = () => { if (drv.state !== 'stalled') { drv.state = 'stalled'; tapDirty(); } };
    if (drv.mode === 'accelerate') {
      if (el.ended || (dur && bufEnd(el, el.currentTime) >= dur - END_TOL)) { drv.state = 'done'; tapDirty(); }
      return;
    }
    if (!dur) { if (late) stall(); return; }
    const e = bufEnd(el, drv.cursor), moved = e > drv.cursor + 0.05;
    if (drv.state === 'stalled') { if (moved) { drv.state = 'running'; hop(); } return; }
    if (e >= Math.min(dur - END_TOL, drv.cursor + drv.hop)) hop();
    else if (late) { if (moved) hop(); else stall(); } // slower than its goal: move on
  }
  function accelerate(rate, hold) {
    st.target = rate; st.enforcing = true; st.letGo = 0;
    scan();
    for (const el of live()) { const x = info.get(el); if (x) { x.off = false; x.ext = []; } apply(el); }
    const el = drv.el, refused = () => { if (drv.mode === 'accelerate') { drv.state = 'refused'; tapDirty(); } };
    if (hold || !el.paused) return;
    let p;
    try { p = nativePlay.call(el); } catch (_) { refused(); return; }
    if (p && typeof p.then === 'function') p.then(null, refused);
  }
  function driveStop() {
    if (!drv.mode) return;
    const { el, base } = drv;
    clearInterval(drv.timer);
    Object.assign(drv, { mode: null, el: null, base: null, state: '', timer: 0 });
    if (st.enforcing) release();
    try {
      el.defaultPlaybackRate = base.dflt; el.playbackRate = base.rate; el.preservesPitch = base.pp;
      el.muted = base.muted; el.volume = base.volume;
      if (base.paused && !el.paused) nativePause.call(el);
      if (el.currentTime !== base.t) el.currentTime = base.t;
    } catch (_) {}
    tapDirty();
  }

  // ---------------------------------------------------------------- page-context fetch
  // {t:'fetch', urls}: the engine has the page fetch links again (signed links are bound to the
  // page's session), with the fetch the agent took at document_start, never one the page put in
  // its place: eight at a time, each given 15 s. Each result is a tap-ready part, kind 'media',
  // numbered by its place in the list; a failure is a tap-error 'fetch' with that number.
  // {t:'readTralbum'}: a Bandcamp page's own stream link (its data-tralbum JSON), fetched the
  // same way and handed over as one 'file' part.
  const FETCH_WAIT = 15000, FILE_WAIT = 60000, Abort_ = AbortController;
  const jobs = new Set();
  async function grab(url, wait, gen) {
    const ac = new Abort_(), timer = setTimeout(() => ac.abort(), wait);
    jobs.add(ac);
    try {
      const res = await nFetch.call(window, url, { signal: ac.signal });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const blob = await res.blob();
      return gen === tap.gen ? { blob, mime: (res.headers.get('content-type') || '').slice(0, 256) } : {};
    } catch (_) {
      return gen !== tap.gen ? {} : { error: ac.signal.aborted ? `timed out after ${wait / 1000} s` : 'network error' };
    } finally { clearTimeout(timer); jobs.delete(ac); }
  }
  /** Count a fetched Blob against the limit; false when it does not fit (the tap gives up). */
  function holds(blob) {
    if (tap.bytes + blob.size > CAP) { tooLarge(); return false; }
    tap.bytes += blob.size;
    return true;
  }
  function fetchUrls(m) {
    if (!Array.isArray(m.urls) || !m.urls.length || m.urls.length > 512) return;
    const urls = m.urls.map((u) => (typeof u === 'string' ? absUrl(u) : null));
    const n = Number.isInteger(m.concurrency) && m.concurrency >= 1 && m.concurrency <= 16 ? m.concurrency : 8, gen = tap.gen;
    const fail = (seq, why) => emit(JSON.stringify({ t: 'tap-error', reason: 'fetch', detail: `#${seq}: ${why}`, seq }));
    let next = 0;
    const worker = async () => {
      while (next < urls.length && gen === tap.gen) {
        const seq = next++;
        if (!urls[seq]) { fail(seq, 'not a web link'); continue; }
        const r = await grab(urls[seq], FETCH_WAIT, gen);
        if (r.error) fail(seq, r.error);
        else if (r.blob && holds(r.blob)) { pend.push({ blob: r.blob, mime: r.mime, kind: 'media', sb: -1, seq }); handLater(); tapDirty(); }
      }
    };
    for (let k = 0; k < Math.min(n, urls.length); k++) worker();
  }
  async function readTralbum() {
    let url = null, duration = null;
    try {
      const el = document.querySelector('[data-tralbum]');
      const t = el ? (JSON.parse(el.getAttribute('data-tralbum')).trackinfo || [])[0] : null;
      const f = t && t.file && t.file['mp3-128'];
      if (typeof f === 'string') url = absUrl(f);
      if (t && Number.isFinite(t.duration) && t.duration > 0) duration = t.duration;
    } catch (_) {}
    if (!url) { emit(JSON.stringify({ t: 'tap-error', reason: 'none', detail: 'no stream link on the page' })); return; }
    const r = await grab(url, FILE_WAIT, tap.gen);
    if (r.error) { emit(JSON.stringify({ t: 'tap-error', reason: 'fetch', detail: `the stream link: ${r.error}` })); return; }
    if (!r.blob || !holds(r.blob)) return;
    const blobUrl = mkUrl(r.blob);
    handed.add(blobUrl);
    emit(JSON.stringify({ t: 'tap-ready', parts: [{ blobUrl, mime: r.mime || 'audio/mpeg', kind: 'file', sb: -1, seq: 0 }], duration }));
  }

  /** Off: drop every copy not handed over. forget: revoke the handed-over URLs too. */
  function tapOff(forget) {
    driveStop();
    for (const ac of jobs) ac.abort();
    if (tap.on) {
      tap.on = false;
      for (const el of wiredEls) for (const ev of TAP_EVENTS) unlisten.call(el, ev, onTapMedia);
      for (const sb of watched) unlisten.call(sb, 'updateend', onSbUpdate);
      wiredEls.clear(); watched.clear();
      clearTimeout(tp.timer);
      tp.timer = 0; tp.dirty = false;
    }
    tap.gen++;
    pend = []; urlq = [];
    if (forget) { for (const u of handed) { try { rmUrl(u); } catch (_) {} } handed.clear(); }
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
      Object.defineProperty(proto, prop, { ...d, get: disguise(get, d.get) });
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
    if (typeof e.detail !== 'string' || e.detail.length > 1 << 20) return;
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
      if (drv.mode) { send(); return; } // the player is being driven: no assist on top of it
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
      tapOff(true);
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
    } else if (m.t === 'tap') {
      // A deck wants the whole track (on), or is done with the tap (off; forget: and with every
      // blob URL handed over, which it has read or no longer wants).
      if (m.on === true) tapOn();
      else if (m.on === false) tapOff(m.forget === true);
    } else if (m.t === 'drive') {
      drive(m);
    } else if (m.t === 'fetch') {
      fetchUrls(m);
    } else if (m.t === 'readTralbum') {
      readTralbum();
    }
  }
})();
