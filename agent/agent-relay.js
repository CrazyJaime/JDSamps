// agent/agent-relay.js — JD Samps relay (ISOLATED world, every frame). Connects this frame to the
// offscreen engine (port 'jds-agent') only after the extension asks ({jds:'connect'}) and only if
// the frame has media. Relays engine commands down to agent-main.js and status up.
(() => {
  if (globalThis.__jdsRelay) return;
  globalThis.__jdsRelay = true;
  let port = null, wanted = false, last = null, rated = false;
  // Upward traffic, per message type: the last JSON forwarded and the latest one waiting.
  const sent = {}, pending = {};
  let timer = 0, at = -1e9;
  const toMain = (m) => window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: JSON.stringify(m) }));

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

  window.addEventListener('jds-agent-status', (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 1000) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (!m || typeof m !== 'object' || (m.t !== 'status' && m.t !== 'external-rate')) return;
    if (m.t === 'status') last = e.detail;
    if (wanted && m.hasMedia) connect();
    pending[m.t] = e.detail;
    if (!timer) timer = setTimeout(flush, Math.max(0, at + 100 - performance.now()));
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.jds !== 'connect') return false;
    wanted = true;
    toMain({ t: 'query' });
    sendResponse({ ok: true });
    return false;
  });
})();
