// Harness for driving the real extension in headless Chromium (verified on Chromium 141 /
// Playwright 1.56). See the plan's Task 14 notes for the switches it relies on.
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = /(^|\/)(\.git|tests|docs|node_modules)(\/|$)/;

export function extensionIdForPath(absDir) {
  const hex = crypto.createHash('sha256').update(absDir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function prepareExtension({ src = ROOT, dest } = {}) {
  dest = dest || fs.mkdtempSync(path.join(os.tmpdir(), 'jds-ext-'));
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !SKIP.test(path.relative(src, p)) });
  const abs = fs.realpathSync(dest);
  return { dir: abs, id: extensionIdForPath(abs) };
}

export async function launchExtension({ ext, headless = process.env.HEADLESS !== '0', downloadsDir } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jds-profile-'));
  const ownDownloads = !downloadsDir;
  downloadsDir = downloadsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'jds-dl-'));
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: downloadsDir },
  }));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${ext.dir}`, `--load-extension=${ext.dir}`,
      '--autoplay-policy=no-user-gesture-required', `--allowlisted-extension-id=${ext.id}`, '--remote-debugging-port=0',
    ],
    ignoreDefaultArgs: ['--mute-audio'],
    acceptDownloads: true,
  });
  const ours = (w) => w.url().startsWith(`chrome-extension://${ext.id}/`);
  let sw;
  try {
    sw = context.serviceWorkers().find(ours);
    // On a busy machine the worker can start late: an extension page of its own wakes it, then it is waited for again.
    if (!sw) sw = await context.waitForEvent('serviceworker', { predicate: ours, timeout: 15000 }).catch(() => null);
    if (!sw) sw = context.serviceWorkers().find(ours);
    if (!sw) {
      const page = await context.newPage();
      const woke = context.waitForEvent('serviceworker', { predicate: ours, timeout: 30000 });
      await page.goto(`chrome-extension://${ext.id}/manifest.json`).catch(() => {});
      sw = context.serviceWorkers().find(ours) || (await woke);
      await page.close();
    }
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  } catch (err) {
    // A launch that fails closes its browser, so the test process is not left waiting on it.
    await context.close().catch(() => {});
    for (const d of [userDataDir, ...(ownDownloads ? [downloadsDir] : [])]) fs.rmSync(d, { recursive: true, force: true });
    throw err;
  }
  return {
    context, sw, extId: ext.id, userDataDir, downloadsDir,
    async close() {
      await context.close();
      for (const d of [userDataDir, ext.dir, ...(ownDownloads ? [downloadsDir] : [])]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- test audio
/** 16-bit mono WAV, 48 kHz, an exact whole number of beats so `loop` is seamless.
 *  kind: 'low' = pitched kick (all energy < 200 Hz), 'high' = 3 kHz click, 'mid' = 800 Hz blip. */
export function makeTrackWav({ bpm, seconds = 60, kind = 'low', sr = 48000 }) {
  const beat = 60 / bpm, beats = Math.round(seconds / beat), n = Math.round(beats * beat * sr);
  const buf = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i / sr) % beat;
    let v = 0;
    if (kind === 'low' && t < 0.2) v = 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-t * 35)) * t) * Math.exp(-t * 18);
    else if (kind === 'high' && t < 0.04) v = 0.6 * Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t * 90);
    else if (kind === 'mid' && t < 0.08) v = 0.6 * Math.sin(2 * Math.PI * 800 * t) * Math.exp(-t * 50);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

const TRACKS = { a: { bpm: 124, kind: 'low' }, b: { bpm: 128, kind: 'high' }, c: { bpm: 120, kind: 'mid' } };

/** /a, /b: <audio loop autoplay> pages (124 BPM low kick, 128 BPM high click). `?autoplay=0` on
 *  either serves the same page with the player stopped, for a DJ who forgot to press play.
 *  /c: Web-Audio page (AudioBufferSourceNode) at 120 BPM, plus a muted decorative <audio> that
 *  player assist must not mistake for the source. Tracks are `seconds` long: an <audio> loop
 *  restart leaves a ~0.1 s gap in the captured audio. */
