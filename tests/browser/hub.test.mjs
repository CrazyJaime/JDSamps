import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareExtension, launchExtension, startTrackServer, openExtPage, hubCall, tabIdFor, waitFor, installClient, events, offscreenEval, act, state,
} from './ext-harness.mjs';

let h, server, deck, track, other;
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
