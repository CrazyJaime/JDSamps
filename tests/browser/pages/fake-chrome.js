// Fake chrome.* for UI tests: a scriptable engine port + hub. Tests drive it via window.__fake.
(() => {
  const listeners = { msg: [], disc: [] };
  const fake = {
    sent: [],
    hubCalls: [],
    hubReplies: {},
    storage: {},
    connected: false,
    state: null,
    push(msg) { for (const fn of listeners.msg) fn(msg); },
    disconnect() { fake.connected = false; for (const fn of listeners.disc) fn(); },
    reply(id, ok = true, error) { fake.push({ t: 'reply', id, ok, error }); },
    autoReply: true,
  };
  window.__fake = fake;
  const port = {
    name: 'jds-ui',
    postMessage(m) {
      const copy = JSON.parse(JSON.stringify(m));
      fake.sent.push(copy);
      if (m.t === 'hello' && fake.state) setTimeout(() => fake.push({ t: 'state', s: fake.state }), 0);
      if (m.id && fake.autoReply) setTimeout(() => fake.reply(m.id, true), 0);
    },
    onMessage: { addListener(fn) { listeners.msg.push(fn); } },
    onDisconnect: { addListener(fn) { listeners.disc.push(fn); } },
    disconnect() {},
  };
  window.chrome = {
    runtime: {
      lastError: undefined,
      connect() { fake.connected = true; return port; },
      sendMessage(msg) {
        fake.hubCalls.push(JSON.parse(JSON.stringify(msg)));
        const r = fake.hubReplies[msg.type];
        return Promise.resolve(typeof r === 'function' ? r(msg) : r ?? { ok: true });
      },
      getURL: (p) => `/${p}`,
    },
    storage: {
      local: {
        get(keys) { const out = {}; for (const k of [].concat(keys ?? Object.keys(fake.storage))) if (k in fake.storage) out[k] = fake.storage[k]; return Promise.resolve(out); },
        set(obj) { Object.assign(fake.storage, obj); return Promise.resolve(); },
      },
    },
  };
})();
