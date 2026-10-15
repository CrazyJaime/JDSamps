import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain, chromium } from './playwright.mjs';
import { makeTrackWav, prepareExtension, launchExtension } from './ext-harness.mjs';

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
// window.__update() acts out an extension update: the old runtime dies (its port drops, its id is
// gone, connect throws) and a fresh chrome.runtime takes its place, with a new window.__eng.
function FAKE_CHROME() {
  function make() {
    const hub = [];
    const eng = { posted: [], times: [], cmdAt: {}, connects: 0, msg: [], gone: [] };
    const port = {
      postMessage: (m) => { eng.posted.push(m); eng.times.push(performance.now()); }, disconnect() {},
      onMessage: { addListener: (f) => eng.msg.push(f) }, onDisconnect: { addListener: (f) => eng.gone.push(f) },
    };
    eng.send = (m) => eng.msg.forEach((f) => f(m));
    eng.die = () => eng.gone.forEach((f) => f());
    eng.ask = () => hub.forEach((f) => f({ jds: 'connect' }, {}, () => {}));
    window.__eng = eng;
    const runtime = { id: 'ext', connect: () => { eng.connects++; return port; }, onMessage: { addListener: (f) => hub.push(f) }, lastError: undefined };
    Object.defineProperty(window, 'chrome', { value: { runtime }, configurable: true, writable: true });
    return { eng, runtime };
  }
  let cur = make();
  window.__update = () => {
    const old = cur;
    old.eng.die();
    old.runtime.id = undefined;
    old.runtime.connect = () => { throw new Error('Extension context invalidated.'); };
    cur = make();
  };
}

// Intensive wake-up throttling (a tab hidden for 5 minutes): every page timer fires a minute late.
function SLOW_TIMERS() {
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  window.setTimeout = (fn, ms = 0, ...a) => st(fn, ms + 60000, ...a);
  window.setInterval = (fn, ms = 0, ...a) => si(fn, ms + 60000, ...a);
}

// A timer that fires although it was cleared: the agent must not trust a timer on its own.
function STICKY_TIMERS() { window.clearTimeout = () => {}; }

