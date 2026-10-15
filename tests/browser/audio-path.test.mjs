// The deck audio path and the main thread: a real Deck with real worklets in a real-time AudioContext.
// The engine shares its renderer main thread with the deck page and the service worker, so the audio
// must not depend on it: no per-chunk round trips, and a stalled main thread must not starve a deck.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { chromium } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server, browser, page; const errors = [];

before(async () => {
  server = await startStaticServer(ROOT);
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${server.origin}/tests/browser/pages/audio-path.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
});
after(async () => { await browser?.close(); await server?.close(); });

const run = (name, arg) => page.evaluate(([n, a]) => window.tests[n](a), [name, arg ?? null]);

test('a playing deck\'s stretcher sends the main thread nothing in steady state (no time updates, no addBuffers replies)', async () => {
  const r = await run('messages', { seconds: 2 });
  const info = JSON.stringify(r);
  const fromStretch = Object.values(r.fromStretch).reduce((a, b) => a + b, 0);
  assert.ok((r.fromInput.chunk || 0) > 30, `the deck is buffering: ${info}`);
  assert.ok(fromStretch <= 2, `stretcher → main messages in 2 s: ${info}`);
});

test('deck audio goes from the input worklet to the stretcher directly: the main thread gets no audio and posts none', async () => {
  const r = await run('messages', { seconds: 2 });
  const info = JSON.stringify(r);
  assert.ok((r.fromInput.chunk || 0) > 30, `the main thread still hears of every chunk (live edge): ${info}`);
  assert.equal(r.inputAudio, 0, `chunk messages to the main thread carry audio: ${info}`);
  assert.equal(r.toStretch.addBuffers || 0, 0, `the main thread forwards audio to the stretcher: ${info}`);
});

test('a 1.8 s main-thread stall does not starve a deck playing with ~1 s of reserve', async () => {
  const r = await run('stall', { reserve: 1, blockMs: 1800 });
  const info = JSON.stringify(r);
  assert.ok(r.blockedMs > 1500, `the main thread was blocked: ${info}`);
  assert.ok(r.before.reserve > 0.6 && r.before.reserve < 1.6, `reserve before the stall: ${info}`);
  assert.equal(r.silentBlocks, 0, `the deck output went silent for ${r.longestSilentMs} ms: ${info}`);
  assert.deepEqual(r.dropouts, { runs: 0, seconds: 0 }, `the stretcher read past its buffered audio: ${info}`);
  assert.deepEqual(r.jumps, [], `the deck jumped (emergency) after the stall: ${info}`);
  assert.equal(r.starved, false, `the deck was marked starved: ${info}`);
});

test('no page errors', () => { assert.deepEqual(errors, []); });
