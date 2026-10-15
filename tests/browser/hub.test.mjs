import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareExtension, launchExtension, startTrackServer, openExtPage, hubCall, tabIdFor, waitFor, installClient, events, offscreenEval,
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
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: 'x' });
  assert.equal(r.ok, false);
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

test('closing the tab ejects its deck', async () => {
  await track.close();
  await waitFor(async () => (await hubCall(deck, { type: 'LIST_SOURCES' })).ok && (await h.sw.evaluate(() => chrome.action.getBadgeText({}))) === '', 8000);
});
