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
  downloadIds, waitForDownload, parseWav, steadyBeats, onsetBias, beatMatch, matchFaults, levelFaults,
} from './ext-harness.mjs';
import { synth, PATTERNS, FS, makeRng } from '../unit/fixtures/synth.mjs';

const SITES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sites');
const index = JSON.parse(fs.readFileSync(path.join(SITES, 'index.json'), 'utf8'));
const OPUS_END = index.reps['opus-hi'].segs.at(-1).t1; // 120.0065
let h, server, deck, rec, multi, tmp;
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decks = async () => (await state(deck)).decks;
const deckWhere = (fn, ms = 60000) => waitFor(async () => (await decks()).find(fn), ms, 150);
const engine = (body) => offscreenEval(h, `(async () => { const e = globalThis.__jdsEngine; ${body} })()`);

/** A 16-bit mono WAV of x (at the synth's rate), peak-normalised to -2 dBFS. */
function loopWav(x) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = 0.8 / peak, n = x.length, buf = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * g * 32767))), 44 + i * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(FS, 24);
  buf.writeUInt32LE(FS * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

/** 124 BPM kicks after 1.5 s of silence, with 1 s of silence after the last (LEAD): a track whose ends are silent. */
const LEAD = { lead: 1.5, beats: 26, tail: 1, bpm: 124 };
function leadTrack() {
  const beat = 60 / LEAD.bpm, x = new Float32Array(Math.round((LEAD.lead + LEAD.beats * beat + LEAD.tail) * FS));
  for (let b = 0; b < LEAD.beats; b++) {
    const k0 = Math.round((LEAD.lead + b * beat) * FS);
    for (let i = 0; i < 0.2 * FS; i++) { const t = i / FS; x[k0 + i] = 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-t * 35)) * t) * Math.exp(-t * 18); }
  }
  return x;
}

/** 24 s of kicks with off-beat hats on a tempo map: at t s the beat is 60 / bpm(t) long (a track whose own tempo moves). */
function tempoTrack(bpm, seconds = 24) {
  const x = new Float32Array(Math.round(seconds * FS)), rnd = makeRng(99);
  const add = (t0, len, fn) => { const s0 = Math.round(t0 * FS); for (let i = 0; i < len * FS && s0 + i < x.length; i++) x[s0 + i] += fn(i / FS); };
  for (let t = 0; t < seconds; t += 60 / bpm(t)) {
    add(t, 0.2, (u) => 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-u * 35)) * u) * Math.exp(-u * 18));
    add(t + 30 / bpm(t), 0.05, (u) => 0.15 * (2 * rnd() - 1) * Math.exp(-u / 0.015));
  }
  return x;
}

/**
 * MP3s behind <audio src> pages, served with byte ranges (so their players know their length): 16 s at /rec (124 BPM
 * kick) and /rec2 (128 BPM click); 150 s at /long, and behind a Bandcamp-like page (data-tralbum) at /bc-long. And
 * WAVs the same way: 60 s of the 128 BPM click at /click128, and 12 bars of a techno loop with a continuous bed (kick,
 * hats, bass and a pad: PATTERNS.techno, 132.7 BPM) at /techno; 24 s whose tempo rises from 124 to 126 BPM at /ramp, and
 * 24 s at 124 BPM, then 126 from 12 s, at /step.
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
    'click128.wav': { type: 'audio/wav', buf: makeTrackWav({ bpm: 128, kind: 'high', seconds: 60 }) },
    'techno.wav': { type: 'audio/wav', buf: loopWav(synth({ ...PATTERNS.techno, bars: 12, tail: 0.5 }).x) },
    'lead.wav': { type: 'audio/wav', buf: loopWav(leadTrack()) },
    'ramp.wav': { type: 'audio/wav', buf: loopWav(tempoTrack((t) => 124 + (2 * t) / 24)) },
    'step.wav': { type: 'audio/wav', buf: loopWav(tempoTrack((t) => (t < 12 ? 124 : 126))) },
    'tone.wav': { type: 'audio/wav', buf: loopWav(Float32Array.from({ length: 4 * FS }, (_, i) => Math.sin((2 * Math.PI * 800 * i) / FS))) } };
  const media = `<script>window.__media = () => { const a = document.getElementById('a'); return { t: a.currentTime, rate: a.playbackRate, pp: a.preservesPitch, paused: a.paused, duration: a.duration }; };</script>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), page = /^\/(rec2?|long|click128|techno|ramp|step)$/.exec(u.pathname), file = files[u.pathname.slice(1)];
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Track ${page[1]}</title><audio id="a" src="/${page[1]}.${files[`${page[1]}.wav`] ? 'wav' : 'mp3'}" autoplay></audio>${media}`);
      return;
    }
    if (u.pathname === '/lead') { // a track with silent ends, and when it ends the page plays a tone (as an autoplay plays the next track)
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Track lead</title><audio id="a" src="/lead.wav" autoplay></audio><audio id="b" src="/tone.wav"></audio>
        <script>document.getElementById('a').onended = () => document.getElementById('b').play();</script>${media}`);
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
  // Keep a copy of each promoted deck's decoded track (the deck takes the arrays), to check it against the source.
  await engine(`if (!e.__pcm) { e.__pcm = new Map(); const s = e.startResidentDeck.bind(e);
    e.startResidentDeck = (o) => { if (o && o.deckId != null && o.pcm) e.__pcm.set(o.deckId, { L: o.pcm.L.slice(), R: o.pcm.R.slice(), sampleRate: o.pcm.sampleRate }); return s(o); }; } return true;`);
  // And each tab load's Loader, to check the pieces a track was assembled from.
  await engine(`if (!e.__loaders) { e.__loaders = new Map(); const lt = e.loadTab.bind(e);
    e.loadTab = (d) => { const p = lt(d); e.__loaders.set(d.id, d.loader); return p; }; } return true;`);
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
  if (m['resident.recordWhole'] !== false) set(deck, null, 'resident.recordWhole', false);
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

test('an MSE page whose server types its playlist audio/mpegurl or audio/x-mpegurl (HLS types) ends resident: the playlist the page fetches again is read', async () => {
  for (const type of ['audio/mpegurl', 'audio/x-mpegurl']) {
    const site = await openSite('mse', `autoplay=1&listType=${encodeURIComponent(type)}`);
    await playing(site.tab);
    const d = await loadTab(site.tabId);
    assert.equal(d.kind, 'resident', `${type}: ${JSON.stringify(d.load)}`);
    assert.match(d.load.report, /\n {2}refetch \(fetching the track's pieces\): ok in \d+\.\d s — \d+ pieces fetched/, type);
    assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `${type}: duration ${d.duration}`);
    await assertReleased(d, site);
  }
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

test('a page loaded before its play button was pressed asks for the track to be started on the tab, then ends resident once it is', async () => {
  const site = await openSite('mse', '');
  const d = await loadTab(site.tabId, {
    // The DJ presses play on the tab only once the deck asks for it.
    during: async (r) => {
      const waiting = await deckWhere((x) => x.id === r.deckId && x.load.strategy === 'start the track on the tab', 15000);
      // Meanwhile its load report can be copied, from the ⓘ in its header on the deck page.
      assert.match(waiting.load.report, /^JD Samps load report\n[^]*Result: still loading: start the track on the tab\n/);
      const el = deck.locator('.deck', { has: deck.locator('[data-title]', { hasText: 'Model site: mse' }) });
      await waitFor(() => el.locator('[data-report-btn]').isVisible(), 5000);
      await site.tab.click('#play');
    },
  });
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `duration ${d.duration}`);
  const c = await compare(d.id, opusUrls());
  assert.ok(c.corr > 0.9999 && c.maxd < 1e-3, JSON.stringify(c));
  const said = (await events(deck)).slice(d.seen).map((e) => e.text).filter((t) => t.startsWith(`Deck ${d.slot}: `));
  assert.equal(said.filter((t) => /start the track on the tab/.test(t)).length, 1, JSON.stringify(said));
  assert.deepEqual(said.filter((t) => /without a media player|plays live/.test(t)), []);
  assert.match(d.load.report, /note: the track was started on the tab/);
  await assertReleased(d, site);
});

/**
 * Every piece the deck's track was assembled from, against index.json: each byte-identical to a segment (or init) of
 * a rendition at the same media time, and together covering 0 to the end of the track with no gap.
 */
