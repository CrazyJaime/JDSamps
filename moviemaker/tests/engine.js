// Browser tests for the playback & export engine (js/audio.js, js/player.js, js/exporter.js).
// Loaded by tests/engine.html; driven by tests/engine.test.mjs (headless Chromium).
// Phase 1 runs on load (no user gesture): decoding, offline audio scheduling, paused seeks,
// scrubbing, snapshot. Phase 2 runs from a click on #go: playback, ended, loop, export.

import { Store } from '../js/store.js';
import { createVisualItem, createMusicItem, computeTimeline } from '../js/model.js';
import { AudioEngine, mixGains } from '../js/audio.js';
import { Player } from '../js/player.js';
import { Exporter, supportedFormats, exportSize, EXPORT_PRESETS } from '../js/exporter.js';
import { sourceTimeAt } from '../js/renderer.js';

const results = [];
window.__results = results;
window.__exports = [];
window.__phase1Done = false;
window.__done = false;
const logEl = document.getElementById('log');

function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
}

function check(name, cond, info = '') {
  results.push({ name, ok: !!cond, info: String(info) });
  log((cond ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  — ' + info : ''), cond ? 'ok' : 'bad');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function once(target, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeout);
    target.addEventListener(type, (e) => { clearTimeout(t); resolve(e); }, { once: true });
  });
}

async function loadMedia(file, type, url0 = './fixtures/' + file) {
  const blob = await (await fetch(url0)).blob();
  const url = URL.createObjectURL(blob);
  let duration = 0, width = 0, height = 0;
  if (type === 'image') {
    const img = new Image();
    img.src = url;
    await img.decode();
    width = img.naturalWidth; height = img.naturalHeight;
  } else {
    const el = document.createElement(type === 'video' ? 'video' : 'audio');
    el.muted = true;
    el.preload = 'metadata';
    el.src = url;
    await once(el, 'loadedmetadata');
    duration = el.duration;
    width = el.videoWidth || 0; height = el.videoHeight || 0;
    el.removeAttribute('src');
  }
  return {
    id: 'media-' + file.replace(/\W/g, '-'), type, name: file, mime: blob.type, blob, url,
    duration, width, height, hasAudio: type !== 'image', thumb: '', filmstrip: [], peaks: null,
  };
}

const stage = document.getElementById('stage');
function frameHash() {
  const ctx = stage.getContext('2d');
  const { width: w, height: h } = stage;
  const d = ctx.getImageData(0, 0, w, h).data;
  let hsh = 0;
  for (let y = 4; y < h; y += 13) {
    for (let x = 4; x < w; x += 17) {
      const i = (y * w + x) * 4;
      hsh = (hsh * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2]) >>> 0;
    }
  }
  return hsh;
}
function pixel(x, y) { // CSS px relative to the canvas → backing pixel
  const k = stage.width / stage.clientWidth;
  const d = stage.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
  return [d[0], d[1], d[2]];
}
// A point inside the movie frame, as fractions of the frame rect.
function framePixel(fx, fy) {
  const r = player.frameRect;
  return pixel(r.x + r.width * fx, r.y + r.height * fy);
}
const isBlack = (p) => p[0] < 12 && p[1] < 12 && p[2] < 12;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function blobDuration(blob) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'metadata';
  v.src = URL.createObjectURL(blob);
  await once(v, 'loadedmetadata', 10000);
  const d = v.duration;
  URL.revokeObjectURL(v.src);
  return d;
}

// ---------------------------------------------------------------------------
// Offline audio scheduling: inject an OfflineAudioContext and read the mix back exactly.

function offlineEngine(seconds, rate = 8000) {
  const off = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate);
  const eng = new AudioEngine();
  eng._ctx = off;
  eng._master = off.createGain();
  eng._speaker = off.createGain();
  eng._master.connect(eng._speaker);
  eng._speaker.connect(off.destination);
  return { off, eng, rate };
}
function putBuffer(eng, id, buf) {
  eng._cache.set(id, { blob: null, url: 'x', buffer: buf, promise: null, failed: false, used: 0, bytes: 0 });
}
function dcBuffer(ctx, seconds, value) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  b.getChannelData(0).fill(value);
  return b;
}
function rampBuffer(ctx, seconds) { // sample value = source time / 4
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = i / ctx.sampleRate / 4;
  return b;
}
const valAt = (buf, t) => buf.getChannelData(0)[Math.round(t * buf.sampleRate)];