export async function startTrackServer({ seconds = 60 } = {}) {
  const model = modelSites();
  const wavs = Object.fromEntries(Object.entries(TRACKS).map(([k, t]) => [k, makeTrackWav({ ...t, seconds })]));
  const media = (k, autoplay) => `<!doctype html><title>Track ${k.toUpperCase()} ${TRACKS[k].bpm} BPM</title><audio id="a" src="/${k}.wav" loop${autoplay ? ' autoplay' : ''}></audio>
<script>window.__media = () => { const a = document.getElementById('a'); return { t: a.currentTime, rate: a.playbackRate, pp: a.preservesPitch, paused: a.paused }; };</script>`;
  const webaudio = `<!doctype html><title>Track C ${TRACKS.c.bpm} BPM (Web Audio)</title><audio id="decor" src="/c.wav" muted loop autoplay></audio><script>
  (async () => { const ctx = new AudioContext(); const buf = await ctx.decodeAudioData(await (await fetch('/c.wav')).arrayBuffer());
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(ctx.destination); s.start(); window.__ctx = ctx; })();
  </script>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.match(/^\/([abc])\.wav$/);
    if (m) { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wavs[m[1]]); return; }
    if (u.pathname === '/a' || u.pathname === '/b') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(media(u.pathname.slice(1), u.searchParams.get('autoplay') !== '0')); return; }
    if (u.pathname === '/c') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(webaudio); return; }
    if (u.pathname.startsWith('/m/')) { model(req, res, u); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: (name) => `${origin}/${name}`, close: () => new Promise((r) => server.close(r)) };
}

// ---------------------------------------------------------------- model streaming sites
// Pages that behave like the streaming sites the resident-deck loader must handle, built on the
// media in tests/fixtures/sites (made by tests/fixtures/make-site-fixtures.mjs; index.json there
// describes every file). Each page sets window.__model = {name, kind, duration, notes}, logs what
// its player does in window.__page, offers window.__media(), and plays on a click or ?autoplay=1.
// The MSE players choose what to fetch from their SourceBuffer's buffered ranges, as real players do
// (window.__mse holds their MediaSource and SourceBuffer); ?sticky=1 makes one that never fetches a
// segment twice; ?onward=1 one that goes on from the segment it fetched last, as shaka does.
//   /m/progressive  <audio src> MP3 with byte ranges
//   /m/mse          MSE, plain GET segments from an HLS playlist, 20 s ahead
//   /m/opaque       MSE, segments only by POST with a single-use token chain, framed
//   /m/abr          MSE, lo rendition then hi from 12 s (second init segment)
//   /m/ratefight    <audio src> WebM whose page resets playbackRate
//   /m/worker       MSE inside a DedicatedWorker
//   /m/drm          ClearKey-encrypted MSE (real EME)
//   /m/preview      30 s excerpt flagged the way SoundCloud flags previews
//   /m/bandcamp     data-tralbum and an <audio> on the same MP3
//   /m/live         MSE, duration Infinity, segments loop for ever
//   /m/webaudio     a decoded buffer through Web Audio only; bytes come scrambled from a non-media URL
const SITES = path.join(ROOT, 'tests/fixtures/sites');
const OPUS_MP4 = 'audio/mp4; codecs="opus"';
const MEDIA_TYPES = { '.mp3': 'audio/mpeg', '.webm': 'audio/webm', '.mp4': 'audio/mp4', '.m4s': 'audio/mp4' };

// Page-side code: injected into the pages (and the worker) as source text, never called in Node.
function pageMedia() {
  const a = document.querySelector('audio');
  if (!a) return null;
  const buffered = [];
  for (let i = 0; i < a.buffered.length; i++) buffered.push([a.buffered.start(i), a.buffered.end(i)]);
  return { t: a.currentTime, rate: a.playbackRate, pp: a.preservesPitch, paused: a.paused, duration: a.duration, buffered, src: a.currentSrc };
}
/** An HLS media playlist -> {init, segs: [{url, t0, t1}]}. */
async function playlist(url) {
  const base = new URL(url, location.href), text = await (await fetch(base)).text(), segs = [];
  let init = null, dur = 0, t = 0;
  for (const line of text.split('\n')) {
    const map = /^#EXT-X-MAP:URI="([^"]+)"/.exec(line), inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (map) init = new URL(map[1], base).href;
    else if (inf) dur = Number(inf[1]);
    else if (line && line[0] !== '#') { segs.push({ url: new URL(line, base).href, t0: t, t1: t + dur }); t += dur; }
  }
  return { init, segs };
}
async function getBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}
/** Append once the SourceBuffer is free (something else, a page-world flush, may be using it), at `offset` if given. */
async function appendTo(sb, data, offset = null) {
  while (sb.updating) await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
  if (offset != null) sb.timestampOffset = offset;
  return new Promise((resolve, reject) => {
    const ok = () => { sb.removeEventListener('error', bad); resolve(); };
    const bad = () => { sb.removeEventListener('updateend', ok); reject(new Error('appendBuffer failed')); };
    sb.addEventListener('updateend', ok, { once: true });
    sb.addEventListener('error', bad, { once: true });
    sb.appendBuffer(data);
  });
}
/**
 * The tiny player: keeps `ahead` s buffered past now(), one segment at a time. Segment n spans
 * times[n % N], one period later per lap when `loop`. A change of rep appends that rep's init first.
 * The next segment is chosen as hls.js chooses it, from the SourceBuffer's buffered ranges: the one
 * at the end of the range holding the playhead (to within HOLE, and holes under HOLE ignored; TOL for a
 * range that ends a few ms short of its last segment), or the playhead's own when none does. So whatever leaves
 * the buffer (a remove, an eviction) is fetched again. `sticky`: a player that fetches each segment
 * once and never again, whatever its buffer holds. `onward`: one that goes on from the segment it
 * fetched last while it holds less than `ahead` s past the playhead (gaps aside), as shaka does, and looks at its
 * buffer only when it seeks (tick.seeking): a seek outside the span it holds empties its buffer and
 * starts again from there if it holds anything, but with nothing held it goes on from its last segment.
 * Once it has appended after a seek, it jumps the playhead over a gap ahead (shaka's gap jumping).
 */
function pump({ ms, sb, now, times, fetchInit, fetchSeg, repOf = () => '', ahead = 20, loop = false, sticky = false, onward = false, jump, playing, seeking, log, fail }) {
  const N = times.length, period = times[N - 1][1], have = new Set(), HOLE = 0.1, TOL = 0.25;
  let busy = false, cur = null, after = null, clear = false, seeks = 0, appended = false, told = false; // after..told: onward's
  const startOf = (n) => times[n % N][0] + Math.floor(n / N) * period;
  const index = (t) => {
    if (!loop && t >= period) return N;
    const lap = Math.floor(t / period), i = times.findIndex(([, t1]) => t - lap * period < t1);
    return lap * N + (i < 0 ? N - 1 : i);
  };
  const ranges = () => {
    const b = sb.buffered, out = [];
    for (let i = 0; i < b.length; i++) {
      const last = out[out.length - 1];
      if (last && b.start(i) - last[1] < HOLE) last[1] = Math.max(last[1], b.end(i)); else out.push([b.start(i), b.end(i)]);
    }
    return out;
  };
  const next = (t) => {
    if (sticky) { let n = index(t); while (have.has(n)) n++; return n; }
    if (onward) return after == null ? index(t) : after + 1;
    const r = ranges().find(([s, e]) => s <= t + HOLE && e > t - HOLE);
    return r ? index(r[1] + TOL) : index(t);
  };
  const heldPast = (t) => ranges().reduce((n, [s, e]) => n + (e > t ? e - Math.max(s, t) : 0), 0); // gaps not counted, as shaka does
  const full = () => (sticky ? have.size === N : onward ? after === N - 1 : ranges().some(([s, e]) => s <= HOLE && e >= period - TOL));
  const entry = (kind, data, extra) => ({ kind, ...extra, bytes: data.byteLength, view: ArrayBuffer.isView(data), offset: data.byteOffset || 0 });
  async function tick() {
    if (onward && !seeking()) told = false;
    if (onward && playing() && (told || !seeking())) { // not mid-seek before its 'seeking' (shaka's gap jumping, getGapIndex)
      const t = now(), r = ranges(), g = r.findIndex(([s], i) => s > t + 0.01 && (i === 0 || r[i - 1][1] - t <= 0.5));
      if (g > 0 || (g === 0 && appended)) jump(r[g][0]);
    }
    if (busy) return;
    busy = true;
    try {
      for (let last = -1; ;) {
        if (clear) { // onward: emptied on a seek, it starts again where the playhead is
          clear = false; after = null;
          while (sb.updating) await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
          await new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.remove(0, ms.duration); });
        }
        const t = now(), n = next(t), at = seeks;
        if ((!loop && n >= N) || (onward ? heldPast(t) >= ahead : startOf(n) - t >= ahead) || n === last) break; // n === last: it did not stay in the buffer
        last = n;
        have.add(n);
        const rep = repOf(n);
        if (rep !== cur) { const init = await fetchInit(rep); await appendTo(sb, init); log(entry('init', init, { rep })); cur = rep; }
        const data = await fetchSeg(n, rep);
        if (at !== seeks) { last = -1; continue; } // onward: a seek outside what it holds drops the fetch in flight
        await appendTo(sb, data, loop ? Math.floor(n / N) * period : null);
        after = n; appended = true;
        log(entry('media', data, { n, rep }));
      }
      if (!loop && full() && ms.readyState === 'open') ms.endOfStream();
    } catch (e) { fail(e); } finally { busy = false; }
  }
  /** onward, on 'seeking': shaka counts all from its first range's start to its last's end as held. */
  tick.seeking = () => {
    const t = now(), r = ranges();
    appended = false; told = true;
    if (r.length && t >= r[0][0] && t <= r[r.length - 1][1]) return;
    seeks++;
    if (r.length) clear = true;
  };
  return tick;
}
/** A MediaSource on `a` with one SourceBuffer, fed by pump() off the element's clock. */
async function mseOn(a, mime, duration, { prepare, ...opts }) {
  const ms = new MediaSource();
  a.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer(mime);
  window.__mse = { ms, sb };
  ms.duration = duration;
  if (prepare) prepare(ms, sb);
  const onward = qs.get('onward') === '1';
  const tick = pump({ ms, sb, now: () => a.currentTime, sticky: qs.get('sticky') === '1', onward, jump: (t) => { a.currentTime = t; }, playing: () => !a.paused, seeking: () => a.seeking,
    log: (x) => P.appends.push(x), fail: (e) => P.errors.push(String(e)), ...opts });
  if (onward) a.addEventListener('seeking', tick.seeking);
  for (const ev of ['timeupdate', 'seeking']) a.addEventListener(ev, tick);
  setInterval(tick, 250);
  tick();
}
function msePage({ list, mime }) {
  const a = document.getElementById('a'), type = qs.get('listType'); // ?listType=: its playlist served as that Content-Type
  let ready;
  return async () => {
    ready ||= playlist(type ? `${list}?type=${encodeURIComponent(type)}` : list).then(({ init, segs }) => mseOn(a, mime, segs.at(-1).t1, {
      times: segs.map((s) => [s.t0, s.t1]), fetchInit: () => getBytes(init), fetchSeg: (n) => getBytes(segs[n].url),
    }));
    await ready;
    await a.play();
  };
}
function b64url(hex) {
  return btoa(String.fromCharCode(...hex.match(/../g).map((h) => parseInt(h, 16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function drmPage(cfg) {
  const a = document.getElementById('a');
  let keys;
  P.encrypted = [];
  a.addEventListener('encrypted', (e) => {
    const u8 = new Uint8Array(e.initData);
    P.encrypted.push({ initDataType: e.initDataType, bytes: u8.length, system: Array.from(u8.subarray(12, 28), (x) => x.toString(16).padStart(2, '0')).join('') });
    keys ||= navigator.requestMediaKeySystemAccess(cfg.keySystem, [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: cfg.mime }] }])
      .then((access) => access.createMediaKeys()).then((mk) => a.setMediaKeys(mk));
    keys.then(() => {
      const s = a.mediaKeys.createSession();
      const license = { keys: [{ kty: 'oct', kid: b64url(cfg.kid), k: b64url(cfg.key) }], type: 'temporary' };
      s.addEventListener('message', () => s.update(new TextEncoder().encode(JSON.stringify(license))).catch((err) => P.errors.push(String(err))));
      return s.generateRequest(e.initDataType, e.initData);
    }).catch((err) => P.errors.push(String(err)));
  });
  return msePage(cfg);
}
function opaquePage({ token, times, mime }) {
  const a = document.getElementById('a');
  let ready;
  const post = async (seg) => {
    const r = await fetch('/m/seg', { method: 'POST', headers: { 'content-type': 'application/json', 'x-model-token': token }, body: JSON.stringify({ seg }) });
    if (!r.ok) throw new Error(`segment ${seg}: ${r.status}`);
    token = r.headers.get('x-model-next');
    const buf = await r.arrayBuffer();
    return new Uint8Array(buf, 9, new DataView(buf).getUint32(5));
  };
  return async () => {
    ready ||= mseOn(a, mime, times.at(-1)[1], { times, fetchInit: () => post('init'), fetchSeg: (n) => post(n) });
    await ready;
    await a.play();
  };
}
function abrPage({ master, mime, switchAt }) {
  const a = document.getElementById('a');
  let ready;
  const setup = async () => {
    const base = new URL(master, location.href), variants = [];
    let bw = 0;
    for (const line of (await (await fetch(base)).text()).split('\n')) {
      const m = /BANDWIDTH=(\d+)/.exec(line);
      if (m) bw = Number(m[1]);
      else if (line && line[0] !== '#') variants.push({ bw, url: new URL(line, base).href });
    }
    variants.sort((x, y) => x.bw - y.bw);
    const [lo, hi] = await Promise.all([variants[0], variants.at(-1)].map((v) => playlist(v.url)));
    const reps = { lo, hi }, times = lo.segs.map((s) => [s.t0, s.t1]);
    return mseOn(a, mime, times.at(-1)[1], {
      times, repOf: (n) => (times[n][0] < switchAt ? 'lo' : 'hi'),
      fetchInit: (rep) => getBytes(reps[rep].init), fetchSeg: (n, rep) => getBytes(reps[rep].segs[n].url),
    });
  };
  return async () => { ready ||= setup(); await ready; await a.play(); };
}
function livePage({ list, mime }) {
  const a = document.getElementById('a'), join = Number(qs.get('join')) || 0;
  let ready;
  return async () => {
    ready ||= playlist(list).then(({ init, segs }) => mseOn(a, mime, Infinity, {
      times: segs.map((s) => [s.t0, s.t1]), loop: true, fetchInit: () => getBytes(init), fetchSeg: (n) => getBytes(segs[n % segs.length].url),
      prepare: (ms) => { ms.setLiveSeekableRange(0, 1e9); if (join) a.currentTime = join; },
    }));
    await ready;
    await a.play();
  };
}
function workerPage({ script }) {
  const a = document.getElementById('a');
  let ready;
  const setup = () => new Promise((resolve, reject) => {
    if (!MediaSource.canConstructInDedicatedWorker) { reject(new Error('this browser cannot run MSE in a worker')); return; }
    const w = new Worker(script);
    w.onmessage = ({ data }) => {
      if (data.handle) { a.srcObject = data.handle; resolve(); }
      if (data.append) P.appends.push(data.append);
      if (data.error) P.errors.push(data.error);
    };
    const tell = () => w.postMessage({ t: a.currentTime });
    for (const ev of ['timeupdate', 'seeking']) a.addEventListener(ev, tell);
    setInterval(tell, 250);
  });
  return async () => { ready ||= setup(); await ready; await a.play(); };
}
function workerMain({ list, mime }) {
  let now = 0, tick = () => {};
  self.onmessage = ({ data }) => { now = data.t; tick(); };
  (async () => {
    const ms = new MediaSource(), handle = ms.handle;
    self.postMessage({ handle }, [handle]);
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    const { init, segs } = await playlist(list);
    const sb = ms.addSourceBuffer(mime);
    ms.duration = segs.at(-1).t1;
    tick = pump({
      ms, sb, now: () => now, times: segs.map((s) => [s.t0, s.t1]), fetchInit: () => getBytes(init), fetchSeg: (n) => getBytes(segs[n].url),
      log: (append) => self.postMessage({ append }), fail: (e) => self.postMessage({ error: String(e) }),
    });
    tick();
  })().catch((e) => self.postMessage({ error: String(e) }));
}
function elementPage() {
  const a = document.getElementById('a');
  return () => a.play();
}
function ratefightPage() {
  const a = document.getElementById('a');
  P.resets = [];
  a.addEventListener('ratechange', () => {
    if (a.playbackRate === 1) return;
    P.resets.push({ why: 'ratechange', from: a.playbackRate });
    a.playbackRate = 1;
  });
  a.addEventListener('seeking', () => { P.resets.push({ why: 'seeking', from: a.playbackRate }); a.playbackRate = 1; });
  return () => a.play();
}
function webaudioPage({ url, xor }) {
  let ready;
  const setup = async () => {
    const ctx = window.__ctx = new AudioContext();
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= xor;
    const src = ctx.createBufferSource();
    src.buffer = await ctx.decodeAudioData(bytes.buffer);
    src.connect(ctx.destination);
    src.start();
    P.playing = true;
  };
  return async () => { ready ||= setup(); await ready; await window.__ctx.resume(); };
}
const MODEL_LIB = [playlist, getBytes, appendTo, pump, mseOn, msePage, b64url].join('\n');

function modelPage({ name, kind, duration, notes, body = '', main, cfg = {}, lib = false }) {
  return `<!doctype html><meta charset="utf-8"><title>Model site: ${name}</title>
<button id="play">Play</button>
${body}
<script>
window.__model = { name: ${JSON.stringify(name)}, kind: ${JSON.stringify(kind)}, duration: ${duration}, notes: ${JSON.stringify(notes)} };
const P = window.__page = { appends: [], errors: [] }, qs = new URLSearchParams(location.search);
window.__media = ${pageMedia};
${lib ? MODEL_LIB : ''}
const start = (${main})(${JSON.stringify(cfg)});
const go = () => start().catch((e) => P.errors.push(String((e && e.message) || e)));
document.addEventListener('click', go);
if (qs.get('autoplay') === '1') go();
</script>`;
}

/** The /m/* request handler; one per server, holding the opaque page's live tokens. */
function modelSites() {
  let ix = null;
  const index = () => (ix ||= JSON.parse(fs.readFileSync(path.join(SITES, 'index.json'), 'utf8')));
  const tokens = new Set();
  const mint = () => { const t = crypto.randomBytes(12).toString('hex'); tokens.add(t); return t; };
  const XOR = 0x5a;
  const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const opus = (rep) => ({ list: `/m/media/${rep}.m3u8`, mime: OPUS_MP4 });
  const audio = (src) => `<audio id="a"${src ? ` src="${src}"` : ''}></audio>`;
  const BUFFERED = 'It decides what to fetch from its SourceBuffer\'s buffered ranges, as hls.js does, so a range removed from its buffer is fetched again; ?sticky=1 makes it a player that fetches each segment once and never again; ?onward=1 one that goes on from the segment it fetched last and looks at its buffer only when it seeks, as shaka does.';
  const pages = {
    progressive: (S) => ({ kind: 'progressive', duration: S, main: elementPage, body: audio('/m/media/track.mp3'),
      notes: 'A plain <audio src> MP3 served with byte ranges, like a direct file link: the URL can simply be fetched again.' }),
    mse: (S) => ({ kind: 'mse', duration: S, main: msePage, lib: true, cfg: opus('opus-hi'), body: audio(),
      notes: `An MSE player that reads an HLS playlist and GETs each 4 s fMP4 segment, keeping 20 s buffered ahead, like Mixcloud or SoundCloud: every segment URL can be fetched again. ${BUFFERED}` }),
    opaque: (S) => ({ kind: 'mse-opaque', duration: S, main: opaquePage, lib: true, body: audio(),
      cfg: { token: mint(), times: index().reps['opus-hi'].segs.map((s) => [s.t0, s.t1]), mime: OPUS_MP4 },
      notes: `An MSE player whose segments come only from POST /m/seg, framed, each request spending a single-use token the last response handed over, like YouTube SABR: nothing can be fetched again, so driving the player is the only way to the audio. ${BUFFERED}` }),
    abr: (S) => ({ kind: 'mse-abr', duration: S, main: abrPage, lib: true, cfg: { master: '/m/media/opus.m3u8', mime: OPUS_MP4, switchAt: 12 }, body: audio(),
      notes: `An MSE player that starts on the 12 kbps rendition and switches to 24 kbps at 12 s by appending the other init segment, like a DASH or HLS quality switch. ${BUFFERED}` }),
    ratefight: (S) => ({ kind: 'progressive', duration: S, main: ratefightPage, body: audio('/m/media/track.webm'),
      notes: 'An <audio src> WebM whose page puts playbackRate back to 1 on every ratechange and on every seek.' }),
    worker: (S) => ({ kind: 'mse-worker', duration: S, main: workerPage, cfg: { script: '/m/worker.js' }, body: audio(),
      notes: 'An MSE player whose MediaSource lives in a DedicatedWorker and reaches the element as a MediaSourceHandle, so a page-world hook sees no SourceBuffer at all.' }),
    drm: (S) => ({ kind: 'eme', duration: S, main: drmPage, lib: true, body: audio(),
      cfg: { ...opus('opus-cenc'), ...index().reps['opus-cenc'].drm },
      notes: 'An MSE player of ClearKey-encrypted fMP4: a real encrypted event fires, then the page licenses the key and plays. Protected audio must play live, never as noise.' }),
    preview: () => ({ kind: 'progressive', duration: index().files['preview/track.mp3'].seconds, main: elementPage,
      body: `${audio('/m/media/preview/track.mp3')}
<script id="track" type="application/json">${JSON.stringify({ title: 'Model preview', policy: 'SNIP', duration: 30000, full_duration: 120000, snipped: true })}</script>`,
      notes: 'A 30 s excerpt of a 2-minute track, flagged in the page JSON the way SoundCloud flags previews (policy SNIP, snipped). It must be refused, not loaded as the track.' }),
    bandcamp: (S) => ({ kind: 'progressive', duration: S, main: elementPage,
      body: `<script type="text/javascript" data-tralbum="${attr(JSON.stringify({ trackinfo: [{ title: 'Model track', duration: 120, file: { 'mp3-128': '/m/media/track.mp3' } }] }))}"></script>
${audio('/m/media/track.mp3')}`,
      notes: 'A Bandcamp-style page: the data-tralbum JSON names the stream MP3 that its <audio> player plays.' }),
    live: () => ({ kind: 'mse-live', duration: Infinity, main: livePage, lib: true, cfg: { ...opus('opus-lo'), list: '/m/media/opus-lo.m3u8?live=1' }, body: audio(),
      notes: 'An MSE live stream: duration is Infinity and the segments come round for ever (?join=<s> starts part way in). It can never be complete, so it must play live.' }),
    webaudio: (S) => ({ kind: 'webaudio', duration: S, main: webaudioPage, cfg: { url: '/m/data/track', xor: XOR },
      notes: 'Plays a decoded buffer through Web Audio with no media element; the bytes arrive scrambled from a non-media URL, so the only audio to capture is the output.' }),
  };
  const send = (res, type, body, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const m3u8 = (rep, live) => {
    const r = index().reps[rep];
    return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', ...(live ? [] : ['#EXT-X-PLAYLIST-TYPE:VOD']), `#EXT-X-MAP:URI="${r.init.path}"`,
      ...r.segs.flatMap((s) => [`#EXTINF:${(s.t1 - s.t0).toFixed(6)},`, s.path]), ...(live ? [] : ['#EXT-X-ENDLIST']), ''].join('\n');
  };
  const master = () => ['#EXTM3U', '#EXT-X-VERSION:7', ...['opus-lo', 'opus-hi'].flatMap((rep) =>
    [`#EXT-X-STREAM-INF:BANDWIDTH=${index().reps[rep].bitrate},CODECS="opus"`, `${rep}.m3u8`]), ''].join('\n');
  function file(req, res, rel) {
    const p = path.normalize(path.join(SITES, rel));
    if (!p.startsWith(SITES + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    const buf = fs.readFileSync(p), head = { 'content-type': MEDIA_TYPES[path.extname(p)] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!r || (!r[1] && !r[2])) { res.writeHead(200, { ...head, 'content-length': buf.length }); res.end(buf); return; }
    const from = r[1] ? Number(r[1]) : Math.max(0, buf.length - Number(r[2])), to = r[1] && r[2] ? Math.min(Number(r[2]), buf.length - 1) : buf.length - 1;
    if (from > to) { res.writeHead(416, { 'content-range': `bytes */${buf.length}` }); res.end(); return; }
    res.writeHead(206, { ...head, 'content-range': `bytes ${from}-${to}/${buf.length}`, 'content-length': to - from + 1 });
    res.end(buf.subarray(from, to + 1));
  }
  // POST /m/seg {seg: 'init' | n} with x-model-token: answers [0x15, u32 seg+1 (0 = init), u32 length, bytes] and the next token.
  async function opaqueSeg(req, res) {
    const token = req.headers['x-model-token'];
    if (!token || !tokens.delete(token)) { req.resume(); send(res, 'text/plain', 'forbidden', 403); return; }
    let body = '';
    for await (const c of req) body += c;
    const { seg } = JSON.parse(body || '{}'), rep = index().reps['opus-hi'], f = seg === 'init' ? rep.init : rep.segs[seg];
    if (!f) { send(res, 'text/plain', 'no such segment', 404); return; }
    const bytes = fs.readFileSync(path.join(SITES, f.path)), head = Buffer.alloc(9);
    head[0] = 0x15; head.writeUInt32BE(seg === 'init' ? 0 : seg + 1, 1); head.writeUInt32BE(bytes.length, 5);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-model-next': mint() });
    res.end(Buffer.concat([head, bytes]));
  }
  return (req, res, u) => {
    const p = u.pathname, name = p.slice('/m/'.length);
    Promise.resolve().then(() => {
      if (p === '/m/seg' && req.method === 'POST') return opaqueSeg(req, res);
      if (p === '/m/worker.js') return send(res, 'text/javascript', `${MODEL_LIB}\n(${workerMain})(${JSON.stringify(opus('opus-hi'))});\n`);
      if (p === '/m/data/track') return send(res, 'application/octet-stream', fs.readFileSync(path.join(SITES, 'track.webm')).map((b) => b ^ XOR));
      if (p === '/m/media/opus.m3u8') return send(res, 'application/vnd.apple.mpegurl', master());
      const pl = /^\/m\/media\/([\w-]+)\.m3u8$/.exec(p);
      if (pl && index().reps[pl[1]]) return send(res, u.searchParams.get('type') || 'application/vnd.apple.mpegurl', m3u8(pl[1], u.searchParams.get('live') === '1'));
      if (p.startsWith('/m/media/')) return file(req, res, decodeURIComponent(p.slice('/m/media/'.length)));
      if (Object.hasOwn(pages, name)) return send(res, 'text/html; charset=utf-8', modelPage({ name, ...pages[name](index().signal.seconds) }));
      res.writeHead(404); res.end();
    }).catch((e) => { if (!res.headersSent) send(res, 'text/plain', String(e), 500); else res.destroy(); });
  };
}

// ---------------------------------------------------------------- pages + messaging
export async function openExtPage(h, p) {
  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${h.extId}/${p}`);
  return page;
}
export const hubCall = (page, msg) => page.evaluate((m) => chrome.runtime.sendMessage({ target: 'hub', ...m }), msg);
export async function tabIdFor(h, prefix) {
  return h.sw.evaluate((p) => chrome.tabs.query({}).then((ts) => (ts.find((t) => (t.url || '').startsWith(p)) || {}).id), prefix);
}
export async function waitFor(fn, ms = 10000, step = 100) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor timed out after ${ms} ms`);
}

