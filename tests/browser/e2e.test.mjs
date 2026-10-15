// End-to-end: real extension, real captured tabs, real engine. About 3 minutes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareExtension, launchExtension, startTrackServer, openExtPage, hubCall, tabIdFor, waitFor, installClient,
  act, set, state, events, downloadIds, waitForDownload, parseWav, bandOnsets, bandRms, medianBpm, offscreenEval,
} from './ext-harness.mjs';

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
let h, server, deck, tabs = {};
const deckBy = (s, slot) => s.decks.find((d) => d.slot === slot);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record(target, seconds) {
  const known = await downloadIds(h);
  const start = target === 'mix' ? await act(deck, null, 'mixRecStart') : await act(deck, target, 'recStart');
  assert.equal(start.ok, true, JSON.stringify(start));
  await sleep(seconds * 1000);
  if (target === 'mix') await act(deck, null, 'mixRecStop'); else await act(deck, target, 'recStop');
  const dl = await waitForDownload(h, known);
  return { dl, wav: parseWav(fs.readFileSync(dl.filename)) };
}

before(async () => {
  server = await startTrackServer();
  h = await launchExtension({ ext: prepareExtension() });
  for (const k of ['a', 'b']) { tabs[k] = await h.context.newPage(); await tabs[k].goto(server.url(k)); }
  deck = await openExtPage(h, 'deck.html');
  for (const k of ['a', 'b']) {
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, server.url(k)) });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  await installClient(deck);
});
after(async () => { await h?.close(); await server?.close(); });

test('two tabs load as cued decks and start buffering', async () => {
  const s = await state(deck);
  assert.equal(s.decks.length, 2);
  for (const d of s.decks) assert.equal(d.playing, false);
  await sleep(1500);
  const s2 = await state(deck);
  for (const d of s2.decks) assert.ok(d.liveEdge > 1 && d.reserve > 0.5, JSON.stringify({ liveEdge: d.liveEdge, reserve: d.reserve }));
  assert.equal(await deck.locator('.deck').count(), 2);
});

test('deck tabs are kept from being discarded while they are on a deck', async () => {
  for (const k of ['a', 'b']) {
    const t = await h.sw.evaluate((id) => chrome.tabs.get(id), await tabIdFor(h, server.url(k)));
    assert.equal(t.autoDiscardable, false, `tab ${k}`);
  }
});

test('tempo locks on both decks', async () => {
  await waitFor(async () => {
    const s = await state(deck);
    const a = deckBy(s, 1), b = deckBy(s, 2);
    return a.bpm.state === 'LOCKED' && b.bpm.state === 'LOCKED' && Math.abs(a.bpm.native - 124) < 0.3 && Math.abs(b.bpm.native - 128) < 0.3;
  }, 25000);
});

test('SYNC PLAY matches tempo and phase to the master', async () => {
  assert.equal((await act(deck, 2, 'master')).ok, true);
  assert.equal((await act(deck, 2, 'play')).ok, true);
  await sleep(1000);
  // SYNC▶ straight from SYNC off: it must set the tempo before it schedules the start.
  assert.equal(deckBy(await state(deck), 1).sync.on, false);
  assert.equal((await act(deck, 1, 'syncPlay')).ok, true);
  // The rate the engine actually scheduled (not params), read as the deck starts, before any phase
  // bend. Assist steps land at the live edge, seconds ahead of this playhead, so the source rate is 1.
  // (The master's own BPM estimate still settles for a few seconds, so compare against it, not 128.)
  const s0 = await waitFor(async () => { const s = await state(deck); return deckBy(s, 1).engineRate > 0 && s; }, 3000, 20);
  const st = deckBy(s0, 1);
  assert.equal(st.sync.on, true);
  assert.ok(Math.abs(st.bpm.out - s0.clock.bpm) < 0.05, `out ${st.bpm.out} vs clock ${s0.clock.bpm} at start`);
  assert.ok(Math.abs(st.engineRate - (1 + st.params.pitch)) < 0.005, `scheduled rate at start ${st.engineRate}, pitch ${st.params.pitch}`);
  await sleep(6000);
  const s = await state(deck);
  const a = deckBy(s, 1);
  assert.equal(s.clock.mode, 'deck');
  assert.ok(Math.abs(a.params.pitch - (128 / 124 - 1)) < 0.0025, `pitch ${a.params.pitch}`);
  assert.ok(Math.abs(a.bpm.out - s.clock.bpm) < 0.02, `out ${a.bpm.out} vs clock ${s.clock.bpm}`);
  assert.ok(Math.abs(a.bpm.out - 128) < 0.3, `out ${a.bpm.out}`);
  const ph = [];
  for (let i = 0; i < 10; i++) { const d = deckBy(await state(deck), 1); if (d.sync.phaseMs != null) ph.push(Math.abs(d.sync.phaseMs)); await sleep(200); }
  ph.sort((x, y) => x - y);
  assert.ok(ph.length && ph[Math.floor(ph.length / 2)] < 15, `phase ${JSON.stringify(ph)}`);
});

