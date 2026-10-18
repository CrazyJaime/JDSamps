// engine/loader.js — a tab made resident (§3, §4): the strategy ladder over the page tap (agent/agent-main.js),
// strict assembly (assemble.js) and whole-track analysis, with live as the fallback. The engine builds one Loader
// per load job, for a loading deck that holds the tab's capture, and keeps it in engine.loads; the deck routes
// its agents' tap messages here while it loads.
//
// Rungs, in order from the one the site table names for the host (§4.6; any other host starts at the first):
//   file     §4.1  the page's own track link (Bandcamp's data-tralbum), fetched by the page
//   refetch  §4.2  the media file, or the playlist and segments, the page requested: fetched again by the page
//   drive    §4.3  the page's player run through the track (seek-hop, then accelerate) while the tap captures
//                  what it appends
// then live. A rung whose precondition is absent is not tried, and says why. Protected media, MSE in a worker,
// a stream with no end, a page with no player the tap can read and a preview go live at once (§4.5).
import { HUB } from '../shared/protocol.js';
import { placeParts, gapsFor, decodePlaced, AssemblyError } from './assemble.js';
import { decodeTo, limitPcm, fetchArrayBuffer, resample } from './decode.js';
import { mp3Frames, adtsFrames } from './bmff.js';

/** Site table (§4.6): host suffix -> first rung. The only per-site knowledge there is. */
export const SITES = Object.freeze({
  'bandcamp.com': 'file',
  'mixcloud.com': 'refetch',
  'soundcloud.com': 'refetch',
  'youtube.com': 'drive',
  'youtu.be': 'drive',
});
const RUNGS = ['file', 'refetch', 'drive'];

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; } };
const siteOf = (host) => Object.keys(SITES).find((s) => host === s || host.endsWith(`.${s}`)) || null;
/** The rung a page's host starts at. */
export function firstRung(url) { const s = siteOf(hostOf(url)); return s ? SITES[s] : RUNGS[0]; }

/** Waits, in ms. A load job's tests shrink them. */
export const TIMES = Object.freeze({
  grace: 2000,       // after the hub has asked the tab's frames to connect: their agents' ports follow at once
  settle: 700,       // after the player's length is known: the tap's errors, links and kept inits are on their way
  duration: 8000,    // the most to wait for the player to say how long the track is (a stream says it has no end after 3 s)
  file: 65000,       // the page's track link (the agent gives it 60 s)
  fetchEach: 15000,  // per eight links fetched by the page (the agent gives each 15 s)
  stall: 5000,       // a seek-hop that brings no new audio this long is given up for accelerate
  drive: 30000,      // a drive's budget: this, plus drivePerSec for each second of the track
  drivePerSec: 250,
  check: 400,        // between gap checks while driving (each one places every piece)
});

/** Plain words for the deck's loading state. */
const SAY = {
  wait: 'waiting for the page', look: "looking at the page's player", file: "reading the page's track link",
  media: 'fetching the track', pieces: "fetching the track's pieces", hop: 'running the player through the track',
  fast: (r) => `running the player through the track (${r}×)`, decode: 'decoding', beat: 'finding the beat',
};
/** Why a deck plays live after all: said once, after "Deck N: ". */
const LIVE = {
  drm: "this page's audio is protected, so it plays live from the tab.",
  worker: 'this page plays its audio from a worker the deck cannot read, so it plays live from the tab.',
  live: 'this is a live stream with no end, so it plays live from the tab.',
  preview: 'SoundCloud only gives a 30-second preview of this track. The deck plays the preview live from the tab.',
  webaudio: 'this page makes its sound without a media player the deck can read, so it plays live from the tab.',
  unreachable: "the deck cannot reach this page's player, so it plays live from the tab.",
  length: "the page's player does not say how long the track is, so it plays live from the tab.",
  gone: 'the page changed while the track was loading, so it plays live from the tab.',
  big: 'the track is too large to hold, so it plays live from the tab.',
  failed: (why) => `the whole track could not be read from this page (${why}), so it plays live from the tab.`,
};
const DECISIVE = ['drm', 'worker', 'preview', 'live'];
const NO_LENGTH = "the page's player has not said how long the track is";
const TAB_CAP = 600 * 2 ** 20;       // bytes from one tab: each frame's tap holds at most this, and so does the whole tab
const NO_STAMPS = /^audio\/(mpeg|mp3|aac|x-aac)\b/i; // placed in append order only: never seek-hopped
const DRIVE_RATE = 8;
const FETCHED = 1e6;                 // placement keys of fetched batches, clear of the tap's SourceBuffers (frame * 1000 + sb)

