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
let h, server, deck, rec, multi, tmp;
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decks = async () => (await state(deck)).decks;
const deckWhere = (fn, ms = 60000) => waitFor(async () => (await decks()).find(fn), ms, 150);
const engine = (body) => offscreenEval(h, `(async () => { const e = globalThis.__jdsEngine; ${body} })()`);

/**
 * MP3s behind <audio src> pages, served with byte ranges (so their players know their length): 16 s at /rec (124 BPM
 * kick) and /rec2 (128 BPM click); 150 s at /long, and behind a Bandcamp-like page (data-tralbum) at /bc-long.
 */
async function startRecServer() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jds-rec-'));
  const mp3s = {};
  for (const [name, opts, rate] of [['rec', { bpm: 124, kind: 'low', seconds: 16 }, '192k'], ['rec2', { bpm: 128, kind: 'high', seconds: 16 }, '192k'], ['long', { bpm: 124, kind: 'low', seconds: 150 }, '64k']]) {
    fs.writeFileSync(path.join(tmp, `${name}.wav`), makeTrackWav(opts));
    execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(tmp, `${name}.wav`), '-codec:a', 'libmp3lame', '-b:a', rate, path.join(tmp, `${name}.mp3`)]);
    mp3s[name] = fs.readFileSync(path.join(tmp, `${name}.mp3`));
  }
  const media = `<script>window.__media = () => { const a = document.getElementById('a'); return { t: a.currentTime, rate: a.playbackRate, pp: a.preservesPitch, paused: a.paused, duration: a.duration }; };</script>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), page = /^\/(rec2?|long)$/.exec(u.pathname), file = /^\/(rec2?|long)\.mp3$/.exec(u.pathname);
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Track ${page[1]}</title><audio id="a" src="/${page[1]}.mp3" autoplay></audio>${media}`);
      return;
    }
    if (u.pathname === '/bc-long') {
      const tralbum = JSON.stringify({ trackinfo: [{ file: { 'mp3-128': '/long.mp3' }, duration: 150 }] }).replace(/"/g, '&quot;');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Long track on a Bandcamp-like page</title><div id="t" data-tralbum="${tralbum}"></div><audio id="a" src="/long.mp3" autoplay></audio>${media}`);
      return;
    }
    if (!file) { res.writeHead(404); res.end(); return; }
    const mp3 = mp3s[file[1]];
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

/**
 * Pages with two players, on another origin. The track (A) is an MSE player of the model track (opus-hi), fed from
 * its HLS playlist 16 s ahead. The other player (B) is a 24 s 440 Hz tone (Opus fMP4, made here): a muted, looping
 * one in the top frame with the track in an iframe of /m/mse (/dur), or one that starts appending when the page's
 * window.__startB() is called: paused beside the track (/two-same) or playing muted in an iframe (/two-sub). /spa
 * has the track alone, for a single-page site that moves on to the tone in place (nextTrack).
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
  const ms = new MediaSource(), src = el.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer('audio/mp4; codecs="opus"'), app = (b) => new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(b); });
  ms.duration = ${rep.segs.at(-1).t1};
  await app(await (await fetch(init)).arrayBuffer());
  for (;;) {
    if (el.src !== src) return; // the player plays something else now
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
    '/spa': html('Track A', '<audio id="a"></audio>', `mse(document.getElementById('a'), '/media/opus-hi.m3u8');`),
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (pages[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[u.pathname]); return; }
    if (u.pathname === '/media/opus-hi.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(m3u8); return; }
    const f = u.pathname === '/tone.mp4' ? tone : /^\/media\/(opus-hi\/[\w.-]+)$/.test(u.pathname) ? path.join(SITES, u.pathname.slice(7)) : null;
    if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    // The tone is fetched by pages on other origins too, as a single-page site's next track (nextTrack).
    res.writeHead(200, { 'content-type': 'audio/mp4', 'cache-control': 'no-store', ...(f === tone ? { 'access-control-allow-origin': '*' } : {}) });
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

test('an ABR page captured across its quality switch (lo, then hi from 12 s) ends resident from both renditions, with no doubled or missing audio at the switch', async (t) => {
  const site = await openSite('abr', '');
  const d = await loadTab(site.tabId, {
    // Its player starts once the deck is reading the page, so the tap captures the switch itself. What the deck is
    // decoded from is kept: each piece's SHA-256, to tell which rendition it is.
    during: async (r) => {
      await waitFor(() => engine(`const l = e.loads.get(${r.deckId}); return !!l && l.loader.tapping;`), 15000);
      await engine(`const l = e.loads.get(${r.deckId}).loader, dp = l.d.decodePlaced;
        const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
        l.d.decodePlaced = async (ctx, placed, o) => {
          window.__runs = await Promise.all(placed.runs.map(async (run) => Promise.all(run.segs.map(async (s) => ({ t0: s.t0, t1: s.t1, sha: await hex(s.bytes) })))));
          return dp(ctx, placed, o);
        };
        return true;`);
      await site.tab.click('#play');
    },
  });
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `duration ${d.duration}`);
  // Both renditions are in what the deck was decoded from, each piece byte-true, lo up to the switch and hi after it.
  const repOf = new Map(['opus-lo', 'opus-hi'].flatMap((rep) => index.reps[rep].segs.map((s) => [s.sha256, { rep, t0: s.t0 }])));
  const segs = (await engine('return window.__runs;')).flat();
  for (const s of segs) assert.ok(repOf.has(s.sha) && Math.abs(repOf.get(s.sha).t0 - s.t0) < 1e-6, `the piece at ${s.t0} s is no rendition's piece for that time`);
  const at = (t) => repOf.get(segs.find((s) => s.t0 <= t && t < s.t1).sha).rep;
  assert.deepEqual([at(10), at(14)], ['opus-lo', 'opus-hi'], 'the switch at 12 s is in the deck');
  assert.ok(new Set(segs.map((s) => repOf.get(s.sha).rep)).size === 2);
  // Continuous at the switch: either side lines up with its rendition decoded whole at lag 0 (a doubled or missing
  // piece would shift it by whole seconds), and the span across the switch matches the two stitched there.
  const c = await engine(`
    const pcm = e.__pcm.get(${d.id}), a = pcm.L, sr = pcm.sampleRate;
    const dec = async (rep) => {
      const bufs = await Promise.all(${JSON.stringify(Object.fromEntries(['opus-lo', 'opus-hi'].map((rep) => [rep, opusUrls(rep)])))}[rep].map((u) => fetch(u).then((r) => r.arrayBuffer())));
      const cat = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0)); let k = 0;
      for (const b of bufs) { cat.set(new Uint8Array(b), k); k += b.byteLength; }
      return (await e.ctx.decodeAudioData(cat.buffer)).getChannelData(0);
    };
    const lo = await dec('opus-lo'), hi = await dec('opus-hi'), cut = Math.round(12 * sr);
    const both = new Float32Array(hi.length); both.set(lo.subarray(0, cut)); both.set(hi.subarray(cut), cut);
    const corr = (ref, i0, n, lag) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { const x = a[i0 + i], y = ref[i0 + i + lag]; ab += x * y; aa += x * x; bb += y * y; } return ab / Math.sqrt(aa * bb); };
    const best = (ref, from, to) => {
      const i0 = Math.round(from * sr), n = Math.round((to - from) * sr), W = Math.round(0.04 * sr);
      let lag = 0, top = -2;
      for (let l = -W; l <= W; l += 2) { const x = corr(ref, i0, n, l); if (x > top) { top = x; lag = l; } }
      for (let l = lag - 2; l <= lag + 2; l++) { const x = corr(ref, i0, n, l); if (x > top) { top = x; lag = l; } }
      return { lagMs: (lag / sr) * 1000, corr: top, atZero: corr(ref, i0, n, 0) };
    };
    e.__pcm.delete(${d.id});
    return { before: best(lo, 10.5, 11.95), after: best(hi, 12.05, 13.5), across: best(both, 11.5, 12.5) };
  `);
  t.diagnostic(`runs: ${segs.map((s) => `${s.t0}:${repOf.get(s.sha).rep}`).join(' ')}; at the switch: ${JSON.stringify(c)}`);
  for (const [k, x] of Object.entries(c)) {
    assert.equal(x.lagMs, 0, `${k} the switch: lined up ${x.lagMs.toFixed(3)} ms off (${JSON.stringify(c)})`);
    assert.ok(x.atZero > 0.99, `${k} the switch: ${JSON.stringify(c)}`);
  }
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
  return { site, deckId: r.deckId, cdp };
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

test('ejected while the beat is being found: the analysis Worker is terminated before it finishes, and no deck is left', async () => {
  // Every Worker counted: made, terminated, and each result it sent back (one that finished its analysis sends one).
  await engine(`if (!window.__W) { const W = window.__W = globalThis.Worker;
    globalThis.Worker = class extends W {
      constructor(...a) { super(...a); window.__workers.made++; this.addEventListener('message', () => { window.__workers.results++; }); }
      terminate() { window.__workers.ended++; return super.terminate(); }
    }; }
    window.__workers = { made: 0, ended: 0, results: 0 };
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
    // analyseTrack terminates its Worker once it has answered too: only one stopped by the eject never answers.
    await sleep(1000);
    assert.equal(await engine('return window.__workers.results;'), 0, 'the Worker finished its analysis: the eject did not stop it');
    assert.deepEqual(await engine('return [...e.__pcm.keys()];'), [], 'nothing was promoted');
    await site.tab.close();
  } finally { await engine('e.analyse = e.__analyse; delete e.__analyse; return true;'); }
});

/** The deck's kinds from now until it is gone (or ms pass), polled from the engine. */
async function kindsUntilGone(deckId, ms = 8000) {
  const seen = [], t0 = Date.now();
  for (;;) {
    const d = await engine(`const d = e.decks.get(${deckId}); return d ? d.kind : null;`);
    if (d == null || Date.now() - t0 > ms) return seen;
    if (seen.at(-1) !== d) seen.push(d);
    await sleep(20);
  }
}

/** After a test, whatever it left: every deck ejected, every model page closed (so a failure does not carry on). */
async function tidy() {
  for (const id of await engine('return [...e.decks.keys()];')) await engine(`await e.eject(${id}); return true;`);
  for (const p of h.context.pages()) if (p !== deck && !p.isClosed() && p.url().startsWith(server.origin)) await p.close();
}

test('the page reloading mid-load (the same page again): the deck plays the tab live, saying so once, with no error', async () => {
  try {
    const { site, deckId } = await drivenLoad();
    const seen = (await events(deck)).length;
    await site.tab.reload();
    const d = await deckWhere((x) => x.id === deckId && x.kind === 'live', 15000);
    assert.equal(d.tabId, site.tabId);
    const said = (await events(deck)).slice(seen);
    assert.equal(said.filter((e) => /^Deck \d: the page changed while the track was loading/.test(e.text)).length, 1, JSON.stringify(said));
    assert.deepEqual(said.filter((e) => e.level === 'error'), []);
    assert.match(d.load.report, /First failure: (drive: )?.*(page went away|page changed)/);
    assert.match(d.load.report, /page: reload in \d+\.\d s — the same page again/);
  } finally { await tidy(); }
});

test('the page moving on to another page mid-load: the deck goes with one error, and never plays that page live', async () => {
  try {
    const { site, deckId } = await drivenLoad();
    const seen = (await events(deck)).length;
    const kinds = kindsUntilGone(deckId, 15000);
    await site.tab.goto(`${server.origin}/m/progressive?autoplay=1`);
    assert.ok(!(await kinds).includes('live'), 'it was never a live deck');
    await sleep(500);
    const said = (await events(deck)).slice(seen).filter((e) => e.text.startsWith('Deck '));
    assert.deepEqual(said.map((e) => [e.level, e.text.replace(/^Deck \d/, 'Deck N')]),
      [['error', 'Deck N: the page moved on to something else before the track was in. Add the tab again.']]);
    assert.equal(await h.sw.evaluate(() => chrome.action.getBadgeText({})), '', 'the hub forgot the tab');
  } finally { await tidy(); }
});

/**
 * A single-page site moving on to its next track, as YouTube, SoundCloud and Mixcloud do: the address changes with no
 * page load (the page and its agents stay), then the same <audio> plays the next track (the 24 s tone, fetched over the
 * network) on a MediaSource of its own. Answers once the engine has the new address for the deck (the hub's META, in
 * milliseconds, where a real page's pieces take seconds).
 */
const nextTrack = async (tab, to, deckId) => {
  await tab.evaluate(({ to: path, tone }) => {
    history.pushState(null, '', path);
    document.title = 'Track B';
    (async () => {
      const a = document.querySelector('audio'), b = await (await fetch(tone)).arrayBuffer(), ms = new MediaSource();
      a.src = URL.createObjectURL(ms);
      await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
      const sb = ms.addSourceBuffer('audio/mp4; codecs="opus"');
      await new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(b); });
      try { ms.endOfStream(); } catch (_) {}
      a.play().catch(() => {});
    })();
  }, { to, tone: `${multi.origin}/tone.mp4` });
  await waitFor(() => engine(`const d = e.decks.get(${deckId}); return !d || new URL(d.meta.url).pathname === ${JSON.stringify(to)};`), 5000);
};
/** The deck's end: 'gone', or the kind it took instead ('live', 'resident'). */
const endOf = (deckId, ms = 30000) => waitFor(async () => {
  const k = await engine(`const d = e.decks.get(${deckId}); return d ? d.kind : 'gone';`);
  return k === 'loading' ? null : k;
}, ms, 20);
/**
 * What a deck that went because its page moved on leaves: one error, never a word of playing live or of a loaded track,
 * nothing promoted, the hub's tab forgotten. (Its eject stops the tab as every eject does: a player caught between two
 * tracks has nothing to pause, so the tab is muted, and that is said.)
 */