test('the mix recording has both decks at 128 BPM with aligned beats', async () => {
  const { wav } = await record('mix', 8);
  assert.ok(wav.seconds > 7 && wav.sr > 0);
  const lo = bandOnsets(wav.mono, wav.sr, 'low'), hi = bandOnsets(wav.mono, wav.sr, 'high');
  assert.ok(Math.abs(medianBpm(lo) - 128) < 1, `low ${medianBpm(lo)}`);
  assert.ok(Math.abs(medianBpm(hi) - 128) < 1, `high ${medianBpm(hi)}`);
  const offs = lo.map((t) => Math.min(...hi.map((u) => Math.abs(u - t)))).sort((x, y) => x - y);
  const med = offs[Math.floor(offs.length / 2)] * 1000;
  assert.ok(med < 25, `median beat offset ${med.toFixed(1)} ms`);
});

test('crossfader isolates A from B', async () => {
  set(deck, 1, 'xf', 'A'); set(deck, 2, 'xf', 'B'); set(deck, null, 'xfader.pos', 0.5);
  await sleep(300);
  const both = await record('mix', 3);
  set(deck, null, 'xfader.pos', 1);
  await sleep(300);
  const onlyB = await record('mix', 3);
  const drop = 20 * Math.log10(bandRms(onlyB.wav.mono, onlyB.wav.sr, 'low') / bandRms(both.wav.mono, both.wav.sr, 'low'));
  assert.ok(drop < -30, `A drop ${drop.toFixed(1)} dB`);
  set(deck, null, 'xfader.pos', 0.5); set(deck, 1, 'xf', 'THRU'); set(deck, 2, 'xf', 'THRU');
});

test('low kill removes the kick from the deck recording', async () => {
  const on = await record(1, 3);
  set(deck, 1, 'kill.low', true);
  await sleep(200);
  const killed = await record(1, 3);
  set(deck, 1, 'kill.low', false);
  const drop = 20 * Math.log10(bandRms(killed.wav.mono, killed.wav.sr, 'low') / bandRms(on.wav.mono, on.wav.sr, 'low'));
  assert.ok(drop < -25, `low drop ${drop.toFixed(1)} dB`);
  assert.match(path.basename(on.dl.filename), /^JDSamps-D1-Track A 124 BPM-\d{8}-\d{6}.*\.wav$/);
});

test('the limiter holds the master under -1 dBFS with +12 dB trims', async () => {
  set(deck, 1, 'trim', 1); set(deck, 2, 'trim', 1);
  await sleep(500);
  const { wav } = await record('mix', 3); // the mix tap is after the limiter: check every sample
  set(deck, 1, 'trim', 0.5); set(deck, 2, 'trim', 0.5);
  let peak = 0;
  for (const x of wav.mono) peak = Math.max(peak, Math.abs(x));
  assert.ok(peak <= 10 ** (-1 / 20) + 2 / 32768, `peak ${peak}`);
  assert.ok(peak > 0.8, `peak ${peak} (limiting engaged)`);
  const gr = Math.min(...(await Promise.all([0, 1, 2, 3, 4].map(() => state(deck)))).map((s) => s.master.gr));
  assert.ok(gr <= 0, `gr ${gr}`);
});

