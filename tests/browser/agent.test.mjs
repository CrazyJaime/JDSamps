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
const RELAY = fs.readFileSync(path.join(ROOT, 'agent/agent-relay.js'), 'utf8');
const WAV = makeTrackWav({ bpm: 120, seconds: 4, kind: 'low' });
let server, browser, page; const errors = [];

// Test stand-in for agent-relay.js: offers agent-main a channel (at document_start, like the
// relay) and talks to it there.
function WIRE() {
  const chan = '0123456789abcdef'.repeat(2);
  window.__status = [];
  window.addEventListener(`s${chan}`, (e) => window.__status.push(JSON.parse(e.detail)));
  window.__cmd = (m) => window.dispatchEvent(new CustomEvent(`c${chan}`, { detail: typeof m === 'string' ? m : JSON.stringify(m) }));
  window.__bound = !window.dispatchEvent(new CustomEvent('media-channel', { detail: chan, cancelable: true }));
}

// Test stand-in for agent-main.js, for driving agent-relay.js directly: takes the relay's channel.
function MAIN_SIDE() {
  let chan = null;
  window.addEventListener('media-channel', (e) => { if (!chan && typeof e.detail === 'string') { e.preventDefault(); chan = e.detail; } });
  window.dispatchEvent(new CustomEvent('media-channel'));
  window.__toRelay = (m) => window.dispatchEvent(new CustomEvent(`s${chan}`, { detail: JSON.stringify(m) }));
}

// chrome.runtime for agent-relay.js running in a plain page; window.__eng is the engine's end.
function FAKE_CHROME() {
  const hub = [];
  const eng = { posted: [], connects: 0, msg: [], gone: [] };
  const port = {
    postMessage: (m) => eng.posted.push(m), disconnect() {},
    onMessage: { addListener: (f) => eng.msg.push(f) }, onDisconnect: { addListener: (f) => eng.gone.push(f) },
  };
  eng.send = (m) => eng.msg.forEach((f) => f(m));
  eng.die = () => eng.gone.forEach((f) => f());
  eng.ask = () => hub.forEach((f) => f({ jds: 'connect' }, {}, () => {}));
  window.__eng = eng;
  const runtime = { connect: () => { eng.connects++; return port; }, onMessage: { addListener: (f) => hub.push(f) }, lastError: undefined };
  Object.defineProperty(window, 'chrome', { value: { runtime }, configurable: true, writable: true });
}

before(async () => {
  server = await startStaticServer(ROOT, {
    '/tone.wav': (req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(WAV); },
    '/__agent.html': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>agent</title><body>'); },
  });
  browser = await launchPlain();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(AGENT);
  await page.addInitScript(WIRE);
  await page.goto(`${server.origin}/__agent.html`);
});
after(async () => { await browser?.close(); await server?.close(); });

/** A fresh page with the agent injected at document_start and wired like the relay does. */
async function agentPage() {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.addInitScript(AGENT);
  await p.addInitScript(WIRE);
  await p.goto(`${server.origin}/__agent.html`);
  return p;
}
const lastOf = (p) => p.evaluate(() => window.__status.filter((m) => m.t === 'status').at(-1) || null);
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
  // A one-off reset (players do that on load) is simply re-applied; only a page that insists is reported.
  assert.ok(!(await page.evaluate(() => window.__status)).some((m) => m.t === 'external-rate'));
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
  await p2.addScriptTag({ content: AGENT }); // a second copy stays out of the way
  await p2.evaluate(WIRE);
  assert.equal(await p2.evaluate(() => window.__bound), true);
  await p2.evaluate(() => window.__cmd({ t: 'query' }));
  await p2.waitForTimeout(100);
  assert.equal((await p2.evaluate(() => window.__status.at(-1))).hasMedia, false, 'detached element unknown before it is touched');
  await p2.evaluate(() => window.b.currentTime);
  await p2.evaluate(() => window.__cmd({ t: 'query' }));
  await p2.waitForTimeout(100);
  const s = await p2.evaluate(() => window.__status.at(-1));
  assert.equal(s.hasMedia, true);
  assert.equal(s.count, 1);
  await p2.close();
});

test('a page that resets its own rate wins: the agent backs off after a few tries and the loop stops', async () => {
  const p = await agentPage();
  await p.evaluate(() => {
    window.__rc = 0;
    const a = new Audio('/tone.wav'); a.loop = true; window.a = a;
    // Site logic such as a live-edge player or an ad SDK: this player only plays at 1x.
    a.addEventListener('ratechange', () => { window.__rc++; if (a.playbackRate !== 1) a.playbackRate = 1; });
    return a.play();
  });
  await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.03 }));
  await p.waitForTimeout(1000);
  const n = () => p.evaluate(() => ({
    rc: window.__rc, rate: a.playbackRate, pp: a.preservesPitch, dflt: a.defaultPlaybackRate,
    status: window.__status.filter((m) => m.t === 'status').length, ext: window.__status.filter((m) => m.t === 'external-rate'),
  }));
  const n1 = await n();
  assert.ok(n1.rc < 20, `ratechange events in 1 s: ${n1.rc}`);
  assert.ok(n1.status <= 6, `statuses in 1 s: ${n1.status}`);
  assert.deepEqual(n1.ext, [{ t: 'external-rate', rate: 1 }], 'one external-rate when it gives up');
  assert.deepEqual([n1.rate, n1.pp, n1.dflt], [1, true, 1], "the page's rate and pitch setting are back");
  await p.waitForTimeout(1000);
  const n2 = await n();
  assert.equal(n2.rc, n1.rc, 'no more ratechange traffic');
  assert.equal(n2.ext.length, 1);
  await p.close();
});

