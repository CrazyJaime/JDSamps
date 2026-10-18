// agent/agent-relay.js — JD Samps relay (ISOLATED world, every frame). Connects this frame to the
// offscreen engine (port 'jds-agent') only after the extension asks ({jds:'connect'}) and only if
// the frame has media. Relays engine commands down to agent-main.js and status up, on a random
// per-page channel it offers agent-main.js at document_start (see agent-main.js). On eject, the
// service worker calls __jdsStop() here (scripting.executeScript, this isolated world only) to
// have agent-main.js pause the frame's players before the capture goes.
(() => {
  // ISOLATED world: pages cannot see this. A relay left behind by an extension update or reload
  // can no longer reach the engine (its runtime is gone): it is replaced, not kept. An older
  // relay that cannot say (`true`) was only ever re-injected because no relay in the tab answered.
  const prev = globalThis.__jdsRelay;
  if (prev && typeof prev.alive === 'function' && prev.alive()) return;
  if (prev && typeof prev.retire === 'function') prev.retire();
  const rt = chrome.runtime;
  globalThis.__jdsRelay = { alive: () => { try { return !!rt.id; } catch (_) { return false; } }, retire };
  const HELLO = 'media-channel';
  const chan = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  // Offer the channel now and whenever agent-main asks, until agent-main takes it (it cancels the offer).
  const offer = () => { if (!window.dispatchEvent(new CustomEvent(HELLO, { detail: chan, cancelable: true }))) window.removeEventListener(HELLO, onHello); };
  function onHello(e) { if (e.detail == null) offer(); }
  window.addEventListener(HELLO, onHello);
  offer();
  let port = null, wanted = false, last = null, rated = false, isolated = false, answering = false, timer = 0;
  // Upward traffic, per message type: the last JSON forwarded, the latest one waiting, and when
  // that type last went up.
  const sent = {}, pending = {}, at = {};
  const toMain = (m) => window.dispatchEvent(new CustomEvent(`c${chan}`, { detail: JSON.stringify(m) }));

  function retire() {
    window.removeEventListener(HELLO, onHello);
    window.removeEventListener(`s${chan}`, onStatus);
    clearTimeout(timer);
    // A replaced relay must not leave the page's pauses guarded with nobody left to lift it.
    if (isolated) { isolated = false; try { toMain({ t: 'isolate', on: false }); } catch (_) {} }
    if (port) { try { port.disconnect(); } catch (_) {} port = null; }
  }

  /**
   * A command for agent-main.js, which answers it from inside this very dispatch: that answer goes
   * up at once. Chrome throttles timers in background tabs, not messages, so no timer is in the way.
   */
  function command(m) {
    answering = true;
    try { toMain(m); } finally { answering = false; }
    flush();
  }

  function connect() {
    if (port) return;
    try { port = rt.connect({ name: 'jds-agent' }); } catch (_) { port = null; return; }
    port.onMessage.addListener((m) => {
      if (!m || typeof m !== 'object' || (m.t !== 'rate' && m.t !== 'release' && m.t !== 'query' && m.t !== 'isolate')) return;
      if (m.t === 'isolate') isolated = m.on === true;
      else if (m.t !== 'query') rated = m.t === 'rate';
      command(m);
    });
    port.onDisconnect.addListener(() => {
      void rt.lastError; port = null; wanted = false;
      for (const k of Object.keys(sent)) delete sent[k];
      // The engine is gone (crash, update, eject): give the page its player back now, rate and pauses.
      if (rated) { rated = false; toMain({ t: 'release' }); }
      if (isolated) { isolated = false; toMain({ t: 'isolate', on: false }); }
    });
    if (last) post('status', last);
  }

  function post(t, s) {
    if (!port || s === sent[t]) return;
    sent[t] = s; at[t] = performance.now();
    try { port.postMessage(JSON.parse(s)); } catch (_) {}
  }

  // Anything else: at most ten messages a second per type (the latest of each), and never the same
  // one twice in a row. Checked on every message up or down; the timer only covers the case where
  // nothing else comes.
  function flush() {
    const now = performance.now();
    let wait = Infinity;
    for (const t of Object.keys(pending)) {
      const w = (at[t] ?? -1e9) + 100 - now;
      if (w > 0) { wait = Math.min(wait, w); continue; }
      const s = pending[t];
      delete pending[t];
      post(t, s);
    }
    if (wait !== Infinity && !timer) timer = setTimeout(() => { timer = 0; flush(); }, wait);
  }

  function onStatus(e) {
    if (typeof e.detail !== 'string' || e.detail.length > 1000) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (m && m.t === 'stopped') {
      if (Number.isInteger(m.count) && m.count >= 0 && m.count < 1000) { for (const f of stops) f(m.count); stops.clear(); }
      return;
    }
    if (m && m.t === 'started') {
      if (Number.isInteger(m.count) && m.count >= 0 && m.count < 1000 && WHY.includes(m.why)) { for (const f of starts) f(m); starts.clear(); }
      return;
    }
    if (!m || typeof m !== 'object' || (m.t !== 'status' && m.t !== 'external-rate' && m.t !== 'external-pause')) return;
    if (m.t === 'status') last = e.detail;
    if (wanted && m.hasMedia) connect();
    if (answering) { delete pending[m.t]; post(m.t, e.detail); } else pending[m.t] = e.detail;
    flush();
  }
  window.addEventListener(`s${chan}`, onStatus);

  // Eject: resolves with {t:'stopped', count} (heard players paused), count 0 if agent-main.js does
  // not answer in time, so an eject never waits on the page.
  const STOP_WAIT = 150, stops = new Set();
  globalThis.__jdsStop = () => new Promise((resolve) => {
    const done = (count) => { clearTimeout(timer); stops.delete(done); resolve({ t: 'stopped', count }); };
    const timer = setTimeout(() => done(0), STOP_WAIT);
    stops.add(done);
    toMain({ t: 'stop' });
  });

  // Load: resolves with {t:'started', count, why} (what agent-main.js did with the page's player),
  // or why:'timeout' when it does not answer in time, so a load never waits on the page. play()
  // has to begin playing before it resolves, so this waits longer than a stop.
  const START_WAIT = 300, WHY = ['started', 'playing', 'none', 'ambiguous', 'refused'], starts = new Set();
  globalThis.__jdsStart = () => new Promise((resolve) => {
    const done = (m) => { clearTimeout(timer); starts.delete(done); resolve({ t: 'started', count: m ? m.count : 0, why: m ? m.why : 'timeout' }); };
    const timer = setTimeout(() => done(null), START_WAIT);
    starts.add(done);
    toMain({ t: 'start' });
  });

  rt.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.jds !== 'connect') return false;
    wanted = true;
    command({ t: 'query' });
    sendResponse({ ok: true });
    return false;
  });
})();
