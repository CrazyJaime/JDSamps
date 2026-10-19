// engine/engine.js — the offscreen audio engine. Owns the AudioContext, decks, master, clock,
// mix recorder, the UI ports ('jds-ui') and agent ports ('jds-agent'). The service worker
// talks to it with runtime messages {target:'engine'}.
import SignalsmithStretch from '../vendor/signalsmith-stretch/SignalsmithStretch.mjs';
import {
  PORT_UI, PORT_AGENT, MAX_DECKS, TARGET, HUB, ENGINE, DECK_PARAMS, MASTER_PARAMS, BPM_RANGES,
  PERSISTED_MASTER_KEYS, defaults, validateUiMessage, validateValue,
} from '../shared/protocol.js';
import { createMaster } from './master.js';
import { Recorder } from './recorder.js';
import { MasterClock } from './sync.js';
import { Deck } from './deck.js';
import { fetchArrayBuffer, decodeTo, resample, limitPcm, wavFrames, mediaDuration, minutes, FetchRefused } from './decode.js';
import { analyseTrack, applyAnalysis } from './analysis.js';
import { decodePlaced } from './assemble.js';
import { Loader, Recording, DirectReport, framesOf } from './loader.js';

const STRETCH_URL = new URL('../vendor/signalsmith-stretch/SignalsmithStretch.js', import.meta.url).href;
SignalsmithStretch.moduleUrl = STRETCH_URL;
const workletUrl = (f) => new URL(`../worklets/${f}`, import.meta.url).href;
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const HIDDEN_STATE_SEC = 0.5; // state period for a UI page that is hidden (no waveform at all)
const TICK_FRAMES = 1536;     // the master worklet's meter (tick) period
// An eject waits at most this long for its tab to stop playing. The hub bounds its own work (pause
// for 250 ms, else mute), so this only guards against a hub that never answers; on a busy machine
// a tighter limit would release the capture while the tab is still playing.
const STOP_TAB_MS = 2500;
const INSTANCE = crypto.randomUUID(); // snapshot.engineId: the UI restores its settings into each new engine
const NOTE_TTL = 60000; // a hub notice raised with no deck page open waits this long for one
/** A track's name from its file name or link: no folders, no extension. */
const trackTitle = (name) => String(name).split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();

