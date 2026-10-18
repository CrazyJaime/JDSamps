// The pause guard: while a deck is capturing a tab, a pause the tab's own site asks for is
// dropped, so a site that allows one playing track at a time cannot stop a deck's source.
// Each site below is a local model of a way a page stops its player, run twice: on an ordinary
// tab (where the site wins) and on a tab a deck has claimed with `isolate`.
import test, { before, after, describe } from 'node:test';
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
let server, browser; const errors = [];

// Test stand-in for agent-relay.js (as in tests/browser/agent.test.mjs): offers agent-main a
// channel at document_start and collects what comes back.
function WIRE() {
  const chan = '0123456789abcdef'.repeat(2);
  window.__status = [];
  window.addEventListener(`s${chan}`, (e) => window.__status.push(JSON.parse(e.detail)));
  window.__cmd = (m) => window.dispatchEvent(new CustomEvent(`c${chan}`, { detail: JSON.stringify(m) }));
  window.__bound = !window.dispatchEvent(new CustomEvent('media-channel', { detail: chan, cancelable: true }));
}

// ---------------------------------------------------------------- the site models
// Every strike records what it achieved, so the tests read a list of outcomes and never a clock.

// A site that stops its player on a timer, whatever made it decide to (a sibling tab, a session
// check, an ad break): the guard's whole territory, mechanism or no mechanism.
function SITE_TIMER() {
  window.__seen = [];
  window.__start = () => { window.__t = setInterval(() => { window.__a.pause(); window.__seen.push(window.__a.paused); }, 120); };
  window.__stop = () => clearInterval(window.__t);
}

// A site that stops its player by tearing the source out instead of pausing it.
function SITE_SRC() {
  window.__seen = [];
  window.__strike = () => { window.__a.src = ''; window.__seen.push(window.__a.paused); };
}

// A pause button of the page's own, for a real click.
function SITE_BUTTON() {
  window.__seen = [];
  addEventListener('DOMContentLoaded', () => {
    document.getElementById('stop').addEventListener('click', () => { window.__a.pause(); window.__seen.push(window.__a.paused); });
  });
}

before(async () => {
  server = await startStaticServer(ROOT, {
    '/tone.wav': (req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(WAV); },
    '/__iso.html': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>iso</title><body><button id="stop">stop</button>'); },
  });
  browser = await launchPlain();
});
after(async () => { await browser?.close(); await server?.close(); });

/**
 * A tab with the agent at document_start, wired like the relay, and the site's own script after
 * it. `run` evaluates through CDP rather than page.evaluate(), because page.evaluate() carries
 * transient user activation — exactly what the guard looks for to tell a user's pause from a
 * script's. Everything a site model does has to arrive without one.
 */
async function tab({ site } = {}) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.addInitScript(AGENT);
  await p.addInitScript(WIRE);
  if (site) await p.addInitScript(site);
  await p.goto(`${server.origin}/__iso.html`);
  const cdp = await p.context().newCDPSession(p);
  p.run = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  assert.equal(await p.run('window.__bound'), true, 'the agent took the channel');
  return p;
}

const play = (p) => p.run("(() => { const a = window.__a || (window.__a = Object.assign(new Audio('/tone.wav'), { loop: true })); return a.play().then(() => a.paused); })()");
const paused = (p) => p.run('window.__a.paused');
const seen = (p) => p.run('JSON.stringify(window.__seen)').then((s) => JSON.parse(s));
const isolate = (p, on) => p.run(`window.__cmd({ t: 'isolate', on: ${on} })`);
const statuses = (p) => p.run('JSON.stringify(window.__status)').then((s) => JSON.parse(s));

