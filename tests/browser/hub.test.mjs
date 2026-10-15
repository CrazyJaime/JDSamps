import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareExtension, launchExtension, startTrackServer, openExtPage, hubCall, tabIdFor, waitFor, installClient, events, offscreenEval, act, state,
} from './ext-harness.mjs';

let h, server, deck, track, other;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  server = await startTrackServer();
  h = await launchExtension({ ext: prepareExtension() });
  track = await h.context.newPage();
  await track.goto(server.url('a'));
  deck = await openExtPage(h, 'deck.html');
});
after(async () => { await h?.close(); await server?.close(); });

test('commands and context menu are registered', async () => {
  const cmds = await h.sw.evaluate(() => chrome.commands.getAll());
  assert.ok(cmds.some((c) => c.name === 'add-tab'));
  // contextMenus has no getter: updating an item fails unless it exists. onInstalled creates it.
  const menu = (id) => h.sw.evaluate((x) => chrome.contextMenus.update(x, {}).then(() => 'ok', (e) => e.message), id);
  await waitFor(async () => (await menu('jds-add-tab')) === 'ok', 5000);
  assert.notEqual(await menu('no-such-item'), 'ok');
});

test('sources list shows the track tab as not yet granted', async () => {
  const r = await hubCall(deck, { type: 'LIST_SOURCES' });
  assert.equal(r.ok, true);
  const row = r.tabs.find((t) => t.url.startsWith(server.origin));
  assert.ok(row);
  assert.equal(row.granted, false);
  assert.equal(row.deckSlot, null);
  assert.ok(!r.tabs.some((t) => t.url.startsWith('chrome-extension://')));
});

test('LOAD_TAB captures the tab onto deck 1 (allowlisted test build)', async () => {
  const id = await tabIdFor(h, server.origin);
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.slot, 1);
  const again = await hubCall(deck, { type: 'LOAD_TAB', tabId: id });
  assert.equal(again.ok, false);
  assert.match(again.error, /already on deck 1/);
  const list = await hubCall(deck, { type: 'LIST_SOURCES' });
  assert.equal(list.tabs.find((t) => t.id === id).deckSlot, 1);
  assert.equal(await h.sw.evaluate(() => chrome.action.getBadgeText({})), '1');
});

// tabs.onUpdated takes no filter in Chrome: every tab's title, favicon and loading changes wake the
// service worker. A tab that is not a deck must cost no storage read and no hub work.
test('30 title changes in a tab that is not a deck: no storage read, no hub work', async () => {
  const chat = await h.context.newPage();
  try {
    await chat.goto(server.url('b'));
    await sleep(500);
    await h.sw.evaluate(() => {
      const n = { updates: 0, titles: 0, reads: 0, work: 0 };
      globalThis.__upd = n;
      chrome.tabs.onUpdated.addListener((id, info) => { n.updates++; if (info.title) n.titles++; });
      const wrap = (obj, k, key) => { const f = obj[k].bind(obj); obj[k] = (...a) => { n[key]++; return f(...a); }; };
      wrap(chrome.storage.session, 'get', 'reads');
      wrap(chrome.storage.local, 'get', 'reads');
      wrap(chrome.runtime, 'sendMessage', 'work');
      wrap(chrome.tabs, 'sendMessage', 'work');
      wrap(chrome.scripting, 'executeScript', 'work');
    });
    for (let i = 0; i < 30; i++) { await chat.evaluate((k) => { document.title = `chat (${k})`; }, i); await sleep(40); }
    await sleep(500);
    const n = await h.sw.evaluate(() => globalThis.__upd);
    assert.ok(n.titles >= 25, `title updates seen: ${n.titles}`);
    assert.deepEqual([n.reads, n.work], [0, 0], `storage reads, hub work over ${n.updates} updates`);
  } finally { await chat.close(); }
});

test('chrome pages and bad ids are refused politely', async () => {
  for (const tabId of ['x', 1.5, null, {}]) {
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId });
    assert.deepEqual([r.ok, r.error], [false, 'Bad tab id.'], JSON.stringify(tabId));
  }
  const gone = await hubCall(deck, { type: 'LOAD_TAB', tabId: 2 ** 30 });
  assert.deepEqual([gone.ok, gone.error], [false, 'That tab is gone.']);
  const page = await h.context.newPage();
  await page.goto('chrome://version');
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, 'chrome://version') });
  await page.close();
  assert.equal(r.ok, false);
  assert.match(r.error, /Chrome pages cannot be captured/);
});

