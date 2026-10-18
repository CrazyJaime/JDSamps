// Tabs made resident, in the real extension: each model site (/m/* on the track server) loaded with
// LOAD_TAB, through the real hub, engine, loader, relay and page tap. The ones whose bytes can be had
// end as resident decks holding the whole track, checked against the source; the rest end live with
// their one message. A resident deck no longer depends on its tab: the tab is released, and pausing,
// seeking and closing it afterwards changes nothing in the deck.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  prepareExtension, launchExtension, startTrackServer, hubCall, tabIdFor, waitFor, installClient, act, set, state, events, offscreenEval, makeTrackWav,
} from './ext-harness.mjs';

const SITES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sites');
const index = JSON.parse(fs.readFileSync(path.join(SITES, 'index.json'), 'utf8'));
const OPUS_END = index.reps['opus-hi'].segs.at(-1).t1; // 120.0065
let h, server, deck, rec, tmp;
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decks = async () => (await state(deck)).decks;
const deckWhere = (fn, ms = 60000) => waitFor(async () => (await decks()).find(fn), ms, 150);
const engine = (body) => offscreenEval(h, `(async () => { const e = globalThis.__jdsEngine; ${body} })()`);

/** A 16 s MP3 behind an <audio src> page, served with byte ranges (so its player knows its length). */
async function startRecServer() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jds-rec-'));
  fs.writeFileSync(path.join(tmp, 'rec.wav'), makeTrackWav({ bpm: 124, seconds: 16 }));
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(tmp, 'rec.wav'), '-codec:a', 'libmp3lame', '-b:a', '192k', path.join(tmp, 'rec.mp3')]);
  const mp3 = fs.readFileSync(path.join(tmp, 'rec.mp3'));
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/rec') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Short track</title><audio id="a" src="/rec.mp3" autoplay></audio>
<script>window.__media = () => { const a = document.getElementById('a'); return { t: a.currentTime, rate: a.playbackRate, pp: a.preservesPitch, paused: a.paused, duration: a.duration }; };</script>`);
      return;
    }
    if (u.pathname !== '/rec.mp3') { res.writeHead(404); res.end(); return; }
    const head = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!r) { res.writeHead(200, { ...head, 'content-length': mp3.length }); res.end(mp3); return; }
    const from = Number(r[1]), to = r[2] ? Math.min(Number(r[2]), mp3.length - 1) : mp3.length - 1;
    res.writeHead(206, { ...head, 'content-range': `bytes ${from}-${to}/${mp3.length}`, 'content-length': to - from + 1 });
    res.end(mp3.subarray(from, to + 1));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

before(async () => {
  server = await startTrackServer({ seconds: 30 });
  rec = await startRecServer();
  h = await launchExtension({ ext: prepareExtension() });
  deck = await h.context.newPage();
  deck.on('pageerror', (e) => pageErrors.push(String(e)));
  deck.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await deck.goto(`chrome-extension://${h.extId}/deck.html`);
  await hubCall(deck, { type: 'ENSURE_ENGINE' });
  await installClient(deck);
  // Keep each promoted deck's decoded track, to check it against the source.
  await engine(`if (!e.__pcm) { e.__pcm = new Map(); const s = e.startResidentDeck.bind(e);
    e.startResidentDeck = (o) => { if (o && o.deckId != null && o.pcm) e.__pcm.set(o.deckId, o.pcm); return s(o); }; } return true;`);
});
after(async () => {
  await h?.close(); await server?.close(); await rec?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Open a model page; `ready` waits for its player (default: playing past 0.3 s). */
async function openSite(name, query = 'autoplay=1') {
  const url = `${server.origin}/m/${name}${query ? `?${query}` : ''}`;
  const tab = await h.context.newPage();
  await tab.goto(url);
  return { tab, url, tabId: await tabIdFor(h, url) };
}
const playing = (tab) => waitFor(() => tab.evaluate(() => { const m = window.__media(); return !!m && !m.paused && m.t > 0.3; }), 15000);

/** LOAD_TAB, then wait until the deck is no longer loading. */
async function loadTab(tabId, { during } = {}) {
  const seen = (await events(deck)).length;
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (during) await during(r);
  const d = await deckWhere((x) => x.id === r.deckId && x.kind !== 'loading', 90000);
  d.seen = seen;
  return d;
}

/** The deck's decoded track against the source decoded here: lengths, the largest sample difference and the correlation. */
function compare(deckId, urls) {
  return engine(`
    const pcm = e.__pcm.get(${deckId});
    const bufs = await Promise.all(${JSON.stringify(urls)}.map((u) => fetch(u).then((r) => r.arrayBuffer())));
    const cat = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0)); let k = 0;
    for (const b of bufs) { cat.set(new Uint8Array(b), k); k += b.byteLength; }
    const ref = await e.ctx.decodeAudioData(cat.buffer);
    // The last 50 ms are left out of the sample comparison: a decode resampled to the engine's rate ends
    // differently when its input ends a few ms earlier (assembly leaves out a final piece shorter than a frame).
    const a = pcm.L, b = ref.getChannelData(0), n = Math.min(a.length, b.length), body = n - Math.round(0.05 * pcm.sampleRate);
    let maxd = 0, ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) { const d = Math.abs(a[i] - b[i]); if (i < body && d > maxd) maxd = d; ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    e.__pcm.delete(${deckId});
    return { seconds: a.length / pcm.sampleRate, refSeconds: b.length / ref.sampleRate, maxd, corr: ab / Math.sqrt(aa * bb) };
  `);
}
const opusUrls = (rep = 'opus-hi') => [index.reps[rep].init, ...index.reps[rep].segs].map((f) => `${server.origin}/m/media/${f.path}`);

/**
 * The tab no longer matters: released (its player paused, no capture, no agents, the hub forgot it), and
 * pausing, seeking and closing it leave the deck playing on from where it was.
 */
async function assertReleased(d, site) {
  // Released right after the promotion: the page's player is paused first (a hub round trip).
  await deckWhere((x) => x.id === d.id && x.tabId === null, 5000).catch(() => assert.fail('the deck kept its tab'));
  const held = await engine(`const d = e.decks.get(${d.id}); return { stream: d.stream, agents: d.agents.size, loads: e.loads.has(${d.id}) };`);
  assert.deepEqual(held, { stream: null, agents: 0, loads: false });
  await waitFor(() => site.tab.evaluate(() => window.__media().paused), 3000).catch(() => {});
  const m = await site.tab.evaluate(() => window.__media());
  assert.deepEqual([m.paused, m.rate, m.pp], [true, 1, true], 'the page has its player back, paused at its own rate');
  assert.equal(await h.sw.evaluate(() => chrome.action.getBadgeText({})), '', 'the badge dropped the tab');
  assert.equal((await act(deck, d.id, 'play')).ok, true);
  await sleep(800);
  const p0 = (await decks()).find((x) => x.id === d.id), t0 = Date.now();
  await site.tab.evaluate(() => { const a = document.querySelector('audio'); a.currentTime = 50; a.play().catch(() => {}); a.pause(); });
  await site.tab.close();
  await sleep(1500);
  const p1 = (await decks()).find((x) => x.id === d.id);
  assert.ok(p1, 'closing the tab did not eject the deck');
  assert.equal(p1.kind, 'resident');
  assert.equal(p1.duration, d.duration);
  assert.equal(p1.playing, true);
  const moved = p1.playhead - p0.playhead, wall = (Date.now() - t0) / 1000;
  assert.ok(Math.abs(moved - wall) < 0.4, `the deck moved ${moved.toFixed(2)} s in ${wall.toFixed(2)} s`);
  assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id), 8000);
}

