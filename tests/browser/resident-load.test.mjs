// Whole tracks straight onto resident decks, in the real extension: a local file (a blob: URL the
// deck page made) or an audio link, fetched and decoded by the real engine. The deck page stays open
// throughout, so its UI meets loading and resident decks too.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  prepareExtension, launchExtension, makeTrackWav, parseWav, waitFor, installClient, act, set, state, events, offscreenEval, tabIdFor, hubCall,
} from './ext-harness.mjs';

let h, deck, server, origin, tmp, slowClosed = false;
const pageErrors = [];
const files = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decks = async () => (await state(deck)).decks;
const deckWhere = (fn, ms) => waitFor(async () => (await decks()).find(fn), ms);
const engine = (expr) => offscreenEval(h, `(async () => { const e = globalThis.__jdsEngine; ${expr} })()`);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jds-resident-'));
  const wav = (name, opts) => { const b = makeTrackWav(opts); fs.writeFileSync(path.join(tmp, name), b); return parseWav(b).seconds; };
  files.kick = wav('kick.wav', { bpm: 124, seconds: 20 });
  files.long = wav('long.wav', { bpm: 120, seconds: 70, kind: 'mid' });
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(tmp, 'kick.wav'), '-codec:a', 'libmp3lame', '-b:a', '160k', path.join(tmp, 'kick.mp3')]);
  const send = (res, type, file) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(tmp, file))); };
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    switch (u.pathname) {
      case '/kick.mp3': return send(res, 'audio/mpeg', 'kick.mp3');
      case '/linked-kick.wav': return send(res, 'audio/wav', 'kick.wav');
      case '/long.wav': return send(res, 'audio/wav', 'long.wav');
      case '/page.html': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Not audio</title><p>Hello.</p>');
      case '/slow.wav': // headers and a little audio, then nothing until the client gives up
        req.on('close', () => { slowClosed = true; });
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.write(fs.readFileSync(path.join(tmp, 'kick.wav')).subarray(0, 4096));
        setTimeout(() => res.end(), 30000).unref();
        return;
      case '/tab': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Tab track</title><audio src="/linked-kick.wav" loop autoplay></audio>');
      default: res.writeHead(404); return res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  h = await launchExtension({ ext: prepareExtension() });
  deck = await h.context.newPage();
  deck.on('pageerror', (e) => pageErrors.push(String(e)));
  deck.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await deck.goto(`chrome-extension://${h.extId}/deck.html`);
  await hubCall(deck, { type: 'ENSURE_ENGINE' }); // a UI port opened before the engine exists is dropped
  await installClient(deck);
});
after(async () => {
  await h?.close();
  server?.closeAllConnections?.();
  await new Promise((r) => (server ? server.close(r) : r()));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a local file loads onto a resident deck: the whole track, named after the file, cued and ready', async () => {
  const blobUrl = await deck.evaluate(async (u) => {
    const b = await (await fetch(u)).blob();
    return URL.createObjectURL(new File([b], 'kick.mp3', { type: 'audio/mpeg' }));
  }, `${origin}/kick.mp3`);
  assert.match(blobUrl, /^blob:chrome-extension:/);
  const r = await act(deck, null, 'loadFile', { name: 'kick.mp3', blobUrl });
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = await deckWhere((x) => x.title === 'kick' && x.kind === 'resident');
  assert.ok(Math.abs(d.duration - files.kick) < 0.1, `duration ${d.duration}, file ${files.kick}`);
  assert.deepEqual(d.load, { state: 'ready', progress: 1, strategy: null, error: null, report: null });
  assert.equal(d.tabId, null);
  assert.equal(d.liveEdge, d.duration);
  assert.equal(d.historyStart, 0);
  assert.equal(d.playing, false);
  assert.ok(d.cue < 0.05, `cue ${d.cue}`);
  await deckWhere((x) => x.id === d.id && Math.abs(x.playhead - x.cue) < 1e-6 && x.engineRate === 0); // parked on the cue
  assert.equal(d.bpm.state, 'SEARCH');
  assert.ok((await events(deck)).some((e) => /Loaded “kick” on deck \d/.test(e.text)));
});

test('an audio link loads onto a second resident deck, beside the first', async () => {
  const url = `${origin}/linked-kick.wav`;
  const r = await act(deck, null, 'loadUrl', { url });
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = await deckWhere((x) => x.title === 'linked-kick' && x.kind === 'resident');
  assert.ok(Math.abs(d.duration - files.kick) < 1e-3, `duration ${d.duration}, file ${files.kick}`);
  assert.equal(d.url, url);
  const all = await decks();
  assert.equal(all.filter((x) => x.kind === 'resident').length, 2);
  assert.notEqual(all[0].slot, all[1].slot);
});

test('the master snapshot counts the decoded audio the decks hold', async () => {
  const s = await state(deck);
  const sr = s.sampleRate, want = s.decks.filter((x) => x.kind !== 'live').reduce((n, x) => n + Math.round(x.liveEdge * sr) * 8, 0);
  assert.ok(want > 0);
  assert.equal(s.master.residentBytes, want);
});