async function assertBytesTrue(deckId) {
  const pieces = await engine(`
    const l = e.__loaders.get(${deckId}); e.__loaders.delete(${deckId}); e.__pcm.delete(${deckId});
    const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const out = [];
    for (const r of l.rep.placed.runs) {
      out.push({ init: await hex(r.init) });
      for (const s of r.segs) out.push({ t0: s.t0, t1: s.t1, sha: await hex(s.bytes) });
    }
    return out;`);
  const known = new Map();
  for (const [rep, r] of Object.entries(index.reps)) {
    known.set(r.init.sha256, { rep, init: true });
    for (const s of r.segs) known.set(s.sha256, { rep, t0: s.t0, t1: s.t1 });
  }
  const segs = pieces.filter((p) => !p.init);
  for (const p of pieces.filter((x) => x.init)) assert.ok(known.get(p.init)?.init, `an init segment that is not one of the renditions': ${p.init}`);
  for (const p of segs) {
    const k = known.get(p.sha);
    assert.ok(k && !k.init, `${p.t0.toFixed(3)}–${p.t1.toFixed(3)} s is not byte-identical to any segment`);
    assert.ok(Math.abs(k.t0 - p.t0) < 1e-3 && Math.abs(k.t1 - p.t1) < 1e-3, `placed at ${p.t0}–${p.t1}, but it is ${k.rep}'s ${k.t0}–${k.t1}`);
  }
  segs.sort((a, b) => a.t0 - b.t0);
  assert.equal(segs[0].t0, 0);
  segs.slice(1).forEach((s, i) => assert.ok(Math.abs(s.t0 - segs[i].t1) < 1e-3, `a gap or overlap at ${segs[i].t1}–${s.t0}`));
  // (The last 6.5 ms of the track is a segment of its own, shorter than a codec frame: assembly leaves it out.)
  assert.ok(Math.abs(segs.at(-1).t1 - OPUS_END) < 0.02, `ends at ${segs.at(-1).t1}`);
  return pieces;
}

for (const name of ['opaque', 'mse', 'abr']) {
  test(`/m/${name} already playing for 5 s when it is loaded ends resident: every piece byte-true, the length to 15 ms`, async () => {
    // The usual flow: the DJ hears the track in its tab, then loads it. What its player buffered before the deck's tap
    // came on is fetched again: from the links it used (mse, abr) or, with single-use links (opaque), by having the
    // player flush its buffer and driving it from 0.
    const site = await openSite(name);
    await waitFor(() => site.tab.evaluate(() => { const m = window.__media(); return !m.paused && m.t > 5; }), 20000);
    const d = await loadTab(site.tabId);
    assert.equal(d.kind, 'resident', JSON.stringify(d.load));
    assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `duration ${d.duration}`);
    await assertBytesTrue(d.id);
    if (name === 'opaque') assert.match(d.load.report, /drive \(seek-hop after a flush\): ok/);
    await assertReleased(d, site);
  });
}

test('a YouTube-like page whose player goes on from its last segment as shaka does (?onward=1), already playing for 5 s when it is loaded, ends resident', async () => {
  // shaka looks at its buffer only when it seeks, and empties it on a seek outside what it holds only if it still holds
  // something: emptied under it and sent to 0, it goes on from its last segment and jumps its playhead over the gap.
  const site = await openSite('opaque', 'autoplay=1&onward=1');
  await waitFor(() => site.tab.evaluate(() => { const m = window.__media(); return !m.paused && m.t > 5; }), 20000);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'resident', JSON.stringify(d.load));
  assert.ok(Math.abs(d.duration - OPUS_END) < 0.015, `duration ${d.duration}`);
  await assertBytesTrue(d.id);
  await assertReleased(d, site);
});

test('a YouTube-like page whose player never fetches a piece twice (?sticky=1), already playing when loaded, plays live: the report says it would not fetch the start again', async () => {
  const site = await openSite('opaque', 'autoplay=1&sticky=1');
  await waitFor(() => site.tab.evaluate(() => { const m = window.__media(); return !m.paused && m.t > 5; }), 20000);
  const d = await loadTab(site.tabId);
  // The live deck plays from the tab: its player was left what it holds around its place, and plays on.
  const p0 = await player(site.tab);
  await waitFor(async () => (await player(site.tab)).t > p0.t + 1.5, 5000)
    .catch(async () => assert.fail(`the tab does not play on after the live fallback: ${JSON.stringify(p0)} -> ${JSON.stringify(await site.tab.evaluate(() => window.__media()))}`));
  assert.deepEqual([p0.paused, p0.muted, p0.rate], [false, false, 1]);
  const why = /the player would not fetch the start again after a flush: 0\.0–2\d\.\d s came before the deck could read it/;
  assert.match(d.load.report, new RegExp(`drive \\(seek-hop\\): failed in \\d+\\.\\d s — ${why.source}`));
  assert.deepEqual(await engine(`const has = e.__pcm.has(${d.id}); e.__loaders.delete(${d.id}); return has;`), false, 'never promoted');
  await assertLive(d, site, why);
});