class Stop extends Error {
  /** kind: 'cancel' (the deck was ejected or the load cancelled) or 'live' (play the tab live, saying why). */
  constructor(kind, message) { super(message); this.kind = kind; }
}
const now = () => performance.now();
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const span = ([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} s`;
const kb = (n) => (n < 1e6 ? `${Math.round(n / 1e3)} kB` : `${(n / 1e6).toFixed(1)} MB`);
const minutes = (m) => `${+m.toFixed(1)} minute${m === 1 ? '' : 's'}`;
const short = (u) => { try { const x = new URL(u); return `${x.host}${x.pathname.length > 40 ? `…${x.pathname.slice(-40)}` : x.pathname}`; } catch (_) { return String(u).slice(0, 60); } };
const uniq = (xs) => [...new Set(xs)];

/**
 * An HLS playlist: {variants: [{bw, url}]} for a master playlist, {init, segs: [{url, t0, t1}]} for a media
 * playlist, or null (not HLS, encrypted segments, or byte ranges of one file, none of which are read here).
 */
export function parseHls(text, base) {
  const s = String(text);
  if (!/^\s*#EXTM3U/.test(s)) return null;
  const abs = (u) => new URL(u, base).href, variants = [], segs = [];
  let init = null, dur = null, bw = null, t = 0;
  try {
    for (const raw of s.split(/\r?\n/)) {
      const line = raw.trim();
      let m;
      if (!line) continue;
      if ((m = /^#EXT-X-STREAM-INF:(.*)$/.exec(line))) { bw = Number((/BANDWIDTH=(\d+)/.exec(m[1]) || [])[1]) || 0; continue; }
      if (/^#EXT-X-KEY:.*METHOD=(?!NONE)/.test(line) || /^#EXT-X-BYTERANGE/.test(line) || /^#EXT-X-MAP:.*BYTERANGE/.test(line)) return null;
      if ((m = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line))) { init = abs(m[1]); continue; }
      if ((m = /^#EXTINF:([\d.]+)/.exec(line))) { dur = Number(m[1]); continue; }
      if (line[0] === '#') continue;
      if (bw != null) { variants.push({ bw, url: abs(line) }); bw = null; } else if (dur != null) { segs.push({ url: abs(line), t0: t, t1: t + dur }); t += dur; dur = null; }
    }
  } catch (_) { return null; }
  if (variants.length) return { variants };
  return segs.length ? { init, segs } : null;
}

/**
 * A whole file's MP3 or ADTS frames, walked (cut: the first frame boundary at or past `until` s), or null for any
 * other format: those have a layout of their own and cannot be cut short at a frame.
 */
function framesOf(bytes, until) {
  const u = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength)), head = String.fromCharCode(...u.subarray(0, 4)), box = String.fromCharCode(...u.subarray(4, 8));
  if (/^(ftyp|moov|styp|moof)$/.test(box) || /^(\x1aE\xdf\xa3|OggS|RIFF|fLaC)$/.test(head)) return null;
  for (const walk of [mp3Frames, adtsFrames]) { const w = walk(bytes, { until }); if (w.frames && !w.midJunk) return w; }
  return null;
}

/** A placement cut to the segments that start before `until` (the resident limit). */
function trimPlaced(placed, until) {
  const runs = [];
  for (const r of placed.runs) { const segs = r.segs.filter((s) => s.t0 < until); if (segs.length) runs.push({ ...r, segs }); }
  const end = runs.length ? runs.at(-1).segs.at(-1).t1 : 0;
  return { ...placed, runs, coverage: placed.coverage.filter(([a]) => a < end).map(([a, b]) => [a, Math.min(b, end)]), end };
}

/** A load job's waiting and progress: what Loader and Recording share. */
class Job {
  constructor(engine, deck, signal) {
    this.engine = engine;
    this.deck = deck;
    this.signal = signal;
    this.waiters = new Set();
    this.done = false;
    this.progress = 0;
    signal.addEventListener('abort', () => this.poke(), { once: true });
  }

  /** Resolves true once cond() holds (checked whenever the page says something), false after ms; rejects when cancelled. */
  until(cond, ms) {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) { reject(new Stop('cancel', 'Loading was cancelled.')); return; }
      if (cond()) { resolve(true); return; }
      const w = { cond, resolve, reject, timer: 0 };
      w.timer = setTimeout(() => { this.waiters.delete(w); resolve(false); }, Math.max(0, ms));
      this.waiters.add(w);
    });
  }
  sleep(ms) { return this.until(() => false, ms); }
  poke() {
    for (const w of [...this.waiters]) {
      let go = false;
      if (this.signal.aborted) { clearTimeout(w.timer); this.waiters.delete(w); w.reject(new Stop('cancel', 'Loading was cancelled.')); continue; }
      try { go = w.cond(); } catch (_) {}
      if (go) { clearTimeout(w.timer); this.waiters.delete(w); w.resolve(true); }
    }
  }
  /** No more waiting: every timer cleared. */
  end() {
    this.done = true;
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.clear();
  }

  /** Progress only goes up; strategy in plain words (undefined: unchanged). */
  say(p, strategy) {
    if (this.done) return;
    this.progress = Math.max(this.progress, Math.min(0.99, p));
    this.deck.setLoad(strategy === undefined ? { progress: this.progress } : { progress: this.progress, strategy });
  }
  /** A rung's own 0..1 mapped onto what is left of the bar before decoding. */
  band(hi = 0.8) { const lo = Math.min(this.progress, hi); return (x) => lo + Math.max(0, Math.min(1, x)) * (hi - lo); }
}

export class Loader extends Job {
  /**
   * engine: the Engine (or a stand-in with the same methods); deck: the loading deck, holding the tab's capture;
   * signal: aborted when the deck is ejected or the load cancelled. deps: fetchBytes, decodeFile, decodePlaced,
   * placeParts, gapsFor and times, for tests.
   */
  constructor({ engine, deck, tabId, signal, deps = {} }) {
    super(engine, deck, signal);
    const { times, ...d } = deps;
    this.tabId = tabId;
    this.d = { fetchBytes: fetchArrayBuffer, decodeFile: decodeTo, decodePlaced, placeParts, gapsFor, ...d };
    this.t = { ...TIMES, ...times };
    this.frames = new Map();   // frameId -> what its agent said, and what it handed over
    this.inflight = new Set(); // blob: URLs being read
    this.fetched = [];         // pieces fetched again, keyed for placement
    this.tried = new Set();    // links already fetched again
    this.batch = 0;
    this.tapping = false;
    this.gone = null;          // the page went away mid-load
    this.pinned = null;        // the frame whose player is the track, once the page has been looked at
    this.big = false;
    this.bytes = 0;            // read from the tab, all frames
    this.host = hostOf(deck.meta && deck.meta.url);
    this.rep = { steps: [], mimes: new Set(), refetched: 0, placed: null, limit: null, result: null, notes: [], t0: now() };
  }

  // ---------------------------------------------------------------- the deck's agents
  onAttach(frameId, a) {
    if (this.done || this.gone) return;
    const f = { id: frameId, n: this.frames.size + 1, a, on: false, left: false, parts: [], reqs: [], errors: [], prog: null, own: null, bytes: 0, fetch: null, asked: false, answer: null, file: null, fileDuration: null };
    this.frames.set(frameId, f);
    if (this.tapping) this.tapOn(f);
    this.poke();
  }

  onDetach(frameId, a) {
    const f = this.frames.get(frameId);
    if (!f || f.a !== a || f.left) return;
    f.left = true;
    // The top frame's agent going (or the last one, or the track's) is the page going: navigated, reloaded or closed.
    if (!this.done && !this.gone && (frameId === 0 || !this.attached().length || f === this.pinned)) this.gone = 'the page went away';
    this.poke();
  }

  onTap(frameId, m) {
    const f = this.frames.get(frameId);
    if (!f || f.left || this.done) return;
    if (m.t === 'tap-progress') {
      f.prog = m;
      for (const x of m.mimes) this.rep.mimes.add(x);
      if (m.sbs) { f.own = f.own || new Set(); for (const i of m.sbs) f.own.add(i); } // its player's SourceBuffers, as the tap says
    } else if (m.t === 'tap-urls') {
      for (const r of m.reqs) if (f.reqs.length < 2000) f.reqs.push({ ...r, frame: f });
    } else if (m.t === 'tap-ready') {
      for (const p of m.parts) this.take(f, p, m.duration);
    } else if (m.t === 'tap-error') {
      f.errors.push(m);
      if (m.reason === 'fetch' && m.seq != null) { if (f.fetch && m.seq < f.fetch.urls.length) f.fetch.failed.set(m.seq, m.detail); }
      else if (f.asked && !f.answer && (m.reason === 'none' || m.reason === 'fetch')) f.answer = m;
      if (m.reason === 'none' && /too large/.test(m.detail)) this.big = true;
    }
    this.poke();
  }

  /** A part the tap handed over: read at once (a page's blob: URL dies with the page). */
  take(f, p, duration) {
    if (p.sb === -1 && p.kind === 'file') {
      if (f.asked && !f.file) { f.file = this.grab(p.blobUrl, (b) => b); f.fileDuration = duration; }
    } else if (p.sb === -1) {
      const job = f.fetch;
      if (job && p.seq < job.urls.length && !job.got.has(p.seq)) job.got.set(p.seq, this.grab(p.blobUrl, (b) => b));
    } else {
      // The player's own appends. SourceBuffers are numbered per frame: kept apart by the frame's number.
      this.grab(p.blobUrl, (bytes) => { f.bytes += bytes.byteLength; f.parts.push({ bytes, mime: p.mime, kind: p.kind, sb: f.n * 1000 + p.sb, seq: p.seq }); });
    }
  }

  /** Read a blob: URL; sink(bytes) once it is in. The promise never rejects: null when it could not be read. */
  grab(url, sink) {
    const job = this.d.fetchBytes(url, { signal: this.signal }).then((bytes) => {
      this.bytes += bytes.byteLength;
      if (this.bytes > TAB_CAP) this.big = true;
      return sink(bytes);
    }, () => {
      // A blob: URL the page minted dies with the page (or its tap was switched off): the page has gone.
      if (!this.signal.aborted && !this.done) this.gone = this.gone || 'a piece the page handed over could not be read';
      return null;
    });
    this.inflight.add(job);
    job.then(() => { this.inflight.delete(job); this.poke(); });
    return job;
  }

  send(f, m) { try { f.a.port.postMessage(m); } catch (_) {} }
  tapOn(f) { if (!f.on) { f.on = true; this.send(f, { t: 'tap', on: true }); } }

  attached() { return [...this.frames.values()].filter((f) => !f.left); }
  top() { const f = this.frames.get(0); return f && !f.left ? f : this.attached()[0] || null; }
  /**
   * The frame whose player is the track: the one its agent says the user hears playing, else one playing, and of
   * those the longest (a shorter one beside it is an advert or a jingle). Fixed once the page has been looked at.
   * The track's length, links, pieces and drive are that frame's: another player's never become the track's.
   */
  track() {
    if (this.pinned) return this.pinned.left ? null : this.pinned;
    const rank = (f) => { const s = f.a && f.a.status; return s && s.playing ? (s.audible > 0 ? 2 : 1) : 0; };
    const len = (f) => (f.prog && f.prog.duration) || 0;
    let best = null;
    for (const f of this.attached()) if (!best || rank(f) > rank(best) || (rank(f) === rank(best) && len(f) > len(best))) best = f;
    return best;
  }
  reqs() { const f = this.track(); return f ? f.reqs : []; }
  mimes() { return [...this.rep.mimes]; }
  /**
   * The track's frame, when its player uses Media Source: it is fed by a SourceBuffer, as the tap says (or, when it
   * cannot tell, the tap saw one in that frame, or what one appended).
   */
  mseFrame() { const f = this.track(); return f && (f.own ? f.own.size > 0 : (f.prog && f.prog.mimes.length) || f.parts.length) ? f : null; }
  /** A frame's captured appends: only those of the SourceBuffers feeding its player, when the tap says which. */
  own(f) { return f.own ? f.parts.filter((p) => f.own.has(p.sb - f.n * 1000)) : f.parts; }
  /** How long the track's player says the track is. */
  duration() { const f = this.track(); return f && f.prog ? f.prog.duration : null; }
  limitSec() { return (this.engine.params['resident.limitMin'] || 15) * 60; }
  /**
   * What must be covered: the track, or its first part when it is longer than the resident limit (a second
   * past the limit, so the cut to it lands inside decoded audio, clear of the codec delay at the end).
   */
  target() { const D = this.duration(), L = this.limitSec(); return D == null ? null : D <= L ? D : Math.min(D, L + 1); }
  decisive() {
    for (const f of this.attached()) for (const e of f.errors) if (DECISIVE.includes(e.reason)) return e.reason;
    return null;
  }

  // ---------------------------------------------------------------- waiting
  /** After every await: stop if the load was cancelled, the deck is gone, or the page went away. */
  check() {
    if (this.signal.aborted || this.engine.decks.get(this.deck.id) !== this.deck) throw new Stop('cancel', 'Loading was cancelled.');
    if (this.gone) throw new Stop('live', LIVE.gone);
    if (this.big) throw new Stop('live', LIVE.big);
  }
  async drain() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
    this.check();
  }

  // ---------------------------------------------------------------- the job
  /** -> {ok:true, kind:'resident'|'live', deckId, slot} or {ok:false, error}. Never rejects. */
  async run() {
    let out;
    try {
      this.say(0, SAY.wait);
      await this.connect();
      await this.look();
      out = await this.finish(await this.climb());
    } catch (err) {
      out = await this.fail(err);
    } finally {
      this.end();
    }
    return out;
  }

  /** The tab's frames' agents: asked to connect again (they did for the deck's start), then tapped. */
  async connect() {
    const t0 = now();
    for (const [id, a] of this.deck.agents) if (!this.frames.has(id)) this.onAttach(id, a); // connected before this load began
    const r = await this.engine.hub({ type: HUB.AGENT_CONNECT, tabId: this.tabId });
    this.check();
    if (!this.attached().length) await this.until(() => this.attached().length > 0, this.t.grace);
    this.check();
    const n = this.attached().length;
    this.rep.steps.push({ name: 'connect', outcome: n ? 'ok' : 'none', why: `${n} frame${n === 1 ? '' : 's'} with a player`, ms: now() - t0 });
    if (!n) throw new Stop('live', r && r.ok === false ? LIVE.unreachable : LIVE.webaudio);
    this.tapping = true;
    for (const f of this.attached()) this.tapOn(f);
  }

  /** What the tap first says: the player's length, and anything that sends the deck live at once. */
  async look() {
    const t0 = now();
    this.say(0.02, SAY.look);
    await this.until(() => !!this.decisive() || this.duration() != null, this.t.duration);
    this.check();
    await this.until(() => !!this.decisive(), this.t.settle); // errors and links still on their way
    this.check();
    this.pinned = this.track();
    const why = this.decisive(), D = this.duration();
    this.rep.steps.push({ name: 'look', outcome: why || 'ok', why: D != null ? `the player says ${D.toFixed(3)} s` : "the player's length is not known", ms: now() - t0 });
    if (why) throw new Stop('live', LIVE[why]);
  }

  /** The rungs, from the site's first. -> {pcm, notice} for a whole track; throws Stop('live') when none gives one. */
  async climb() {
    const first = firstRung(this.deck.meta && this.deck.meta.url), order = RUNGS.slice(RUNGS.indexOf(first));
    for (const r of RUNGS) if (!order.includes(r)) this.rep.steps.push({ name: r, outcome: 'skipped', why: `the site table starts ${this.host} at ${first}`, ms: 0 });
    for (const rung of order) {
      const got = await this.step(rung, (e) => this[rung](e));
      if (got) return got;
    }
    // Links the player asked for while it was driven: one more pass at them.
    if (order.includes('refetch') && this.mseFrame() && this.wanted(this.plan).urls.length) {
      const got = await this.step('refetch', (e) => this.refetch(e));
      if (got) return got;
    }
    const tried = this.rep.steps.filter((s) => RUNGS.includes(s.name) && s.outcome !== 'skipped');
    if (!tried.length) throw new Stop('live', this.rep.steps.some((s) => s.why === NO_LENGTH) ? LIVE.length : LIVE.webaudio);
    throw new Stop('live', LIVE.failed(tried.find((s) => s.outcome === 'failed').why));
  }

  /** Run one rung, noting how it went: its result is {done: {pcm, notice}} or {outcome, why}. */
  async step(name, fn) {
    const e = { name, how: '', outcome: '', why: '', ms: 0 }, t0 = now();
    this.rep.steps.push(e);
    try {
      const r = await fn(e);
      e.outcome = r.done ? 'ok' : r.outcome || 'failed';
      e.why = r.why || (r.again ? 'the track length changed while it loaded' : e.why);
      return r.done || null;
    } catch (err) {
      e.outcome = err instanceof Stop && err.kind === 'cancel' ? 'cancelled' : 'stopped';
      e.why = err.message;
      throw err;
    } finally { e.ms = now() - t0; }
  }

  // ---------------------------------------------------------------- rung: the page's own track link (§4.1)
  async file(e) {
    e.how = SAY.file;
    const f = this.top();
    this.say(this.progress, SAY.file);
    f.asked = true;
    this.send(f, { t: 'readTralbum' });
    await this.until(() => !!f.file || !!f.answer || f.left, this.t.file);
    this.check();
    if (f.answer) {
      return f.answer.reason === 'none'
        ? { outcome: 'skipped', why: 'the page has no track link of its own' }
        : { outcome: 'failed', why: `the page's track link failed (${f.answer.detail})` };
    }
    if (!f.file) return { outcome: 'failed', why: 'the page did not answer for its track link' };
    const bytes = await f.file;
    this.check();
    if (!bytes) return { outcome: 'failed', why: "the page's track link could not be read" };
    this.rep.refetched += bytes.byteLength;
    return this.wholeFile(bytes, f.fileDuration || this.duration(), "the page's track link");
  }

  /**
   * A whole media file, decoded and checked against the length the page gives (`expect`, s). Longer than the resident
   * limit, an MP3 or ADTS file is cut at the frame a second past it, and only that part is decoded; a file in any other
   * format is decoded whole, so only up to twice the limit.
   */
  async wholeFile(bytes, expect, what) {
    const L = this.limitSec(), w = framesOf(bytes, L + 1), own = w ? w.samples / w.sampleRate : null;
    const off = (got, want) => Math.abs(got - want) > Math.max(0.5, 0.01 * want);
    if (own && expect && off(own, expect)) return { outcome: 'failed', why: `${what} holds ${own.toFixed(1)} s, but the page's player says ${expect.toFixed(1)} s` };
    const cut = own > L + 0.5 && w.cut ? w.cut : null, part = cut && cut.samples / w.sampleRate;
    if (!own && expect && expect > 2 * L) return { outcome: 'failed', why: `${what} is ${minutes(expect / 60)} long, too long to decode whole` };
    this.say(this.progress, SAY.decode);
    const t0 = now();
    let pcm;
    try { pcm = await this.d.decodeFile(this.engine.ctx, cut ? bytes.slice(0, cut.end) : bytes); } catch (_) { this.check(); return { outcome: 'failed', why: `${what} is not audio this browser can play` }; }
    this.check();
    this.rep.steps.push({ name: 'decode', outcome: 'ok', why: cut ? `${what}, its first ${part.toFixed(1)} s` : what, ms: now() - t0 });
    const got = pcm.L.length / pcm.sampleRate;
    if (cut && off(got, part)) return { outcome: 'failed', why: `the first ${part.toFixed(1)} s of ${what} decoded to ${got.toFixed(1)} s` };
    if (!cut && expect && off(got, expect)) return { outcome: 'failed', why: `${what} holds ${got.toFixed(1)} s, but the page's player says ${expect.toFixed(1)} s` };
    return { done: this.limited(pcm, cut ? own : got) };
  }

  /** {pcm, notice}: the track, or its first part when it is longer than the resident limit (said once). */
  limited(pcm, length) {
    const lim = limitPcm(pcm, this.engine.params['resident.limitMin']);
    // Said of the track's own length: a cut placement decodes only a little past the limit.
    const notice = length > this.limitSec() + 0.5
      ? `this track is ${minutes(length / 60)} long: the deck holds its first ${minutes(this.limitSec() / 60)} (the resident track limit).` : lim.notice;
    if (notice) this.rep.limit = notice;
    return { pcm: lim.pcm, notice };
  }

  // ---------------------------------------------------------------- rung: what the page requested, again (§4.2)
  refetch(e) { return this.mseFrame() ? this.refetchPieces(e) : this.refetchFile(e); }

  /** A progressive player's media file (an <audio src> the URL layer saw), from the page, else from here. */
  async refetchFile(e) {
    e.how = SAY.media;
    const D = this.duration();
    const urls = uniq(this.reqs().filter((r) => r.media && r.method === 'GET' && (!r.range || /^bytes=0-$/i.test(r.range))).map((r) => r.url));
    if (!urls.length) return { outcome: 'skipped', why: 'the page has asked for no media file' };
    if (D == null) return { outcome: 'skipped', why: NO_LENGTH };
    const why = [];
    for (const url of urls.slice(0, 3)) {
      this.say(this.progress, SAY.media);
      const [bytes] = await this.fetchUrls(this.frameOf(url), [url]);
      if (!bytes) { why.push(`${short(url)} could not be fetched`); continue; }
      this.rep.refetched += bytes.byteLength;
      const r = await this.wholeFile(bytes, D, 'the media file');
      if (r.done) return r;
      why.push(r.why);
    }
    return { outcome: 'failed', why: why[0] };
  }

  /** A Media Source player's pieces: the ones still missing, from the playlist it read or the links it fetched. */
  async refetchPieces(e) {
    e.how = SAY.pieces;
    if (this.mimes().some((m) => /mp2t/i.test(m))) return { outcome: 'skipped', why: 'the player appends MPEG-TS, which cannot be decoded directly' };
    if (this.target() == null) return { outcome: 'skipped', why: NO_LENGTH };
    const lists = uniq(this.reqs().filter((r) => !r.media && r.method === 'GET').map((r) => r.url));
    if (!lists.length && !this.reqs().some((r) => r.media && r.method === 'GET')) {
      return { outcome: 'skipped', why: 'the player fetched nothing that can be fetched again' };
    }
    if (this.plan === undefined) {
      this.plan = null;
      for (const url of lists.slice(0, 4)) { this.plan = await this.readList(url); if (this.plan) break; }
    }
    let fetched = 0, failed = 0;
    const counts = () => `${fetched} pieces fetched${failed ? `, ${failed} failed` : ''}`;
    for (let round = 0; round < 3; round++) {
      const placed = await this.complete();
      if (placed) { const r = await this.decodeOr(placed); if (!r.again) return { why: counts(), ...r }; continue; }
      const want = this.wanted(this.plan);
      if (!want.urls.length) break;
      const n = await this.fetchPieces(want);
      fetched += n.ok; failed += n.failed;
    }
    const placed = await this.complete();
    if (placed) return { why: counts(), ...(await this.decodeOr(placed)) };
    return { outcome: 'failed', why: `${counts()}, still missing ${this.gapsNow().map(span).join(', ') || 'the track length'}` };
  }

  /** A playlist the page requested: its best variant's init and timed segments, or null. */
  async readList(url) {
    const f = this.frameOf(url);
    const [buf] = await this.fetchUrls(f, [url]);
    let pl = buf ? parseHls(new TextDecoder().decode(buf), url) : null;
    if (pl && pl.variants) {
      const best = pl.variants.reduce((a, b) => (b.bw > a.bw ? b : a));
      const [b2] = await this.fetchUrls(f, [best.url]);
      pl = b2 ? parseHls(new TextDecoder().decode(b2), best.url) : null;
      if (pl && pl.variants) pl = null;
    }
    if (!pl) { this.rep.notes.push(`${short(url)}: ${buf ? 'not a playlist the deck can read' : 'could not be fetched'}`); return null; }
    return { ...pl, frame: f };
  }

  /** Links to fetch for what is still missing: from the plan, else every segment link the page fetched. */
  wanted(plan) {
    const gaps = this.gapsNow();
    if (plan) {
      const urls = plan.segs.filter((s) => !this.tried.has(s.url) && gaps.some(([a, b]) => s.t0 < b - 1e-3 && s.t1 > a + 1e-3)).map((s) => s.url);
      return { frame: plan.frame, init: plan.init, urls };
    }
    const urls = uniq(this.reqs().filter((r) => r.media && r.method === 'GET' && !this.tried.has(r.url)).map((r) => r.url));
    return { frame: this.frameOf(urls[0]), init: null, urls };
  }

  /** Fetch [init, ...urls] as one placement stream (with the player's own init when the playlist names none). */
  async fetchPieces({ frame, init, urls }) {
    const list = init ? [init, ...urls] : urls, band = this.band();
    for (const u of urls) this.tried.add(u);
    this.say(this.progress, SAY.pieces);
    const got = await this.fetchUrls(frame, list, (n) => this.say(band(n / list.length)));
    const sb = FETCHED + this.batch++;
    let seq = 0;
    if (!init) { const own = this.ownInit(); if (own) this.fetched.push({ bytes: own.bytes, mime: own.mime, kind: 'init', sb, seq: seq++ }); }
    let ok = 0;
    for (const b of got) if (b) { ok++; this.rep.refetched += b.byteLength; this.fetched.push({ bytes: b, mime: '', kind: 'media', sb, seq: seq++ }); }
    return { ok, failed: list.length - ok };
  }

  /** The latest init segment the player appended (its Media Source frame's, highest seq). */
  ownInit() {
    const f = this.mseFrame();
    const inits = f ? this.own(f).filter((p) => p.kind === 'init') : [];
    return inits.sort((a, b) => b.seq - a.seq)[0] || null;
  }

  frameOf(url) { const r = this.reqs().find((x) => x.url === url); return r ? r.frame : this.track() || this.top(); }

  /** Fetch links from the page (it holds the session signed links are bound to), and from here what it could not. */
  async fetchUrls(f, urls, onCount) {
    const out = await this.pageFetch(f, urls, onCount);
    const miss = urls.map((_, i) => i).filter((i) => !out[i]);
    let k = 0;
    const worker = async () => {
      while (k < miss.length && !this.signal.aborted) {
        const i = miss[k++];
        try { out[i] = await this.d.fetchBytes(urls[i], { signal: this.signal }); } catch (_) { out[i] = null; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, miss.length) }, worker));
    this.check();
    return out;
  }

  /** The page fetches the links (eight at a time) and hands each over as a blob: URL. -> bytes or null, by index. */
  async pageFetch(f, urls, onCount) {
    const out = new Array(urls.length).fill(null);
    if (!f || f.left) return out;
    for (let i = 0; i < urls.length; i += 512) {
      const chunk = urls.slice(i, i + 512), job = { urls: chunk, got: new Map(), failed: new Map() };
      f.fetch = job;
      this.send(f, { t: 'fetch', urls: chunk, concurrency: 8 });
      await this.until(() => {
        const n = job.got.size + job.failed.size;
        if (onCount) onCount(i + n);
        return n >= chunk.length || f.left;
      }, this.t.fetchEach * Math.ceil(chunk.length / 8) + 2000);
      f.fetch = null;
      const got = await Promise.all(chunk.map((_, j) => job.got.get(j) || null));
      got.forEach((b, j) => { out[i + j] = b; });
      this.check();
    }
    return out;
  }

  // ---------------------------------------------------------------- rung: drive the player (§4.3)
  async drive(e) {
    const f = this.mseFrame();
    if (!f) return { outcome: 'skipped', why: "the page's player does not use Media Source, so driving it would capture nothing" };
    const T = this.target();
    if (T == null) return { outcome: 'skipped', why: NO_LENGTH };
    const stampless = !!(f.prog && f.prog.mimes.length && f.prog.mimes.every((m) => NO_STAMPS.test(m)));
    let mode = null, placed = null, out = null, pass = null;
    const go = (m, from) => {
      mode = m;
      this.send(f, m === 'seekhop' ? { t: 'drive', mode: m } : { t: 'drive', mode: m, rate: DRIVE_RATE, ...(from != null ? { from } : {}) });
      const how = m === 'seekhop' ? 'seek-hop' : `accelerate ${DRIVE_RATE}×${from != null ? ` from ${from.toFixed(1)} s` : ''}`;
      e.how = e.how ? `${e.how}, then ${how}` : how;
      this.say(this.progress, m === 'seekhop' ? SAY.hop : SAY.fast(DRIVE_RATE));
    };
    const band = this.band(), end = now() + this.t.drive + T * this.t.drivePerSec;
    let bytes = f.bytes, fresh = now(), checked = 0;
    try {
      go(stampless ? 'accelerate' : 'seekhop');
      for (;;) {
        const seen = f.prog;
        await this.until(() => f.prog !== seen || f.left, this.t.check);
        this.check();
        if (f.bytes !== bytes) { bytes = f.bytes; fresh = now(); }
        const d = f.prog && f.prog.drive, st = d && d.mode === mode && !(pass && f.prog === pass.prog) ? d.state : 'running';
        if (st === 'done' || now() - checked >= this.t.check) {
          checked = now();
          placed = await this.complete();
          if (placed) break;
          this.say(band(this.covered()));
        }
        if (st === 'done') {
          await this.sleep(2 * this.t.check); // a last piece may still be on its way
          this.check();
          placed = await this.complete();
          if (placed) break;
          const gaps = this.gapsNow();
          if (!gaps.length) { out = { outcome: 'failed', why: NO_LENGTH }; break; } // the player no longer gives a length
          const why = `the player buffered the whole track, but ${gaps.map(span).join(', ')} came before the deck could read it`;
          // A player keeps only so much behind its playhead: what it held from before the tap may be gone from it by
          // now, and run once more from the first gap it fetches that again (never for appends placed in order only).
          if (!pass && !stampless) { pass = { why, prog: f.prog }; go('accelerate', gaps[0][0]); fresh = now(); continue; }
          out = { outcome: 'failed', why: pass ? pass.why : why };
          break;
        }
        if (mode === 'seekhop' && (st === 'refused' || now() - fresh > this.t.stall)) { go('accelerate'); fresh = now(); continue; }
        if (mode === 'accelerate' && st === 'refused') { out = { outcome: 'failed', why: pass ? pass.why : 'the page will not let its player run faster' }; break; }
        if (now() > end) { out = { outcome: 'failed', why: `the player had not given the whole track after ${secs(now() - end + this.t.drive + T * this.t.drivePerSec)} (missing ${this.gapsNow().map(span).join(', ')})` }; break; }
      }
    } finally {
      this.send(f, { t: 'drive', mode: 'stop' }); // always: the player gets back its rate, pitch, mute and place
    }
    if (out) return out;
    return { why: `${this.own(f).length} pieces captured from the player`, ...(await this.decodeOr(placed)) };
  }

  // ---------------------------------------------------------------- assembly
  parts() { const f = this.track(); return [...(f ? this.own(f) : []), ...this.fetched]; }

  /** The placement of everything captured and fetched when it covers the track (re-checked against the latest length), else null. */
  async complete() {
    await this.drain();
    const T = this.target(), parts = this.parts();
    if (T == null || !parts.length) return null;
    const placed = this.d.placeParts(parts);
    this.rep.placed = placed;
    return this.d.gapsFor(placed, T).length ? null : placed;
  }
  gapsNow() {
    const T = this.target();
    if (T == null) return [];
    return this.rep.placed ? this.d.gapsFor(this.rep.placed, T) : [[0, T]];
  }
  covered() {
    const T = this.target();
    if (!T || !this.rep.placed) return 0;
    return 1 - this.gapsNow().reduce((n, [a, b]) => n + (b - a), 0) / T;
  }

  /** {done: {pcm, notice}}, {again: true} when the length changed while decoding, or {outcome:'failed', why}. */
  async decodeOr(placed) {
    const D = this.duration(), T = this.target(), cut = T < D - placed.tol, t0 = now();
    this.say(0.8, SAY.decode);
    let pcm;
    try {
      const use = cut ? trimPlaced(placed, T) : placed;
      pcm = await this.d.decodePlaced(this.engine.ctx, use, { duration: cut ? use.end : D });
    } catch (err) {
      if (err instanceof Stop) throw err;
      this.check();
      return { outcome: 'failed', why: err instanceof AssemblyError ? err.message : `the audio would not decode (${err.message})` };
    }
    this.check();
    this.rep.steps.push({ name: 'decode', outcome: 'ok', why: `${placed.runs.length} run${placed.runs.length === 1 ? '' : 's'}`, ms: now() - t0 });
    if (Math.abs(this.duration() - D) > placed.tol) return { again: true }; // never resident at a length the page no longer gives
    return { done: this.limited(pcm, D) };
  }

  // ---------------------------------------------------------------- the end
  async finish({ pcm, notice }) {
    const d = this.deck, e = this.engine, t0 = now();
    this.say(0.85, SAY.beat);
    let analysis = null;
    try { analysis = await e.analyse(pcm, this.signal); } catch (err) {
      this.check();
      e.event('warn', `Deck ${d.slot}: no beat grid from the whole track (${err.message}). TAP the beat.`, d.id);
    }
    this.check();
    this.rep.steps.push({ name: 'beat', outcome: analysis ? 'ok' : 'none', why: analysis && analysis.bpm > 0 ? `${analysis.bpm.toFixed(2)} BPM` : 'no steady beat', ms: now() - t0 });
    const res = await e.serial(() => e.startResidentDeck({ deckId: d.id, pcm, analysis }));
    if (!res.ok) { this.check(); throw new Stop('live', LIVE.failed(res.error)); }
    this.done = true; // the tap's messages are not this load's any more
    // With the promotion, before any other task: no snapshot shows the resident deck without its report.
    this.rep.result = `resident, ${(pcm.L.length / pcm.sampleRate).toFixed(3)} s`;
    d.setLoad({ report: this.report() });
    await this.release();
    if (notice) e.notify('warn', `Deck ${d.slot}: ${notice}`);
    return { ok: true, kind: 'resident', deckId: d.id, slot: d.slot };
  }

  /**
   * The tab stops mattering: its player paused and given back its rate (STOP_TAB, as a release: never left
   * muted), the held capture stopped, the agents' tap off and the agents let go, the tab forgotten (closing it no
   * longer ejects the deck).
   */
  async release() {
    const d = this.deck, e = this.engine;
    if (e.decks.get(d.id) !== d) return;
    await e.stopTab(d, { release: true });
    if (e.decks.get(d.id) !== d) return; // ejected meanwhile: the eject lets go of all of it
    if (d.stream) { for (const t of d.stream.getTracks()) t.stop(); d.stream = null; }
    for (const a of d.agents.values()) { try { a.port.postMessage({ t: 'tap', on: false, forget: true }); a.port.disconnect(); } catch (_) {} }
    d.agents.clear();
    d.tabId = null;
    e.hub({ type: HUB.DECKS_CHANGED, decks: e.tabDecks() });
  }

  /**
   * The load report (plain text, for "Copy load report"): the page, the result, every step with how it ended,
   * why and how long it took, what the tap saw and the first failure. Real sites cannot be reached from where
   * this is built, so this is how a failure on one gets back.
   */
  report() {
    const r = this.rep, D = this.duration(), site = siteOf(this.host), p = r.placed;
    const reqs = this.reqs(), media = uniq(reqs.filter((x) => x.media).map((x) => x.url)).length, lists = uniq(reqs.filter((x) => !x.media).map((x) => x.url)).length;
    const gaps = p && D != null ? this.d.gapsFor(p, this.target()) : [];
    const failed = r.steps.find((s) => s.outcome === 'failed' || s.outcome === 'stopped');
    const captured = [...this.frames.values()].reduce((n, f) => n + f.bytes, 0);
    const lines = [
      'JD Samps load report',
      `Page: ${this.host || 'unknown'} (${site ? `site table: ${site} starts at ${SITES[site]}` : 'generic site: file, refetch, drive, then live'})`,
      `Result: ${r.result}`,
      `Track length: ${D != null ? `${D.toFixed(3)} s (the page's player)` : 'not known'}`,
      ...(r.limit ? [`Limit: ${r.limit}`] : []),
      'Steps:',
      ...r.steps.map((s) => `  ${s.name}${s.how ? ` (${s.how})` : ''}: ${s.outcome} in ${secs(s.ms)}${s.why ? ` — ${s.why}` : ''}`),
      ...r.notes.map((n) => `  note: ${n}`),
      `Media types: ${r.mimes.size ? [...r.mimes].join(', ') : 'none seen'}`,
      `Runs: ${p ? p.runs.length : 0}, segments: ${p ? p.runs.reduce((n, x) => n + x.segs.length, 0) : 0}, gaps: ${gaps.length ? gaps.map(span).join(', ') : 'none'}`,
      `Requests seen: ${media} media, ${lists} playlist${lists === 1 ? '' : 's'}`,
      `Bytes: ${kb(captured)} captured from the player, ${kb(r.refetched)} fetched again`,
      `First failure: ${failed ? `${failed.name}: ${failed.why}` : r.result.startsWith('live: ') ? r.result.slice(6) : 'none'}`,
      `Total: ${secs(now() - r.t0)}`,
    ];
    return lines.join('\n');
  }

  /** Every frame's player let go (a drive always ends with stop) and its tap off, its blob: URLs revoked. */
  quiet() {
    for (const f of this.frames.values()) {
      if (f.left) continue;
      this.send(f, { t: 'drive', mode: 'stop' });
      this.send(f, { t: 'tap', on: false, forget: true });
    }
  }

  async fail(err) {
    const d = this.deck, e = this.engine;
    const cancelled = (err instanceof Stop && err.kind === 'cancel') || this.signal.aborted || e.decks.get(d.id) !== d;
    this.quiet();
    this.done = true;
    if (cancelled) { this.rep.result = 'cancelled'; return { ok: false, error: 'Loading was cancelled.' }; }
    const reason = err instanceof Stop ? err.message : LIVE.failed((err && err.message) || String(err));
    this.rep.result = `live: ${reason}`;
    d.setLoad({ report: this.report() });
    const own = e.loads.get(d.id);
    if (own && own.loader === this) e.loads.delete(d.id); // failLoadingToLive aborts the load it finds
    // A tab whose audio has gone too (closed, or its capture ended) would make a silent live deck: the deck goes.
    if (!d.stream || d.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
      const error = `Deck ${d.slot}: the tab's audio went away while the track was loading.`;
      e.event('error', error, d.id);
      e.eject(d.id);
      return { ok: false, error };
    }
    const r = await e.failLoadingToLive(d.id, reason);
    if (!r.ok) {
      if (e.decks.get(d.id) === d) e.eject(d.id);
      return r;
    }
    return { ok: true, kind: 'live', deckId: d.id, slot: d.slot };
  }
}