/** Second UI port inside an extension page, for tests to read state and send commands. */
export async function installClient(page) {
  await page.evaluate(() => {
    const c = { last: null, events: [], next: 1, pending: new Map() };
    c.port = chrome.runtime.connect({ name: 'jds-ui' });
    c.port.onMessage.addListener((m) => {
      if (m.t === 'state') c.last = m.s;
      else if (m.t === 'event') c.events.push(m);
      else if (m.t === 'reply') { const r = c.pending.get(m.id); if (r) { c.pending.delete(m.id); r({ ok: m.ok, error: m.error }); } }
    });
    c.port.postMessage({ t: 'hello' });
    window.__c = c;
  });
  await waitFor(() => page.evaluate(() => !!window.__c.last), 10000);
}
export const act = (page, deck, a, arg = {}) => page.evaluate(([d, x, g]) => new Promise((res) => {
  const c = window.__c, id = c.next++;
  c.pending.set(id, res);
  c.port.postMessage({ t: 'act', deck: d, a: x, arg: g, id });
}), [deck, a, arg]);
export const set = (page, deck, key, value) => page.evaluate(([d, k, v]) => window.__c.port.postMessage({ t: 'set', deck: d, key: k, value: v }), [deck, key, value]);
export const state = (page) => page.evaluate(() => window.__c.last);
export const events = (page) => page.evaluate(() => window.__c.events);

