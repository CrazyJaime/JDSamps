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
import { decodeTo, limitPcm, fetchArrayBuffer } from './decode.js';

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

/** A placement cut to the segments that start before `until` (the resident limit). */
function trimPlaced(placed, until) {
  const runs = [];
  for (const r of placed.runs) { const segs = r.segs.filter((s) => s.t0 < until); if (segs.length) runs.push({ ...r, segs }); }
  const end = runs.length ? runs.at(-1).segs.at(-1).t1 : 0;
  return { ...placed, runs, coverage: placed.coverage.filter(([a]) => a < end).map(([a, b]) => [a, Math.min(b, end)]), end };
}

export class Loader {
  /**
   * engine: the Engine (or a stand-in with the same methods); deck: the loading deck, holding the tab's capture;
   * signal: aborted when the deck is ejected or the load cancelled. deps: fetchBytes, decodeFile, decodePlaced,
   * placeParts, gapsFor and times, for tests.
   */
  constructor({ engine, deck, tabId, signal, deps = {} }) {
    const { times, ...d } = deps;
    this.engine = engine;
    this.deck = deck;
    this.tabId = tabId;
    this.signal = signal;
    this.d = { fetchBytes: fetchArrayBuffer, decodeFile: decodeTo, decodePlaced, placeParts, gapsFor, ...d };
    this.t = { ...TIMES, ...times };
    this.frames = new Map();   // frameId -> what its agent said, and what it handed over
    this.waiters = new Set();
    this.inflight = new Set(); // blob: URLs being read
    this.fetched = [];         // pieces fetched again, keyed for placement
    this.tried = new Set();    // links already fetched again
    this.batch = 0;
    this.tapping = false;
    this.done = false;         // finished: the tap's messages are no longer this load's
    this.gone = null;          // the page went away mid-load
    this.big = false;
    this.bytes = 0;            // read from the tab, all frames
    this.progress = 0;
    this.host = hostOf(deck.meta && deck.meta.url);
    this.rep = { steps: [], mimes: new Set(), refetched: 0, placed: null, limit: null, result: null, notes: [], t0: now() };
    signal.addEventListener('abort', () => this.poke(), { once: true });
  }

  // ---------------------------------------------------------------- the deck's agents
  onAttach(frameId, a) {
    if (this.done || this.gone) return;
    const f = { id: frameId, n: this.frames.size + 1, a, on: false, left: false, parts: [], reqs: [], errors: [], prog: null, bytes: 0, fetch: null, asked: false, answer: null, file: null, fileDuration: null };
    this.frames.set(frameId, f);
    if (this.tapping) this.tapOn(f);
    this.poke();
  }

  onDetach(frameId, a) {
    const f = this.frames.get(frameId);
    if (!f || f.a !== a || f.left) return;
    f.left = true;
    // The top frame's agent going (or the last one) is the page going: navigated, reloaded or closed.
    if (!this.done && !this.gone && (frameId === 0 || !this.attached().length)) this.gone = 'the page went away';
    this.poke();
  }

