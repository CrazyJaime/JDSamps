import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';
import { makeTrackWav } from './ext-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = fs.readFileSync(path.join(ROOT, 'agent/agent-main.js'), 'utf8');
const WAV = makeTrackWav({ bpm: 120, seconds: 4, kind: 'low' });
let server, browser, page; const errors = [];

before(async () => {
  server = await startStaticServer(ROOT, {
    '/tone.wav': (req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(WAV); },
    '/__agent.html': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>agent</title><body>'); },
  });
  browser = await launchPlain();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(AGENT);
  await page.addInitScript(() => {
    window.__status = [];
    window.addEventListener('jds-agent-status', (e) => window.__status.push(JSON.parse(e.detail)));
    window.__cmd = (m) => window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: typeof m === 'string' ? m : JSON.stringify(m) }));
  });
  await page.goto(`${server.origin}/__agent.html`);
});
after(async () => { await browser?.close(); await server?.close(); });

const last = () => page.evaluate(() => window.__status[window.__status.length - 1] || null);

test('passive until commanded, then finds a detached Audio()', async () => {
  await page.evaluate(() => { window.a = new Audio('/tone.wav'); window.a.loop = true; return window.a.play(); });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__status.length), 0, 'no traffic before a command');
  await page.evaluate(() => window.__cmd({ t: 'query' }));
  await page.waitForTimeout(100);
  const s = await last();
  assert.equal(s.t, 'status');
  assert.equal(s.hasMedia, true);
  assert.equal(s.count, 1);
  assert.equal(s.playing, true);
});

test('rate command sets rate with resampling and enforces it against the page', async () => {
  await page.evaluate(() => window.__cmd({ t: 'rate', rate: 1.06 }));
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => [a.playbackRate, a.defaultPlaybackRate, a.preservesPitch]), [1.06, 1.06, false]);
  await page.evaluate(() => { a.playbackRate = 1; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => a.playbackRate), 1.06);
  assert.ok((await page.evaluate(() => window.__status)).some((m) => m.t === 'external-rate' && m.rate === 1));
});

test('release restores the page player', async () => {
  await page.evaluate(() => window.__cmd({ t: 'release' }));
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => [a.playbackRate, a.preservesPitch]), [1, true]);
  await page.evaluate(() => { a.playbackRate = 1.5; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => a.playbackRate), 1.5, 'no longer enforcing');
  await page.evaluate(() => { a.playbackRate = 1; });
});

test('hostile or malformed commands are ignored', async () => {
  for (const m of ['garbage', '{"t":"rate","rate":100}', '{"t":"rate","rate":"x"}', 'null', '{"t":"rate","rate":0.1}', JSON.stringify({ t: 'rate', rate: NaN })]) {
    await page.evaluate((x) => window.__cmd(x), m);
  }
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => a.playbackRate), 1);
  assert.deepEqual(errors, []);
});

test('late injection finds an element that was already playing', async () => {
  const p2 = await browser.newPage();
  await p2.goto(`${server.origin}/__agent.html`);
  await p2.evaluate(() => { window.b = new Audio('/tone.wav'); window.b.loop = true; return window.b.play(); });
  await p2.addScriptTag({ content: AGENT });
  await p2.addScriptTag({ content: AGENT }); // idempotent
  await p2.evaluate(() => {
    window.__status = [];
    window.addEventListener('jds-agent-status', (e) => window.__status.push(JSON.parse(e.detail)));
    window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: JSON.stringify({ t: 'query' }) }));
  });
  await p2.waitForTimeout(100);
  assert.equal((await p2.evaluate(() => window.__status.at(-1))).hasMedia, false, 'detached element unknown before it is touched');
  await p2.evaluate(() => window.b.currentTime);
  await p2.evaluate(() => window.dispatchEvent(new CustomEvent('jds-agent-cmd', { detail: JSON.stringify({ t: 'query' }) })));
  await p2.waitForTimeout(100);
  const s = await p2.evaluate(() => window.__status.at(-1));
  assert.equal(s.hasMedia, true);
  assert.equal(s.count, 1);
  await p2.close();
});