test('a resident deck plays its own audio, from its buffer', async () => {
  const d = (await decks()).find((x) => x.title === 'kick');
  assert.equal((await act(deck, d.id, 'play')).ok, true);
  await sleep(1500);
  const p = (await decks()).find((x) => x.id === d.id);
  assert.equal(p.playing, true);
  assert.equal(p.engineRate, 1);
  assert.ok(p.playhead > 0.8 && p.playhead < 2.5, `playhead ${p.playhead}`);
  assert.equal(p.starved, false);
  assert.equal((await act(deck, d.id, 'live')).ok, false);
  assert.equal((await act(deck, d.id, 'pause')).ok, true);
});

test('a link that is not audio, or not there, is refused with a reason and leaves no deck', async () => {
  const n = (await decks()).length;
  const html = await act(deck, null, 'loadUrl', { url: `${origin}/page.html` });
  assert.equal(html.ok, false);
  assert.match(html.error, /not audio/);
  const missing = await act(deck, null, 'loadUrl', { url: `${origin}/missing.mp3` });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /404/);
  await waitFor(async () => (await decks()).length === n);
});

test('a deck shows that it is loading, refuses to play meanwhile, and loadCancel stops the fetch and ejects it', async () => {
  const pending = act(deck, null, 'loadUrl', { url: `${origin}/slow.wav` });
  const d = await deckWhere((x) => x.kind === 'loading');
  assert.equal(d.title, 'slow');
  assert.equal(d.load.state, 'loading');
  assert.match(d.load.strategy, /fetching/);
  assert.match((await act(deck, d.id, 'play')).error, /still loading/);
  assert.equal((await act(deck, d.id, 'loadCancel')).ok, true);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /cancel/i);
  await waitFor(() => slowClosed, 5000);
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id));
});

test('a track longer than the resident limit is cut to it, and the deck says so once', async () => {
  set(deck, null, 'resident.limitMin', 1);
  await waitFor(async () => (await state(deck)).master.params['resident.limitMin'] === 1);
  const r = await act(deck, null, 'loadUrl', { url: `${origin}/long.wav` });
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = await deckWhere((x) => x.title === 'long' && x.kind === 'resident');
  assert.ok(Math.abs(d.duration - 60) < 1e-3, `duration ${d.duration}`);
  await waitFor(async () => (await events(deck)).some((e) => /first 1 minute\b/.test(e.text)));
  await sleep(300);
  assert.equal((await events(deck)).filter((e) => /first 1 minute\b/.test(e.text)).length, 1);
  set(deck, null, 'resident.limitMin', 15);
  assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id));
});

test('a decoded track at another sample rate is resampled to the engine\'s before it goes on a deck', async () => {
  const r = await engine(`
    const sr = e.ctx.sampleRate === 44100 ? 48000 : 44100, n = sr * 3, L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / sr);
    const res = await e.serial(() => e.startResidentDeck({ pcm: { L, R: L.slice(), sampleRate: sr }, meta: { title: 'resampled' } }));
    const d = e.decks.get(res.deckId);
    return { res, from: sr, to: e.ctx.sampleRate, frames: Math.round(d.ts.liveEdge * e.ctx.sampleRate), duration: d.duration };
  `);
  assert.equal(r.res.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(r.duration - 3) < 1e-3, JSON.stringify(r));
  assert.ok(Math.abs(r.frames - 3 * r.to) <= 1, JSON.stringify(r));
  assert.equal((await act(deck, r.res.deckId, 'eject')).ok, true);
});

test('a loading deck that holds a tab\'s capture falls back to live, saying why once', async () => {
  const tab = await h.context.newPage();
  await tab.goto(`${origin}/tab`);
  const tabId = await tabIdFor(h, `${origin}/tab`);
  const streamId = await h.sw.evaluate((id) => new Promise((res, rej) => chrome.tabCapture.getMediaStreamId({ targetTabId: id }, (s) => {
    const err = chrome.runtime.lastError; if (err) rej(new Error(err.message)); else res(s);
  })), tabId);
  const r = await engine(`return e.serial(() => e.startLoadingDeck({ tabId: ${tabId}, streamId: ${JSON.stringify(streamId)}, meta: { title: 'Tab track' } }));`);
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = await deckWhere((x) => x.id === r.deckId);
  assert.equal(d.kind, 'loading');
  assert.equal(d.tabId, tabId);
  const f = await engine(`return e.failLoadingToLive(${r.deckId}, 'The page gave nothing to read.');`);
  assert.equal(f.ok, true, JSON.stringify(f));
  const live = await deckWhere((x) => x.id === r.deckId && x.kind === 'live' && x.liveEdge > 1, 10000);
  assert.equal(live.load.state, 'ready');
  assert.equal((await events(deck)).filter((e) => /Deck \d: The page gave nothing to read\./.test(e.text)).length, 1);
  assert.equal((await act(deck, r.deckId, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).some((x) => x.id === r.deckId));
  await tab.close();
});

test('the deck page shows loading and resident decks without errors', () => { assert.deepEqual(pageErrors, []); });