// ---------------------------------------------------------------- recording a whole track (§4.4)
// Opt-in, never automatic: for a page whose bytes cannot be had, the live deck's own capture records the tab's
// sound while its player runs the track at 2× from the start (pitch unlocked), and the recording is slowed back
// by 2. Whatever lay above a quarter of the media's rate (12 kHz at 48 kHz) is gone, and the deck says so.
const REC_RATE = 2;
const AUDIBLE = 0.003; // about -50 dBFS, as a deck's first audible sample
const HOLD_MS = 700;   // the player held silent at the start: longer than a recorder batch and the capture's delay

/** The first audible frame in [from, to) of a recording, or -1. */
export function findStart(L, R, from, to) {
  for (let i = Math.max(0, from); i < to; i++) if (Math.abs(L[i]) > AUDIBLE || Math.abs(R[i]) > AUDIBLE) return i;
  return -1;
}

// Under load the tab capture now and then loses or repeats one of its 10 ms buffers (20 ms of the track at 2×),
// silently: the page's player and the engine's clock never see it, but every beat after it is that much early or
// late, and the beat grid fitted to the whole recording comes out a few tenths of a percent off. A skip is a step:
// one beat-to-beat interval off by SKIP_MIN or more between intervals that are steady to SKIP_STEADY.
const SKIP_MIN = 0.006, SKIP_STEADY = 0.003; // s