test('player assist refills the reserve on a media-element page', async () => {
  // LIVE leaves ~0.6 s of reserve; deck 1 must run +3.2 %, so assist has to keep it fed.
  assert.equal((await act(deck, 1, 'live')).ok, true);
  await waitFor(async () => (await tabs.a.evaluate(() => window.__media())).rate > 1.01, 15000, 250);
  const m = await tabs.a.evaluate(() => window.__media());
  assert.equal(m.pp, false);
  await sleep(1500); // the LIVE jump lands ~0.15 s after the call; let it settle
  const d0 = deckBy(await state(deck), 1);
  assert.equal(d0.assist.active, true);
  assert.ok(d0.reserve < 3, `reserve after LIVE ${d0.reserve}`);
  await sleep(6000);
  const d1 = deckBy(await state(deck), 1);
  assert.ok(d1.reserve > d0.reserve, `reserve ${d0.reserve} -> ${d1.reserve}`);
  assert.equal(d1.starved, false);
  assert.ok(Math.abs(d1.bpm.out - 128) < 0.4, `out ${d1.bpm.out}`);
  assert.ok(Math.abs(d1.bpm.native - 124) < 0.4, `native ${d1.bpm.native}`);
  // Phase lock is regained after the LIVE jump while assist runs: median of 5 readings < 15 ms.
  const recent = [];
  await waitFor(async () => {
    const p = deckBy(await state(deck), 1).sync.phaseMs;
    if (p != null) recent.push(Math.abs(p));
    const last = recent.slice(-5).sort((x, y) => x - y);
    return last.length === 5 && last[2] < 15;
  }, 15000, 300);
});

test('a 2.5 s stall of the deck page (it shares the engine\'s main thread) leaves no gap in the mix', async () => {
  // Deck 1 plays synced +3.2 % from a LIVE-sized reserve (about 1 s), deck 2 is the master.
  const s0 = await state(deck);
  assert.ok(deckBy(s0, 1).playing && deckBy(s0, 1).reserve < 2.5, JSON.stringify({ reserve: deckBy(s0, 1).reserve }));
  const known = await downloadIds(h);
  assert.equal((await act(deck, null, 'mixRecStart')).ok, true);
  await sleep(2000);
  const blocked = await deck.evaluate(() => { const t0 = performance.now(); while (performance.now() - t0 < 2500); return performance.now() - t0; });
  await sleep(3000);
  await act(deck, null, 'mixRecStop');
  const wav = parseWav(fs.readFileSync((await waitForDownload(h, known)).filename));
  const kicks = bandOnsets(wav.mono, wav.sr, 'low'); // deck 1 (track A) is the only low-band source
  const gaps = kicks.slice(1).map((t, i) => [kicks[i], t - kicks[i]]);
  const worst = gaps.reduce((m, g) => (g[1] > m[1] ? g : m), [0, 0]);
  const info = JSON.stringify({ blocked: Math.round(blocked), seconds: wav.seconds, kicks: kicks.length, worst: [+worst[0].toFixed(2), Math.round(worst[1] * 1000)] });
  assert.ok(kicks.length > 10, info);
  assert.ok(worst[1] < 0.6, `longest gap between kicks ${Math.round(worst[1] * 1000)} ms (a beat is 469 ms): ${info}`);
  const ids = s0.decks.map((d) => d.id);
  const dropouts = await offscreenEval(h, `${JSON.stringify(ids)}.map((id) => globalThis.__jdsEngine.decks.get(id).dropouts)`);
  assert.deepEqual(dropouts, ids.map(() => ({ runs: 0, seconds: 0 })), `the stretchers read past their audio: ${info}`);
});

test('a Web-Audio page with a muted decorative <audio> has no assist and the reserve stays protected', async () => {
  tabs.c = await h.context.newPage();
  await tabs.c.goto(server.url('c'));
  await sleep(500);
  assert.equal((await hubCall(deck, { type: 'LOAD_TAB', tabId: await tabIdFor(h, server.url('c')) })).ok, true);
  const early = await act(deck, 3, 'sync', { on: true }); // the tracker needs >= 4 s of audio first
  assert.equal(early.ok, false);
  assert.match(early.error, /No BPM yet/);
  await waitFor(async () => { const d = deckBy(await state(deck), 3); return d && d.bpm.state === 'LOCKED'; }, 25000);
  await act(deck, 3, 'live');
  assert.equal((await act(deck, 3, 'sync', { on: true })).ok, true);
  assert.equal((await act(deck, 3, 'play')).ok, true);
  // Needs +6.7 % with no player to drive: the small LIVE reserve drains, then the deck is held at 1×.
  await waitFor(async () => deckBy(await state(deck), 3).starved, 20000, 250);
  await sleep(600); // the 1x clamp is scheduled ~0.15 s ahead and reported at the heard time
  for (let i = 0; i < 10; i++) {
    const d = deckBy(await state(deck), 3);
    assert.equal(d.assist.available, false);
    assert.equal(d.playing, true);
    assert.equal(d.starved, true);
    assert.ok(d.reserve >= 0 && d.engineRate <= 1.0001, JSON.stringify({ reserve: d.reserve, rate: d.engineRate }));
    await sleep(200);
  }
  // The muted element was left alone and the tempo/pitch model is untouched.
  const d = deckBy(await state(deck), 3);
  assert.equal(d.assist.sourceRate, 1);
  assert.ok(Math.abs(d.bpm.native - 120) < 0.4, `native ${d.bpm.native}`);
  assert.deepEqual(await tabs.c.evaluate(() => { const a = document.getElementById('decor'); return [a.paused, a.playbackRate, a.preservesPitch]; }), [false, 1, true]);
});

