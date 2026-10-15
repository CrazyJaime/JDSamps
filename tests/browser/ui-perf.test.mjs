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

// ---------------------------------------------------------------- waveform

/** Records fillText calls made on the waveform canvases: [{row, text, x, y}]. */
function spyWaveText() {
  window.__text = [];
  const P = CanvasRenderingContext2D.prototype, fillText = P.fillText;
  P.fillText = function (text, x, y, ...rest) {
    const row = this.canvas.closest && this.canvas.closest('.wave-row');
    if (row) window.__text.push({ row: [...row.parentNode.children].indexOf(row), text: String(text), x, y });
    return fillText.call(this, text, x, y, ...rest);
  };
}

// A busy main thread delivers several snapshots back to back (31 Hz from the engine): only the
// latest one reaches the DOM, once per frame.
test('snapshots that arrive within one frame are rendered once, the latest', async () => {
  const b = await openBoard({ state: threeDecks() });
  const { page } = b;
  try {
    await page.waitForSelector('.deck >> nth=2');
    await page.waitForTimeout(100);
    const r = await page.evaluate(async (s0) => {
      const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
      await frame();
      const title = document.querySelector('.deck [data-title]'), vol = document.getElementById('masterVol'), clock = document.getElementById('clockBpm');
      const recs = [];
      const mo = new MutationObserver((rs) => recs.push(...rs));
      for (const el of [title, vol, clock]) mo.observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
      for (let i = 0; i < 10; i++) {
        const s = structuredClone(s0);
        s.decks[0].title = `Burst ${i}`;
        s.master.params['master.volume'] = i / 10;
        s.clock = { ...s.clock, bpm: 120 + i };
        window.__fake.push({ t: 'state', s });
      }
      recs.push(...mo.takeRecords());
      const during = recs.length;
      await frame();
      await frame();
      recs.push(...mo.takeRecords());
      mo.disconnect();
      // Text writes (childList) on the title and the clock, value writes on the volume knob.
      const n = (el, attr) => recs.filter((m) => (m.target === el || el.contains(m.target)) && (attr ? m.attributeName === attr : m.type !== 'attributes')).length;
      return {
        during, titleWrites: n(title), volWrites: n(vol, 'aria-valuenow'), clockWrites: n(clock),
        shown: [title.textContent, vol.getAttribute('aria-valuenow'), clock.textContent],
      };
    }, threeDecks());
    assert.deepEqual(r, { during: 0, titleWrites: 1, volWrites: 1, clockWrites: 1, shown: ['Burst 9', '0.900', '129.0'] });
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); }
});

test('waveform draws bar numbers at bar lines once bar 1 is known', async () => {
  const T = 60 / 124;
  const state = makeState({
    decks: [
      deck({ playing: false, playhead: 41.3, cue: 2.0, grid: { t0: 2.0, T, bar1: 2.0 } }),
      deck({ id: 2, slot: 2, tabId: 102, playing: false, playhead: 41.3, grid: { t0: 2.0, T, bar1: null } }),
    ],
  });
  const b = await openBoard({ state, init: [spyWaveText] });
  const { page } = b;
  try {
    await page.waitForSelector('.wave-row >> nth=1');
    for (const id of [1, 2]) await b.push(makeWave(id, 60, 124));
    await page.evaluate(() => { window.__text.length = 0; });
    await b.push({ t: 'state', s: { ...state, decks: state.decks.map((d) => ({ ...d, liveEdge: d.liveEdge + 0.01 })) } });
    await page.waitForTimeout(200);
    const { calls, w } = await page.evaluate(() => ({ calls: window.__text, w: document.querySelector('[data-wave]').width }));
    const labels = new Map();
    for (const c of calls.filter((c) => c.row === 0)) labels.set(c.text, c.x);
    assert.ok(labels.size >= 4, `bar labels on deck 1: ${JSON.stringify([...labels])}`);
    assert.equal(calls.filter((c) => c.row === 1).length, 0, 'no bar numbers without bar 1');
    // Bar n starts at bar1 + 4(n-1) beats; the label sits just right of its bar line.
    const cx = Math.round(w / 2), secPerPx = T / 56;
    for (const n of [21, 22]) {
      assert.ok(labels.has(String(n)), `bar ${n} labelled (got ${[...labels.keys()]})`);
      const xLine = cx + (2.0 + 4 * (n - 1) * T - 41.3) / secPerPx;
      const x = labels.get(String(n));
      assert.ok(x >= xLine && x <= xLine + 8, `bar ${n} label at ${x.toFixed(1)}, line at ${xLine.toFixed(1)}`);
    }
    for (const [text] of labels) assert.match(text, /^[1-9]\d*$/);
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); }
});