describe('a deck holds its source', { concurrency: 1 }, () => {
  test('a site that pauses its player on a timer gets nowhere at first, then wins once, with no ping-pong', async () => {
    const p = await tab({ site: SITE_TIMER });
    // Control: on an ordinary tab the site stops its player on the first try.
    assert.equal(await play(p), false, 'the track plays');
    await p.run('window.__start()');
    await p.waitForTimeout(400);
    await p.run('window.__stop()');
    const control = await seen(p);
    assert.ok(control.length >= 1 && control.every((x) => x === true), `an ordinary tab is stopped at once: ${JSON.stringify(control)}`);

    // On a deck: the first strikes are dropped, and after a few the agent stops resisting rather
    // than fight the page for ever.
    await isolate(p, true);
    assert.equal(await play(p), false);
    await p.run('window.__seen = []; window.__start()');
    await p.waitForTimeout(1200);
    await p.run('window.__stop()');
    const decked = await seen(p);
    assert.deepEqual(decked.slice(0, 2), [false, false], `the first pauses are dropped: ${JSON.stringify(decked)}`);
    assert.ok(decked.includes(true), 'and the site has it in the end rather than being fought for ever');
    assert.deepEqual((await statuses(p)).filter((m) => m.t === 'external-pause'), [{ t: 'external-pause' }], 'the engine is told once');

    // No ping-pong: the agent never takes the element back and never reports again.
    await p.run('window.__a.play()');
    await p.run('window.__seen = []; window.__start()');
    await p.waitForTimeout(600);
    await p.run('window.__stop()');
    const after = await seen(p);
    assert.ok(after.length >= 1 && after.every((x) => x === true), `no longer resisting: ${JSON.stringify(after)}`);
    assert.equal((await statuses(p)).filter((m) => m.t === 'external-pause').length, 1, 'said once');
    await p.close();
  });

  test('the back-off counts exactly: two pauses dropped, the third taken', async () => {
    const p = await tab();
    assert.equal(await play(p), false);
    await isolate(p, true);
    // One burst, so the back-off window cannot expire between the attempts on a busy machine.
    assert.deepEqual(
      await p.run('(() => { const o = []; for (let i = 0; i < 4; i++) { window.__a.pause(); o.push(window.__a.paused); } return o; })()'),
      [false, false, true, true],
    );
    assert.deepEqual((await statuses(p)).filter((m) => m.t === 'external-pause'), [{ t: 'external-pause' }]);
    await p.close();
  });

  test('a site that stops by emptying src is blocked; a new source and load() are not', async () => {
    const p = await tab({ site: SITE_SRC });
    assert.equal(await play(p), false);
    const src = await p.run('window.__a.src');
    // Control: on an ordinary tab emptying src stops the player.
    await p.run('window.__strike()');
    assert.deepEqual(await seen(p), [true], 'an ordinary tab is torn down');

    await isolate(p, true);
    await p.run(`window.__a.src = ${JSON.stringify(src)}`);
    assert.equal(await play(p), false);
    await p.run('window.__seen = []; window.__strike()');
    assert.deepEqual(await seen(p), [false], 'the teardown is dropped');
    assert.equal(await p.run('window.__a.src'), src, 'and the source is untouched');
    await p.run('window.__a.srcObject = null');
    assert.equal(await paused(p), false);
    // What is deliberately left alone: a real source change (a playlist moving on) and load()
    // (how a player re-buffers or moves on). Seeking is left alone too — nothing wraps the
    // currentTime setter, which the fingerprint test below checks.
    await p.run("window.__a.src = '/tone.wav?next'");
    assert.ok((await p.run('window.__a.src')).endsWith('?next'), 'a new source goes through');
    await p.run('window.__a.load()');
    assert.equal(await play(p), false);
    await p.close();
  });

  test('taking the element out of the document stops it, which the guard cannot see: a known gap', async () => {
    const p = await tab();
    await p.run("document.body.append(Object.assign(window.__a = new Audio('/tone.wav'), { loop: true }))");
    assert.equal(await play(p), false);
    await isolate(p, true);
    await p.run('window.__a.remove()');
    await p.waitForTimeout(300);
    // Chrome's own internal pause steps, not a pause() call: nothing comes through the wrapper,
    // so there is nothing to drop and nothing to report, and putting the element back would be
    // the fight loop the guard exists to avoid.
    assert.deepEqual([await paused(p), await p.run('window.__a.isConnected')], [true, false]);
    assert.deepEqual((await statuses(p)).filter((m) => m.t === 'external-pause'), []);
    // An element that was never in the document is not affected: it plays on, detached.
    await p.run("window.__b = Object.assign(new Audio('/tone.wav'), { loop: true }); void window.__b.play().catch(() => {})");
    await p.waitForTimeout(400);
    assert.equal(await p.run('window.__b.paused'), false);
    await p.close();
  });

  test('a pause the user makes on the tab still works', async () => {
    const p = await tab({ site: SITE_BUTTON });
    assert.equal(await play(p), false);
    await isolate(p, true);
    await p.click('#stop'); // a real click, so the handler runs with transient user activation
    await p.waitForTimeout(200);
    assert.deepEqual(await seen(p), [true], 'the user is obeyed');
    assert.deepEqual((await statuses(p)).filter((m) => m.t === 'external-pause'), [], 'and it is not reported as a fight');
    await p.close();
  });

  test('our own pauses still work: the stop an eject sends pauses the tab and lifts the guard', async () => {
    const p = await tab({ site: SITE_TIMER });
    assert.equal(await play(p), false);
    await isolate(p, true);
    await p.run("window.__cmd({ t: 'stop' })");
    await p.waitForTimeout(150);
    assert.equal(await paused(p), true, 'the eject pauses the tab whatever the guard thinks');
    assert.deepEqual((await statuses(p)).filter((m) => m.t === 'stopped'), [{ t: 'stopped', count: 1 }]);
    // The tab is its site's again.
    assert.equal(await play(p), false);
    await p.run('window.__seen = []; window.__start()');
    await p.waitForTimeout(400);
    await p.run('window.__stop()');
    const after = await seen(p);
    assert.ok(after.length >= 1 && after.every((x) => x === true), `the site has its player back: ${JSON.stringify(after)}`);
    await p.close();
  });

  test('isolate off puts everything back', async () => {
    const p = await tab({ site: SITE_SRC });
    assert.equal(await play(p), false);
    await isolate(p, true);
    await p.run('window.__strike()');
    assert.deepEqual(await seen(p), [false]);
    await isolate(p, false);
    await p.run('window.__seen = []; window.__strike()');
    assert.deepEqual(await seen(p), [true]);
    await p.close();
  });
});

