// background.js — service-worker hub (ES module).
// * Chrome only lets an extension capture a tab after the user invokes it there, so the
//   toolbar icon, the Alt+Shift+A command and the context-menu item all capture the current
//   tab, then open (or focus) the full-page deck.
// * Owns tabCapture stream ids, the offscreen engine's lifetime, the Sources list, downloads,
//   badge, tab lifecycle and player-assist injection.
// * Registers NO runtime.onConnect listener: a receiver that disconnects a port tears it down
//   for every receiver. UI and agent ports go straight to the offscreen engine.
import { TARGET, HUB, ENGINE } from './shared/protocol.js';

const OFFSCREEN = 'offscreen.html';
const DECK = 'deck.html';
const MENU_ID = 'jds-add-tab';
const EXT = chrome.runtime.getURL('');
const capturable = (url) => /^https?:\/\//i.test(url || '');
const originOf = (u) => { try { return new URL(u).origin; } catch (_) { return ''; } };
const fromExtensionPage = (sender) => !!sender && typeof sender.url === 'string' && sender.url.startsWith(EXT);

// ---------------------------------------------------------------- engine
let creating = null;
async function hasEngine() {
  const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
  return c.length > 0;
}
async function ensureEngine() {
  // A document that is still loading already shows up in getContexts(), so wait for any
  // creation in flight before trusting hasEngine().
  if (creating) { await creating; return; }
  if (await hasEngine()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['USER_MEDIA'], justification: 'Capture, mix and record audio from browser tabs.' })
      .finally(() => { creating = null; });
  }
  await creating;
}
async function toEngine(msg) {
  await ensureEngine();
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: TARGET.ENGINE, ...msg });
    } catch (err) {
      // The engine registers its listener while its module loads; retry briefly.
      if (i >= 20 || !/Receiving end does not exist/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
async function engineDecks() {
  if (!(await hasEngine())) return [];
  const r = await chrome.runtime.sendMessage({ target: TARGET.ENGINE, type: ENGINE.PING }).catch(() => null);
  return r && r.ok ? r.decks : [];
}
const notify = (level, text) => toEngine({ type: ENGINE.NOTIFY, level, text }).catch(() => {});

// ---------------------------------------------------------------- grants
async function getGrants() { return (await chrome.storage.session.get('grants')).grants || {}; }
// Grants share one stored object: serialize read-modify-write so concurrent edits don't drop each other.
let grantsQ = Promise.resolve();
function editGrants(fn) {
  const run = grantsQ.then(async () => { const g = await getGrants(); if (fn(g)) await chrome.storage.session.set({ grants: g }); });
  grantsQ = run.catch(() => {});
  return run;
}
async function grant(tab) { await editGrants((g) => { g[tab.id] = originOf(tab.url); return true; }); }
/** Drops a tab's grant, unless it is for `keepOrigin`. */
async function revoke(tabId, keepOrigin) {
  await editGrants((g) => { if (!(tabId in g) || (keepOrigin && g[tabId] === keepOrigin)) return false; delete g[tabId]; return true; });
}

// ---------------------------------------------------------------- capture
function streamIdFor(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(id);
    });
  });
}

async function capture(tabId) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'Bad tab id.' };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: 'That tab is gone.' };
  if (!capturable(tab.url)) return { ok: false, error: 'Only web pages (http/https) can be loaded. Chrome pages cannot be captured.' };
  const on = (await engineDecks()).find((d) => d.tabId === tabId);
  if (on) return { ok: false, error: `That tab is already on deck ${on.slot}.` };
  let streamId;
  try {
    streamId = await streamIdFor(tabId);
  } catch (err) {
    return {
      ok: false,
      error: /invoked|activeTab/i.test(err.message)
        ? 'Chrome needs you to click the JD Samps icon on that tab (or press Alt+Shift+A there) before it can be loaded.'
        : `Chrome refused to capture that tab: ${err.message}`,
    };
  }
  return toEngine({ type: ENGINE.START, tabId, streamId, meta: { title: tab.title || '', url: tab.url || '', favIconUrl: tab.favIconUrl || '' } });
}

async function deckTab() {
  const [t] = await chrome.tabs.query({ url: chrome.runtime.getURL(DECK) });
  return t || null;
}
async function openDeck(focus = true) {
  const t = await deckTab();
  if (t) {
    if (focus) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
    return t;
  }
  return chrome.tabs.create({ url: chrome.runtime.getURL(DECK), active: true });
}

async function invoke(tab, { focusDeck }) {
  const deckOpen = !!(await deckTab());
  if (tab && tab.id != null && capturable(tab.url)) {
    await grant(tab);
    const r = await capture(tab.id);
    if (!r.ok) await notify('warn', r.error);
  }
  await openDeck(focusDeck || !deckOpen);
}

chrome.action.onClicked.addListener((tab) => { invoke(tab, { focusDeck: true }); });
chrome.commands.onCommand.addListener((cmd, tab) => { if (cmd === 'add-tab') invoke(tab, { focusDeck: false }); });
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === MENU_ID) invoke(tab, { focusDeck: false }); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Add this tab to JD Samps', contexts: ['page', 'frame', 'audio', 'video'] });
  });
});