/**
 * A recording's skips mended, so every beat is in its place: in the quiet between the two beats around each
 * step, audio the capture put in (its silence, when that is there) is cut, and audio it lost is given back as
 * silence. T: the beat period (s). -> {pcm, steps: [{at: s, ms}]}; pcm is the same object when nothing was mended.
 */
export function mendSteps(pcm, T) {
  const { L, R, sampleRate: sr } = pcm, hop = Math.max(1, Math.round(0.002 * sr)), n = Math.floor(L.length / hop);
  const amp = (i) => Math.max(Math.abs(L[i]), Math.abs(R[i]));
  let max = 0;
  const env = new Float32Array(n);
  for (let k = 0; k < n; k++) { let m = 0; for (let i = k * hop; i < (k + 1) * hop; i++) m = Math.max(m, amp(i)); env[k] = m; max = Math.max(max, m); }
  // Beats: the first sample through 35 % of the loudest after 20 ms under it, at least 0.6 T after the last.
  const thr = 0.35 * max, on = [], q = Math.round(0.02 * sr / hop);
  if (!(max > 0) || !(T > 0)) return { pcm, steps: [] };
  for (let k = 0, under = q; k < n; k++) { // the track's start counts as quiet before it
    if (env[k] < thr) { under++; continue; }
    const after = under >= q;
    under = 0;
    if (!after) continue;
    let i = Math.max(0, k - 1) * hop;
    while (amp(i) < thr) i++;
    if (!on.length || i - on[on.length - 1] >= 0.6 * T * sr) on.push(i);
  }
  if (on.length < 8) return { pcm, steps: [] };
  const gaps = on.slice(1).map((x, i) => x - on[i]), beats = gaps.map((g) => Math.max(1, Math.round(g / (T * sr))));
  const per = gaps.map((g, i) => g / beats[i]).sort((a, b) => a - b), P = per[per.length >> 1]; // the period, by the median
  const d = gaps.map((g, i) => g - beats[i] * P), steady = (i) => i < 0 || i >= d.length || Math.abs(d[i]) <= SKIP_STEADY * sr;
  const steps = [];
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) < SKIP_MIN * sr || Math.abs(d[i]) > 0.45 * P || !steady(i - 1) || !steady(i + 1)) continue;
    steps.push({ a: on[i] + hop, b: on[i + 1] - hop, D: Math.round(d[i]) });
  }
  if (!steps.length) return { pcm, steps: [] };
  const edits = []; // [at, frames cut (> 0) or silence put in (< 0)], in order
  for (const step of steps) {
    const { a, b, D } = step;
    let at = -1, len = D;
    if (D > 0) {
      // The capture's own silence: a run of zeros as long as the step, or one longer (silence it fell into).
      let best = null;
      for (let i = a; i < b; i++) {
        if (L[i] !== 0 || R[i] !== 0) continue;
        let j = i; while (j < b && L[j] === 0 && R[j] === 0) j++;
        const run = j - i;
        if (run >= D - hop / 2 && (!best || Math.abs(run - D) < Math.abs(best.run - D))) best = { i, run };
        i = j;
      }
      if (best && Math.abs(best.run - D) <= hop / 2) { at = best.i; len = best.run; } else if (best) at = best.i + ((best.run - D) >> 1);
    }
    if (at < 0) {
      // The quietest stretch between the two beats: as long as the cut, or 10 ms where silence goes in.
      const w = D > 0 ? D : Math.min(-D, Math.round(0.01 * sr)), sum = new Float64Array(Math.max(0, b - a) + 1);
      for (let i = a; i < b; i++) sum[i - a + 1] = sum[i - a] + amp(i);
      let low = Infinity;
      for (let i = a; i + w <= b; i++) if (sum[i + w - a] - sum[i - a] < low) { low = sum[i + w - a] - sum[i - a]; at = i; }
      if (at < 0) continue;
    }
    edits.push([at, len, step]);
  }
  if (!edits.length) return { pcm, steps: [] };
  const size = edits.reduce((s, [, len]) => s - len, L.length), oL = new Float32Array(size), oR = new Float32Array(size);
  let src = 0, dst = 0;
  for (const [at, len] of edits) {
    oL.set(L.subarray(src, at), dst); oR.set(R.subarray(src, at), dst); dst += at - src;
    if (len > 0) src = at + len; else { dst -= len; src = at; } // a cut skips audio; a loss gets silence
  }
  oL.set(L.subarray(src), dst); oR.set(R.subarray(src), dst);
  return { pcm: { L: oL, R: oR, sampleRate: sr }, steps: edits.map(([, , { b, D }]) => ({ at: b / sr, ms: (D / sr) * 1000 })) };
}