test('recordings stopped together are all saved, reported and released', async () => {
  const rounds = 4, known = await downloadIds(h), ev0 = (await events(deck)).length;
  const completed = () => h.sw.evaluate((k) => chrome.downloads.search({ state: 'complete' }).then((xs) => xs.filter((d) => !k.includes(d.id)).length), known);
  for (let i = 0; i < rounds; i++) {
    assert.equal((await act(deck, 1, 'recStart')).ok, true);
    assert.equal((await act(deck, null, 'mixRecStart')).ok, true);
    await sleep(700);
    await Promise.all([act(deck, 1, 'recStop'), act(deck, null, 'mixRecStop')]); // as STOP ALL or a closing tab does
    await waitFor(async () => (await completed()) === 2 * (i + 1), 15000, 200);
  }
  const notices = async () => (await events(deck)).slice(ev0).filter((e) => /^Sav(ed|ing) /.test(e.text));
  await waitFor(async () => (await notices()).length >= 2 * rounds, 5000).catch(() => {});
  const n = await notices();
  assert.equal(n.filter((e) => e.level === 'info').length, 2 * rounds, JSON.stringify(n.map((e) => e.text)));
  assert.equal(n.length, 2 * rounds);
  assert.deepEqual(await offscreenEval(h, '[...globalThis.__jdsEngine.downloads.values()].map((x) => x.filename)'), []);
  const s = await h.sw.evaluate(() => chrome.storage.session.get(null));
  assert.deepEqual(Object.entries(s).flatMap(([k, v]) => (k === 'dl' ? Object.keys(v) : k.startsWith('dl:') ? [k] : [])), []);
});

test('reloading the deck page keeps the engine playing', async () => {
  const before = deckBy(await state(deck), 2).playhead;
  const t0 = Date.now();
  await deck.reload();
  await deck.waitForSelector('.deck >> nth=2', { timeout: 10000 });
  await installClient(deck);
  const after = deckBy(await state(deck), 2).playhead;
  assert.ok(after - before > (Date.now() - t0) / 1000 - 0.8, `playhead ${before} -> ${after}`);
  fs.mkdirSync(ART, { recursive: true });
  await sleep(500);
  await deck.screenshot({ path: path.join(ART, 'e2e-deck.png') });
});

test('closing a recording tab saves its recording and frees the master clock', async () => {
  const known = await downloadIds(h);
  assert.equal((await act(deck, 2, 'recStart')).ok, true);
  await sleep(2000);
  await tabs.b.close();
  const dl = await waitForDownload(h, known, 15000);
  assert.match(path.basename(dl.filename), /^JDSamps-D2-/);
  const wav = parseWav(fs.readFileSync(dl.filename));
  assert.ok(wav.seconds > 1.5, `seconds ${wav.seconds}`);
  await waitFor(async () => (await state(deck)).decks.length === 2, 8000);
  assert.equal((await state(deck)).clock.mode, 'free');
});

// Inside the engine: wrap AudioWorkletNode to log what each new node is told (port messages and
// stretcher remote calls), and whether the stretcher processor answered destroy().
const NODE_PROBE = `(() => {
  const Orig = AudioWorkletNode, lc = window.__lc = { Orig, nodes: [] };
  window.AudioWorkletNode = class extends Orig {
    constructor(ctx, name, opts) {
      super(ctx, name, opts);
      const rec = { name, sent: [], destroyAnswered: false };
      lc.nodes.push(rec);
      const port = this.port, post = port.postMessage.bind(port);
      let destroyId = null;
      port.postMessage = (...args) => {
        const m = args[0];
        if (Array.isArray(m)) { if (m[1] !== 'addBuffers') rec.sent.push(m[1]); if (m[1] === 'destroy') destroyId = m[0]; }
        else if (m && m.t) rec.sent.push(m.t);
        return post(...args);
      };
      port.addEventListener('message', (e) => { if (destroyId !== null && Array.isArray(e.data) && e.data[0] === destroyId) rec.destroyAnswered = true; });
    }
  };
  return true;
})()`;

