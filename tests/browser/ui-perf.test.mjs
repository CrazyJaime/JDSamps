// Deck page rendering cost, waveform bar numbers and the screen wake lock (fake engine + hub).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';
import { deck, makeState, makeWave, threeDecks } from './fixtures/mock-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE = fs.readFileSync(path.join(ROOT, 'tests/browser/pages/fake-chrome.js'), 'utf8');
const ART = path.join(ROOT, 'tests/browser/artifacts');

/** deck.html with the fake engine; `init` scripts run before the page's own scripts. */
async function openBoard({ state, dpr = 1, viewport = { width: 1440, height: 900 }, init = [] }) {
  const server = await startStaticServer(ROOT);
  const browser = await launchPlain();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(FAKE);
  await page.addInitScript((s) => { window.__fake.state = s; }, state);
  for (const fn of init) await page.addInitScript(fn);
  await page.goto(`${server.origin}/deck.html`);
  return {
    page,
    errors,
    push: (msg) => page.evaluate((m) => window.__fake.push(m), msg),
    async close() { await browser.close(); await server.close(); },
  };
}

// ---------------------------------------------------------------- wake lock

/** Fake Screen Wake Lock whose sentinels the "browser" releases when the page is hidden. */
function fakeWakeLock() {
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => vis !== 'visible', configurable: true });
  const active = new Set();
  window.__wl = { requests: 0, active };
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request(type) {
        window.__wl.requests++;
        if (type !== 'screen' || vis !== 'visible') return Promise.reject(new DOMException('not visible', 'NotAllowedError'));
        const s = new EventTarget();
        s.released = false;
        s.type = 'screen';
        s.release = () => {
          if (!s.released) { s.released = true; active.delete(s); s.dispatchEvent(new Event('release')); }
          return Promise.resolve();
        };
        return new Promise((r) => setTimeout(() => { active.add(s); r(s); }, 30));
      },
    },
  });
  window.__hide = () => { vis = 'hidden'; for (const s of [...active]) s.release(); document.dispatchEvent(new Event('visibilitychange')); };
  window.__show = () => { vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); };
}

test('wake lock: one lock survives repeated tab switches and is released with no decks', async () => {
  const b = await openBoard({ state: threeDecks(), init: [fakeWakeLock] });
  const { page } = b;
  const wl = () => page.evaluate(() => ({ requests: window.__wl.requests, active: window.__wl.active.size }));
  // Snapshots arrive at ~31 Hz while a request is in flight.
  const burst = async (s) => { for (let i = 0; i < 6; i++) { await b.push({ t: 'state', s }); await page.waitForTimeout(8); } };
  try {
    await page.waitForSelector('.deck >> nth=2');
    await burst(threeDecks());
    await page.waitForTimeout(100);
    assert.deepEqual(await wl(), { requests: 1, active: 1 }, 'one request, one lock after load');
    // Tab switches with no snapshot in between: only the visibilitychange path can re-acquire.
    for (let cycle = 1; cycle <= 3; cycle++) {
      await page.evaluate(() => window.__hide());
      await page.waitForTimeout(20);
      await page.evaluate(() => window.__show());
      await page.waitForTimeout(100);
      assert.equal((await wl()).active, 1, `exactly one active lock after quiet hide/show cycle ${cycle}`);
    }
    // Tab switches with snapshots streaming, including while a request is in flight.
    for (let cycle = 1; cycle <= 3; cycle++) {
      await page.evaluate(() => window.__hide());
      await burst(threeDecks());
      await page.evaluate(() => window.__show());
      await burst(threeDecks());
      await page.waitForTimeout(100);
      assert.equal((await wl()).active, 1, `exactly one active lock after busy hide/show cycle ${cycle}`);
    }
    assert.equal((await wl()).requests, 7, 'one request per visible period, none while one is in flight');
    const none = makeState({ decks: [], clock: { mode: 'none', deckId: null, bpm: null } });
    await b.push({ t: 'state', s: none });
    await page.waitForTimeout(100);
    assert.equal((await wl()).active, 0, 'lock released when no decks are loaded');
    await page.evaluate(() => { window.__hide(); window.__show(); });
    await page.waitForTimeout(100);
    assert.deepEqual(await wl(), { requests: 7, active: 0 }, 'no lock requested without decks');
    await burst(threeDecks());
    await page.waitForTimeout(100);
    assert.equal((await wl()).active, 1, 'lock re-acquired when decks come back');
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); }
});
