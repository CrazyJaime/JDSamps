// background.js — service worker / hub.
//
// Responsibilities:
//   * Owns the chrome.tabCapture API (only available in the worker).
//   * Creates & owns the single offscreen document that does the actual
//     getUserMedia / Web Audio / recording work.
//   * Relays control messages from the popup to the offscreen document.
//   * Caches the latest state pushed up by the offscreen doc so the popup
//     can poll it instantly.

const OFFSCREEN_PATH = 'offscreen.html';

// Latest snapshot pushed up from the offscreen document. The popup polls this.
let cachedState = { tabs: {}, audioContextState: 'unknown' };

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------
let creating = null; // de-dupe concurrent creation

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture and process audio from multiple tabs simultaneously.'
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

// ---------------------------------------------------------------------------
// Messaging to the offscreen document (request/response)
// ---------------------------------------------------------------------------
async function sendToOffscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

// ---------------------------------------------------------------------------
// Tab capture
// ---------------------------------------------------------------------------
async function startCapture(tabId) {
  // Mint a stream id bound to this specific tab. Consumed by the offscreen doc.
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const meta = tab
    ? { title: tab.title || `Tab ${tabId}`, favIconUrl: tab.favIconUrl || '', url: tab.url || '' }
    : { title: `Tab ${tabId}`, favIconUrl: '', url: '' };

  return sendToOffscreen({ type: 'START', tabId, streamId, meta });
}

async function stopCapture(tabId) {
  return sendToOffscreen({ type: 'STOP', tabId });
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // State pushes coming up from the offscreen document.
  if (msg.target === 'background') {
    if (msg.type === 'STATE_UPDATE') {
      cachedState = msg.state;
    } else if (msg.type === 'DOWNLOAD') {
      chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false });
    }
    return false;
  }

  // Control messages from the popup.
  if (msg.target !== 'hub') return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'LIST_TABS': {
          const tabs = await chrome.tabs.query({});
          const list = tabs
            .filter((t) => t.id != null && /^https?:|^file:/.test(t.url || ''))
            .map((t) => ({
              id: t.id,
              title: t.title || t.url || `Tab ${t.id}`,
              favIconUrl: t.favIconUrl || '',
              url: t.url || '',
              audible: !!t.audible,
              muted: !!(t.mutedInfo && t.mutedInfo.muted),
              windowId: t.windowId
            }));
          sendResponse({ ok: true, tabs: list });
          break;
        }
        case 'START':
          await startCapture(msg.tabId);
          sendResponse({ ok: true });
          break;
        case 'STOP':
          await stopCapture(msg.tabId);
          sendResponse({ ok: true });
          break;
        case 'STOP_ALL':
          await sendToOffscreen({ type: 'STOP_ALL' });
          sendResponse({ ok: true });
          break;
        case 'GET_STATE':
          sendResponse({ ok: true, state: cachedState });
          break;
        case 'SET_GAIN':
          await sendToOffscreen({ type: 'SET_GAIN', tabId: msg.tabId, gain: msg.gain });
          sendResponse({ ok: true });
          break;
        case 'SET_MONITOR':
          await sendToOffscreen({ type: 'SET_MONITOR', tabId: msg.tabId, monitor: msg.monitor });
          sendResponse({ ok: true });
          break;
        case 'RECORD_START':
          await sendToOffscreen({ type: 'RECORD_START', tabId: msg.tabId, format: msg.format });
          sendResponse({ ok: true });
          break;
        case 'RECORD_STOP':
          await sendToOffscreen({ type: 'RECORD_STOP', tabId: msg.tabId });
          sendResponse({ ok: true });
          break;
        case 'RECORD_MIX_START':
          await sendToOffscreen({ type: 'RECORD_MIX_START', format: msg.format });
          sendResponse({ ok: true });
          break;
        case 'RECORD_MIX_STOP':
          await sendToOffscreen({ type: 'RECORD_MIX_STOP' });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the channel open for the async response
});