test('ejected and closed deck tabs stop their audio processors (stretcher, input, FX, recorder)', async () => {
  await offscreenEval(h, NODE_PROBE);
  try {
    // 0: eject. 1: record, stop, close the tab. 2: eject while recording.
    for (let i = 0; i < 3; i++) {
      const url = `${server.url('a')}?lifecycle=${i}`;
      const tab = await h.context.newPage();
      await tab.goto(url);
      const tabId = await tabIdFor(h, url);
      const r = await hubCall(deck, { type: 'LOAD_TAB', tabId });
      assert.equal(r.ok, true, JSON.stringify(r));
      const d = await waitFor(async () => (await state(deck)).decks.find((x) => x.tabId === tabId), 8000);
      await sleep(1500);
      if (i > 0) { assert.equal((await act(deck, d.id, 'recStart')).ok, true); await sleep(1000); }
      if (i === 1) { await act(deck, d.id, 'recStop'); await tab.close(); } else { assert.equal((await act(deck, d.id, 'eject')).ok, true); await tab.close(); }
      await waitFor(async () => !(await state(deck)).decks.some((x) => x.tabId === tabId), 10000);
    }
    const done = (n) => n.filter((x) => x.name === 'signalsmith-stretch').every((x) => x.destroyAnswered)
      && n.filter((x) => x.name === 'jds-recorder').every((x) => x.sent.includes('dispose'));
    await waitFor(async () => done(await offscreenEval(h, 'window.__lc.nodes')), 15000, 250).catch(() => {});
    const nodes = await offscreenEval(h, 'window.__lc.nodes');
    const by = (name) => nodes.filter((x) => x.name === name);
    assert.equal(by('signalsmith-stretch').length, 3);
    for (const s of by('signalsmith-stretch')) {
      assert.ok(s.sent.includes('dropBuffers') && s.destroyAnswered, `stretcher not destroyed: ${JSON.stringify(s)}`);
    }
    for (const name of ['jds-deck-input', 'jds-beatfx']) {
      assert.equal(by(name).length, 3, name);
      for (const x of by(name)) assert.ok(x.sent.includes('dispose'), `${name} not disposed: ${JSON.stringify(x.sent.slice(-5))}`);
    }
    assert.deepEqual(by('jds-recorder').map((x) => x.sent), [['start', 'stop', 'dispose'], ['start', 'stop', 'dispose']]);
  } finally {
    await offscreenEval(h, 'window.AudioWorkletNode = window.__lc.Orig, true').catch(() => {});
  }
});

