// Tabs made resident, in the real extension: each model site (/m/* on the track server) loaded with
// LOAD_TAB, through the real hub, engine, loader, relay and page tap. The ones whose bytes can be had
// end as resident decks holding the whole track, checked against the source; the rest end live with
// their one message. A resident deck no longer depends on its tab: the tab is released, and pausing,
// seeking and closing it afterwards changes nothing in the deck.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  prepareExtension, launchExtension, startTrackServer, hubCall, tabIdFor, waitFor, installClient, act, set, state, events, offscreenEval, makeTrackWav,
  downloadIds, waitForDownload, parseWav, bandOnsets, medianBpm, steadyBeats,
} from './ext-harness.mjs';

const SITES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sites');
const index = JSON.parse(fs.readFileSync(path.join(SITES, 'index.json'), 'utf8'));
const OPUS_END = index.reps['opus-hi'].segs.at(-1).t1; // 120.0065
let h, server, deck, rec, multi, tmp;
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decks = async () => (await state(deck)).decks;
const deckWhere = (fn, ms = 60000) => waitFor(async () => (await decks()).find(fn), ms, 150);
const engine = (body) => offscreenEval(h, `(async () => { const e = globalThis.__jdsEngine; ${body} })()`);

/**
 * MP3s behind <audio src> pages, served with byte ranges (so their players know their length): 16 s at /rec (124 BPM
 * kick) and /rec2 (128 BPM click); 150 s at /long, and behind a Bandcamp-like page (data-tralbum) at /bc-long. And a
 * WAV the same way: 60 s of the 128 BPM click at /click128.
 */