// ---------------------------------------------------------------- downloads
export const downloadIds = (h) => h.sw.evaluate(() => chrome.downloads.search({}).then((xs) => xs.map((d) => d.id)));
export async function waitForDownload(h, known, ms = 20000) {
  return waitFor(async () => {
    const items = await h.sw.evaluate((k) => chrome.downloads.search({}).then((xs) => xs.filter((d) => !k.includes(d.id))
      .map((d) => ({ id: d.id, state: d.state, filename: d.filename, error: d.error }))), known);
    const bad = items.find((d) => d.state === 'interrupted');
    if (bad) throw new Error(`download interrupted: ${bad.error}`);
    return items.find((d) => d.state === 'complete') || null;
  }, ms, 200);
}

// ---------------------------------------------------------------- audio analysis
export function parseWav(buf) {
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(off + 10), sr: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('unsupported WAV');
  const frames = Math.floor(data.length / (2 * fmt.ch)), mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2) / 32768; mono[i] = s / fmt.ch; }
  return { sr: fmt.sr, ch: fmt.ch, mono, seconds: frames / fmt.sr, declaredBytes: buf.readUInt32LE(40) };
}

function bandFilter(x, sr, band) {
  const y = new Float32Array(x.length);
  const a = (fc) => Math.exp((-2 * Math.PI * fc) / sr);
  if (band === 'low') {            // 4-pole low-pass at 150 Hz
    const k = a(150); let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < x.length; i++) { s1 = (1 - k) * x[i] + k * s1; s2 = (1 - k) * s1 + k * s2; s3 = (1 - k) * s2 + k * s3; s4 = (1 - k) * s3 + k * s4; y[i] = s4; }
  } else {                         // high: 4-pole high-pass at 1.5 kHz (a 100 Hz kick is ~90 dB down)
    const k = a(1500), s = [0, 0, 0, 0], xp = [0, 0, 0, 0];
    for (let i = 0; i < x.length; i++) {
      let v = x[i];
      for (let j = 0; j < 4; j++) { const o = k * (s[j] + v - xp[j]); xp[j] = v; s[j] = o; v = o; }
      y[i] = v;
    }
  }
  return y;
}

