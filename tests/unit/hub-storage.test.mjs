// background.js bookkeeping in chrome.storage.session under concurrency, against a fake chrome
// whose async calls each yield a turn (like the real IPC), so interleavings are deterministic.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const turn = () => new Promise((r) => setImmediate(r));
// Settle by turns, not wall time: under CPU load a 30 ms timer can fire before the chains finish.
const settle = async () => { for (let i = 0; i < 400; i++) await turn(); };
const event = () => { const ls = []; return { ls, addListener: (f) => ls.push(f), fire: (...a) => ls.map((f) => f(...a)) }; };
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';

let store, sent, items, nextId, onDownload, tabs, scripts, runScript, ops;
const chrome = {
  runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop', lastError: null, getURL: (p = '') => EXT + p,
    getContexts: async () => { await turn(); return [{}]; },
    sendMessage: async (m) => { await turn(); sent.push(m); ops.push(m.type); return m.type === 'PING' ? { ok: true, decks: [] } : { ok: true }; },
    onMessage: event(), onInstalled: event(),
  },
  storage: { session: {
    get: async (k) => {
      await turn();
      const keys = k == null ? Object.keys(store) : [].concat(k);
      return structuredClone(Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, store[x]])));
    },
    set: async (o) => { await turn(); Object.assign(store, structuredClone(o)); },
    remove: async (k) => { await turn(); for (const x of [].concat(k)) delete store[x]; },
  } },
  downloads: {
    download: async (o) => {
      await turn();
      const id = nextId++;
      items[id] = { id, url: o.url, state: 'in_progress' };
      if (onDownload) onDownload(id);
      await turn();
      return id;
    },
    search: async (q) => { await turn(); return items[q.id] ? [{ ...items[q.id] }] : []; },
    onChanged: event(),
  },
  tabs: {
    get: async (id) => { await turn(); return tabs.find((t) => t.id === id); },
    query: async (q) => { await turn(); return q.url ? tabs.filter((t) => t.url === q.url) : tabs; },
    update: async (id, props = {}) => {
      await turn();
      if ('muted' in props) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        t.mutedInfo = { muted: props.muted, reason: 'extension', extensionId: chrome.runtime.id };
        ops.push(`muted:${props.muted}`);
      }
      return { id, windowId: 1 };
    },
    create: async (o) => { await turn(); return { id: 99, windowId: 1, ...o }; },
    sendMessage: async () => { await turn(); return { ok: true }; },
    onRemoved: event(), onUpdated: event(),
  },
  windows: { update: async () => { await turn(); } },
  action: { onClicked: event(), setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
  commands: { onCommand: event() },
  contextMenus: { onClicked: event(), removeAll: (cb) => cb && cb(), create: () => {} },
  tabCapture: { getMediaStreamId: (o, cb) => setImmediate(() => cb('stream-id')) },
  offscreen: { createDocument: async () => {} },
  scripting: { executeScript: async (o) => { await turn(); scripts.push(o); return runScript ? runScript(o) : []; } },
};
globalThis.chrome = chrome;
await import('../../background.js');

/** A hub request as the offscreen engine sends it. */
function hub(msg) {
  return new Promise((resolve) => {
    chrome.runtime.onMessage.fire({ target: 'hub', ...msg }, { id: chrome.runtime.id, url: `${EXT}offscreen.html` }, resolve);
  });
}
const done = () => sent.filter((m) => m.target === 'engine' && m.type === 'DOWNLOAD_DONE');
/** Downloads the hub still tracks, whatever the storage layout. */
const tracked = () => Object.entries(store).flatMap(([k, v]) => (k === 'dl' ? Object.keys(v) : k.startsWith('dl:') ? [k] : []));
const blob = (n) => `blob:${EXT.slice(0, -1)}/rec-${n}`;
function finish(id, state, error) {
  items[id].state = state;
  if (error) items[id].error = error;
  chrome.downloads.onChanged.fire({ id, state: { current: state }, ...(error ? { error: { current: error } } : {}) });
}

