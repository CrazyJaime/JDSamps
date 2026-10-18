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
  let sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${ext.id}/`));
  if (!sw) sw = await context.waitForEvent('serviceworker', { predicate: (w) => w.url().startsWith(`chrome-extension://${ext.id}/`), timeout: 15000 });
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
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
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: (name) => `${origin}/${name}`, close: () => new Promise((r) => server.close(r)) };
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

export function bandRms(mono, sr, band) {
  const y = bandFilter(mono, sr, band);
  let s = 0; for (let i = 0; i < y.length; i++) s += y[i] * y[i];
  return Math.sqrt(s / Math.max(1, y.length));
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