async function offlineAudioTests() {
  // 1) Music fades, started in the middle of the fade-in.
  {
    const { off, eng } = offlineEngine(5);
    putBuffer(eng, 'mA', dcBuffer(off, 6, 0.5));
    const project = {
      audioMix: 0, items: [], texts: [],
      music: [createMusicItem({ id: 'mu', mediaId: 'mA', start: 0, trimEnd: 4, fadeIn: 'medium', fadeOut: 'medium', volume: 0.8 })],
    };
    const tl = computeTimeline(project, new Map([['mA', { id: 'mA', type: 'audio', duration: 6 }]]));
    const at = eng.start(project, tl, 0.5);
    const out = await off.startRendering();
    const at0 = (t) => valAt(out, at + (t - 0.5));
    check('audio: start() returns ctx time of fromTime', near(at, 0.08, 1e-6), at);
    check('audio: silent before start time', Math.abs(valAt(out, 0.04)) < 1e-4, valAt(out, 0.04));
    check('audio: starts mid fade-in at exact gain', near(at0(0.5 + 1 / 8000), 0.2, 0.01), at0(0.5));
    check('audio: fade-in completes', near(at0(1.2), 0.4, 0.01), at0(1.2));
    check('audio: fade-out halfway', near(at0(3.5), 0.2, 0.012), at0(3.5));
    check('audio: stops at item end', Math.abs(at0(4.1)) < 1e-3, at0(4.1));
  }
  // 2) Video soundtrack with trim + speed (playbackRate) and audioMix.
  {
    const { off, eng } = offlineEngine(3);
    putBuffer(eng, 'vA', rampBuffer(off, 4));
    const item = createVisualItem('video', { id: 'v1', mediaId: 'vA', trimStart: 1, speed: 2 });
    const project = { audioMix: 0, items: [item], texts: [], music: [] };
    const tl = computeTimeline(project, new Map([['vA', { id: 'vA', type: 'video', duration: 4 }]]));
    const at = eng.start(project, tl, 0.5);
    const out = await off.startRendering();
    check('audio: video offset honours trimStart & speed', near(valAt(out, at + 0.001), (1 + 0.5 * 2) / 4, 0.01), valAt(out, at + 0.001));
    check('audio: playbackRate = speed', near(valAt(out, at + 0.5), (1 + 1.0 * 2) / 4, 0.01), valAt(out, at + 0.5));
    check('audio: video sound ends with its segment', Math.abs(valAt(out, at + 1.05)) < 1e-3, valAt(out, at + 1.05));
  }
  {
    const { off, eng } = offlineEngine(2);
    putBuffer(eng, 'vA', dcBuffer(off, 4, 0.5));
    putBuffer(eng, 'mA', dcBuffer(off, 4, 0.25));
    const project = {
      audioMix: 0.5,
      items: [createVisualItem('video', { id: 'v1', mediaId: 'vA' })], texts: [],
      music: [createMusicItem({ id: 'm1', mediaId: 'mA', start: 0 })],
    };
    const mm = new Map([['vA', { id: 'vA', type: 'video', duration: 4 }], ['mA', { id: 'mA', type: 'audio', duration: 4 }]]);
    const at = eng.start(project, computeTimeline(project, mm), 0);
    const out = await off.startRendering();
    // video gain 0.5, music gain 1 → 0.5*0.5 + 0.25
    check('audio: audioMix balance (mix=0.5)', near(valAt(out, at + 0.5), 0.5, 0.01), valAt(out, at + 0.5));
    const g = mixGains(-1);
    check('audio: mixGains(-1) = video only', g.video === 1 && g.music === 0, JSON.stringify(g));
  }
  // 3) Crossfade under a visual transition + narration ducking.
  {
    const { off, eng } = offlineEngine(6);
    putBuffer(eng, 'a', dcBuffer(off, 4, 0.5));
    putBuffer(eng, 'b', dcBuffer(off, 4, 0.5));
    const project = {
      audioMix: 0, texts: [], music: [],
      items: [
        createVisualItem('video', { id: 'i1', mediaId: 'a' }),
        createVisualItem('video', { id: 'i2', mediaId: 'b', transition: { type: 'crossfade', duration: 1 } }),
      ],
    };
    const mm = new Map([['a', { id: 'a', type: 'video', duration: 4 }], ['b', { id: 'b', type: 'video', duration: 4 }]]);
    const at = eng.start(project, computeTimeline(project, mm), 0);
    const out = await off.startRendering();
    // overlap 3..4: a fades 1→0, b 0→1 → constant sum 0.5
    check('audio: crossfade keeps level across the transition', near(valAt(out, at + 3.5), 0.5, 0.02), valAt(out, at + 3.5));
    check('audio: before transition only first clip', near(valAt(out, at + 2.5), 0.5, 0.01), valAt(out, at + 2.5));
  }
  {
    const { off, eng } = offlineEngine(4);
    putBuffer(eng, 'mus', dcBuffer(off, 4, 0.5));
    putBuffer(eng, 'nar', dcBuffer(off, 4, 0));
    const project = {
      audioMix: 0, items: [], texts: [], emphasize: 'narration',
      music: [
        createMusicItem({ id: 'm1', mediaId: 'mus', start: 0, trimEnd: 3.5 }),
        createMusicItem({ id: 'n1', mediaId: 'nar', kind: 'narration', start: 1, trimEnd: 1 }),
      ],
    };
    const mm = new Map([['mus', { id: 'mus', type: 'audio', duration: 4 }], ['nar', { id: 'nar', type: 'audio', duration: 4 }]]);
    const at = eng.start(project, computeTimeline(project, mm), 0);
    const out = await off.startRendering();
    check('audio: music full before narration', near(valAt(out, at + 0.4), 0.5, 0.01), valAt(out, at + 0.4));
    check('audio: music ducked under narration', near(valAt(out, at + 1.5), 0.15, 0.01), valAt(out, at + 1.5));
    check('audio: music restored after narration', near(valAt(out, at + 2.6), 0.5, 0.01), valAt(out, at + 2.6));
  }
  // 4) A hard cut between two parts of a sound ramps out/in over a few ms (no click), while the
  // pieces of a split stay continuous (no dip at the joint).
  {
    const { off, eng } = offlineEngine(3);
    putBuffer(eng, 'dc', dcBuffer(off, 6, 0.5));
    const project = {
      audioMix: 0, texts: [], music: [],
      items: [
        createVisualItem('video', { id: 'c1', mediaId: 'dc', trimStart: 0, trimEnd: 1 }),
        createVisualItem('video', { id: 'c2', mediaId: 'dc', trimStart: 3, trimEnd: 4 }), // cut at t = 1
        createVisualItem('video', { id: 'c3', mediaId: 'dc', trimStart: 4, trimEnd: 5 }), // split: continues c2 at t = 2
      ],
    };
    const at = eng.start(project, computeTimeline(project, new Map([['dc', { id: 'dc', type: 'video', duration: 6 }]])), 0);
    const out = await off.startRendering();
    const v = (t) => valAt(out, at + t);
    check('audio: hard cut is de-clicked (ramps through silence)', Math.abs(v(1.0)) < 0.06 && near(v(0.99), 0.5, 0.01) && near(v(1.01), 0.5, 0.01),
      [v(0.99), v(1.0), v(1.01)].map((x) => x.toFixed(3)).join(' '));
    check('audio: split pieces stay continuous', near(v(2.0), 0.5, 0.01) && near(v(2.0 - 1 / 8000), 0.5, 0.01) && near(v(2.0 + 1 / 8000), 0.5, 0.01),
      [v(2.0 - 1 / 8000), v(2.0), v(2.0 + 1 / 8000)].map((x) => x.toFixed(3)).join(' '));
  }
  {
    const { off, eng } = offlineEngine(3);
    putBuffer(eng, 'm', dcBuffer(off, 6, 0.5));
    const project = {
      audioMix: 0, items: [], texts: [],
      music: [
        createMusicItem({ id: 'ma', mediaId: 'm', start: 0, trimStart: 1, trimEnd: 2 }),
        createMusicItem({ id: 'mb', mediaId: 'm', start: 1, trimStart: 2, trimEnd: 2.5 }), // Music › Split
      ],
    };
    const at = eng.start(project, computeTimeline(project, new Map([['m', { id: 'm', type: 'audio', duration: 6 }]])), 0);
    const out = await off.startRendering();
    const v = (t) => valAt(out, at + t);
    check('audio: trimmed music starts and ends with a de-click ramp', Math.abs(v(1 / 8000)) < 0.06 && Math.abs(v(1.5 - 1 / 8000)) < 0.06 && near(v(0.02), 0.5, 0.01),
      [v(1 / 8000), v(0.02), v(1.5 - 1 / 8000)].map((x) => x.toFixed(3)).join(' '));
    check('audio: split music stays continuous', near(v(1.0), 0.5, 0.01) && near(v(1.0 - 1 / 8000), 0.5, 0.01), v(1.0).toFixed(3));
  }
}