beforeEach(() => {
  store = {}; sent = []; items = {}; nextId = 1; onDownload = null; scripts = []; runScript = null; ops = [];
  tabs = [
    { id: 11, windowId: 1, url: 'https://a.example/x', title: 'A' },
    { id: 12, windowId: 1, url: 'https://b.example/y', title: 'B' },
  ];
});

test('two downloads started together are both reported and forgotten', async () => {
  const [a, b] = await Promise.all([hub({ type: 'DOWNLOAD', url: blob(1), filename: 'a.wav' }), hub({ type: 'DOWNLOAD', url: blob(2), filename: 'b.wav' })]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  finish(a.downloadId, 'complete');
  finish(b.downloadId, 'complete');
  await settle();
  assert.deepEqual(done().map((m) => [m.url, m.ok]).sort(), [[blob(1), true], [blob(2), true]]);
  assert.deepEqual(tracked(), []);
});

test('a download that finishes before it is tracked is still reported', async () => {
  onDownload = (id) => finish(id, 'complete');
  const r = await hub({ type: 'DOWNLOAD', url: blob(3), filename: 'c.wav' });
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(done().map((m) => [m.url, m.ok]), [[blob(3), true]]);
  assert.deepEqual(tracked(), []);
});

test('a download interrupted before it is tracked is reported as a failure', async () => {
  onDownload = (id) => finish(id, 'interrupted', 'FILE_NO_SPACE');
  const r = await hub({ type: 'DOWNLOAD', url: blob(4), filename: 'd.wav' });
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(done().map((m) => [m.url, m.ok, m.error]), [[blob(4), false, 'FILE_NO_SPACE']]);
  assert.deepEqual(tracked(), []);
});

test('grants given at the same time are all kept', async () => {
  chrome.action.onClicked.fire(tabs[0]);
  chrome.action.onClicked.fire(tabs[1]);
  await settle();
  const r = await hub({ type: 'LIST_SOURCES' });
  assert.deepEqual(r.tabs.map((t) => [t.id, t.granted]).sort(), [[11, true], [12, true]]);
});

test('closing one tab while another is granted keeps the other grant', async () => {
  for (let k = 0; k < 6; k++) { // every interleaving of the two read-modify-writes
    store = {};
    tabs = [{ id: 11, windowId: 1, url: 'https://a.example/x', title: 'A' }, { id: 12, windowId: 1, url: 'https://b.example/y', title: 'B' }];
    chrome.action.onClicked.fire(tabs[0]);
    await settle();
    chrome.action.onClicked.fire(tabs[1]);
    for (let i = 0; i < k; i++) await turn();
    chrome.tabs.onRemoved.fire(11);
    tabs = tabs.slice(1);
    await settle();
    const r = await hub({ type: 'LIST_SOURCES' });
    assert.deepEqual(r.tabs.map((t) => [t.id, t.granted]), [[12, true]], `offset ${k}`);
  }
});

// ---------------------------------------------------------------- eject: stop the tab playing
/** executeScript results: one {t:'stopped', count} per frame relay (null: no relay in that frame). */
const frames = (...counts) => counts.map((c, i) => ({ frameId: i, result: c == null ? null : { t: 'stopped', count: c } }));
const pausing = (...counts) => (o) => (o.func ? frames(...counts) : []);
const stopTab = (tabId) => hub({ type: 'STOP_TAB', tabId });
const muteRecords = () => Object.keys(store).filter((k) => k.startsWith('muted:'));

test('STOP_TAB pauses the players in every frame and leaves the tab unmuted', async () => {
  runScript = pausing(0, 2, null);
  assert.deepEqual(await stopTab(11), { ok: true, paused: 2, muted: false });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].target.tabId, 11);
  assert.equal(scripts[0].target.allFrames, true);
  assert.equal(tabs[0].mutedInfo, undefined);
  assert.deepEqual(muteRecords(), []);
});

test('STOP_TAB with nothing paused mutes the tab and records it; closing the tab forgets it', async () => {
  runScript = pausing(0);
  assert.deepEqual(await stopTab(11), { ok: true, paused: 0, muted: true });
  assert.equal(tabs[0].mutedInfo.muted, true);
  assert.deepEqual(muteRecords(), ['muted:11']);
  chrome.tabs.onRemoved.fire(11);
  await settle();
  assert.deepEqual(muteRecords(), []);
});