test('a YouTube-like page loaded a second time, after its first load drove its player through the whole track, ends resident again', async () => {
  // The first load's drive leaves the player holding all of the track, its stream ended. The DJ plays the track on the
  // tab again for a while (or wants it on a second deck too), then loads the tab again.
  const site = await openSite('opaque');
  await waitFor(() => site.tab.evaluate(() => { const m = window.__media(); return !m.paused && m.t > 3; }), 20000);
  const d1 = await loadTab(site.tabId);
  assert.equal(d1.kind, 'resident', JSON.stringify(d1.load));
  await deckWhere((x) => x.id === d1.id && x.tabId === null, 5000);
  assert.equal(await site.tab.evaluate(() => window.__mse.ms.readyState), 'ended', 'the drive had the player buffer all of it');
  await site.tab.evaluate(() => document.querySelector('audio').play());
  const t1 = (await player(site.tab)).t;
  await waitFor(async () => (await player(site.tab)).t > t1 + 2, 8000);
  const d2 = await loadTab(site.tabId);
  assert.equal(d2.kind, 'resident', JSON.stringify(d2.load));
  assert.ok(Math.abs(d2.duration - OPUS_END) < 0.015, `duration ${d2.duration}`);
  await assertBytesTrue(d2.id);
  assert.match(d2.load.report, /drive \(seek-hop after a flush\): ok/);
  await assertReleased(d2, site);
});

test('a YouTube-like page its player already played to the end, its stream ended, plays live and says to reload the tab', async () => {
  // The player ended its own stream: a flush would reopen it, so it is left alone (only a stream a drive ended is flushed).
  const site = await openSite('opaque');
  await playing(site.tab);
  await site.tab.evaluate(() => { document.querySelector('audio').playbackRate = 8; });
  await waitFor(() => site.tab.evaluate(() => document.querySelector('audio').ended), 60000);
  assert.equal(await site.tab.evaluate(() => window.__mse.ms.readyState), 'ended');
  const d = await loadTab(site.tabId);
  assert.match(d.load.report, /note: the player was not flushed: it had loaded the whole track and ended its stream/);
  assert.deepEqual(await engine(`const has = e.__pcm.has(${d.id}); e.__loaders.delete(${d.id}); return has;`), false, 'never promoted');
  await assertLive(d, site, /reload the tab, then load it again/);
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

/**
 * Record the live deck d's whole track; a recording refused because the capture ran at a changing speed (a busy
 * computer) is tried again, as its message says, up to three times. -> {loading, r (the resident deck), took (s)}.
 */
async function recordWholeTrack(t, d) {
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    assert.deepEqual(await act(deck, d.id, 'recordWhole'), { ok: true, error: undefined });
    const loading = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 5000);
    assert.match(loading.title, /recorded from the page — reduced highs/);
    await deckWhere((x) => x.id === loading.id && /recording/.test(x.load.strategy || ''), 5000);
    const r = await deckWhere((x) => x.id === loading.id && (x.kind === 'resident' || x.load.state === 'error'), 40000);
    if (r.kind === 'resident') return { loading, r, took: (Date.now() - t0) / 1000 };
    // Refused, saying why and keeping its report; never a deck at the wrong speed.
    assert.equal(r.load.error, 'The recording was disturbed (the computer was busy); try again.', JSON.stringify(r.load));
    assert.match(r.load.report, /Result: failed: the recording was disturbed \(the computer was busy\); try again\n[^]*Beat: not steady/);
    t.diagnostic(`attempt ${attempt} refused: ${r.load.report.split('\n').filter((l) => /^(Beat|Mended)/.test(l)).join('; ')}`);
    assert.ok(attempt < 3, 'refused three times');
    assert.equal((await act(deck, r.id, 'loadCancel')).ok, true);
    await waitFor(async () => !(await decks()).some((x) => x.id === r.id), 8000);
  }
}

/** How a promoted deck's kept track lines up with the source at `url` over its first 4 s: {lag (s), corr}, where it matches best within 30 ms. */
const againstSource = (deckId, url) => engine(`
  const pcm = e.__pcm.get(${deckId});
  const ref = await e.ctx.decodeAudioData(await (await fetch('${url}')).arrayBuffer());
  const a = pcm.L, b = ref.getChannelData(0), sr = pcm.sampleRate, n = Math.round(4 * sr), W = Math.round(0.03 * sr);
  let best = { lag: 0, corr: -1 };
  for (let lag = -W; lag <= W; lag += 2) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = W; i < n; i++) { const x = a[i + lag], y = b[i]; ab += x * y; aa += x * x; bb += y * y; }
    const corr = ab / Math.sqrt(aa * bb);
    if (corr > best.corr) best = { lag: lag / sr, corr };
  }
  e.__pcm.delete(${deckId});
  return best;`);

