// Model streaming sites (/m/* on the track server): each page behaves like the kind of site it
// models, in plain Chromium with no extension. The resident-deck acceptance tests load these.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startTrackServer, waitFor } from './ext-harness.mjs';
import { launchPlain } from './playwright.mjs';

const SITES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sites');
const MODELS = {
  progressive: { kind: 'progressive', duration: 120 },
  mse: { kind: 'mse', duration: 120 },
  opaque: { kind: 'mse-opaque', duration: 120 },
  abr: { kind: 'mse-abr', duration: 120 },
  ratefight: { kind: 'progressive', duration: 120 },
  worker: { kind: 'mse-worker', duration: 120 },
  drm: { kind: 'eme', duration: 120 },
  preview: { kind: 'progressive', duration: 30 },
  bandcamp: { kind: 'progressive', duration: 120 },
  live: { kind: 'mse-live', duration: Infinity },
  webaudio: { kind: 'webaudio', duration: 120 },
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const index = () => JSON.parse(fs.readFileSync(path.join(SITES, 'index.json'), 'utf8'));
let server, browser;

before(async () => {
  server = await startTrackServer({ seconds: 2 });
  browser = await launchPlain();
});
after(async () => { await browser?.close(); await server?.close(); });

/** Open /m/<name>; `init` runs before any page script. Collects page errors and requests. */
async function open(name, { query = '', init } = {}) {
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method(), body: r.postData(), headers: r.headers() }));
  if (init) await page.addInitScript(init);
  await page.goto(`${server.origin}/m/${name}${query ? `?${query}` : ''}`);
  return { page, errors, requests };
}
const media = (page) => page.evaluate(() => window.__media());
const pageState = (page) => page.evaluate(() => window.__page);
/** Waits until the element plays past `from + by` seconds. */
const playsPast = (page, from, by = 0.3) => waitFor(async () => {
  const m = await media(page);
  return m && !m.paused && m.t > from + by && m;
}, 10000);
async function clickToPlay(page) {
  const m0 = await media(page);
  assert.ok(!m0 || m0.paused, 'nothing plays before the click');
  await page.click('#play');
  return playsPast(page, 0);
}
async function assertModel(page, name) {
  const m = await page.evaluate(() => window.__model);
  assert.equal(m.name, name);
  assert.equal(m.kind, MODELS[name].kind);
  assert.equal(m.duration, MODELS[name].duration);
  assert.ok(typeof m.notes === 'string' && m.notes.length > 20, `notes: ${m.notes}`);
}
async function done(o) {
  const st = await pageState(o.page);
  await o.page.close();
  assert.deepEqual(st.errors, []);
  assert.deepEqual(o.errors, []);
}

