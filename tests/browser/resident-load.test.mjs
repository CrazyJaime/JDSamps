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
  downloadIds, waitForDownload, bandOnsets, medianBpm,
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
  files.five = wav('five.wav', { bpm: 120, seconds: 300, kind: 'mid' });
  { // a 124 BPM kick whose first beat comes after 0.37 s of silence
    const b = makeTrackWav({ bpm: 124, seconds: 30 }), pad = Buffer.alloc(Math.round(0.37 * 48000) * 2), late = Buffer.concat([b.subarray(0, 44), pad, b.subarray(44)]);
    late.writeUInt32LE(late.length - 8, 4); late.writeUInt32LE(late.length - 44, 40);
    fs.writeFileSync(path.join(tmp, 'late.wav'), late);
    files.lateLead = 0.37;
  }
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(tmp, 'kick.wav'), '-codec:a', 'libmp3lame', '-b:a', '160k', path.join(tmp, 'kick.mp3')]);
  const send = (res, type, file) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(tmp, file))); };
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    switch (u.pathname) {
      case '/kick.mp3': return send(res, 'audio/mpeg', 'kick.mp3');
      case '/linked-kick.wav': return send(res, 'audio/wav', 'kick.wav');
      case '/long.wav': return send(res, 'audio/wav', 'long.wav');
      case '/five.wav': return send(res, 'audio/wav', 'five.wav');
      case '/late.wav': return send(res, 'audio/wav', 'late.wav');
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
  assert.equal(d.bpm.state, 'LOCKED', 'gridded from the whole track at once');
  assert.ok(Math.abs(d.bpm.native - 124) < 0.05, `native ${d.bpm.native}`);
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

test('a resident deck records under its track\'s name, with its own audio', async () => {
  const d = (await decks()).find((x) => x.title === 'kick');
  const known = await downloadIds(h);
  assert.equal((await act(deck, d.id, 'play')).ok, true);
  assert.equal((await act(deck, d.id, 'recStart')).ok, true);
  await sleep(3000);
  assert.equal((await act(deck, d.id, 'recStop')).ok, true);
  const dl = await waitForDownload(h, known);
  assert.equal((await act(deck, d.id, 'pause')).ok, true);
  const name = path.basename(dl.filename);
  assert.match(name, /^JDSamps-D\d-kick-/);
  assert.doesNotMatch(name, /null/i);
  const w = parseWav(fs.readFileSync(dl.filename));
  assert.ok(w.seconds > 2, `recorded ${w.seconds} s`);
  const bpm = medianBpm(bandOnsets(w.mono, w.sr, 'low'));
  assert.ok(Math.abs(bpm - 124) < 2, `recorded ${bpm} BPM, the file is 124`);
});

test('a resident deck plays to the end of its track and stops there, quietly', async () => {
  const d = (await decks()).find((x) => x.title === 'kick');
  await engine(`const d = e.decks.get(${d.id}); d.setCue(d.duration - 1); return true;`); // the input clamp a seek goes through
  await deckWhere((x) => x.id === d.id && Math.abs(x.playhead - (d.duration - 1)) < 1e-6);
  assert.equal((await act(deck, d.id, 'play')).ok, true);
  await sleep(1800);
  const s = await deckWhere((x) => x.id === d.id && !x.playing, 3000);
  assert.equal(s.engineRate, 0);
  assert.ok(Math.abs(s.playhead - s.duration) < 1e-6, `stopped at ${s.playhead} of ${s.duration}`);
  assert.equal((await events(deck)).filter((e) => /ran dry|reserve empty|skipped ahead|buffer/.test(e.text)).length, 0);
});

test('ejecting a resident deck stops no tab, and the hub hears only of decks bound to a tab', async () => {
  const had = new Set((await decks()).map((x) => x.id));
  await engine(`e.hubLog = []; const send = e.hub.bind(e); e.hub = (m) => { e.hubLog.push(m); return send(m); };`);
  const r = await act(deck, null, 'loadUrl', { url: `${origin}/linked-kick.wav` });
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = await deckWhere((x) => !had.has(x.id) && x.kind === 'resident');
  assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id));
  const log = await engine(`const l = e.hubLog.map((m) => ({ type: m.type, tabId: m.tabId, decks: m.decks })); delete e.hub; delete e.hubLog; return l;`);
  assert.deepEqual(log.filter((m) => m.type === 'STOP_TAB'), [], JSON.stringify(log));
  const changed = log.filter((m) => m.type === 'DECKS_CHANGED');
  assert.ok(changed.length >= 2, `the hub was told of the load and the eject: ${JSON.stringify(log)}`);
  for (const m of changed) assert.ok(m.decks.every((x) => Number.isInteger(x.tabId)), JSON.stringify(m));
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

test('a loaded track is beat-gridded the moment it is resident: its tempo, grid, first-beat cue and whole waveform', async () => {
  const r = await act(deck, null, 'loadUrl', { url: `${origin}/late.wav` });
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = await deckWhere((x) => x.title === 'late' && x.kind === 'resident');
  assert.ok(Math.abs(d.bpm.native - 124) < 0.05, `native ${d.bpm.native}`);
  assert.ok(d.grid && Math.abs(60 / d.grid.T - 124) < 0.05, `grid ${JSON.stringify(d.grid)}`);
  assert.ok(Math.abs(d.cue - files.lateLead) < 0.02, `cue ${d.cue}: not on the first beat at ${files.lateLead}`);
  const e = await engine(`const d = e.decks.get(${d.id}); return { canBeat: d.canBeat(), seeded: !!d.tempo.seeded, waveEnd: d.waveEnd() };`);
  assert.equal(e.canBeat, true, 'the deck can beat-match at once');
  assert.equal(e.seeded, true, 'its tempo comes from the whole track');
  assert.ok(e.waveEnd > d.duration - 0.1, `waveform to ${e.waveEnd} of ${d.duration} s`);
});

test('a gridded resident deck takes a typed tempo for its track and keeps it while it plays', async () => {
  const id = (await decks()).find((x) => x.title === 'late').id;
  assert.deepEqual(await act(deck, id, 'setNativeBpm', { bpm: 125 }), { ok: true, error: undefined });
  assert.equal((await act(deck, id, 'play')).ok, true);
  await sleep(1500);
  const d = (await decks()).find((x) => x.id === id);
  assert.ok(Math.abs(d.bpm.native - 125) < 0.01, `native ${d.bpm.native}`);
  assert.equal(d.bpm.manual, 'typed');
  assert.equal((await engine(`return e.decks.get(${id}).canBeat();`)), true);
  assert.equal((await act(deck, id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).some((x) => x.id === id));
});

test('cancelling while the beat is being found stops the load and leaves no deck', async () => {
  const pending = act(deck, null, 'loadUrl', { url: `${origin}/five.wav` });
  const d = await deckWhere((x) => x.title === 'five' && x.kind === 'loading' && /beat/.test(x.load.strategy || ''), 20000);
  assert.equal((await act(deck, d.id, 'loadCancel')).ok, true);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /cancel/i);
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id));
});