async function assertMovedOn(deckId, seen) {
  await sleep(500);
  const said = (await events(deck)).slice(seen);
  assert.deepEqual(said.filter((e) => e.level !== 'info').map((e) => [e.level, e.text.replace(/^Deck \d/, 'Deck N')]),
    [['error', 'Deck N: the page moved on to something else before the track was in. Add the tab again.']]);
  assert.deepEqual(said.filter((e) => /plays live|^Loaded/.test(e.text)), []);
  assert.equal(await engine(`return e.__pcm.has(${deckId});`), false, 'nothing was promoted');
  assert.equal(await h.sw.evaluate(() => chrome.action.getBadgeText({})), '', 'the hub forgot the tab');
}

test('a single-page site moving on to another track while its pieces are fetched again: the deck goes with one error, and never plays it live', async () => {
  const url = `${multi.origin}/spa`, tab = await h.context.newPage();
  try {
    await tab.goto(url);
    const tabId = await tabIdFor(h, url);
    await playing(tab);
    const cdp = await h.context.newCDPSession(tab);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 40 * 1024, uploadThroughput: -1 });
    const seen = (await events(deck)).length;
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId });
    assert.equal(r.ok, true, JSON.stringify(r));
    await deckWhere((x) => x.id === r.deckId && /fetching the track's pieces/.test(x.load.strategy || ''), 20000);
    await nextTrack(tab, '/spa/b', r.deckId);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    assert.equal(await endOf(r.deckId), 'gone');
    await assertMovedOn(r.deckId, seen);
  } finally { await tidy(); await tab.close(); }
});

test('a single-page site moving on to another track while its player is driven: the deck goes with one error, and the other track never becomes the deck', async () => {
  try {
    const { site, deckId, cdp } = await drivenLoad();
    const seen = (await events(deck)).length;
    await nextTrack(site.tab, '/m/opaque/b', deckId);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    assert.equal(await endOf(deckId), 'gone');
    await assertMovedOn(deckId, seen);
  } finally { await tidy(); }
});

test('the tab closed mid-load: the deck goes with one error, and no live deck is built on its dying capture', async () => {
  try {
    const { site, deckId } = await drivenLoad();
    const seen = (await events(deck)).length;
    const kinds = kindsUntilGone(deckId, 15000);
    await site.tab.close();
    assert.ok(!(await kinds).includes('live'), 'it was never a live deck');
    await sleep(500);
    const said = (await events(deck)).slice(seen).filter((e) => e.text.startsWith('Deck '));
    assert.deepEqual(said.map((e) => [e.level, e.text.replace(/^Deck \d/, 'Deck N')]), [['error', 'Deck N: the tab was closed before the track was in.']]);
  } finally { await tidy(); }
});

test('the deck page showed every load without errors', () => { assert.deepEqual(pageErrors, []); });