// ---------------------------------------------------------------- fixtures
test('site fixtures match their index and stay under 2 MB', () => {
  const ix = index(), listed = new Map();
  for (const [p, f] of Object.entries(ix.files)) listed.set(p, f);
  for (const r of Object.values(ix.reps)) for (const f of [r.init, ...r.segs]) listed.set(f.path, f);
  let total = 0;
  for (const [p, f] of listed) {
    const buf = fs.readFileSync(path.join(SITES, p));
    assert.equal(buf.length, f.bytes, p);
    assert.equal(sha(buf), f.sha256, p);
    total += buf.length;
  }
  const onDisk = fs.readdirSync(SITES, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
    .map((d) => path.relative(SITES, path.join(d.parentPath, d.name))).filter((p) => p !== 'index.json');
  assert.deepEqual(onDisk.sort(), [...listed.keys()].sort());
  total += fs.statSync(path.join(SITES, 'index.json')).size;
  assert.ok(total < 2e6, `fixtures total ${total} bytes`);
  assert.equal(ix.signal.bpm, 124);
  assert.equal(ix.signal.seconds, 120);
});

test('the two Opus bitrates share 4 s segment boundaries, and the encrypted copy carries its key', () => {
  const { reps } = index(), lo = reps['opus-lo'], hi = reps['opus-hi'];
  assert.ok(hi.bitrate >= 2 * lo.bitrate);
  assert.deepEqual(lo.segs.map((s) => [s.t0, s.t1]), hi.segs.map((s) => [s.t0, s.t1]));
  lo.segs.slice(0, -1).forEach((s, i) => { assert.equal(s.t0, 4 * i); assert.equal(s.t1, 4 * i + 4); });
  assert.ok(lo.segs.at(-1).t1 >= 120 && lo.segs.at(-1).t1 < 120.1);
  assert.ok(hi.segs.reduce((a, s) => a + s.bytes, 0) > 1.5 * lo.segs.reduce((a, s) => a + s.bytes, 0));
  const enc = reps['opus-cenc'];
  assert.deepEqual(enc.segs.map((s) => [s.t0, s.t1]), lo.segs.map((s) => [s.t0, s.t1]));
  assert.equal(enc.drm.keySystem, 'org.w3.clearkey');
  assert.match(enc.drm.kid, /^[0-9a-f]{32}$/);
  assert.match(enc.drm.key, /^[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------- pages
test('every model page plays with ?autoplay=1', async () => {
  await Promise.all(Object.keys(MODELS).map(async (name) => {
    const o = await open(name, { query: name === 'live' ? 'autoplay=1&join=30' : 'autoplay=1' });
    if (name === 'webaudio') await waitFor(() => o.page.evaluate(() => window.__ctx?.state === 'running' && window.__ctx.currentTime > 0.3));
    else if (name === 'worker' && !(await o.page.evaluate(() => MediaSource.canConstructInDedicatedWorker))) { await o.page.close(); return; }
    else await playsPast(o.page, name === 'live' ? 30 : 0);
    await assertModel(o.page, name);
    await done(o);
  }));
});

test('/m/progressive: a plain <audio src> MP3 with byte ranges, seekable', async () => {
  const o = await open('progressive');
  await assertModel(o.page, 'progressive');
  const m = await clickToPlay(o.page);
  assert.equal(new URL(m.src).pathname, '/m/media/track.mp3');
  assert.ok(Math.abs(m.duration - 120) < 0.1, `duration ${m.duration}`);
  const r = await fetch(`${server.origin}/m/media/track.mp3`, { headers: { range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 100-199/${index().files['track.mp3'].bytes}`);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  await o.page.evaluate(() => { document.querySelector('audio').currentTime = 60; });
  await playsPast(o.page, 60);
  await done(o);
});

test('/m/mse: plain GET segments from a playlist, 20 s buffered ahead, re-fetchable, seekable', async () => {
  const o = await open('mse');
  await assertModel(o.page, 'mse');
  await clickToPlay(o.page);
  await new Promise((r) => setTimeout(r, 800));
  const m = await media(o.page), ahead = m.buffered[0][1] - m.t;
  assert.ok(ahead >= 15 && ahead <= 25, `buffered ahead ${ahead}`);
  assert.equal(m.buffered.length, 1);
  assert.ok(m.src.startsWith('blob:'));
  assert.ok(Math.abs(m.duration - 120) < 0.1, `duration ${m.duration}`);
  const segs = o.requests.filter((r) => /\/m\/media\/opus-hi\/seg-\d{3}\.m4s$/.test(r.url));
  assert.ok(segs.length >= 5 && segs.length <= 7, `${segs.length} segments fetched`);
  assert.ok(segs.every((r) => r.method === 'GET'));
  assert.ok(o.requests.some((r) => r.url.endsWith('/m/media/opus-hi.m3u8')));
  const st = await pageState(o.page);
  assert.ok(st.appends.every((a) => !a.view), 'whole ArrayBuffers are appended');
  const again = Buffer.from(await (await fetch(segs[3].url)).arrayBuffer());
  assert.equal(sha(again), index().reps['opus-hi'].segs[3].sha256, 'a seen segment URL can be fetched again');
  await o.page.evaluate(() => { document.querySelector('audio').currentTime = 61; });
  const after = await playsPast(o.page, 61);
  assert.ok(after.buffered.some(([a, b]) => a <= 60.01 && b >= 76), JSON.stringify(after.buffered));
  await done(o);
});

test('/m/opaque: segments only by POST with a single-use page token, framed, appended as views', async () => {
  const o = await open('opaque');
  await assertModel(o.page, 'opaque');
  const responses = [];
  o.page.on('response', async (r) => { if (r.url().endsWith('/m/seg')) responses.push(await r.body().catch(() => null)); });
  await clickToPlay(o.page);
  const posts = o.requests.filter((r) => r.url.endsWith('/m/seg'));
  assert.ok(posts.length >= 6, `${posts.length} posts`);
  assert.ok(posts.every((r) => r.method === 'POST' && r.headers['x-model-token']));
  assert.deepEqual(JSON.parse(posts[0].body), { seg: 'init' });
  assert.deepEqual(JSON.parse(posts[1].body), { seg: 0 });
  assert.ok(!o.requests.some((r) => /\.(m4s|mp4|m3u8)$/.test(r.url)), 'no media URL is ever requested');
  const body = responses.find(Boolean);
  assert.equal(body[0], 0x15, 'responses are framed, not raw media');
  const st = await pageState(o.page);
  assert.ok(st.appends.length >= 6 && st.appends.every((a) => a.view && a.offset > 0), 'appends are views into larger buffers');
  const post = (headers) => fetch(`${server.origin}/m/seg`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ seg: 3 }) });
  assert.equal((await post({})).status, 403, 'no token');
  assert.equal((await post({ 'x-model-token': posts[3].headers['x-model-token'] })).status, 403, 'a replayed token');
  await o.page.evaluate(() => { document.querySelector('audio').currentTime = 90; });
  await playsPast(o.page, 90);
  await done(o);
});

test('/m/abr: lo segments to 12 s, then the hi init segment and hi segments; plays through the switch', async () => {
  const o = await open('abr');
  await assertModel(o.page, 'abr');
  await clickToPlay(o.page);
  const st = await pageState(o.page);
  assert.deepEqual(st.appends.slice(0, 7).map((a) => `${a.rep}:${a.kind === 'init' ? 'init' : a.n}`),
    ['lo:init', 'lo:0', 'lo:1', 'lo:2', 'hi:init', 'hi:3', 'hi:4']);
  assert.ok(o.requests.some((r) => r.url.endsWith('/m/media/opus.m3u8')), 'reads the master playlist');
  await o.page.evaluate(() => { document.querySelector('audio').currentTime = 11.6; });
  const m = await playsPast(o.page, 12, 0.4);
  assert.ok(m.buffered[0][0] <= 0.01 && m.buffered[0][1] >= 20, JSON.stringify(m.buffered));
  assert.ok(Math.abs(m.duration - 120) < 0.1);
  await done(o);
});

test('/m/ratefight: resets playbackRate within 50 ms, and on seeking', async () => {
  const o = await open('ratefight');
  await assertModel(o.page, 'ratefight');
  const m = await clickToPlay(o.page);
  assert.equal(new URL(m.src).pathname, '/m/media/track.webm');
  const dt = await o.page.evaluate(() => new Promise((res) => {
    const a = document.querySelector('audio'), t0 = performance.now();
    const f = () => { if (a.playbackRate === 1) { a.removeEventListener('ratechange', f); res(performance.now() - t0); } };
    a.addEventListener('ratechange', f);
    setTimeout(() => res(Infinity), 1000);
    a.playbackRate = 4;
  }));
  assert.ok(dt < 50, `reset after ${dt} ms`);
  await o.page.evaluate(() => { const a = document.querySelector('audio'); a.currentTime = 30; });
  await waitFor(async () => (await pageState(o.page)).resets.some((r) => r.why === 'seeking'));
  const st = await pageState(o.page);
  assert.ok(st.resets.some((r) => r.why === 'ratechange' && r.from === 4), JSON.stringify(st.resets));
  assert.equal((await media(o.page)).rate, 1);
  await playsPast(o.page, 30);
  await done(o);
});

test('/m/worker: MSE lives in a DedicatedWorker, so the page itself never touches a SourceBuffer', async (t) => {
  const o = await open('worker', {
    init: () => {
      const n = window.__mainMse = { add: 0, append: 0 };
      const add = MediaSource.prototype.addSourceBuffer, app = SourceBuffer.prototype.appendBuffer;
      MediaSource.prototype.addSourceBuffer = function (...a) { n.add++; return add.apply(this, a); };
      SourceBuffer.prototype.appendBuffer = function (...a) { n.append++; return app.apply(this, a); };
    },
  });
  if (!(await o.page.evaluate(() => MediaSource.canConstructInDedicatedWorker))) {
    await o.page.close();
    t.skip('this Chromium cannot construct a MediaSource in a DedicatedWorker');
    return;
  }
  await assertModel(o.page, 'worker');
  await clickToPlay(o.page);
  const r = await o.page.evaluate(() => {
    const a = document.querySelector('audio');
    return { handle: a.srcObject?.constructor.name, src: a.getAttribute('src'), main: window.__mainMse, worker: window.__page.appends.length };
  });
  assert.equal(r.handle, 'MediaSourceHandle');
  assert.equal(r.src, null);
  assert.deepEqual(r.main, { add: 0, append: 0 });
  assert.ok(r.worker >= 5, `${r.worker} appends in the worker`);
  await done(o);
});

test('/m/drm: ClearKey-encrypted MSE fires a real encrypted event and plays once licensed', async () => {
  const o = await open('drm');
  await assertModel(o.page, 'drm');
  await clickToPlay(o.page);
  const st = await pageState(o.page);
  assert.ok(st.encrypted.length >= 1);
  assert.equal(st.encrypted[0].initDataType, 'cenc');
  assert.equal(st.encrypted[0].system, '1077efecc0b24d02ace33c1e52e2fb4b', 'a ClearKey pssh');
  assert.equal(await o.page.evaluate(() => !!document.querySelector('audio').mediaKeys), true);
  await done(o);
});

test('/m/preview: a 30 s excerpt, flagged as a snipped preview in the page JSON', async () => {
  const o = await open('preview');
  await assertModel(o.page, 'preview');
  const m = await clickToPlay(o.page);
  assert.ok(Math.abs(m.duration - 30) < 0.1, `duration ${m.duration}`);
  assert.match(new URL(m.src).pathname, /\/preview\//);
  const info = await o.page.evaluate(() => JSON.parse(document.getElementById('track').textContent));
  assert.equal(info.policy, 'SNIP');
  assert.equal(info.snipped, true);
  assert.equal(info.full_duration, 120000);
  await done(o);
});

test('/m/bandcamp: data-tralbum names the stream MP3 the <audio> player uses', async () => {
  const o = await open('bandcamp');
  await assertModel(o.page, 'bandcamp');
  const m = await clickToPlay(o.page);
  const info = await o.page.evaluate(() => JSON.parse(document.querySelector('[data-tralbum]').dataset.tralbum));
  assert.equal(info.trackinfo[0].file['mp3-128'], '/m/media/track.mp3');
  assert.equal(info.trackinfo[0].duration, 120);
  assert.ok(info.trackinfo[0].title);
  assert.equal(m.src, `${server.origin}/m/media/track.mp3`);
  assert.ok(Math.abs(m.duration - 120) < 0.1);
  await done(o);
});

test('/m/live: duration is Infinity and segments keep coming round in a loop', async () => {
  const o = await open('live', { query: 'join=119' });
  await assertModel(o.page, 'live');
  await o.page.click('#play');
  const m = await playsPast(o.page, 120.5, 0);
  assert.equal(m.duration, Infinity);
  const st = await pageState(o.page), n = index().reps['opus-lo'].segs.length;
  assert.ok(st.appends.some((a) => a.kind === 'media' && a.n >= n), 'the second time round has started');
  assert.ok(o.requests.some((r) => r.url.endsWith('/m/media/opus-lo.m3u8?live=1')));
  await done(o);
});

test('/m/webaudio: plays a decoded buffer through Web Audio, with no media element and no media URL', async () => {
  const o = await open('webaudio');
  await assertModel(o.page, 'webaudio');
  await o.page.click('#play');
  await waitFor(() => o.page.evaluate(() => window.__ctx?.state === 'running' && window.__ctx.currentTime > 0.3 && window.__page.playing));
  assert.equal(await o.page.evaluate(() => document.querySelectorAll('audio, video').length), 0);
  assert.ok(!o.requests.some((r) => /\.(mp3|webm|mp4|m4s|m3u8|wav)(\?|$)/.test(r.url)), o.requests.map((r) => r.url).join('\n'));
  await done(o);
});
