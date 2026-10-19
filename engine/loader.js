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
import { decodeTo, limitPcm, fetchArrayBuffer, resample, FetchRefused } from './decode.js';
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
  idle: 2000,        // a player that holds nothing this long after the tap is on was not started (play not pressed)
  start: 30000,      // the most to wait for the DJ to start such a player on the tab
  file: 65000,       // the page's track link (the agent gives it 60 s)
  fetchEach: 15000,  // per eight links fetched by the page (the agent gives each 15 s)
  stall: 5000,       // a seek-hop that brings no new audio this long is given up for accelerate
  drive: 30000,      // a drive's budget: this, plus drivePerSec for each second of the track
  drivePerSec: 250,
  check: 400,        // between gap checks while driving (each one places every piece)
  away: 1500,        // after the page went away: the most to wait for word of what became of the tab (closed, another page)
  report: 1000,      // between refreshes of the load report while nothing else moves the deck's progress
});

/** Plain words for the deck's loading state. */
const SAY = {
  wait: 'waiting for the page', look: "looking at the page's player", start: 'start the track on the tab', file: "reading the page's track link",
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
  unstarted: "the page's player had not started, so it plays live from the tab. For the whole track, press play on the tab, eject this deck and load the tab again.",
  gone: 'the page changed while the track was loading, so it plays live from the tab.',
  big: 'the track is too large to hold, so it plays live from the tab.',
  failed: (why) => `the whole track could not be read from this page (${why}), so it plays live from the tab.`,
};
/** Why a player asked to flush was not (tap-progress drive.unflushed), for the load report. */
const UNFLUSHED = {
  ended: 'it had loaded the whole track and ended its stream, which a flush would reopen',
  video: 'it holds pictures only',
  none: 'its media source could not be flushed',
  start: 'it had only just started, with nothing behind its place to try a flush on',
  sticky: 'it would not fetch again what was taken from behind its place',
};
const DECISIVE = ['drm', 'worker', 'preview', 'live'];
/** A decisive error from a player in the tab that is not the track's (an advert, a jingle), as its report note says it. */
const OTHERS = { drm: 'its audio is protected', worker: 'it plays from a worker', preview: 'it is a 30-second preview', live: 'it is a live stream with no end' };
const UNREADABLE = ['drm', 'worker']; // decisive, and the page's bytes cannot be had: only its sound can be recorded
const NO_LENGTH = "the page's player has not said how long the track is";
const TAB_CAP = 600 * 2 ** 20;       // bytes from one tab: each frame's tap holds at most this, and so does the whole tab
const NO_STAMPS = /^audio\/(mpeg|mp3|aac|x-aac)\b/i; // placed in append order only: never seek-hopped
const DRIVE_RATE = 16;               // accelerate: the most a media element takes; capturing bytes is lossless at any rate
const FETCHED = 1e6;                 // placement keys of fetched batches, clear of the tap's SourceBuffers (frame * 1000 + sb)

