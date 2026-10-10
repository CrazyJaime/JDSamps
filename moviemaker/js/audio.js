// Movie Maker (web) — AudioEngine: decodes and schedules every sound of the movie through
// Web Audio. Video soundtracks are decoded from the video file's own bytes, so <video>
// elements can always stay muted (which keeps inline autoplay working on phones).
//
// Graph per playback session:
//   AudioBufferSourceNode → GainNode (volume × fades × transition crossfade × ducking)
//      → session video bus | session music bus (audioMix balance)
//      → session gain (de-click on stop) → master gain → speaker gain → destination
//                                                     └→ MediaStreamAudioDestinationNode(s) (export)

import { FADE_SPEEDS } from './model.js';

const START_LEAD = 0.08;        // seconds between start() and the moment t = fromTime is heard
const LATE_LEAD = 0.04;         // lead for sources whose buffer finishes decoding mid-playback
const DECLICK = 0.015;          // ramp to silence on stop()
const DECODE_TIMEOUT_MS = 120000;
const IDLE_SUSPEND_MS = 30000;  // suspend the context when idle so phones can power the audio HW down
const DUCK_LEVEL = 0.3;         // music level while narration plays ("Emphasize narration")
const DUCK_RAMP = 0.3;
const FALLBACK_RATE = 48000;

function isCoarsePointer() {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch (_) { return false; }
}

function makeEvent(type, detail) {
  if (typeof CustomEvent === 'function') return new CustomEvent(type, { detail });
  const e = new Event(type);
  e.detail = detail;
  return e;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function fadeSeconds(v) {
  const s = FADE_SPEEDS[v];
  return s > 0 ? s : 0;
}

/** Gains of the two buses for an audioMix value (-1 = video sound only … 1 = music only). */
export function mixGains(mix) {
  const m = clamp(Number.isFinite(+mix) ? +mix : 0, -1, 1);
  return { video: m <= 0 ? 1 : 1 - m, music: m >= 0 ? 1 : 1 + m };
}

function getAudioContextClass() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function getOfflineContextClass() {
  if (typeof window === 'undefined') return null;
  return window.OfflineAudioContext || window.webkitOfflineAudioContext || null;
}

/** decodeAudioData with both the promise and the callback form (old Safari only has callbacks). */
function decodeWith(ctx, data) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e || new Error('decode failed')); } };
    try {
      const p = ctx.decodeAudioData(data, ok, fail);
      if (p && typeof p.then === 'function') p.then(ok, fail);
    } catch (e) { fail(e); }
  });
}

function withTimeout(promise, ms) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function readBlob(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('read failed'));
      fr.readAsArrayBuffer(blob);
    } catch (e) { reject(e); }
  });
}

// ---------------------------------------------------------------------------
// Piecewise-linear envelopes, stored flat: [t0, v0, t1, v1, ...] with t ascending.
// The value is v0 before t0 and the last v after the last t.

function envAt(env, x) {
  const n = env.length;
  if (!n) return 1;
  if (x <= env[0]) return env[1];
  for (let i = 2; i < n; i += 2) {
    if (x <= env[i]) {
      const t0 = env[i - 2], v0 = env[i - 1], t1 = env[i], v1 = env[i + 1];
      return t1 > t0 ? v0 + ((v1 - v0) * (x - t0)) / (t1 - t0) : v1;
    }
  }
  return env[n - 1];
}

/** Fade-in / fade-out envelope over a span of `len` seconds. */
function fadeEnvelope(len, fadeIn, fadeOut) {
  let fi = fadeSeconds(fadeIn), fo = fadeSeconds(fadeOut);
  if (fi + fo > len && fi + fo > 0) { const k = len / (fi + fo); fi *= k; fo *= k; }
  const e = [];
  if (fi > 0) e.push(0, 0, fi, 1); else e.push(0, 1);
  if (fo > 0) e.push(Math.max(len - fo, e[e.length - 2]), 1, len, 0);
  return e;
}

/** Audio crossfade matching a visual transition: ramp in over `dIn`, out over `dOut`. */
function crossfadeEnvelope(len, dIn, dOut) {
  if (!(dIn > 0) && !(dOut > 0)) return null;
  const e = [];
  if (dIn > 0) e.push(0, 0, Math.min(dIn, len), 1); else e.push(0, 1);
  if (dOut > 0) e.push(Math.max(len - dOut, e[e.length - 2]), 1, len, 0);
  return e;
}