/** Decoding readiness (whenReady / soundReadyAt) and the budget for sound of removed clips. */
async function decodeReadinessTests() {
  const s3 = new Store();
  const bad = {
    id: 'bad-music', type: 'audio', name: 'broken.ogg', mime: 'audio/ogg', duration: 3, width: 0, height: 0, hasAudio: true,
    blob: new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/ogg' }), thumb: '', filmstrip: [], peaks: null,
  };
  bad.url = URL.createObjectURL(bad.blob);
  for (const m of [M.video, M.music, bad]) s3.addMedia(m);
  s3.update((p) => {
    p.items.push(createVisualItem('video', { mediaId: M.video.id }));
    p.music.push(createMusicItem({ mediaId: M.music.id, start: 0 }), createMusicItem({ mediaId: bad.id, start: 1 }));
  });
  const eng = new AudioEngine();
  const gm = (id) => s3.getMedia(id);
  check('audio: soundReadyAt is false while the sound still has to be decoded', eng.soundReadyAt(s3.project, s3.timeline, 0, { getMedia: gm }) === false);
  const prog = [];
  const res = await eng.whenReady(s3.project, s3, { onProgress: (d, n) => prog.push(d + '/' + n) });
  check('audio: whenReady waits for every soundtrack', res.total === 3 && !res.pending.length && !!eng.peekBuffer(M.video.id) && !!eng.peekBuffer(M.music.id),
    JSON.stringify({ total: res.total, pending: res.pending.length, prog }));
  check("audio: whenReady reports music that can't be decoded", res.failed.length === 1 && res.failed[0].id === bad.id, res.failed.map((m) => m.name).join());
  check('audio: soundReadyAt is true once decoded', eng.soundReadyAt(s3.project, s3.timeline, 0, { getMedia: gm }) === true);
  const stuck = new AudioEngine();
  stuck._decode = () => new Promise(() => {}); // a decode that never finishes
  const r2 = await stuck.whenReady(s3.project, s3, { stallMs: 200 });
  check('audio: whenReady gives up when decoding stalls', r2.pending.length === 3 && r2.done === 0, JSON.stringify({ pending: r2.pending.length, done: r2.done }));

  // Decoded sound of clips the project no longer uses is kept only up to a small budget.
  const eng3 = new AudioEngine();
  eng3._concurrency = 1; // phone budgets
  const s4 = new Store();
  const fake = (id) => ({ id, type: 'audio', name: id, url: 'blob:' + id, blob: null, duration: 10 });
  for (const id of ['r', 'u1', 'u2', 'u3']) s4.addMedia(fake(id));
  s4.update((p) => { p.music.push(createMusicItem({ mediaId: 'r', start: 0 })); });
  let used = 1;
  for (const id of ['r', 'u1', 'u2', 'u3']) {
    eng3._cache.set(id, { blob: null, url: 'blob:' + id, buffer: { length: 1, numberOfChannels: 1, duration: 10 }, promise: null, failed: false, reason: '', used: used++, bytes: 5e6 });
  }
  await eng3.prepare(s4.project, s4);
  const kept = ['r', 'u1', 'u2', 'u3'].filter((id) => eng3._cache.has(id));
  check('audio: sound of removed clips is dropped beyond a small budget (most recent kept)', kept.join() === 'r,u3', kept.join());
}