async function assertLive(d, site, re) {
  assert.equal(d.kind, 'live');
  assert.match(d.load.report, /^JD Samps load report\n[^]*Result: live: /);
  assert.equal(d.tabId, site.tabId, 'a live deck stays bound to its tab');
  const said = (await events(deck)).slice(d.seen).filter((e) => e.text.startsWith(`Deck ${d.slot}: `) && re.test(e.text));
  assert.equal(said.length, 1, JSON.stringify((await events(deck)).map((e) => e.text)));
  assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id), 8000);
  await site.tab.close();
}

// ---------------------------------------------------------------- resident
test('a progressive MP3 page ends resident: the whole file, sample for sample, and the tab released', async () => {
  const site = await openSite('progressive');
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  const c = await compare(d.id, [`${server.origin}/m/media/track.mp3`]);
  assert.ok(Math.abs(d.duration - c.refSeconds) < 0.015, `deck ${d.duration} s, the MP3 ${c.refSeconds} s`);
  assert.ok(c.maxd < 1e-6, JSON.stringify(c));
  await assertReleased(d, site);
});

test('an MSE page whose segments can be fetched again ends resident: the start it buffered before the tap is fetched again', async () => {
  const site = await openSite('mse');
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `duration ${d.duration}`);
  const c = await compare(d.id, opusUrls());
  assert.ok(c.corr > 0.9999 && c.maxd < 1e-3, JSON.stringify(c));
  await assertReleased(d, site);
});

