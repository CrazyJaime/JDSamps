// A fake tab for engine/loader.js: frames whose agents answer the page-tap commands (I3) the way
// agent/agent-main.js does, every message checked by the real validateAgentMessage; a fake engine
// and hub that record what the loader asks of them; and the model sites' real Opus fMP4 bytes, so
// the real placeParts places what the fake player "appends". decodePlaced and the file decoder are
// stand-ins (no Web Audio in Node): a "file" is JSON {audio, seconds}; decoded PCM is filled with a
// code naming its source, so a test can tell whose audio a deck got. The loader and every simulated
// delay here run on one virtual clock (engine.clock, virtual-clock.mjs): what the fakes do at once
// always comes before what is due later, however busy the machine is.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateAgentMessage } from '../../../shared/protocol.js';
import { gapsFor, AssemblyError } from '../../../engine/assemble.js';
import { mp3Frames } from '../../../engine/bmff.js';
import { Loader } from '../../../engine/loader.js';
import { FetchRefused, FETCH_STALL, fetchArrayBuffer } from '../../../engine/decode.js';
import { VirtualClock } from './virtual-clock.mjs';

const SITES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/sites');
const index = JSON.parse(fs.readFileSync(path.join(SITES, 'index.json'), 'utf8'));
const read = (p) => { const b = fs.readFileSync(path.join(SITES, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
export const SR = 1000; // the fake engine's sample rate: small, so test PCM stays small
export const OPUS = 'audio/mp4; codecs="opus"';
export const DUR = index.reps['opus-hi'].segs.at(-1).t1; // 120.0065
export const turn = () => new Promise((r) => setImmediate(r));
export const settle = async (n = 20) => { for (let i = 0; i < n; i++) await turn(); };

/** One rendition of the model track: init and segments with their bytes, under `origin`. */
export function rendition(rep = 'opus-hi', origin = 'https://cdn.example') {
  const r = index.reps[rep];
  return {
    rep, mime: r.mime, list: `${origin}/media/${rep}.m3u8`, init: { url: `${origin}/media/${r.init.path}`, bytes: read(r.init.path) },
    segs: r.segs.map((s) => ({ url: `${origin}/media/${s.path}`, t0: s.t0, t1: s.t1, bytes: read(s.path) })),
  };
}
/**
 * The rendition's HLS media playlist, its links relative to it (as the model sites write them). ts: the playlist an
 * MPEG-TS stream has instead (no init, .ts pieces), whose player transmuxes each piece before it appends it.
 */
export function playlist(r, { ts = false } = {}) {
  const rel = (u) => u.slice(r.list.lastIndexOf('/') + 1);
  if (ts) return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD',
    ...r.segs.flatMap((s) => [`#EXTINF:${(s.t1 - s.t0).toFixed(6)},`, rel(tsUrl(s.url))]), '#EXT-X-ENDLIST', ''].join('\n');
  return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-MAP:URI="${rel(r.init.url)}"`,
    ...r.segs.flatMap((s) => [`#EXTINF:${(s.t1 - s.t0).toFixed(6)},`, rel(s.url)]), '#EXT-X-ENDLIST', ''].join('\n');
}
/** A piece's link in an MPEG-TS playlist. */
export const tsUrl = (u) => u.replace(/\.m4s$/, '.ts');
const enc = (s) => { const b = Buffer.from(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
/** A whole "file" the stand-in decoder reads: `seconds` of audio coded `audio`. */
export const file = (audio, seconds) => enc(JSON.stringify({ audio, seconds }));
/** A real MP3 frame stream, `seconds` long (MPEG-2.5 Layer III, 8 kb/s at 8 kHz, mono: 72 bytes and 72 ms a frame). */
export function mp3(seconds) {
  const n = Math.ceil(seconds / 0.072 - 1e-9), u8 = new Uint8Array(n * 72);
  for (let i = 0; i < n; i++) u8.set([0xFF, 0xE3, 0x18, 0xC0], i * 72);
  return u8.buffer;
}
/** The code decoded PCM carries for a source (its first sample). */
export const code = (s) => Math.fround([...String(s)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) / 1000);

/**
 * A fake tab. page: {
 *   kind: 'mse' | 'progressive' | 'none' (no agent ever connects: Web Audio only),
 *   duration: s | null (never said) | Infinity (a stream: reported as null, then tap-error 'live' after liveAfter ms),
 *   rendition, preTap (segments appended before the tap was on: lost but for the init), playing (segments appended right after tap on),
 *   list (the HLS playlist was requested), segUrls (segment requests seen), pageFetch (false: every page fetch fails),
 *   src (a progressive element source URL), tralbum ({url, duration}), files ({url: bytes}, served to the page and the engine),
 *   hang ([url]: links the engine's own fetch of never answers),
 *   types ({url: Content-Type}: what its server types a link as; the blob the page hands over for it is typed so, as the
 *   agent makes it from the response, and the engine reads a typed blob through the real fetchArrayBuffer),
 *   errors (reasons reported at tap on), seekhop ('ok' | 'stall' | 'refuse' | 'slow': a piece every 10 ms | 'trickle': stalled where it hops, while the player
 *   appends on elsewhere, so bytes keep coming but never what is missing), accelerate ('ok' | 'refuse' | 'dead': it runs, and
 *   nothing more comes, as from a page whose connection dropped | 'late': it appends the rest after 200 ms), 'dead' for
 *   seekhop too (it runs, nothing comes, and it never says it stalled: a player busy with a flush), mimes (override),
 *   appends (MSE parts as {bytes} the player appends on a drive, in order, for a stream with no timestamps),
 *   status (the frame agent's status, over a heard playing player's), framePages ([{...}]: frame i's page, over this one),
 *   other ({rendition, sb, n}: another player's SourceBuffer in the frame, appending its init and first n segments at tap on),
 *   sbs (the SourceBuffers the tap says feed the heard player: default [0] for 'mse', [] for 'progressive'; null: not said),
 *   evicts (the player lets go of what it held from before the tap while it is driven: a later drive appends that again),
 *   ts (the playlist is MPEG-TS: no init, .ts pieces), fetched ([url]: media the page fetched before its player's own
 *   source, seen first), elSrc (false: the tap does not say which source the heard player plays),
 *   flush (how a drive {flush: true} is answered; unset: the flush is ignored, as an agent that does not know it would):
 *     'refetch' (flushed; the player fetches again what left its buffer), 'sticky' (it did not fetch again what was
 *     taken from behind its place, so the rest is left it: said in drive.unflushed, and nothing more comes), 'dry' (flushed,
 *     and then it fetches nothing more), 'ended' | 'video' | 'none' | 'start' (refused, said in drive.unflushed, and the
 *     drive goes on without it)
 * }
 */
export function makeTab({ tabId = 7, url = 'https://site.example/track', frames = 1, ...page } = {}) {
  const blobs = new Map(), types = new Map(), log = [], net = new Map(Object.entries(page.files || {}));
  for (const r of [page, ...(page.framePages || [])].flatMap((p) => [p.rendition, p.other && p.other.rendition])) {
    if (r) { net.set(r.list, enc(playlist(r, { ts: page.ts }))); net.set(r.init.url, r.init.bytes); for (const s of r.segs) net.set(page.ts ? tsUrl(s.url) : s.url, s.bytes); }
  }
  // Its delays run on a virtual clock: the engine's (makeEngine shares its own with the tabs it is given).
  const tab = { tabId, url, page, blobs, types, log, net, frames: [], deck: null, hooks: [], clock: new VirtualClock() };
  const mint = (bytes, type) => { const u = `blob:${new URL(url).origin}/${crypto.randomUUID()}`; blobs.set(u, bytes); if (type) types.set(u, type); return u; };
  for (let i = 0; i < frames; i++) {
    const pg = { ...page, ...((page.framePages || [])[i] || {}) }, r = pg.rendition;
    // The pieces appended before the tap are in the player's buffer: a drive never makes it append them again.
    const fr = { id: i, seq: 0, appended: new Set(Array.from({ length: pg.preTap || 0 }, (_, k) => k)), left: false, a: null, duration: pg.duration === undefined ? DUR : pg.duration };
    const emit = (m) => {
      const v = validateAgentMessage(m);
      if (!v) throw new Error(`the fake agent sent an invalid message: ${JSON.stringify(m)}`);
      if (fr.hung) return;
      setImmediate(() => { const d = tab.deck; if (!fr.left && d && d.agents.get(fr.id) === fr.a && d.loader) d.loader.onTap(fr.id, v); });
    };
    const sbs = pg.sbs !== undefined ? pg.sbs : pg.kind === 'mse' ? [0] : pg.kind === 'progressive' ? [] : null;
    const progress = (extra = {}) => emit({ t: 'tap-progress', bytes: 0, buffered: [], duration: Number.isFinite(fr.duration) ? fr.duration : null,
      mimes: pg.mimes || (pg.kind === 'mse' ? [r ? r.mime : OPUS] : []), ...(sbs ? { sbs } : {}), ...(pg.src && pg.elSrc !== false ? { src: pg.src } : {}), ...extra });
    const append = (ks) => {
      const parts = [];
      for (const k of ks) if (!fr.appended.has(k) && r.segs[k]) { fr.appended.add(k); parts.push({ blobUrl: mint(r.segs[k].bytes), mime: r.mime, kind: 'media', sb: 0, seq: fr.seq++ }); }
      if (parts.length) emit({ t: 'tap-ready', parts, duration: Number.isFinite(fr.duration) ? fr.duration : null });
    };
    const drive = (mode, m = {}) => {
      const how = m.late ? 'ok' : pg[mode] || 'ok';
      if (how === 'refuse' || (mode === 'seekhop' && (pg.mimes || []).some((m) => /mpeg|aac/.test(m)))) { progress({ drive: { mode, state: 'refused', at: 0 } }); return; }
      if (how === 'stall') { progress({ drive: { mode, state: 'stalled', at: 24 } }); return; }
      if (how === 'dead') { progress({ drive: { mode, state: 'running', at: 24 } }); return; }
      if (how === 'late') { progress({ drive: { mode, state: 'running', at: 24 } }); tab.clock.setTimeout(() => drive(mode, { ...m, late: true }), 200); return; }
      if (how === 'slow') {
        const ks = r.segs.map((_, k) => k).filter((k) => !fr.appended.has(k));
        ks.forEach((k, i) => tab.clock.setTimeout(() => { append([k]); if (i === ks.length - 1) tab.clock.setTimeout(() => progress({ drive: { mode, state: 'done', at: fr.duration } }), 5); }, 10 * (i + 1)));
        return;
      }
      if (how === 'trickle') {
        progress({ drive: { mode, state: 'stalled', at: 0 } });
        const k = pg.preTap || 0;
        fr.trickle = tab.clock.setInterval(() => emit({ t: 'tap-ready', parts: [{ blobUrl: mint(r.segs[k].bytes), mime: r.mime, kind: 'media', sb: 0, seq: fr.seq++ }], duration: fr.duration }), 20);
        fr.trickle.unref();
        return;
      }
      const unflushed = m.flush === true && ['ended', 'video', 'none', 'start', 'sticky'].includes(pg.flush) ? { unflushed: pg.flush } : {};
      if (m.flush === true && (pg.flush === 'refetch' || pg.flush === 'dry')) {
        fr.flushed = pg.flush;
        if (pg.flush === 'refetch') for (let k = 0; k < (pg.preTap || 0); k++) fr.appended.delete(k);
        progress({ drive: { mode, state: 'flushed', at: 0 } });
      } else if (unflushed.unflushed) progress({ drive: { mode, state: 'running', at: 0, ...unflushed } });
      if (fr.flushed === 'dry' || pg.flush === 'sticky') { // it fetches nothing more: nothing comes
        tab.clock.setTimeout(() => progress({ drive: { mode, state: mode === 'seekhop' ? 'stalled' : 'running', at: 0, ...unflushed } }), 5);
        return;
      }
      if (pg.appends) {
        emit({ t: 'tap-ready', parts: pg.appends.map((p) => ({ blobUrl: mint(p.bytes), mime: p.mime, kind: 'media', sb: 0, seq: fr.seq++ })), duration: fr.duration });
      } else append(r.segs.map((_, k) => k));
      if (pg.evicts) for (let k = 0; k < (pg.preTap || 0); k++) fr.appended.delete(k);
      tab.clock.setTimeout(() => progress({ drive: { mode, state: 'done', at: fr.duration, ...unflushed } }), 5);
    };
    const onCommand = (m) => {
      log.push({ frame: i, m, at: tab.clock.now() });
      for (const h of tab.hooks) h(m, i);
      if (fr.left) return;
      if (m.t === 'drive') tab.clock.clearInterval(fr.trickle);
      if (m.t === 'tap' && m.on === true) {
        if (pg.kind === 'mse' && pg.preTap > 0) emit({ t: 'tap-ready', parts: [{ blobUrl: mint(r.init.bytes), mime: r.mime, kind: 'init', sb: 0, seq: fr.seq++ }], duration: Number.isFinite(fr.duration) ? fr.duration : null });
        const reqs = [];
        if (pg.list) reqs.push({ url: r.list, method: 'GET', range: null, size: null, media: false, past: true });
        if (pg.segUrls) { reqs.push({ url: r.init.url, method: 'GET', range: null, size: null, media: true, past: true }); for (let k = 0; k < (pg.preTap || 0); k++) reqs.push({ url: r.segs[k].url, method: 'GET', range: null, size: null, media: true, past: true }); }
        for (const u of pg.fetched || []) reqs.push({ url: u, method: 'GET', range: null, size: null, media: true, past: true });
        if (pg.src) reqs.push({ url: pg.src, method: 'GET', range: null, size: null, media: true, past: true });
        for (let k = 0; k < reqs.length; k += 16) emit({ t: 'tap-urls', reqs: reqs.slice(k, k + 16) });
        progress();
        for (const reason of pg.errors || []) emit({ t: 'tap-error', reason, detail: `fake ${reason}` });
        if (pg.duration === Infinity) tab.clock.setTimeout(() => emit({ t: 'tap-error', reason: 'live', detail: 'the player reports no end' }), pg.liveAfter ?? 30);
        if (pg.kind === 'mse' && pg.playing) {
          if (pg.preTap === 0 || pg.preTap == null) emit({ t: 'tap-ready', parts: [{ blobUrl: mint(r.init.bytes), mime: r.mime, kind: 'init', sb: 0, seq: fr.seq++ }], duration: fr.duration });
          append(Array.from({ length: pg.playing }, (_, k) => (pg.preTap || 0) + k));
        }
        const o = pg.other;
        if (o) {
          const bytes = [o.rendition.init.bytes, ...o.rendition.segs.slice(0, o.n).map((x) => x.bytes)];
          emit({ t: 'tap-ready', parts: bytes.map((b, k) => ({ blobUrl: mint(b), mime: o.rendition.mime, kind: k ? 'media' : 'init', sb: o.sb, seq: fr.seq++ })), duration: Number.isFinite(fr.duration) ? fr.duration : null });
        }
      } else if (m.t === 'readTralbum') {
        const t = pg.tralbum;
        if (!t) emit({ t: 'tap-error', reason: 'none', detail: 'no stream link on the page' });
        else if (!net.has(t.url)) emit({ t: 'tap-error', reason: 'fetch', detail: 'the stream link: HTTP 404' });
        else emit({ t: 'tap-ready', parts: [{ blobUrl: mint(net.get(t.url)), mime: 'audio/mpeg', kind: 'file', sb: -1, seq: 0 }], duration: t.duration ?? null });
      } else if (m.t === 'fetch') {
        m.urls.forEach((u, seq) => setImmediate(() => {
          if (pg.pageFetch !== false && net.has(u)) emit({ t: 'tap-ready', parts: [{ blobUrl: mint(net.get(u), (pg.types || {})[u]), mime: '', kind: 'media', sb: -1, seq }], duration: null });
          else emit({ t: 'tap-error', reason: 'fetch', detail: `#${seq}: network error`, seq });
        }));
      } else if (m.t === 'drive' && m.mode !== 'stop') drive(m.mode, m);
    };
    fr.port = { onCommand, postMessage: (m) => onCommand(structuredClone(m)), disconnect: () => { fr.disconnected = true; } };
    fr.emit = emit; fr.progress = progress; fr.append = append; fr.pg = pg;
    fr.hang = () => { fr.hung = true; }; // its agent says nothing more (the page's player hung)
    tab.frames.push(fr);
  }
  /** What deck.attachAgent does for a loading deck: register the frame's agent and tell the loader. */
  tab.connect = (deck) => {
    tab.deck = deck;
    if (page.kind === 'none') return;
    for (const fr of tab.frames) {
      if (fr.a || fr.left) continue;
      fr.a = { port: fr.port, status: { t: 'status', hasMedia: true, playing: true, rate: 1, audible: 1, muted: false, volume: 1, count: 1, seq: -1, ...fr.pg.status } };
      deck.agents.set(fr.id, fr.a);
      if (deck.loader) deck.loader.onAttach(fr.id, fr.a);
    }
  };
  /**
   * The page navigates away: its agents' ports drop and the blob URLs it minted die. to: the page the tab shows now,
   * which the hub tells the engine (META) metaAfter ms later (0: as the agents go); a reload stays on the same page.
   */
  tab.navigate = ({ to = null, metaAfter = 0 } = {}) => {
    blobs.clear();
    for (const fr of tab.frames) {
      fr.left = true;
      const d = tab.deck;
      if (d && d.agents.get(fr.id) === fr.a) { d.agents.delete(fr.id); if (d.loader) d.loader.onDetach(fr.id, fr.a); }
    }
    const meta = () => { if (tab.deck) Object.assign(tab.deck.meta, { url: to, title: 'Another page' }); };
    if (to) { if (metaAfter) tab.clock.setTimeout(meta, metaAfter); else meta(); }
  };
  /**
   * A single-page site moves on to another track in place (history.pushState): the address changes, which the hub
   * tells the engine (META) at once (a real page's pieces take far longer than that word), but the page and its agents
   * stay. Its player plays the other track from then on: its length is `duration` (when given), a drive appends
   * nothing more of the first, and appendAfter ms later it appends `rendition` (init and every piece) on a SourceBuffer
   * of its own, which the tap says feeds it now.
   */
  tab.moveInPlace = ({ to, rendition: r2 = null, duration, appendAfter = 10 } = {}) => {
    if (tab.deck) Object.assign(tab.deck.meta, { url: to, title: 'Another track' });
    for (const fr of tab.frames) {
      if (fr.left) continue;
      if (fr.pg.rendition) fr.pg.rendition.segs.forEach((_, k) => fr.appended.add(k));
      if (duration !== undefined) fr.duration = duration;
      if (r2) {
        tab.clock.setTimeout(() => {
          fr.progress({ sbs: [1], mimes: [r2.mime] });
          fr.emit({ t: 'tap-ready', parts: [r2.init, ...r2.segs].map((x, k) => ({ blobUrl: mint(x.bytes), mime: r2.mime, kind: k ? 'media' : 'init', sb: 1, seq: fr.seq++ })), duration: fr.duration });
        }, appendAfter);
      }
    }
  };
  /**
   * The tab is closed: its page goes as on a navigation, its capture ends endAfter ms later (null: not yet), and the
   * hub's EJECT for it reaches the engine ejectAfter ms later (null: never).
   */
  tab.close = (engine, { endAfter = 0, ejectAfter = 20 } = {}) => {
    tab.navigate();
    if (endAfter != null) tab.clock.setTimeout(() => { if (tab.deck) for (const t of tab.deck.tracks) t.stop(); }, endAfter);
    if (ejectAfter != null) tab.clock.setTimeout(() => engine.hubEject(tab.tabId), ejectAfter);
  };
  tab.sent = (frame = 0) => log.filter((x) => x.frame === frame).map((x) => x.m);
  tab.kinds = () => log.map((x) => (x.m.t === 'drive' ? `drive ${x.m.mode}` : x.m.t === 'tap' ? `tap ${x.m.on ? 'on' : 'off'}` : x.m.t));
  return tab;
}

export function makeDeck(tab, { id = 1, slot = 1, title = 'Model track' } = {}) {
  const tracks = [{ readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } }];
  const deck = {
    id, slot, tabId: tab.tabId, kind: 'loading', meta: { url: tab.url, title }, agents: new Map(), loader: null, loads: [],
    stream: { getTracks: () => tracks, getAudioTracks: () => tracks }, tracks,
    load: { state: 'loading', progress: 0, strategy: null, error: null, report: null },
    setLoad(o) {
      const keep = (v, old) => (v === undefined ? old : v), l = this.load;
      this.load = { state: keep(o.state, l.state), progress: keep(o.progress, l.progress), strategy: keep(o.strategy, l.strategy), error: keep(o.error, l.error), report: keep(o.report, l.report) };
      this.loads.push({ ...this.load });
    },
  };
  return deck;
}

/**
 * A fake engine: the I1 entry points, the hub (AGENT_CONNECT connects the tab), events. Its eject has the real one's
 * shape: the load is stopped and the tab's STOP_TAB started at once, and the deck goes in its turn on serial().
 * clock: the virtual clock its loads and its tabs' delays run on (default: its first tab's).
 */
export function makeEngine({ tabs = [], limitMin = 15, hubOk = true, clock = (tabs[0] && tabs[0].clock) || new VirtualClock() } = {}) {
  let q = Promise.resolve();
  for (const t of tabs) t.clock = clock;
  const stops = new WeakMap(); // deck -> its STOP_TAB, sent once (the real engine's tabStops)
  const e = {
    clock, ctx: { sampleRate: SR }, params: { 'resident.limitMin': limitMin, 'bpm.range': 'AUTO' }, decks: new Map(), loads: new Map(),
    hubLog: [], events: [], notes: [], calls: [], order: [], leaving: new WeakSet(),
    serial(fn) { const run = q.then(fn, fn); q = run.catch(() => {}); return run; },
    hub(m) {
      e.hubLog.push(structuredClone(m)); e.order.push(m.type);
      if (m.type === 'AGENT_CONNECT') {
        const tab = tabs.find((t) => t.tabId === m.tabId);
        setImmediate(() => { if (tab && tab.deck) tab.connect(tab.deck); });
        return Promise.resolve(hubOk ? { ok: true } : { ok: false, error: 'Player assist is unavailable on this page: nope' });
      }
      return Promise.resolve({ ok: true });
    },
    stopTab(d, o = {}) {
      if (d.tabId == null) return Promise.resolve();
      if (!stops.has(d)) {
        e.hubLog.push({ type: 'STOP_TAB', tabId: d.tabId, ...o }); e.order.push('STOP_TAB');
        stops.set(d, turn().then(() => { e.order.push('STOP_TAB done'); }));
      }
      return stops.get(d);
    },
    tabDecks() { return [...e.decks.values()].filter((d) => d.tabId != null).map((d) => ({ tabId: d.tabId, slot: d.slot })); },
    async analyse(pcm, signal) {
      e.calls.push({ fn: 'analyse', frames: pcm.L.length });
      await turn();
      if (signal && signal.aborted) throw new Error('Track analysis cancelled');
      return { bpm: 124, conf: 0.9, octConf: 1, segments: [], bar1: null, residuals: { median: 1, max: 2 }, wave: null };
    },
    async startResidentDeck({ deckId, pcm, analysis, meta = {}, ...rest }) {
      e.calls.push({ fn: 'startResidentDeck', deckId, frames: pcm.L.length, code: pcm.L[0], analysis: !!analysis, rest });
      const d = e.decks.get(deckId);
      if (!d || e.leaving.has(d)) return { ok: false, error: 'That deck is gone.' };
      await turn();
      Object.assign(d.meta, meta);
      d.kind = 'resident'; d.duration = pcm.L.length / pcm.sampleRate;
      structuredClone([pcm.L, pcm.R], { transfer: [...new Set([pcm.L.buffer, pcm.R.buffer])] }); // the deck takes the arrays, as the real one does
      d.setLoad({ state: 'ready', progress: 1, strategy: null, error: null });
      if (e.decks.get(deckId) !== d || e.leaving.has(d)) return { ok: false, error: 'That deck is gone.' }; // ejected meanwhile
      e.events.push({ level: 'info', text: `Loaded “${d.meta.title}” on deck ${d.slot}.` });
      return { ok: true, deckId, slot: d.slot };
    },
    async failLoadingToLive(deckId, reason) {
      e.calls.push({ fn: 'failLoadingToLive', deckId, reason });
      const d = e.decks.get(deckId);
      if (!d || e.leaving.has(d)) return { ok: false, error: 'That deck is gone.' };
      const l = e.loads.get(deckId); if (l) { e.loads.delete(deckId); l.abort(); }
      d.kind = 'live';
      d.setLoad({ state: 'ready', progress: 1, strategy: null, error: null });
      if (reason) e.events.push({ level: 'warn', text: `Deck ${d.slot}: ${reason}` });
      return { ok: true, deckId, slot: d.slot };
    },
    eject(id) {
      e.calls.push({ fn: 'eject', deckId: id });
      const l = e.loads.get(id); if (l) { e.loads.delete(id); l.abort(); }
      const d0 = e.decks.get(id);
      if (d0) { e.leaving.add(d0); e.stopTab(d0); }
      return e.serial(async () => {
        const d = e.decks.get(id);
        if (!d) return;
        e.decks.delete(id);
        e.hubLog.push({ type: 'DECKS_CHANGED', decks: e.tabDecks(), eject: true }); e.order.push('DECKS_CHANGED');
        await e.stopTab(d);
      });
    },
    /**
     * The hub's EJECT for a closed tab, as the real engine takes it: a deck holding its whole track (resident, or its
     * load with every byte in hand) stays; a deck still loading from it says so, once.
     */
    hubEject(tabId) {
      const d = [...e.decks.values()].find((x) => x.tabId === tabId);
      if (!d) return Promise.resolve();
      if (d.kind === 'resident' || (d.kind === 'loading' && d.loader && d.loader.tabClosed())) return Promise.resolve();
      if (d.kind === 'loading' && e.loads.has(d.id)) e.events.push({ level: 'error', text: `Deck ${d.slot}: the tab was closed before the track was in.` });
      return e.eject(d.id);
    },
    event(level, text) { e.events.push({ level, text }); },
    notify(level, text) { e.notes.push({ level, text }); },
  };
  return e;
}

export const FAST = { grace: 40, settle: 15, duration: 400, idle: 60, start: 500, file: 400, fetchEach: 200, stall: 60, drive: 1500, drivePerSec: 0, check: 5, away: 80 };

/** Stand-ins for the browser-only decoders. */
export const decoders = {
  async decodeFile(ctx, buf) {
    await turn();
    let o;
    try { o = JSON.parse(new TextDecoder().decode(buf)); } catch (_) {
      const w = mp3Frames(buf); // an MP3 frame stream decodes to as long as its frames
      if (!w.frames || w.midJunk) throw new Error('Unable to decode audio data');
      o = { audio: 'mp3', seconds: w.samples / w.sampleRate };
    }
    if (!o || typeof o.seconds !== 'number') throw new Error('Unable to decode audio data');
    const L = new Float32Array(Math.round(o.seconds * ctx.sampleRate)).fill(code(o.audio));
    return { L, R: L.slice(), sampleRate: ctx.sampleRate };
  },
  async decodePlaced(ctx, placed, { duration } = {}) {
    await turn();
    if (!(duration > 0) || !Number.isFinite(duration)) throw new AssemblyError('The track length is not known yet.', { reason: 'duration' });
    const gaps = gapsFor(placed, duration);
    if (gaps.length) throw new AssemblyError(`Audio is missing at ${gaps.map(([a, b]) => `${a}–${b}`).join(', ')}.`, { gaps });
    const L = new Float32Array(Math.round((placed.coverage.at(-1)[1] - (placed.runs.at(-1).delay || 0)) * ctx.sampleRate)).fill(code(placed.runs[0].segs[0].bytes.byteLength));
    return { L, R: L.slice(), sampleRate: ctx.sampleRate };
  },
};

/**
 * fetchBytes as the offscreen engine has it (decode.js fetchArrayBuffer): page blob: URLs (dead once the page goes; one
 * typed by page.types read by the real fetchArrayBuffer, from a real blob of that type), and the open web with its
 * limits: a link in page.hang never answers and is given up after the stall (on the tabs' clock), and one larger than
 * the budget it is given is refused.
 */
export function fetcher(tabs) {
  return async (u, { signal, stall = FETCH_STALL, budget = null } = {}) => {
    await turn();
    if (signal && signal.aborted) throw new Error('The operation was aborted.');
    for (const t of tabs) {
      if (!t.blobs.has(u)) continue;
      if (!t.types.has(u)) return t.blobs.get(u).slice(0);
      const real = URL.createObjectURL(new Blob([t.blobs.get(u)], { type: t.types.get(u) }));
      try { return await fetchArrayBuffer(real, { signal }); } finally { URL.revokeObjectURL(real); }
    }
    if (!u.startsWith('blob:')) {
      const hung = tabs.find((t) => (t.page.hang || []).includes(u));
      if (hung) {
        return new Promise((resolve, reject) => {
          const timer = hung.clock.setTimeout(() => reject(new FetchRefused('stall', `nothing came from the link for ${+(stall / 1000).toFixed(1)} s`)), stall);
          if (signal) signal.addEventListener('abort', () => { hung.clock.clearTimeout(timer); reject(new Error('The operation was aborted.')); }, { once: true });
        });
      }
      for (const t of tabs) {
        if (t.page.extensionFetch === false || !t.net.has(u)) continue;
        const b = t.net.get(u);
        if (budget && b.byteLength > budget.left) throw new FetchRefused('big', `it holds ${(b.byteLength / 2 ** 20).toFixed(1)} MB, more than the ${+(budget.left / 2 ** 20).toFixed(1)} MB a deck takes`);
        if (budget) budget.left -= b.byteLength;
        return b.slice(0);
      }
    }
    throw new Error(u.startsWith('blob:') ? 'Failed to fetch' : 'it answered 404');
  };
}

/** A loading deck for `tab` on `engine` with its Loader, as Engine.loadTab builds it. */
export function loaderFor(tab, engine, { deckId = 1, slot = 1, fetchBytes, times = FAST, deps = {} } = {}) {
  const deck = makeDeck(tab, { id: deckId, slot });
  tab.deck = deck;
  engine.decks.set(deck.id, deck);
  const ac = new AbortController();
  const loader = new Loader({ engine, deck, tabId: tab.tabId, signal: ac.signal, deps: { fetchBytes: fetchBytes || fetcher([tab]), ...decoders, times, clock: engine.clock, ...deps } });
  engine.loads.set(deck.id, { abort: () => ac.abort(), loader });
  deck.loader = loader;
  return { deck, loader, ac };
}

/** Load `page` in one fake tab to the end. */
export async function load(page = {}, opts = {}) {
  const tab = makeTab(page), engine = makeEngine({ tabs: [tab], limitMin: opts.limitMin, hubOk: opts.hubOk });
  const { deck, loader, ac } = loaderFor(tab, engine, opts);
  if (opts.before) opts.before({ tab, engine, deck, loader, ac, clock: engine.clock });
  const result = await loader.run();
  await settle();
  return { result, tab, engine, deck, loader, ac };
}