test('STOP_TAB puts the agent into a tab that has none, then pauses', async () => {
  let injected = false;
  runScript = (o) => { if (o.files) { injected = true; return []; } return frames(injected ? 1 : null); };
  assert.deepEqual(await stopTab(11), { ok: true, paused: 1, muted: false });
  assert.deepEqual(scripts.filter((o) => o.files).map((o) => [o.files[0], o.world || 'ISOLATED', o.target.allFrames]),
    [['agent/agent-main.js', 'MAIN', true], ['agent/agent-relay.js', 'ISOLATED', true]]);
});

test('STOP_TAB that cannot pause in time mutes the tab instead, and answers within the bound', async () => {
  runScript = () => new Promise(() => {}); // a frame that never answers
  const t0 = Date.now();
  assert.deepEqual(await stopTab(11), { ok: true, paused: 0, muted: true });
  assert.ok(Date.now() - t0 < 400, `answered after ${Date.now() - t0} ms`);
  // A page that cannot be scripted at all is muted too.
  runScript = () => { throw new Error('Cannot access contents of the page.'); };
  assert.deepEqual(await stopTab(12), { ok: true, paused: 0, muted: true });
});

test('STOP_TAB skips a closed or navigated-away tab silently', async () => {
  tabs[0].url = 'chrome://newtab/';
  for (const id of [11, 77, 'x']) {
    const r = await stopTab(id);
    if (id === 'x') assert.equal(r.ok, false);
    else assert.deepEqual(r, { ok: true, paused: 0, muted: false });
  }
  assert.equal(scripts.length, 0);
  assert.equal(tabs[0].mutedInfo, undefined);
  assert.deepEqual(muteRecords(), []);
  assert.deepEqual(sent.filter((m) => m.type === 'NOTIFY'), []);
});

test('LOAD_TAB on a tab we muted unmutes it first', async () => {
  runScript = pausing(0);
  await stopTab(11);
  ops = [];
  const r = await hub({ type: 'LOAD_TAB', tabId: 11 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(tabs[0].mutedInfo.muted, false);
  assert.ok(ops.includes('muted:false') && ops.indexOf('muted:false') < ops.indexOf('START'), ops.join());
  assert.deepEqual(muteRecords(), []);
});

test('a mute the user made is left alone', async () => {
  runScript = pausing(0);
  // Muted by the user before the eject: not recorded, not undone.
  tabs[0].mutedInfo = { muted: true, reason: 'user' };
  assert.deepEqual(await stopTab(11), { ok: true, paused: 0, muted: false });
  assert.deepEqual(muteRecords(), []);
  assert.equal((await hub({ type: 'LOAD_TAB', tabId: 11 })).ok, true);
  assert.deepEqual(tabs[0].mutedInfo, { muted: true, reason: 'user' });
  // Muted by us, then muted again by the user: the user's mute stays.
  assert.deepEqual(await stopTab(12), { ok: true, paused: 0, muted: true });
  tabs[1].mutedInfo = { muted: true, reason: 'user' };
  assert.equal((await hub({ type: 'LOAD_TAB', tabId: 12 })).ok, true);
  assert.deepEqual(tabs[1].mutedInfo, { muted: true, reason: 'user' });
  assert.ok(!ops.includes('muted:false'), ops.join());
  assert.deepEqual(muteRecords(), []);
});

test('a LOAD_TAB that races a STOP_TAB of the same tab waits for it, so the capture is not muted', async () => {
  runScript = async (o) => { await new Promise((r) => setTimeout(r, 50)); return pausing(0)(o); }; // a slow page
  const stop = stopTab(11);
  const load = hub({ type: 'LOAD_TAB', tabId: 11 });
  await Promise.all([stop, load]);
  assert.equal(tabs[0].mutedInfo.muted, false);
  assert.ok(ops.lastIndexOf('muted:false') < ops.indexOf('START'), ops.join());
});