test('messages from content scripts are refused', async () => {
  const r = await h.sw.evaluate(async (origin) => {
    const [t] = await chrome.tabs.query({ url: `${origin}/*` });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => chrome.runtime.sendMessage({ target: 'hub', type: 'LIST_SOURCES' }) });
    return res.result;
  }, server.origin);
  assert.deepEqual(r, { ok: false, error: 'forbidden' });
});

// The relay content script runs in every frame of every site, so a compromised renderer can
// speak as it. The engine must not hand it the snapshot or take commands from it.
async function attackerTab() {
  if (!other) { other = await h.context.newPage(); await other.goto(server.url('b')); }
  return tabIdFor(h, server.url('b'));
}

test('the engine refuses a UI port from a content script', async () => {
  const tabId = await attackerTab();
  const vol = await offscreenEval(h, 'globalThis.__jdsEngine.params["master.volume"]');
  assert.notEqual(vol, 0);
  const r = await h.sw.evaluate(async (tabId) => {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => new Promise((resolve) => {
      const out = { got: [], disconnected: false };
      const p = chrome.runtime.connect({ name: 'jds-ui' });
      p.onMessage.addListener((m) => out.got.push(m.t));
      p.onDisconnect.addListener(() => { void chrome.runtime.lastError; out.disconnected = true; });
      try {
        p.postMessage({ t: 'hello' });
        p.postMessage({ t: 'set', deck: null, key: 'master.volume', value: 0, id: 1 });
      } catch (_) { /* already disconnected */ }
      setTimeout(() => resolve(out), 1000);
    }) });
    return res.result;
  }, tabId);
  assert.deepEqual(r, { got: [], disconnected: true });
  assert.equal(await offscreenEval(h, 'globalThis.__jdsEngine.params["master.volume"]'), vol);
});

test('the engine refuses runtime messages from a content script', async () => {
  const tabId = await attackerTab();
  await installClient(deck);
  const titles = () => offscreenEval(h, '[...globalThis.__jdsEngine.decks.values()].map((d) => d.meta.title)');
  const before = await titles();
  assert.equal(before.length, 1);
  const r = await h.sw.evaluate(async ([attacker, victim]) => {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: attacker }, args: [victim], func: (tabId) => Promise.all([
      chrome.runtime.sendMessage({ target: 'engine', type: 'PING' }),
      chrome.runtime.sendMessage({ target: 'engine', type: 'NOTIFY', level: 'error', text: 'spoofed toast' }),
      chrome.runtime.sendMessage({ target: 'engine', type: 'META', tabId, meta: { title: 'spoofed' } }),
    ]) });
    return res.result;
  }, [tabId, await tabIdFor(h, server.url('a'))]);
  assert.deepEqual(r, [0, 1, 2].map(() => ({ ok: false, error: 'forbidden' })));
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(await titles(), before);
  assert.ok(!(await events(deck)).some((e) => /spoofed/.test(e.text)));
});

test('a repeated DOWNLOAD_DONE is reported once', async () => {
  await installClient(deck);
  const url = await offscreenEval(h, `(() => {
    const e = globalThis.__jdsEngine, url = URL.createObjectURL(new Blob(['x']));
    e.downloads.set(url, { timer: setTimeout(() => {}, 60000), filename: 'twice.wav' });
    return url;
  })()`);
  await h.sw.evaluate(async (u) => {
    for (let i = 0; i < 2; i++) await chrome.runtime.sendMessage({ target: 'engine', type: 'DOWNLOAD_DONE', url: u, ok: true });
  }, url);
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual((await events(deck)).filter((e) => /Sav(ed|ing)/.test(e.text)).map((e) => e.text), ['Saved twice.wav.']);
  assert.equal(await offscreenEval(h, 'globalThis.__jdsEngine.downloads.size'), 0);
});