test('recording a whole track from a media page: its player run at 2× from the start, the capture slowed back, a resident deck labelled as such', async (t) => {
  const { site, d } = await liveDeck(`${rec.origin}/rec`);
  await playing(site.tab);
  const D = (await site.tab.evaluate(() => window.__media())).duration;
  assert.ok(D > 15.9 && D < 16.2, `the player says ${D} s`);
  const seen = (await events(deck)).length;
  const { loading, r, took } = await recordWholeTrack(t, d);
  assert.ok(took > 7.5 && took < 25, `recorded in ${took.toFixed(1)} s (half the track's length, plus setting up)`);
  assert.ok(Math.abs(r.duration - Math.min(D, 16.1)) < 0.1, `deck ${r.duration} s, the track ${D} s`);
  assert.match(r.title, /recorded from the page — reduced highs/);
  const said = r.load.report.match(/Result: resident, (\d+\.\d{3}) s, recorded from the page at 2×/);
  assert.ok(said && Math.abs(+said[1] - r.duration) < 0.01, r.load.report);
  assert.equal(r.tabId, null, 'the recording holds no tab');
  const kicks = await kicksOf(loading.id);
  t.diagnostic(`beat to beat (ms): ${kicks.slice(1).map((x, i) => Math.round((x - kicks[i]) * 1000)).join(' ')}; ${r.load.report.split('\n').filter((l) => /^Mended/.test(l)).join('') || 'nothing mended'}`);
  assert.ok(Math.abs(r.bpm.native - 124) < 0.5, `bpm ${r.bpm.native}`);
  // Slowed back to the track's own pitch: lined up with the source (to within a few ms), the audio matches it.
  const c = await againstSource(loading.id, `${rec.origin}/rec.mp3`);
  t.diagnostic(`deck ${r.duration.toFixed(3)} s of a ${D.toFixed(3)} s track in ${took.toFixed(1)} s; against the source: ${JSON.stringify(c)}; ${r.load.report.split('\n').find((l) => /^Recorded/.test(l))}`);
  assert.ok(c.corr > 0.8, JSON.stringify(c));
  // The live deck it came from is gone, and with it the tab's capture: the page is paused, at its own rate, and the
  // tab is let go as a resident deck lets go of its tab: never left muted.
  await waitFor(async () => !(await decks()).some((x) => x.id === d.id), 8000);
  await waitFor(() => site.tab.evaluate(() => window.__media().paused), 3000);
  const m = await site.tab.evaluate(() => window.__media());
  assert.deepEqual([m.paused, m.rate, m.pp], [true, 1, true]);
  const muted = await h.sw.evaluate((id) => chrome.tabs.get(id).then((x) => x.mutedInfo), site.tabId);
  assert.equal(muted.muted, false, `the tab was left muted: ${JSON.stringify(muted)}`);
  assert.deepEqual((await events(deck)).slice(seen).filter((e) => /so it was muted/.test(e.text)), []);
  assert.equal((await act(deck, r.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).length, 8000);
  await site.tab.close();
});

test('recording a whole track keeps its leading silence and ends at its own end: nothing the page plays after it comes onto the deck', async (t) => {
  const { site, d } = await liveDeck(`${rec.origin}/lead`);
  await playing(site.tab);
  const D = (await site.tab.evaluate(() => window.__media())).duration, want = LEAD.lead + LEAD.beats * (60 / LEAD.bpm) + LEAD.tail;
  assert.ok(Math.abs(D - want) < 0.05, `the player says ${D} s`);
  const { loading, r } = await recordWholeTrack(t, d);
  assert.ok(Math.abs(r.duration - D) < 0.1, `deck ${r.duration} s, the track ${D} s`);
  const said = /from the player's time 0 \(its first sound (\d+\.\d{3}) s in\)/.exec(r.load.report);
  t.diagnostic(`${r.load.report.split('\n').find((l) => /^Recorded/.test(l))}`);
  assert.ok(said && Math.abs(+said[1] - LEAD.lead) < 0.06, r.load.report);
  // The deck's first kick is where the track's is, and its last 0.6 s are the track's own silence, not the tone.
  const ends = await engine(`const pcm = e.__pcm.get(${loading.id}), L = pcm.L, sr = pcm.sampleRate;
    let first = -1, peak = 0;
    for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 0.1) { first = i / sr; break; }
    for (let i = L.length - Math.round(0.6 * sr); i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]));
    return { first, peak };`);
  t.diagnostic(JSON.stringify(ends));
  assert.ok(Math.abs(ends.first - LEAD.lead) < 0.06, `the first kick at ${ends.first} s, the track's at ${LEAD.lead} s`);
  assert.ok(ends.peak < 0.01, `the deck ends with ${ends.peak.toFixed(3)} peak, the tone the page played after the track`);
  assert.equal((await act(deck, r.id, 'eject')).ok, true);
  await waitFor(async () => !(await decks()).length, 8000);
  await site.tab.close();
});

test('recording a whole track whose own tempo moves (rising through it, or stepping from 124 to 126 BPM) keeps a clean recording: its beat moves with the track, and the capture kept the player\'s pace', async (t) => {
  for (const name of ['ramp', 'step']) {
    const { site, d } = await liveDeck(`${rec.origin}/${name}`);
    await playing(site.tab);
    const { r } = await recordWholeTrack(t, d);
    t.diagnostic(`${name}: ${r.load.report.split('\n').filter((l) => /^(Result|Mended|Beat|Pace)/.test(l)).join(' | ')}`);
    assert.equal(r.kind, 'resident', r.load.report);
    assert.match(r.load.report, /^Beat: moving: the beat about a bar up to \d+\.\d ms of the track's \(the track's own tempo: the capture kept the player's pace\)$/m, name);
    assert.match(r.load.report, /^Pace: by the player's clock, the recording kept its pace within \d+\.\d ms$/m, name);
    assert.equal((await act(deck, r.id, 'eject')).ok, true);
    await waitFor(async () => !(await decks()).length, 8000);
    await site.tab.close();
  }
});

/** Settings → Record whole track at 2× when bytes are unavailable, on or off (and waited for). */
async function recordWholeSetting(on) {
  set(deck, null, 'resident.recordWhole', on);
  await waitFor(async () => (await state(deck)).master.params['resident.recordWhole'] === on);
}

test('with "Record whole track at 2× when bytes are unavailable" on, a protected page that plays live is recorded at 2× without asking', async () => {
  await recordWholeSetting(true);
  const site = await openSite('drm');
  await playing(site.tab);
  const d = await loadTab(site.tabId);
  assert.equal(d.kind, 'live', JSON.stringify(d.load));
  const recording = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 10000);
  assert.match(recording.title, /recorded from the page — reduced highs/);
  await deckWhere((x) => x.id === recording.id && /recording from the page at 2×/.test(x.load.strategy || ''), 15000);
  const said = (await events(deck)).slice(d.seen).map((e) => e.text);
  assert.equal(said.filter((t) => t === `Deck ${d.slot}: recording its whole track from the page at 2× (reduced highs), as the settings ask.`).length, 1, JSON.stringify(said));
  // The 2-minute track would take a minute at 2×: that it started is what is checked here.
  assert.equal((await act(deck, recording.id, 'loadCancel')).ok, true);
  await recordWholeSetting(false);
});

test('with that setting on, a page that cannot be sped up plays live and says why it was not recorded; with it off, nothing is recorded', async () => {
  await recordWholeSetting(true);
  let site = await openSite('webaudio');
  await waitFor(() => site.tab.evaluate(() => window.__ctx?.state === 'running' && window.__ctx.currentTime > 0.3), 15000);
  let d = await loadTab(site.tabId);
  assert.equal(d.kind, 'live');
  await waitFor(async () => (await events(deck)).slice(d.seen).some((e) => e.text === `Deck ${d.slot}: its whole track is not recorded at 2×. This page can't be sped up, so it would record in real time.`), 5000);
  assert.equal((await decks()).length, 1, 'no deck was started for it');
  await assertLive(d, site, /without a media player/);
  await recordWholeSetting(false);
  site = await openSite('drm');
  await playing(site.tab);
  d = await loadTab(site.tabId);
  await sleep(1500);
  assert.deepEqual((await decks()).map((x) => x.id), [d.id], 'the setting is off: nothing is recorded');
  await assertLive(d, site, /protected/);
});

/** Kick onsets (s) in a promoted deck's kept track: its envelope (2 ms) rising through 35 % of its loudest. */
const kicksOf = (deckId) => engine(`const pcm = e.__pcm.get(${deckId}), L = pcm.L, sr = pcm.sampleRate, hop = Math.round(sr * 0.002), env = [];
  for (let i = 0; i + hop <= L.length; i += hop) { let m = 0; for (let j = 0; j < hop; j++) m = Math.max(m, Math.abs(L[i + j])); env.push(m); }
  const max = Math.max(...env), on = [];
  for (let i = 1; i < env.length; i++) if (env[i] >= 0.35 * max && env[i - 1] < 0.35 * max && (!on.length || (i * hop) / sr - on[on.length - 1] > 0.15)) on.push((i * hop) / sr);
  return on;`);

/**
 * In the engine (offscreen page): every jds-recorder made from now on records the track at `url` as a 2× player puts it
 * out, captured perfectly, from the moment the real capture first sounds after the page was held silent (before that,
 * the real capture passes through). So no busy computer's own skips get into it, and what is done to it is all that is
 * done to it, at fixed places in the track (s of it, from its first sound), however long the page took to start: at
 * `ins` 10 ms of the capture's silence is put in, and at `lose` 10 ms of it is lost, as a busy computer's tab capture
 * skips: the recorder's batches keep their length, so all the audio after a skip comes late (or early). From `leak` on,
 * 1 ms is lost every 2048 frames as an engine too busy to keep up loses it (a capture whose speed changes): the audio
 * jumps on by it, and the batches come that much short, the capture falling behind the player's clock. With `late`
 * (s of the track) the capture comes that much later than the player's clock puts it, as a busy computer's can: as
 * much silence before the track's first sound. undo() puts AudioWorkletNode back.
 */
async function idealCapture(url, { ins = -1, lose = -1, leak = -1, late = 0 } = {}) {
  const ctx = globalThis.__jdsEngine.ctx, sr = ctx.sampleRate;
  const src = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const off = new OfflineAudioContext(2, Math.ceil(src.length / 2) + 256, sr), node = off.createBufferSource();
  node.buffer = src; node.playbackRate.value = 2; node.connect(off.destination); node.start();
  const two = await off.startRendering(), A = two.getChannelData(0), B = two.getChannelData(1);
  let s0 = 0;
  while (s0 < A.length && Math.abs(A[s0]) <= 0.003 && Math.abs(B[s0]) <= 0.003) s0++; // the track's first sound in it
  const BUF = Math.round(0.01 * sr), LEAK = Math.round(0.001 * sr), at = (t) => (t < 0 ? Infinity : Math.round((t / 2) * sr));
  const INS = at(ins), LOSE = at(lose), LEAKS = at(leak), LATE = Math.round((late / 2) * sr), i16 = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  // Where frame r (from the first sound) of the edited capture is read from in the perfect one, or -1 for silence put in.
  const from = (r) => {
    if (r < LATE) return -1;
    r -= LATE;
    if (r >= INS && r < INS + BUF) return -1;
    return r + s0 - (r >= INS ? BUF : 0) + (r >= LOSE ? BUF : 0) + (r >= LEAKS ? LEAK * (1 + Math.floor((r - LEAKS) / 2048)) : 0);
  };
  const edit = () => {
    let pos = 0, quiet = 0, anchor = -1, q = 0, owed = 0; // q: frames given from the anchor; owed: frames the engine lost, not given
    return (m) => {
      if (!m || m.t !== 'data') return m;
      const n = m.frames, real = m.buf, out = new Int16Array(2 * n);
      let w = 0;
      for (let i = 0; i < n; i++) {
        if (anchor < 0) {
          const loud = Math.abs(real[2 * i]) > 98 || Math.abs(real[2 * i + 1]) > 98; // above -50 dBFS
          if (loud && quiet >= 0.3 * sr) anchor = pos + i; else quiet = loud ? 0 : quiet + 1;
          if (anchor < 0) { out[2 * w] = real[2 * i]; out[2 * w + 1] = real[2 * i + 1]; w++; continue; }
        }
        if (owed > 0) { owed--; continue; }
        if (q >= LEAKS && (q - LEAKS) % 2048 === 0) owed += LEAK;
        const k = from(q++);
        if (k >= 0 && k < A.length) { out[2 * w] = i16(A[k]); out[2 * w + 1] = i16(B[k]); }
        w++;
      }
      pos += n;
      return { ...m, frames: w, buf: out.slice(0, 2 * w) };
    };
  };
  const W = globalThis.AudioWorkletNode, onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  globalThis.AudioWorkletNode = class extends W {
    constructor(c, name, opts) {
      super(c, name, opts);
      if (name !== 'jds-recorder') return;
      const port = this.port, ed = edit();
      let fn = null;
      Object.defineProperty(port, 'onmessage', { configurable: true, get: () => fn, set: (f) => { fn = f; onmessage.set.call(port, f ? (ev) => f({ data: ed(ev.data) }) : null); } });
    }
  };
  window.__undoSkips = () => { globalThis.AudioWorkletNode = W; };
}

test('recording a whole track through a capture that skips (a busy computer loses or repeats 10 ms now and then): every beat in its place', async (t) => {
  await engine(`await (${idealCapture})('${rec.origin}/rec.mp3', { ins: 3.4, lose: 10.7 }); return true;`); // each inside a kick, as the tests of mendSteps have them
  try {
    const { site, d } = await liveDeck(`${rec.origin}/rec`);
    await playing(site.tab);
    assert.deepEqual(await act(deck, d.id, 'recordWhole'), { ok: true, error: undefined });
    const loading = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 5000);
    const r = await deckWhere((x) => x.id === loading.id && x.kind === 'resident', 40000);
    const kicks = await kicksOf(loading.id), iv = kicks.slice(1).map((x, i) => (x - kicks[i]) * 1000);
    t.diagnostic(`beat to beat (ms): ${iv.map(Math.round).join(' ')}; bpm ${r.bpm.native}; ${r.load.report.split('\n').filter((l) => /^Mended/.test(l)).join('') || 'nothing mended'}`);
    assert.ok(kicks.length >= 32, `${kicks.length} kicks`);
    // Every beat on one straight line: a skip left in moves all the beats after it 20 ms, a mend in the wrong place
    // moves them too. The first beat starts the recording, so the line starts at the second.
    const on = kicks.slice(1), k = on.map((x) => Math.round((x - on[0]) / (60 / 124))), n = on.length;
    const mk = k.reduce((a, b) => a + b) / n, mt = on.reduce((a, b) => a + b) / n;
    const P = k.reduce((a, x, i) => a + (x - mk) * (on[i] - mt), 0) / k.reduce((a, x) => a + (x - mk) ** 2, 0);
    const off = on.map((x, i) => (x - mt - (k[i] - mk) * P) * 1000);
    assert.ok(off.every((x) => Math.abs(x) <= 6), `beats off the line (ms): ${off.map((x) => x.toFixed(1)).join(' ')}`);
    assert.ok(Math.abs(r.bpm.native - 124) < 0.1, `bpm ${r.bpm.native}`);
    // The two skips are mended, and nothing else is touched (the capture has no skips of its own).
    assert.match(r.load.report, /^Mended: 2 skips in the capture \(the computer was busy\): 20 ms put in at \d+\.\d s, 20 ms lost at \d+\.\d s$/m);
    assert.match(r.load.report, /^Beat: steady all through: /m);
  } finally { await engine('window.__undoSkips && window.__undoSkips(); return true;'); }
});

test('recording a whole track through a capture that skips in its first beats and its last (10 ms of silence put in 0.6 s in, 10 ms lost 1 s before the end): both mended, every beat on the line', async (t) => {
  // In kick 1, and between kicks 30 and 31: steps the bars alone never mend (1.2 s in they mend silence put in, and a
  // loss once the take starts even 10 ms before the first sound).
  await engine(`await (${idealCapture})('${rec.origin}/rec.mp3', { ins: 0.6, lose: 14.97 }); return true;`);
  try {
    const { site, d } = await liveDeck(`${rec.origin}/rec`);
    await playing(site.tab);
    assert.deepEqual(await act(deck, d.id, 'recordWhole'), { ok: true, error: undefined });
    const loading = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 5000);
    const r = await deckWhere((x) => x.id === loading.id && x.kind === 'resident', 40000);
    const kicks = await kicksOf(loading.id), iv = kicks.slice(1).map((x, i) => (x - kicks[i]) * 1000);
    t.diagnostic(`beat to beat (ms): ${iv.map(Math.round).join(' ')}; bpm ${r.bpm.native}; ${r.load.report.split('\n').filter((l) => /^(Mended|Skips)/.test(l)).join(' | ')}`);
    assert.ok(kicks.length >= 32, `${kicks.length} kicks`);
    // Every beat on one straight line, the first two and the last two with them (the line starts at the second, as above).
    const on = kicks.slice(1), k = on.map((x) => Math.round((x - on[0]) / (60 / 124))), n = on.length;
    const mk = k.reduce((a, b) => a + b) / n, mt = on.reduce((a, b) => a + b) / n;
    const P = k.reduce((a, x, i) => a + (x - mk) * (on[i] - mt), 0) / k.reduce((a, x) => a + (x - mk) ** 2, 0);
    const off = on.map((x, i) => (x - mt - (k[i] - mk) * P) * 1000);
    assert.ok(off.every((x) => Math.abs(x) <= 6), `beats off the line (ms): ${off.map((x) => x.toFixed(1)).join(' ')}`);
    // Both mended where they were (s of the take, which may start a little before the first sound, by the player's
    // clock): the silence put in is cut where it fell, and the 20 ms lost is given back between kicks 30 and 31.
    const lead = +/its first sound (\d+\.\d{3}) s in/.exec(r.load.report)[1];
    const m = /^Mended: 2 skips in the capture \(the computer was busy\): 20 ms put in at (\d+\.\d) s, 20 ms lost at (\d+\.\d) s$/m.exec(r.load.report);
    assert.ok(m && Math.abs(+m[1] - lead - 0.6) <= 0.1 && Math.abs(+m[2] - lead - 14.85) <= 0.2, r.load.report);
    const seen = /^Skips: looked for between its first beat \((\d+\.\d) s in\) and its last \((\d+\.\d) s in\); one before the first or after the last cannot be seen$/m.exec(r.load.report);
    assert.ok(seen && Math.abs(+seen[1] - lead) <= 0.1 && Math.abs(+seen[2] - lead - 32 * (60 / 124)) <= 0.1, r.load.report);
    assert.match(r.load.report, /^Beat: steady all through: /m);
  } finally { await engine('window.__undoSkips && window.__undoSkips(); return true;'); }
});