/** Ducking envelope (local time) for a music item spanning [start, start+len] under narration. */
function duckEnvelope(start, len, intervals) {
  const e = [];
  for (const [a0, b0] of intervals) {
    const a = a0 - start, b = b0 - start;
    if (b + DUCK_RAMP <= 0 || a - DUCK_RAMP >= len) continue;
    const last = e.length ? e[e.length - 2] : -Infinity;
    const p0 = Math.max(a - DUCK_RAMP, last);
    e.push(p0, 1, Math.max(a, p0), DUCK_LEVEL, Math.max(b, a, p0), DUCK_LEVEL, Math.max(b + DUCK_RAMP, b, a, p0), 1);
  }
  return e.length ? e : null;
}

function mergeIntervals(list) {
  list.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + 2 * DUCK_RAMP) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * Program a gain AudioParam with the product of several envelopes (local time), scaled,
 * from local x0 to x1. ctxAt(x) maps local time to context time. The value at x0 is exact
 * even when starting in the middle of a fade.
 */
function scheduleGain(param, envs, scale, x0, x1, ctxAt) {
  const ts = [x0];
  for (const env of envs) {
    for (let i = 0; i < env.length; i += 2) {
      const t = env[i];
      if (t > x0 && t < x1) ts.push(t);
    }
  }
  ts.push(x1);
  ts.sort((a, b) => a - b);
  const val = (x) => {
    let v = scale;
    for (const env of envs) v *= envAt(env, x);
    return v;
  };
  const v0 = val(x0);
  try { param.value = v0; } catch (_) { /* ignore */ }
  param.setValueAtTime(v0, ctxAt(x0));
  let last = x0;
  for (let i = 1; i < ts.length; i++) {
    const x = ts[i];
    if (x - last < 1e-4) continue;
    param.linearRampToValueAtTime(val(x), ctxAt(x));
    last = x;
  }
}

function bufferBytes(buf) {
  return buf ? buf.length * buf.numberOfChannels * 4 : 0;
}