// Counts the WeakRefs the agent makes and how many of them are garbage collected.
function COUNT_WEAKREFS() {
  const Real = WeakRef, n = { made: 0, freed: 0 };
  const fr = new FinalizationRegistry(() => { n.freed++; });
  window.__wr = n;
  window.WeakRef = class WeakRef extends Real { constructor(t) { super(t); n.made++; fr.register(this, 0); } };
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
async function agentPage({ init = [] } = {}) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  for (const fn of init) await p.addInitScript(fn);
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

// The engine keeps a rate alive every second; the agent lets go of the page after LET_GO without
// a command. That is long enough to ride out a stalled engine (a busy main thread holds its
// keep-alives back for seconds); a dead engine is let go of at once by the relay (onDisconnect).
const LET_GO = 10000;

describe('watchdog', { concurrency: 3 }, () => {
  test('the agent lets go of the page by itself when the engine goes quiet, says so, and takes only a new command', async () => {
    const p = await agentPage();
    await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; window.a = a; return a.play(); });
    await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02, seq: 5 }));
    await p.waitForTimeout(1500);
    await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02, seq: 5 })); // keep-alive
    await p.waitForTimeout(LET_GO - 1500);
    assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1.02, false], `still held ${(LET_GO - 1500) / 1000} s after a keep-alive`);
    assert.ok(!(await lastOf(p)).selfReleased);
    const t0 = await p.evaluate(() => performance.timeOrigin + performance.now());
    await p.waitForTimeout(3000);
    assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1, true], `released ${(LET_GO + 1500) / 1000} s after the last command`);
    // The engine is told the page let go by itself, and when (wall-clock ms), so a stall is not
    // taken for a page that refused the rate.
    const s = await lastOf(p);
    assert.deepEqual([s.rate, s.seq, s.selfReleased], [1, 5, true], JSON.stringify(s));
    assert.ok(s.releasedAt > t0 - 500 && s.releasedAt < t0 + 1600, `released at ${s.releasedAt - t0} ms`);
    // A keep-alive of the old command (an engine back from a stall) does not take the page back.
    await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02, seq: 5 }));
    await p.waitForTimeout(100);
    assert.equal(await p.evaluate(() => a.playbackRate), 1);
    assert.equal((await lastOf(p)).selfReleased, true);
    // A new command does.
    await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.0025, seq: 6 }));
    await p.waitForTimeout(100);
    assert.equal(await p.evaluate(() => a.playbackRate), 1.0025);
    const s2 = await lastOf(p);
    assert.deepEqual([s2.rate, s2.seq, s2.selfReleased, s2.releasedAt], [1.0025, 6, undefined, undefined]);
    await p.evaluate(() => window.__cmd({ t: 'release', seq: 7 }));
    await p.evaluate(() => { a.playbackRate = 1.25; });
    await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => a.playbackRate), 1.25, 'the page owns its speed again');
    assert.equal((await lastOf(p)).selfReleased, undefined, 'an engine release is not a self-release');
    await p.close();
  });

  test('with page timers a minute late the agent still lets go after the timeout', async () => {
    const p = await agentPage({ init: [SLOW_TIMERS] });
    await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; window.a = a; return a.play(); });
    await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02, seq: 1 }));
    await p.waitForTimeout(LET_GO - 1000);
    assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1.02, false], `held ${(LET_GO - 1000) / 1000} s after the command`);
    await p.waitForTimeout(1800);
    assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1, true], `released ${(LET_GO + 800) / 1000} s after the command, with no timer`);
    assert.equal((await lastOf(p)).selfReleased, true);
    await p.close();
  });

  test('a stale watchdog timer never lets go while the engine keeps the rate alive', async () => {
    const p = await agentPage({ init: [STICKY_TIMERS] });
    await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; window.a = a; return a.play(); });
    const t0 = Date.now();
    await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02, seq: 1 }));
    // Keep-alives every 0.8 s, so a stale timer would fire between two of them.
    let next = 800;
    const seen = [];
    while (Date.now() - t0 < LET_GO + 1600) {
      if (Date.now() - t0 >= next) { await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02, seq: 1 })); next += 800; }
      seen.push([Date.now() - t0, await p.evaluate(() => a.playbackRate)]);
      await p.waitForTimeout(100);
    }
    assert.deepEqual(seen.filter(([, r]) => r !== 1.02), [], 'never released while keep-alives keep coming');
    await p.close();
  });
});

// Counts the listeners added to media elements, and the distinct functions they use.
function COUNT_LISTENERS() {
  const add = EventTarget.prototype.addEventListener, fns = new Set();
  window.__ls = { n: 0, fns };
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (this instanceof HTMLMediaElement) { window.__ls.n++; fns.add(fn); }
    return add.call(this, type, fn, opts);
  };
}

test('a page that is never decked gets no listener on its media elements; the first command adds them, one handler for all', async () => {
  const p = await agentPage({ init: [COUNT_LISTENERS] });
  await p.evaluate(() => {
    window.els = [];
    for (let i = 0; i < 20; i++) { const m = new Audio('/tone.wav'); m.muted = true; m.loop = true; window.els.push(m); m.play(); }
  });
  await p.waitForTimeout(200);
  assert.equal(await p.evaluate(() => window.__ls.n), 0, 'no listeners while passive');
  await p.evaluate(() => window.__cmd({ t: 'query' }));
  await p.waitForTimeout(100);
  const r = await p.evaluate(() => ({ n: window.__ls.n, fns: window.__ls.fns.size }));
  assert.ok(r.n >= 20 * 7, `listeners after the first command: ${r.n}`);
  assert.ok(r.fns <= 2, `distinct listener functions: ${r.fns}`);
  // Elements played after the first command are wired at once; their events reach the status.
  await p.evaluate(() => { const b = new Audio('/tone.wav'); b.loop = true; window.b = b; return b.play(); });
  await p.waitForTimeout(400);
  const s = await lastOf(p);
  assert.deepEqual([s.count, s.audible, s.playing], [21, 1, true], JSON.stringify(s));
  await p.evaluate(() => window.b.pause());
  await p.waitForTimeout(400);
  assert.equal((await lastOf(p)).audible, 0, 'the pause reached the status');
  assert.deepEqual(errors, []);
  await p.close();
});

