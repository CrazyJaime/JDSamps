// The page tap: the MAIN-world agent captures the media a page's own player appends, and the
// relay hands it to the engine as blob: URLs (bytes never travel on the agent port). Driven like
// tests/browser/agent.test.mjs: the real agent-main.js and agent-relay.js in a plain page, with a
// fake chrome.runtime standing in for the engine's end of the port. The players are tiny MSE
// players written below; their media is made by ffmpeg at test start and cached by recipe.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';
import { launchPlain } from './playwright.mjs';
import { waitFor } from './ext-harness.mjs';
import { validateAgentMessage } from '../../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = fs.readFileSync(path.join(ROOT, 'agent/agent-main.js'), 'utf8');
const RELAY = fs.readFileSync(path.join(ROOT, 'agent/agent-relay.js'), 'utf8');
const MIME = 'audio/mp4; codecs="opus"';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- fixtures (ffmpeg, cached)
// Opus in fragmented MP4, an init segment plus 4 s media segments: `short` (30 s) and `long`
// (3 min) as a DASH packager writes them; `enc`, a ClearKey-encrypted fragmented MP4 with a pssh
// box (so Chromium fires a real `encrypted` event); `mp3`, a progressive MP3 file; `vid`, 8 s of
// VP9 pictures in WebM.
const RECIPE = { v: 1, seg: 4, short: [30, 330], long: [180, 220], enc: 8, mp3: 30, vid: 8, kid: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', key: '00112233445566778899aabbccddeeff' };

function ffmpeg(...args) { execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); }

/** A ClearKey pssh box (system 1077efec-c0b2-4d02-ace3-3c1e52e2fb4b) appended to the moov. */
function addPssh(buf) {
  const out = [];
  for (let off = 0; off < buf.length;) {
    const size = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    let box = buf.subarray(off, off + size);
    if (type === 'moov') {
      const pssh = Buffer.alloc(52);
      pssh.writeUInt32BE(52, 0); pssh.write('pssh', 4); pssh.writeUInt32BE(0x01000000, 8);
      Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex').copy(pssh, 12);
      pssh.writeUInt32BE(1, 28); Buffer.from(RECIPE.kid, 'hex').copy(pssh, 32);
      box = Buffer.concat([box, pssh]); box.writeUInt32BE(box.length, 0);
    }
    out.push(box); off += size;
  }
  return Buffer.concat(out);
}