test('an MP3 dropped on the deck page\'s board becomes a whole-track deck that shows TRACK and its elapsed and remaining time', async () => {
  const had = new Set((await decks()).map((x) => x.id));
  await deck.evaluate(async (u) => {
    const dt = new DataTransfer();
    dt.items.add(new File([await (await fetch(u)).blob()], 'dropped-kick.mp3', { type: 'audio/mpeg' }));
    const board = document.querySelector('.board');
    for (const type of ['dragenter', 'dragover', 'drop']) board.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, `${origin}/kick.mp3`);
  const d = await deckWhere((x) => !had.has(x.id) && x.title === 'dropped-kick' && x.kind === 'resident', 20000);
  assert.ok(Math.abs(d.duration - files.kick) < 0.1, `duration ${d.duration}, file ${files.kick}`);
  const el = deck.locator('.deck', { has: deck.locator('[data-title]', { hasText: 'dropped-kick' }) });
  await waitFor(async () => (await el.locator('[data-kind]').textContent()).trim() === 'TRACK');
  await waitFor(async () => /^0:00 \/ -0:(19|20)$/.test(await el.locator('[data-time]').textContent()));
  assert.equal(await el.locator('[data-act="live"]').isHidden(), true);
  assert.equal(await el.locator('.reserve').isHidden(), true);
  assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id));
});

test('the deck page shows loading and resident decks without errors', () => { assert.deepEqual(pageErrors, []); });