/** RMS in one band, from 10 ms in: a recording starts wherever the music is, and the filter would hear that start as a click. */
export function bandRms(mono, sr, band) {
  const y = bandFilter(mono, sr, band), from = Math.min(y.length, Math.round(0.01 * sr));
  let s = 0; for (let i = from; i < y.length; i++) s += y[i] * y[i];
  return Math.sqrt(s / Math.max(1, y.length - from));
}

/**
 * RMS in one band, from 10 ms in, of the median beat: the take cut into windows of one beat period T (s), each holding
 * the same energy of any sound that repeats every beat. A sound in every beat (a deck's music, or a leak of it) moves
 * them all; a click in one or two (the box's capture dropping a few ms of a kick) moves only those, and not the median.
 */
export function beatBandRms(mono, sr, band, T) {
  const y = bandFilter(mono, sr, band), from = Math.round(0.01 * sr), W = Math.round(T * sr), ms = [];
  for (let i = from; i + W <= y.length; i += W) { let s = 0; for (let j = i; j < i + W; j++) s += y[j] * y[j]; ms.push(s / W); }
  if (!ms.length) return bandRms(mono, sr, band);
  ms.sort((a, b) => a - b);
  const k = ms.length >> 1;
  return Math.sqrt(ms.length & 1 ? ms[k] : (ms[k - 1] + ms[k]) / 2);
}