test('recording a whole track through a capture that comes later than the player\'s clock puts it (0.08 s of the track, as on a busy computer): the deck still starts at the track\'s first sound, on the source', async (t) => {
  await engine(`await (${idealCapture})('${rec.origin}/rec.mp3', { late: 0.08 }); return true;`);
  try {
    const { site, d } = await liveDeck(`${rec.origin}/rec`);
    await playing(site.tab);
    assert.deepEqual(await act(deck, d.id, 'recordWhole'), { ok: true, error: undefined });
    const loading = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 5000);
    const r = await deckWhere((x) => x.id === loading.id && x.kind === 'resident', 40000);
    const c = await againstSource(loading.id, `${rec.origin}/rec.mp3`);
    t.diagnostic(`against the source: ${JSON.stringify(c)}; ${r.load.report.split('\n').find((l) => /^Recorded/.test(l))}`);
    // The track opens with sound: a silence before it this short is the capture's delay, not the track's.
    assert.match(r.load.report, /from the player's time 0 \(its first sound 0\.000 s in\)$/m);
    assert.ok(c.corr > 0.8, JSON.stringify(c));
    assert.equal((await act(deck, r.id, 'eject')).ok, true);
    await waitFor(async () => !(await decks()).some((x) => x.id === r.id), 8000);
    await site.tab.close();
  } finally { await engine('window.__undoSkips && window.__undoSkips(); return true;'); }
});