/** JS heap growth per element over `n` `new Audio().play()` calls the page drops, after full GCs. */
async function heapPerElement(page, cdp, n) {
  const gc = async () => { for (let i = 0; i < 4; i++) { await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(50); } };
  await page.evaluate(() => {
    window.__sfx = (k) => { for (let i = 0; i < k; i++) { const a = new Audio(); a.muted = true; a.play().catch(() => {}); } };
    window.__sfx(10); // warm up: compile, inline caches, the agent's first registrations
  });
  await page.waitForTimeout(300);
  await gc();
  const h0 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  await page.evaluate((k) => window.__sfx(k), n);
  await page.waitForTimeout(500);
  await gc();
  return ((await cdp.send('Runtime.getHeapUsage')).usedSize - h0) / n;
}

test('with the extension, a page that is never decked holds at most ~150 B more JS heap per media element it plays', async () => {
  // Sound effects and feeds play thousands of short-lived elements. Chrome keeps an element whose
  // play() is pending alive, with or without the agent: what the agent adds is its registry entry.
  const N = 5000;
  const plain = await launchPlain();
  let base, ext;
  try {
    const p = await plain.newPage();
    await p.goto(`${server.origin}/__agent.html`);
    base = await heapPerElement(p, await p.context().newCDPSession(p), N);
  } finally { await plain.close(); }
  const h = await launchExtension({ ext: prepareExtension() });
  try {
    const p = await h.context.newPage();
    await p.goto(`${server.origin}/__agent.html`);
    assert.ok(!(await p.evaluate(() => Function.prototype.toString.call(HTMLMediaElement.prototype.play))).includes('[native code]'), 'the agent is in the page');
    ext = await heapPerElement(p, await h.context.newCDPSession(p), N);
  } finally { await h.close(); }
  console.log(`JS heap per element: ${ext.toFixed(1)} B with the extension, ${base.toFixed(1)} B without`);
  assert.ok(ext - base <= 150, `the agent adds ${(ext - base).toFixed(0)} B per element (${ext.toFixed(0)} vs ${base.toFixed(0)} B)`);
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

test('stop pauses every playing element, in the DOM or detached, and counts the heard ones', async () => {
  const p = await agentPage();
  await p.evaluate(async () => {
    document.body.innerHTML = '<audio id="el" src="/tone.wav" loop autoplay></audio>'; // never play()ed: found by the scan
    const d = new Audio('/tone.wav'); d.loop = true; window.d = d;
    const m = new Audio('/tone.wav'); m.loop = true; m.muted = true; window.m = m;
    await Promise.all([d.play(), m.play()]);
    const el = document.getElementById('el');
    if (el.paused) await new Promise((r) => el.addEventListener('playing', r, { once: true }));
  });
  assert.deepEqual(await p.evaluate(() => [document.getElementById('el').paused, d.paused, m.paused]), [false, false, false]);
  await p.evaluate(() => window.__cmd({ t: 'stop' })); // a stop is a first command too
  await p.waitForTimeout(100);
  assert.deepEqual(await p.evaluate(() => [document.getElementById('el').paused, d.paused, m.paused]), [true, true, true]);
  assert.deepEqual(await p.evaluate(() => window.__status.filter((x) => x.t === 'stopped')), [{ t: 'stopped', count: 2 }], 'the muted one is paused but not counted');
  await p.close();
});

test("stop gives the page its own rate back before pausing; a page with no media answers count 0", async () => {
  const p = await agentPage();
  await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; a.playbackRate = 1.5; window.a = a; return a.play(); });
  await p.evaluate(() => window.__cmd({ t: 'rate', rate: 1.02, seq: 4 }));
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => a.playbackRate), 1.02);
  await p.evaluate(() => window.__cmd({ t: 'stop' }));
  await p.waitForTimeout(100);
  assert.deepEqual(await p.evaluate(() => [a.paused, a.playbackRate, a.preservesPitch]), [true, 1.5, true]);
  assert.deepEqual(await p.evaluate(() => window.__status.filter((x) => x.t === 'stopped')), [{ t: 'stopped', count: 1 }]);
  const q = await agentPage();
  await q.evaluate(() => window.__cmd({ t: 'stop' }));
  await q.waitForTimeout(100);
  assert.deepEqual(await q.evaluate(() => window.__status), [{ t: 'stopped', count: 0 }]);
  assert.deepEqual(errors, []);
  await p.close(); await q.close();
});