// Trust: the relay content script runs in every frame of every site, so any renderer can speak
// as it. Only extension contexts (the service worker, the deck page) may command the engine.
const EXT = chrome.runtime.getURL('');
const DECK_URL = chrome.runtime.getURL('deck.html');
const isExtUrl = (u) => typeof u === 'string' && u.startsWith(EXT);
const fromExtension = (s) => !!s && s.id === chrome.runtime.id && isExtUrl(s.url);
/** 'jds-ui': an extension page, either tabless or in the deck tab. */
const uiSender = (s) => fromExtension(s) && (!s.tab || (s.tab.url || '').split(/[?#]/)[0] === DECK_URL);
/** 'jds-agent': our content script in a web page's frame. */
const agentSender = (s) => !!s && s.id === chrome.runtime.id && !!s.tab && typeof s.url === 'string' && !isExtUrl(s.url);

class Engine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.params = defaults(MASTER_PARAMS);
    this.decks = new Map();
    this.loads = new Map(); // deck id → its load in progress ({abort()}): loadCancel and eject stop it
    this.tabStops = new WeakMap(); // deck → its STOP_TAB (sent once)
    this.leaving = new WeakSet(); // decks an eject has been asked for: it takes them in their turn on serial()
    this.nextId = 1;
    this.clock = new MasterClock();
    this.ui = new Set();
    // UI port -> {hidden, nextState, waves: Map(deck id -> input time its waveform was sent up to)}.
    // Set by the port's hello: only then does it join the state and waveform stream.
    this.uiStream = new WeakMap();
    this.idleMs = 30000; // no decks, no UI and no mix recording for this long: the AudioContext is suspended
    this.idleSince = null;
    this.holds = new Set(); // 'deckId|key': kills/FX held down in the UI (set with hold:true)
    this.notes = []; // hub notices waiting for a deck page
    this.serialQ = Promise.resolve();
    this.heavyQ = Promise.resolve(); // decoding and analysing whole tracks, one at a time (heavy()): its last turn
    this.heavyN = 0;                 // and how many turns are running or waiting
    this.downloads = new Map();
    this.downloadsSettled = new Set(); // blob URLs already reported: the hub may send DOWNLOAD_DONE twice
    this.clipUntil = { L: 0, R: 0 };
    this.mm = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, gr: 0 };
    this.nextPhase = 0;
    this.ready = this.boot();
    this.listen();
  }

  async boot() {
    for (const f of ['deck-input.js', 'beatfx.js', 'recorder.js', 'master.js']) await this.ctx.audioWorklet.addModule(workletUrl(f));
    await this.ctx.audioWorklet.addModule(STRETCH_URL);
    this.silentSink = this.ctx.createGain();
    this.silentSink.gain.value = 0;
    this.silentSink.connect(this.ctx.destination);
    this.master = createMaster(this.ctx);
    this.master.setVolume(this.params['master.volume']);
    this.master.setLimiter(this.params['master.limiter']);
    this.master.setCrossfader(this.params['xfader.pos'], this.params['xfader.curve']);
    this.mixRec = new Recorder(this.ctx, this.master.out, {
      format: this.params['rec.format'], who: 'mix', title: () => 'Master', sink: this.silentSink,
      deliver: (b, f) => this.deliver(b, f), onChange: () => {}, onError: (m) => this.event('error', m),
    });
    this.master.onMeter((m) => this.tick(m));
  }

  createStretch() {
    return withTimeout(
      SignalsmithStretch(this.ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }),
      6000, 'The time-stretcher failed to start',
    );
  }

  wallNow() { return performance.timeOrigin + performance.now(); }

  /** Context time whose audio is being heard now (and the wall clock at that moment). */
  outputStamp() {
    const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return { ctxTime: ts.contextTime, wallMs: performance.timeOrigin + ts.performanceTime };
    return { ctxTime: this.ctx.currentTime - (this.ctx.outputLatency || 0), wallMs: this.wallNow() };
  }
  heardTime() { return this.outputStamp().ctxTime; }
  ctxTimeAtWall(wallMs) { const s = this.outputStamp(); return s.ctxTime + (wallMs - s.wallMs) / 1000; }

  serial(fn) {
    const run = this.serialQ.then(fn, fn);
    this.serialQ = run.catch(() => {});
    return run;
  }

  /**
   * Decoding a whole track, or analysing one, in turn: tracks loaded together (files dropped at once, tabs) never
   * stack their memory peaks. With none waiting, fn starts at once. A load stopped while it waits (signal aborted)
   * is not run. fn never waits on heavy().
   */
  heavy(fn, signal) {
    const go = () => {
      if (signal && signal.aborted) throw new Error('The load was stopped.');
      return fn();
    };
    const run = this.heavyN++ ? this.heavyQ.then(go) : (async () => go())(), done = () => { this.heavyN--; };
    this.heavyQ = run.then(done, done);
    return run;
  }

  /** The deck bound to a tab. A deck with no tab (a file, a link) is no tab's. */
  deckByTab(tabId) { if (tabId == null) return null; for (const d of this.decks.values()) if (d.tabId === tabId) return d; return null; }

  // ------------------------------------------------------------------ messaging
  listen() {
    chrome.runtime.onConnect.addListener((port) => {
      const refuse = () => { try { port.disconnect(); } catch (_) {} };
      if (port.name === PORT_UI) {
        if (!uiSender(port.sender)) { refuse(); return; }
        this.ui.add(port);
        port.onMessage.addListener((m) => { this.onUi(port, m); });
        port.onDisconnect.addListener(() => { void chrome.runtime.lastError; this.ui.delete(port); if (!this.ui.size) this.releaseHolds(); });
      } else if (port.name === PORT_AGENT) {
        const d = agentSender(port.sender) ? this.deckByTab(port.sender.tab.id) : null;
        if (!d) { refuse(); return; }
        d.attachAgent(port, port.sender.frameId || 0);
      }
    });
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.target !== TARGET.ENGINE) return false;
      if (!fromExtension(sender)) { sendResponse({ ok: false, error: 'forbidden' }); return false; }
      this.onHub(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
      return true;
    });
  }

  post(port, msg) { try { port.postMessage(msg); } catch (_) { this.ui.delete(port); } }
  broadcast(msg) { for (const p of this.ui) this.post(p, msg); }
  event(level, text, deck) { this.broadcast({ t: 'event', level, text, deck }); }
  hub(msg) { return chrome.runtime.sendMessage({ target: TARGET.HUB, ...msg }).catch(() => null); }

  async onUi(port, m) {
    await this.ready;
    const v = validateUiMessage(m);
    const reply = (ok, error) => { if (m && m.id) this.post(port, { t: 'reply', id: m.id, ok, error }); };
    if (!v.ok) { reply(false, v.error); return; }
    if (m.t === 'hello') {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const u = { hidden: false, nextState: 0, waves: new Map() };
      this.uiStream.set(port, u);
      this.post(port, this.stateMsg(this.ctx.currentTime));
      this.sendWaves(port, u);
      this.flushNotes(port);
      return;
    }
    if (m.t === 'vis') { this.setHidden(port, m.hidden); return; }
    if (m.t === 'set') {
      if (m.deck === null) this.setMasterParam(m.key, v.value);
      else { const d = this.decks.get(m.deck); if (d) { d.setParam(m.key, v.value); this.noteHold(m, v.value); } else { reply(false, 'That deck is gone.'); return; } }
      reply(true);
      return;
    }
    let r;
    if (m.deck === null) r = await this.masterAct(m.a, v.arg);
    else { const d = this.decks.get(m.deck); r = d ? await d.act(m.a, v.arg) : { ok: false, error: 'That deck is gone.' }; }
    reply(r.ok, r.error);
  }

  /** A kill/FX pad held down is sent with hold:true; the next set of that key (release or latch) clears it. */
  noteHold(m, value) {
    const k = `${m.deck}|${m.key}`;
    if (m.hold === true && value === true) this.holds.add(k); else this.holds.delete(k);
  }

  /** The last deck page went away (reload, close) mid-press: let go of everything held. */
  releaseHolds() {
    for (const k of this.holds) {
      const [id, key] = k.split('|'), d = this.decks.get(Number(id));
      if (d) d.setParam(key, false);
    }
    this.holds.clear();
    for (const d of this.decks.values()) d.releaseHolds().catch(() => {});
  }

  setMasterParam(k, v) {
    this.params[k] = v;
    switch (k) {
      case 'master.volume': this.master.setVolume(v); break;
      case 'master.limiter': this.master.setLimiter(v); break;
      case 'xfader.pos': case 'xfader.curve': this.master.setCrossfader(this.params['xfader.pos'], this.params['xfader.curve']); break;
      case 'bpm.range': {
        const [lo, hi] = BPM_RANGES[v];
        for (const d of this.decks.values()) d.setRange(lo, hi);
        break;
      }
      case 'buffer.capSec': for (const d of this.decks.values()) if (d.ts) d.ts.capSec = v; break;
      default: break;
    }
  }

  async masterAct(a, arg) {
    switch (a) {
      case 'mixRecStart':
        try { this.mixRec.start(this.params['rec.format']); return { ok: true }; } catch (err) { return { ok: false, error: `Could not start the mix recording: ${err.message}` }; }
      case 'mixRecStop': this.mixRec.stop(); return { ok: true };
      case 'clipReset':
        this.clipUntil = { L: 0, R: 0 };
        for (const d of this.decks.values()) d.meter.clipUntil = 0;
        return { ok: true };
      case 'stopAll':
        this.mixRec.stop();
        for (const id of [...this.decks.keys()]) this.eject(id);
        return { ok: true };
      case 'loadFile': return this.loadFile(arg);
      case 'loadUrl': return this.loadUrl(arg);
      default: return { ok: false, error: `Unknown action ${a}` };
    }
  }

  async onHub(msg) {
    await this.ready;
    switch (msg.type) {
      case ENGINE.START: return this.startTab(msg);
      case ENGINE.EJECT: {
        const d = this.deckByTab(msg.tabId);
        if (!d) return { ok: true };
        // The tab was closed. A deck holding its whole track needs it no more: one resident (letting go of the tab), or
        // one whose load has every byte in hand (it goes on, and lets go of the tab once resident).
        if (d.kind === 'resident' || (d.kind === 'loading' && d.loader && d.loader.tabClosed())) return { ok: true };
        // Else a deck still loading from it goes, said once here (its load ends cancelled, quietly).
        if (d.kind === 'loading' && this.loads.has(d.id)) this.event('error', `Deck ${d.slot}: the tab was closed before the track was in.`, d.id);
        await this.eject(d.id, msg.reason);
        return { ok: true };
      }
      case ENGINE.META: {
        const d = this.deckByTab(msg.tabId);
        // A load waits on no page that moved on. A resident deck letting go of its tab is not renamed by the next page.
        if (d && d.kind !== 'resident') { Object.assign(d.meta, msg.meta || {}); if (d.loader) d.loader.poke(); }
        return { ok: true };
      }
      case ENGINE.PING: return { ok: true, decks: [...this.decks.values()].map((d) => ({ tabId: d.tabId, slot: d.slot })) };
      case ENGINE.DOWNLOAD_DONE: {
        if (this.downloadsSettled.has(msg.url)) return { ok: true };
        this.downloadsSettled.add(msg.url);
        const t = this.downloads.get(msg.url);
        if (t) { clearTimeout(t.timer); this.downloads.delete(msg.url); URL.revokeObjectURL(msg.url); }
        if (msg.ok) this.event('info', `Saved ${t ? t.filename : 'recording'}.`);
        else this.event('error', `Saving ${t ? t.filename : 'the recording'} failed: ${msg.error || 'download interrupted'}.`);
        return { ok: true };
      }
      case ENGINE.NOTIFY: this.notify(msg.level === 'error' || msg.level === 'warn' ? msg.level : 'info', String(msg.text || '').slice(0, 300)); return { ok: true };
      default: return { ok: false, error: `Unknown engine message ${msg.type}` };
    }
  }

  /** A hub notice (a capture error from the toolbar) waits for the deck page when none is connected. */
  notify(level, text) {
    if (this.ui.size) { this.event(level, text); return; }
    this.notes.push({ level, text, at: Date.now() });
    if (this.notes.length > 5) this.notes.shift();
  }
  flushNotes(port) {
    const notes = this.notes;
    this.notes = [];
    for (const n of notes) if (Date.now() - n.at < NOTE_TTL) this.post(port, { t: 'event', level: n.level, text: n.text });
  }

  /** The DJ's saved settings, from the hub's first START: a new engine takes them before its first deck. */
  applySaved(saved) {
    if (this.savedApplied || !saved || typeof saved !== 'object') return;
    this.savedApplied = true; // once per engine; afterwards the deck page owns these settings
    for (const k of PERSISTED_MASTER_KEYS) {
      const v = k in saved ? validateValue(MASTER_PARAMS[k], saved[k]) : null;
      if (v && v.ok && v.value !== this.params[k]) this.setMasterParam(k, v.value);
    }
  }

  // ------------------------------------------------------------------ decks
  async startDeck(tabId, streamId, meta) {
    const no = await this.readyForDeck(tabId);
    if (no) return { ok: false, error: no };
    let stream;
    try {
      stream = await this.tabStream(streamId);
    } catch (err) {
      return { ok: false, error: `Chrome would not share that tab's audio: ${err.message}` };
    }
    const deck = this.newDeck({ tabId, stream, meta });
    try {
      await deck.init();
    } catch (err) {
      return this.notStarted(deck, err);
    }
    this.addDeck(deck);
    this.hub({ type: HUB.AGENT_CONNECT, tabId });
    this.event('info', `Loaded “${meta.title || 'tab'}” on deck ${deck.slot}. It is cued: press PLAY when you're ready.`, deck.id);
    return { ok: true, deckId: deck.id, slot: deck.slot };
  }

  /**
   * A tab from the hub: by default a loading deck whose Loader goes for the whole track (outside serial(), so
   * other decks never queue behind it), falling back to live; mode 'live' or resident.auto off: a live deck.
   */
  async startTab(msg) {
    const meta = msg.meta || {};
    let resident = false;
    const r = await this.serial(() => {
      this.applySaved(msg.settings);
      resident = msg.mode !== 'live' && this.params['resident.auto'] !== false;
      return resident ? this.startLoadingDeck({ tabId: msg.tabId, streamId: msg.streamId, meta }) : this.startDeck(msg.tabId, msg.streamId, meta);
    });
    if (r.ok && resident) this.loadTab(this.decks.get(r.deckId));
    return r;
  }

  /** Run a loading tab deck's Loader. Its agents' tap messages reach it through deck.loader while it runs. */
  loadTab(deck) {
    const ac = new AbortController(), turn = (fn) => (...a) => this.heavy(() => fn(...a), ac.signal);
    const loader = new Loader({ engine: this, deck, tabId: deck.tabId, signal: ac.signal, deps: { decodeFile: turn(decodeTo), decodePlaced: turn(decodePlaced) } });
    const load = { abort: () => ac.abort(), loader };
    this.loads.set(deck.id, load);
    deck.loader = loader;
    return loader.run().then((r) => {
      if (this.loads.get(deck.id) === load) this.loads.delete(deck.id);
      if (deck.loader === loader) deck.loader = null;
      if (r.ok && r.kind === 'live' && r.noBytes && this.params['resident.recordWhole']) this.recordUnread(deck);
      return r;
    });
  }

  /**
   * Settings → Record whole track at 2× when bytes are unavailable (§11): a tab deck that went live because its page's
   * bytes cannot be had is recorded without asking, or says why it cannot be.
   */
  async recordUnread(live) {
    const r = await this.recordWhole(live.id);
    if (this.decks.get(live.id) !== live) return;
    if (r.ok) this.event('info', `Deck ${live.slot}: recording its whole track from the page at 2× (reduced highs), as the settings ask.`, live.id);
    else this.event('info', `Deck ${live.slot}: its whole track is not recorded at 2×. ${r.error}`, live.id);
  }

  /**
   * Record a live tab deck's whole track from the page's sound at 2× (§4.4: opt-in, highs above a quarter of the
   * media's rate lost) onto a new deck, which becomes resident; the live deck is then let go. Answers once the
   * recording has started: the new deck shows its progress.
   */
  async recordWhole(id) {
    const live = this.decks.get(id);
    if (!live) return { ok: false, error: 'That deck is gone.' };
    if (live.kind !== 'live' || live.tabId == null || !live.source) return { ok: false, error: 'Only a deck playing a tab live can record its whole track.' };
    if (live.loader) return { ok: false, error: `Deck ${live.slot} is being recorded already.` };
    if (live.wantPlay) return { ok: false, error: 'Pause the deck first: recording runs its page at 2×.' };
    if (!Recording.agentOf(live)) return { ok: false, error: "This page can't be sped up, so it would record in real time." };
    const meta = { title: `${live.meta.title || 'Tab'} (recorded from the page — reduced highs)`, url: live.meta.url, favIconUrl: live.meta.favIconUrl };
    const r = await this.serial(() => this.startLoadingDeck({ meta }));
    if (!r.ok) return r;
    const deck = this.decks.get(r.deckId), ac = new AbortController();
    const job = new Recording({ engine: this, live, deck, signal: ac.signal }), load = { abort: () => ac.abort(), loader: job };
    this.loads.set(deck.id, load);
    live.loader = job; // the live deck's agents' tap messages go to the recording
    job.run().then(() => {
      if (this.loads.get(deck.id) === load) this.loads.delete(deck.id);
      if (live.loader === job) live.loader = null;
    });
    return { ok: true };
  }

  /** Why no new deck can start now (the tab is on a deck already, or every slot is taken), or null; wakes the context. */
  async readyForDeck(tabId) {
    const existing = this.deckByTab(tabId);
    if (existing) return `That tab is already on deck ${existing.slot}.`;
    if (this.decks.size >= MAX_DECKS) return `All ${MAX_DECKS} decks are in use. Eject one first.`;
    this.idleSince = null;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    return null;
  }

  tabStream(streamId) {
    return navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  }

  /** A deck in the first free slot, with the default deck settings. */
  newDeck({ tabId = null, stream = null, meta = {}, kind }) {
    const used = new Set([...this.decks.values()].map((d) => d.slot));
    let slot = 1; while (used.has(slot)) slot++;
    const params = defaults(DECK_PARAMS);
    params.range = this.params['pitch.defaultRange'];
    return new Deck(this, { id: this.nextId++, slot, tabId, stream, meta, params, kind });
  }

  addDeck(deck) {
    this.decks.set(deck.id, deck);
    this.master.addDeck(deck.id, deck.xfGain, deck.params.xf);
    this.hub({ type: HUB.DECKS_CHANGED, decks: this.tabDecks() });
  }

  /** The decks the hub keeps track of: the ones bound to a tab. */
  tabDecks() { return [...this.decks.values()].filter((d) => d.tabId != null).map((d) => ({ tabId: d.tabId, slot: d.slot })); }

  async notStarted(deck, err) {
    if (deck.stream) for (const t of deck.stream.getTracks()) t.stop();
    await deck.dispose().catch(() => {});
    return { ok: false, error: `The deck could not start: ${err.message}` };
  }

  // ------------------------------------------------------------------ whole tracks (resident decks)
  // startLoadingDeck and startResidentDeck (for a new deck) run under serial(), as startDeck does.

  /**
   * A deck that shows as loading while its track is on the way: its chain is built, nothing plays. It
   * holds a tab's capture (streamId), if given, for a fall-back to live.
   */
  async startLoadingDeck({ tabId = null, streamId = null, meta = {}, token = null } = {}) {
    const no = await this.readyForDeck(tabId);
    if (no) return { ok: false, error: no };
    let stream = null;
    if (streamId) {
      try { stream = await this.tabStream(streamId); } catch (err) { return { ok: false, error: `Chrome would not share that tab's audio: ${err.message}` }; }
    }
    const deck = this.newDeck({ tabId, stream, meta, kind: 'loading' });
    if (token) deck.setLoad({ token }); // in its first snapshot: the deck page knows its load's deck by it
    try {
      await deck.build();
    } catch (err) {
      return this.notStarted(deck, err);
    }
    this.addDeck(deck);
    if (tabId != null) this.hub({ type: HUB.AGENT_CONNECT, tabId });
    return { ok: true, deckId: deck.id, slot: deck.slot };
  }

  /**
   * A deck holding a whole decoded track, pcm {L, R, sampleRate}: a new deck, or the loading deck
   * deckId promoted (a failed promotion leaves it loading, for its loader to decide). Its beat grid
   * comes from gridResident() before it is reported ready: from `analysis` when given (null: none),
   * else from analysing pcm here. The deck takes pcm's arrays (they are transferred to its stretcher),
   * so the caller reads what it needs of them first.
   */
  async startResidentDeck({ deckId = null, tabId = null, pcm, meta = {}, analysis } = {}) {
    if (!pcm || !(pcm.L && pcm.L.length) || !pcm.R || pcm.R.length !== pcm.L.length) return { ok: false, error: 'There is no audio to load.' };
    let deck = null;
    if (deckId != null) {
      deck = this.decks.get(deckId);
      if (!deck || this.leaving.has(deck)) return { ok: false, error: 'That deck is gone.' };
      if (deck.kind !== 'loading' || deck.ts.liveEdge > 0) return { ok: false, error: `Deck ${deck.slot} is not waiting for a track.` };
    } else {
      const no = await this.readyForDeck(tabId);
      if (no) return { ok: false, error: no };
    }
    // The stretcher runs at the context's rate.
    if (pcm.sampleRate !== this.ctx.sampleRate) pcm = await resample(pcm, this.ctx.sampleRate);
    let unfit = null; // analysed before the stretcher takes the track
    if (analysis === undefined) analysis = await this.analyse(pcm).catch((err) => { unfit = err; return null; });
    if (deck) {
      if (this.decks.get(deck.id) !== deck) return { ok: false, error: 'That deck is gone.' };
      Object.assign(deck.meta, meta);
    } else deck = this.newDeck({ tabId, meta });
    try {
      await deck.initResident(pcm);
    } catch (err) {
      if (deckId == null) return this.notStarted(deck, err);
      deck.setLoad({ state: 'error', error: err.message });
      return { ok: false, error: `Deck ${deck.slot} could not take the track: ${err.message}` };
    }
    try {
      if (unfit) throw unfit;
      this.gridResident(deck, analysis);
    } catch (err) {
      this.event('warn', `Deck ${deck.slot}: no beat grid from the whole track (${err.message}). TAP the beat.`, deck.id);
    }
    if (deckId == null) this.addDeck(deck);
    else if (this.decks.get(deck.id) !== deck || this.leaving.has(deck)) return { ok: false, error: 'That deck is gone.' }; // ejected meanwhile: not loaded
    this.event('info', `Loaded “${deck.meta.title || 'track'}” on deck ${deck.slot}. It is cued: press PLAY when you're ready.`, deck.id);
    return { ok: true, deckId: deck.id, slot: deck.slot };
  }

  /**
   * A resident deck's beat grid, tempo and whole waveform, from whole-track analysis (null for none).
   * The automatic cue moves to the first beat, as a live deck's does.
   */
  gridResident(deck, analysis) {
    if (!analysis || deck.disposed) return;
    applyAnalysis(deck, analysis);
    deck.analysis = { bpm: analysis.bpm, conf: analysis.conf, octConf: analysis.octConf, bar1: analysis.bar1, residuals: analysis.residuals };
    const first = deck.firstAudible ?? 0;
    if (deck.canBeat(first)) deck.snapAutoCue(deck.grids.at(first));
    else this.event('info', `Deck ${deck.slot}: no steady beat found in “${deck.meta.title || 'the track'}”. TAP it if it has one.`, deck.id);
  }

  /** Whole-track analysis of pcm in a worker, over the BPM range in force, in its turn (heavy()). Rejects when signal aborts. */
  analyse(pcm, signal) {
    const [lo, hi] = BPM_RANGES[this.params['bpm.range']] || BPM_RANGES.AUTO;
    return this.heavy(() => analyseTrack(pcm, { lo, hi, signal }), signal);
  }

  /** A loading deck holding a tab's capture plays it live after all; the reason is said once. */
  async failLoadingToLive(deckId, reason) {
    const d = this.decks.get(deckId);
    if (!d || this.leaving.has(d)) return { ok: false, error: 'That deck is gone.' };
    if (d.kind !== 'loading') return { ok: false, error: `Deck ${d.slot} is not loading.` };
    if (!d.stream) return { ok: false, error: `Deck ${d.slot} has no tab audio to play live.` };
    this.abortLoad(deckId);
    try {
      await d.initLive();
    } catch (err) {
      this.eject(deckId);
      return { ok: false, error: `The deck could not start: ${err.message}` };
    }
    d.setLoad({ state: 'ready', progress: 1, strategy: null, error: null });
    if (reason) this.event('warn', `Deck ${d.slot}: ${reason}`, d.id);
    return { ok: true, deckId: d.id, slot: d.slot };
  }

  /** A local file, as the deck page's blob: URL for it. */
  loadFile({ name, blobUrl, token }) {
    const title = trackTitle(name) || 'track';
    return this.loadDirect(blobUrl, { title }, { strategy: 'reading the file', failed: `Could not read “${title}”`, token, file: name });
  }

  /** A link to an audio file, fetched here. */
  loadUrl({ url, token }) {
    const u = new URL(url);
    let name = u.pathname;
    try { name = decodeURIComponent(name); } catch (_) {}
    return this.loadDirect(url, { title: trackTitle(name) || u.hostname, url }, { strategy: 'fetching the link', failed: 'Could not fetch that link', token });
  }

  /**
   * Fetch and decode a whole track onto a new deck, which shows as loading meanwhile, with its load report. Settles
   * when the deck is resident ({ok:true}), or with the reason it is not: the deck stays, failed, saying why and offering
   * its report until the DJ dismisses it (a cancel: it is gone).
   */
  async loadDirect(src, meta, { strategy, failed, token, file }) {
    const r = await this.serial(() => this.startLoadingDeck({ meta, token }));
    if (!r.ok) return r;
    const deck = this.decks.get(r.deckId), ac = new AbortController(), load = { abort: () => ac.abort() };
    this.loads.set(deck.id, load);
    const gone = () => ac.signal.aborted || this.decks.get(deck.id) !== deck || this.leaving.has(deck);
    const rep = new DirectReport(file != null ? { file } : { url: src });
    const say = (o) => deck.setLoad({ ...o, report: rep.text(o.strategy) });
    const tick = setInterval(() => { if (gone() || rep.result) clearInterval(tick); else deck.setLoad({ report: rep.text(deck.load.strategy) }); }, 1000);
    const refuse = async (error) => {
      const cancelled = gone();
      if (this.loads.get(deck.id) === load) this.loads.delete(deck.id);
      if (cancelled) return { ok: false, error: 'Loading was cancelled.' };
      rep.result = `failed: ${error}`;
      deck.setLoad({ state: 'error', error, strategy: null, report: rep.text() });
      return { ok: false, error };
    };
    say({ strategy });
    let buf;
    try {
      // A link has a stall deadline and a byte cap, and a stream with no end is refused; a local file is read whole.
      buf = await fetchArrayBuffer(src, { signal: ac.signal, ...(file != null ? { cap: Infinity } : {}) });
    } catch (err) {
      rep.step('fetch', 'failed', err.message);
      if (err instanceof FetchRefused && err.kind === 'page') return refuse(err.message);
      return refuse(`${failed}: ${err.message}`);
    }
    if (gone()) return refuse();
    rep.fetched(buf.byteLength);
    say({ progress: 0.5, strategy: 'decoding' });
    // Longer than the resident limit, an MP3 or ADTS file is cut at the frame a second past it (as a tab's file is),
    // or a WAV file at the sample, and only that part is decoded. A file in any other format cannot be cut short and
    // is decoded whole, so only up to twice the limit: its length is read from its header first.
    const limitMin = this.params['resident.limitMin'], until = limitMin * 60 + 1, w = framesOf(buf, until) || wavFrames(buf, until);
    const own = w ? w.samples / w.sampleRate : 0, cut = own > limitMin * 60 + 0.5 && w.cut ? w.cut : null;
    if (cut) buf = cut.bytes || buf.slice(0, cut.end);
    else if (!w) {
      const length = await mediaDuration(buf);
      if (gone()) return refuse();
      if (length > 2 * limitMin * 60) {
        return refuse(`“${meta.title}” is ${minutes(length / 60)} long, too long to decode whole: the deck holds ${minutes(limitMin)}. As an MP3 or WAV file, its first ${minutes(limitMin)} would load.`);
      }
    }
    let lim;
    try { // decoded and cut in one turn: the whole decoded track is let go of before the next one decodes
      lim = await this.heavy(async () => limitPcm(await decodeTo(this.ctx, buf), limitMin, cut ? own : undefined), ac.signal);
    } catch (_) {
      const error = `“${meta.title}” is not audio this browser can play.`;
      rep.step('decode', 'failed', error);
      return refuse(error);
    }
    buf = null;
    if (gone()) return refuse();
    rep.step('decode', 'ok', `${(lim.pcm.L.length / lim.pcm.sampleRate).toFixed(3)} s${cut ? `, the first part of ${own.toFixed(1)} s` : ''}`);
    rep.limit = lim.notice;
    // Found here rather than in startResidentDeck, so other decks' starts and ejects never queue behind it.
    say({ progress: 0.8, strategy: 'finding the beat' });
    let analysis = null, why = '';
    try {
      analysis = await this.analyse(lim.pcm, ac.signal);
    } catch (err) {
      if (gone()) return refuse();
      why = err.message;
      this.event('warn', `Deck ${deck.slot}: no beat grid from the whole track (${err.message}). TAP the beat.`, deck.id);
    }
    if (gone()) return refuse();
    rep.step('beat', analysis ? 'ok' : 'none', analysis ? (analysis.bpm > 0 ? `${analysis.bpm.toFixed(2)} BPM` : 'no steady beat') : why);
    this.loads.delete(deck.id);
    rep.result = `resident, ${(lim.pcm.L.length / lim.pcm.sampleRate).toFixed(3)} s`;
    deck.setLoad({ report: rep.text() }); // with the promotion: the resident deck never shows without its report
    const res = await this.serial(() => this.startResidentDeck({ deckId: deck.id, pcm: lim.pcm, analysis }));
    if (!res.ok) { rep.result = null; rep.step('deck', 'failed', res.error); return refuse(res.error); }
    if (lim.notice) this.notify('warn', `Deck ${deck.slot}: ${lim.notice}`); // waits for a deck page, if none is open
    return res;
  }

  /** Stop a deck's load in progress, and eject the deck. */
  async loadCancel(id) {
    const d = this.decks.get(id);
    if (!d || d.kind !== 'loading') return { ok: false, error: d ? `Deck ${d.slot} is not loading.` : 'That deck is gone.' };
    this.abortLoad(id);
    await this.eject(id);
    return { ok: true };
  }

  abortLoad(id) {
    const l = this.loads.get(id);
    if (l) { this.loads.delete(id); l.abort(); }
  }

  /** Bytes of decoded audio held by decks that are not live (stereo float32). */
  residentBytes() {
    let n = 0;
    for (const d of this.decks.values()) if (d.kind !== 'live' && d.ts) n += Math.round(d.ts.liveEdge * this.ctx.sampleRate) * 8;
    return n;
  }

  /** Before a deck's capture goes, stop its tab playing (the hub pauses the page's players, or
   *  mutes the tab), so the ejected track does not come out of the speakers. Bounded. release: the
   *  deck went resident and lets go of its tab, which is paused but never left muted. */
  stopTab(d, { release = false } = {}) {
    if (d.tabId == null) return Promise.resolve(); // a deck with no tab has none to stop
    let p = this.tabStops.get(d);
    if (!p) {
      p = withTimeout(this.hub({ type: HUB.STOP_TAB, tabId: d.tabId, ...(release ? { release } : {}) }), STOP_TAB_MS, 'STOP_TAB timed out').then((r) => {
        if (r && r.ok && r.muted) this.event('info', `Deck ${d.slot}: the tab has no pausable player, so it was muted.`);
      }, () => {});
      this.tabStops.set(d, p);
    }
    return p;
  }

  eject(id, reason) {
    this.abortLoad(id);
    // Stopping the tab starts now, ahead of the queue, so STOP ALL stops every tab in parallel.
    const d0 = this.decks.get(id);
    if (d0) { this.leaving.add(d0); this.stopTab(d0); }
    return this.serial(async () => {
      const d = this.decks.get(id);
      if (!d) return;
      this.decks.delete(id);
      this.clock.release(id);
      if (reason) this.event('warn', reason);
      this.hub({ type: HUB.DECKS_CHANGED, decks: this.tabDecks() });
      await this.stopTab(d);
      await d.dispose();
    });
  }

  deliver(blob, filename) {
    const url = URL.createObjectURL(blob);
    const timer = setTimeout(() => { URL.revokeObjectURL(url); this.downloads.delete(url); }, 10 * 60 * 1000);
    this.downloads.set(url, { timer, filename });
    this.hub({ type: HUB.DOWNLOAD, url, filename }).then((r) => {
      if (!r || !r.ok) {
        this.event('error', `Saving ${filename} failed: ${(r && r.error) || 'the browser refused the download'}.`);
        clearTimeout(timer); this.downloads.delete(url); URL.revokeObjectURL(url);
      }
    });
  }

  // ------------------------------------------------------------------ clock + tick
  updateClock(now) {
    const a = this.clock.assigned != null ? this.decks.get(this.clock.assigned) : null;
    this.clock.update(now, a ? a.masterInfo(now) : null);
  }

  tick(m) {
    const now = this.ctx.currentTime;
    this.mm = m;
    if (m.peakL >= 0.999) this.clipUntil.L = now + 2;
    if (m.peakR >= 0.999) this.clipUntil.R = now + 2;
    for (const d of this.decks.values()) d.tick(now);
    this.updateClock(now);
    for (const d of this.decks.values()) d.syncTick(now);
    if (now >= this.nextPhase) { this.nextPhase = now + 0.5; for (const d of this.decks.values()) d.phaseTick(now); }
    // After a main-thread stall the meter ticks queue up and run back to back: a tick whose
    // successor is already waiting sends no state, so only the newest of them builds one.
    if (!(now * this.ctx.sampleRate - m.frame > TICK_FRAMES)) this.broadcastState(now);
    this.idleTick();
  }

  // ------------------------------------------------------------------ UI stream
  // A shown page gets a state every tick and each waveform batch as it arrives; a hidden one
  // ({t:'vis', hidden:true}) a state every HIDDEN_STATE_SEC and no waveform until it is shown again.

  /** A state message, with the decks' meters measured for it (nothing to measure when no page is shown one). */
  stateMsg(now) {
    for (const d of this.decks.values()) d.meterTick(now);
    return { t: 'state', s: this.snapshot(now) };
  }

  broadcastState(now) {
    let msg = null;
    for (const p of this.ui) {
      const u = this.uiStream.get(p);
      if (!u || (u.hidden && now < u.nextState)) continue;
      if (u.hidden) u.nextState = now + HIDDEN_STATE_SEC;
      if (!msg) msg = this.stateMsg(now);
      this.post(p, msg);
      if (u.hidden) continue;
      // A deck new to this page: its whole waveform follows the first state that lists it.
      for (const d of this.decks.values()) {
        if (u.waves.has(d.id)) continue;
        const w = d.waveBacklog();
        if (w) this.post(p, w);
        u.waves.set(d.id, d.waveEnd());
      }
      if (u.waves.size > this.decks.size) for (const id of u.waves.keys()) if (!this.decks.has(id)) u.waves.delete(id);
    }
  }

  /** A deck's new waveform hops, to each shown page that has its earlier ones. */
  broadcastWave(d, tStart, hop, bands) {
    let msg = null;
    for (const p of this.ui) {
      const u = this.uiStream.get(p);
      if (!u || u.hidden || !u.waves.has(d.id)) continue;
      if (!msg) msg = { t: 'wave', deck: d.id, tStart, hop, data: Array.from(bands) };
      this.post(p, msg);
      u.waves.set(d.id, d.waveEnd());
    }
  }

  /** Each deck's waveform a page does not have yet: all that is buffered, or what came after its last batch. */
  sendWaves(port, u) {
    for (const d of this.decks.values()) {
      const w = d.waveSince(u.waves.has(d.id) ? u.waves.get(d.id) : -Infinity);
      if (w) this.post(port, w);
      u.waves.set(d.id, d.waveEnd());
    }
  }

  setHidden(port, hidden) {
    const u = this.uiStream.get(port);
    if (!u || u.hidden === hidden) return;
    u.hidden = hidden;
    if (hidden) { u.nextState = this.ctx.currentTime + HIDDEN_STATE_SEC; return; }
    this.post(port, this.stateMsg(this.ctx.currentTime));
    this.sendWaves(port, u);
  }

  /** With no decks, no UI and no mix recording for idleMs, suspend the AudioContext (START and hello resume it). */
  idleTick() {
    if (this.decks.size || this.ui.size || this.mixRec.state !== 'idle') { this.idleSince = null; return; }
    const t = performance.now();
    if (this.idleSince == null) this.idleSince = t;
    else if (t - this.idleSince >= this.idleMs) { this.idleSince = null; this.ctx.suspend().catch(() => {}); }
  }

  snapshot(now) {
    const stamp = this.outputStamp();
    const decks = [...this.decks.values()].sort((a, b) => a.slot - b.slot).map((d) => d.state(stamp.ctxTime));
    const cs = this.clock.state();
    return {
      engineId: INSTANCE,
      ctxTime: stamp.ctxTime, wallMs: stamp.wallMs, sampleRate: this.ctx.sampleRate, engineState: this.ctx.state,
      outputLatency: this.ctx.outputLatency || 0, clock: cs,
      master: {
        params: { ...this.params }, peakL: this.mm.peakL, peakR: this.mm.peakR, rmsL: this.mm.rmsL, rmsR: this.mm.rmsR,
        clipL: now < this.clipUntil.L, clipR: now < this.clipUntil.R, gr: this.mm.gr, residentBytes: this.residentBytes(),
        rec: this.mixRec ? { state: this.mixRec.state, format: this.mixRec.format, seconds: this.mixRec.seconds } : { state: 'idle', format: 'wav', seconds: 0 },
      },
      decks,
    };
  }
}

globalThis.__jdsEngine = new Engine();