// ---------------------------------------------------------------- UI stream (final review ui/M2, perf)
/** A raw UI port in the deck page that logs what arrives: state (deck ids) and wave (deck, span). */
const rawPort = (page, { hello = true } = {}) => page.evaluate((hi) => {
  if (window.__raw) window.__raw.port.disconnect();
  const r = { log: [], port: chrome.runtime.connect({ name: 'jds-ui' }) };
  r.port.onMessage.addListener((m) => {
    const e = { t: m.t, at: performance.now() };
    if (m.t === 'state') e.decks = m.s.decks.map((d) => d.id);
    if (m.t === 'wave') Object.assign(e, { deck: m.deck, tStart: m.tStart, hop: m.hop, n: m.data.length / 3 });
    r.log.push(e);
  });
  if (hi) r.port.postMessage({ t: 'hello' });
  window.__raw = r;
}, hello);
const rawLog = (page) => page.evaluate(() => window.__raw.log);
const rawSend = (page, m) => page.evaluate((x) => window.__raw.port.postMessage(x), m);
const rawClose = (page) => page.evaluate(() => { window.__raw.port.disconnect(); window.__raw = null; });
const deckWave = (id) => offscreenEval(h, `(() => { const d = __jdsEngine.decks.get(${id}); return { tStart: d.wave.tStart, end: d.wave.tStart + d.wave.n * d.wave.hop, hs: d.ts.historyStart }; })()`);
const waveEnd = (e) => e.tStart + e.n * e.hop;

test('a UI port gets no state or waveform before its hello; then state and the whole waveform backlog', async () => {
  await rawPort(deck, { hello: false });
  try {
    await sleep(500);
    assert.deepEqual((await rawLog(deck)).filter((e) => e.t === 'state' || e.t === 'wave').map((e) => e.t), []);
    await rawSend(deck, { t: 'hello' });
    await waitFor(async () => (await rawLog(deck)).some((e) => e.t === 'wave'), 3000);
    const log = await rawLog(deck);
    assert.equal(log[0].t, 'state');
    const id = log[0].decks[0];
    const w = log.find((e) => e.t === 'wave' && e.deck === id), ref = await deckWave(id);
    assert.ok(Math.abs(w.tStart - Math.max(ref.tStart, ref.hs)) < w.hop, `first waveform from ${w.tStart}, buffered from ${ref.tStart}`);
  } finally { await rawClose(deck); }
});

test('a deck new to a UI port arrives as a state, then its whole waveform, even when engine ticks run late', async () => {
  await rawPort(deck);
  const page = await h.context.newPage();
  // Hold the engine's ticks (a busy or throttled main thread) from before the deck exists to 500 ms after.
  await offscreenEval(h, `(() => { const E = __jdsEngine; if (!E.__tick) { E.__tick = E.tick; E.tick = function (m) { if (performance.now() < globalThis.__hold) return; return E.__tick.call(this, m); }; } globalThis.__hold = Infinity; return true; })()`);
  let id = null;
  try {
    await page.goto(server.url('c'));
    const tabId = await tabIdFor(h, server.url('c'));
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId });
    assert.equal(r.ok, true, JSON.stringify(r));
    id = await offscreenEval(h, `__jdsEngine.deckByTab(${tabId}).id`);
    await sleep(500);
    await offscreenEval(h, 'globalThis.__hold = performance.now() + 300, true');
    await waitFor(async () => (await rawLog(deck)).some((e) => e.t === 'state' && e.decks.includes(id)), 3000);
    await sleep(300);
    const log = await rawLog(deck), s = log.findIndex((e) => e.t === 'state' && e.decks.includes(id));
    assert.deepEqual(log.slice(0, s).filter((e) => e.t === 'wave' && e.deck === id).map((e) => e.tStart), [], 'waveform before any state lists the deck (the UI has no strip for it yet)');
    const w = log.slice(s).find((e) => e.t === 'wave' && e.deck === id), ref = await deckWave(id);
    assert.ok(w && Math.abs(w.tStart - Math.max(ref.tStart, ref.hs)) < w.hop, `first waveform from ${w && w.tStart}, deck's from ${ref.tStart}`);
    assert.ok(w.n * w.hop > 0.4, `backlog covers ${w.n * w.hop} s`);
  } finally {
    await offscreenEval(h, '(() => { const E = __jdsEngine; E.tick = E.__tick; delete E.__tick; return true; })()');
    if (id != null) await offscreenEval(h, `__jdsEngine.eject(${id}).then(() => true)`);
    await page.close();
    await rawClose(deck);
  }
});