/** A page running agent-relay.js against FAKE_CHROME, with the real agent-main.js or a stand-in. */
async function relayPage({ main = true, relayFirst = false, init = [] } = {}) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  for (const fn of init) await p.addInitScript(fn);
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

// In the extension the relay's world is isolated, so only the service worker (executeScript) can
// call __jdsStop; in these plain test pages it is simply on window.
test('the relay passes a stop to its agent and answers with the count, or 0 when the agent is silent', async () => {
  const p = await relayPage();
  await p.evaluate(() => { const a = new Audio('/tone.wav'); a.loop = true; window.a = a; return a.play(); });
  await p.evaluate(() => window.__eng.ask());
  await p.waitForTimeout(200);
  assert.deepEqual(await p.evaluate(() => window.__jdsStop()), { t: 'stopped', count: 1 });
  assert.equal(await p.evaluate(() => a.paused), true);
  await p.waitForTimeout(200);
  assert.ok(!(await p.evaluate(() => window.__eng.posted)).some((m) => m.t === 'stopped'), 'the answer does not go up the engine port');
  const q = await relayPage({ main: false }); // a stand-in that never answers
  const t0 = Date.now();
  assert.deepEqual(await q.evaluate(() => window.__jdsStop()), { t: 'stopped', count: 0 });
  assert.ok(Date.now() - t0 < 1000, `answered after ${Date.now() - t0} ms`);
  // A forged or malformed answer is not taken.
  const pend = q.evaluate(() => window.__jdsStop());
  await q.evaluate(() => { window.__toRelay({ t: 'stopped', count: -3 }); window.__toRelay({ t: 'stopped', count: 'x' }); });
  assert.deepEqual(await pend, { t: 'stopped', count: 0 });
  await p.close(); await q.close();
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

// ---------------------------------------------------------------- background tabs
// Chrome throttles timers in hidden tabs (1 Hz, then once a minute), but not message events: the
// command → status path must not wait on a timer anywhere, in the agent or in the relay.

test('with page timers a minute late (a long-hidden tab) every rate command is confirmed at once and the rate holds', async () => {
  const p = await relayPage({ init: [SLOW_TIMERS] });
  await p.evaluate(() => { const a = document.createElement('audio'); a.src = '/tone.wav'; a.loop = true; document.body.append(a); window.a = a; return a.play(); });
  await p.evaluate(() => window.__eng.ask());
  await p.waitForTimeout(150);
  assert.equal(await p.evaluate(() => window.__eng.connects), 1);
  const rate = (r, seq, ramp) => p.evaluate(([r, seq, ramp]) => {
    if (ramp) window.__eng.cmdAt[seq] = performance.now();
    window.__eng.send({ t: 'rate', rate: r, seq });
  }, [r, seq, ramp]);
  // The engine ramps a step every 250 ms, then keeps the rate alive every second.
  let seq = 100;
  for (let i = 1; i <= 8; i++) { await rate(1 + 0.0025 * i, ++seq, true); await p.waitForTimeout(250); }
  for (let i = 0; i < 4; i++) { await rate(1.02, seq, false); await p.waitForTimeout(1000); }
  const lags = await p.evaluate(() => {
    const e = window.__eng;
    return Object.entries(e.cmdAt).map(([q, at]) => {
      const i = e.posted.findIndex((m) => m.t === 'status' && m.seq === Number(q));
      return { seq: Number(q), lag: i < 0 ? null : Math.round(e.times[i] - at), rate: i < 0 ? null : e.posted[i].rate };
    });
  });
  assert.equal(lags.length, 8);
  for (const [i, l] of lags.entries()) {
    assert.ok(l.lag != null && l.lag < 100, `seq ${l.seq} confirmed after ${l.lag} ms`);
    assert.ok(Math.abs(l.rate - (1 + 0.0025 * (i + 1))) < 1e-9, `seq ${l.seq} confirms rate ${l.rate}`);
  }
  assert.deepEqual(await p.evaluate(() => [a.playbackRate, a.preservesPitch]), [1.02, false], 'still held after 4 s of keep-alives');
  await p.close();
});

test('a relay left behind by an extension update is replaced, so assist works again without a reload', async () => {
  const p = await relayPage();
  await p.evaluate(() => { const a = document.createElement('audio'); a.src = '/tone.wav'; a.loop = true; document.body.append(a); window.a = a; return a.play(); });
  await p.evaluate(() => window.__eng.ask());
  await p.waitForTimeout(150);
  assert.equal(await p.evaluate(() => window.__eng.connects), 1);
  await p.evaluate(() => window.__update());
  // What connectAgent injects when the tab does not answer.
  await p.addScriptTag({ content: AGENT });
  await p.addScriptTag({ content: RELAY });
  await p.evaluate(() => window.__eng.ask());
  await p.waitForTimeout(150);
  assert.equal(await p.evaluate(() => window.__eng.connects), 1, 'the new relay connects to the new engine');
  await p.evaluate(() => window.__eng.send({ t: 'rate', rate: 1.04, seq: 3 }));
  await p.waitForTimeout(150);
  assert.equal(await p.evaluate(() => a.playbackRate), 1.04);
  assert.deepEqual(await p.evaluate(() => { const m = window.__eng.posted.filter((x) => x.t === 'status').at(-1); return [m.rate, m.seq]; }), [1.04, 3]);
  assert.deepEqual(await p.evaluate(() => window.__jdsStop()), { t: 'stopped', count: 1 }, 'an eject reaches the page through the new relay');
  await p.close();
});

test('on a page that is never decked the agent does not keep a reference per media element it ever saw', async () => {
  const gcBrowser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc'] });
  try {
    const p = await gcBrowser.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.addInitScript(COUNT_WEAKREFS);
    await p.addInitScript(AGENT);
    await p.addInitScript(WIRE);
    await p.goto(`${server.origin}/__agent.html`);
    // A feed that creates and drops media elements for hours, each touched once.
    const churn = (k) => p.evaluate((k) => { for (let i = 0; i < k; i++) new Audio().pause(); }, k);
    const collect = () => p.evaluate(async () => { for (let i = 0; i < 4; i++) { gc(); await new Promise((r) => setTimeout(r, 25)); } });
    await churn(2000);
    await collect();
    await churn(3000);
    await collect();
    const n = await p.evaluate(() => window.__wr);
    assert.equal(n.made, 5000);
    assert.ok(n.freed >= 1500, `references to collected elements still held: ${n.made - n.freed} of ${n.made}`);
    assert.equal(await p.evaluate(() => window.__status.length), 0, 'still passive');
  } finally { await gcBrowser.close(); }
});