// ---------------------------------------------------------------------------
// Frame-number fixture (tests/engine-bars.webm, made by engine.test.mjs): 30 fps, the frame
// number as 12 bars in the top half, a 440 Hz tone. Its WebM timestamps are rounded to whole
// ms, so frame k often starts a hair after k/30 s.

/** Frame number shown in a canvas region (x, y, w, h in backing pixels) of a bars frame. */
function readBars(canvas, x, y, w, h) {
  const row = canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y + h / 4), Math.max(1, Math.floor(w)), 1).data;
  let code = 0;
  for (let q = 0; q < 12; q++) if (row[Math.floor(((q + 0.5) * w) / 12) * 4] >= 128) code |= 1 << q;
  return code;
}

async function barsPausedTests() {
  const bars = await loadMedia('engine-bars.webm', 'video', './engine-bars.webm');
  M.bars = bars;
  const s5 = new Store();
  s5.addMedia(bars);
  s5.update((p) => { p.items.push(createVisualItem('video', { id: 'b1', mediaId: bars.id, trimEnd: 4 })); });
  const c5 = document.createElement('canvas');
  c5.style.cssText = 'width:320px;height:180px;display:block';
  document.body.appendChild(c5);
  const p5 = new Player({ store: s5, audio: null, canvas: c5, mediaHost: document.getElementById('media-host') });
  const read = () => {
    const r = p5.frameRect, k = c5.width / c5.clientWidth;
    return readBars(c5, r.x * k, r.y * k, r.width * k, r.height * k);
  };
  await p5.seek(1);
  const seq = [read()];
  for (let i = 0; i < 30; i++) { await p5.stepFrame(1); seq.push(read()); }
  check('player: every "next frame" shows the next frame (ms-rounded WebM)', seq.every((c, i) => c === 30 + i), seq.join(' '));
  await p5.seek(4.1 - 4 + 2.0); // float error: 4.1 - 4 = 0.0999…
  check('player: paused seek lands inside the wanted frame', read() === 63, read());
  const e5 = new Exporter({ store: s5, player: p5, audio: null });
  const snap = await e5.snapshot(59 / 30);
  const bmp = await createImageBitmap(snap);
  const sc = document.createElement('canvas');
  sc.width = bmp.width; sc.height = bmp.height;
  sc.getContext('2d').drawImage(bmp, 0, 0);
  const code = readBars(sc, 0, 0, bmp.width, bmp.height);
  check('snapshot: shows the frame at exactly its time (59/30 s → frame 59)', code === 59, code);
  p5.destroy();
  c5.remove();
}

let store, audio, player, exporter, M;

