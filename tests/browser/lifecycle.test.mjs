// Ejected decks must not leave AudioWorklet processors running (Chrome keeps calling process() on a
// disconnected node while it returns true). Real Deck, real worklets, real-time AudioContext.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { chromium } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROCS = ['signalsmith-stretch', 'jds-deck-input', 'jds-beatfx', 'jds-recorder'];
let server, browser, page; const errors = [];

before(async () => {
  server = await startStaticServer(ROOT);
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc'] });
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${server.origin}/tests/browser/pages/lifecycle.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
});
after(async () => { await browser?.close(); await server?.close(); });

const run = (name, arg) => page.evaluate(([n, a]) => window.tests[n](a), [name, arg ?? null]);

test('ejected decks leave no stretcher, input, beatfx or recorder processor running', async () => {
  const r = await run('ejectCycles', { n: 4 });
  for (const [i, live] of r.live.entries()) {
    for (const p of PROCS) assert.ok(live[p] > 20, `cycle ${i + 1}: ${p} ran ${live[p]} quanta in 300 ms while loaded`);
  }
  for (const p of PROCS) assert.equal(r.after[p] || 0, 0, `${p}: ${r.after[p]} process() calls in the second after 4 ejects`);
  assert.equal(r.delivered, 4, 'every recording was saved');
  assert.deepEqual(r.errors, []);
});

test('ejected resident decks leave no processor running, never start an input worklet, and record under the track name', async () => {
  const r = await run('residentEjectCycles', { n: 3 });
  for (const [i, live] of r.live.entries()) {
    for (const p of ['signalsmith-stretch', 'jds-beatfx', 'jds-recorder']) assert.ok(live[p] > 20, `cycle ${i + 1}: ${p} ran ${live[p]} quanta in 300 ms while loaded`);
    assert.equal(live['jds-deck-input'] || 0, 0, `cycle ${i + 1}: an input worklet ran for a resident deck`);
  }
  for (const p of PROCS) assert.equal(r.after[p] || 0, 0, `${p}: ${r.after[p]} process() calls in the second after 3 ejects`);
  assert.equal(r.names.length, 3, 'every recording was saved');
  assert.match(r.names[0], /-Resident 1-/);
  assert.match(r.names[1], /-Deck 1-/);
  for (const n of r.names) assert.doesNotMatch(n, /null/i);
  assert.deepEqual(r.errors, []);
});

test('stopping a recording ends its recorder processor while the deck stays loaded', async () => {
  const r = await run('recStop');
  assert.equal(r.state, 'idle');
  assert.equal(r.delivered, 1);
  assert.equal(r.after['jds-recorder'] || 0, 0, `jds-recorder ran ${r.after['jds-recorder']} quanta after REC stopped`);
  assert.ok(r.after['signalsmith-stretch'] > 100, 'the loaded deck keeps running');
});

test('no page errors', () => { assert.deepEqual(errors, []); });