/**
 * How a promoted deck's kept track lines up with the source at `url` (decoded here, at the engine's rate): the lag of
 * the deck against it in 50 ms windows every 250 ms, both low-passed at 8 kHz (the recording lost its highs), as
 * [s, ms, correlation]. The lag is followed from window to window, and looked for over ±40 ms where it is lost.
 */
const lagsOf = (deckId, url) => engine(`
  const pcm = e.__pcm.get(${deckId}), ref = await e.ctx.decodeAudioData(await (await fetch('${url}')).arrayBuffer()), sr = pcm.sampleRate;
  const lp = (x) => { const y = new Float32Array(x.length), k = Math.exp(-2 * Math.PI * 8000 / sr); let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) { s1 = (1 - k) * x[i] + k * s1; s2 = (1 - k) * s1 + k * s2; y[i] = s2; } return y; };
  const a = lp(pcm.L), b = lp(ref.getChannelData(0)), W = Math.round(0.05 * sr), out = [];
  const corr = (l, s) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < W; i++) { const x = a[s + l + i], y = b[s + i]; ab += x * y; aa += x * x; bb += y * y; } return ab / Math.sqrt(aa * bb + 1e-20); };
  const search = (s, from, to, step) => { let best = { l: 0, c: -2 }; for (let l = from; l <= to; l += step) { if (s + l < 0 || s + l + W > a.length) continue; const c = corr(l, s); if (c > best.c) best = { l, c }; } return best; };
  let cur = 0;
  for (let s = Math.round(0.3 * sr); s + W + Math.round(0.05 * sr) < Math.min(a.length, b.length); s += Math.round(0.25 * sr)) {
    let best = search(s, cur - Math.round(0.003 * sr), cur + Math.round(0.003 * sr), 1);
    if (best.c < 0.9) { const wide = search(s, -Math.round(0.04 * sr), Math.round(0.04 * sr), 3); if (wide.c > best.c) best = search(s, wide.l - 3, wide.l + 3, 1); }
    out.push([+(s / sr).toFixed(2), +((best.l / sr) * 1000).toFixed(1), +best.c.toFixed(3)]);
    if (best.c > 0.9) cur = best.l;
  }
  e.__pcm.delete(${deckId});
  return out;`);