test("status counts only playing, audible elements; release restores the page's own rate and pitch setting", async () => {
  const p = await agentPage();
  await p.evaluate(() => { const m = new Audio('/tone.wav'); m.loop = true; m.muted = true; window.m = m; return m.play(); });
  await p.evaluate(() => window.__cmd({ t: 'query' }));
  await p.waitForTimeout(150);
  let s = await lastOf(p);
  assert.deepEqual([s.hasMedia, s.playing, s.audible, s.muted], [true, true, 0, true], JSON.stringify(s));
  await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; a.playbackRate = 1.5; a.preservesPitch = false; window.a = a; return a.play(); });
  await p.waitForTimeout(400);
  s = await lastOf(p);
  assert.deepEqual([s.count, s.audible, s.rate, s.muted, s.volume], [2, 1, 1.5, false, 1], JSON.stringify(s));
  await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.0025 }));
  await p.waitForTimeout(100);
  assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1.0025, false]);
  await p.evaluate(() => window.__cmd({ t: 'release' }));
  await p.waitForTimeout(100);
  assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch, a.defaultPlaybackRate]), [1.5, false, 1], 'page player back to its own 1.5x, pitch unlocked');
  assert.deepEqual(await p.evaluate(() => [m.playbackRate, m.preservesPitch, m.defaultPlaybackRate]), [1, true, 1]);
  await p.close();
});

test('the agent lets go of the page by itself when the engine goes quiet', async () => {
  const p = await agentPage();
  await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; window.a = a; return a.play(); });
  await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02 }));
  await p.waitForTimeout(1500);
  await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02 })); // keep-alive
  await p.waitForTimeout(2000);
  assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1.02, false], 'still held 2 s after a keep-alive');
  await p.waitForTimeout(1500);
  assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1, true], 'released 3.5 s after the last command');
  await p.evaluate(() => { a.playbackRate = 1.25; });
  await p.waitForTimeout(200);
  assert.equal(await p.evaluate(() => a.playbackRate), 1.25, 'the page owns its speed again');
  await p.close();
});

test('elements that were only load()ed or pause()d are found too', async () => {
  const p = await agentPage();
  await p.evaluate(() => { window.x = new Audio('/tone.wav'); window.x.load(); window.y = new Audio('/tone.wav'); window.y.pause(); });
  await p.waitForTimeout(200);
  await p.evaluate(() => window.__cmd({ t: 'query' }));
  await p.waitForTimeout(150);
  const s = await lastOf(p);
  assert.equal(s.hasMedia, true);
  assert.equal(s.count, 2);
  assert.deepEqual(errors, []);
  await p.close();
});

/** A page running agent-relay.js against FAKE_CHROME, with the real agent-main.js or a stand-in. */
async function relayPage({ main = true, relayFirst = false } = {}) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.addInitScript(FAKE_CHROME);
  if (relayFirst) await p.addInitScript(RELAY);
  if (main) await p.addInitScript(AGENT); else await p.addInitScript(MAIN_SIDE);
  if (!relayFirst) await p.addInitScript(RELAY);
  await p.goto(`${server.origin}/__agent.html`);
  return p;
}

test('relay and agent find each other whichever runs first', async () => {
  const p = await relayPage({ relayFirst: true });
  await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; window.a = a; return a.play(); });
  await p.evaluate(() => window.__eng.ask());
  await p.waitForTimeout(200);
  assert.equal(await p.evaluate(() => window.__eng.posted.at(-1).audible), 1);
  await p.evaluate(() => window.__eng.send({ t: 'rate', rate: 1.04, seq: 9 }));
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => a.playbackRate), 1.04);
  assert.deepEqual(await p.evaluate(() => [window.__eng.posted.at(-1).rate, window.__eng.posted.at(-1).seq]), [1.04, 9]);
  await p.close();
});