/** Onset times (s) in one band: 2 ms envelope, rising through 35% of max, 150 ms refractory. */
export function bandOnsets(mono, sr, band) {
  const y = bandFilter(mono, sr, band);
  const hop = Math.round(sr * 0.002), dt = hop / sr, env = []; // 88 samples at 44.1 kHz: dt is not 2 ms
  for (let i = 0; i + hop <= y.length; i += hop) { let m = 0; for (let j = 0; j < hop; j++) m = Math.max(m, Math.abs(y[i + j])); env.push(m); }
  const max = Math.max(...env), thr = max * 0.35, out = [];
  for (let i = 1; i < env.length; i++) if (env[i] >= thr && env[i - 1] < thr && (!out.length || i * dt - out[out.length - 1] > 0.15)) out.push(i * dt);
  return out;
}

export function medianBpm(onsets) {
  const iv = onsets.slice(1).map((t, i) => t - onsets[i]).sort((a, b) => a - b);
  return iv.length ? 60 / iv[Math.floor(iv.length / 2)] : null;
}

/**
 * Steady beats: onsets split into runs of consecutive beats, each interval within `tol` of the
 * median one (a capture dropout or a phase bend ends a run), and one beat period fitted by least
 * squares across every run of at least `minLen` beats, each run with its own phase. The fit uses
 * every onset, so the 2 ms envelope hop averages out. Returns {T, n (onsets fitted), runs: [[t...]]}.
 */