test('an ABR page ends resident with no doubled or missing audio at its quality switch', async () => {
  const site = await openSite('abr');
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `duration ${d.duration}`);
  const c = await compare(d.id, opusUrls('opus-hi'));
  assert.ok(c.corr > 0.999, JSON.stringify(c));
  await assertReleased(d, site);
});

test('a YouTube-like page with single-use links ends resident by driving its player through the track', async () => {
  const site = await openSite('opaque', '');
  const d = await loadTab(site.tabId, {
    // Its player starts once the deck is reading the page (what it buffered earlier could not be had again).
    during: async (r) => {
      await waitFor(() => engine(`const l = e.loads.get(${r.deckId}); return !!l && l.loader.tapping;`), 15000);
      await site.tab.click('#play');
    },
  });
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `duration ${d.duration}`);
  const c = await compare(d.id, opusUrls());
  assert.ok(c.corr > 0.9999 && c.maxd < 1e-3, JSON.stringify(c));
  assert.match(d.load.report, /refetch \(fetching the track's pieces\): skipped .* — the player fetched nothing that can be fetched again/);
  assert.match(d.load.report, /drive \(seek-hop[^)]*\): ok/);
  await assertReleased(d, site);
});

test('a Bandcamp-like page ends resident from its own track link', async () => {
  const site = await openSite('bandcamp');
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  const c = await compare(d.id, [`${server.origin}/m/media/track.mp3`]);
  assert.ok(Math.abs(d.duration - c.refSeconds) < 0.015, `deck ${d.duration} s, the MP3 ${c.refSeconds} s`);
  assert.ok(c.maxd < 1e-6, JSON.stringify(c));
  assert.match(d.load.report, /file \(reading the page's track link\): ok/);
  await assertReleased(d, site);
});

test('a page that fights playbackRate ends resident from the link it requested, never driven', async () => {
  const site = await openSite('ratefight');
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  assert.ok(Math.abs(d.duration - 120) < 0.05, `duration ${d.duration}`);
  const c = await compare(d.id, [`${server.origin}/m/media/track.webm`]);
  assert.ok(c.maxd < 1e-6, JSON.stringify(c));
  assert.deepEqual(await site.tab.evaluate(() => window.__page.resets), [], 'the page never had its rate changed');
  assert.match(d.load.report, /refetch \(fetching the track\): ok/);
  assert.doesNotMatch(d.load.report, /^ +drive/m);
  await assertReleased(d, site);
});

// ---------------------------------------------------------------- live, with one message
test('a protected (DRM) page plays live, saying why once', async () => {
  const site = await openSite('drm');
  await playing(site.tab);
  await assertLive(await loadTab(site.tabId), site, /protected/);
});

test('a page whose Media Source runs in a worker plays live, saying why once', async (t) => {
  const site = await openSite('worker');
  if (!(await site.tab.evaluate(() => MediaSource.canConstructInDedicatedWorker))) { await site.tab.close(); t.skip('no MSE in workers here'); return; }
  await playing(site.tab);
  await assertLive(await loadTab(site.tabId), site, /worker/);
});

test('a live stream plays live, saying why once', async () => {
  const site = await openSite('live', 'autoplay=1&join=30');
  await waitFor(() => site.tab.evaluate(() => { const m = window.__media(); return !m.paused && m.t > 30.3; }), 15000);
  await assertLive(await loadTab(site.tabId), site, /live stream/);
});

test('a progressive player that reports no end (a file served without byte ranges) plays live, saying why once', async () => {
  const site = { tab: await h.context.newPage(), url: server.url('a') };
  await site.tab.goto(site.url);
  site.tabId = await tabIdFor(h, site.url);
  await playing(site.tab);
  const t0 = Date.now(), d = await loadTab(site.tabId);
  assert.ok(Date.now() - t0 < 7000, `live after ${Date.now() - t0} ms`);
  await assertLive(d, site, /live stream/);
});

test('a Web-Audio-only page plays live, saying why once', async () => {
  const site = await openSite('webaudio');
  await waitFor(() => site.tab.evaluate(() => window.__ctx?.state === 'running' && window.__ctx.currentTime > 0.3), 15000);
  await assertLive(await loadTab(site.tabId), site, /without a media player/);
});

test('a SoundCloud-style preview is refused and plays live, never made resident as the track', async () => {
  const site = await openSite('preview');
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  assert.deepEqual(await engine('return [...e.__pcm.keys()];'), [], 'no preview was promoted');
  await assertLive(d, site, /SoundCloud only gives a 30-second preview of this track\./);
});

// ---------------------------------------------------------------- recording a whole track (opt-in)
/** A live deck of the page at `url`: tabs load live while resident.auto is off. */
async function liveDeck(url) {
  set(deck, null, 'resident.auto', false);
  await waitFor(async () => (await state(deck)).master.params['resident.auto'] === false);
  const site = { tab: await h.context.newPage(), url };
  try {
    await site.tab.goto(url);
    site.tabId = await tabIdFor(h, url);
    const d = await loadTab(site.tabId);
    assert.equal(d.kind, 'live');
    return { site, d };
  } finally { set(deck, null, 'resident.auto', true); }
}

test("recording a whole track is refused on a page that can't be sped up", async () => {
  const { site, d } = await liveDeck(`${server.origin}/m/webaudio?autoplay=1`);
  const r = await act(deck, d.id, 'recordWhole');
  assert.equal(r.ok, false);
  assert.match(r.error, /can't be sped up, so it would record in real time/);
  assert.equal((await decks()).length, 1, 'no deck was started for it');
  assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).length, 8000);
  await site.tab.close();
});

test('recording a whole track from a media page: its player run at 2× from the start, the capture slowed back, a resident deck labelled as such', async (t) => {
  const { site, d } = await liveDeck(`${rec.origin}/rec`);
  await playing(site.tab);
  const D = (await site.tab.evaluate(() => window.__media())).duration;
  assert.ok(D > 15.9 && D < 16.2, `the player says ${D} s`);
  const t0 = Date.now();
  assert.deepEqual(await act(deck, d.id, 'recordWhole'), { ok: true, error: undefined });
  const loading = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 5000);
  assert.match(loading.title, /recorded from the page — reduced highs/);
  await deckWhere((x) => x.id === loading.id && /recording/.test(x.load.strategy || ''), 5000);
  const r = await deckWhere((x) => x.id === loading.id && x.kind === 'resident', 40000);
  const took = (Date.now() - t0) / 1000;
  assert.ok(took > 7.5 && took < 25, `recorded in ${took.toFixed(1)} s (half the track's length, plus setting up)`);
  assert.ok(Math.abs(r.duration - Math.min(D, 16.1)) < 0.1, `deck ${r.duration} s, the track ${D} s`);
  assert.match(r.title, /recorded from the page — reduced highs/);
  assert.match(r.load.report, /recorded from the page at 2×/);
  assert.equal(r.tabId, null, 'the recording holds no tab');
  assert.ok(Math.abs(r.bpm.native - 124) < 0.5, `bpm ${r.bpm.native}`);
  // Slowed back to the track's own pitch: lined up with the source (to within a few ms), the audio matches it.
  const c = await engine(`
    const pcm = e.__pcm.get(${loading.id});
    const ref = await e.ctx.decodeAudioData(await (await fetch('${rec.origin}/rec.mp3')).arrayBuffer());
    const a = pcm.L, b = ref.getChannelData(0), sr = pcm.sampleRate, n = Math.round(4 * sr), W = Math.round(0.03 * sr);
    let best = { lag: 0, corr: -1 };
    for (let lag = -W; lag <= W; lag += 2) {
      let ab = 0, aa = 0, bb = 0;
      for (let i = W; i < n; i++) { const x = a[i + lag], y = b[i]; ab += x * y; aa += x * x; bb += y * y; }
      const corr = ab / Math.sqrt(aa * bb);
      if (corr > best.corr) best = { lag: lag / sr, corr };
    }
    e.__pcm.delete(${loading.id});
    return best;
  `);
  t.diagnostic(`deck ${r.duration.toFixed(3)} s of a ${D.toFixed(3)} s track in ${took.toFixed(1)} s; against the source: ${JSON.stringify(c)}`);
  assert.ok(c.corr > 0.8, JSON.stringify(c));
  // The live deck it came from is gone, and with it the tab's capture: the page is paused, at its own rate.
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id), 8000);
  await waitFor(() => site.tab.evaluate(() => window.__media().paused), 3000);
  const m = await site.tab.evaluate(() => window.__media());
  assert.deepEqual([m.paused, m.rate, m.pp], [true, 1, true]);
  assert.equal((await act(deck, r.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).length, 8000);
  await site.tab.close();
});

test('the deck page showed every load without errors', () => { assert.deepEqual(pageErrors, []); });