test("ejecting a deck pauses its tab's player, whether the user or the engine ejects it, even with a slow hub", async () => {
  // 0: EJECT from the deck. 1: the engine ejects it (the tab stopped sharing audio).
  // 2: EJECT while the hub answers slowly (a busy machine): the capture still waits for the pause.
  for (let i = 0; i < 3; i++) {
    const url = `${server.url('a')}?eject=${i}`;
    const tab = await h.context.newPage();
    await tab.goto(url);
    const tabId = await tabIdFor(h, url);
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId });
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = await waitFor(async () => (await state(deck)).decks.find((x) => x.tabId === tabId), 8000);
    await waitFor(() => tab.evaluate(() => { const m = window.__media(); return !m.paused && m.t > 0.3; }), 8000);
    // Wall-clock times of the page's pause and of the capture being released.
    await tab.evaluate(() => document.getElementById('a').addEventListener('pause', () => { window.__pausedAt = Date.now(); }));
    // On a busy machine the hub may mute first (the pause is late); either way the tab is silent.
    await h.sw.evaluate((id) => { globalThis.__mutedAt = 0; chrome.tabs.onUpdated.addListener((t, info) => {
      if (t === id && info.mutedInfo && info.mutedInfo.muted && !globalThis.__mutedAt) globalThis.__mutedAt = Date.now(); }); }, tabId);
    await offscreenEval(h, `(() => { window.__releasedAt = 0; const t = globalThis.__jdsEngine.decks.get(${d.id}).stream.getAudioTracks()[0], stop = t.stop.bind(t);
      t.stop = () => { window.__releasedAt = Date.now(); stop(); }; return true; })()`);
    if (i === 2) {
      await offscreenEval(h, `(() => { const e = globalThis.__jdsEngine, hub = e.hub.bind(e); e.__hub = hub;
        e.hub = (m) => (m.type === 'STOP_TAB' ? new Promise((r) => setTimeout(r, 700)).then(() => hub(m)) : hub(m)); return true; })()`);
    }
    if (i !== 1) assert.equal((await act(deck, d.id, 'eject')).ok, true);
    else await offscreenEval(h, `globalThis.__jdsEngine.decks.get(${d.id}).stream.getAudioTracks()[0].dispatchEvent(new Event('ended'))`);
    await waitFor(async () => !(await state(deck)).decks.some((x) => x.tabId === tabId), 8000);
    await waitFor(() => tab.evaluate(() => window.__media().paused), 1500).catch(() => {});
    assert.equal((await tab.evaluate(() => window.__media())).paused, true, `eject ${i}: the tab's <audio> is still playing`);
    const releasedAt = await waitFor(() => offscreenEval(h, 'window.__releasedAt || 0'), 3000);
    const pausedAt = await tab.evaluate(() => window.__pausedAt);
    const mutedAt = await h.sw.evaluate(() => globalThis.__mutedAt);
    // The hub answers only after the page's pause() calls returned, so the capture is released after the
    // pause; the 'pause' event itself is dispatched a task later, which a starved CPU can delay a few ms.
    const EVENT_LAG = 100;
    assert.ok(pausedAt <= releasedAt + EVENT_LAG || (mutedAt && mutedAt <= releasedAt),
      `eject ${i}: the tab was still playing when the capture was released (paused ${pausedAt - releasedAt} ms after, muted ${mutedAt ? mutedAt - releasedAt : 'never'})`);
    // Paused in the end, so any mute made while the pause was late is taken back off.
    await waitFor(async () => !(await h.sw.evaluate((id) => chrome.tabs.get(id), tabId)).mutedInfo.muted, 3000)
      .catch(() => assert.fail(`eject ${i}: paused, but the tab was left muted`));
    if (i === 2) await offscreenEval(h, '(() => { const e = globalThis.__jdsEngine; e.hub = e.__hub; delete e.__hub; return true; })()');
    await tab.close();
  }
});

test('stop all ejects everything; no engine errors were reported', async () => {
  assert.equal((await act(deck, null, 'stopAll')).ok, true);
  await waitFor(async () => (await state(deck)).decks.length === 0, 8000);
  const errs = (await events(deck)).filter((e) => e.level === 'error');
  assert.deepEqual(errs, []);
});

test('ejected tabs may be discarded again', async () => {
  for (const k of ['a', 'b', 'c']) {
    const id = await tabIdFor(h, server.url(k));
    if (id == null) continue; // closed by an earlier test (b): nothing left to give back
    await waitFor(async () => (await h.sw.evaluate((x) => chrome.tabs.get(x), id)).autoDiscardable === true, 3000);
  }
});

test("STOP ALL left every deck's tab silent: players paused at their own rate, the Web-Audio tab muted", async () => {
  await waitFor(() => tabs.a.evaluate(() => window.__media().paused), 1500).catch(() => {});
  const m = await tabs.a.evaluate(() => window.__media());
  assert.deepEqual([m.paused, m.rate, m.pp], [true, 1, true], 'deck 1 (<audio>, assisted earlier)');
  const cId = await tabIdFor(h, server.url('c'));
  const mi = await h.sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.mutedInfo), cId);
  assert.deepEqual([mi.muted, mi.reason, mi.extensionId], [true, 'extension', h.extId], 'Web-Audio tab muted by us');
  assert.equal(await tabs.c.evaluate(() => document.getElementById('decor').paused), true, 'its muted decor <audio> is paused too');
  const notes = (await events(deck)).filter((e) => /no pausable player/.test(e.text));
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.match(notes[0].text, /^Deck \d: the tab has no pausable player, so it was muted\.$/);
  assert.equal(notes[0].level, 'info');
});

test('loading a tab we muted unmutes it first, so the deck hears it', async () => {
  const cId = await tabIdFor(h, server.url('c'));
  assert.equal((await h.sw.evaluate((id) => chrome.tabs.get(id), cId)).mutedInfo.muted, true, 'muted by the STOP ALL');
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: cId });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await h.sw.evaluate((id) => chrome.tabs.get(id), cId)).mutedInfo.muted, false);
  const d = await waitFor(async () => (await state(deck)).decks.find((x) => x.tabId === cId), 8000);
  await waitFor(() => offscreenEval(h, `globalThis.__jdsEngine.decks.get(${d.id}).firstAudible != null`), 8000);
  assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => (await state(deck)).decks.length === 0, 8000);
});