export function steadyBeats(onsets, { tol = 0.008, minLen = 8 } = {}) {
  const Tm = 60 / medianBpm(onsets), runs = [[onsets[0]]];
  for (let i = 1; i < onsets.length; i++) {
    if (Math.abs(onsets[i] - onsets[i - 1] - Tm) <= tol) runs[runs.length - 1].push(onsets[i]); else runs.push([onsets[i]]);
  }
  let sxy = 0, sxx = 0, n = 0;
  for (const r of runs.filter((x) => x.length >= minLen)) {
    const mk = (r.length - 1) / 2, mt = r.reduce((a, t) => a + t, 0) / r.length;
    r.forEach((t, k) => { sxy += (k - mk) * (t - mt); sxx += (k - mk) ** 2; });
    n += r.length;
  }
  return { T: sxy / sxx, n, runs };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** How late bandOnsets() reports a beat of a makeTrackWav sound itself (s): taken off before two decks are compared. */
export function onsetBias(bpm, kind, band) {
  const w = parseWav(makeTrackWav({ bpm, kind, seconds: 8 })), T = 60 / bpm;
  return median(bandOnsets(w.mono, w.sr, band).map((x) => x - Math.round(x / T) * T));
}

/**
 * Two beat-matched decks in a master recording, one heard in each band (a low kick and a high click): each one's
 * onsets, steady tempo (steadyBeats) and median BPM, and each kick's distance (ms) to the nearest click less `bias`
 * (s: the detector's own lateness on the kick less on the click).
 */
export function beatMatch(wav, bias = 0) {
  const lo = bandOnsets(wav.mono, wav.sr, 'low'), hi = bandOnsets(wav.mono, wav.sr, 'high');
  const off = lo.map((x) => ({ t: x, ms: (x - hi.reduce((b, y) => (Math.abs(x - y) < Math.abs(x - b) ? y : b), Infinity) - bias) * 1000 }));
  const abs = off.map((o) => Math.abs(o.ms)).sort((a, b) => a - b), windows = [];
  for (let w = 0; w < wav.seconds - 1; w += 5) { // every 5 s, and what is left at the end
    const to = Math.min(w + 5, wav.seconds), xs = off.filter((o) => o.t >= w && o.t < to).map((o) => Math.abs(o.ms));
    windows.push({ from: w, to, n: xs.length, med: xs.length ? median(xs) : Infinity });
  }
  const A = steadyBeats(lo), B = steadyBeats(hi);
  return { seconds: wav.seconds, lo, hi, off, A, B, tempoErr: A.T / B.T - 1, bpm: [medianBpm(lo), medianBpm(hi)], med: median(abs), p90: abs[Math.floor(abs.length * 0.9)], max: abs.at(-1), windows };
}

/**
 * What a beat match (beatMatch) falls short of, as plain sentences ([] when it holds), over `seconds` at `bpm`: the
 * recording that long, the kicks and clicks there at that tempo, the same tempo within 0.2 %, and every kick within
 * `tol` ms of a click, to the end of the recording (a kick cut by its start or end aside). steady: each deck's beats one steady run (no jump, no gap, none
 * missing). excuse: the beats this many after each break in the master's own steady run (master: 'lo', the kick, or
 * 'hi') may be further off, a tenth of the beats at most: a live master's capture can skip, and the other deck takes
 * a few beats to follow it.
 */
export function matchFaults(m, { seconds, bpm = 124, tol = 20, steady = false, excuse = 0, master = 'lo' } = {}) {
  const out = [], beats = (seconds * bpm) / 60, T = 60 / bpm;
  if (m.seconds < seconds - 0.2) out.push(`${m.seconds.toFixed(3)} s recorded of ${seconds} s`);
  if (!(m.lo.length >= beats - 2 && m.hi.length >= beats - 2)) out.push(`${m.lo.length} kicks, ${m.hi.length} clicks in ${seconds} s`);
  if (!(Math.abs(m.bpm[0] - bpm) < 1 && Math.abs(m.bpm[1] - bpm) < 1)) out.push(`median BPM ${m.bpm}`);
  if (!(Math.abs(m.tempoErr) < 0.002)) out.push(`tempo error ${(m.tempoErr * 100).toFixed(4)} %`);
  const breaks = excuse ? (master === 'lo' ? m.A : m.B).runs.slice(1).map((r) => r[0]) : [];
  const excused = (t) => breaks.some((b) => t >= b - T / 2 && t < b + (excuse - 0.5) * T);
  // A recording starts and stops wherever the music is: a kick cut there is no beat.
  const off = m.off.filter((o) => Math.abs(o.ms) > tol && o.t > 0.15 && o.t < m.seconds - 0.15), own = off.filter((o) => !excused(o.t));
  if (own.length) out.push(`kicks more than ${tol} ms from a click: ${own.map((o) => `${o.t.toFixed(2)} s: ${o.ms.toFixed(1)} ms`).join(', ')}`);
  if (off.length - own.length > 0.1 * beats) out.push(`${off.length - own.length} beats off after the master's own breaks`);
  for (const w of m.windows) {
    const want = ((w.to - w.from) * bpm) / 60 - 2;
    if (!(w.n >= want && w.med <= tol)) out.push(`${w.from}-${w.to.toFixed(1)} s: median ${w.med.toFixed(1)} ms over ${w.n} beats`);
  }
  if (steady) {
    for (const [name, on, fit] of [['kicks', m.lo, m.A], ['clicks', m.hi, m.B]]) {
      const runs = fit.runs.filter((r) => r.length > 1);
      if (!(runs.length === 1 && runs[0].length >= on.length - 2)) out.push(`${name}: steady runs ${fit.runs.map((r) => r.length)}`);
    }
  }
  return out;
}

/**
 * Where a master recording's level leaves its own beat, as plain sentences ([] when it doesn't): its RMS in each
 * 1/48 of a beat of the kicks' steady tempo (beatMatch), over the whole band and above 1.5 kHz, against the same
 * 48th in the 8 beats either side (median), more than `db` below (a dropout, a dip) or above (a click, a jump), all
 * under -60 dBFS (-40 above 1.5 kHz, where a click's tail can sit a few ms on) taken as silence. The first and last
 * `edge` s are left out.
 */
export function levelFaults(wav, m, { db = 10, edge = 0.5 } = {}) {
  const T = m.A.T, B = 48, sr = wav.sr, t0 = median(m.lo.map((t) => t - Math.round((t - m.lo[0]) / T) * T));
  const k0 = Math.ceil((edge - t0) / T), k1 = Math.floor((wav.seconds - edge - t0) / T) - 1, out = [];
  for (const [band, x, floor] of [['', wav.mono, -60], ['above 1.5 kHz ', bandFilter(wav.mono, sr, 'high'), -40]]) {
    const lv = [];
    for (let k = k0; k <= k1; k++) {
      const row = new Float64Array(B);
      for (let j = 0; j < B; j++) {
        const a = Math.round((t0 + (k + j / B) * T) * sr), b = Math.round((t0 + (k + (j + 1) / B) * T) * sr);
        let s = 0;
        for (let i = a; i < b; i++) s += x[i] * x[i];
        row[j] = Math.max(floor, 10 * Math.log10(s / Math.max(1, b - a) + 1e-12)); // silence is silence, however quiet
      }
      lv.push(row);
    }
    const found = [];
    for (let k = 0; k < lv.length; k++) {
      for (let j = 0; j < B; j++) {
        const near = [];
        for (let q = Math.max(0, k - 8); q <= Math.min(lv.length - 1, k + 8); q++) if (q !== k) near.push(lv[q][j]);
        const dev = lv[k][j] - median(near);
        if (Math.abs(dev) <= db) continue;
        const t = t0 + (k0 + k + j / B) * T, last = found[found.length - 1];
        if (last && t - last.to < T / B + 1e-6 && Math.sign(dev) === Math.sign(last.dev)) { last.to = t + T / B; if (Math.abs(dev) > Math.abs(last.dev)) last.dev = dev; } else found.push({ from: t, to: t + T / B, dev });
      }
    }
    for (const f of found) out.push(`${f.from.toFixed(2)} s: ${Math.round((f.to - f.from) * 1000)} ms ${band}${f.dev < 0 ? 'below' : 'above'} its beat by up to ${Math.abs(f.dev).toFixed(0)} dB`);
  }
  return out;
}

/** The RIFF/WAVE header fields, as written, plus the file length. */
export function wavHeader(buf) {
  return {
    riff: buf.toString('ascii', 0, 4), riffSize: buf.readUInt32LE(4), wave: buf.toString('ascii', 8, 12),
    fmt: buf.toString('ascii', 12, 16), fmtSize: buf.readUInt32LE(16), format: buf.readUInt16LE(20), ch: buf.readUInt16LE(22),
    sr: buf.readUInt32LE(24), byteRate: buf.readUInt32LE(28), blockAlign: buf.readUInt16LE(32), bits: buf.readUInt16LE(34),
    data: buf.toString('ascii', 36, 40), dataSize: buf.readUInt32LE(40), fileBytes: buf.length,
  };
}

// ---------------------------------------------------------------- engine internals (CDP)
export async function offscreenEval(h, expression) {
  return withOffscreen(h, async (send) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });
}

/** The offscreen engine's JS heap after a full GC: {usedSize, totalSize, backingStorageSize?} in bytes. */
export function offscreenHeap(h) {
  return withOffscreen(h, async (send) => {
    await send('HeapProfiler.collectGarbage');
    return send('Runtime.getHeapUsage');
  });
}

/** Run fn(send) with a CDP session attached to the offscreen engine document. */
async function withOffscreen(h, fn) {
  const [port, wsPath] = fs.readFileSync(path.join(h.userDataDir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const cb = m.id && pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    const { targetInfos } = await send('Target.getTargets');
    const t = targetInfos.find((x) => x.url === `chrome-extension://${h.extId}/offscreen.html`);
    if (!t) throw new Error('offscreen engine not running');
    const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    return await fn((method, params) => send(method, params, sessionId));
  } finally { ws.close(); }
}