test('a hidden UI page gets no waveform and state at most twice a second; shown again, a state and the waveform it missed', async () => {
  await rawPort(deck);
  try {
    await waitFor(async () => (await rawLog(deck)).filter((e) => e.t === 'wave').length >= 3, 5000);
    await rawSend(deck, { t: 'vis', hidden: true });
    await sleep(150);
    const mark = (await rawLog(deck)).length;
    await sleep(1500);
    let log = await rawLog(deck);
    const during = log.slice(mark), id = log[0].decks[0];
    assert.deepEqual(during.filter((e) => e.t === 'wave').map((e) => e.tStart), [], 'no waveform while hidden');
    const states = during.filter((e) => e.t === 'state');
    assert.ok(states.length >= 1 && states.length <= 4, `${states.length} states in 1.5 s hidden`);
    for (let i = 1; i < states.length; i++) assert.ok(states[i].at - states[i - 1].at > 400, `states ${Math.round(states[i].at - states[i - 1].at)} ms apart`);
    const sentTo = Math.max(...log.filter((e) => e.t === 'wave' && e.deck === id).map(waveEnd));
    const mark2 = log.length;
    await rawSend(deck, { t: 'vis', hidden: false });
    await sleep(400);
    log = await rawLog(deck);
    const after = log.slice(mark2), ref = await deckWave(id);
    assert.equal(after[0] && after[0].t, 'state', 'a full state first');
    const w = after.find((e) => e.t === 'wave' && e.deck === id);
    assert.ok(w && Math.abs(w.tStart - sentTo) < w.hop / 2, `waveform resumes at ${w && w.tStart}, last sent up to ${sentTo}`);
    assert.ok(w.n * w.hop > 1.4, `it covers the hidden time (${(w.n * w.hop).toFixed(2)} s)`);
    const tail = after.filter((e) => e.t === 'wave' && e.deck === id);
    assert.ok(Math.abs(waveEnd(tail[tail.length - 1]) - ref.end) < 0.5, 'and live waveform follows');
    assert.ok(after.filter((e) => e.t === 'state').length >= 6, 'per-tick state again');
  } finally { await rawClose(deck); }
});

test('meter ticks that queued up behind a stall run the decks but send one state, for the newest', async () => {
  const r = await offscreenEval(h, `(() => {
    const E = __jdsEngine, sr = E.ctx.sampleRate, ds = [...E.decks.values()];
    let posts = 0, ticks = 0;
    const post = E.post, dt = ds.map((d) => d.tick);
    E.post = function (p, m) { if (m && m.t === 'state') posts++; return post.call(this, p, m); };
    ds.forEach((d, i) => { d.tick = function (now) { ticks++; return dt[i].call(this, now); }; });
    try {
      const at = (lag) => ({ ...E.mm, t: 'meter', frame: Math.round(E.ctx.currentTime * sr) - lag });
      E.tick(at(300));
      const one = posts; posts = 0; ticks = 0;
      for (let k = 4; k >= 0; k--) E.tick(at(768 + k * 1536)); // five ticks, all but the last already overtaken
      return { one, posts, ticks, decks: ds.length };
    } finally { E.post = post; ds.forEach((d, i) => { d.tick = dt[i]; }); }
  })()`);
  assert.ok(r.decks >= 1 && r.one >= 1, JSON.stringify(r));
  assert.equal(r.ticks, 5 * r.decks, 'every queued tick runs the decks');
  assert.equal(r.posts, r.one, 'one state broadcast for the five');
});