test('recording a whole track of a loop with a continuous bed through a capture that skips: each skip mended, nothing else touched, the deck on the track', async (t) => {
  await engine(`await (${idealCapture})('${rec.origin}/techno.wav', { ins: 3.4, lose: 10.7 }); return true;`);
  try {
    const { site, d } = await liveDeck(`${rec.origin}/techno`);
    await playing(site.tab);
    assert.deepEqual(await act(deck, d.id, 'recordWhole'), { ok: true, error: undefined });
    const loading = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 5000);
    const r = await deckWhere((x) => x.id === loading.id && x.kind === 'resident', 40000);
    const mended = r.load.report.split('\n').find((l) => /^Mended/.test(l)) || 'nothing mended', lags = await lagsOf(loading.id, `${rec.origin}/techno.wav`);
    t.diagnostic(`bpm ${r.bpm.native}; ${mended}; ${r.load.report.split('\n').find((l) => /^Recorded/.test(l))}`);
    t.diagnostic(`[s, lag ms, corr]: ${JSON.stringify(lags)}`);
    // Both skips played in are mended, and nothing else (the capture has no skips of its own: a clean beat is never cut).
    assert.match(mended, /^Mended: 2 skips in the capture \(the computer was busy\): 20 ms put in at \d+\.\d s, 20 ms lost at \d+\.\d s$/);
    // The deck's audio is the track's, in place: the lag in nine windows out of ten within 3 ms of where it starts
    // (the stretch between a loss and the silence given back is up to two beats off).
    const good = lags.filter(([, , c]) => c >= 0.8), at = median(good.slice(0, 8).map(([, l]) => l)), off = good.filter(([, l]) => Math.abs(l - at) > 3);
    assert.ok(good.length >= 0.9 * lags.length, `${lags.length - good.length} of ${lags.length} windows don't match the source`);
    assert.ok(off.length <= 0.1 * good.length, `${off.length} windows off the track: ${JSON.stringify(off)}`);
    assert.ok(Math.abs(r.bpm.native - PATTERNS.techno.bpm) < 0.15, `bpm ${r.bpm.native}`);
  } finally { await engine('window.__undoSkips && window.__undoSkips(); return true;'); }
});