async function phase1() {
  M = {
    video: await loadMedia('clip1.webm', 'video'),
    photo: await loadMedia('photo1.jpg', 'image'),
    music: await loadMedia('music.ogg', 'audio'),
  };
  store = new Store();
  for (const m of Object.values(M)) store.addMedia(m);
  store.update((p) => {
    p.items.push(createVisualItem('video', { id: 'vid', mediaId: M.video.id }));
    p.items.push(createVisualItem('image', {
      id: 'img', mediaId: M.photo.id, duration: 3, transition: { type: 'crossfade', duration: 1 }, panZoom: 'zoom-in',
    }));
    p.music.push(createMusicItem({ id: 'mus', mediaId: M.music.id, start: 0, trimEnd: 5.5, fadeOut: 'fast' }));
  }, { label: 'setup' });

  audio = new AudioEngine();
  // Decoding: video soundtrack (webm/opus), music (ogg/vorbis), image → null, in-flight dedupe.
  const p1 = audio.getBuffer(M.music);
  const p2 = audio.getBuffer(M.music);
  const vbuf = await audio.getBuffer(M.video);
  check('decode: webm video soundtrack', vbuf && near(vbuf.duration, 4, 0.15), vbuf && vbuf.duration);
  let peak = 0;
  if (vbuf) for (const v of vbuf.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
  check('decode: soundtrack is not silent', peak > 0.05, peak.toFixed(3));
  const [b1, b2] = await Promise.all([p1, p2]);
  check('decode: music (ogg)', b1 && near(b1.duration, 8, 0.1), b1 && b1.duration);
  check('decode: concurrent calls share one decode', b1 && b1 === b2);
  check('decode: cached afterwards', (await audio.getBuffer(M.music)) === b1);
  check('decode: image has no audio', (await audio.getBuffer(M.photo)) === null);
  check('decode: main AudioContext not created before a gesture', audio.contextIfCreated === null);

  await offlineAudioTests();
  await decodeReadinessTests();

  player = new Player({ store, audio, canvas: stage, mediaHost: document.getElementById('media-host') });
  exporter = new Exporter({ store, player, audio });
  window.__engine = { store, audio, player, exporter };

  const dur = store.timeline.duration;
  check('player: duration from timeline', near(player.duration, dur, 1e-9) && near(dur, M.video.duration + 2, 0.05), dur);

  await player.seek(1);
  check('player: seek sets currentTime', near(player.currentTime, 1, 1e-9), player.currentTime);
  const fr = player.frameRect;
  const k = Math.min(window.devicePixelRatio || 1, 2);
  check('player: canvas backing = CSS box × min(dpr, 2)', Math.abs(stage.width - stage.clientWidth * k) <= 1
    && Math.abs(stage.height - stage.clientHeight * k) <= 1, `${stage.width}x${stage.height} for ${stage.clientWidth}x${stage.clientHeight} @${devicePixelRatio}`);
  check('player: frame keeps 16:9 inside the box', near(fr.width / fr.height, 16 / 9, 0.01)
    && (near(fr.height, stage.clientHeight, 1) || near(fr.width, stage.clientWidth, 1)), JSON.stringify(fr));
  const bar = fr.x > 2 ? [pixel(fr.x / 2, stage.clientHeight / 2), pixel(stage.clientWidth - fr.x / 2, stage.clientHeight / 2)]
    : [pixel(stage.clientWidth / 2, fr.y / 2), pixel(stage.clientWidth / 2, stage.clientHeight - fr.y / 2)];
  check('player: letterbox bars are black', isBlack(bar[0]) && isBlack(bar[1]), bar[0]);
  check('player: video frame drawn after seek', !isBlack(framePixel(0.5, 0.33)), framePixel(0.5, 0.33));
  const vEl = document.querySelector('#media-host video');
  check('player: pooled video parked muted/playsinline in mediaHost', vEl && vEl.muted && vEl.playsInline
    && vEl.getAttribute('playsinline') !== null, vEl && vEl.outerHTML.slice(0, 80));
  check('player: video element seeked to source time', vEl && near(vEl.currentTime, 1, 0.01), vEl && vEl.currentTime);
  const h1 = frameHash();
  await player.seek(2);
  const h2 = frameHash();
  check('player: different time → different frame', h1 !== h2);
  await player.seek(2.5);
  const hVideo = frameHash();
  await player.seek(3.5);
  const hMix = frameHash();
  await player.seek(5.5);
  const hPhoto = frameHash();
  check('player: crossfade frame differs from both sides', hMix !== hVideo && hMix !== hPhoto);
  check('player: photo drawn', !isBlack(framePixel(0.5, 0.5)), framePixel(0.5, 0.5));

  // Rapid scrubbing: only the latest seek matters.
  let lastP = null;
  for (let i = 0; i < 30; i++) lastP = player.seek(0.1 + i * 0.1);
  await lastP;
  const hScrub = frameHash();
  check('player: scrub lands on the latest time', near(player.currentTime, 3.0, 1e-9), player.currentTime);
  check('player: scrubbed video at latest target', near(vEl.currentTime, 3.0, 0.01), vEl.currentTime);
  await player.seek(1.5);
  await player.seek(3.0);
  check('player: scrubbed frame equals a direct seek', frameHash() === hScrub);

  await player.seek(1);
  player.stepFrame(1);
  check('player: stepFrame +1 → 1/30 s', near(player.currentTime, 1 + 1 / 30, 1e-6), player.currentTime);
  await player.stepFrame(-1);
  check('player: stepFrame -1', near(player.currentTime, 1, 1e-6), player.currentTime);

  // durationchange on edit, and missing media handled gracefully.
  const dc = once(player, 'durationchange', 2000).then((e) => e.detail.duration, () => null);
  store.update((p) => { p.items[1].duration = 4; });
  const newDur = await dc;
  check('player: durationchange after edit', newDur && near(newDur, dur + 1, 0.01), newDur);
  store.undo();
  await player.renderNow();
  store.update((p) => { p.items.push(createVisualItem('video', { id: 'ghost', mediaId: 'missing-media' })); });
  store.update((p) => { p.items.push(createVisualItem('image', { id: 'ghost2', mediaId: 'missing-photo', duration: 2 })); });
  await player.seek(player.duration - 0.5);
  check('player: missing media draws a placeholder', !isBlack(framePixel(0.5, 0.5)), framePixel(0.5, 0.5));
  store.undo(); store.undo();
  check('player: duration back after undo', near(player.duration, dur, 1e-6), player.duration);

  // Aspect change re-fits the frame; loading a project rewinds.
  store.update((p) => { p.aspect = '9:16'; });
  await player.renderNow();
  const fr2 = player.frameRect;
  check('player: aspect change re-fits the frame', near(fr2.width / fr2.height, 9 / 16, 0.02) && near(fr2.height, stage.clientHeight, 1), JSON.stringify(fr2));
  store.undo();
  await player.renderNow();
  await player.seek(2);
  store.replaceProject(structuredClone(store.project), store.media);
  check('player: loading a project rewinds to 0', player.currentTime === 0 && near(player.duration, dur, 1e-6), player.currentTime);

  // Overlay hook and hidden text ids don't break drawing.
  let overlayCalls = 0;
  player.setOverlayHook((ctx, t, w, h) => { overlayCalls++; ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 4, 4); });
  await player.seek(1);
  const ov = pixel(player.frameRect.x + 2, player.frameRect.y + 1);
  check('player: overlay hook called in frame space', overlayCalls > 0 && ov[0] > 200 && ov[1] < 60, ov);
  player.setOverlayHook(null);

  // Snapshot at export resolution.
  const snap = await exporter.snapshot(1.0);
  const bmp = await createImageBitmap(snap);
  const want = exportSize('recommended', store.project, store.media, { coarse: false });
  check('snapshot: PNG at export resolution', snap.type === 'image/png' && bmp.width === want.width && bmp.height === want.height,
    `${bmp.width}x${bmp.height} (${snap.size} bytes)`);
  const sc = document.createElement('canvas');
  sc.width = bmp.width; sc.height = bmp.height;
  sc.getContext('2d').drawImage(bmp, 0, 0);
  const sp = sc.getContext('2d').getImageData(bmp.width >> 1, bmp.height >> 2, 1, 1).data;
  check('snapshot: has picture content', !isBlack([sp[0], sp[1], sp[2]]), [...sp].slice(0, 3));
  check('snapshot: preview restored', player.output === stage && near(player.currentTime, 1, 1e-6));

  const fm = supportedFormats();
  check('export: supportedFormats lists webm', fm.some((f) => f.ext === 'webm'), JSON.stringify(fm));
  check('export: presets', EXPORT_PRESETS.length === 6 && EXPORT_PRESETS[0].id === 'recommended');
  await barsPausedTests();
  window.__phase1Done = true;
  log('Phase 1 done — click "Run playback tests".');
}