describe('a tab that is not on a deck', { concurrency: 1 }, () => {
  test('is not touched at all: its own script stops its player as it always did', async () => {
    const p = await tab({ site: SITE_SRC });
    assert.equal(await play(p), false);
    assert.deepEqual(
      await p.run('(() => { const o = []; for (let i = 0; i < 4; i++) { window.__a.pause(); o.push(window.__a.paused); } return o; })()'),
      [true, true, true, true],
      'no counting, no resistance',
    );
    assert.equal(await play(p), false);
    await p.run('window.__strike()');
    assert.deepEqual(await seen(p), [true], 'and emptying src is nobody else\'s business');
    assert.deepEqual(await statuses(p), [], 'nothing was reported to the engine either');
    await p.close();
  });

  test('the guard leaves no trace a page can find', async () => {
    const p = await tab();
    const look = () => p.run(`JSON.stringify((() => {
      const proto = HTMLMediaElement.prototype, d = (k) => Object.getOwnPropertyDescriptor(proto, k);
      return {
        names: Object.getOwnPropertyNames(window).filter((k) => /jds|jdsamps/i.test(k)),
        fns: ['play', 'pause', 'load'].map((k) => [proto[k].toString(), proto[k].name, proto[k].length, 'prototype' in proto[k]]),
        setters: ['src', 'srcObject', 'currentTime'].map((k) => [d(k).set.toString(), d(k).set.name, d(k).set.length, d(k).configurable]),
      };
    })())`).then((s) => JSON.parse(s));
    const r = await look();
    assert.deepEqual(r.names, []);
    assert.deepEqual(r.fns, [
      ['function play() { [native code] }', 'play', 0, false],
      ['function pause() { [native code] }', 'pause', 0, false],
      ['function load() { [native code] }', 'load', 0, false],
    ]);
    // currentTime is the untouched native one: a seek is never guarded.
    assert.deepEqual(r.setters, [
      ['function set src() { [native code] }', 'set src', 1, true],
      ['function set srcObject() { [native code] }', 'set srcObject', 1, true],
      ['function set currentTime() { [native code] }', 'set currentTime', 1, true],
    ]);
    // Still native-looking once a deck has claimed the tab.
    await isolate(p, true);
    assert.deepEqual(await look(), r);
    assert.deepEqual(errors, []);
    await p.close();
  });
});