export class Recording extends Job {
  /** live: the live tab deck whose page is recorded; deck: the loading deck the recording becomes. */
  constructor({ engine, live, deck, signal }) {
    super(engine, deck, signal);
    this.live = live;
    this.frame = Recording.agentOf(live); // [frameId, agent]
    this.prog = null;
    this.gone = false;
  }

  /** The live deck's frame agent whose player the user hears, or null: a page with none cannot be sped up. */
  static agentOf(live) {
    let best = null;
    for (const [id, a] of live.agents) {
      const s = a.status;
      if (!s || !s.hasMedia || s.muted || !(s.volume > 0)) continue;
      if (!best || s.audible > best[1].status.audible) best = [id, a];
    }
    return best;
  }

  // The live deck's agents, while it is recorded.
  onAttach() {}
  onDetach(frameId, a) { if (this.frame && a === this.frame[1]) { this.gone = true; this.poke(); } }
  onTap(frameId, m) {
    if (this.done || !this.frame || frameId !== this.frame[0]) return;
    if (m.t === 'tap-progress') this.prog = m;
    this.poke();
  }

  send(m) { try { this.frame[1].port.postMessage(m); } catch (_) {} }
  check() {
    if (this.signal.aborted || this.engine.decks.get(this.deck.id) !== this.deck) throw new Stop('cancel', 'Recording was cancelled.');
    if (this.gone || this.engine.decks.get(this.live.id) !== this.live) throw new Stop('live', 'the page went away');
  }
  refused() { const d = this.prog && this.prog.drive; return !!d && d.mode === 'accelerate' && d.state === 'refused'; }