async function startRecServer() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jds-rec-'));
  const mp3s = {};
  for (const [name, opts, rate] of [['rec', { bpm: 124, kind: 'low', seconds: 16 }, '192k'], ['rec2', { bpm: 128, kind: 'high', seconds: 16 }, '192k'], ['long', { bpm: 124, kind: 'low', seconds: 150 }, '64k']]) {
    fs.writeFileSync(path.join(tmp, `${name}.wav`), makeTrackWav(opts));
    execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(tmp, `${name}.wav`), '-codec:a', 'libmp3lame', '-b:a', rate, path.join(tmp, `${name}.mp3`)]);
    mp3s[name] = fs.readFileSync(path.join(tmp, `${name}.mp3`));
  }
  const files = { ...Object.fromEntries(Object.entries(mp3s).map(([k, v]) => [`${k}.mp3`, { type: 'audio/mpeg', buf: v }])),
    'click128.wav': { type: 'audio/wav', buf: makeTrackWav({ bpm: 128, kind: 'high', seconds: 60 }) } };
  const media = `<script>window.__media = () => { const a = document.getElementById('a'); return { t: a.currentTime, rate: a.playbackRate, pp: a.preservesPitch, paused: a.paused, duration: a.duration }; };</script>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), page = /^\/(rec2?|long|click128)$/.exec(u.pathname), file = files[u.pathname.slice(1)];
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Track ${page[1]}</title><audio id="a" src="/${page[1]}.${page[1] === 'click128' ? 'wav' : 'mp3'}" autoplay></audio>${media}`);
      return;
    }
    if (u.pathname === '/bc-long') {
      const tralbum = JSON.stringify({ trackinfo: [{ file: { 'mp3-128': '/long.mp3' }, duration: 150 }] }).replace(/"/g, '&quot;');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Long track on a Bandcamp-like page</title><div id="t" data-tralbum="${tralbum}"></div><audio id="a" src="/long.mp3" autoplay></audio>${media}`);
      return;
    }
    if (!file) { res.writeHead(404); res.end(); return; }
    const { buf } = file, head = { 'content-type': file.type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!r) { res.writeHead(200, { ...head, 'content-length': buf.length }); res.end(buf); return; }
    const from = Number(r[1]), to = r[2] ? Math.min(Number(r[2]), buf.length - 1) : buf.length - 1;
    res.writeHead(206, { ...head, 'content-range': `bytes ${from}-${to}/${buf.length}`, 'content-length': to - from + 1 });
    res.end(buf.subarray(from, to + 1));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

/**
 * Pages with two players, on another origin. The track (A) is an MSE player of the model track (opus-hi), fed from
 * its HLS playlist 16 s ahead. The other player (B) is a 24 s 440 Hz tone (Opus fMP4, made here): a muted, looping
 * one in the top frame with the track in an iframe of /m/mse (/dur), or one that starts appending when the page's
 * window.__startB() is called: paused beside the track (/two-same) or playing muted in an iframe (/two-sub).
 */
async function startMultiServer() {
  const tone = path.join(tmp, 'tone.mp4');
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24:sample_rate=48000', '-ac', '2',
    '-c:a', 'libopus', '-b:a', '128k', '-f', 'mp4', '-movflags', '+empty_moov+default_base_moof', '-frag_duration', '4000000', tone]);
  const rep = index.reps['opus-hi'];
  const m3u8 = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-MAP:URI="${rep.init.path}"`,
    ...rep.segs.flatMap((x) => [`#EXTINF:${(x.t1 - x.t0).toFixed(6)},`, x.path]), '#EXT-X-ENDLIST', ''].join('\n');
  const mse = `async function mse(el, list) {
  const text = await (await fetch(list)).text(), base = new URL(list, location.href), segs = []; let init = null, n = 0, played = false;
  for (const l of text.split('\\n')) { const m = /URI="([^"]+)"/.exec(l); if (m) init = new URL(m[1], base).href; else if (l && l[0] !== '#') segs.push(new URL(l, base).href); }
  const ms = new MediaSource(); el.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer('audio/mp4; codecs="opus"'), app = (b) => new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(b); });
  ms.duration = ${rep.segs.at(-1).t1};
  await app(await (await fetch(init)).arrayBuffer());
  for (;;) {
    const end = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
    if (n < segs.length && end < el.currentTime + 16) { await app(await (await fetch(segs[n++])).arrayBuffer()); if (!played) { played = true; el.play().catch(() => {}); } continue; }
    if (n >= segs.length) { try { ms.endOfStream(); } catch (_) {} return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}
/** The tone on its own MediaSource; the whole file in one append. */
async function tone(el) {
  const ms = new MediaSource(); el.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer('audio/mp4; codecs="opus"'), b = await (await fetch('/tone.mp4')).arrayBuffer();
  await new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(b); });
  try { ms.endOfStream(); } catch (_) {}
}
window.__media = () => { const a = document.querySelector('audio'); return { t: a.currentTime, rate: a.playbackRate, pp: a.preservesPitch, paused: a.paused, duration: a.duration }; };`;
  const html = (title, body, script) => `<!doctype html><title>${title}</title>${body}<script>${mse}\n${script}</script>`;
  const pages = {
    '/dur': html('Two frames', `<audio id="b" muted loop></audio><iframe src="${server.origin}/m/mse?autoplay=1" allow="autoplay"></iframe>`, `const b = document.getElementById('b'); tone(b).then(() => b.play());`),
    '/two-same': html('Two players', '<audio id="a"></audio><audio id="b"></audio>', `mse(document.getElementById('a'), '/media/opus-hi.m3u8'); window.__startB = () => tone(document.getElementById('b'));`),
    '/two-sub': html('Two frames', '<audio id="a"></audio><iframe src="/bframe" allow="autoplay"></iframe>', `mse(document.getElementById('a'), '/media/opus-hi.m3u8');`),
    '/bframe': html('Another player', '<audio id="b" muted></audio>', `window.__startB = async () => { const b = document.getElementById('b'); await tone(b); await b.play(); };`),
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (pages[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[u.pathname]); return; }
    if (u.pathname === '/media/opus-hi.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(m3u8); return; }
    const f = u.pathname === '/tone.mp4' ? tone : /^\/media\/(opus-hi\/[\w.-]+)$/.test(u.pathname) ? path.join(SITES, u.pathname.slice(7)) : null;
    if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'audio/mp4', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

before(async () => {
  server = await startTrackServer({ seconds: 30 });
  rec = await startRecServer();
  multi = await startMultiServer();
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
  await h?.close(); await server?.close(); await rec?.close(); await multi?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
// A test that fails part way leaves nothing to the next: every deck ejected, every page but the deck page
// closed, the settings it changed put back, the kept tracks dropped.
afterEach(async () => {
  if (!deck) return;
  for (const x of await decks().catch(() => [])) await act(deck, x.id, 'eject').catch(() => {});
  await waitFor(async () => !(await decks()).length, 8000).catch(() => {});
  for (const p of h.context.pages()) if (p !== deck) await p.close().catch(() => {});
  const m = (await state(deck)).master.params;
  if (m['resident.auto'] !== true) set(deck, null, 'resident.auto', true);
  if (m['resident.limitMin'] !== 15) set(deck, null, 'resident.limitMin', 15);
  await engine('if (e.__pcm) e.__pcm.clear(); return true;').catch(() => {});
});

/** Open a model page; `ready` waits for its player (default: playing past 0.3 s). */
async function openSite(name, query = 'autoplay=1') {
  const url = `${server.origin}/m/${name}${query ? `?${query}` : ''}`;
  const tab = await h.context.newPage();
  await tab.goto(url);
  return { tab, url, tabId: await tabIdFor(h, url) };
}
/** The page's <audio> as it is now (model pages' __media() has no mute). */
const player = (tab) => tab.evaluate(() => { const a = document.querySelector('audio'); return { t: a.currentTime, paused: a.paused, muted: a.muted, rate: a.playbackRate, pp: a.preservesPitch }; });
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
  // No mute of ours is left on the tab, whatever its player was doing when it was released.
  const muted = await h.sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.mutedInfo), site.tabId);
  assert.equal(muted.muted, false, `the tab was left muted: ${JSON.stringify(muted)}`);
  if (d.seen != null) assert.deepEqual((await events(deck)).slice(d.seen).filter((e) => /so it was muted/.test(e.text)), []);
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

test('a YouTube-like page already playing when it is loaded plays live, naming the start its player buffered before the deck could read it', async () => {
  // The usual flow. Its player keeps that start and never fetches it again, even when run once more from there (a
  // player that has let go of it fetches it, and the track loads): live, until a player can be made to append it again.
  const site = await openSite('opaque');
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  const gap = /the player buffered the whole track, but 0\.0–\d+\.\d s came before the deck could read it/;
  assert.match(d.load.report, new RegExp(`drive \\(seek-hop, then accelerate 8× from 0\\.0 s\\): failed in \\d+\\.\\d s — ${gap.source}`));
  await assertLive(d, site, gap);
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

test('a page the DJ pauses while it loads still ends resident, and its tab is released paused, never muted', async () => {
  const site = await openSite('progressive');
  await playing(site.tab);
  const d = await loadTab(site.tabId, {
    during: async (r) => {
      await waitFor(() => engine(`const l = e.loads.get(${r.deckId}); return !!l && l.loader.tapping;`), 15000);
      await site.tab.click('body', { position: { x: 2, y: 2 } }); // a pause the user makes gets past the deck's pause guard
      await site.tab.evaluate(() => document.querySelector('audio').pause());
    },
  });
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  const c = await compare(d.id, [`${server.origin}/m/media/track.mp3`]);
  assert.ok(Math.abs(d.duration - c.refSeconds) < 0.015 && c.maxd < 1e-6, JSON.stringify(c));
  await assertReleased(d, site);
});

test('a track longer than twice the resident limit, behind <audio src> or on a Bandcamp-like page, loads its first part: said once and reported', async () => {
  set(deck, null, 'resident.limitMin', 1);
  await waitFor(async () => (await state(deck)).master.params['resident.limitMin'] === 1);
  try {
    for (const page of ['long', 'bc-long']) {
      const site = { tab: await h.context.newPage(), url: `${rec.origin}/${page}` };
      await site.tab.goto(site.url);
      site.tabId = await tabIdFor(h, site.url);
      await playing(site.tab);
      const d = await loadTab(site.tabId);
      assert.equal(d.kind, 'resident', `${page}: ${JSON.stringify(d.load)}`);
      assert.ok(Math.abs(d.duration - 60) < 0.015, `${page}: deck ${d.duration} s`);
      const c = await compare(d.id, [`${rec.origin}/long.mp3`]);
      assert.ok(c.refSeconds > 149.9, `the MP3 is ${c.refSeconds} s`);
      assert.ok(c.maxd < 1e-4, `${page}: ${JSON.stringify(c)}`);
      assert.match(d.load.report, /Limit: this track is 2\.5 minutes long: the deck holds its first 1 minute/);
      if (page === 'bc-long') assert.match(d.load.report, /file \(reading the page's track link\): ok/);
      const notice = () => events(deck).then((es) => es.slice(d.seen).filter((e) => e.text === `Deck ${d.slot}: this track is 2.5 minutes long: the deck holds its first 1 minute (the resident track limit).`));
      await waitFor(async () => (await notice()).length > 0, 5000).catch(() => {});
      assert.equal((await notice()).length, 1, JSON.stringify((await events(deck)).slice(d.seen)));
      await assertReleased(d, site);
    }
  } finally {
    set(deck, null, 'resident.limitMin', 15);
    await waitFor(async () => (await state(deck)).master.params['resident.limitMin'] === 15);
  }
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

// ---------------------------------------------------------------- several players in one tab
test('the track length is the heard player\'s: a muted player in the top frame beside the track in an iframe changes nothing', async () => {
  const site = { tab: await h.context.newPage(), url: `${multi.origin}/dur` };
  await site.tab.goto(site.url);
  site.tabId = await tabIdFor(h, site.url);
  const frame = () => site.tab.frames().find((f) => f.url().includes('/m/mse'));
  await waitFor(() => frame() && frame().evaluate(() => { const m = window.__media && window.__media(); return !!m && !m.paused && m.t > 0.3; }), 15000);
  await waitFor(() => site.tab.evaluate(() => { const m = window.__media(); return !m.paused && m.duration > 23 && m.duration < 25; }), 15000);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `duration ${d.duration}`);
  assert.match(d.load.report, /the player says 120\.007 s/);
  const c = await compare(d.id, opusUrls());
  assert.ok(c.corr > 0.9999 && c.maxd < 1e-3, JSON.stringify(c));
  await assertReleased(d, site);
});

test('another player in the tab, beside the track or muted in an iframe, never puts its audio in the deck', async () => {
  for (const where of ['same', 'sub']) {
    const site = { tab: await h.context.newPage(), url: `${multi.origin}/two-${where}` };
    await site.tab.goto(site.url);
    site.tabId = await tabIdFor(h, site.url);
    await playing(site.tab);
    const other = () => (where === 'same' ? site.tab.mainFrame() : site.tab.frames().find((f) => f.url().endsWith('/bframe')));
    await waitFor(() => other() && other().evaluate(() => typeof window.__startB === 'function'), 15000);
    const d = await loadTab(site.tabId, {
      // It starts once the deck is reading the page, so all it appends is captured: a 440 Hz tone at 0–24 s.
      during: async (r) => {
        await waitFor(() => engine(`const l = e.loads.get(${r.deckId}); return !!l && l.loader.tapping;`), 15000);
        await other().evaluate(() => window.__startB());
      },
    });
    assert.equal(d.kind, 'resident', `${where}: ${JSON.stringify(d.load)}`);
    assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `${where}: duration ${d.duration}`);
    const c = await compare(d.id, opusUrls());
    assert.ok(c.corr > 0.9999 && c.maxd < 1e-3, `${where}: ${JSON.stringify(c)}`);
    await assertReleased(d, site);
  }
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
  const kicks = await kicksOf(loading.id);
  t.diagnostic(`beat to beat (ms): ${kicks.slice(1).map((x, i) => Math.round((x - kicks[i]) * 1000)).join(' ')}; ${r.load.report.split('\n').filter((l) => /^Mended/.test(l)).join('') || 'nothing mended'}`);
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

/** Kick onsets (s) in a promoted deck's kept track: its envelope (2 ms) rising through 35 % of its loudest. */
const kicksOf = (deckId) => engine(`const pcm = e.__pcm.get(${deckId}), L = pcm.L, sr = pcm.sampleRate, hop = Math.round(sr * 0.002), env = [];
  for (let i = 0; i + hop <= L.length; i += hop) { let m = 0; for (let j = 0; j < hop; j++) m = Math.max(m, Math.abs(L[i + j])); env.push(m); }
  const max = Math.max(...env), on = [];
  for (let i = 1; i < env.length; i++) if (env[i] >= 0.35 * max && env[i - 1] < 0.35 * max && (!on.length || (i * hop) / sr - on[on.length - 1] > 0.15)) on.push((i * hop) / sr);
  return on;`);

/**
 * In the engine (offscreen page): every jds-recorder made from now on gets its capture skipped as a busy computer's
 * tab capture skips it, the page's player and the engine's clock none the wiser: before batch `ins` 10 ms of silence
 * is put in, and from batch `lose` 10 ms is lost. Each batch keeps its length (and context frame), so all the audio
 * after a skip comes 10 ms late (or early). undo() puts AudioWorkletNode back.
 */
function captureSkips(ins, lose) {
  const W = globalThis.AudioWorkletNode, onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  const skip = (frames) => { let batch = 0, q = new Int16Array(0); return (m) => {
    if (!m || m.t !== 'data') return m;
    const b = batch++, got = m.buf.subarray(0, m.frames * 2), add = b === lose ? got.subarray(2 * frames) : got, gap = b === ins ? 2 * frames : 0;
    const all = new Int16Array(q.length + gap + add.length);
    all.set(q); all.set(add, q.length + gap);
    q = all.slice(2 * m.frames);
    return { ...m, buf: all.slice(0, 2 * m.frames) };
  }; };
  globalThis.AudioWorkletNode = class extends W {
    constructor(ctx, name, opts) {
      super(ctx, name, opts);
      if (name !== 'jds-recorder') return;
      const port = this.port, edit = skip(Math.round(0.01 * ctx.sampleRate));
      let fn = null;
      Object.defineProperty(port, 'onmessage', { configurable: true, get: () => fn, set: (f) => { fn = f; onmessage.set.call(port, f ? (ev) => f({ data: edit(ev.data) }) : null); } });
    }
  };
  window.__undoSkips = () => { globalThis.AudioWorkletNode = W; };
}

test('recording a whole track through a capture that skips (a busy computer loses or repeats 10 ms now and then): every beat in its place', async (t) => {
  await engine(`(${captureSkips})(14, 34); return true;`); // 2.4 s and 5.8 s into the capture: 3.4 s and 10.2 s of the track
  try {
    const { site, d } = await liveDeck(`${rec.origin}/rec`);
    await playing(site.tab);
    assert.deepEqual(await act(deck, d.id, 'recordWhole'), { ok: true, error: undefined });
    const loading = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 5000);
    const r = await deckWhere((x) => x.id === loading.id && x.kind === 'resident', 40000);
    const kicks = await kicksOf(loading.id), T = 60 / 124, iv = kicks.slice(1).map((x, i) => (x - kicks[i]) * 1000);
    t.diagnostic(`beat to beat (ms): ${iv.map(Math.round).join(' ')}; bpm ${r.bpm.native}`);
    assert.ok(kicks.length >= 32, `${kicks.length} kicks`);
    // The first beat starts the recording (where it crosses -50 dBFS, not 35 %): the rest are a beat apart.
    const off = iv.slice(1).filter((x) => Math.abs(x - T * 1000) > 2);
    assert.deepEqual(off.map(Math.round), [], 'beats out of place');
    assert.ok(Math.abs(r.bpm.native - 124) < 0.1, `bpm ${r.bpm.native}`);
    // (A busy box may skip the real capture too: those are mended and listed beside these two.)
    assert.match(r.load.report, /^Mended: \d+ skips in the capture \(the computer was busy\): (.*, )?20 ms put in at \d+\.\d s, (.*, )?20 ms lost at \d+\.\d s(,.*)?$/m);
  } finally { await engine('window.__undoSkips && window.__undoSkips(); return true;'); }
});

// ---------------------------------------------------------------- races, ejects, the page going away (Review Focus 1, 2, 5)
test('two loads racing on two tabs: each deck gets its own track, checked by its audio', async () => {
  const sites = [];
  for (const name of ['rec', 'rec2']) {
    const tab = await h.context.newPage(), url = `${rec.origin}/${name}`;
    await tab.goto(url);
    sites.push({ tab, url, tabId: await tabIdFor(h, url) });
  }
  await Promise.all(sites.map((x) => playing(x.tab)));
  const [ra, rb] = await Promise.all(sites.map((x) => hubCall(deck, { type: 'LOAD_TAB', tabId: x.tabId })));
  assert.ok(ra.ok && rb.ok, JSON.stringify([ra, rb]));
  const [da, db] = await Promise.all([ra, rb].map((r) => deckWhere((x) => x.id === r.deckId && x.kind === 'resident' && x.tabId === null, 30000)));
  // Each deck's audio against both sources: its own matches, the other tab's does not.
  const c = await engine(`
    const ref = async (u) => (await e.ctx.decodeAudioData(await (await fetch(u)).arrayBuffer())).getChannelData(0);
    const srcs = [await ref('${rec.origin}/rec.mp3'), await ref('${rec.origin}/rec2.mp3')];
    const corr = (a, b) => { let ab = 0, aa = 0, bb = 0; const n = Math.min(a.length, b.length, 4 * e.ctx.sampleRate); for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return ab / Math.sqrt(aa * bb); };
    const out = [${da.id}, ${db.id}].map((id) => srcs.map((s) => corr(e.__pcm.get(id).L, s)));
    for (const id of [${da.id}, ${db.id}]) e.__pcm.delete(id);
    return out;
  `);
  assert.ok(c[0][0] > 0.99 && c[1][1] > 0.99, `own tracks: ${JSON.stringify(c)}`);
  assert.ok(Math.abs(c[0][1]) < 0.2 && Math.abs(c[1][0]) < 0.2, `crossed: ${JSON.stringify(c)}`);
  assert.ok(Math.abs(da.bpm.native - 124) < 0.5 && Math.abs(db.bpm.native - 128) < 0.5, `${da.bpm.native}, ${db.bpm.native}`);
  for (const d of [da, db]) assert.equal((await act(deck, d.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).length, 8000);
  for (const x of sites) await x.tab.close();
});

/**
 * A YouTube-like page loading on a deck, its player being driven: the page, the deck and the loader's sends and
 * parts, recorded. Its network is slowed (about 60 kB/s), so the drive takes several seconds, as on a real site.
 */
async function drivenLoad() {
  const site = await openSite('opaque', '');
  const cdp = await h.context.newCDPSession(site.tab);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 60 * 1024, uploadThroughput: -1 });
  const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: site.tabId });
  assert.equal(r.ok, true, JSON.stringify(r));
  await waitFor(() => engine(`const l = e.loads.get(${r.deckId}); return !!l && l.loader.tapping;`), 15000);
  await engine(`const l = e.loads.get(${r.deckId}).loader, send = l.send.bind(l), tap = l.onTap.bind(l);
    l.log = []; l.blobs = []; window.__s = e.decks.get(${r.deckId}).stream;
    l.send = (f, m) => { l.log.push({ at: performance.now(), m }); return send(f, m); };
    l.onTap = (id, m) => { if (m.t === 'tap-ready') for (const p of m.parts) l.blobs.push(p.blobUrl); return tap(id, m); };
    window.__l = l; return true;`);
  await site.tab.click('#play');
  await deckWhere((x) => x.id === r.deckId && /running the player/.test(x.load.strategy || ''), 15000);
  await waitFor(async () => (await player(site.tab)).muted, 5000); // muted while driven
  return { site, deckId: r.deckId };
}

test('ejected mid-drive: within 1 s the page has its player back, the capture is released, the blob URLs revoked, and no command follows', async () => {
  const { site, deckId } = await drivenLoad();
  const t0 = await engine(`window.__ejectAt = performance.now(); e.eject(${deckId}); return window.__ejectAt;`);
  await waitFor(async () => { const x = await player(site.tab); return x.paused && !x.muted && x.rate === 1 && x.pp; }, 1000)
    .catch(async () => assert.fail(`after 1 s: ${JSON.stringify(await player(site.tab))}`));
  const m = await player(site.tab);
  assert.ok(m.t < 8, `the player is back where it was before the drive, not where it was driven to: ${m.t}`);
  await waitFor(async () => !(await decks()).some((x) => x.id === deckId), 3000);
  await sleep(1500);
  const after = await engine(`return { ended: window.__s.getTracks().every((t) => t.readyState === 'ended'), late: window.__l.log.filter((x) => x.at > ${t0}).map((x) => x.m), blobs: window.__l.blobs.slice(0, 3) };`);
  assert.equal(after.ended, true, 'the held capture is stopped');
  for (const x of after.late) assert.ok((x.t === 'drive' && x.mode === 'stop') || (x.t === 'tap' && x.on === false), `sent after the eject: ${JSON.stringify(x)}`);
  assert.ok(after.blobs.length > 0);
  assert.deepEqual(await site.tab.evaluate((us) => Promise.all(us.map((u) => fetch(u).then(() => 'readable', () => 'revoked'))), after.blobs), after.blobs.map(() => 'revoked'));
  await site.tab.close();
});

test('ejected while the beat is being found: the analysis Worker is terminated and no deck is left', async () => {
  await engine(`if (!window.__W) { const W = window.__W = globalThis.Worker; window.__workers = { made: 0, ended: 0 };
    globalThis.Worker = class extends W { constructor(...a) { super(...a); window.__workers.made++; } terminate() { window.__workers.ended++; return super.terminate(); } }; }
    window.__workers = { made: 0, ended: 0 };
    const f = e.analyse.bind(e); e.__analyse = f;
    e.analyse = (pcm, signal) => { const p = f(pcm, signal); const id = [...e.loads.keys()][0]; e.eject(id); return p; };
    return true;`);
  try {
    const site = await openSite('progressive');
    await playing(site.tab);
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: site.tabId });
    assert.equal(r.ok, true);
    await waitFor(async () => !(await decks()).some((x) => x.id === r.deckId), 30000);
    await waitFor(() => engine('return window.__workers.made > 0 && window.__workers.made === window.__workers.ended;'), 3000)
      .catch(async () => assert.fail(JSON.stringify(await engine('return window.__workers;'))));
    assert.deepEqual(await engine('return [...e.__pcm.keys()];'), [], 'nothing was promoted');
    await site.tab.close();
  } finally { await engine('e.analyse = e.__analyse; delete e.__analyse; return true;'); }
});

test('the page navigating away mid-load: the deck plays the tab live, saying so once, with no error', async () => {
  const { site, deckId } = await drivenLoad();
  const seen = (await events(deck)).length;
  await site.tab.goto(`${server.origin}/m/progressive?autoplay=1`);
  const d = await deckWhere((x) => x.id === deckId && x.kind === 'live', 15000);
  assert.equal(d.tabId, site.tabId);
  const said = (await events(deck)).slice(seen);
  assert.equal(said.filter((e) => /^Deck \d: the page changed while the track was loading/.test(e.text)).length, 1, JSON.stringify(said));
  assert.deepEqual(said.filter((e) => e.level === 'error'), []);
  assert.match(d.load.report, /First failure: (drive: )?.*(page went away|page changed)/);
  assert.equal((await act(deck, deckId, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).length, 8000);
  await site.tab.close();
});

// ---------------------------------------------------------------- beat-matched decks (R6.2 acceptance)
// Two decks synced and playing, the master recorded and measured with the harness's onset tools: one deck plays a
// low kick, the other a high click, so each is heard in its own band. Every beat of one is within 20 ms of a beat
// of the other and their tempos match within 0.2 %, in every 5 s of the recording.
const SYNC_S = 30;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** How late bandOnsets() reports a beat of the synthetic sound itself (s): taken off before two decks are compared. */
function onsetBias(bpm, kind, band) {
  const w = parseWav(makeTrackWav({ bpm, kind, seconds: 8 })), T = 60 / bpm;
  return median(bandOnsets(w.mono, w.sr, band).map((x) => x - Math.round(x / T) * T));
}

/** The master recorded for `seconds` (a parsed WAV), with during(t0) run meanwhile. */
async function mixRecord(seconds, during) {
  const known = await downloadIds(h);
  assert.equal((await act(deck, null, 'mixRecStart')).ok, true);
  const t0 = Date.now();
  try {
    if (during) await during(t0);
    await sleep(Math.max(0, seconds * 1000 - (Date.now() - t0)));
  } finally { await act(deck, null, 'mixRecStop'); }
  return parseWav(fs.readFileSync((await waitForDownload(h, known, 30000)).filename));
}

/**
 * The kick deck against the click deck in a master recording: each one's steady tempo (steadyBeats) and median BPM,
 * and each kick's distance (ms) to the nearest click, less the detector's own lateness on each sound, over all of
 * it and in each 5 s.
 */
function matched(wav) {
  const bias = onsetBias(124, 'low', 'low') - onsetBias(128, 'high', 'high');
  const lo = bandOnsets(wav.mono, wav.sr, 'low'), hi = bandOnsets(wav.mono, wav.sr, 'high');
  const off = lo.map((x) => ({ t: x, ms: (x - hi.reduce((b, y) => (Math.abs(x - y) < Math.abs(x - b) ? y : b), Infinity) - bias) * 1000 }));
  const abs = off.map((o) => Math.abs(o.ms)).sort((a, b) => a - b), windows = [];
  for (let w = 0; w + 5 <= wav.seconds + 0.01; w += 5) {
    const xs = off.filter((o) => o.t >= w && o.t < w + 5).map((o) => Math.abs(o.ms));
    windows.push({ from: w, n: xs.length, med: xs.length ? median(xs) : Infinity });
  }
  const A = steadyBeats(lo), B = steadyBeats(hi);
  return { lo, hi, A, B, tempoErr: A.T / B.T - 1, bpm: [medianBpm(lo), medianBpm(hi)], med: median(abs), p90: abs[Math.floor(abs.length * 0.9)], max: abs.at(-1), windows };
}
function assertMatched(t, m, seconds) {
  t.diagnostic(`tempo: kick ${(60 / m.A.T).toFixed(3)} BPM (runs ${m.A.runs.map((r) => r.length)}), click ${(60 / m.B.T).toFixed(3)} BPM (runs ${m.B.runs.map((r) => r.length)}): error ${(m.tempoErr * 100).toFixed(4)} %; median BPM ${m.bpm.map((x) => x.toFixed(2))}`);
  t.diagnostic(`|kick - click| (ms): median ${m.med.toFixed(1)}, p90 ${m.p90.toFixed(1)}, max ${m.max.toFixed(1)}; median in each 5 s: ${m.windows.map((w) => `${w.med.toFixed(1)} (${w.n})`).join(', ')}`);
  const beats = (seconds * 124) / 60;
  assert.ok(m.lo.length >= beats - 2 && m.hi.length >= beats - 2, `${m.lo.length} kicks, ${m.hi.length} clicks in ${seconds} s`);
  assert.ok(Math.abs(m.bpm[0] - 124) < 1 && Math.abs(m.bpm[1] - 124) < 1, `median BPM ${m.bpm}`);
  assert.ok(Math.abs(m.tempoErr) < 0.002, `tempo error ${(m.tempoErr * 100).toFixed(4)} %`);
  assert.ok(m.p90 <= 20, `kicks to clicks: p90 ${m.p90.toFixed(1)} ms`);
  for (const w of m.windows) assert.ok(w.n >= 8 && w.med <= 20, `${w.from}-${w.from + 5} s: median ${w.med.toFixed(1)} ms over ${w.n} beats`);
}

/** The page at url in a new tab, loaded resident and released. */
async function residentTab(url) {
  const site = { tab: await h.context.newPage(), url };
  await site.tab.goto(url);
  site.tabId = await tabIdFor(h, url);
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'resident', `${url}: ${JSON.stringify(d.load)}`);
  await deckWhere((x) => x.id === d.id && x.tabId === null, 5000);
  return { site, d };
}
const MODEL = () => `${server.origin}/m/progressive?autoplay=1`; // the 124 BPM model track (kick and chirp), 120 s
const CLICK = () => `${rec.origin}/click128`;                     // a 128 BPM click, a 60 s WAV

/** a plays as the master; b is synced to it (SYNC▶) and plays, until its phase has settled. */
async function syncPlay(a, b) {
  assert.equal((await act(deck, a.id, 'master')).ok, true);
  assert.equal((await act(deck, a.id, 'play')).ok, true);
  await sleep(500);
  assert.equal((await act(deck, b.id, 'syncPlay')).ok, true);
  const ph = [];
  await waitFor(async () => {
    const x = (await decks()).find((y) => y.id === b.id);
    if (x.sync.phaseMs != null) ph.push(Math.abs(x.sync.phaseMs));
    return x.playing && x.sync.on && ph.length >= 5 && median(ph.slice(-5)) < 5;
  }, 15000, 200).catch(() => assert.fail(`deck ${b.slot} phase (ms): ${JSON.stringify(ph.slice(-5))}`));
}

test('two resident decks beat-matched: a 128 BPM WAV synced to the 124 BPM track holds within 0.2 % and 20 ms for 30 s, measured on the master', async (t) => {
  const a = await residentTab(MODEL()), b = await residentTab(CLICK());
  await syncPlay(a.d, b.d);
  const x = (await decks()).find((y) => y.id === b.d.id);
  assert.ok(Math.abs(x.bpm.native - 128) < 0.05 && Math.abs(x.bpm.out - 124) < 0.05, JSON.stringify(x.bpm));
  assertMatched(t, matched(await mixRecord(SYNC_S)), SYNC_S);
});

test('a resident deck beat-matched to a live deck holds within 0.2 % and 20 ms for 30 s, measured on the master', async (t) => {
  // The live deck: the 124 BPM kick played by its tab (a WAV with no byte ranges), long enough that it never loops here.
  const long = await startTrackServer({ seconds: 120 });
  try {
    const { d: live } = await liveDeck(long.url('a'));
    const b = await residentTab(CLICK());
    await waitFor(async () => { const x = (await decks()).find((y) => y.id === live.id); return x.bpm.state === 'LOCKED' && Math.abs(x.bpm.native - 124) < 0.1; }, 30000);
    await syncPlay(live, b.d);
    assertMatched(t, matched(await mixRecord(SYNC_S)), SYNC_S);
  } finally { await long.close(); }
});

test('beat-matched resident decks ignore their tabs: pausing, seeking and closing each source tab leaves no glitch and no tempo change on the master', async (t) => {
  const a = await residentTab(MODEL()), b = await residentTab(CLICK());
  await syncPlay(a.d, b.d);
  const S = 24, done = [];
  // Each tab in turn, 9 s apart: its player played (out loud: the tab is not captured any more), paused, seeked, then the tab closed.
  const wav = await mixRecord(S, async (t0) => {
    const at = (s) => sleep(Math.max(0, t0 + s * 1000 - Date.now()));
    for (const [k, x] of [a, b].entries()) {
      const s0 = 3 + 9 * k;
      await at(s0); await x.site.tab.evaluate(() => document.querySelector('audio').play()); done.push(`tab ${k + 1} played at ${s0} s`);
      await at(s0 + 2); await x.site.tab.evaluate(() => document.querySelector('audio').pause()); done.push(`paused at ${s0 + 2} s`);
      await at(s0 + 4); await x.site.tab.evaluate(() => { document.querySelector('audio').currentTime = 40; }); done.push(`seeked at ${s0 + 4} s`);
      await at(s0 + 6); await x.site.tab.close(); done.push(`closed at ${s0 + 6} s`);
    }
  });
  t.diagnostic(done.join(', '));
  const m = matched(wav);
  assertMatched(t, m, S);
  // No glitch: each deck's beats are one steady run (no jump, no gap, none missing) from the first whole beat to the
  // last; and no tempo change: the second half's tempo is the first half's.
  const half = (on) => [steadyBeats(on.filter((x) => x < S / 2)).T, steadyBeats(on.filter((x) => x >= S / 2)).T];
  for (const [name, on, fit] of [['kick', m.lo, m.A], ['click', m.hi, m.B]]) {
    const runs = fit.runs.filter((r) => r.length > 1);
    assert.ok(runs.length === 1 && runs[0].length >= on.length - 2, `${name}: steady runs ${fit.runs.map((r) => r.length)}`);
    const [t1, t2] = half(on);
    assert.ok(Math.abs(t2 / t1 - 1) < 0.001, `${name}: ${(60 / t1).toFixed(3)} then ${(60 / t2).toFixed(3)} BPM`);
  }
  for (const x of [a.d, b.d]) {
    const y = (await decks()).find((z) => z.id === x.id);
    assert.deepEqual([y.kind, y.playing, y.tabId], ['resident', true, null], `deck ${x.slot}`);
  }
});

test('the deck page showed every load without errors', () => { assert.deepEqual(pageErrors, []); });