function buildFixtures(dir) {
  for (const set of ['short', 'long']) {
    const [seconds, freq] = RECIPE[set], d = path.join(dir, set);
    fs.mkdirSync(d);
    ffmpeg('-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`, '-ac', '2', '-c:a', 'libopus', '-b:a', '96k',
      '-f', 'dash', '-seg_duration', String(RECIPE.seg), '-use_template', '1', '-use_timeline', '0',
      '-init_seg_name', 'init.mp4', '-media_seg_name', 'seg-$Number%05d$.m4s', '-dash_segment_type', 'mp4', path.join(d, 'manifest.mpd'));
  }
  fs.mkdirSync(path.join(dir, 'enc'));
  const raw = path.join(dir, 'enc', 'raw.mp4');
  ffmpeg('-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${RECIPE.enc}`, '-ac', '2', '-c:a', 'libopus', '-b:a', '96k',
    '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', RECIPE.key, '-encryption_kid', RECIPE.kid,
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000', raw);
  fs.writeFileSync(path.join(dir, 'enc', 'enc.mp4'), addPssh(fs.readFileSync(raw)));
  fs.mkdirSync(path.join(dir, 'mp3'));
  ffmpeg('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${RECIPE.mp3}`, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(dir, 'mp3', 'track.mp3'));
  fs.mkdirSync(path.join(dir, 'vid'));
  ffmpeg('-f', 'lavfi', '-i', `testsrc=size=64x48:rate=10:duration=${RECIPE.vid}`, '-c:v', 'libvpx-vp9', '-b:v', '50k', '-deadline', 'realtime', '-cpu-used', '8', path.join(dir, 'vid', 'vid.webm'));
}

function fixtures() {
  const dir = path.join(os.tmpdir(), `jds-tap-fixtures-${sha(JSON.stringify(RECIPE)).slice(0, 16)}`);
  if (!fs.existsSync(path.join(dir, 'ok'))) {
    const tmp = fs.mkdtempSync(`${dir}-`);
    buildFixtures(tmp);
    fs.writeFileSync(path.join(tmp, 'ok'), '');
    try { fs.renameSync(tmp, dir); } catch (_) { fs.rmSync(tmp, { recursive: true, force: true }); } // another run got there first
  }
  const files = {};
  for (const set of fs.readdirSync(dir)) {
    const d = path.join(dir, set);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) files[`/fx/${set}/${f}`] = fs.readFileSync(path.join(d, f));
  }
  const segs = (set) => Object.keys(files).filter((k) => k.startsWith(`/fx/${set}/seg-`)).sort().map((k) => files[k]);
  return { files, short: { init: files['/fx/short/init.mp4'], segs: segs('short') }, long: { init: files['/fx/long/init.mp4'], segs: segs('long') } };
}

// ---------------------------------------------------------------- pages
// A tiny MSE player. ?set=short|long &n=<segments> &dur=<s> &ahead=<s> (0: append everything)
// &manual (wait for __go()) &snap (keep its own copy of appendBuffer, taken before any tap)
// &xhr (load with XMLHttpRequest) &raw (open a SourceBuffer and append nothing: __push does)
// &prog (also a progressive <audio src>) &buf (choose what to fetch from the SourceBuffer's buffered
// ranges, as real players do, not from what it has appended: what is removed is fetched again)
// &video (a second SourceBuffer, of pictures, on the same MediaSource: empty until the test appends to __vsb). Event handlers are on*
// properties, never addEventListener, so the dormancy test can count every listener the agent adds.
const PLAYER = `<!doctype html><title>player</title><body><audio id="a"></audio><script>
(() => {
  const q = new URLSearchParams(location.search);
  const SET = q.get('set') || 'short', N = +q.get('n') || 0, DUR = +q.get('dur') || 0, AHEAD = +q.get('ahead') || 0, SEG = 4;
  const APPEND = SourceBuffer.prototype.appendBuffer;
  const a = document.getElementById('a');
  if (q.has('prog')) document.body.insertAdjacentHTML('beforeend', '<audio id="p" src="/fx/mp3/track.mp3" preload="metadata"></audio>');
  if (q.has('fight')) a.onratechange = () => { window.__rc = (window.__rc || 0) + 1; if (a.playbackRate !== 1) a.playbackRate = 1; };
  const name = (k) => '/fx/' + SET + '/seg-' + String(k).padStart(5, '0') + '.m4s';
  const get = (u) => q.has('xhr')
    ? new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', u); x.responseType = 'arraybuffer'; x.onload = () => res(x.response); x.onerror = rej; x.send(); })
    : fetch(u).then((r) => r.arrayBuffer());
  let ms = null, sb = null, have = new Set(), chain = Promise.resolve();
  const BUF = q.has('buf');
  const push = async (buf) => {
    if (BUF) while (sb.updating) await new Promise((r) => setTimeout(r, 5)); // someone else's remove
    return new Promise((res, rej) => {
      sb.onupdateend = () => res(); sb.onerror = () => rej(new Error('append failed'));
      (q.has('snap') ? APPEND : sb.appendBuffer).call(sb, buf);
    });
  };
  window.__push = (buf) => push(buf);
  window.__fx = { appended: [] };
  // &buf: the segment at the end of the buffered range holding t (within 0.1 s of it; 0.25 s for a range a few ms
  // short of its last segment), else t's own.
  const next = (t) => {
    const b = sb.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.1 && b.end(i) > t - 0.1) return Math.floor((b.end(i) + 0.25) / SEG) + 1;
    return Math.floor(t / SEG) + 1;
  };
  const full = () => { const b = sb.buffered; return b.length === 1 && b.start(0) <= 0.1 && b.end(0) >= Math.min(N * SEG, DUR || 1e9) - 0.3; };
  // One pass at a time, each to the buffering goal; a pass left over from an earlier __go() stops.
  async function pass() {
    const s = sb;
    if (!s) return;
    for (let last = 0; ;) {
      const t = a.currentTime, from = BUF ? next(t) : Math.floor(t / SEG) + 1;
      const to = Math.min(AHEAD ? Math.min(N, Math.ceil((t + AHEAD) / SEG)) : N, Math.ceil((window.__limit || 1e9) / SEG));
      let k = from;
      if (!BUF) while (k <= to && have.has(k)) k++;
      if (k > to || k === last || sb !== s) break;
      have.add(k); last = k;
      const buf = await get(name(k));
      if (sb !== s) return;
      await push(buf);
      window.__fx.appended.push(k);
    }
    if (sb === s && (BUF ? full() : have.size === N) && ms.readyState === 'open' && !sb.updating) ms.endOfStream();
  }
  const pump = () => (chain = chain.then(pass, pass));
  window.__pump = pump; // __limit (s): a player that will not buffer past it
  window.__go = async () => {
    sb = null; ms = new MediaSource(); have = new Set(); window.__fx.appended = [];
    a.src = URL.createObjectURL(ms);
    await new Promise((r) => { ms.onsourceopen = r; });
    sb = ms.addSourceBuffer(q.get('mime') || ${JSON.stringify(MIME)});
    window.__sb = sb; window.__ms = ms;
    if (q.has('video')) window.__vsb = ms.addSourceBuffer('video/webm; codecs="vp9"');
    if (q.has('raw')) { if (DUR) ms.duration = DUR; return; }
    await push(await get('/fx/' + SET + '/init.mp4'));
    if (DUR) ms.duration = DUR;
    a.ontimeupdate = pump; a.onseeking = pump;
    await pump();
    window.__ready = true;
  };
  if (!q.has('manual')) window.__go();
})();
</script>`;

// Encrypted media and EME, for the DRM tests.
const DRM = `<!doctype html><title>drm</title><body><audio id="a"></audio><script>
  const a = document.getElementById('a');
  const CFG = [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: ${JSON.stringify(MIME)} }] }];
  a.onencrypted = (e) => { window.__enc = e.initDataType; };
  window.__playEnc = async () => {
    const ms = new MediaSource(); a.src = URL.createObjectURL(ms);
    await new Promise((r) => { ms.onsourceopen = r; });
    const sb = ms.addSourceBuffer(${JSON.stringify(MIME)});
    sb.appendBuffer(await (await fetch('/fx/enc/enc.mp4')).arrayBuffer());
  };
  window.__ask = () => navigator.requestMediaKeySystemAccess('org.w3.clearkey', CFG).then((x) => x.keySystem);
  window.__keys = async () => { const acc = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', CFG); await a.setMediaKeys(await acc.createMediaKeys()); return !!a.mediaKeys; };
</script>`;

// MSE inside a DedicatedWorker: the element only ever sees a MediaSourceHandle.
const WORKER_JS = 'self.onmessage = () => { const ms = new MediaSource(); const h = ms.handle; self.postMessage({ h }, [h]); };';
const WORKER = `<!doctype html><title>worker</title><body><audio id="a"></audio><script>
  window.__attach = () => new Promise((res) => {
    const w = new Worker('/mse-worker.js');
    w.onmessage = (e) => { document.getElementById('a').srcObject = e.data.h; res(Object.prototype.toString.call(document.getElementById('a').srcObject)); };
    w.postMessage(1);
  });
</script>`;

const BLANK = '<!doctype html><title>blank</title><body><audio id="a"></audio>';

// A Bandcamp-like album page: the player's data is JSON in a data-tralbum attribute.
// ?mode=ok | none (no attribute) | nourl (the track has no stream link).
function TRALBUM(mode) {
  const info = { trackinfo: [{ title: 'Track', duration: 30.04, file: mode === 'nourl' ? null : { 'mp3-128': '/fx/mp3/track.mp3' } }] };
  const attr = JSON.stringify(info).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html><title>album</title><body><audio id="a"></audio>${mode === 'none' ? '' : `<script data-tralbum="${attr}"></script>`}`;
}

// The native fetch as the agent finds it at document_start, counting calls and the most in flight.
function FETCH_SPY() {
  const f = window.fetch, n = { calls: 0, inflight: 0, max: 0 };
  window.__fs = n;
  window.fetch = function fetch(...a) {
    n.calls++; n.inflight++; n.max = Math.max(n.max, n.inflight);
    const p = f.apply(this, a), done = () => { n.inflight--; };
    p.then(done, done);
    return p;
  };
}

// SourceBuffer.remove as the agent finds it at document_start: each call logged with the buffer's type.
function REMOVE_SPY() {
  const types = new WeakMap(), log = window.__removes = [];
  const add = MediaSource.prototype.addSourceBuffer, rm = SourceBuffer.prototype.remove;
  MediaSource.prototype.addSourceBuffer = function addSourceBuffer(type) { const sb = add.call(this, type); types.set(sb, type); return sb; };
  SourceBuffer.prototype.remove = function remove(a, b) { log.push([types.get(this), a, b]); return rm.call(this, a, b); };
}

// ---------------------------------------------------------------- the engine's end of the port
// chrome.runtime for agent-relay.js in a plain page (as in agent.test.mjs). Every message the
// relay posts is kept, with the time, and checked for binary payloads: bytes must never go up.
function FAKE_CHROME() {
  const hub = [];
  const eng = { posted: [], times: [], connects: 0, msg: [], gone: [], binary: 0 };
  const binary = (v, d = 0) => {
    if (v == null || typeof v !== 'object' || d > 8) return false;
    if (ArrayBuffer.isView(v) || /^\[object (Shared)?ArrayBuffer\]$/.test(Object.prototype.toString.call(v)) || v instanceof Blob) return true;
    return Object.values(v).some((x) => binary(x, d + 1));
  };
  const port = {
    postMessage: (m) => { if (binary(m)) eng.binary++; eng.posted.push(m); eng.times.push(performance.now()); }, disconnect() {},
    onMessage: { addListener: (f) => eng.msg.push(f) }, onDisconnect: { addListener: (f) => eng.gone.push(f) },
  };
  eng.send = (m) => eng.msg.forEach((f) => f(m));
  eng.die = () => eng.gone.forEach((f) => f());
  eng.ask = () => hub.forEach((f) => f({ jds: 'connect' }, {}, () => {}));
  window.__eng = eng;
  const runtime = { id: 'ext', connect: () => { eng.connects++; return port; }, onMessage: { addListener: (f) => hub.push(f) }, lastError: undefined };
  Object.defineProperty(window, 'chrome', { value: { runtime }, configurable: true, writable: true });
}

// Spies installed before the agent (so it takes them for the natives): byte copies, Blobs,
// blob: URLs made and revoked, and every listener added outside the agent's own channel.
function SPY() {
  const n = { copies: 0, blobs: 0, created: [], revoked: [], listeners: [] };
  window.__spy = n;
  const TA = Object.getPrototypeOf(Uint8Array.prototype);
  for (const k of ['set', 'slice']) { const f = TA[k]; TA[k] = { [k](...a) { n.copies++; return f.apply(this, a); } }[k]; }
  const abSlice = ArrayBuffer.prototype.slice;
  ArrayBuffer.prototype.slice = { slice(...a) { n.copies++; return abSlice.apply(this, a); } }.slice;
  const RealBlob = Blob;
  window.Blob = class Blob extends RealBlob { constructor(...a) { super(...a); n.blobs++; } };
  const mk = URL.createObjectURL, rv = URL.revokeObjectURL;
  URL.createObjectURL = (o) => { const u = mk(o); if (o instanceof RealBlob) n.created.push(u); return u; };
  URL.revokeObjectURL = (u) => { n.revoked.push(u); return rv(u); };
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = { addEventListener(type, ...a) {
    if (!(this === window && /^(media-channel|[cs][0-9a-f]{32})$/.test(type))) n.listeners.push(`${Object.prototype.toString.call(this).slice(8, -1)}:${type}`);
    return add.call(this, type, ...a);
  } }.addEventListener;
}

// ---------------------------------------------------------------- harness
let fx, server, browser;
const errors = [], hanging = [];

function serve(req, res, buf, type) {
  const h = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (m && req.method === 'GET') {
    const s = +m[1], e = Math.min(buf.length - 1, m[2] ? +m[2] : buf.length - 1);
    res.writeHead(206, { ...h, 'content-range': `bytes ${s}-${e}/${buf.length}`, 'content-length': e - s + 1 });
    res.end(buf.subarray(s, e + 1));
  } else { res.writeHead(200, { ...h, 'content-length': buf.length }); res.end(buf); }
}
const TYPE = { '.mp4': 'audio/mp4', '.m4s': 'audio/mp4', '.mp3': 'audio/mpeg', '.mpd': 'application/dash+xml' };
const html = (s) => (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(s); };

before(async () => {
  fx = fixtures();
  const routes = {
    '/player.html': html(PLAYER), '/drm.html': html(DRM), '/worker.html': html(WORKER), '/blank.html': html(BLANK),
    '/mse-worker.js': (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(WORKER_JS); },
    '/data.json': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); },
    '/tralbum.html': (req, res, u) => html(TRALBUM(u.searchParams.get('mode')))(req, res),
    '/hang': (req, res) => { hanging.push(res); }, // never answers
  };
  for (const [k, buf] of Object.entries(fx.files)) {
    routes[k] = (req, res) => serve(req, res, buf, TYPE[path.extname(k)] || 'application/octet-stream');
    routes[`/slow${k}`] = (req, res) => setTimeout(() => serve(req, res, buf, TYPE[path.extname(k)] || 'application/octet-stream'), 300);
  }
  server = await startStaticServer(ROOT, routes);
  browser = await launchPlain();
});
after(async () => {
  for (const res of hanging) res.destroy();
  await browser?.close();
  await server?.close();
});

/** A page with the real agent and relay at document_start, the relay connected to __eng. */
async function tapPage(query = '', { init = [], page = '/player.html', agent = true } = {}) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  for (const fn of init) await p.addInitScript(fn);
  await p.addInitScript(FAKE_CHROME);
  if (agent) await p.addInitScript(AGENT);
  await p.addInitScript(RELAY);
  await p.goto(`${server.origin}${page}?${query}`);
  const cdp = await p.context().newCDPSession(p);
  // Evaluate through CDP, so nothing of Playwright's own runs in the page (the spies count all).
  p.run = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return p;
}
async function connect(p) {
  await p.run('window.__eng.ask()');
  await waitFor(() => p.run('window.__eng.connects === 1'), 5000);
}
const send = (p, m) => p.run(`window.__eng.send(${JSON.stringify(m)})`);
const posted = (p, t) => p.run(`JSON.stringify(window.__eng.posted)`).then((s) => JSON.parse(s).filter((m) => !t || m.t === t));
const partsOf = async (p) => (await posted(p, 'tap-ready')).flatMap((m) => m.parts);
const lastProgress = async (p) => (await posted(p, 'tap-progress')).at(-1);
const errorsOf = async (p) => posted(p, 'tap-error');
const blobShas = (p, urls) => p.run(`Promise.all(${JSON.stringify(urls)}.map(async (u) => {
  try {
    const b = await (await fetch(u)).arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch (e) { return 'unreadable'; }
}))`);

/** Every tap message that went up is valid as the engine will read it, and none carried bytes. */
async function checkPosted(p) {
  assert.equal(await p.run('window.__eng.binary'), 0, 'the agent port carried binary data');
  for (const m of await posted(p)) {
    if (!/^tap-/.test(m.t)) continue;
    assert.deepEqual(validateAgentMessage(m), m, `the engine would not take ${JSON.stringify(m).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------- R3.1: the tap
describe('the byte tap', { concurrency: 2 }, () => {
  test("tap on: the init and every segment a player appends come back as blob URLs, byte-identical and in order", async () => {
    const p = await tapPage('set=short&n=8&dur=30&manual');
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run('window.__go()');
    await waitFor(async () => (await partsOf(p)).length >= 9, 10000);
    const parts = await partsOf(p);
    assert.equal(parts.length, 9);
    assert.deepEqual(parts.map((x) => x.kind), ['init', ...Array(8).fill('media')]);
    assert.deepEqual(parts.map((x) => x.sb), Array(9).fill(0));
    assert.deepEqual(parts.map((x) => x.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual([...new Set(parts.map((x) => x.mime))], [MIME]);
    assert.deepEqual(await blobShas(p, parts.map((x) => x.blobUrl)), [fx.short.init, ...fx.short.segs].map(sha));
    await waitFor(async () => { const g = await lastProgress(p); return g && g.bytes === [fx.short.init, ...fx.short.segs].reduce((s, b) => s + b.length, 0) && g.duration; }, 5000);
    const g = await lastProgress(p);
    assert.deepEqual(g.mimes, [MIME]);
    assert.ok(Math.abs(g.duration - 30) < 0.1, `duration ${g.duration}`);
    assert.equal(g.buffered.length, 1);
    assert.ok(g.buffered[0][0] < 0.05 && Math.abs(g.buffered[0][1] - 30) < 0.1, JSON.stringify(g.buffered));
    assert.deepEqual(await errorsOf(p), [], 'an ordinary player says nothing wrong');
    await checkPosted(p);
    await p.close();
  });

  test('a page that took its own copy of appendBuffer before the tap was on is still captured', async () => {
    const p = await tapPage('set=short&n=8&dur=30&manual&snap');
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run('window.__go()');
    await waitFor(async () => (await partsOf(p)).length >= 9, 10000);
    const parts = await partsOf(p);
    assert.deepEqual(await blobShas(p, parts.map((x) => x.blobUrl)), [fx.short.init, ...fx.short.segs].map(sha));
    await checkPosted(p);
    await p.close();
  });

  test('a tap turned on late hands over the latest init the player appended, first, then the media from there', async () => {
    const p = await tapPage('set=long&dur=180&manual&raw');
    await connect(p);
    // Dormant: an init, two segments, then a switch to another representation and its init.
    await p.run(`(async () => {
      await window.__go();
      const get = (u) => fetch(u).then((r) => r.arrayBuffer());
      for (const u of ['/fx/short/init.mp4', '/fx/short/seg-00001.m4s', '/fx/short/seg-00002.m4s', '/fx/long/init.mp4']) await window.__push(await get(u));
    })()`);
    assert.deepEqual(await partsOf(p), [], 'nothing handed over while dormant');
    await send(p, { t: 'tap', on: true });
    await p.run("(async () => window.__push(await fetch('/fx/long/seg-00003.m4s').then((r) => r.arrayBuffer())))()");
    await waitFor(async () => (await partsOf(p)).length >= 2, 3000);
    const parts = await partsOf(p);
    assert.deepEqual(parts.map((x) => [x.kind, x.seq, x.sb, x.mime]), [['init', 0, 0, MIME], ['media', 1, 0, MIME]]);
    assert.deepEqual(await blobShas(p, parts.map((x) => x.blobUrl)), [sha(fx.long.init), sha(fx.long.segs[2])]);
    await checkPosted(p);
    await p.close();
  });

  test('an init larger than 256 KB is not kept, and the one before it is dropped too', async () => {
    const p = await tapPage('set=short&dur=30&manual&raw');
    await connect(p);
    await p.run(`(async () => {
      await window.__go();
      const init = new Uint8Array(await fetch('/fx/short/init.mp4').then((r) => r.arrayBuffer()));
      await window.__push(init);
      const N = 300 * 1024, big = new Uint8Array(init.length + N); // the init again, with a 300 KB 'free' box after it
      big.set(init); new DataView(big.buffer).setUint32(init.length, N); big.set([0x66, 0x72, 0x65, 0x65], init.length + 4);
      await window.__push(big);
    })()`);
    await send(p, { t: 'tap', on: true });
    await p.run("(async () => window.__push(await fetch('/fx/short/seg-00001.m4s').then((r) => r.arrayBuffer())))()");
    await waitFor(async () => (await partsOf(p)).length >= 1, 3000);
    await p.waitForTimeout(200);
    assert.deepEqual((await partsOf(p)).map((x) => [x.kind, x.seq]), [['media', 0]], 'no init handed over');
    await checkPosted(p);
    await p.close();
  });

  test('cross-realm buffers from an about:blank iframe are captured (brand checks, not instanceof)', async () => {
    const p = await tapPage('set=short&dur=30&manual&raw');
    await connect(p);
    await send(p, { t: 'tap', on: true });
    const r = await p.run(`(async () => {
      await window.__go();
      const ifr = document.createElement('iframe'); document.body.append(ifr);
      const W = ifr.contentWindow;
      const init = await W.fetch('/fx/short/init.mp4').then((x) => x.arrayBuffer());
      const seg = await W.fetch('/fx/short/seg-00001.m4s').then((x) => x.arrayBuffer());
      const view = new W.Uint8Array(seg);
      const foreign = !(init instanceof ArrayBuffer) && !(view instanceof Uint8Array);
      await window.__push(init);
      await window.__push(view);
      return foreign;
    })()`);
    assert.equal(r, true, 'the buffers really are from the other realm');
    await waitFor(async () => (await partsOf(p)).length >= 2, 5000);
    const parts = await partsOf(p);
    assert.deepEqual(parts.map((x) => x.kind), ['init', 'media']);
    assert.deepEqual(await blobShas(p, parts.map((x) => x.blobUrl)), [fx.short.init, fx.short.segs[0]].map(sha));
    await checkPosted(p);
    await p.close();
  });

  // The one thing a dormant tap keeps: each SourceBuffer's latest init segment (one copy per init
  // appended, held in the agent's closure), never a media segment.
  test('dormant until the first tap on: only the init is kept; no media copied, no Blob or blob URL, no listener, no global', async () => {
    const control = await tapPage('set=short&n=8&dur=30&manual', { init: [SPY], agent: false });
    const p = await tapPage('set=short&n=8&dur=30&manual', { init: [SPY] });
    const snap = (q) => q.run('JSON.stringify({ copies: __spy.copies, blobs: __spy.blobs, created: __spy.created.length, listeners: __spy.listeners.slice() })').then(JSON.parse);
    const playThrough = (q) => q.run(`(async () => {
      await window.__go();
      await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/fx/short/seg-00002.m4s'); x.onloadend = res; x.send(); });
      await fetch('/fx/short/seg-00003.m4s').then((r) => r.arrayBuffer());
      return window.__fx.appended.length;
    })()`);
    // 1. A page nobody has decked plays its whole track.
    const s0 = await snap(p);
    assert.equal(await playThrough(p), 8);
    const s1 = await snap(p);
    assert.deepEqual([s1.copies - s0.copies, s1.blobs - s0.blobs, s1.created - s0.created], [1, 0, 0], 'one copy (the init), no Blob, no blob URL');
    assert.deepEqual(s1.listeners.slice(s0.listeners.length), [], 'no listener added');
    // 2. A deck talks to the tab (query, isolate) but has not asked for the tap: the agent's
    // usual media listeners and nothing of the tap's.
    await connect(p);
    await send(p, { t: 'isolate', on: true });
    assert.equal(await playThrough(p), 8);
    const s2 = await snap(p);
    assert.deepEqual([s2.copies - s1.copies, s2.blobs - s1.blobs, s2.created - s1.created], [1, 0, 0]);
    const usual = ['ratechange', 'play', 'playing', 'pause', 'emptied', 'loadedmetadata', 'volumechange', 'timeupdate'].map((t) => `HTMLAudioElement:${t}`);
    const added = s2.listeners.slice(s1.listeners.length);
    assert.ok(added.length > 0 && added.every((l) => usual.includes(l)), `only the usual media listeners: ${added}`);
    // No global, on the window or on the prototypes, whatever state the tap is in.
    await control.run('window.__go()');
    const names = (q) => q.run(`JSON.stringify({
      win: Object.getOwnPropertyNames(window).filter((k) => !k.startsWith('__')).sort(), syms: Object.getOwnPropertySymbols(window).length,
      protos: [HTMLMediaElement, SourceBuffer, MediaSource, XMLHttpRequest, Navigator, Function, URL, Blob].map((C) => Object.getOwnPropertyNames(C.prototype).sort()),
    })`).then(JSON.parse);
    const want = await names(control);
    assert.deepEqual(await names(p), want, 'dormant: no new globals');
    // 3. Tap on: the kept init of the SourceBuffer still playing goes first (the one from step 1
    // belongs to a MediaSource the page has since replaced), then the positive control: the same
    // spies see the tap copy, mint and listen.
    await send(p, { t: 'tap', on: true });
    await waitFor(async () => (await partsOf(p)).length >= 1, 3000);
    const kept = await partsOf(p);
    assert.deepEqual(kept.map((x) => [x.kind, x.seq, x.mime]), [['init', 0, MIME]]);
    assert.deepEqual(await blobShas(p, [kept[0].blobUrl]), [sha(fx.short.init)]);
    assert.equal(await playThrough(p), 8);
    await waitFor(async () => (await partsOf(p)).length >= 10, 10000);
    const s3 = await snap(p);
    assert.ok(s3.copies > s2.copies && s3.created - s2.created >= 10, `the spies see the tap work: ${JSON.stringify([s3.copies - s2.copies, s3.created - s2.created])}`);
    const tapAdded = s3.listeners.slice(s2.listeners.length);
    for (const l of ['SourceBuffer:updateend', 'HTMLAudioElement:encrypted', 'XMLHttpRequest:loadend']) assert.ok(tapAdded.includes(l), `${l} in ${tapAdded}`);
    assert.deepEqual(await names(p), want, 'tapping: no new globals');
    await checkPosted(p);
    await control.close(); await p.close();
  });

  test('tap-progress goes up at most four times a second, and no part is ever coalesced away', async () => {
    const p = await tapPage('set=short&dur=30&manual&raw');
    await connect(p);
    await send(p, { t: 'tap', on: true });
    // A streaming player: each segment appended in 16 pieces as it "arrives", for about 2 s.
    const pushes = await p.run(`(async () => {
      await window.__go();
      const get = (u) => fetch(u).then((r) => r.arrayBuffer());
      await window.__push(await get('/fx/short/init.mp4'));
      let n = 1;
      for (let k = 1; k <= 8; k++) {
        const b = new Uint8Array(await get('/fx/short/seg-' + String(k).padStart(5, '0') + '.m4s')), step = Math.ceil(b.length / 16);
        for (let o = 0; o < b.length; o += step) { await window.__push(b.subarray(o, o + step)); n++; await new Promise((r) => setTimeout(r, 15)); }
      }
      return n;
    })()`);
    assert.ok(pushes > 100, `${pushes} appends`);
    await waitFor(async () => (await partsOf(p)).length >= pushes, 5000);
    await p.waitForTimeout(600);
    const parts = await partsOf(p);
    assert.equal(parts.length, pushes, 'one part per append');
    assert.deepEqual(parts.map((x) => x.seq), parts.map((_, i) => i));
    const shas = await p.run(`(async () => {
      const urls = ${JSON.stringify(parts.map((x) => x.blobUrl))};
      const bufs = await Promise.all(urls.map((u) => fetch(u).then((r) => r.arrayBuffer())));
      const join = (bs) => { const o = new Uint8Array(bs.reduce((s, b) => s + b.byteLength, 0)); let k = 0; for (const b of bs) { o.set(new Uint8Array(b), k); k += b.byteLength; } return o; };
      const hex = async (u8) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map((x) => x.toString(16).padStart(2, '0')).join('');
      return [await hex(join(bufs.slice(0, 1))), await hex(join(bufs.slice(1)))];
    })()`);
    assert.deepEqual(shas, [sha(fx.short.init), sha(Buffer.concat(fx.short.segs))], 'the pieces join back into the exact bytes');
    const times = await p.run(`JSON.stringify(window.__eng.times.filter((_, i) => window.__eng.posted[i].t === 'tap-progress'))`).then(JSON.parse);
    assert.ok(times.length >= 4, `progress was reported (${times.length})`);
    for (let i = 0; i < times.length; i++) {
      const inSecond = times.filter((t) => t >= times[i] && t < times[i] + 1000).length;
      assert.ok(inSecond <= 4, `${inSecond} tap-progress messages within 1 s of ${times[i].toFixed(0)} ms`);
    }
    await checkPosted(p);
    await p.close();
  });

  test('past 600 MB the tap stops: one tap-error "too large", its copies dropped, nothing more captured', async () => {
    const p = await tapPage('set=short&dur=30&manual&raw');
    await connect(p);
    await send(p, { t: 'tap', on: true });
    // 8 MiB top-level 'free' boxes: valid to append, so every append succeeds and is captured.
    const n = await p.run(`(async () => {
      await window.__go();
      await window.__push(await fetch('/fx/short/init.mp4').then((r) => r.arrayBuffer()));
      const N = 8 * 1024 * 1024, free = new Uint8Array(N);
      new DataView(free.buffer).setUint32(0, N); free.set([0x66, 0x72, 0x65, 0x65], 4);
      for (let i = 0; i < 80; i++) await window.__push(free);
      return 80;
    })()`);
    assert.equal(n, 80);
    await waitFor(async () => (await errorsOf(p)).length > 0, 5000);
    await p.waitForTimeout(300);
    assert.deepEqual(await errorsOf(p), [{ t: 'tap-error', reason: 'none', detail: 'too large' }]);
    const parts = await partsOf(p);
    const bytes = fx.short.init.length + (parts.length - 1) * 8 * 1024 * 1024;
    assert.ok(parts.length < 80 && bytes <= 600 * 1024 * 1024, `${parts.length} parts handed over (${(bytes / 2 ** 20).toFixed(0)} MiB)`);
    await p.run(`(async () => { for (let i = 0; i < 3; i++) await window.__push(await fetch('/fx/short/seg-0000' + (i + 1) + '.m4s').then((r) => r.arrayBuffer())); })()`);
    await p.waitForTimeout(300);
    assert.equal((await partsOf(p)).length, parts.length, 'nothing captured after the limit');
    await send(p, { t: 'tap', on: false, forget: true });
    await checkPosted(p);
    await p.close();
  });

  test("tap off drops what it has not handed over; handed-over URLs stay readable until the engine says forget", async () => {
    const p = await tapPage('set=short&n=8&dur=30&manual', { init: [SPY] });
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run('window.__go()');
    await waitFor(async () => (await partsOf(p)).length >= 9, 10000);
    const first = await partsOf(p);
    // An append and the tap going off in the same task: the copy never becomes a part.
    await p.run(`(async () => {
      const b = await fetch('/fx/short/seg-00001.m4s').then((r) => r.arrayBuffer());
      window.__sb.appendBuffer(b);
      window.__eng.send({ t: 'tap', on: false });
      await new Promise((r) => { window.__sb.onupdateend = r; });
    })()`);
    await p.waitForTimeout(300);
    assert.equal((await partsOf(p)).length, 9, 'nothing handed over after tap off');
    const spy = await p.run('JSON.stringify(__spy)').then(JSON.parse);
    const handed = new Set(first.map((x) => x.blobUrl));
    assert.deepEqual(spy.created.filter((u) => !handed.has(u) && !spy.revoked.includes(u)), [], 'every URL not handed over is revoked');
    assert.deepEqual(await blobShas(p, first.map((x) => x.blobUrl)), [fx.short.init, ...fx.short.segs].map(sha), 'handed-over URLs still readable');
    // Not tapping: appends are not copied.
    const c0 = spy.copies;
    await p.run(`(async () => { const b = await fetch('/fx/short/seg-00002.m4s').then((r) => r.arrayBuffer()); window.__sb.appendBuffer(b); await new Promise((r) => { window.__sb.onupdateend = r; }); })()`);
    assert.equal(await p.run('__spy.copies'), c0, 'no copies once the tap is off');
    await send(p, { t: 'tap', on: false, forget: true });
    assert.deepEqual(await blobShas(p, first.map((x) => x.blobUrl)), Array(9).fill('unreadable'), 'forget revokes the handed-over URLs');
    await checkPosted(p);
    await p.close();
  });

  test('when the engine port drops, the relay turns the tap off and forgets its blob URLs', async () => {
    const p = await tapPage('set=short&n=8&dur=30&manual');
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run('window.__go()');
    await waitFor(async () => (await partsOf(p)).length >= 9, 10000);
    const parts = await partsOf(p);
    await p.run('window.__eng.die()');
    assert.deepEqual(await blobShas(p, parts.map((x) => x.blobUrl)), Array(9).fill('unreadable'));
    await p.close();
  });
});

describe('the URL and element layers', { concurrency: 2 }, () => {
  test('fetch and XHR media requests show up in tap-urls with method, Range and size; other requests do not; history is marked past', async () => {
    const p = await tapPage('set=short&manual&prog');
    await connect(p);
    // Before the tap: the page's resource history, which the tap reads when it comes on.
    await p.run("Promise.all([fetch('/fx/short/seg-00007.m4s').then((r) => r.arrayBuffer()), fetch('/data.json').then((r) => r.json())])");
    await send(p, { t: 'tap', on: true });
    await p.run(`(async () => {
      await fetch('/fx/short/seg-00002.m4s', { headers: { Range: 'bytes=0-999' } }).then((r) => r.arrayBuffer());
      await fetch(new Request('/fx/short/seg-00003.m4s', { headers: { Range: 'bytes=100-199' } })).then((r) => r.arrayBuffer());
      await fetch('/fx/short/seg-00005.m4s', { method: 'POST' }).then((r) => r.arrayBuffer());
      await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/fx/short/seg-00004.m4s'); x.setRequestHeader('Range', 'bytes=0-1'); x.responseType = 'arraybuffer'; x.onloadend = res; x.send(); });
      await fetch('/fx/short/manifest.mpd').then((r) => r.text());
      await fetch('/data.json').then((r) => r.json());
    })()`);
    const o = server.origin;
    await waitFor(async () => (await posted(p, 'tap-urls')).flatMap((m) => m.reqs).length >= 7, 5000);
    await p.waitForTimeout(300);
    const reqs = (await posted(p, 'tap-urls')).flatMap((m) => m.reqs);
    const by = Object.fromEntries(reqs.map((r) => [r.url.replace(o, '') + (r.past ? ' (past)' : ''), r]));
    const size = (k) => fx.files[k].length;
    assert.deepEqual(by, {
      '/fx/short/seg-00007.m4s (past)': { url: `${o}/fx/short/seg-00007.m4s`, method: 'GET', range: null, size: size('/fx/short/seg-00007.m4s'), media: true, past: true },
      '/fx/mp3/track.mp3 (past)': { url: `${o}/fx/mp3/track.mp3`, method: 'GET', range: null, size: null, media: true, past: true },
      '/fx/short/seg-00002.m4s': { url: `${o}/fx/short/seg-00002.m4s`, method: 'GET', range: 'bytes=0-999', size: 1000, media: true },
      '/fx/short/seg-00003.m4s': { url: `${o}/fx/short/seg-00003.m4s`, method: 'GET', range: 'bytes=100-199', size: 100, media: true },
      '/fx/short/seg-00005.m4s': { url: `${o}/fx/short/seg-00005.m4s`, method: 'POST', range: null, size: size('/fx/short/seg-00005.m4s'), media: true },
      '/fx/short/seg-00004.m4s': { url: `${o}/fx/short/seg-00004.m4s`, method: 'GET', range: 'bytes=0-1', size: 2, media: true },
      '/fx/short/manifest.mpd': { url: `${o}/fx/short/manifest.mpd`, method: 'GET', range: null, size: size('/fx/short/manifest.mpd'), media: false },
    });
    assert.equal(reqs.length, 7, 'each request once');
    await checkPosted(p);
    await p.close();
  });

  test('DRM: a real encrypted event reports tap-error drm once, and the page still gets its event', async () => {
    const p = await tapPage('', { page: '/drm.html' });
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run('window.__playEnc()');
    await waitFor(async () => (await errorsOf(p)).length > 0, 5000);
    await p.waitForTimeout(200);
    assert.deepEqual((await errorsOf(p)).map((m) => m.reason), ['drm']);
    assert.equal(await p.run('window.__enc'), 'cenc', "the page's own handler saw the event");
    await checkPosted(p);
    await p.close();
  });

  test('DRM: keys set before the tap, or a key-system request while tapping, report drm; EME answers as it always does', async () => {
    const control = await tapPage('', { page: '/drm.html', agent: false });
    const want = await control.run('window.__ask()');
    assert.equal(want, 'org.w3.clearkey');
    await control.close();
    // Keys already on the element when the tap comes on.
    const p = await tapPage('', { page: '/drm.html' });
    await connect(p);
    assert.equal(await p.run('window.__keys()'), true);
    assert.deepEqual(await errorsOf(p), [], 'nothing said while dormant');
    await send(p, { t: 'tap', on: true });
    await waitFor(async () => (await errorsOf(p)).length > 0, 3000);
    assert.deepEqual((await errorsOf(p)).map((m) => m.reason), ['drm']);
    await p.close();
    // A request for a key system while tapping.
    const q = await tapPage('', { page: '/drm.html' });
    await connect(q);
    await send(q, { t: 'tap', on: true });
    assert.equal(await q.run('window.__ask()'), want, 'the page gets exactly what it would have');
    await waitFor(async () => (await errorsOf(q)).length > 0, 3000);
    assert.deepEqual((await errorsOf(q)).map((m) => m.reason), ['drm']);
    await checkPosted(q);
    await q.close();
  });

  test('a player that keeps reporting no end is a live stream: tap-error live, once, after a few seconds', async () => {
    const p = await tapPage('set=short&manual&raw');
    await connect(p);
    await send(p, { t: 'tap', on: true });
    // No duration ever set: after its init segment an MSE element reports Infinity.
    await p.run(`(async () => {
      await window.__go();
      await window.__push(await fetch('/fx/short/init.mp4').then((r) => r.arrayBuffer()));
      for (let k = 1; k <= 8; k++) { await window.__push(await fetch('/fx/short/seg-0000' + k + '.m4s').then((r) => r.arrayBuffer())); await new Promise((r) => setTimeout(r, 550)); }
    })()`);
    assert.equal(await p.run('String(document.getElementById("a").duration)'), 'Infinity');
    await waitFor(async () => (await errorsOf(p)).length > 0, 3000);
    assert.deepEqual((await errorsOf(p)).map((m) => m.reason), ['live']);
    await checkPosted(p);
    await p.close();
  });

  test('MSE in a worker: a MediaSourceHandle on srcObject reports tap-error worker, before or after the tap comes on', async () => {
    const p = await tapPage('', { page: '/worker.html' });
    await connect(p);
    assert.equal(await p.run('window.__attach()'), '[object MediaSourceHandle]');
    await send(p, { t: 'tap', on: true });
    await waitFor(async () => (await errorsOf(p)).length > 0, 3000);
    assert.deepEqual((await errorsOf(p)).map((m) => m.reason), ['worker']);
    await p.close();
    const q = await tapPage('', { page: '/worker.html' });
    await connect(q);
    await send(q, { t: 'tap', on: true });
    await q.run('window.__attach()');
    await waitFor(async () => (await errorsOf(q)).length > 0, 3000);
    assert.deepEqual((await errorsOf(q)).map((m) => m.reason), ['worker']);
    await checkPosted(q);
    await q.close();
  });

  test("only a heard player's source is reported; one holding 30 s on a page whose JSON flags a snippet reports tap-error preview", async () => {
    const p = await tapPage('', { page: '/blank.html' });
    await connect(p);
    await p.run(`(() => { const a = document.getElementById('a'); a.muted = true; a.src = '/fx/mp3/track.mp3'; return new Promise((r) => { a.onloadedmetadata = r; }); })()`);
    await send(p, { t: 'tap', on: true });
    await waitFor(async () => !!(await lastProgress(p)), 5000);
    await p.waitForTimeout(400);
    assert.deepEqual((await posted(p, 'tap-urls')).flatMap((m) => m.reqs).map((r) => r.url), [], 'a muted player is not the track');
    assert.deepEqual(await errorsOf(p), [], 'no snippet flag on the page yet');
    await send(p, { t: 'tap', on: false, forget: true });
    await p.run(`(() => { const s = document.createElement('script'); s.type = 'application/json';
      s.textContent = JSON.stringify({ title: 'x', policy: 'SNIP', snipped: true }); document.body.append(s); document.getElementById('a').muted = false; })()`);
    await send(p, { t: 'tap', on: true });
    await waitFor(async () => (await errorsOf(p)).some((e) => e.reason === 'preview'), 5000);
    assert.ok((await posted(p, 'tap-urls')).flatMap((m) => m.reqs).some((r) => r.url === `${server.origin}/fx/mp3/track.mp3` && r.past), 'heard: its source is reported');
    await checkPosted(p);
    await p.close();
  });

  test('tap-progress names the web source the player plays (src), and none for a Media Source player', async () => {
    const p = await tapPage('', { page: '/blank.html' });
    await connect(p);
    await p.run(`(() => { const a = document.getElementById('a'); a.src = '/fx/mp3/track.mp3'; return new Promise((r) => { a.onloadedmetadata = r; }); })()`);
    await send(p, { t: 'tap', on: true });
    await waitFor(async () => !!(await lastProgress(p)), 5000);
    assert.equal((await lastProgress(p)).src, `${server.origin}/fx/mp3/track.mp3`);
    await checkPosted(p);
    await p.close();
    const m = await tapPage('set=short&n=4&dur=16&manual');
    await connect(m);
    await send(m, { t: 'tap', on: true });
    await m.run('window.__go()');
    await waitFor(async () => { const x = await lastProgress(m); return !!x && x.mimes.length > 0; }, 10000);
    assert.equal((await lastProgress(m)).src, undefined, 'a blob: source is no link to fetch');
    await checkPosted(m);
    await m.close();
  });
});

// ---------------------------------------------------------------- disguise
// Everything a page can ask of a function, for every function the agent replaces.
function LOOK() {
  const d = (o, k) => Object.getOwnPropertyDescriptor(o, k);
  const fns = {
    play: HTMLMediaElement.prototype.play, pause: HTMLMediaElement.prototype.pause, load: HTMLMediaElement.prototype.load,
    'set src': d(HTMLMediaElement.prototype, 'src').set, 'set srcObject': d(HTMLMediaElement.prototype, 'srcObject').set,
    'get currentTime': d(HTMLMediaElement.prototype, 'currentTime').get, 'get paused': d(HTMLMediaElement.prototype, 'paused').get,
    appendBuffer: SourceBuffer.prototype.appendBuffer, addSourceBuffer: MediaSource.prototype.addSourceBuffer,
    fetch: window.fetch, open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send, setRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
    requestMediaKeySystemAccess: Navigator.prototype.requestMediaKeySystemAccess, toString: Function.prototype.toString, createObjectURL: URL.createObjectURL,
  };
  const look = (fn) => [
    Function.prototype.toString.call(fn), String(fn), fn.toString.toString(), fn.name, fn.length, Object.getOwnPropertyNames(fn),
    Object.getOwnPropertySymbols(fn).length, 'prototype' in fn, Object.getPrototypeOf(fn) === Function.prototype,
    (() => { try { new fn(); return 'constructed'; } catch (e) { return e.constructor.name; } })(),
  ];
  const attrs = (x) => x && [typeof x.value, typeof x.get, typeof x.set, x.writable, x.enumerable, x.configurable];
  return JSON.stringify({
    fns: Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, look(f)])),
    descs: [d(window, 'fetch'), d(Function.prototype, 'toString'), d(SourceBuffer.prototype, 'appendBuffer'), d(MediaSource.prototype, 'addSourceBuffer'),
      d(XMLHttpRequest.prototype, 'send'), d(Navigator.prototype, 'requestMediaKeySystemAccess'), d(HTMLMediaElement.prototype, 'srcObject'), d(URL, 'createObjectURL')].map(attrs),
  });
}

test('every wrapper the agent installs looks exactly like the native it replaces, tapping or not', async () => {
  const control = await tapPage('set=short&manual', { agent: false });
  const want = JSON.parse(await control.run(`(${LOOK})()`));
  await control.close();
  const p = await tapPage('set=short&manual');
  const fns = JSON.parse(await p.run(`(${LOOK})()`)).fns;
  // Before the first command the getters are not wrapped yet; compare them after it.
  for (const k of Object.keys(want.fns)) if (!k.startsWith('get ')) assert.deepEqual(fns[k], want.fns[k], k);
  await connect(p);
  assert.deepEqual(JSON.parse(await p.run(`(${LOOK})()`)), want, 'after the first command');
  await send(p, { t: 'tap', on: true });
  assert.deepEqual(JSON.parse(await p.run(`(${LOOK})()`)), want, 'while tapping');
  assert.ok(!(await p.run('Function.prototype.toString.call(SourceBuffer.prototype.appendBuffer)')).includes('capture'), 'no source text leaks');
  assert.deepEqual(errors, []);
  await p.close();
});

// ---------------------------------------------------------------- R3.2: drive, fetch, Bandcamp
const media = (p) => p.run(`(() => { const a = document.getElementById('a');
  return { t: a.currentTime, paused: a.paused, rate: a.playbackRate, dflt: a.defaultPlaybackRate, pp: a.preservesPitch, muted: a.muted, volume: a.volume }; })()`);
const driveState = async (p) => { const g = await lastProgress(p); return g && g.drive ? g.drive.state : null; };
// (Opus priming leaves a buffered range a few ms short of its segments' nominal end.)
const bufferedTo = (p, s) => waitFor(() => p.run(`(() => { const b = document.getElementById('a').buffered; return b.length > 0 && b.end(0) >= ${s - 0.1}; })()`), 10000);
// A player that buffers 20 s ahead of its playhead, through the 45 segments of the 3:00 its
// manifest declares (the packager wrote a 46th of a few milliseconds of encoder padding).
const LONG = 'set=long&n=45&dur=180&ahead=20&manual';

describe('driving the player', { concurrency: 3 }, () => {
  test('drive seekhop: the tap covers all of a 3-minute track in under 10 s without playing it; stop puts the player back', async (t) => {
    const p = await tapPage(LONG);
    await connect(p);
    await send(p, { t: 'drive', mode: 'seekhop' }); // no tap yet: nothing to drive for
    await send(p, { t: 'tap', on: true });
    await p.run('window.__go()');
    await bufferedTo(p, 20);
    assert.equal((await media(p)).t, 0, 'a drive before the tap did nothing');
    await p.run("(() => { const a = document.getElementById('a'); a.currentTime = 7.5; a.volume = 0.8; })()");
    await waitFor(() => p.run("!document.getElementById('a').seeking"), 3000);
    // From 7.5 s its goal reaches the end of the segment holding 27.5 s: 20.5 s ahead. From a hop (the end
    // of a segment) the same goal is 20 s ahead, so the drive must not wait for the 20.5 it saw first.
    await bufferedTo(p, 28);
    const t0 = Date.now(), pt0 = await p.run('performance.now()');
    await send(p, { t: 'drive', mode: 'seekhop' });
    assert.equal((await media(p)).muted, true, 'muted while driven');
    await waitFor(async () => (await driveState(p)) === 'done', 10000, 100).finally(async () => {
      // The hops as the engine saw them: seconds after the drive, at the drive's cursor (s of the track).
      const ms = JSON.parse(await p.run('JSON.stringify(window.__eng.posted.map((m, i) => [window.__eng.times[i], m]))'));
      t.diagnostic(`hops: ${ms.filter(([, m]) => m.t === 'tap-progress' && m.drive).map(([at, m]) => `${((at - pt0) / 1000).toFixed(2)} s at ${m.drive.at.toFixed(1)} ${m.drive.state}`).join(', ')}`);
    });
    const took = Date.now() - t0;
    assert.ok(took < 10000, `${took} ms`);
    await waitFor(async () => (await partsOf(p)).length >= 46, 3000);
    const got = new Set(await blobShas(p, (await partsOf(p)).map((x) => x.blobUrl)));
    assert.deepEqual([fx.long.init, ...fx.long.segs.slice(0, 45)].map(sha).filter((h) => !got.has(h)), [], "every segment of the 3:00 the manifest declares");
    const g = await lastProgress(p);
    assert.ok(g.buffered.length === 1 && g.buffered[0][0] < 0.05 && g.buffered[0][1] > 179.9, JSON.stringify(g.buffered));
    const played = await p.run("(() => { const a = document.getElementById('a'); let s = 0; for (let i = 0; i < a.played.length; i++) s += a.played.end(i) - a.played.start(i); return s; })()");
    assert.ok(played < 1, `played ${played} s of it`);
    await send(p, { t: 'drive', mode: 'stop' });
    assert.deepEqual(await media(p), { t: 7.5, paused: true, rate: 1, dflt: 1, pp: true, muted: false, volume: 0.8 });
    await waitFor(async () => !(await lastProgress(p)).drive, 2000);
    await checkPosted(p);
    await p.close();
  });

  test('drive seekhop: a player that stops buffering is reported stalled after 3 s; when it buffers again the hop goes on', async () => {
    const p = await tapPage(LONG);
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run('window.__limit = 60; window.__go()');
    await bufferedTo(p, 20);
    const t0 = Date.now();
    await send(p, { t: 'drive', mode: 'seekhop' });
    await waitFor(async () => (await driveState(p)) === 'stalled', 8000, 100);
    const s = (Date.now() - t0) / 1000;
    assert.ok(s >= 3 && s < 7, `stalled after ${s.toFixed(1)} s`);
    assert.ok(Math.abs((await lastProgress(p)).drive.at - 60) < 0.5, 'at the place it stopped');
    await p.run('window.__limit = 0; window.__pump()');
    await waitFor(async () => (await driveState(p)) === 'done', 10000, 100);
    await send(p, { t: 'drive', mode: 'stop' });
    await checkPosted(p);
    await p.close();
  });

  test('drive accelerate from a place, held and audible (recording a whole track): paused there with its sound, then played; stop puts it back', async () => {
    const p = await tapPage(LONG);
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run("window.__go().then(() => { const a = document.getElementById('a'); a.volume = 0.6; a.currentTime = 12; return a.play(); })");
    await waitFor(async () => { const m = await media(p); return !m.paused && m.t > 12.2; }, 5000);
    await send(p, { t: 'drive', mode: 'accelerate', rate: 2, from: 0, hold: true, audible: true });
    await waitFor(() => p.run("!document.getElementById('a').seeking"), 3000);
    let m = await media(p);
    assert.deepEqual([m.t, m.paused, m.rate, m.pp, m.muted], [0, true, 2, false, false], 'held at 0, at 2x, with its sound');
    await send(p, { t: 'drive', mode: 'accelerate', rate: 2, audible: true });
    await waitFor(async () => { const x = await media(p); return !x.paused && x.t > 0.3; }, 5000);
    m = await media(p);
    assert.deepEqual([m.rate, m.pp, m.muted], [2, false, false]);
    await send(p, { t: 'drive', mode: 'stop' });
    m = await media(p);
    assert.deepEqual([m.paused, m.rate, m.pp, m.muted, m.volume], [false, 1, true, false, 0.6]);
    assert.ok(Math.abs(m.t - 12.2) < 1, `back near where it was: ${m.t}`);
    await checkPosted(p);
    await p.close();
  });

  test('drive accelerate at 8x captures the track through playback with pitch unlocked, for as long as it takes', async () => {
    const p = await tapPage(LONG);
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run("window.__go().then(() => document.getElementById('a').play())");
    await waitFor(async () => !(await media(p)).paused, 5000);
    await send(p, { t: 'drive', mode: 'accelerate', rate: 8 });
    await p.waitForTimeout(300);
    const m = await media(p);
    assert.deepEqual([m.rate, m.pp, m.muted], [8, false, true]);
    // About 20 s at 8x: longer than the 10 s the agent waits for an assist keep-alive.
    await waitFor(async () => (await driveState(p)) === 'done', 45000, 250);
    const got = new Set(await blobShas(p, (await partsOf(p)).map((x) => x.blobUrl)));
    assert.deepEqual([fx.long.init, ...fx.long.segs.slice(0, 45)].map(sha).filter((h) => !got.has(h)), [], "every segment of the 3:00 the manifest declares");
    await send(p, { t: 'drive', mode: 'stop' });
    const b = await media(p);
    assert.deepEqual([b.rate, b.dflt, b.pp, b.muted], [1, 1, true, false]);
    await checkPosted(p);
    await p.close();
  });

  test('drive accelerate on a page that resets its rate: the agent backs off after a few tries and says refused', async () => {
    const p = await tapPage(`${LONG}&fight`);
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run("window.__go().then(() => document.getElementById('a').play())");
    await waitFor(async () => !(await media(p)).paused, 5000);
    await send(p, { t: 'drive', mode: 'accelerate', rate: 8 });
    await waitFor(async () => (await driveState(p)) === 'refused', 3000);
    await p.waitForTimeout(500);
    const m = await media(p);
    assert.deepEqual([m.rate, m.pp], [1, true], 'the page keeps its rate and pitch setting');
    assert.ok((await p.run('window.__rc')) < 20, 'no fight loop');
    assert.equal((await posted(p, 'external-rate')).length, 1);
    await checkPosted(p);
    await p.close();
  });

  test('drive stop puts back everything the drive changed: position, playing state, rate, pitch, mute and volume', async () => {
    const p = await tapPage(LONG);
    await connect(p);
    await send(p, { t: 'tap', on: true });
    await p.run('window.__go()');
    await bufferedTo(p, 20);
    await p.run("(() => { const a = document.getElementById('a'); a.currentTime = 12.3; a.playbackRate = 1.25; a.volume = 0.7; })()");
    await waitFor(() => p.run("!document.getElementById('a').seeking"), 3000);
    const before = await media(p);
    assert.deepEqual(before, { t: 12.3, paused: true, rate: 1.25, dflt: 1, pp: true, muted: false, volume: 0.7 });
    await send(p, { t: 'drive', mode: 'accelerate', rate: 8 }); // a paused player is started for the drive
    await waitFor(async () => { const m = await media(p); return !m.paused && m.rate === 8 && m.t > 13; }, 5000);
    await send(p, { t: 'drive', mode: 'stop' });
    assert.deepEqual(await media(p), before);
    await checkPosted(p);
    await p.close();
  });

  test('no seek-hop on an MP3 SourceBuffer (nothing in it to place it by): refused, untouched, and its type is in tap-progress', async () => {
    const p = await tapPage('set=short&dur=30&manual&raw&mime=audio/mpeg');
    await connect(p);
    await p.run('window.__go()'); // the SourceBuffer is made before the tap comes on
    await send(p, { t: 'tap', on: true });
    await waitFor(async () => { const g = await lastProgress(p); return g && g.mimes.includes('audio/mpeg'); }, 3000);
    await send(p, { t: 'drive', mode: 'seekhop' });
    await waitFor(async () => (await driveState(p)) === 'refused', 3000);
    const m = await media(p);
    assert.deepEqual([m.t, m.muted], [0, false], 'the player was not touched');
    await checkPosted(p);
    await p.close();
  });

  test('an eject (stop) or the engine going away mid-drive gives the player back at once and lets the blob URLs go', async () => {
    for (const end of ['window.__jdsStop()', 'window.__eng.die()']) {
      const p = await tapPage(LONG);
      await connect(p);
      await send(p, { t: 'tap', on: true });
      await p.run('window.__go()');
      await bufferedTo(p, 20);
      await p.run("document.getElementById('a').currentTime = 5");
      await waitFor(() => p.run("!document.getElementById('a').seeking"), 3000);
      await send(p, { t: 'drive', mode: 'accelerate', rate: 8 });
      await waitFor(async () => { const m = await media(p); return !m.paused && m.rate === 8; }, 5000);
      const urls = (await partsOf(p)).map((x) => x.blobUrl);
      await p.run(end);
      const m = await media(p);
      assert.deepEqual([m.t, m.paused, m.rate, m.pp, m.muted], [5, true, 1, true, false], end);
      assert.deepEqual(await blobShas(p, urls), urls.map(() => 'unreadable'), end);
      await p.close();
    }
  });
});

// ---------------------------------------------------------------- follow-up: a player that was playing before the tap
const removes = (p) => p.run('JSON.stringify(window.__removes)').then(JSON.parse);
const driveStates = async (p) => (await posted(p, 'tap-progress')).filter((g) => g.drive).map((g) => g.drive.state);
const sbRanges = (p, v = '__sb') => p.run(`(() => { const b = window.${v}.buffered, o = []; for (let i = 0; i < b.length; i++) o.push([b.start(i), b.end(i)]); return JSON.stringify(o); })()`).then(JSON.parse);

describe('flushing the player before a drive', { concurrency: 3 }, () => {
  test('drive with flush: what a playing player held from before the tap is removed, fetched again and captured byte for byte; stop gives it back playing', async () => {
    const p = await tapPage(`${LONG}&buf`, { init: [REMOVE_SPY] });
    await connect(p);
    // The DJ hears it first: playing, about 20 s held ahead, none of it captured (only its init is kept).
    await p.run("window.__go().then(() => document.getElementById('a').play())");
    await waitFor(async () => { const m = await media(p); return !m.paused && m.t > 1; }, 5000);
    await bufferedTo(p, 20);
    await send(p, { t: 'tap', on: true });
    await waitFor(async () => (await partsOf(p)).length >= 1, 3000);
    const t0 = (await media(p)).t;
    await send(p, { t: 'drive', mode: 'seekhop', flush: true });
    await waitFor(async () => (await driveState(p)) === 'done', 15000, 100)
      .catch(async () => assert.fail(`not done: ${JSON.stringify(await lastProgress(p))}, appended ${await p.run('JSON.stringify(window.__fx.appended)')}`));
    const states = await driveStates(p);
    assert.equal(states.filter((s) => s === 'flushed').length, 1, `flushed said once: ${states}`);
    assert.ok(states.indexOf('flushed') < states.lastIndexOf('done'), `${states}`);
    const rm = await removes(p);
    assert.ok(rm.length === 2 && rm.every((r) => r[0] === MIME) && rm[0][1] === 0 && rm[0][2] > 0.25 && rm[0][2] < t0 && rm[1][1] === rm[0][2] && rm[1][2] === 180,
      `what lies behind its place, then (once it fetched that again) the rest, to the length of the track: ${JSON.stringify(rm)} (at ${t0})`);
    await waitFor(async () => (await partsOf(p)).length >= 46, 3000);
    const got = await blobShas(p, (await partsOf(p)).map((x) => x.blobUrl)), want = [fx.long.init, ...fx.long.segs.slice(0, 45)].map(sha);
    assert.deepEqual(want.filter((h) => !got.includes(h)), [], 'every piece from 0 to the end of the 3:00');
    assert.deepEqual(got.filter((h) => !want.includes(h)), [], 'byte for byte the files served');
    const g = await lastProgress(p);
    assert.ok(g.buffered.length === 1 && g.buffered[0][0] < 0.05 && g.buffered[0][1] > 179.9, JSON.stringify(g.buffered));
    await send(p, { t: 'drive', mode: 'stop' });
    const m = await media(p);
    assert.deepEqual([m.paused, m.muted, m.rate, m.pp], [false, false, 1, true]);
    assert.ok(m.t >= t0 && m.t < t0 + 1.5, `back where it was: ${m.t} (drive at ${t0})`);
    await waitFor(async () => (await media(p)).t > m.t + 0.5, 5000).catch(async () => assert.fail(`it does not play again: ${JSON.stringify(await media(p))}`));
    await checkPosted(p);
    await p.close();
  });

  test('a playing player that never fetches a piece twice is left what it holds around its place: said sticky, and after stop it plays on from there', async () => {
    const p = await tapPage(LONG, { init: [REMOVE_SPY] }); // no &buf: it fetches each segment once, whatever its buffer holds
    await connect(p);
    await p.run("window.__go().then(() => document.getElementById('a').play())");
    await waitFor(async () => { const m = await media(p); return !m.paused && m.t > 2; }, 8000);
    await bufferedTo(p, 20);
    await send(p, { t: 'tap', on: true });
    const t0 = (await media(p)).t;
    await send(p, { t: 'drive', mode: 'seekhop', flush: true });
    await waitFor(async () => { const d = (await lastProgress(p))?.drive; return d && (d.unflushed || d.state === 'flushed'); }, 8000);
    await send(p, { t: 'drive', mode: 'stop' });
    const m = await media(p);
    assert.deepEqual([m.paused, m.muted, m.rate], [false, false, 1]);
    assert.ok(m.t >= t0 && m.t < t0 + 1.5, `back where it was: ${m.t} (drive at ${t0})`);
    await waitFor(async () => (await media(p)).t > m.t + 1, 5000)
      .catch(async () => assert.fail(`it does not play again: ${JSON.stringify(await media(p))}, buffered ${JSON.stringify(await sbRanges(p))}`));
    const said = (await posted(p, 'tap-progress')).filter((g) => g.drive).map((g) => g.drive);
    assert.ok(said.some((d) => d.unflushed === 'sticky') && !said.some((d) => d.state === 'flushed'), JSON.stringify(said));
    const rm = await removes(p);
    assert.ok(rm.length === 1 && rm[0][0] === MIME && rm[0][1] === 0 && rm[0][2] > 0.25 && rm[0][2] < t0, `only what lies behind its place: ${JSON.stringify(rm)} (at ${t0})`);
    await checkPosted(p);
    await p.close();
  });

  test('flush never empties a SourceBuffer of pictures: beside a sound one only the sound is flushed; with pictures only it is refused, said, and the drive goes on', async () => {
    const both = await tapPage(`${LONG}&buf&video`, { init: [REMOVE_SPY] });
    await connect(both);
    await both.run('window.__go()');
    // The pictures SourceBuffer holds 8 s of VP9: a flush that took it too would empty it.
    await both.run(`fetch('/fx/vid/vid.webm').then((r) => r.arrayBuffer()).then((b) => new Promise((res, rej) => {
      const v = window.__vsb; v.onupdateend = () => res(); v.onerror = () => rej(new Error('the pictures would not append')); v.appendBuffer(b);
    }))`);
    const held = await sbRanges(both, '__vsb');
    assert.ok(held.length === 1 && held[0][0] < 0.05 && held[0][1] > 7.5, `pictures held: ${JSON.stringify(held)}`);
    await both.run("document.getElementById('a').currentTime = 6"); // something behind its place to flush first
    await waitFor(async () => { const b = await sbRanges(both); return b.length === 1 && b[0][1] > 25.9; }, 5000);
    await send(both, { t: 'tap', on: true });
    await send(both, { t: 'drive', mode: 'seekhop', flush: true });
    await waitFor(async () => (await driveStates(both)).includes('flushed'), 8000);
    assert.deepEqual(await removes(both), [[MIME, 0, 5], [MIME, 5, 180]], 'only the sound');
    assert.deepEqual(await sbRanges(both, '__vsb'), held, 'the pictures kept');
    await send(both, { t: 'drive', mode: 'stop' });
    await checkPosted(both);
    await both.close();

    const pics = await tapPage('set=short&dur=30&manual&raw&mime=video/webm;%20codecs%3D%22vp9%22', { init: [REMOVE_SPY] });
    await connect(pics);
    await pics.run('window.__go()');
    await send(pics, { t: 'tap', on: true });
    await send(pics, { t: 'drive', mode: 'seekhop', flush: true });
    await waitFor(async () => { const d = (await lastProgress(pics))?.drive; return d && d.unflushed === 'video'; }, 3000);
    assert.ok(!(await driveStates(pics)).includes('flushed'));
    assert.deepEqual(await removes(pics), []);
    await send(pics, { t: 'drive', mode: 'stop' });
    await checkPosted(pics);
    await pics.close();
  });

  test('a player at the very start (nothing behind its place to try a flush on) is not flushed: said, nothing removed, and the drive goes on', async () => {
    const p = await tapPage(`${LONG}&buf`, { init: [REMOVE_SPY] });
    await connect(p);
    await p.run('window.__go()'); // paused at 0, 20 s held
    await bufferedTo(p, 20);
    await send(p, { t: 'tap', on: true });
    await send(p, { t: 'drive', mode: 'seekhop', flush: true });
    await waitFor(async () => { const d = (await lastProgress(p))?.drive; return d && d.unflushed === 'start'; }, 3000);
    await waitFor(async () => (await driveState(p)) === 'done', 15000);
    assert.ok(!(await driveStates(p)).includes('flushed'));
    assert.deepEqual(await removes(p), []);
    await send(p, { t: 'drive', mode: 'stop' });
    assert.deepEqual([(await media(p)).t, (await media(p)).muted], [0, false]);
    await checkPosted(p);
    await p.close();
  });

  test('flush on a MediaSource that has ended is refused (a remove would reopen it): said, nothing removed, no sourceopen, the buffer kept; the drive goes on', async () => {
    const p = await tapPage('set=short&n=8&dur=30&manual', { init: [REMOVE_SPY] });
    await connect(p);
    await p.run('window.__go()'); // no buffering goal: it appends every segment and ends the stream
    await waitFor(() => p.run("window.__ms.readyState === 'ended'"), 5000);
    const held = await sbRanges(p);
    await p.run("window.__ms.addEventListener('sourceopen', () => { window.__reopened = true; })");
    await send(p, { t: 'tap', on: true });
    await send(p, { t: 'drive', mode: 'seekhop', flush: true });
    await waitFor(async () => { const d = (await lastProgress(p))?.drive; return d && d.unflushed === 'ended'; }, 3000);
    await waitFor(async () => (await driveState(p)) === 'done', 5000);
    assert.ok(!(await driveStates(p)).includes('flushed'));
    assert.deepEqual(await removes(p), []);
    assert.deepEqual([await p.run('window.__ms.readyState'), await p.run('!!window.__reopened')], ['ended', false]);
    assert.deepEqual(await sbRanges(p), held);
    await send(p, { t: 'drive', mode: 'stop' });
    assert.deepEqual([(await media(p)).t, (await media(p)).muted], [0, false]);
    await checkPosted(p);
    await p.close();
  });
});

describe('fetching from the page', { concurrency: 3 }, () => {
  test("fetch {urls}: the page's own fetch from document_start, eight at a time, parts numbered in request order", async () => {
    const p = await tapPage('', { page: '/blank.html', init: [FETCH_SPY] });
    await connect(p);
    // The page replaces fetch after load: the agent must not go through it.
    await p.run('window.__pf = 0; { const g = window.fetch; window.fetch = function fetch(...a) { window.__pf++; return g.apply(this, a); }; } 0');
    const urls = fx.long.segs.slice(0, 20).map((_, i) => `/slow/fx/long/seg-${String(i + 1).padStart(5, '0')}.m4s`);
    await send(p, { t: 'fetch', urls });
    await waitFor(async () => (await partsOf(p)).length >= 20, 15000);
    const spy = await p.run('JSON.stringify(window.__fs)').then(JSON.parse);
    assert.deepEqual([spy.calls, spy.max], [20, 8], 'all through the native fetch, eight at a time');
    assert.equal(await p.run('window.__pf'), 0, "the page's own later fetch was never used");
    const parts = (await partsOf(p)).sort((a, b) => a.seq - b.seq);
    assert.deepEqual(parts.map((x) => [x.kind, x.sb, x.seq, x.mime]), urls.map((_, i) => ['media', -1, i, 'audio/mp4']));
    assert.deepEqual(await blobShas(p, parts.map((x) => x.blobUrl)), fx.long.segs.slice(0, 20).map(sha));
    await checkPosted(p);
    await p.close();
  });

  test('fetch {urls}: a failing or non-web link is reported by its place in the list, and the rest still come', async () => {
    const p = await tapPage('', { page: '/blank.html' });
    await connect(p);
    await send(p, { t: 'fetch', urls: ['/fx/short/seg-00001.m4s', '/nope.m4s', 'javascript:alert(1)', '/fx/short/seg-00002.m4s'] });
    await waitFor(async () => (await partsOf(p)).length >= 2 && (await errorsOf(p)).length >= 2, 5000);
    const parts = (await partsOf(p)).sort((a, b) => a.seq - b.seq);
    assert.deepEqual(parts.map((x) => x.seq), [0, 3]);
    assert.deepEqual(await blobShas(p, parts.map((x) => x.blobUrl)), [fx.short.segs[0], fx.short.segs[1]].map(sha));
    const errs = (await errorsOf(p)).sort((a, b) => a.seq - b.seq);
    assert.deepEqual(errs.map((e) => [e.reason, e.seq]), [['fetch', 1], ['fetch', 2]]);
    assert.match(errs[0].detail, /404/);
    assert.match(errs[1].detail, /not a web link/);
    // Tap off while a fetch is under way: what arrives afterwards is not handed over.
    await send(p, { t: 'fetch', urls: ['/slow/fx/short/seg-00003.m4s'] });
    await send(p, { t: 'tap', on: false });
    await p.waitForTimeout(800);
    assert.equal((await partsOf(p)).length, 2);
    await checkPosted(p);
    await p.close();
  });

  test('fetch {urls}: a link that never answers is given up after 15 s', async () => {
    const p = await tapPage('', { page: '/blank.html' });
    await connect(p);
    const t0 = Date.now();
    await send(p, { t: 'fetch', urls: ['/hang'] });
    await waitFor(async () => (await errorsOf(p)).length > 0, 25000, 250);
    const s = (Date.now() - t0) / 1000;
    assert.ok(s > 14 && s < 20, `gave up after ${s.toFixed(1)} s`);
    assert.deepEqual((await errorsOf(p)).map((e) => [e.reason, e.seq]), [['fetch', 0]]);
    assert.match((await errorsOf(p))[0].detail, /timed out/);
    await checkPosted(p);
    await p.close();
  });

  test("readTralbum: the page's own stream link comes back as one 'file' part, with the track's length", async () => {
    const p = await tapPage('mode=ok', { page: '/tralbum.html' });
    await connect(p);
    await send(p, { t: 'readTralbum' });
    await waitFor(async () => (await partsOf(p)).length >= 1, 5000);
    const ready = await posted(p, 'tap-ready');
    assert.equal(ready.length, 1);
    assert.deepEqual(ready[0].parts.map((x) => [x.kind, x.sb, x.seq, x.mime]), [['file', -1, 0, 'audio/mpeg']]);
    assert.equal(ready[0].duration, 30.04);
    assert.deepEqual(await blobShas(p, [ready[0].parts[0].blobUrl]), [sha(fx.files['/fx/mp3/track.mp3'])]);
    await checkPosted(p);
    await p.close();
  });

  test('readTralbum: no data-tralbum, or no stream link in it, is tap-error none', async () => {
    for (const mode of ['none', 'nourl']) {
      const p = await tapPage(`mode=${mode}`, { page: '/tralbum.html' });
      await connect(p);
      await send(p, { t: 'readTralbum' });
      await waitFor(async () => (await errorsOf(p)).length > 0, 3000);
      assert.deepEqual((await errorsOf(p)).map((e) => e.reason), ['none'], mode);
      assert.deepEqual(await partsOf(p), []);
      await checkPosted(p);
      await p.close();
    }
  });
});
