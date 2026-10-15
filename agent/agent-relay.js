// agent/agent-relay.js — JD Samps relay (ISOLATED world, every frame). Connects this frame to the
// offscreen engine (port 'jds-agent') only after the extension asks ({jds:'connect'}) and only if
// the frame has media. Relays engine commands down to agent-main.js and status up.
(() => {
  if (globalThis.__jdsRelay) return;
  globalThis.__jdsRelay = true;
  let port = null, wanted = false, last = null;
  const toMain = (m) => window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: JSON.stringify(m) }));

  function connect() {
    if (port) return;
    try { port = chrome.runtime.connect({ name: 'jds-agent' }); } catch (_) { port = null; return; }
    port.onMessage.addListener((m) => {
      if (m && typeof m === 'object' && (m.t === 'rate' || m.t === 'release' || m.t === 'query')) toMain(m);
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; wanted = false; });
    if (last) { try { port.postMessage(last); } catch (_) {} }
  }

  window.addEventListener('jds-agent-status', (e) => {
    if (typeof e.detail !== 'string' || e.detail.length > 1000) return;
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    last = m;
    if (wanted && m.hasMedia) connect();
    if (port) { try { port.postMessage(m); } catch (_) {} }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.jds !== 'connect') return false;
    wanted = true;
    toMain({ t: 'query' });
    sendResponse({ ok: true });
    return false;
  });
})();