test('closing the deck page mid-press ends held rolls, nudges, kills and FX, but not latched ones', async () => {
  await installClient(deck);
  const id = (await state(deck)).decks[0].id;
  assert.equal((await act(deck, id, 'play')).ok, true);
  await deck.evaluate((d) => {
    const p = window.__c.port;
    p.postMessage({ t: 'set', deck: d, key: 'kill.hi', value: true, hold: true }); // pad held down
    p.postMessage({ t: 'set', deck: d, key: 'fx.on', value: true, hold: true }); // pad held down
    p.postMessage({ t: 'set', deck: d, key: 'kill.low', value: true, hold: true }); // pad tapped: latched on release
    p.postMessage({ t: 'set', deck: d, key: 'kill.low', value: true });
    p.postMessage({ t: 'set', deck: d, key: 'kill.mid', value: true }); // toggled
  }, id);
  assert.equal((await act(deck, id, 'nudge', { dir: 1 })).ok, true);
  assert.equal((await act(deck, id, 'rollStart', { beats: 1 })).ok, true);
  const look = `(() => { const d = globalThis.__jdsEngine.decks.get(${id}), p = d.params;
    return { roll: d.roll, nudge: d.nudge, playing: d.wantPlay, kills: [p['kill.hi'], p['kill.mid'], p['kill.low']], fx: p['fx.on'] }; })()`;
  assert.deepEqual(await offscreenEval(h, look), { roll: 1, nudge: 1, playing: true, kills: [true, true, true], fx: true });
  await deck.close();
  try {
    await waitFor(async () => (await offscreenEval(h, look)).nudge === 0, 5000);
    assert.deepEqual(await offscreenEval(h, look), { roll: null, nudge: 0, playing: true, kills: [false, true, true], fx: false });
  } finally {
    deck = await openExtPage(h, 'deck.html');
  }
  await installClient(deck);
  assert.equal((await act(deck, id, 'pause')).ok, true);
});

test('closing the tab ejects its deck', async () => {
  await track.close();
  await waitFor(async () => (await hubCall(deck, { type: 'LIST_SOURCES' })).ok && (await h.sw.evaluate(() => chrome.action.getBadgeText({}))) === '', 8000);
});

test('with no decks and no UI the engine suspends its AudioContext; a UI hello resumes it', async () => {
  await offscreenEval(h, '__jdsEngine.idleMs = 300, true');
  assert.equal(await offscreenEval(h, '__jdsEngine.ctx.state'), 'running');
  await deck.close();
  await waitFor(() => offscreenEval(h, '__jdsEngine.ctx.state === "suspended"'), 5000);
  deck = await openExtPage(h, 'deck.html');
  await waitFor(() => offscreenEval(h, '__jdsEngine.ctx.state === "running"'), 5000);
  await waitFor(() => deck.evaluate(() => document.getElementById('engineStatus').dataset.status === 'up' && /^Engine ·/.test(document.getElementById('engineText').textContent)), 5000);
  await offscreenEval(h, '__jdsEngine.idleMs = 30000, true');
});

test('a capture warning raised while the deck page is closed is shown when it opens', async () => {
  await deck.close();
  await h.sw.evaluate(() => chrome.runtime.sendMessage({ target: 'engine', type: 'NOTIFY', level: 'warn', text: 'Chrome pages can\'t be captured (raised while closed).' }));
  deck = await openExtPage(h, 'deck.html');
  await waitFor(async () => (await deck.locator('.toast').allTextContents()).some((t) => /raised while closed/.test(t)), 5000);
});

test('a new engine applies the saved settings that come with its first START, before making the deck', async () => {
  await deck.close(); // no deck page: only the hub's START can carry the settings
  const t = await h.context.newPage();
  await t.goto(server.url('a'));
  const tabId = await tabIdFor(h, server.url('a'));
  const r = await h.sw.evaluate(async (id) => {
    await chrome.offscreen.closeDocument();
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'test' });
    const streamId = await new Promise((res, rej) => chrome.tabCapture.getMediaStreamId({ targetTabId: id }, (s) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(s))));
    const settings = { 'pitch.defaultRange': 0.16, 'bpm.range': '78-155', 'rec.format': 'webm', 'master.volume': 0, 'buffer.capSec': 7 };
    const msg = { target: 'engine', type: 'START', tabId: id, streamId, meta: { title: 'A' }, settings };
    for (let i = 0; ; i++) {
      try { return await chrome.runtime.sendMessage(msg); } catch (e) { if (i > 30) throw e; await new Promise((res) => setTimeout(res, 100)); }
    }
  }, tabId);
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = await offscreenEval(h, `(() => { const e = globalThis.__jdsEngine, d = [...e.decks.values()][0];
    return { range: d.params.range, bpm: e.params['bpm.range'], rec: e.params['rec.format'], vol: e.params['master.volume'], cap: e.params['buffer.capSec'] }; })()`);
  assert.deepEqual(got, { range: 0.16, bpm: '78-155', rec: 'webm', vol: 0.5, cap: 240 }, 'persisted keys only, validated');
});