async function phase2() {
  // --- play (inside a click: unlocks audio)
  await player.seek(0);
  const playEv = once(player, 'play', 3000);
  let updates = 0;
  const onTime = () => { updates++; };
  player.addEventListener('timeupdate', onTime);
  const playP = player.play();
  await playEv;
  check('play: playing flag', player.playing);
  await playP;
  check('audio: context running after gesture', audio.context && audio.context.state === 'running', audio.context && audio.context.state);
  check('audio: sources scheduled (video + music)', audio.activeSourceCount >= 2, audio.activeSourceCount);
  const t0 = player.currentTime;
  const hashes = new Set();
  const syncErr = [];
  const startWall = performance.now();
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    hashes.add(frameHash());
    const seg = store.timeline.segments[0];
    const vEl = document.querySelector('#media-host video');
    const t = player.currentTime;
    if (t < seg.end - 0.3 && vEl && !vEl.seeking) syncErr.push(Math.abs(vEl.currentTime - sourceTimeAt(seg, t)));
  }
  const wall = (performance.now() - startWall) / 1000;
  const t1 = player.currentTime;
  check('play: clock advances in real time', near(t1 - t0, wall, 0.35), `${(t1 - t0).toFixed(2)}s in ${wall.toFixed(2)}s (mode ${player._mode})`);
  check('play: frames change while playing', hashes.size >= 6, hashes.size);
  check('play: timeupdate events', updates > 30, updates);
  const maxErr = Math.max(...syncErr);
  check('play: video element follows the clock', syncErr.length > 3 && maxErr < 0.3, maxErr.toFixed(3));

  // --- edits during playback (mix change = live, volume change = reschedule)
  store.update((p) => { p.audioMix = 0.4; }, { coalesceKey: 'mix' });
  await sleep(100);
  store.update((p) => { p.items[0].volume = 0.5; });
  await sleep(400);
  check('play: still playing after edits', player.playing && player.currentTime > t1, player.currentTime);
  check('audio: rescheduled after edit', audio.activeSourceCount >= 1, audio.activeSourceCount);
  store.undo(); store.undo();

  // --- dragging the seek bar while playing: coalesced, silent while dragging, sound comes back
  for (let i = 0; i < 20; i++) { player.seek(0.5 + i * 0.05); await sleep(15); }
  const dragEnd = performance.now();
  check('seek while playing: currentTime follows immediately', near(player.currentTime, 1.45, 0.1), player.currentTime);
  await sleep(450);
  const expect = 1.45 + (performance.now() - dragEnd) / 1000;
  check('seek while playing: continues from the last seek', player.playing && near(player.currentTime, expect, 0.3),
    `${player.currentTime.toFixed(2)} vs ~${expect.toFixed(2)}`);
  check('seek while playing: sound back on the audio clock', player._mode === 'audio' && audio.activeSourceCount >= 1,
    `${player._mode} / ${audio.activeSourceCount}`);

  // --- pause
  const pauseEv = once(player, 'pause', 2000);
  player.pause();
  await pauseEv;
  const tp = player.currentTime;
  await sleep(300);
  check('pause: time stays put', player.currentTime === tp && !player.playing, tp);
  check('pause: videos paused', [...document.querySelectorAll('#media-host video')].every((v) => v.paused));
  check('pause: audio stopped', audio.activeSourceCount === 0);

  // --- ended, then play restarts from 0
  await player.seek(player.duration - 0.6);
  const endedEv = once(player, 'ended', 5000).then(() => true, () => false);
  await player.play();
  const ended = await endedEv;
  check('ended: fired at the end', ended && !player.playing && player.currentTime === player.duration, player.currentTime);
  await player.play();
  await sleep(300);
  check('ended: play() again restarts from 0', player.playing && player.currentTime < 0.8, player.currentTime);
  player.pause();

  // --- loop range (trim preview)
  player.loopRange = { start: 1, end: 1.6 };
  await player.seek(1);
  await player.play();
  const loopTimes = [];
  for (let i = 0; i < 12; i++) { await sleep(120); loopTimes.push(player.currentTime); }
  player.pause();
  player.loopRange = null;
  check('loop: time stays inside the loop range', loopTimes.every((t) => t >= 1 - 1e-6 && t <= 1.66), loopTimes.map((t) => t.toFixed(2)).join(' '));
  check('loop: it actually wrapped', loopTimes.some((t, i) => i > 0 && t < loopTimes[i - 1]));
  player.removeEventListener('timeupdate', onTime);

  // --- export (webm in Chromium)
  await player.seek(2);
  const fmt = supportedFormats().find((f) => f.ext === 'webm');
  const prog = [];
  const tExp = performance.now();
  let blob = null;
  try {
    blob = await exporter.exportMovie({ presetId: 'email', mime: fmt.mime, fps: 30, onProgress: (p, t, info) => prog.push([p, t, info && info.state]) });
  } catch (err) {
    check('export: completes', false, err && (err.message + ' ' + (err.cause ? err.cause : '')));
  }
  if (blob) {
    const secs = (performance.now() - tExp) / 1000;
    check('export: non-empty blob', blob.size > 10000, blob.size + ' bytes, ' + blob.type + ', took ' + secs.toFixed(1) + 's');
    check('export: progress reported', prog.length > 20 && prog[prog.length - 1][0] === 1 && prog.some((x) => x[2] === 'recording'),
      prog.length);
    const monotone = prog.filter((x) => x[2] === 'recording').every((x, i, a) => i === 0 || x[0] >= a[i - 1][0] - 1e-9);
    check('export: progress is monotonic', monotone);
    let d = NaN;
    try { d = await blobDuration(blob); } catch (_) { /* ignore */ }
    check('export: browser reads a finite duration (EBML patch)', Number.isFinite(d) && near(d, store.timeline.duration, 0.6), d);
    window.__exports.push({ name: 'export-email.webm', type: blob.type, b64: await blobToBase64(blob), expect: store.timeline.duration });
  }
  check('export: player restored (output, time)', player.output === stage && near(player.currentTime, 2, 1e-6) && !player.playing,
    player.currentTime);
  check('export: speakers unmuted again', audio.outputMuted === false);

  // --- export while the tab goes to the background (recorder pause/resume). While hidden the
  // audio context gets suspended and refuses to resume without a tap (as on iOS): the exporter
  // must ask for a tap ('waiting') and carry on once sound runs again.
  const states = [];
  let hiddenBlob = null;
  const setHidden = (h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const expP = exporter.exportMovie({ presetId: 'email', mime: fmt.mime, fps: 24, onProgress: (p, t, info) => states.push(info.state) });
  await sleep(2000);
  setHidden(true);
  await sleep(300);
  const actx = audio.context;
  await actx.suspend();
  const realResume = actx.resume;
  actx.resume = () => Promise.resolve(); // no gesture → no sound
  await sleep(900);
  const pausedWhileHidden = !player.playing;
  setHidden(false);
  delete document.hidden; delete document.visibilityState;
  await sleep(1800);
  const waited = states.includes('waiting') && !player.playing;
  actx.resume = realResume;
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // the "tap"
  try { hiddenBlob = await expP; } catch (err) { check('export (hidden): completes', false, err.message); }
  check('export (hidden): paused while hidden and reported', pausedWhileHidden && states.includes('hidden') && states.includes('resumed'),
    [...new Set(states)].join(','));
  check('export (hidden): waits for a tap when sound is suspended', waited && actx.state === 'running', actx.state);
  if (hiddenBlob) {
    window.__exports.push({ name: 'export-hidden.webm', type: hiddenBlob.type, b64: await blobToBase64(hiddenBlob), expect: store.timeline.duration });
  }

  // --- A/V sync: a clip with flashes + beeps at 1.0 s and 2.5 s (checked with ffmpeg by the runner)
  {
    const blobS = await (await fetch('./engine-sync.webm')).blob();
    const media = { id: 'sync', type: 'video', name: 'sync.webm', mime: 'video/webm', blob: blobS, url: URL.createObjectURL(blobS),
      duration: 4, width: 320, height: 180, hasAudio: true, thumb: '', filmstrip: [], peaks: null };
    const s2 = new Store();
    s2.addMedia(media);
    s2.update((p) => { p.items.push(createVisualItem('video', { mediaId: 'sync' })); });
    const off = document.createElement('canvas');
    const p2 = new Player({ store: s2, audio, canvas: off, mediaHost: document.getElementById('media-host') });
    const e2 = new Exporter({ store: s2, player: p2, audio });
    try {
      const b = await e2.exportMovie({ presetId: 'wide480', fps: 30 });
      window.__exports.push({ name: 'export-sync.webm', b64: await blobToBase64(b), expect: s2.timeline.duration, sync: true, size: [854, 480] });
      check('export (sync clip): done', b.size > 1000, b.size);
    } catch (err) {
      check('export (sync clip): done', false, err.message);
    }
    p2.destroy();
  }

  // --- iOS before 16.4 (no navigator.audioSession): Web Audio alone is muted by the Ring/Silent
  // switch, so unlock() starts a silent, unmuted, looping <audio> and stops it after playback.
  if (!navigator.audioSession) {
    const uaDesc = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true, get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
    });
    const ios = new AudioEngine();
    try {
      check('audio (iOS 15): needs the media-session keeper', ios.needsSessionKeeper === true);
      await ios.unlock();
      await sleep(200);
      const k1 = ios.sessionKeeper;
      check('audio (iOS 15): unlock starts a silent unmuted media element', k1.active && k1.playing && !k1.muted, JSON.stringify(k1));
      const proj = { audioMix: 0, items: [], texts: [], music: [] };
      ios.start(proj, computeTimeline(proj, new Map()), 0);
      ios.stop();
      await sleep(400);
      check('audio (iOS 15): keeper still playing right after stop (quick restarts)', ios.sessionKeeper.playing);
      await sleep(1600);
      check('audio (iOS 15): keeper paused once playback has stopped', !ios.sessionKeeper.playing, JSON.stringify(ios.sessionKeeper));
    } finally {
      await ios.close();
      if (uaDesc) Object.defineProperty(navigator, 'userAgent', uaDesc); else delete navigator.userAgent;
    }
    check('audio (iOS 15): not used elsewhere', new AudioEngine().needsSessionKeeper === false);
  }

  // --- clips cut from the frame-number fixture: the pieces of a split share one <video> and
  // play on smoothly; clips start exactly on their in-point frame and never show trimmed-out
  // frames; the export waits for slow decoding (sound from the very start) and warns about
  // music it can't read.
  {
    const bars = { ...M.bars, id: 'bars-export' };
    const broken = {
      id: 'broken-music', type: 'audio', name: 'broken.ogg', mime: 'audio/ogg', duration: 3, width: 0, height: 0, hasAudio: true,
      blob: new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/ogg' }), thumb: '', filmstrip: [], peaks: null,
    };
    broken.url = URL.createObjectURL(broken.blob);
    const s6 = new Store();
    s6.addMedia(bars);
    s6.addMedia(broken);
    const clip = (id, a, b) => createVisualItem('video', { id, mediaId: bars.id, trimStart: a, trimEnd: b, transition: { type: 'none', duration: 0 } });
    s6.update((p) => {
      p.items.push(createVisualItem('title', { id: 'T', duration: 1, background: '#000000', text: '', transition: { type: 'none', duration: 0 } }),
        clip('A1', 1.0, 1.6), clip('A2', 1.6, 2.2), clip('A3', 2.2, 2.8), // a split clip
        clip('B', 59 / 30, 59 / 30 + 0.6), clip('C', 116 / 30, 116 / 30 + 0.6), clip('D', 0.5, 1.1));
      p.music.push(createMusicItem({ mediaId: broken.id, start: 0 }));
    });
    const realDecode = audio._decode;
    audio._decode = async (m) => { if (m.id === bars.id) await sleep(1500); return realDecode.call(audio, m); }; // a slow phone decode
    const off6 = document.createElement('canvas');
    const p6 = new Player({ store: s6, audio, canvas: off6, mediaHost: document.getElementById('media-host') });
    const e6 = new Exporter({ store: s6, player: p6, audio });
    const states = [];
    try {
      const b = await e6.exportMovie({ presetId: 'email', fps: 30, onProgress: (pp, t, info) => states.push(info.state + (info.message ? ':' + info.message : '')) });
      const tl = s6.timeline.segments;
      const segs = tl.filter((sg) => sg.item.kind === 'video').map((sg) => ({
        start: sg.start, end: sg.end, sIn: sg.sourceIn, sOut: sg.sourceOut,
        chainedIn: sg.item.id === 'A2' || sg.item.id === 'A3', chainedOut: sg.item.id === 'A1' || sg.item.id === 'A2',
      }));
      const mid = (id) => { const sg = tl.find((x) => x.item.id === id); return (sg.start + sg.end) / 2; };
      window.__exports.push({ name: 'export-bars.webm', b64: await blobToBase64(b), expect: s6.timeline.duration, soundFrom: tl[1].start,
        bars: { segs, splits: [tl[2].start, tl[3].start], controls: [mid('A1'), mid('A2'), mid('A3')] } });
      const vids = [...document.querySelectorAll('#media-host video')].filter((v) => v.src === bars.url).length;
      check('export (bars): the pieces of a split share one <video>', vids === 4, vids + ' elements for 6 clips (3 of them one split clip)');
      check('export (bars): waits for slow decoding and says so', states.some((x) => x.startsWith('preparing:Preparing the sound')), [...new Set(states.map((x) => x.split(':')[0]))].join(','));
      check("export (bars): warns about music it can't read", states.some((x) => x.startsWith('warning:') && x.includes('broken.ogg')), states.filter((x) => x.startsWith('warning')).join(' | '));
    } catch (err) {
      check('export (bars): done', false, err.message);
    } finally {
      audio._decode = realDecode;
      p6.destroy();
    }
  }

  // --- abort
  const ac = new AbortController();
  const abortP = exporter.exportMovie({ presetId: 'email', fps: 30, signal: ac.signal });
  setTimeout(() => ac.abort(), 700);
  let abortErr = null;
  try { await abortP; } catch (err) { abortErr = err; }
  check('export: abort rejects with AbortError', abortErr && abortErr.name === 'AbortError', abortErr && abortErr.message);
  check('export: not busy after abort, player restored', !exporter.busy && player.output === stage && !player.playing);

  // --- a 9:16 project exports with even portrait dims
  const sz = exportSize('hd720', { aspect: '9:16', items: [] }, new Map(), { coarse: false });
  check('export: portrait size', sz.width === 720 && sz.height === 1280, JSON.stringify(sz));
  const szc = exportSize('hd1080', { aspect: '16:9', items: [] }, new Map(), { coarse: true });
  const szc2 = exportSize('recommended', { aspect: '4:3', items: [] }, new Map(), { coarse: true });
  check('export: phone cap unless 1080 chosen', szc.height === 1080 && szc2.height === 720 && szc2.width % 2 === 0, JSON.stringify([szc, szc2]));

  window.__done = true;
  const failed = results.filter((r) => !r.ok).length;
  log(`Done: ${results.length - failed} passed, ${failed} failed`, failed ? 'bad' : 'ok');
}

phase1().catch((err) => {
  check('phase 1 crashed', false, err && (err.stack || err.message));
  window.__phase1Done = true;
  window.__done = true;
});
document.getElementById('go').addEventListener('click', () => {
  phase2().catch((err) => {
    check('phase 2 crashed', false, err && (err.stack || err.message));
    window.__done = true;
  });
});