// ---------------------------------------------------------------------------

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this._ctx = null;
    this._master = null;
    this._speaker = null;
    this._ctxFailed = false;
    this._volume = 1;
    this._muted = false;
    this._cache = new Map();   // mediaId → { blob, buffer, promise, failed, used, bytes }
    this._queue = [];
    this._running = 0;
    this._concurrency = isCoarsePointer() ? 1 : 2;
    this._decodeCtxs = new Map(); // sampleRate → OfflineAudioContext
    this._session = null;
    this._sessionSeq = 0;
    this._store = null;
    this._streamDests = new Set();
    this._idleTimer = 0;
    this._autoResumeInstalled = false;
    this._wantRunning = false;
    this._lastCt = -1;
    this._lastCtPerf = 0;
    this.startLead = START_LEAD;
    this._onStateChange = this._onStateChange.bind(this);
    this._onGesture = this._onGesture.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
  }

  // ---------- context ----------

  /** Lazily created AudioContext (webkitAudioContext fallback). null if Web Audio is unavailable. */
  get context() {
    if (this._ctx || this._ctxFailed) return this._ctx;
    const Ctx = getAudioContextClass();
    if (!Ctx) { this._ctxFailed = true; return null; }
    let ctx = null;
    try { ctx = new Ctx({ latencyHint: 'interactive' }); } catch (_) {
      try { ctx = new Ctx(); } catch (err) {
        console.warn('Movie Maker: Web Audio is not available, movies will play without sound.', err);
        this._ctxFailed = true;
        return null;
      }
    }
    this._ctx = ctx;
    try {
      this._master = ctx.createGain();
      this._speaker = ctx.createGain();
      this._master.gain.value = this._volume;
      this._speaker.gain.value = this._muted ? 0 : 1;
      this._master.connect(this._speaker);
      this._speaker.connect(ctx.destination);
    } catch (err) {
      console.warn('Movie Maker: could not build the audio graph.', err);
    }
    if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', this._onStateChange);
    else ctx.onstatechange = this._onStateChange;
    return ctx;
  }

  /** The context if it has been created already (never creates one). */
  get contextIfCreated() { return this._ctx; }

  get state() { return this._ctx ? this._ctx.state : 'none'; }

  /** GainNode feeding the speakers and any export stream destinations. */
  get masterGain() {
    this.context;
    return this._master;
  }

  get volume() { return this._volume; }
  set volume(v) {
    this._volume = clamp(Number.isFinite(+v) ? +v : 1, 0, 2);
    if (this._master && this._ctx) {
      try { this._master.gain.setTargetAtTime(this._volume, this._ctx.currentTime, 0.02); } catch (_) { this._master.gain.value = this._volume; }
    }
  }

  /** Silence the speakers while still feeding stream destinations (used during export). */
  get outputMuted() { return this._muted; }
  set outputMuted(m) {
    this._muted = !!m;
    if (this._speaker && this._ctx) {
      const g = this._muted ? 0 : 1;
      try {
        const p = this._speaker.gain;
        p.cancelScheduledValues(0);
        p.setTargetAtTime(g, this._ctx.currentTime, 0.01);
      } catch (_) { this._speaker.gain.value = this._muted ? 0 : 1; }
    }
  }

  /**
   * Call inside a user gesture (pointerup/click/keydown): resumes the context and plays a
   * 1-sample silent buffer, which is what iOS needs to allow sound. Resolves true if running.
   */
  async unlock() {
    const ctx = this.context;
    if (!ctx) return false;
    this._wantRunning = true;
    this._installAutoResume();
    this._clearIdle();
    // iOS 16.4+: play through the silent switch like a media app would.
    try {
      if (typeof navigator !== 'undefined' && navigator.audioSession && navigator.audioSession.type !== 'playback') {
        navigator.audioSession.type = 'playback';
      }
    } catch (_) { /* ignore */ }
    // Everything up to here runs synchronously inside the gesture.
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      if (typeof src.start === 'function') src.start(0); else if (typeof src.noteOn === 'function') src.noteOn(0);
      src.onended = () => { try { src.disconnect(); } catch (_) { /* ignore */ } };
    } catch (_) { /* ignore */ }
    if (ctx.state === 'running') return true;
    let p = null;
    try { p = ctx.resume(); } catch (_) { p = null; }
    if (p && typeof p.then === 'function') {
      await withTimeout(p.catch(() => {}), 1500);
    }
    return ctx.state === 'running';
  }

  _installAutoResume() {
    if (this._autoResumeInstalled || typeof document === 'undefined') return;
    this._autoResumeInstalled = true;
    const opts = { capture: true, passive: true };
    for (const type of ['pointerdown', 'touchend', 'keydown', 'click']) document.addEventListener(type, this._onGesture, opts);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  _onGesture() {
    const ctx = this._ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    // An iOS interruption (phone call, Siri) leaves the context 'interrupted'; a tap brings it back.
    if (this._wantRunning || ctx.state === 'interrupted') {
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
    }
  }

  _onVisibility() {
    if (typeof document === 'undefined' || document.hidden) return;
    const ctx = this._ctx;
    if (ctx && this._wantRunning && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
    }
  }

  _onStateChange() {
    const state = this._ctx ? this._ctx.state : 'none';
    this.dispatchEvent(makeEvent('statechange', { state }));
  }

  _clearIdle() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = 0; }
  }

  _scheduleIdle() {
    this._clearIdle();
    if (this._streamDests.size) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = 0;
      const ctx = this._ctx;
      if (!ctx || this._session || this._streamDests.size || ctx.state !== 'running') return;
      this._wantRunning = false;
      try { const p = ctx.suspend(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
    }, IDLE_SUSPEND_MS);
  }

  // ---------- clocks (used by the Player) ----------

  /** Context time of the sample being rendered now, smoothed with performance.now(). */
  renderTime() {
    const ctx = this._ctx;
    if (!ctx) return 0;
    const ct = ctx.currentTime;
    const pn = performance.now();
    if (ct !== this._lastCt) { this._lastCt = ct; this._lastCtPerf = pn; }
    return ct + Math.min(0.05, Math.max(0, (pn - this._lastCtPerf) / 1000)) * (ctx.state === 'running' ? 1 : 0);
  }

  /** Context time of the sample currently coming out of the speakers (accounts for output latency). */
  outputTime() {
    const ctx = this._ctx;
    if (!ctx) return 0;
    const rt = this.renderTime();
    if (typeof ctx.getOutputTimestamp === 'function') {
      try {
        const ts = ctx.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
          const est = ts.contextTime + Math.max(0, performance.now() - ts.performanceTime) / 1000;
          if (Math.abs(est - rt) < 0.5) return Math.min(est, rt);
        }
      } catch (_) { /* fall through */ }
    }
    const lat = ctx.outputLatency;
    return rt - (lat > 0 && lat < 1 ? lat : 0);
  }

  // ---------- decoding ----------

  /** Decode (once) and cache the sound of a media record. null if it has no usable audio. */
  async getBuffer(media, { priority = false } = {}) {
    if (!media || !media.id || media.type === 'image') return null;
    let entry = this._cache.get(media.id);
    if (entry && entry.blob === (media.blob || null) && (entry.blob || entry.url === media.url)) {
      entry.used = Date.now();
      if (entry.promise) {
        if (priority) this._prioritize(media.id);
        return entry.promise;
      }
      return entry.buffer;
    }
    if (media.type === 'video' && media.hasAudio === false) {
      this._cache.set(media.id, { blob: media.blob || null, url: media.url, buffer: null, promise: null, failed: true, used: Date.now(), bytes: 0 });
      return null;
    }
    if (!media.blob && !media.url) return null;
    entry = { blob: media.blob || null, url: media.url, buffer: null, promise: null, failed: false, used: Date.now(), bytes: 0 };
    this._cache.set(media.id, entry);
    entry.promise = new Promise((resolve) => {
      const job = { id: media.id, media, entry, resolve };
      if (priority) this._queue.unshift(job); else this._queue.push(job);
      this._pump();
    });
    return entry.promise;
  }

  /** The decoded buffer if already available (never starts decoding). */
  peekBuffer(mediaId) {
    const e = this._cache.get(mediaId);
    return e && !e.promise ? e.buffer : null;
  }

  _prioritize(id) {
    const i = this._queue.findIndex((j) => j.id === id);
    if (i > 0) this._queue.unshift(this._queue.splice(i, 1)[0]);
  }

  _pump() {
    while (this._running < this._concurrency && this._queue.length) {
      const job = this._queue.shift();
      this._running++;
      this._runJob(job).finally(() => {
        this._running--;
        this._pump();
      });
    }
  }

  async _runJob(job) {
    const { media, entry } = job;
    let buffer = null;
    let reason = '';
    try {
      buffer = await this._decode(media);
      if (!buffer) reason = 'no-audio';
    } catch (err) {
      reason = (err && err.code) || 'decode-failed';
      buffer = null;
    }
    entry.buffer = buffer;
    entry.bytes = bufferBytes(buffer);
    entry.failed = !buffer;
    entry.promise = null;
    if (this._cache.get(job.id) !== entry) {
      // Media was replaced/evicted while decoding: still hand the result to the waiter.
      job.resolve(buffer);
      return;
    }
    // A video without a soundtrack is normal; music that can't be decoded (or anything too
    // big to decode) is worth telling the user about.
    if (!buffer && (media.type !== 'video' || reason === 'too-large')) {
      this.dispatchEvent(makeEvent('decodeerror', { mediaId: media.id, name: media.name || '', reason }));
    }
    this._enforceBudget();
    job.resolve(buffer);
  }

  _decodeContext(media) {
    const Offline = getOfflineContextClass();
    const main = this._ctx;
    let rate = main ? main.sampleRate : FALLBACK_RATE;
    const longBytes = this._concurrency === 1 ? 120e6 : 400e6;
    const dur = media.duration > 0 ? media.duration : 0;
    const est = dur * rate * 2 * 4;
    // Very long recordings, or a cache that is already full, decode at a lower rate so
    // phones don't run out of memory (decoded audio is 32-bit float per sample).
    if (est > longBytes || this._totalBytes() + est > this._budget()) rate = Math.min(rate, 22050);
    if (Offline) {
      let ctx = this._decodeCtxs.get(rate);
      if (ctx) return ctx;
      try {
        ctx = new Offline(2, 1, rate);
        this._decodeCtxs.set(rate, ctx);
        return ctx;
      } catch (_) { /* fall back to the main context */ }
    }
    return this.context;
  }

  async _decode(media) {
    const maxBytes = this._concurrency === 1 ? 400e6 : 1200e6;
    if (media.blob && media.blob.size > maxBytes) {
      const err = new Error('too large');
      err.code = 'too-large';
      throw err;
    }
    let data;
    if (media.blob) data = await readBlob(media.blob);
    else {
      const res = await fetch(media.url);
      data = await res.arrayBuffer();
    }
    if (!data || !data.byteLength) return null;
    const ctx = this._decodeContext(media);
    if (!ctx) return null;
    let buf = null;
    try {
      buf = await withTimeout(decodeWith(ctx, data), DECODE_TIMEOUT_MS);
    } catch (err) {
      // Some engines refuse to decode on an OfflineAudioContext; retry once on the main
      // context if it exists (creating one here, before a user gesture, would be refused).
      const main = this._ctx;
      if (main && main !== ctx && data.byteLength) {
        try {
          const again = media.blob ? await readBlob(media.blob) : null;
          if (again) buf = await withTimeout(decodeWith(main, again), DECODE_TIMEOUT_MS);
        } catch (_) { buf = null; }
      }
      if (!buf) return null;
    }
    if (!buf || !buf.length || !buf.numberOfChannels) return null;
    return buf;
  }

  _budget() { return this._concurrency === 1 ? 220e6 : 700e6; }

  _totalBytes() {
    let total = 0;
    for (const e of this._cache.values()) total += e.bytes || 0;
    return total;
  }

  _enforceBudget(referenced) {
    const budget = this._budget();
    let total = this._totalBytes();
    if (total <= budget) return;
    const refs = referenced || this._referenced || new Set();
    const victims = [...this._cache.entries()]
      .filter(([id, e]) => !e.promise && e.buffer && !refs.has(id))
      .sort((a, b) => a[1].used - b[1].used);
    for (const [id, e] of victims) {
      if (total <= budget) break;
      total -= e.bytes || 0;
      this._cache.delete(id);
    }
  }

  /** Pre-decode every media referenced by the project (video soundtracks + music) in the background. */
  async prepare(project, store) {
    if (store) this._store = store;
    const s = store || this._store;
    if (!project) return;
    const ids = new Set();
    for (const it of project.items || []) if (it && it.kind === 'video' && it.mediaId) ids.add(it.mediaId);
    for (const m of project.music || []) if (m && m.mediaId) ids.add(m.mediaId);
    this._referenced = ids;
    // Forget media that no longer exists.
    for (const id of [...this._cache.keys()]) {
      if (!ids.has(id) && s && s.media && typeof s.media.has === 'function' && !s.media.has(id)) {
        const e = this._cache.get(id);
        if (!e.promise) this._cache.delete(id);
      }
    }
    this._enforceBudget(ids);
    if (!s || typeof s.getMedia !== 'function') return;
    const jobs = [];
    for (const id of ids) {
      const media = s.getMedia(id);
      if (media) jobs.push(this.getBuffer(media).catch(() => null));
    }
    await Promise.all(jobs);
  }

  // ---------- scheduling ----------

  /**
   * Schedule every audible source of the movie from timeline time `fromTime`.
   * options: { destination?: AudioNode (instead of the master gain), at?: context time for
   *            fromTime, getMedia?: (id) => Media }
   * Returns the context time at which t = fromTime is played, or null without Web Audio.
   */
  start(project, timeline, fromTime, options = {}) {
    this.stop();
    const ctx = this.context;
    if (!ctx || !this._master || !project || !timeline) return null;
    this._clearIdle();
    this._wantRunning = true;
    const opts = options || {};
    const from = Math.max(0, Number.isFinite(+fromTime) ? +fromTime : 0);
    let startAt = ctx.currentTime + START_LEAD;
    if (Number.isFinite(opts.at) && opts.at > ctx.currentTime + 0.01) startAt = opts.at;

    const session = {
      id: ++this._sessionSeq,
      from,
      startAt,
      nodes: [],
      sources: [],
      gain: ctx.createGain(),
      videoBus: ctx.createGain(),
      musicBus: ctx.createGain(),
    };
    const g = mixGains(project.audioMix);
    session.videoBus.gain.value = g.video;
    session.musicBus.gain.value = g.music;
    session.videoBus.connect(session.gain);
    session.musicBus.connect(session.gain);
    let out = this._master;
    if (opts.destination && typeof opts.destination.connect === 'function') out = opts.destination;
    session.gain.connect(out);
    this._session = session;

    const getMedia = typeof opts.getMedia === 'function' ? opts.getMedia
      : (this._store && typeof this._store.getMedia === 'function' ? (id) => this._store.getMedia(id) : null);

    const specs = this._buildSpecs(project, timeline, from);
    for (const spec of specs) {
      const cached = this._cache.get(spec.mediaId);
      const media = getMedia ? getMedia(spec.mediaId) : null;
      if (cached && !cached.promise && (!media || cached.blob === (media.blob || null))) {
        if (cached.buffer) this._scheduleSpec(session, spec, cached.buffer);
        continue;
      }
      // Not decoded yet: schedule it the moment it is (if this session is still playing).
      let p = cached && cached.promise ? cached.promise : null;
      if (cached && cached.promise) this._prioritize(spec.mediaId);
      if (!p && media) p = this.getBuffer(media, { priority: true });
      if (p) {
        p.then((buf) => {
          if (buf && this._session === session) this._scheduleSpec(session, spec, buf);
        }, () => {});
      }
    }
    return startAt;
  }

  _buildSpecs(project, timeline, from) {
    const specs = [];
    const segs = timeline.segments || [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const item = seg && seg.item;
      if (!item || item.kind !== 'video' || !item.mediaId) continue;
      if (!(seg.duration > 0) || seg.end <= from + 1e-3) continue;
      const vol = Number.isFinite(item.volume) ? clamp(item.volume, 0, 1) : 1;
      if (vol <= 0) continue;
      const len = seg.duration;
      const envs = [fadeEnvelope(len, item.fadeIn, item.fadeOut)];
      const next = segs[i + 1];
      const dIn = seg.transitionIn ? seg.transitionIn.duration : 0;
      const dOut = next && next.transitionIn ? next.transitionIn.duration : 0;
      const xf = crossfadeEnvelope(len, dIn, dOut);
      if (xf) envs.push(xf);
      specs.push({
        mediaId: item.mediaId,
        bus: 'video',
        start: seg.start,
        end: seg.end,
        srcIn: seg.sourceIn || 0,
        srcOut: seg.sourceOut,
        rate: item.speed > 0 ? item.speed : 1,
        volume: vol,
        envs,
      });
    }
    const music = timeline.music || [];
    const duck = project.emphasize === 'narration' || project.duckMusic === true;
    let narr = null;
    if (duck) {
      narr = mergeIntervals(music.filter((m) => m.item && m.item.kind === 'narration' && m.end > m.start)
        .map((m) => [m.start, m.end]));
    }
    for (const m of music) {
      const item = m && m.item;
      if (!item || !item.mediaId || !(m.end > m.start) || m.end <= from + 1e-3) continue;
      const vol = Number.isFinite(item.volume) ? clamp(item.volume, 0, 1) : 1;
      if (vol <= 0) continue;
      const len = m.end - m.start;
      const envs = [fadeEnvelope(len, item.fadeIn, item.fadeOut)];
      if (narr && narr.length && item.kind !== 'narration') {
        const d = duckEnvelope(m.start, len, narr);
        if (d) envs.push(d);
      }
      specs.push({
        mediaId: item.mediaId,
        bus: 'music',
        start: m.start,
        end: m.end,
        srcIn: item.trimStart > 0 ? item.trimStart : 0,
        srcOut: Infinity,
        rate: 1,
        volume: vol,
        envs,
      });
    }
    return specs;
  }

  _scheduleSpec(session, spec, buffer) {
    const ctx = this._ctx;
    if (!ctx) return;
    const ctxAtTl = (tl) => session.startAt + (tl - session.from);
    // Timeline time that can still be scheduled (late decodes join mid-way).
    const earliest = session.from + Math.max(0, ctx.currentTime + LATE_LEAD - session.startAt);
    const tFrom = Math.max(spec.start, earliest, session.from);
    if (tFrom >= spec.end - 0.005) return;
    const local = tFrom - spec.start;
    const offset = spec.srcIn + local * spec.rate;
    if (offset >= buffer.duration - 0.002) return;
    const when = ctxAtTl(tFrom);
    const stopAt = ctxAtTl(spec.end);
    let src, gain;
    try {
      src = ctx.createBufferSource();
      src.buffer = buffer;
      if (spec.rate !== 1) {
        try { src.playbackRate.value = spec.rate; } catch (_) { /* unsupported rate: plays at 1x */ }
      }
      gain = ctx.createGain();
      scheduleGain(gain.gain, spec.envs, spec.volume, local, spec.end - spec.start,
        (x) => ctxAtTl(spec.start + x));
      src.connect(gain);
      gain.connect(spec.bus === 'video' ? session.videoBus : session.musicBus);
      src.start(when, Math.max(0, offset));
      src.stop(Math.max(when + 0.001, stopAt));
    } catch (err) {
      console.warn('Movie Maker: could not schedule a sound.', err);
      try { if (src) src.disconnect(); if (gain) gain.disconnect(); } catch (_) { /* ignore */ }
      return;
    }
    src.onended = () => {
      try { src.disconnect(); } catch (_) { /* ignore */ }
      try { gain.disconnect(); } catch (_) { /* ignore */ }
    };
    session.sources.push(src);
    session.nodes.push(gain);
  }

  /** Change the video/music balance of the running session without restarting it. */
  setMix(mix) {
    const s = this._session;
    const ctx = this._ctx;
    if (!s || !ctx) return;
    const g = mixGains(mix);
    try {
      s.videoBus.gain.setTargetAtTime(g.video, ctx.currentTime, 0.03);
      s.musicBus.gain.setTargetAtTime(g.music, ctx.currentTime, 0.03);
    } catch (_) {
      s.videoBus.gain.value = g.video;
      s.musicBus.gain.value = g.music;
    }
  }

  /** Number of sources in the current session (diagnostics / tests). */
  get activeSourceCount() { return this._session ? this._session.sources.length : 0; }

  get isPlaying() { return !!this._session; }

  /** Stop every scheduled source (with a short de-click ramp). */
  stop() {
    const s = this._session;
    this._session = null;
    if (!s) return;
    const ctx = this._ctx;
    const now = ctx ? ctx.currentTime : 0;
    try {
      const p = s.gain.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + DECLICK);
    } catch (_) {
      try { s.gain.gain.value = 0; } catch (__) { /* ignore */ }
    }
    for (const src of s.sources) {
      try { src.stop(now + DECLICK + 0.005); } catch (_) { /* already stopped / old engines */ }
    }
    const cleanup = () => {
      for (const src of s.sources) {
        try { src.onended = null; src.disconnect(); } catch (_) { /* ignore */ }
      }
      for (const n of s.nodes) { try { n.disconnect(); } catch (_) { /* ignore */ } }
      for (const n of [s.videoBus, s.musicBus, s.gain]) { try { n.disconnect(); } catch (_) { /* ignore */ } }
    };
    setTimeout(cleanup, 80);
    this._scheduleIdle();
  }

  // ---------- export ----------

  /** A MediaStreamAudioDestinationNode fed from the master gain (for MediaRecorder). */
  createStreamDestination() {
    const ctx = this.context;
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') {
      const err = new Error("This browser can't record sound from the movie.");
      err.code = 'no-stream-destination';
      throw err;
    }
    const dest = ctx.createMediaStreamDestination();
    try { dest.channelCount = 2; } catch (_) { /* ignore */ }
    this.masterGain.connect(dest);
    this._streamDests.add(dest);
    this._clearIdle();
    return dest;
  }

  /** Disconnect a destination created by createStreamDestination(). */
  releaseStreamDestination(dest) {
    if (!dest) return;
    this._streamDests.delete(dest);
    try { this._master.disconnect(dest); } catch (_) {
      // Engines without selective disconnect: rebuild the master's outgoing connections.
      try {
        this._master.disconnect();
        this._master.connect(this._speaker);
        for (const d of this._streamDests) this._master.connect(d);
      } catch (__) { /* ignore */ }
    }
    try { for (const tr of dest.stream.getTracks()) tr.stop(); } catch (_) { /* ignore */ }
    if (!this._session) this._scheduleIdle();
  }

  /** Release everything (tests / teardown). */
  async close() {
    this.stop();
    this._clearIdle();
    if (this._autoResumeInstalled && typeof document !== 'undefined') {
      const opts = { capture: true };
      for (const type of ['pointerdown', 'touchend', 'keydown', 'click']) document.removeEventListener(type, this._onGesture, opts);
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._autoResumeInstalled = false;
    }
    this._cache.clear();
    this._queue.length = 0;
    const ctx = this._ctx;
    this._ctx = null;
    this._master = null;
    this._speaker = null;
    if (ctx && typeof ctx.close === 'function') { try { await ctx.close(); } catch (_) { /* ignore */ } }
  }
}