test('a recording whose capture ran at a changing speed (losing a little all the time from half way) is refused, saying so once, with its report: never a deck at the wrong speed', async (t) => {
  await engine(`await (${idealCapture})('${rec.origin}/rec.mp3', { leak: 6.5 }); return true;`);
  try {
    const { site, d } = await liveDeck(`${rec.origin}/rec`);
    await playing(site.tab);
    const seen = (await events(deck)).length;
    assert.deepEqual(await act(deck, d.id, 'recordWhole'), { ok: true, error: undefined });
    const loading = await deckWhere((x) => x.id !== d.id && x.kind === 'loading', 5000);
    const r = await deckWhere((x) => x.id === loading.id && (x.load.state === 'error' || x.kind === 'resident'), 40000);
    t.diagnostic(r.load.report.split('\n').filter((l) => /^(Mended|Beat|Pace)/.test(l)).join(' | '));
    assert.equal(r.kind, 'loading', `never resident: ${r.load.report}`);
    assert.equal(r.kind, 'loading', 'never resident');
    assert.equal(r.load.error, 'The recording was disturbed (the computer was busy); try again.');
    assert.match(r.load.report, /^JD Samps load report\n[^]*Result: failed: the recording was disturbed \(the computer was busy\); try again\n/);
    assert.match(r.load.report, /^Beat: not steady: the beat about a bar up to \d+\.\d ms of the track's \(the capture ran at a changing speed\)$/m);
    assert.match(r.load.report, /^Pace: by the player's clock, the recording drifted \d+\.\d ms$/m);
    await sleep(300);
    const said = (await events(deck)).slice(seen).filter((e) => e.level === 'error');
    assert.deepEqual(said.map((e) => e.text), [`Deck ${r.slot}: recording the whole track failed: the recording was disturbed (the computer was busy); try again.`]);
    assert.equal((await decks()).find((x) => x.id === d.id).kind, 'live', 'the live deck stays, to try again');
    assert.equal((await act(deck, r.id, 'loadCancel')).ok, true);
    assert.equal((await act(deck, d.id, 'eject')).ok, true);
    await waitFor(async () => !(await decks()).length, 8000);
    await site.tab.close();
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

// The tab closed once every byte of the track is in: the load is held at a stage until the hub's EJECT for the closed
// tab has been taken, then let go on.
for (const [stage, hold] of [
  ['while it decodes', `const lt = e.loadTab; e.__unhold = () => { e.loadTab = lt; };
    e.loadTab = (d) => { const p = lt.call(e, d), L = d.loader, df = L.d.decodeFile;
      L.d.decodeFile = (...a) => { window.__held = true; return new Promise((r) => { window.__go = r; }).then(() => df(...a)); }; return p; };`],
  ['while the beat is found', `const f = e.analyse; e.__unhold = () => { e.analyse = f; };
    e.analyse = (...a) => { window.__held = true; return new Promise((r) => { window.__go = r; }).then(() => f.apply(e, a)); };`],
]) {
  test(`the tab closed ${stage}, every byte of the track in: the deck goes resident all the same, with no error`, async () => {
    await engine(`window.__held = false; window.__ejects = 0; const oh = e.onHub; e.__onHub = oh;
      e.onHub = async (m) => { const r = await oh.call(e, m); if (m.type === 'EJECT') window.__ejects++; return r; }; ${hold} return true;`);
    try {
      const site = await openSite('progressive');
      await playing(site.tab);
      const seen = (await events(deck)).length;
      const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: site.tabId });
      assert.equal(r.ok, true, JSON.stringify(r));
      await waitFor(() => engine('return window.__held;'), 30000);
      await site.tab.close();
      await waitFor(() => engine('return window.__ejects > 0;'), 5000); // the hub's EJECT for the closed tab is taken
      await engine('window.__go(); return true;');
      assert.equal(await endOf(r.deckId), 'resident');
      const d = await deckWhere((x) => x.id === r.deckId && x.tabId === null, 5000);
      assert.ok(Math.abs(d.duration - 120) < 0.05, `duration ${d.duration}`);
      await sleep(300);
      assert.deepEqual((await events(deck)).slice(seen).filter((e) => e.level === 'error').map((e) => e.text), []);
      assert.equal(await h.sw.evaluate(() => chrome.action.getBadgeText({})), '', 'the hub forgot the tab');
    } finally {
      await engine('e.onHub = e.__onHub; delete e.__onHub; e.__unhold(); delete e.__unhold; return true;');
      await tidy();
    }
  });
}

test('the tab going on to another page while the beat is found, every byte of the track in: the deck goes resident under its own page\'s name', async () => {
  await engine(`window.__held = false; const f = e.analyse; e.__unhold = () => { e.analyse = f; };
    e.analyse = (...a) => { window.__held = true; return new Promise((r) => { window.__go = r; }).then(() => f.apply(e, a)); }; return true;`);
  try {
    const site = await openSite('progressive');
    await playing(site.tab);
    const title = await site.tab.title(), seen = (await events(deck)).length;
    const r = await hubCall(deck, { type: 'LOAD_TAB', tabId: site.tabId });
    assert.equal(r.ok, true, JSON.stringify(r));
    await waitFor(() => engine('return window.__held;'), 30000);
    await site.tab.goto(`${rec.origin}/rec2`);
    // The hub's word of the new page reaches the loading deck before the load goes on.
    await waitFor(() => engine(`const d = e.decks.get(${r.deckId}); return !!d && d.meta.url.startsWith(${JSON.stringify(rec.origin)});`), 10000);
    await engine('window.__go(); return true;');
    assert.equal(await endOf(r.deckId), 'resident');
    const d = await deckWhere((x) => x.id === r.deckId && x.tabId === null, 5000);
    assert.equal(d.title, title, 'named for the page the track came from');
    assert.ok(d.url.startsWith(server.origin), d.url);
    const loaded = (await events(deck)).slice(seen).filter((e) => /^Loaded /.test(e.text)).map((e) => e.text);
    assert.deepEqual(loaded, [`Loaded “${title}” on deck ${d.slot}. It is cued: press PLAY when you're ready.`]);
  } finally {
    await engine('e.__unhold(); delete e.__unhold; return true;');
    await tidy();
  }
});

// ---------------------------------------------------------------- beat-matched decks (R6.2 acceptance)
// Two decks synced and playing, the master recorded and measured with the harness's onset tools: one deck plays a
// low kick, the other a high click, so each is heard in its own band. Every beat of one is within 20 ms of a beat
// of the other and their tempos match within 0.2 %, to the end of the recording (matchFaults).
const SYNC_S = 30;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

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

/** The kick deck against the click deck in a master recording (beatMatch), the detector's own lateness on each taken off. */
const matched = (wav) => beatMatch(wav, onsetBias(124, 'low', 'low') - onsetBias(128, 'high', 'high'));
function assertMatched(t, m, seconds, opts) {
  t.diagnostic(`tempo: kick ${(60 / m.A.T).toFixed(3)} BPM (runs ${m.A.runs.map((r) => r.length)}), click ${(60 / m.B.T).toFixed(3)} BPM (runs ${m.B.runs.map((r) => r.length)}): error ${(m.tempoErr * 100).toFixed(4)} %; median BPM ${m.bpm.map((x) => x.toFixed(2))}`);
  t.diagnostic(`|kick - click| (ms): median ${m.med.toFixed(1)}, p90 ${m.p90.toFixed(1)}, max ${m.max.toFixed(1)}; median in each 5 s: ${m.windows.map((w) => `${w.med.toFixed(1)} (${w.n})`).join(', ')}`);
  assert.deepEqual(matchFaults(m, { seconds, ...opts }), []);
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
  // Both decks resident: each one's beats one steady run, every one within 20 ms of the other's.
  assertMatched(t, matched(await mixRecord(SYNC_S)), SYNC_S, { steady: true });
});

test('a resident deck beat-matched to a live deck holds within 0.2 % and 20 ms for 30 s, measured on the master', async (t) => {
  // The live deck: the 124 BPM kick played by its tab (a WAV with no byte ranges), long enough that it never loops here.
  const long = await startTrackServer({ seconds: 120 });
  try {
    const { d: live } = await liveDeck(long.url('a'));
    const b = await residentTab(CLICK());
    await waitFor(async () => { const x = (await decks()).find((y) => y.id === live.id); return x.bpm.state === 'LOCKED' && Math.abs(x.bpm.native - 124) < 0.1; }, 30000);
    await syncPlay(live, b.d);
    // The live master's own capture can skip (its kicks one steady run no more): the resident deck takes a few beats
    // to follow it, and only those beats may be further off.
    assertMatched(t, matched(await mixRecord(SYNC_S)), SYNC_S, { excuse: 4 });
  } finally { await long.close(); }
});

test('beat-matched resident decks ignore their tabs: pausing, seeking and closing each source tab leaves no glitch (in time or level) and no tempo change on the master', async (t) => {
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
  // No glitch: each deck's beats are one steady run (no jump, no gap, none missing) from the first whole beat to the
  // last, every one within 20 ms of the other's; the level never leaves its beat (no dropout, dip or click between
  // the beats either: the model track's chirp keeps it near -20 dBFS there); and no tempo change: the second half's
  // tempo is the first half's.
  assertMatched(t, m, S, { steady: true });
  assert.deepEqual(levelFaults(wav, m), []);
  const half = (on) => [steadyBeats(on.filter((x) => x < S / 2)).T, steadyBeats(on.filter((x) => x >= S / 2)).T];
  for (const [name, on] of [['kick', m.lo], ['click', m.hi]]) {
    const [t1, t2] = half(on);
    assert.ok(Math.abs(t2 / t1 - 1) < 0.001, `${name}: ${(60 / t1).toFixed(3)} then ${(60 / t2).toFixed(3)} BPM`);
  }
  for (const x of [a.d, b.d]) {
    const y = (await decks()).find((z) => z.id === x.id);
    assert.deepEqual([y.kind, y.playing, y.tabId], ['resident', true, null], `deck ${x.slot}`);
  }
});

test('the deck page showed every load without errors', () => { assert.deepEqual(pageErrors, []); });
