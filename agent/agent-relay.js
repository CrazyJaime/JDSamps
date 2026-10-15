// agent/agent-relay.js — JD Samps relay (ISOLATED world, every frame). Connects this frame to the
// offscreen engine (port 'jds-agent') only after the extension asks ({jds:'connect'}) and only if
// the frame has media. Relays engine commands down to agent-main.js and status up, on a random
// per-page channel it offers agent-main.js at document_start (see agent-main.js). On eject, the
// service worker calls __jdsStop() here (scripting.executeScript, this isolated world only) to
// have agent-main.js pause the frame's players before the capture goes.
(() => {
  if (globalThis.__jdsRelay) return; // ISOLATED world: pages cannot see this
  globalThis.__jdsRelay = true;
  const HELLO = 'media-channel';
  const chan = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  // Offer the channel now and whenever agent-main asks, until agent-main takes it (it cancels the offer).
  const offer = () => { if (!window.dispatchEvent(new CustomEvent(HELLO, { detail: chan, cancelable: true }))) window.removeEventListener(HELLO, onHello); };
  function onHello(e) { if (e.detail == null) offer(); }
  window.addEventListener(HELLO, onHello);
  offer();
  let port = null, wanted = false, last = null, rated = false;
  // Upward traffic, per message type: the last JSON forwarded and the latest one waiting.
  const sent = {}, pending = {};
  let timer = 0, at = -1e9;
  const toMain = (m) => window.dispatchEvent(new CustomEvent(`c${chan}`, { detail: JSON.stringify(m) }));

  function connect() {
    if (port) return;
    try { port = chrome.runtime.connect({ name: 'jds-agent' }); } catch (_) { port = null; return; }
    port.onMessage.addListener((m) => {
      if (!m || typeof m !== 'object' || (m.t !== 'rate' && m.t !== 'release' && m.t !== 'query')) return;
      if (m.t !== 'query') rated = m.t === 'rate';
      toMain(m);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; port = null; wanted = false;
      for (const k of Object.keys(sent)) delete sent[k];
      // The engine is gone (crash, update, eject): give the page its player back now.
      if (rated) { rated = false; toMain({ t: 'release' }); }
    });
    if (last) { sent.status = last; try { port.postMessage(JSON.parse(last)); } catch (_) {} }
  }

  // At most ten messages a second (the latest of each type) and never the same one twice in a row.
  function flush() {
    timer = 0; at = performance.now();
    for (const t of Object.keys(pending)) {
      const s = pending[t];
      delete pending[t];
      if (port && s !== sent[t]) { sent[t] = s; try { port.postMessage(JSON.parse(s)); } catch (_) {} }
    }
  }

  window.addEventListener(`s${chan}`, (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 1000) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (m && m.t === 'stopped') {
      if (Number.isInteger(m.count) && m.count >= 0 && m.count < 1000) { for (const f of stops) f(m.count); stops.clear(); }
      return;
    }
    if (!m || typeof m !== 'object' || (m.t !== 'status' && m.t !== 'external-rate')) return;
    if (m.t === 'status') last = e.detail;
    if (wanted && m.hasMedia) connect();
    pending[m.t] = e.detail;
    if (!timer) timer = setTimeout(flush, Math.max(0, at + 100 - performance.now()));
  });

  // Eject: resolves with {t:'stopped', count} (heard players paused), count 0 if agent-main.js does
  // not answer in time, so an eject never waits on the page.
  const STOP_WAIT = 150, stops = new Set();
  globalThis.__jdsStop = () => new Promise((resolve) => {
    const done = (count) => { clearTimeout(timer); stops.delete(done); resolve({ t: 'stopped', count }); };
    const timer = setTimeout(() => done(0), STOP_WAIT);
    stops.add(done);
    toMain({ t: 'stop' });
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.jds !== 'connect') return false;
    wanted = true;
    toMain({ t: 'query' });
    sendResponse({ ok: true });
    return false;
  });
})();