class Stop extends Error {
  /**
   * kind: 'cancel' (the deck was ejected or the load cancelled), 'live' (play the tab live, saying why) or 'away' (the
   * page went away before the track was in: what follows depends on what became of the tab). noBytes (live): the page's
   * bytes cannot be had, so only its sound can be recorded (the setting "Record whole track at 2× when bytes are unavailable").
   */
  constructor(kind, message, noBytes = false) { super(message); this.kind = kind; this.noBytes = noBytes; }
}
const now = () => performance.now();
/** Real time. A load job's tests give it a virtual clock instead (deps.clock): every wait and time read goes through it. */
const REAL = Object.freeze({ now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) });
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const span = ([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} s`;
const kb = (n) => (n < 1e6 ? `${Math.round(n / 1e3)} kB` : `${(n / 1e6).toFixed(1)} MB`);
const minutes = (m) => `${+m.toFixed(1)} minute${m === 1 ? '' : 's'}`;
const short = (u) => { try { const x = new URL(u); return `${x.host}${x.pathname.length > 40 ? `…${x.pathname.slice(-40)}` : x.pathname}`; } catch (_) { return String(u).slice(0, 60); } };
const uniq = (xs) => [...new Set(xs)];
const pageOf = (m = {}) => ({ title: m.title, url: m.url, favIconUrl: m.favIconUrl });

/**
 * An HLS playlist: {variants: [{bw, url}]} for a master playlist, {init, segs: [{url, t0, t1}], ts?} for a media
 * playlist, or null (not HLS, encrypted segments, or byte ranges of one file, none of which are read here). ts:
 * its pieces are MPEG-TS (no init, and .ts pieces or an mp2t hint), which decodeAudioData cannot read (§4.2).
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
  if (!segs.length) return null;
  const ts = !init && (segs.some((x) => /\.ts$/i.test(new URL(x.url).pathname)) || /mp2t/i.test(s));
  return ts ? { init, segs, ts } : { init, segs };
}

/**
 * A whole file's MP3 or ADTS frames, walked (cut: the first frame boundary at or past `until` s), or null for any
 * other format: those have a layout of their own and cannot be cut short at a frame.
 */
export function framesOf(bytes, until) {
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
  constructor(engine, deck, signal, clock = REAL) {
    this.clock = clock;
    this.engine = engine;
    this.deck = deck;
    this.signal = signal;
    this.waiters = new Set();
    this.done = false;
    this.progress = 0;
    signal.addEventListener('abort', () => this.poke(), { once: true });
  }

  now() { return this.clock.now(); }

  /**
   * Resolves true once cond() holds, or something every wait gives way to (urgent(): the caller's check() says what),
   * checked whenever the page says something; false after ms; rejects when cancelled.
   */
  until(cond, ms) {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) { reject(new Stop('cancel', 'Loading was cancelled.')); return; }
      if (cond() || this.urgent()) { resolve(true); return; }
      const w = { cond, resolve, reject, timer: 0 };
      w.timer = this.clock.setTimeout(() => { this.waiters.delete(w); resolve(false); }, Math.max(0, ms));
      this.waiters.add(w);
    });
  }
  sleep(ms) { return this.until(() => false, ms); }
  poke() {
    for (const w of [...this.waiters]) {
      let go = false;
      if (this.signal.aborted) { this.clock.clearTimeout(w.timer); this.waiters.delete(w); w.reject(new Stop('cancel', 'Loading was cancelled.')); continue; }
      try { go = w.cond() || this.urgent(); } catch (_) {}
      if (go) { this.clock.clearTimeout(w.timer); this.waiters.delete(w); w.resolve(true); }
    }
  }
  urgent() { return false; }
  /** No more waiting: every timer cleared. */
  end() {
    this.done = true;
    for (const w of this.waiters) this.clock.clearTimeout(w.timer);
    this.waiters.clear();
  }

  /** Progress only goes up; strategy in plain words (undefined: unchanged). */
  say(p, strategy) {
    if (this.done) return;
    this.progress = Math.max(this.progress, Math.min(0.99, p));
    this.deck.setLoad({ ...(strategy === undefined ? { progress: this.progress } : { progress: this.progress, strategy }), ...this.also(strategy) });
  }
  /** What else the deck's load shows with its progress (a Loader: its report as it stands). */
  also() { return {}; }
  /** A rung's own 0..1 mapped onto what is left of the bar before decoding. */
  band(hi = 0.8) { const lo = Math.min(this.progress, hi); return (x) => lo + Math.max(0, Math.min(1, x)) * (hi - lo); }
}

export class Loader extends Job {
  /**
   * engine: the Engine (or a stand-in with the same methods); deck: the loading deck, holding the tab's capture;
   * signal: aborted when the deck is ejected or the load cancelled. deps: fetchBytes, decodeFile, decodePlaced,
   * placeParts, gapsFor, times, clock ({now, setTimeout, clearTimeout}) and cap (the tab's byte budget), for tests.
   */
  constructor({ engine, deck, tabId, signal, deps = {} }) {
    const { times, clock, cap = TAB_CAP, ...d } = deps;
    super(engine, deck, signal, clock);
    this.cap = cap;
    this.tabId = tabId;
    this.d = { fetchBytes: fetchArrayBuffer, decodeFile: decodeTo, decodePlaced, placeParts, gapsFor, ...d };
    this.t = { ...TIMES, ...times };
    this.frames = new Map();   // frameId -> what its agent said, and what it handed over
    this.inflight = new Set(); // blob: URLs being read
    this.fetched = [];         // pieces fetched again, keyed for placement
    this.tried = new Set();    // links already fetched again
    this.unfetched = new Map(); // link -> why the engine's own fetch of it failed
    this.batch = 0;
    this.tapping = false;
    this.gone = null;          // the page went away mid-load
    this.inPlace = false;      // it moved on with the track's frame still there (a single-page site's next track, until that frame goes)
    this.pinned = null;        // the frame whose player is the track, once the page has been looked at
    this.looked = false;       // past the first look: a decisive tap error ends the load wherever it is
    this.have = false;         // every byte of the track is in hand: the page going away no longer matters
    this.closed = false;       // the hub said the tab was closed while every byte was in hand (tabClosed)
    this.url0 = (deck.meta && deck.meta.url) || '';
    this.page = pageOf(deck.meta); // the name, address and icon of the page the track is on, kept for the resident deck
    this.big = false;
    this.bytes = 0;            // read from the tab, all frames
    this.host = hostOf(deck.meta && deck.meta.url);
    this.rep = { steps: [], mimes: new Set(), refetched: 0, placed: null, limit: null, result: null, notes: [], t0: this.now() };
    this.doing = '';           // what the load is doing now, in plain words (its report says so until it ends)
    this.changes = [];         // the track's length changing while it decoded, said as the report says it
    this.reportedAt = -Infinity;
  }

  /**
   * The load report as it stands goes with the progress (§11: it can be copied while the deck loads): at once when what
   * the load does changes, else at most every 250 ms.
   */
  also(strategy) {
    if (strategy !== undefined) this.doing = strategy;
    if (strategy === undefined && this.now() - this.reportedAt < 250) return {};
    this.reportedAt = this.now();
    return { report: this.report() };
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
      if (this.bytes > this.cap) this.big = true;
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
  /** The track's frame, or once the page has been looked at, its pinned frame even after it left (what it gave stays good). */
  held() { return this.pinned || this.track(); }
  /**
   * The track's player holds nothing yet: no length, no source, nothing appended or asked for. A page whose play button
   * was not pressed (a track page that does not autoplay): the hub's start finds no source to play.
   */
  idle() {
    const f = this.track(), p = f && f.prog;
    return !!p && p.duration == null && !p.src && !p.mimes.length && !f.own && !f.parts.length && !f.reqs.some((r) => r.media);
  }
  /** How long the track's player says the track is. */
  duration() { const f = this.held(); return f && f.prog ? f.prog.duration : null; }
  limitSec() { return (this.engine.params['resident.limitMin'] || 15) * 60; }
  /**
   * What must be covered: the track, or its first part when it is longer than the resident limit (a second
   * past the limit, so the cut to it lands inside decoded audio, clear of the codec delay at the end).
   */
  target() { const D = this.duration(), L = this.limitSec(); return D == null ? null : D <= L ? D : Math.min(D, L + 1); }
  /** A decisive tap error from the track's own player: another player's (an advert beside it) never decides the load. */
  decisive() {
    const f = this.track();
    for (const e of f ? f.errors : []) if (DECISIVE.includes(e.reason)) return e.reason;
    return null;
  }
  /** The other players' decisive errors, as notes for the report. */
  othersSaid() {
    const t = this.held(), out = [];
    for (const f of this.frames.values()) {
      if (f === t) continue;
      for (const reason of uniq(f.errors.filter((e) => DECISIVE.includes(e.reason)).map((e) => e.reason))) {
        const e = f.errors.find((x) => x.reason === reason);
        out.push(`another player in the tab (frame ${f.n}) said ${OTHERS[reason]} (${e.detail}): not the track's, so the load went on`);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- waiting
  /**
   * The tab shows another page than the one this load began on (the hub's META; a hash is the same page): a navigation,
   * or a single-page site's move to its next track, which leaves the page and its agents in place.
   */
  moved() { const page = (u) => String(u || '').split('#')[0]; return page(this.deck.meta && this.deck.meta.url) !== page(this.url0); }
  /** Any word from the page or the hub: a newer name of the track's own page is kept, never one of a page the tab went on to. */
  poke() {
    if (this.page && !this.moved()) this.page = pageOf(this.deck.meta);
    super.poke();
  }
  /** Waits give way to a decisive tap error once the page has been looked at, and to the page going away or moving on. */
  urgent() { return (this.looked && !!this.decisive()) || ((!!this.gone || this.moved()) && !this.have); }
  /**
   * After every await: stop if the load was cancelled or the deck is gone; go live, with its one message, on a decisive
   * tap error (protected, in a worker, a preview, a stream) whenever the page reports it; stop if the page went away or
   * moved on, unless every byte of the track is in hand already.
   */
  check() {
    if (this.signal.aborted || this.engine.decks.get(this.deck.id) !== this.deck) throw new Stop('cancel', 'Loading was cancelled.');
    const why = this.looked && this.decisive();
    if (why) throw new Stop('live', LIVE[why], UNREADABLE.includes(why));
    if (!this.gone && !this.have && this.moved()) { this.gone = 'the page moved on'; this.inPlace = true; }
    if (this.gone && !this.have) throw new Stop('away', this.gone);
    if (this.big) throw new Stop('live', LIVE.big);
  }
  /**
   * The hub says the tab was closed: true when the load goes on without it (every byte of the track is in hand), so
   * the deck stays; false when the deck must go.
   */
  tabClosed() {
    if (this.done || !this.have) return false;
    this.closed = true;
    this.gone = this.gone || 'the tab was closed';
    this.poke();
    return true;
  }
  /** Work on a whole track's bytes, all in hand: meanwhile (and after, when it gives the track) the page going away does not matter. */
  async holding(fn) {
    this.have = true;
    let r = null;
    try { r = await fn(); } finally { if (!(r && r.done)) this.have = false; }
    return r;
  }
  async drain() {
    while (this.inflight.size) await Promise.all([...this.inflight]);
    this.check();
  }

  // ---------------------------------------------------------------- the job
  /** -> {ok:true, kind:'resident'|'live', deckId, slot} or {ok:false, error}. Never rejects. */
  async run() {
    let out;
    // While a step waits long (a look, a fetch, a page's answer), its report still keeps up with how long it has taken.
    let tick = 0;
    const report = () => { if (!this.done) { this.deck.setLoad({ report: this.report() }); tick = this.clock.setTimeout(report, this.t.report); } };
    tick = this.clock.setTimeout(report, this.t.report);
    try {
      this.say(0, SAY.wait);
      await this.connect();
      await this.look();
      let got;
      try { got = await this.climb(); } catch (err) {
        if (!(err instanceof Stop && err.kind === 'away') || !(got = await this.inHand())) throw err;
      }
      out = await this.finish(got);
    } catch (err) {
      out = await this.fail(err);
    } finally {
      this.clock.clearTimeout(tick);
      this.end();
    }
    return out;
  }

  /** The tab's frames' agents: asked to connect again (they did for the deck's start), then tapped. */
  async connect() {
    const t0 = this.now();
    for (const [id, a] of this.deck.agents) if (!this.frames.has(id)) this.onAttach(id, a); // connected before this load began
    const r = await this.engine.hub({ type: HUB.AGENT_CONNECT, tabId: this.tabId });
    this.check();
    if (!this.attached().length) await this.until(() => this.attached().length > 0, this.t.grace);
    this.check();
    const n = this.attached().length;
    this.rep.steps.push({ name: 'connect', outcome: n ? 'ok' : 'none', why: `${n} frame${n === 1 ? '' : 's'} with a player`, ms: this.now() - t0 });
    if (!n) throw new Stop('live', r && r.ok === false ? LIVE.unreachable : LIVE.webaudio, true);
    this.tapping = true;
    for (const f of this.attached()) this.tapOn(f);
  }

  /** What the tap first says: the player's length, and anything that sends the deck live at once. */
  async look() {
    const t0 = this.now(), known = () => !!this.decisive() || this.duration() != null;
    this.say(0.02, SAY.look);
    await this.until(known, Math.min(this.t.idle, this.t.duration));
    this.check();
    let wait = this.t.duration - this.t.idle;
    if (!known() && this.idle()) {
      // Not started: the DJ is asked to start it on the tab, and the load goes on once it plays. It has a player, so it
      // is never said to make its sound without one.
      this.say(this.progress, SAY.start);
      this.engine.event('info', `Deck ${this.deck.slot}: start the track on the tab. The deck loads it once it plays.`, this.deck.id);
      await this.until(() => known() || !this.idle(), this.t.start);
      this.check();
      if (!known() && this.idle()) {
        this.rep.steps.push({ name: 'look', outcome: 'not started', why: "the page's player had nothing to play", ms: this.now() - t0 });
        throw new Stop('live', LIVE.unstarted);
      }
      this.rep.notes.push(`the track was started on the tab ${secs(this.now() - t0)} into the load`);
      this.say(this.progress, SAY.look);
      wait = this.t.duration;
    }
    await this.until(known, wait);
    this.check();
    await this.until(() => !!this.decisive(), this.t.settle); // errors and links still on their way
    this.check();
    this.pinned = this.track();
    const why = this.decisive(), D = this.duration();
    this.rep.steps.push({ name: 'look', outcome: why || 'ok', why: D != null ? `the player says ${D.toFixed(3)} s` : "the player's length is not known", ms: this.now() - t0 });
    if (why) throw new Stop('live', LIVE[why], UNREADABLE.includes(why));
    this.looked = true;
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
    if (order.includes('refetch') && this.mseFrame() && !(this.plan && this.plan.ts) && this.wanted(this.plan).urls.length) {
      const got = await this.step('refetch', (e) => this.refetch(e));
      if (got) return got;
    }
    const tried = this.rep.steps.filter((s) => RUNGS.includes(s.name) && s.outcome !== 'skipped');
    if (!tried.length) {
      const length = this.rep.steps.some((s) => s.why === NO_LENGTH);
      throw new Stop('live', length ? LIVE.length : LIVE.webaudio, !length);
    }
    throw new Stop('live', LIVE.failed(tried.find((s) => s.outcome === 'failed').why), true);
  }

  /** Run one rung, noting how it went: its result is {done: {pcm, notice}} or {outcome, why}. */
  async step(name, fn) {
    const t0 = this.now(), e = { name, how: '', outcome: '', why: '', ms: 0, at: t0 }, k = this.changes.length;
    this.rep.steps.push(e);
    try {
      const r = await fn(e);
      e.outcome = r.done ? 'ok' : r.outcome || 'failed';
      e.why = r.why || e.why;
      // The length changed while it decoded: that is what happened first, whatever the rung found after it.
      const change = this.changes.length > k && this.changes.at(-1);
      if (change && !r.done && !e.why.startsWith(change)) e.why = e.why ? `${change}; ${e.why}` : change;
      return r.done || null;
    } catch (err) {
      e.outcome = err instanceof Stop && err.kind === 'cancel' ? 'cancelled' : 'stopped';
      e.why = err.message;
      throw err;
    } finally { e.ms = this.now() - t0; }
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
   * format is decoded whole, so only up to twice the limit. Its bytes are all in: the page may go meanwhile.
   */
  wholeFile(bytes, expect, what) { return this.holding(() => this.decodeWhole(bytes, expect, what)); }
  async decodeWhole(bytes, expect, what) {
    const L = this.limitSec(), w = framesOf(bytes, L + 1), own = w ? w.samples / w.sampleRate : null;
    const off = (got, want) => Math.abs(got - want) > Math.max(0.5, 0.01 * want);
    if (own && expect && off(own, expect)) return { outcome: 'failed', why: `${what} holds ${own.toFixed(1)} s, but the page's player says ${expect.toFixed(1)} s` };
    const cut = own > L + 0.5 && w.cut ? w.cut : null, part = cut && cut.samples / w.sampleRate;
    if (!own && expect && expect > 2 * L) return { outcome: 'failed', why: `${what} is ${minutes(expect / 60)} long, too long to decode whole` };
    this.say(this.progress, SAY.decode);
    const t0 = this.now();
    let pcm;
    try { pcm = await this.d.decodeFile(this.engine.ctx, cut ? bytes.slice(0, cut.end) : bytes); } catch (_) { this.check(); return { outcome: 'failed', why: `${what} is not audio this browser can play` }; }
    this.check();
    this.rep.steps.push({ name: 'decode', outcome: 'ok', why: cut ? `${what}, its first ${part.toFixed(1)} s` : what, ms: this.now() - t0 });
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

  /**
   * A progressive player's media file (an <audio src> the URL layer saw), from the page, else from here: the heard
   * player's own source first (the tap names it), then the media links the page asked for, in order.
   */
  async refetchFile(e) {
    e.how = SAY.media;
    const D = this.duration(), f = this.held(), src = f && f.prog && f.prog.src;
    const urls = uniq([...(src ? [src] : []), ...this.reqs().filter((r) => r.media && r.method === 'GET' && (!r.range || /^bytes=0-$/i.test(r.range))).map((r) => r.url)]);
    if (!urls.length) return { outcome: 'skipped', why: 'the page has asked for no media file' };
    if (D == null) return { outcome: 'skipped', why: NO_LENGTH };
    const why = [];
    for (const url of urls.slice(0, 3)) {
      this.say(this.progress, SAY.media);
      const [bytes] = await this.fetchUrls(this.frameOf(url), [url]);
      if (!bytes) { why.push(`${short(url)} could not be fetched${this.unfetched.has(url) ? ` (${this.unfetched.get(url)})` : ''}`); continue; }
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
    // A player of MPEG-TS transmuxes each piece before it appends it: fetched as they are, the pieces would not decode.
    if (this.plan && this.plan.ts) return { outcome: 'skipped', why: "the playlist's pieces are MPEG-TS, which cannot be decoded directly" };
    if (this.plan && !this.plan.init) return this.refetchPacked(this.plan);
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

  /**
   * Packed audio (a playlist with no init that is not MPEG-TS: MP3 or ADTS pieces) has no timestamps: its pieces place
   * only back to back, from 0. So every piece from the first is fetched, those the tap holds too (where its capture
   * starts in the track cannot be known), and once all are in they are placed alone: never beside the capture, and
   * never kept where a drive's placement would find them starting at 0 beside it.
   */
  async refetchPacked(plan) {
    const got = this.packed || (this.packed = new Map()); // link -> bytes
    const want = () => { const T = this.target(); return plan.segs.filter((s, i) => i === 0 || s.t0 < T - 1e-3); };
    const place = (segs) => this.d.placeParts(segs.map((s, seq) => ({ bytes: got.get(s.url), mime: '', kind: 'media', sb: FETCHED, seq })));
    const counts = (miss) => `${got.size} pieces fetched${miss.length ? `, ${miss.length} failed` : ''}`;
    for (let round = 0; round <= 3; round++) {
      const segs = want(), miss = segs.filter((s) => !got.has(s.url));
      if (!miss.length) {
        const placed = place(segs), gaps = this.d.gapsFor(placed, this.target());
        if (gaps.length) return { outcome: 'failed', why: `${counts(miss)}, still missing ${gaps.map(span).join(', ')}` };
        this.rep.placed = placed;
        const r = await this.decodeOr(placed);
        if (!r.again) return { why: counts(miss), ...r };
        continue;
      }
      if (round === 3) {
        const spans = miss.reduce((a, s) => { const l = a.at(-1); if (l && Math.abs(l[1] - s.t0) < 1e-3) l[1] = s.t1; else a.push([s.t0, s.t1]); return a; }, []);
        return { outcome: 'failed', why: `${counts(miss)}, still missing ${spans.map(span).join(', ')}` };
      }
      const urls = miss.map((s) => s.url), band = this.band();
      for (const u of urls) this.tried.add(u);
      this.say(this.progress, SAY.pieces);
      const bytes = await this.fetchUrls(plan.frame, urls, (n) => this.say(band(n / urls.length)));
      bytes.forEach((b, i) => { if (b) { got.set(urls[i], b); this.rep.refetched += b.byteLength; } });
    }
    return { outcome: 'failed', why: 'the track length kept changing while it loaded' };
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

  /**
   * Fetch links from the page (it holds the session signed links are bound to), and from here what it could not: within
   * what is left of the tab's byte budget, shared by the eight at a time (a link past it: the track is too large to hold).
   * The engine's fetch has its own stall deadline, and refuses a stream with no end.
   */
  async fetchUrls(f, urls, onCount) {
    const out = await this.pageFetch(f, urls, onCount);
    const miss = urls.map((_, i) => i).filter((i) => !out[i]), budget = { left: Math.max(0, this.cap - this.bytes) };
    let k = 0;
    const worker = async () => {
      while (k < miss.length && !this.signal.aborted) {
        const i = miss[k++];
        try {
          out[i] = await this.d.fetchBytes(urls[i], { signal: this.signal, budget });
          this.bytes += out[i].byteLength;
        } catch (err) {
          out[i] = null;
          this.unfetched.set(urls[i], err.message);
          if (err instanceof FetchRefused && err.kind === 'big') this.big = true;
        }
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
    // A gap at the start of what the tap holds is what the player buffered before the tap (named by the range it holds
    // there): a player never fetches what it holds again, so the first drive has it flush its buffer first.
    await this.complete();
    const startOf = () => { const g = this.gapsNow()[0]; return g && g[0] < 0.05 ? g : null; }, g0 = stampless ? null : startOf();
    const held = g0 && ((f.prog && f.prog.buffered) || []).find(([a, b]) => a <= g0[0] + 0.5 && b > g0[0]);
    const unfetched = g0 && `the player would not fetch the start again after a flush: ${span(held ? [g0[0], Math.min(g0[1], held[1])] : g0)} came before the deck could read it`;
    let mode = null, placed = null, out = null, pass = null, flushed = false, unflushed = false;
    const go = (m, from, flush) => {
      mode = m;
      this.send(f, m === 'seekhop' ? { t: 'drive', mode: m, ...(flush ? { flush: true } : {}) } : { t: 'drive', mode: m, rate: DRIVE_RATE, ...(from != null ? { from } : {}) });
      const how = m === 'seekhop' ? 'seek-hop' : `accelerate ${DRIVE_RATE}×${from != null ? ` from ${from.toFixed(1)} s` : ''}`;
      e.how = e.how ? `${e.how}, then ${how}` : how;
      this.say(this.progress, m === 'seekhop' ? SAY.hop : SAY.fast(DRIVE_RATE));
    };
    const band = this.band(), end = this.now() + this.t.drive + T * this.t.drivePerSec;
    let bytes = f.bytes, fresh = this.now(), checked = 0, stalled = 0;
    try {
      go(stampless ? 'accelerate' : 'seekhop', null, !!g0);
      // Said once, and looked for in every message from the page, so it is never missed.
      if (g0) this.until(() => { const d = f.prog && f.prog.drive; return !!d && d.state === 'flushed'; }, end - this.now()).then((yes) => {
        if (yes) { flushed = true; e.how = e.how.replace('seek-hop', 'seek-hop after a flush'); }
      }, () => {});
      for (;;) {
        const seen = f.prog;
        await this.until(() => f.prog !== seen || f.left, this.t.check);
        this.check();
        if (f.bytes !== bytes) { bytes = f.bytes; fresh = this.now(); }
        const d = f.prog && f.prog.drive, st = d && d.mode === mode && !(pass && f.prog === pass.prog) ? d.state : 'running';
        stalled = st === 'stalled' ? stalled || this.now() : 0;
        // It did not fetch again what the flush took from behind its place (so it was left the rest): the start is not to be had.
        if (g0 && d && d.unflushed === 'sticky') { out = { outcome: 'failed', why: unfetched }; break; }
        if (d && d.unflushed && !unflushed) { unflushed = d.unflushed; this.rep.notes.push(`the player was not flushed: ${UNFLUSHED[d.unflushed]}`); }
        if (st === 'done' || this.now() - checked >= this.t.check) {
          checked = this.now();
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
          // It ended its own stream before the deck could read it (left alone: see the agent's flush): a reload starts it afresh.
          const why = `the player buffered the whole track, but ${gaps.map(span).join(', ')} came before the deck could read it${flushed && gaps[0][0] < 0.05 ? ', and it would not fetch the start again after a flush' : ''}${unflushed === 'ended' && gaps[0][0] < 0.05 ? ': reload the tab, then load it again' : ''}`;
          // A player keeps only so much behind its playhead: what it held from before the tap may be gone from it by
          // now, and run once more from the first gap it fetches that again (never for appends placed in order only).
          if (!pass && !stampless) { pass = { why, prog: f.prog }; go('accelerate', gaps[0][0]); fresh = this.now(); continue; }
          out = { outcome: 'failed', why: pass ? pass.why : why };
          break;
        }
        // A seek-hop stalls when it brings nothing new, or when the player says so while it appends elsewhere (shaka going on
        // from its last segment after a flush): either way, accelerate.
        if (mode === 'seekhop' && (st === 'refused' || this.now() - fresh > this.t.stall || (stalled && this.now() - stalled > this.t.stall))) { go('accelerate'); fresh = this.now(); continue; }
        if (mode === 'accelerate' && st === 'refused') { out = { outcome: 'failed', why: pass ? pass.why : 'the page will not let its player run faster' }; break; }
        // Flushed, and nothing comes even played: a player that never fetches a piece twice. The start is not to be had.
        if (mode === 'accelerate' && flushed && startOf() && this.now() - fresh > this.t.stall) { out = { outcome: 'failed', why: unfetched }; break; }
        if (this.now() > end) { out = { outcome: 'failed', why: `the player had not given the whole track after ${secs(this.now() - end + this.t.drive + T * this.t.drivePerSec)} (missing ${this.gapsNow().map(span).join(', ')})` }; break; }
      }
    } finally {
      this.send(f, { t: 'drive', mode: 'stop' }); // always: the player gets back its rate, pitch, mute and place
    }
    if (out) return out;
    return { why: `${this.own(f).length} pieces captured from the player`, ...(await this.decodeOr(placed)) };
  }

  // ---------------------------------------------------------------- assembly
  parts() { const f = this.held(); return [...(f ? this.own(f) : []), ...this.fetched]; }

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
  /**
   * After the page went away: the track, when what is already in covers it ({pcm, notice}: the page going away does
   * not matter then), else null. Pieces still being read are waited for; one the page took with it fails to read.
   */
  async inHand() {
    // A page that moved on in place (a single-page site: its frame and agent stay) may have handed over its next track's
    // pieces as the track's: what is in is kept only if the track's frame goes too (another document).
    if (this.inPlace && !(await this.frameGone())) return null;
    while (this.inflight.size) await Promise.all([...this.inflight]);
    const T = this.target(), parts = this.parts();
    if (T == null || !parts.length) return null;
    const placed = this.d.placeParts(parts);
    if (this.d.gapsFor(placed, T).length) return null;
    this.rep.placed = placed;
    this.rep.notes.push('the page went away once every piece was in: the track was kept');
    const r = await this.decodeOr(placed);
    return r.done || null;
  }

  /**
   * {done: {pcm, notice}}, {again: true, why} when the length changed while decoding, or {outcome:'failed', why}. The
   * placement covers the track: every byte is in, so the page may go meanwhile.
   */
  decodeOr(placed) { return this.holding(() => this.decodeRuns(placed)); }
  async decodeRuns(placed) {
    const D = this.duration(), T = this.target(), cut = T < D - placed.tol, t0 = this.now();
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
    this.rep.steps.push({ name: 'decode', outcome: 'ok', why: `${placed.runs.length} run${placed.runs.length === 1 ? '' : 's'}`, ms: this.now() - t0 });
    const len = this.duration();
    if (!(Math.abs(len - D) <= placed.tol)) { // never resident at a length the page no longer gives
      const why = len == null ? 'the player stopped saying how long the track is while it decoded' : `the track's length changed from ${D.toFixed(1)} s to ${len.toFixed(1)} s while it decoded`;
      this.changes.push(why);
      return { again: true, why };
    }
    return { done: this.limited(pcm, D) };
  }

  // ---------------------------------------------------------------- the end
  async finish({ pcm, notice }) {
    const d = this.deck, e = this.engine, t0 = this.now();
    this.say(0.85, SAY.beat);
    let analysis = null;
    try { analysis = await e.analyse(pcm, this.signal); } catch (err) {
      this.check();
      e.event('warn', `Deck ${d.slot}: no beat grid from the whole track (${err.message}). TAP the beat.`, d.id);
    }
    this.check();
    this.rep.steps.push({ name: 'beat', outcome: analysis ? 'ok' : 'none', why: analysis && analysis.bpm > 0 ? `${analysis.bpm.toFixed(2)} BPM` : 'no steady beat', ms: this.now() - t0 });
    const length = pcm.L.length / pcm.sampleRate; // read first: the deck takes the arrays
    // Named for the page the track came from, though the tab may show another by now (the hub's META renames the deck).
    const res = await e.serial(() => e.startResidentDeck({ deckId: d.id, pcm, analysis, meta: this.page }));
    if (!res.ok) { this.check(); throw new Stop('live', LIVE.failed(res.error)); }
    this.done = true; // the tap's messages are not this load's any more
    // With the promotion, before any other task: no snapshot shows the resident deck without its report.
    this.rep.result = `resident, ${length.toFixed(3)} s`;
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
      `Result: ${r.result || `still loading: ${this.doing || 'starting'}`}`,
      `Track length: ${D != null ? `${D.toFixed(3)} s (the page's player)` : 'not known'}`,
      ...(r.limit ? [`Limit: ${r.limit}`] : []),
      'Steps:',
      ...r.steps.map((s) => `  ${s.name}${s.how ? ` (${s.how})` : ''}: ${s.outcome ? `${s.outcome} in ${secs(s.ms)}` : `running for ${secs(this.now() - s.at)}`}${s.why ? ` — ${s.why}` : ''}`),
      ...[...r.notes, ...this.othersSaid()].map((n) => `  note: ${n}`),
      `Media types: ${r.mimes.size ? [...r.mimes].join(', ') : 'none seen'}`,
      `Runs: ${p ? p.runs.length : 0}, segments: ${p ? p.runs.reduce((n, x) => n + x.segs.length, 0) : 0}, gaps: ${gaps.length ? gaps.map(span).join(', ') : 'none'}`,
      `Requests seen: ${media} media, ${lists} playlist${lists === 1 ? '' : 's'}`,
      `Bytes: ${kb(captured)} captured from the player, ${kb(r.refetched)} fetched again`,
      `First failure: ${failed ? `${failed.name}: ${failed.why}` : (r.result || '').startsWith('live: ') ? r.result.slice(6) : 'none'}`,
      `Total: ${secs(this.now() - r.t0)}`,
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

  /** The track's frame has gone, or goes within a moment (word of a page's new address can come before its agent goes). */
  async frameGone() {
    for (const t0 = this.now(); ;) {
      const f = this.held();
      if (!f || f.left) return true;
      if (this.signal.aborted || this.now() - t0 >= this.t.away) return false;
      await new Promise((r) => this.clock.setTimeout(r, Math.min(50, this.t.away / 4)));
    }
  }

  /** The tab's capture has ended: the tab closed, or its audio went away otherwise. */
  ended() { const s = this.deck.stream; return !s || s.getAudioTracks().every((t) => t.readyState === 'ended'); }

  /**
   * The page went away before the track was in: what became of the tab. Word of it comes by other ways a moment
   * later (the hub's META for the page the tab shows now, its EJECT of a closed tab), so it is waited for: 'moved'
   * (another page), 'ended' (the capture ended, and no EJECT came) or 'reload' (the same page again). An EJECT
   * meanwhile cancels the load, and says why itself.
   */
  async fate() {
    const t0 = this.now();
    for (;;) {
      if (this.signal.aborted || this.engine.decks.get(this.deck.id) !== this.deck) throw new Stop('cancel', 'Loading was cancelled.');
      if (this.moved()) {
        this.rep.steps.push({ name: 'page', outcome: 'moved', why: `the tab shows ${short(this.deck.meta.url)} now`, ms: this.now() - t0 });
        return 'moved';
      }
      if (this.now() - t0 >= this.t.away) break;
      await new Promise((r) => this.clock.setTimeout(r, Math.min(50, this.t.away / 4)));
    }
    const ended = this.ended();
    this.rep.steps.push({ name: 'page', outcome: ended ? 'ended' : 'reload', why: ended ? "the tab's capture ended" : 'the same page again', ms: this.now() - t0 });
    return ended ? 'ended' : 'reload';
  }

  async fail(err) {
    const d = this.deck, e = this.engine;
    this.quiet();
    let away = null;
    // A page that moved on in place says so only by its address: looked at here too, whatever ended the load.
    if (!this.closed && (this.gone || this.moved()) && !this.signal.aborted && e.decks.get(d.id) === d) {
      try { away = await this.fate(); } catch (x) { err = x; }
    }
    const cancelled = (err instanceof Stop && err.kind === 'cancel') || this.signal.aborted || e.decks.get(d.id) !== d;
    this.done = true;
    if (cancelled) { this.rep.result = 'cancelled'; return { ok: false, error: 'Loading was cancelled.' }; }
    const own = e.loads.get(d.id);
    if (own && own.loader === this) e.loads.delete(d.id); // failLoadingToLive aborts the load it finds
    // The deck goes, with one error, rather than play live: a tab showing another page plays something else, and a
    // tab whose capture ended (closed, or its audio gone) would make a silent live deck.
    const gone = away === 'moved' ? 'the page moved on to something else before the track was in. Add the tab again.'
      : this.closed ? 'the tab was closed before the track was in.'
        : this.ended() ? "the tab's audio went away while the track was loading." : null;
    if (gone) {
      const error = `Deck ${d.slot}: ${gone}`;
      this.rep.result = `ejected: ${gone}`;
      d.setLoad({ report: this.report() });
      e.event('error', error, d.id);
      e.eject(d.id);
      return { ok: false, error };
    }
    const reason = !(err instanceof Stop) ? LIVE.failed((err && err.message) || String(err)) : err.kind === 'away' ? LIVE.gone : err.message;
    this.rep.result = `live: ${reason}`;
    d.setLoad({ report: this.report() });
    const r = await e.failLoadingToLive(d.id, reason);
    if (!r.ok) {
      if (e.decks.get(d.id) === d) e.eject(d.id);
      return r;
    }
    return { ok: true, kind: 'live', deckId: d.id, slot: d.slot, ...(err instanceof Stop && err.noBytes ? { noBytes: true } : {}) };
  }
}

/**
 * The load report of a file or a link loaded straight onto a deck (engine.loadDirect), for "Copy load report": what it
 * is, each step with how it ended, why and how long it took, and the result. Shown while the deck loads, and kept on
 * the deck it leaves, resident or failed.
 */
export class DirectReport {
  /** file: its name; else url: the link. */
  constructor({ file, url }) {
    this.source = file != null ? `a file, “${file}”` : `a link, ${short(url)}`;
    this.steps = [];
    this.t0 = this.at = now();
    this.result = null;
    this.limit = null;
  }
  /** The step that ran since the last one ended: how it ended, and why. */
  step(name, outcome, why = '') { const t = now(); this.steps.push({ name, outcome, why, ms: t - this.at }); this.at = t; }
  /** The fetch step done: n bytes. */
  fetched(n) { this.step('fetch', 'ok', kb(n)); }
  /** The report; doing: what the load is doing now (until it has a result). */
  text(doing) {
    const failed = this.steps.find((s) => s.outcome === 'failed');
    return [
      'JD Samps load report', `Source: ${this.source}`, `Result: ${this.result || `still loading: ${doing || 'starting'}`}`,
      ...(this.limit ? [`Limit: ${this.limit}`] : []), 'Steps:',
      ...this.steps.map((s) => `  ${s.name}: ${s.outcome} in ${secs(s.ms)}${s.why ? ` — ${s.why}` : ''}`),
      ...(this.result ? [] : [`  ${doing || 'starting'}: running for ${secs(now() - this.at)}`]),
      `First failure: ${failed ? `${failed.name}: ${failed.why}` : 'none'}`, `Total: ${secs(now() - this.t0)}`,
    ].join('\n');
  }
}

// ---------------------------------------------------------------- recording a whole track (§4.4)
// Opt-in (the ⓘ action, or the setting that does it without asking): for a page whose bytes cannot be had, the live
// deck's own capture records the tab's sound while its player runs the track at 2× from the start (pitch unlocked),
// and the recording is slowed back by 2. Whatever lay above a quarter of the media's rate (12 kHz at 48 kHz) is gone,
// and the deck says so.
const REC_RATE = 2;
const AUDIBLE = 0.003; // about -50 dBFS, as a deck's first audible sample
const HOLD_MS = 700;   // the player held silent at the start: longer than a recorder batch and the capture's delay

/** The first audible frame in [from, to) of a recording, or -1. */
export function findStart(L, R, from, to) {
  for (let i = Math.max(0, from); i < to; i++) if (Math.abs(L[i]) > AUDIBLE || Math.abs(R[i]) > AUDIBLE) return i;
  return -1;
}

// Under load the tab capture now and then puts in or loses some of its 10 ms buffers (20 ms of the track at 2×),
// silently: the page's player and the engine's clock never see it, but every beat after it is that much late or
// early, and the beat grid fitted to the whole recording comes out a few tenths of a percent off. What it puts in is
// silence, exact zeros; what it loses leaves nothing behind. A skip shows against the music itself: a bar from the
// skip on sits that much off the bar before it, while every other bar sits on the one before. Music that is not on
// a grid (played by hand, or a reading of it that is not clear) is left alone.
const SKIP_MIN = 0.006, SKIP_MAX = 0.026; // s: a step mended (a buffer or two, or a burst adding up to that)
const SKIP_TOL = 0.0015;                 // s: bars that sit together
const SKIP_NOISE = 0.001;                // s: how closely the bars about a step must sit (90 % of them)
const SKIP_LAG = 0.03;                   // s: how far a bar is looked for from where the beat puts it
const medianOf = (xs) => { const s = Float64Array.from(xs).sort(); return s.length ? s[s.length >> 1] : 0; };

/** Two envelopes of a recording at `hop` frames: the loudest sample of either channel, and the low band's (300 Hz). */
function skipEnvelopes({ L, R, sampleRate: sr }, hop) {
  const n = Math.floor(L.length / hop), env = new Float32Array(n), low = new Float32Array(n), a = Math.exp((-2 * Math.PI * 300) / sr);
  let y1 = 0, y2 = 0;
  for (let k = 0; k < n; k++) {
    let m = 0, ml = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) {
      m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
      y1 = (1 - a) * 0.5 * (L[i] + R[i]) + a * y1;
      y2 = (1 - a) * y1 + a * y2;
      ml = Math.max(ml, Math.abs(y2));
    }
    env[k] = m; low[k] = ml;
  }
  return [env, low];
}

/**
 * One reading of envelope f: how far window k (span beats from k·Tb, in hops) sits from window k − 4, a bar before:
 * d[k] (hops; NaN where the two don't match well), and base[k], the median of d about it (the beat's own error).
 */
function barShifts(f, Tb, span, lag) {
  const W = Math.floor(Tb * span), nb = Math.max(0, Math.floor((f.length - lag) / Tb) - span), start = (k) => Math.round(k * Tb);
  const S1 = new Float64Array(f.length + 1), S2 = new Float64Array(f.length + 1), d = new Float64Array(nb).fill(NaN), cs = new Float64Array(2 * lag + 1);
  for (let i = 0; i < f.length; i++) { S1[i + 1] = S1[i] + f[i]; S2[i + 1] = S2[i] + f[i] * f[i]; }
  for (let k = 4; k < nb; k++) {
    const a = start(k - 4), b = start(k);
    if (b - lag < 0 || b + W + lag > f.length) continue;
    const ma = (S1[a + W] - S1[a]) / W, va = S2[a + W] - S2[a] - W * ma * ma;
    if (!(va > 1e-12)) continue;
    const c = (i) => { // the match at lag i - lag, worked out once
      if (!isNaN(cs[i])) return cs[i];
      const o = b + i - lag, mb = (S1[o + W] - S1[o]) / W, vb = S2[o + W] - S2[o] - W * mb * mb;
      let ab = 0;
      for (let j = 0; j < W; j++) ab += f[a + j] * f[o + j];
      return (cs[i] = vb > 1e-12 ? (ab - W * ma * mb) / Math.sqrt(va * vb) : 0);
    };
    cs.fill(NaN);
    let best = 0; // every other lag, then the two beside the best (a match is wider than a hop)
    for (let i = 2; i < cs.length; i += 2) if (c(i) > c(best)) best = i;
    for (const i of [best - 1, best + 1]) if (i >= 0 && i < cs.length && c(i) > c(best)) best = i;
    if (c(best) < 0.5) continue;
    let off = 0;
    if (best > 0 && best < cs.length - 1) { const p = c(best - 1), q = c(best), r = c(best + 1), den = p - 2 * q + r; if (den < 0) off = (0.5 * (p - r)) / den; }
    d[k] = best - lag + off;
  }
  const base = new Float64Array(nb).fill(NaN);
  for (let k = 0; k < nb; k++) {
    const w = [];
    for (let j = Math.max(0, k - 16); j <= Math.min(nb - 1, k + 16); j++) if (!isNaN(d[j])) w.push(d[j]);
    if (w.length >= 8) base[k] = medianOf(w);
  }
  return { f, d, base, nb, start, Tb, span };
}

/** A recording's readings at beat T (s): both envelopes, in windows of one beat and of two. */
function skipReadings(pcm, T, hop) {
  const sr = pcm.sampleRate, lag = Math.round((SKIP_LAG * sr) / hop), out = [];
  for (const [i, f] of skipEnvelopes(pcm, hop).entries()) for (const span of [1, 2]) out.push({ i, ...barShifts(f, (T * sr) / hop, span, lag) });
  return out;
}

/**
 * The steps in one reading: a run of windows off their bar by one amount S, with the beat as it was either side of
 * it (past the windows that straddle the step, which may read anything), where the bars about it (two bars either
 * side) sit together.
 * -> [{S (hops), mlo, mhi, first, last}]: the first window wholly after the step is one of mlo..mhi.
 */
function readSteps(r, hop, sr) {
  const { d, base, nb, span } = r, tol = (SKIP_TOL * sr) / hop, min = (SKIP_MIN * sr) / hop, max = (SKIP_MAX * sr) / hop;
  const dev = (k) => (k >= 4 && k < nb && !isNaN(d[k]) && !isNaN(base[k]) ? d[k] - base[k] : NaN);
  const out = [], near = new Uint8Array(nb);
  const side = (from, dir) => { // twice where there is room
    let quiet = 0, have = 0;
    for (let i = 0; i < span + 3; i++) {
      const j = from + dir * i, x = dev(j);
      if (j < 4) continue;
      have++;
      if (isNaN(x)) continue;
      if (Math.abs(x) <= tol) quiet++; else if (i > span) return false;
    }
    return quiet >= Math.min(2, have);
  };
  for (let k = 4; k < nb; k++) {
    const v = dev(k);
    if (isNaN(v) || Math.abs(v) < min) continue;
    let last = k;
    while (last + 1 < nb && Math.abs(dev(last + 1) - v) <= tol) last++;
    const first = k, run = [];
    for (let j = first; j <= last; j++) run.push(dev(j));
    const S = medianOf(run);
    k = last;
    if (run.length < 3 || run.length > 4 + span || Math.abs(S) > max || run.some((x) => Math.abs(x - S) > tol)) continue;
    const mark = () => { for (let j = Math.max(0, first - span); j <= Math.min(nb - 1, last + span); j++) near[j] = 1; };
    if (last + 2 >= nb) { mark(); continue; } // the track ends: no telling
    if (!side(first - 1, -1) || !side(last + 1, 1)) continue;
    mark();
    const mlo = Math.max(1, first, last - 3);
    out.push({ S, mlo, mhi: Math.max(mlo, Math.min(first + span, last - 3 + span)), first, last });
  }
  return out.filter((s) => {
    const rest = [];
    let stray = 0;
    for (let k = Math.max(4, s.first - 8); k <= Math.min(nb - 1, s.last + 8); k++) {
      const x = dev(k);
      if (near[k] || isNaN(x)) continue;
      rest.push(Math.abs(x));
      if (Math.abs(x) >= min) stray++;
    }
    rest.sort((p, q) => p - q);
    return rest.length >= 4 && (rest[Math.floor(0.9 * (rest.length - 1))] * hop) / sr <= SKIP_NOISE && stray <= 1;
  });
}

/**
 * Where about step s (hops) the music leaves its bar-before self at the old place and meets it moved by S, on the
 * rises of both envelopes: {lo, hi}, the split that fits best (a stretch, where nothing rises).
 */
function whereStep(fs, r, s) {
  const { Tb, start, base } = r, A = Math.max(1, Math.round(start(s.mlo - 1) - 0.25 * Tb)), B = Math.min(fs[0].length - 1, Math.round(start(s.mhi) + 0.25 * Tb));
  const b = base[Math.min(base.length - 1, s.mhi)] || 0, n = B - A, E = new Float64Array(n + 1), SM = 4;
  if (n <= 0 || A - 4 * Tb - b - Math.abs(s.S) - SM - 2 < 0) return { lo: A, hi: B };
  for (const f of fs) {
    const sm = (x) => { const i = Math.floor(x), t = x - i; let acc = 0; for (let j = 0; j < SM; j++) acc += f[i - j] * (1 - t) + f[i - j + 1] * t; return acc / SM; };
    const rise = (x) => Math.max(0, sm(x) - sm(x - 1));
    let norm = 1e-12;
    for (let x = A; x < B; x++) norm += rise(x) ** 2;
    const P0 = new Float64Array(n + 1), PS = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const x = A + i, back = x - 4 * Tb - b, v = rise(x);
      P0[i + 1] = P0[i] + (v - rise(back)) ** 2 / norm;
      PS[i + 1] = PS[i] + (v - rise(back - s.S)) ** 2 / norm;
    }
    for (let i = 0; i <= n; i++) E[i] += P0[i] + PS[n] - PS[i];
  }
  let lo = 0, top = -Infinity;
  for (let i = 0; i <= n; i++) { if (E[i] < E[lo]) lo = i; top = Math.max(top, E[i]); }
  const eps = E[lo] + 0.05 * (top - E[lo]);
  let hi = lo;
  while (lo > 0 && E[lo - 1] <= eps) lo--;
  while (hi < n && E[hi + 1] <= eps) hi++;
  return { lo: A + lo, hi: A + hi };
}

/** A recording with edits [at, frames cut (> 0) or silence put in (< 0)], in order. */
function edited({ L, R, sampleRate }, edits) {
  const size = edits.reduce((s, [, len]) => s - len, L.length), oL = new Float32Array(size), oR = new Float32Array(size);
  let src = 0, dst = 0;
  for (const [at, len] of edits) {
    oL.set(L.subarray(src, at), dst); oR.set(R.subarray(src, at), dst); dst += at - src;
    if (len > 0) src = at + len; else { dst -= len; src = at; } // a cut skips audio; a loss gets silence
  }
  oL.set(L.subarray(src), dst); oR.set(R.subarray(src), dst);
  return { L: oL, R: oR, sampleRate };
}

/**
 * A recording's skips mended, so every beat is in its place: silence the capture put in is cut (the run of zeros a
 * step long, or the step's worth of a longer one), and audio it lost is given back as silence in the quietest 10 ms
 * where the step is. A loss must show in two readings; an edit stays only where the mended recording reads as one
 * beat there. T: the beat period (s). -> {pcm, steps: [{at: s, ms}]}; pcm is the same object when nothing was mended.
 */
export function mendSteps(pcm, T) {
  const { L, R, sampleRate: sr } = pcm, hop = Math.max(1, Math.round(0.0005 * sr));
  if (!(T > 0) || L.length < 12 * T * sr) return { pcm, steps: [] };
  const rs = skipReadings(pcm, T, hop), fs = rs.filter((r) => r.span === 1).map((r) => r.f), found = [];
  for (const r of rs) for (const s of readSteps(r, hop, sr)) {
    const lo = r.start(s.mlo - 1) - r.Tb, hi = r.start(s.mhi) + r.Tb, same = found.find((x) => x.lo < hi && lo < x.hi);
    if (!same) found.push({ r, s, lo, hi, seen: 1 });
    else if (Math.abs(same.s.S - s.S) <= (SKIP_TOL * sr) / hop) same.seen++;
  }
  found.sort((p, q) => p.lo - q.lo);
  const BUF = Math.round(0.01 * sr), tol = Math.round(SKIP_TOL * sr), edits = [];
  for (const { r, s, seen } of found) {
    let D = Math.round(s.S * hop), at = -1, len;
    const k = Math.round(D / BUF);
    if (k !== 0 && Math.abs(D - k * BUF) <= tol) D = k * BUF; // whole capture buffers
    len = D;
    if (D > 0) {
      // The capture's silence: a run of zeros as long as the step; or, where the track is near silent there too, a
      // near-silent run the step longer than the same place a bar away (silence it fell into).
      const lo = Math.max(0, Math.round(r.start(s.mlo - 1) - 0.25 * r.Tb) * hop), hi = Math.min(L.length, Math.round(r.start(s.mhi) + 0.25 * r.Tb) * hop);
      const bar = Math.round((4 * r.Tb + (r.base[s.mhi] || 0)) * hop);
      const runs = (still) => {
        const runAt = (i) => { if (!still(i)) return 0; let a = i, j = i; while (still(a - 1)) a--; while (still(j)) j++; return j - a; };
        const out = [];
        for (let i = lo; i < hi; i++) {
          if (!still(i)) continue;
          let a = i, j = i;
          while (still(a - 1)) a--;
          while (still(j)) j++;
          i = j;
          const mid = (a + j) >> 1;
          out.push({ a, run: j - a, more: j - a - (mid - bar >= 0 ? runAt(mid - bar) : runAt(mid + bar + D)) });
        }
        return out;
      };
      const zero = (i) => i >= 0 && i < L.length && L[i] === 0 && R[i] === 0;
      const hush = (i) => i >= 0 && i < L.length && Math.abs(L[i]) <= 1e-4 && Math.abs(R[i]) <= 1e-4;
      const near = (xs, key) => xs.filter((x) => Math.abs(x[key] - D) <= tol).sort((p, q) => Math.abs(p[key] - D) - Math.abs(q[key] - D))[0];
      const best = near(runs(zero), 'run') || near(runs(hush), 'more');
      if (!best) continue; // audio put in is the capture's silence, or no skip
      if (Math.abs(best.run - D) <= tol && zero(best.a)) { at = best.a; len = best.run; } else at = best.a + ((best.run - D) >> 1);
    } else {
      if (seen < 2) continue; // a loss leaves nothing behind: two readings must see it
      const sp = whereStep(fs, r, s), w = Math.min(-D, BUF), a0 = Math.max(0, sp.lo * hop - (w >> 1)), b0 = Math.min(L.length, (sp.hi + 1) * hop + (w >> 1));
      const sum = new Float64Array(Math.max(0, b0 - a0) + 1);
      for (let i = a0; i < b0; i++) sum[i - a0 + 1] = sum[i - a0] + Math.max(Math.abs(L[i]), Math.abs(R[i]));
      let low = Infinity;
      for (let i = a0; i + w <= b0; i++) if (sum[i + w - a0] - sum[i - a0] < low) { low = sum[i + w - a0] - sum[i - a0]; at = i; }
      if (at < 0) continue;
    }
    const prev = edits[edits.length - 1];
    if (prev && at < prev[0] + Math.max(0, prev[1])) continue;
    edits.push([at, len, r]);
  }
  if (!edits.length) return { pcm, steps: [] };
  // Read again about each edit (12 beats either side): an edit after which its reading still finds a step there was
  // no skip, or not that one.
  let out = edited(pcm, edits), moved = 0;
  const keep = edits.filter(([at, len, r]) => {
    const mid = at - moved, from = Math.max(0, Math.round(mid - 12 * T * sr)), to = Math.min(out.L.length, Math.round(mid + 12 * T * sr));
    moved += len;
    const part = { L: out.L.subarray(from, to), R: out.R.subarray(from, to), sampleRate: sr }, k = (mid - from) / hop / r.Tb;
    const y = skipReadings(part, T, hop).find((x) => x.i === r.i && x.span === r.span);
    return !readSteps(y, hop, sr).some((s) => s.mlo - 3 <= k && k <= s.mhi + 3);
  });
  if (!keep.length) return { pcm, steps: [] };
  if (keep.length < edits.length) out = edited(pcm, keep);
  return { pcm: out, steps: keep.map(([at, len]) => ({ at: at / sr, ms: (len / sr) * 1000 })) };
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
    const e = this.engine, live = this.live, d = this.deck, sr = e.ctx.sampleRate, t0 = this.now(), assist = live.assist.offUntil;
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
      const mark = frames, end = this.now() + (T / REC_RATE + 10) * 1000;
      this.send({ t: 'drive', mode: 'accelerate', rate: REC_RATE, audible: true });
      this.say(0.02, `recording from the page at ${REC_RATE}×`);
      let start = -1;
      for (;;) {
        await this.sleep(250);
        this.check();
        if (this.refused()) throw new Stop('live', 'the page will not let its player run faster');
        if (start < 0) start = findStart(L, R, mark, frames);
        if (start >= 0) { this.say(0.02 + 0.78 * Math.min(1, (frames - start) / need)); if (frames - start >= need) break; }
        if (this.now() > end) throw new Stop('live', start < 0 ? 'the page played nothing' : 'the page stopped before the end of the track');
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
      // The capture's skips, mended against its own bars (a bar apart everywhere else), and the beat found again.
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
      const got = pcm.L.length / pcm.sampleRate; // read first: the deck takes the arrays
      const res = await e.serial(() => e.startResidentDeck({ deckId: d.id, pcm, analysis }));
      if (!res.ok) { this.check(); throw new Stop('live', res.error); }
      this.end();
      const host = hostOf(live.meta && live.meta.url) || 'unknown';
      d.setLoad({ report: [
        'JD Samps load report', `Page: ${host}`, `Result: resident, ${got.toFixed(3)} s, recorded from the page at ${REC_RATE}× (reduced highs)`,
        `Track length: ${D.toFixed(3)} s (the page's player)`, ...(T < D ? [`Limit: the deck holds the first ${minutes(T / 60)}`] : []),
        `Recorded: ${(need / sr).toFixed(3)} s of the tab's sound from deck ${live.slot}'s capture, slowed back by ${REC_RATE}`,
        ...(mended.length ? [`Mended: ${mended.length} skip${mended.length === 1 ? '' : 's'} in the capture (the computer was busy): ${mended.map((x) =>
          `${Math.round(Math.abs(x.ms) * REC_RATE)} ms ${x.ms > 0 ? 'put in' : 'lost'} at ${(x.at * REC_RATE).toFixed(1)} s`).join(', ')}`] : []),
        `Total: ${secs(this.now() - t0)}`,
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