  onTap(frameId, m) {
    const f = this.frames.get(frameId);
    if (!f || f.left || this.done) return;
    if (m.t === 'tap-progress') {
      f.prog = m;
      for (const x of m.mimes) this.rep.mimes.add(x);
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
  reqs() { return this.attached().flatMap((f) => f.reqs); }
  mimes() { return [...this.rep.mimes]; }
  /** A frame whose player uses Media Source (the tap saw a SourceBuffer, or what it appended), most bytes first. */
  mseFrame() { return this.attached().filter((f) => (f.prog && f.prog.mimes.length) || f.parts.length).sort((a, b) => b.bytes - a.bytes)[0] || null; }
  /** How long the player says the track is: the Media Source frame's player first, else the top frame's, else any. */
  duration() {
    const fs = this.attached().filter((f) => f.prog && f.prog.duration);
    const f = fs.find((x) => x.prog.mimes.length) || fs.find((x) => x.id === 0) || fs[0];
    return f ? f.prog.duration : null;
  }
  limitSec() { return (this.engine.params['resident.limitMin'] || 15) * 60; }
  /** What must be covered: the track, or its first part when it is longer than the resident limit. */
  target() { const D = this.duration(); return D == null ? null : Math.min(D, this.limitSec()); }
  decisive() {
    for (const f of this.attached()) for (const e of f.errors) if (DECISIVE.includes(e.reason)) return e.reason;
    return null;
  }

  // ---------------------------------------------------------------- waiting
  /** Resolves true once cond() holds (checked whenever the tap says something), false after ms; rejects when cancelled. */
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

  /** Progress only goes up; strategy in plain words (undefined: unchanged). */
  say(p, strategy) {
    if (this.done) return;
    this.progress = Math.max(this.progress, Math.min(0.99, p));
    this.deck.setLoad(strategy === undefined ? { progress: this.progress } : { progress: this.progress, strategy });
  }
  /** A rung's own 0..1 mapped onto what is left of the bar before decoding. */
  band(hi = 0.8) { const lo = Math.min(this.progress, hi); return (x) => lo + Math.max(0, Math.min(1, x)) * (hi - lo); }

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
      this.done = true;
      for (const w of this.waiters) clearTimeout(w.timer);
      this.waiters.clear();
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
    if (order.includes('refetch') && this.mseFrame() && this.wanted(null).urls.length) {
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

  /** A whole media file, decoded and checked against the length the page gives (`expect`, s). */
  async wholeFile(bytes, expect, what) {
    if (expect && expect > 2 * this.limitSec()) return { outcome: 'failed', why: `${what} is ${minutes(expect / 60)} long, too long to decode whole` };
    this.say(this.progress, SAY.decode);
    const t0 = now();
    let pcm;
    try { pcm = await this.d.decodeFile(this.engine.ctx, bytes); } catch (_) { this.check(); return { outcome: 'failed', why: `${what} is not audio this browser can play` }; }
    this.check();
    this.rep.steps.push({ name: 'decode', outcome: 'ok', why: what, ms: now() - t0 });
    const got = pcm.L.length / pcm.sampleRate;
    if (expect && Math.abs(got - expect) > Math.max(0.5, 0.01 * expect)) {
      return { outcome: 'failed', why: `${what} holds ${got.toFixed(1)} s, but the page's player says ${expect.toFixed(1)} s` };
    }
    return { done: this.limited(pcm, got) };
  }

  /** {pcm, notice}: the track, or its first part when it is longer than the resident limit (said once). */
  limited(pcm, length) {
    const lim = limitPcm(pcm, this.engine.params['resident.limitMin']);
    const notice = lim.notice || (length > this.limitSec() + 0.5
      ? `this track is ${minutes(length / 60)} long: the deck holds its first ${minutes(this.limitSec() / 60)} (the resident track limit).` : null);
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
    for (let round = 0; round < 3; round++) {
      const placed = await this.complete();
      if (placed) { const r = await this.decodeOr(placed); if (!r.again) return r; continue; }
      const want = this.wanted(this.plan);
      if (!want.urls.length) break;
      const n = await this.fetchPieces(want);
      fetched += n.ok; failed += n.failed;
    }
    const placed = await this.complete();
    if (placed) return this.decodeOr(placed);
    const gaps = this.gapsNow();
    return { outcome: 'failed', why: `${fetched} pieces fetched${failed ? `, ${failed} failed` : ''}, still missing ${gaps.map(span).join(', ') || 'the track length'}` };
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
    const inits = f ? f.parts.filter((p) => p.kind === 'init') : [];
    return inits.sort((a, b) => b.seq - a.seq)[0] || null;
  }

  frameOf(url) { const r = this.reqs().find((x) => x.url === url); return r ? r.frame : this.top(); }

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
    let mode = null, placed = null, out = null;
    const go = (m) => {
      mode = m;
      this.send(f, m === 'seekhop' ? { t: 'drive', mode: m } : { t: 'drive', mode: m, rate: DRIVE_RATE });
      e.how = e.how ? `${e.how}, then ${m === 'seekhop' ? 'seek-hop' : `accelerate ${DRIVE_RATE}×`}` : m === 'seekhop' ? 'seek-hop' : `accelerate ${DRIVE_RATE}×`;
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
        const d = f.prog && f.prog.drive, st = d && d.mode === mode ? d.state : 'running';
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
          out = { outcome: 'failed', why: `the player buffered the whole track, but ${this.gapsNow().map(span).join(', ')} came before the deck could read it` };
          break;
        }
        if (mode === 'seekhop' && (st === 'refused' || now() - fresh > this.t.stall)) { go('accelerate'); fresh = now(); continue; }
        if (mode === 'accelerate' && st === 'refused') { out = { outcome: 'failed', why: 'the page will not let its player run faster' }; break; }
        if (now() > end) { out = { outcome: 'failed', why: `the player had not given the whole track after ${secs(now() - end + this.t.drive + T * this.t.drivePerSec)} (missing ${this.gapsNow().map(span).join(', ')})` }; break; }
      }
    } finally {
      this.send(f, { t: 'drive', mode: 'stop' }); // always: the player gets back its rate, pitch, mute and place
    }
    if (out) return out;
    return this.decodeOr(placed);
  }

  // ---------------------------------------------------------------- assembly
  parts() { return [...this.attached().flatMap((f) => f.parts), ...this.fetched]; }

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
    this.rep.steps.push({ name: 'beat', outcome: analysis ? 'ok' : 'none', why: analysis ? `${analysis.bpm.toFixed(2)} BPM` : '', ms: now() - t0 });
    const res = await e.serial(() => e.startResidentDeck({ deckId: d.id, pcm, analysis }));
    if (!res.ok) { this.check(); throw new Stop('live', LIVE.failed(res.error)); }
    this.done = true; // the tap's messages are not this load's any more
    await this.release();
    if (notice) e.notify('warn', `Deck ${d.slot}: ${notice}`);
    this.rep.result = `resident, ${(pcm.L.length / pcm.sampleRate).toFixed(3)} s`;
    return { ok: true, kind: 'resident', deckId: d.id, slot: d.slot };
  }

  /**
   * The tab stops mattering: its player paused and given back its rate (STOP_TAB), the held capture stopped,
   * the agents' tap off and the agents let go, the tab forgotten (closing it no longer ejects the deck).
   */
  async release() {
    const d = this.deck, e = this.engine;
    if (e.decks.get(d.id) !== d) return;
    await e.stopTab(d);
    if (d.stream) { for (const t of d.stream.getTracks()) t.stop(); d.stream = null; }
    for (const a of d.agents.values()) { try { a.port.postMessage({ t: 'tap', on: false, forget: true }); a.port.disconnect(); } catch (_) {} }
    d.agents.clear();
    d.tabId = null;
    e.hub({ type: HUB.DECKS_CHANGED, decks: e.tabDecks() });
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
    const own = e.loads.get(d.id);
    if (own && own.loader === this) e.loads.delete(d.id); // failLoadingToLive aborts the load it finds
    const r = await e.failLoadingToLive(d.id, reason);
    if (!r.ok) {
      if (e.decks.get(d.id) === d) e.eject(d.id);
      return r;
    }
    return { ok: true, kind: 'live', deckId: d.id, slot: d.slot };
  }
}