// ---------------------------------------------------------------- sources
async function listSources() {
  const [tabs, grants, decks] = await Promise.all([chrome.tabs.query({}), getGrants(), engineDecks()]);
  const slot = new Map(decks.map((d) => [d.tabId, d.slot]));
  const rows = tabs.filter((t) => t.id != null && capturable(t.url)).map((t) => ({
    id: t.id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '', audible: !!t.audible,
    granted: grants[t.id] === originOf(t.url), deckSlot: slot.get(t.id) ?? null,
  }));
  rows.sort((a, b) => (a.deckSlot ? 0 : 1) - (b.deckSlot ? 0 : 1) || (b.audible - a.audible));
  return { ok: true, tabs: rows };
}

// ---------------------------------------------------------------- downloads
// One storage key per download ('dl:<id>' → blob URL), so concurrent downloads never overwrite
// each other's entry.
const dlKey = (id) => `dl:${id}`;
const settledState = (s) => s === 'complete' || s === 'interrupted';
async function download(url, filename) {
  if (typeof url !== 'string' || !url.startsWith(`blob:${EXT.slice(0, -1)}`)) return { ok: false, error: 'Bad download url.' };
  if (typeof filename !== 'string' || !/^[\w .()-]{1,120}\.(wav|webm)$/.test(filename)) return { ok: false, error: 'Bad file name.' };
  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    await chrome.storage.session.set({ [dlKey(id)]: url });
    // A small blob can finish before its entry is stored, when onChanged finds nothing to report.
    const [item] = await chrome.downloads.search({ id }).catch(() => []);
    if (item && settledState(item.state)) downloadDone(id, item.state, item.error);
    return { ok: true, downloadId: id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
/** Reports a finished download to the engine once its entry is found (the engine ignores repeats). */
async function downloadDone(id, state, error) {
  const key = dlKey(id);
  const url = (await chrome.storage.session.get(key))[key];
  if (!url) return;
  await chrome.storage.session.remove(key);
  toEngine({ type: ENGINE.DOWNLOAD_DONE, url, ok: state === 'complete', error: error || undefined }).catch(() => {});
}
chrome.downloads.onChanged.addListener((d) => {
  if (d.state && settledState(d.state.current)) downloadDone(d.id, d.state.current, d.error ? d.error.current : undefined);
});

// ---------------------------------------------------------------- player-assist agent
async function connectAgent(tabId) {
  const ask = () => chrome.tabs.sendMessage(tabId, { jds: 'connect' });
  try { await ask(); return { ok: true }; } catch (_) { /* not injected yet (tab predates install) */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['agent/agent-main.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['agent/agent-relay.js'] });
    await ask();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Player assist is unavailable on this page: ${err.message}` };
  }
}

// ---------------------------------------------------------------- tab lifecycle
async function deckTabIds() { return ((await chrome.storage.session.get('decks')).decks || []).map((d) => d.tabId); }
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await revoke(tabId);
  if ((await deckTabIds()).includes(tabId) && (await hasEngine())) {
    chrome.runtime.sendMessage({ target: TARGET.ENGINE, type: ENGINE.EJECT, tabId }).catch(() => {});
  }
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) await revoke(tabId, originOf(info.url));
  if (!(await deckTabIds()).includes(tabId)) return;
  if (info.title || info.favIconUrl || info.url) {
    toEngine({ type: ENGINE.META, tabId, meta: { title: tab.title || '', url: tab.url || '', favIconUrl: tab.favIconUrl || '' } }).catch(() => {});
  }
  if (info.status === 'complete') connectAgent(tabId);
});

async function badge(decks) {
  await chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  await chrome.action.setBadgeText({ text: decks.length ? String(decks.length) : '' });
}

// ---------------------------------------------------------------- router
async function handle(msg) {
  switch (msg.type) {
    case HUB.ENSURE_ENGINE: await ensureEngine(); return { ok: true };
    case HUB.LIST_SOURCES: return listSources();
    case HUB.LOAD_TAB: return capture(msg.tabId);
    case HUB.GOTO_TAB: {
      if (!Number.isInteger(msg.tabId)) return { ok: false, error: 'Bad tab id.' };
      const t = await chrome.tabs.update(msg.tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true };
    }
    case HUB.DOWNLOAD: return download(msg.url, msg.filename);
    case HUB.AGENT_CONNECT: return Number.isInteger(msg.tabId) ? connectAgent(msg.tabId) : { ok: false, error: 'Bad tab id.' };
    case HUB.DECKS_CHANGED: {
      const decks = Array.isArray(msg.decks) ? msg.decks.filter((d) => Number.isInteger(d.tabId) && Number.isInteger(d.slot)) : [];
      await chrome.storage.session.set({ decks });
      await badge(decks);
      return { ok: true };
    }
    default: return { ok: false, error: `Unknown hub message ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.HUB) return false;
  if (!fromExtensionPage(sender)) { sendResponse({ ok: false, error: 'forbidden' }); return false; }
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