test('waveform tile cache draws what a fresh render draws', async () => {
  const server = await startStaticServer(ROOT);
  const browser = await launchPlain();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/deck.css`);
    const r = await page.evaluate(async ({ wave }) => {
      const { WaveStore, drawWave } = await import('/ui/waveform.js');
      const W = 1200, H = 80, hop = wave.hop, T = 60 / 124;
      const view = (store, over = {}) => ({
        w: W, h: H, store, playhead: 10, grid: { t0: 0.1, T, bar1: 0.1 }, cue: 2, liveEdge: 20, historyStart: 0, loop: null,
        color: '#22d3ee', pxPerBeat: 56, pxPerSec: 110, playing: true, dpr: 1, ...over,
      });
      const pixels = (g) => g.getImageData(0, 0, W, H).data;
      const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
      const fresh = (data, over) => {
        const s = new WaveStore(); s.add({ tStart: 0, hop, data });
        const g = new OffscreenCanvas(W, H).getContext('2d');
        drawWave(g, view(s, over));
        return pixels(g);
      };
      const store = new WaveStore(), g = new OffscreenCanvas(W, H).getContext('2d');
      // Audio arriving in hops while the deck plays: each tile is painted in pieces.
      const per = 37;
      for (let i = 0; i * per * 3 < wave.data.length; i++) {
        store.add({ tStart: i * per * hop, hop, data: wave.data.slice(i * per * 3, (i + 1) * per * 3) });
        drawWave(g, view(store, { liveEdge: Math.min(20, (i + 1) * per * hop) }));
      }
      drawWave(g, view(store));
      const appended = diff(pixels(g), fresh(wave.data));
      // The engine re-sends its backlog after a reconnect: different audio over the same span.
      const quiet = wave.data.map((v) => v >> 1);
      store.add({ tStart: 0, hop, data: quiet });
      drawWave(g, view(store, { cue: 2.5 }));
      const resent = diff(pixels(g), fresh(quiet, { cue: 2.5 }));
      // A tempo change beyond the stretch slack (×2 corrections, a new grid) repaints at the new scale.
      drawWave(g, view(store, { grid: { t0: 0.1, T: T * 1.1, bar1: 0.1 } }));
      const rescaled = diff(pixels(g), fresh(quiet, { grid: { t0: 0.1, T: T * 1.1, bar1: 0.1 } }));
      return { appended, resent, rescaled };
    }, { wave: makeWave(1, 20, 124) });
    assert.deepEqual(r, { appended: 0, resent: 0, rescaled: 0 });
  } finally { await browser.close(); await server.close(); }
});

/** Times each rAF callback and counts the canvas draw calls it makes. */
function frameProbe() {
  window.__frames = [];
  window.__calls = 0;
  if (window.__countCalls) {
    const P = CanvasRenderingContext2D.prototype;
    for (const k of ['fillRect', 'strokeRect', 'drawImage', 'fill', 'stroke', 'fillText', 'putImageData']) {
      const f = P[k];
      P[k] = function (...a) { window.__calls++; return f.apply(this, a); };
    }
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    const c0 = window.__calls, a = performance.now();
    cb(t);
    window.__frames.push([performance.now() - a, window.__calls - c0]);
  });
}

/** Playing decks with 60 s of waveform, snapshots at 31 Hz for 3 s; returns per-frame stats. */
async function measureBoard({ n = 6, dpr = 2, countCalls }) {
  const state = makeState({ decks: Array.from({ length: n }, (_, i) => deck({ id: i + 1, slot: i + 1, tabId: 100 + i, playhead: 30, liveEdge: 58, historyStart: 0 })) });
  const b = await openBoard({ state, dpr, viewport: { width: 1920, height: 1080 }, init: [`window.__countCalls = ${!!countCalls};`, frameProbe] });
  const { page } = b;
  try {
    await page.waitForSelector(`.wave-row >> nth=${n - 1}`);
    for (let i = 1; i <= n; i++) await b.push(makeWave(i, 60, 124));
    await page.waitForTimeout(300); // first paint of the backlog is not part of steady scrolling
    await page.evaluate((s) => {
      window.__frames.length = 0;
      let k = 0;
      const id = setInterval(() => {
        s.ctxTime += 0.032; s.wallMs = performance.timeOrigin + performance.now();
        for (const d of s.decks) d.playhead += 0.032;
        window.__fake.push({ t: 'state', s });
        if (++k > 94) clearInterval(id);
      }, 32);
    }, state);
    await page.waitForTimeout(3200);
    const frames = await page.evaluate(() => window.__frames);
    assert.deepEqual(b.errors, []);
    const ms = frames.map((f) => f[0]).sort((x, y) => x - y);
    return {
      frames: frames.length,
      avgMs: +(ms.reduce((s, x) => s + x, 0) / ms.length).toFixed(2),
      p95Ms: +ms[Math.floor(ms.length * 0.95)].toFixed(2),
      callsPerFrame: Math.round(frames.reduce((s, f) => s + f[1], 0) / frames.length),
    };
  } finally { await b.close(); }
}

test('6 decks at DPR 2: canvas draw calls per frame stay small', async () => {
  const r = await measureBoard({ countCalls: true });
  console.log(`6 decks dpr 2 (counting): ${JSON.stringify(r)}`);
  // The per-device-pixel-column renderer made ~67,000 draw calls per frame here.
  assert.ok(r.callsPerFrame < 1500, `canvas draw calls per frame: ${r.callsPerFrame}`);
});

test('6 decks at DPR 2: average frame callback fits the budget', async () => {
  const r = await measureBoard({ countCalls: false });
  console.log(`6 decks dpr 2 (timing): ${JSON.stringify(r)}`);
  // Headless software raster; the per-column renderer averaged 10–20 ms here.
  assert.ok(r.avgMs < 6, `average rAF callback ${r.avgMs} ms`);
  assert.ok(r.frames >= 30, `frames rendered in 3 s: ${r.frames}`);
});