test('the relay gives the page its player back when the engine port goes away', async () => {
  const p = await relayPage();
  await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; window.a = a; return a.play(); });
  await p.evaluate(() => window.__eng.ask());
  await p.waitForTimeout(200);
  assert.equal(await p.evaluate(() => window.__eng.connects), 1);
  assert.equal(await p.evaluate(() => window.__eng.posted.at(-1).hasMedia), true);
  await p.evaluate(() => window.__eng.send({ t: 'rate', rate: 1.04, seq: 5 }));
  await p.waitForTimeout(100);
  assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1.04, false]);
  await p.evaluate(() => window.__eng.die()); // offscreen engine crashed, or the extension was updated
  await p.waitForTimeout(200);
  assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1, true]);
  await p.close();
});

test('the relay forwards at a bounded rate, latest first, and drops repeats', async () => {
  const p = await relayPage({ main: false });
  const st = (count) => ({ t: 'status', hasMedia: true, playing: true, rate: 1, preservesPitch: true, count });
  await p.evaluate(() => window.__eng.ask());
  await p.evaluate((m) => window.__toRelay(m), st(1));
  await p.waitForTimeout(150);
  assert.equal(await p.evaluate(() => window.__eng.posted.length), 1);
  await p.evaluate(([a, b]) => {
    for (let i = 0; i < 2000; i++) {
      window.__toRelay(i % 2 ? a : b);
      if (i === 1000) window.__toRelay({ t: 'external-rate', rate: 1 });
    }
    window.__toRelay(b);
  }, [st(1), st(2)]);
  await p.waitForTimeout(400);
  const posted = await p.evaluate(() => window.__eng.posted);
  assert.ok(posted.length <= 6, `forwarded ${posted.length}`);
  assert.equal(posted.filter((m) => m.t === 'external-rate').length, 1, 'external-rate is never lost');
  assert.equal(posted.filter((m) => m.t === 'status').at(-1).count, 2, 'the latest status wins');
  const n = posted.length;
  for (let i = 0; i < 5; i++) { await p.evaluate((m) => window.__toRelay(m), st(2)); await p.waitForTimeout(120); }
  assert.equal(await p.evaluate(() => window.__eng.posted.length), n, 'identical statuses are not re-sent');
  await p.close();
});

test('a page sees no trace of the agent: no globals, native-looking wrappers, untouched getters', async () => {
  const p = await agentPage();
  const look = () => p.evaluate(() => {
    const proto = HTMLMediaElement.prototype;
    return {
      names: Object.getOwnPropertyNames(window).filter((k) => /jds|jdsamps/i.test(k)),
      syms: Object.getOwnPropertySymbols(window).map(String).filter((k) => /jds|jdsamps/i.test(k)),
      marker: String(window[Symbol.for('jdsamps.agent')]),
      fns: ['play', 'pause', 'load'].map((k) => [proto[k].toString(), proto[k].name, proto[k].length, 'prototype' in proto[k], proto[k].toString.toString()]),
      getters: ['currentTime', 'paused'].map((k) => { const g = Object.getOwnPropertyDescriptor(proto, k).get; return [g.toString(), g.name]; }),
    };
  });
  const r = await look();
  assert.deepEqual(r.names, []);
  assert.deepEqual(r.syms, []);
  assert.equal(r.marker, 'undefined');
  for (const [i, k] of ['play', 'pause', 'load'].entries()) {
    assert.deepEqual(r.fns[i], [`function ${k}() { [native code] }`, k, 0, false, 'function toString() { [native code] }']);
  }
  assert.deepEqual(r.getters, [['function get currentTime() { [native code] }', 'get currentTime'], ['function get paused() { [native code] }', 'get paused']]);
  // Once a deck is talking to the tab the getters help find late elements; they still look native.
  await p.evaluate(() => window.__cmd({ t: 'query' }));
  assert.deepEqual((await look()).getters, r.getters);
  await p.close();
});

test('a page cannot drive the agent or get a status out of it', async () => {
  const p = await agentPage();
  await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; window.a = a; return a.play(); });
  const heard = await p.evaluate(async () => {
    const got = [];
    const hear = (name) => window.addEventListener(name, (e) => got.push([name, e.detail]));
    for (const n of ['jds-agent-status', 'media-channel']) hear(n);
    const send = (name, m) => window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(m) }));
    send('jds-agent-cmd', { t: 'query' });
    send('jds-agent-cmd', { t: 'rate', rate: 1.5 });
    // Try to take over the channel handshake after the relay has already bound it.
    const mine = 'ab'.repeat(16);
    hear(`s${mine}`);
    window.dispatchEvent(new CustomEvent('media-channel'));
    window.dispatchEvent(new CustomEvent('media-channel', { detail: mine, cancelable: true }));
    send(`c${mine}`, { t: 'query' });
    send(`c${mine}`, { t: 'rate', rate: 1.5 });
    await new Promise((r) => setTimeout(r, 300));
    return got.filter(([n, d]) => !(n === 'media-channel' && (d == null || d === mine)));
  });
  assert.deepEqual(heard, []);
  assert.equal(await p.evaluate(() => a.playbackRate), 1);
  assert.equal(await p.evaluate(() => window.__status.length), 0, 'nothing reached the relay either');
  await p.close();
});