  /** -> {ok:true, deckId, slot} once the recording is a resident deck (and the live deck let go), or {ok:false, error}. */
  async run() {
    const e = this.engine, live = this.live, d = this.deck, sr = e.ctx.sampleRate, t0 = now(), assist = live.assist.offUntil;
    let node = null;
    try {
      this.say(0, 'getting the page ready');
      live.assist.offUntil = Infinity; // no player assist on a page being recorded
      this.send({ t: 'tap', on: true }); // drives go through the tap
      await this.until(() => !!(this.prog && this.prog.duration), 5000);
      this.check();
      const D = this.prog && this.prog.duration;
      if (!D) throw new Stop('live', "the page's player does not say how long the track is");
      const T = Math.min(D, (e.params['resident.limitMin'] || 15) * 60), need = Math.round((T / REC_RATE) * sr), cap = need + Math.round(20 * sr);
      const L = new Float32Array(cap), R = new Float32Array(cap);
      let frames = 0;
      node = new AudioWorkletNode(e.ctx, 'jds-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' });
      node.port.onmessage = (ev) => {
        const m = ev.data;
        if (!m || m.t !== 'data') return;
        const b = m.buf, n = Math.min(m.frames, cap - frames);
        for (let i = 0; i < n; i++) { L[frames + i] = b[2 * i] / 32768; R[frames + i] = b[2 * i + 1] / 32768; }
        frames += n;
      };
      live.source.connect(node);
      node.connect(e.silentSink);
      node.port.postMessage({ t: 'start' });
      // Held silent at the start first, so the first sound recorded after `mark` is the track's own.
      this.send({ t: 'drive', mode: 'accelerate', rate: REC_RATE, from: 0, hold: true, audible: true });
      await this.sleep(HOLD_MS);
      this.check();
      const mark = frames, end = now() + (T / REC_RATE + 10) * 1000;
      this.send({ t: 'drive', mode: 'accelerate', rate: REC_RATE, audible: true });
      this.say(0.02, `recording from the page at ${REC_RATE}×`);
      let start = -1;
      for (;;) {
        await this.sleep(250);
        this.check();
        if (this.refused()) throw new Stop('live', 'the page will not let its player run faster');
        if (start < 0) start = findStart(L, R, mark, frames);
        if (start >= 0) { this.say(0.02 + 0.78 * Math.min(1, (frames - start) / need)); if (frames - start >= need) break; }
        if (now() > end) throw new Stop('live', start < 0 ? 'the page played nothing' : 'the page stopped before the end of the track');
      }
      this.send({ t: 'drive', mode: 'stop' });
      this.send({ t: 'tap', on: false, forget: true });
      this.say(0.8, 'slowing the recording back');
      const take = { L: L.slice(start, start + need), R: R.slice(start, start + need), sampleRate: sr / REC_RATE };
      let pcm = await resample(take, sr);
      this.check();
      this.say(0.85, SAY.beat);
      const analyse = async () => {
        try { return await e.analyse(pcm, this.signal); } catch (err) {
          this.check();
          e.event('warn', `Deck ${d.slot}: no beat grid from the whole track (${err.message}). TAP the beat.`, d.id);
          return null;
        }
      };
      let analysis = await analyse(), mended = [];
      this.check();
      // The capture's skips, mended on its beat (a beat apart everywhere else), and the beat found again.
      if (analysis && analysis.bpm > 0) {
        const m = mendSteps({ L: take.L, R: take.R, sampleRate: sr }, 60 / analysis.bpm / REC_RATE);
        if (m.steps.length) {
          mended = m.steps;
          pcm = await resample({ ...m.pcm, sampleRate: sr / REC_RATE }, sr);
          this.check();
          analysis = await analyse();
          this.check();
        }
      }
      const res = await e.serial(() => e.startResidentDeck({ deckId: d.id, pcm, analysis }));
      if (!res.ok) { this.check(); throw new Stop('live', res.error); }
      this.end();
      const host = hostOf(live.meta && live.meta.url) || 'unknown', got = pcm.L.length / pcm.sampleRate;
      d.setLoad({ report: [
        'JD Samps load report', `Page: ${host}`, `Result: resident, ${got.toFixed(3)} s, recorded from the page at ${REC_RATE}× (reduced highs)`,
        `Track length: ${D.toFixed(3)} s (the page's player)`, ...(T < D ? [`Limit: the deck holds the first ${minutes(T / 60)}`] : []),
        `Recorded: ${(need / sr).toFixed(3)} s of the tab's sound from deck ${live.slot}'s capture, slowed back by ${REC_RATE}`,
        ...(mended.length ? [`Mended: ${mended.length} skip${mended.length === 1 ? '' : 's'} in the capture (the computer was busy): ${mended.map((x) =>
          `${Math.round(Math.abs(x.ms) * REC_RATE)} ms ${x.ms > 0 ? 'put in' : 'lost'} at ${(x.at * REC_RATE).toFixed(1)} s`).join(', ')}`] : []),
        `Total: ${secs(now() - t0)}`,
      ].join('\n') });
      e.event('info', `Deck ${d.slot}: the whole track was recorded from the page (reduced highs). Deck ${live.slot} is let go.`, d.id);
      e.eject(live.id); // the page paused, its capture released
      return { ok: true, deckId: d.id, slot: d.slot };
    } catch (err) {
      const cancelled = (err instanceof Stop && err.kind === 'cancel') || this.signal.aborted || e.decks.get(d.id) !== d;
      this.end();
      this.send({ t: 'drive', mode: 'stop' });
      this.send({ t: 'tap', on: false, forget: true });
      if (cancelled) return { ok: false, error: 'Recording was cancelled.' };
      e.event('error', `Deck ${d.slot}: recording the whole track failed: ${err.message}.`, d.id);
      e.eject(d.id);
      return { ok: false, error: err.message };
    } finally {
      this.end();
      if (node) {
        try { live.source.disconnect(node); } catch (_) {}
        try { node.port.postMessage({ t: 'dispose' }); node.disconnect(); node.port.close(); } catch (_) {}
      }
      if (live.assist.offUntil === Infinity) live.assist.offUntil = assist;
    }
  }
}
