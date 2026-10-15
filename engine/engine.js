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

const STRETCH_URL = new URL('../vendor/signalsmith-stretch/SignalsmithStretch.js', import.meta.url).href;
SignalsmithStretch.moduleUrl = STRETCH_URL;
const workletUrl = (f) => new URL(`../worklets/${f}`, import.meta.url).href;
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const HIDDEN_STATE_SEC = 0.5; // state period for a UI page that is hidden (no waveform at all)
// An eject waits at most this long for its tab to stop playing. The hub bounds its own work (pause
// for 250 ms, else mute), so this only guards against a hub that never answers; on a busy machine
// a tighter limit would release the capture while the tab is still playing.
const STOP_TAB_MS = 2500;
const INSTANCE = crypto.randomUUID(); // snapshot.engineId: the UI restores its settings into each new engine
const NOTE_TTL = 60000; // a hub notice raised with no deck page open waits this long for one

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
    this.tabStops = new WeakMap(); // deck → its STOP_TAB (sent once)
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

  deckByTab(tabId) { for (const d of this.decks.values()) if (d.tabId === tabId) return d; return null; }

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
    if (m.deck === null) r = await this.masterAct(m.a);
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

  async masterAct(a) {
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
      default: return { ok: false, error: `Unknown action ${a}` };
    }
  }

  async onHub(msg) {
    await this.ready;
    switch (msg.type) {
      case ENGINE.START: return this.serial(() => { this.applySaved(msg.settings); return this.startDeck(msg.tabId, msg.streamId, msg.meta || {}); });
      case ENGINE.EJECT: { const d = this.deckByTab(msg.tabId); if (d) await this.eject(d.id, msg.reason); return { ok: true }; }
      case ENGINE.META: { const d = this.deckByTab(msg.tabId); if (d) Object.assign(d.meta, msg.meta || {}); return { ok: true }; }
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
    const existing = this.deckByTab(tabId);
    if (existing) return { ok: false, error: `That tab is already on deck ${existing.slot}.` };
    if (this.decks.size >= MAX_DECKS) return { ok: false, error: `All ${MAX_DECKS} decks are in use. Eject one first.` };
    this.idleSince = null;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
    } catch (err) {
      return { ok: false, error: `Chrome would not share that tab's audio: ${err.message}` };
    }
    const used = new Set([...this.decks.values()].map((d) => d.slot));
    let slot = 1; while (used.has(slot)) slot++;
    const params = defaults(DECK_PARAMS);
    params.range = this.params['pitch.defaultRange'];
    const deck = new Deck(this, { id: this.nextId++, slot, tabId, stream, meta, params });
    try {
      await deck.init();
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      await deck.dispose().catch(() => {});
      return { ok: false, error: `The deck could not start: ${err.message}` };
    }
    this.decks.set(deck.id, deck);
    this.master.addDeck(deck.id, deck.xfGain, deck.params.xf);
    this.hub({ type: HUB.DECKS_CHANGED, decks: [...this.decks.values()].map((d) => ({ tabId: d.tabId, slot: d.slot })) });
    this.hub({ type: HUB.AGENT_CONNECT, tabId });
    this.event('info', `Loaded “${meta.title || 'tab'}” on deck ${slot}. It is cued: press PLAY when you're ready.`, deck.id);
    return { ok: true, deckId: deck.id, slot };
  }

  /** Before a deck's capture goes, stop its tab playing (the hub pauses the page's players, or
   *  mutes the tab), so the ejected track does not come out of the speakers. Bounded. */
  stopTab(d) {
    let p = this.tabStops.get(d);
    if (!p) {
      p = withTimeout(this.hub({ type: HUB.STOP_TAB, tabId: d.tabId }), STOP_TAB_MS, 'STOP_TAB timed out').then((r) => {
        if (r && r.ok && r.muted) this.event('info', `Deck ${d.slot}: the tab has no pausable player, so it was muted.`);
      }, () => {});
      this.tabStops.set(d, p);
    }
    return p;
  }

  eject(id, reason) {
    // Stopping the tab starts now, ahead of the queue, so STOP ALL stops every tab in parallel.
    const d0 = this.decks.get(id);
    if (d0) this.stopTab(d0);
    return this.serial(async () => {
      const d = this.decks.get(id);
      if (!d) return;
      this.decks.delete(id);
      this.clock.release(id);
      if (reason) this.event('warn', reason);
      this.hub({ type: HUB.DECKS_CHANGED, decks: [...this.decks.values()].map((x) => ({ tabId: x.tabId, slot: x.slot })) });
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
    this.broadcastState(now);
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
        clipL: now < this.clipUntil.L, clipR: now < this.clipUntil.R, gr: this.mm.gr,
        rec: this.mixRec ? { state: this.mixRec.state, format: this.mixRec.format, seconds: this.mixRec.seconds } : { state: 'idle', format: 'wav', seconds: 0 },
      },
      decks,
    };
  }
}

globalThis.__jdsEngine = new Engine();
