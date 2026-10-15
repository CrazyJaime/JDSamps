// ui/connection.js — the UI's link to the offscreen engine (port 'jds-ui') and the service worker hub.
// Reconnects forever with backoff; while disconnected the engine keeps playing.
import { PORT_UI, TARGET, HUB } from '../shared/protocol.js';

export class EngineConnection {
  constructor({ onState, onWave, onEvent, onStatus }) {
    this.cb = { onState, onWave, onEvent, onStatus };
    this.port = null;
    this.status = 'connecting';
    this.nextId = 1;
    this.pending = new Map();
    this.sets = new Map();
    this.raf = 0;
    this.retry = 250;
    this.lastStateAt = 0;
  }

  start() {
    this.hub(HUB.ENSURE_ENGINE).catch(() => {}).finally(() => this.connect());
  }

  connect() {
    let port;
    try { port = chrome.runtime.connect({ name: PORT_UI }); } catch (_) { this.down(); return; }
    this.port = port;
    port.onMessage.addListener((m) => this.onMessage(m));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.port === port) { this.port = null; this.down(); }
    });
    this.post({ t: 'hello' });
  }

  down() {
    for (const [, p] of this.pending) p.resolve({ ok: false, error: 'Audio engine is not connected' });
    this.pending.clear();
    this.setStatus('down');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.retry = Math.min(2000, this.retry * 2);
      this.hub(HUB.ENSURE_ENGINE).catch(() => {}).finally(() => this.connect());
    }, this.retry);
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.cb.onStatus && this.cb.onStatus(s);
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'state') {
      this.retry = 250;
      this.lastStateAt = performance.now();
      this.setStatus('up');
      this.cb.onState(m.s);
    } else if (m.t === 'wave') this.cb.onWave(m);
    else if (m.t === 'event') this.cb.onEvent(m);
    else if (m.t === 'reply') {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve({ ok: !!m.ok, error: m.error }); }
    }
  }

  post(msg) {
    if (!this.port) return false;
    try { this.port.postMessage(msg); return true; } catch (_) { return false; }
  }

  /** Continuous controls: only the latest value per key is sent, once per animation frame. */
  set(deck, key, value) {
    this.sets.set(`${deck}|${key}`, { t: 'set', deck, key, value });
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      for (const msg of this.sets.values()) this.post(msg);
      this.sets.clear();
    });
  }

  act(deck, a, arg) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      if (!this.post({ t: 'act', deck, a, arg: arg ?? {}, id })) { resolve({ ok: false, error: 'Audio engine is not connected' }); return; }
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'The audio engine did not answer' }); }, 4000);
      this.pending.set(id, { resolve, timer });
    });
  }

  hub(type, payload = {}) {
    return chrome.runtime.sendMessage({ target: TARGET.HUB, type, ...payload });
  }
}
