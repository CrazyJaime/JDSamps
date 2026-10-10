// Feature-fallback tests for the engine: each scenario removes a browser feature the engine
// feature-detects (requestFrame, Web Audio, MediaRecorder, getOutputTimestamp,
// ResizeObserver, a running AudioContext) and checks that playback/export still behave.
// Loaded by tests/engine-fallbacks.html, driven by tests/engine.test.mjs.

import { Store } from '../js/store.js';
import { createVisualItem, createMusicItem } from '../js/model.js';
import { AudioEngine } from '../js/audio.js';
import { Player } from '../js/player.js';
import { Exporter, supportedFormats } from '../js/exporter.js';

const results = [];
window.__results = results;
window.__exports = [];
window.__phase1Done = false;
window.__done = false;
const logEl = document.getElementById('log');
function check(name, cond, info = '') {
  results.push({ name, ok: !!cond, info: String(info) });
  const line = document.createElement('div');
  line.className = cond ? 'ok' : 'bad';
  line.textContent = (cond ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  — ' + info : '');
  logEl.appendChild(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function once(target, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeout);
    target.addEventListener(type, (e) => { clearTimeout(t); resolve(e); }, { once: true });
  });
}
async function loadMedia(file, type) {
  const blob = await (await fetch('./fixtures/' + file)).blob();
  const url = URL.createObjectURL(blob);
  let duration = 0, width = 0, height = 0;
  if (type === 'image') {
    const img = new Image(); img.src = url; await img.decode();
    width = img.naturalWidth; height = img.naturalHeight;
  } else {
    const el = document.createElement(type === 'video' ? 'video' : 'audio');
    el.muted = true; el.preload = 'metadata'; el.src = url;
    await once(el, 'loadedmetadata');
    duration = el.duration; width = el.videoWidth || 0; height = el.videoHeight || 0;
  }
  return { id: 'media-' + file.replace(/\W/g, '-'), type, name: file, mime: blob.type, blob, url, duration, width, height,
    hasAudio: type !== 'image', thumb: '', filmstrip: [], peaks: null };
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

const stage = document.getElementById('stage');
let M;
function makeStore() {
  const store = new Store();
  for (const m of Object.values(M)) store.addMedia(m);
  store.update((p) => {
    p.items.push(createVisualItem('video', { mediaId: M.video.id, trimEnd: 2.5 }));
    p.items.push(createVisualItem('image', { mediaId: M.photo.id, duration: 1.5, transition: { type: 'wipe-left', duration: 0.5 } }));
    p.music.push(createMusicItem({ mediaId: M.music.id, start: 0, trimEnd: 3.5 }));
  });
  return store;
}
function setup(audioEngine) {
  const store = makeStore();
  const audio = audioEngine || new AudioEngine();
  const player = new Player({ store, audio, canvas: stage, mediaHost: document.getElementById('media-host') });
  const exporter = new Exporter({ store, player, audio });
  return { store, audio, player, exporter };
}
function teardown(env) {
  try { env.player.destroy(); } catch (_) { /* ignore */ }
  try { if (env.audio && env.audio.close) env.audio.close(); } catch (_) { /* ignore */ }
}
function stash(obj, key, value) {
  const had = Object.prototype.hasOwnProperty.call(obj, key);
  const old = obj[key];
  try { obj[key] = value; } catch (_) { Object.defineProperty(obj, key, { configurable: true, writable: true, value }); }
  return () => { if (had) obj[key] = old; else delete obj[key]; };
}

async function phase1() {
  M = {
    video: await loadMedia('clip1.webm', 'video'),
    photo: await loadMedia('photo1.jpg', 'image'),
    music: await loadMedia('music.ogg', 'audio'),
  };

  // No MediaRecorder: friendly error, no formats.
  {
    const restore = stash(window, 'MediaRecorder', undefined);
    const env = setup();
    let err = null;
    try { await env.exporter.exportMovie({ presetId: 'email' }); } catch (e) { err = e; }
    check('no MediaRecorder: friendly error', err && err.friendly && err.code === 'no-mediarecorder', err && err.message);
    check('no MediaRecorder: no formats', supportedFormats().length === 0);
    check('no MediaRecorder: exporter not left busy', !env.exporter.busy);
    teardown(env);
    restore();
  }

  // Empty project: friendly error.
  {
    const store = new Store();
    const player = new Player({ store, audio: null, canvas: stage, mediaHost: document.getElementById('media-host') });
    const ex = new Exporter({ store, player, audio: null });
    let err = null;
    try { await ex.exportMovie({ presetId: 'email' }); } catch (e) { err = e; }
    check('empty project: friendly error', err && err.code === 'empty', err && err.message);
    let err2 = null;
    try { await ex.snapshot(0); } catch (e) { err2 = e; }
    check('empty project: snapshot friendly error', err2 && err2.code === 'empty', err2 && err2.message);
    await player.play();
    check('empty project: play() is a no-op', !player.playing);
    player.destroy();
  }

  // No ResizeObserver: window resize fallback keeps the backing store in sync.
  {
    const restore = stash(window, 'ResizeObserver', undefined);
    const env = setup(new AudioEngine());
    await env.player.seek(1);
    const w0 = stage.width;
    stage.style.width = '320px';
    window.dispatchEvent(new Event('resize'));
    await env.player.renderNow();
    check('no ResizeObserver: resize via window event', stage.width !== w0 && Math.abs(stage.width - stage.clientWidth * Math.min(devicePixelRatio, 2)) <= 1,
      `${w0} → ${stage.width}`);
    stage.style.width = '';
    window.dispatchEvent(new Event('resize'));
    teardown(env);
    restore();
  }
  // A canvas the page doesn't size (CSS only says max-width/max-height, like the shell's
  // .pv-canvas): the player must size it to the project aspect inside its parent.
  {
    const box = document.createElement('div');
    box.style.cssText = 'width:600px;height:400px;display:flex;align-items:center;justify-content:center;background:#222;';
    const cv = document.createElement('canvas');
    cv.style.cssText = 'display:block;max-width:100%;max-height:100%;';
    box.appendChild(cv);
    document.body.appendChild(box);
    const store = makeStore();
    const player = new Player({ store, audio: null, canvas: cv, mediaHost: document.getElementById('media-host') });
    await player.seek(1);
    const k = Math.min(devicePixelRatio, 2);
    check('unsized canvas: fitted to 16:9 in its parent', cv.clientWidth === 600 && cv.clientHeight === 337
      && Math.abs(cv.width - 600 * k) <= 1, `${cv.clientWidth}x${cv.clientHeight} css, ${cv.width}x${cv.height} px`);
    store.update((p) => { p.aspect = '9:16'; });
    await player.renderNow();
    check('unsized canvas: refits on aspect change', cv.clientHeight === 400 && cv.clientWidth === 225, `${cv.clientWidth}x${cv.clientHeight}`);
    box.style.width = '300px';
    await sleep(100);
    await player.renderNow();
    store.update((p) => { p.aspect = '16:9'; });
    await player.renderNow();
    check('unsized canvas: follows parent resize', cv.clientWidth === 300 && cv.clientHeight === 168, `${cv.clientWidth}x${cv.clientHeight}`);
    const fr = player.frameRect;
    check('unsized canvas: no letterbox inside', fr.x === 0 && fr.y === 0, JSON.stringify(fr));
    // Page takes over sizing → the player stops touching the style.
    cv.style.width = '200px';
    cv.style.height = '100px';
    box.style.width = '500px';
    await sleep(100);
    check('unsized canvas: page can take over sizing', cv.style.width === '200px' && cv.clientWidth === 200, cv.style.width);
    player.destroy();
    box.remove();
  }
  window.__phase1Done = true;
}

async function phase2() {
  // No CanvasCaptureMediaStreamTrack.requestFrame → captureStream(fps).
  {
    const proto = window.CanvasCaptureMediaStreamTrack && window.CanvasCaptureMediaStreamTrack.prototype;
    const restore = proto ? stash(proto, 'requestFrame', undefined) : () => {};
    const env = setup();
    let blob = null;
    try { blob = await env.exporter.exportMovie({ presetId: 'email', fps: 30 }); } catch (e) { check('captureStream(fps): export', false, e.message); }
    check('captureStream(fps): export works', blob && blob.size > 5000, blob && blob.size);
    if (blob) window.__exports.push({ name: 'fallback-fps.webm', b64: await blobToBase64(blob), expect: env.store.timeline.duration, audio: true });
    teardown(env);
    restore();
  }

  // No getOutputTimestamp: audio clock from currentTime − outputLatency.
  {
    const P = window.AudioContext && window.AudioContext.prototype;
    const restore = P ? stash(P, 'getOutputTimestamp', undefined) : () => {};
    const env = setup();
    check('cold cache: nothing decoded before play', env.audio.peekBuffer(M.music.id) === null && env.audio.peekBuffer(M.video.id) === null);
    await env.player.play();
    const t0 = env.player.currentTime, w0 = performance.now();
    await sleep(800);
    const adv = env.player.currentTime - t0, wall = (performance.now() - w0) / 1000;
    check('no getOutputTimestamp: plays on the audio clock', env.player._mode === 'audio' && near(adv, wall, 0.2), `${env.player._mode} ${adv.toFixed(2)}/${wall.toFixed(2)}`);
    // Fresh engine: nothing was decoded when play() started, sounds join as decoding finishes.
    check('cold cache: late-decoded sounds join playback', env.audio.activeSourceCount >= 2, env.audio.activeSourceCount);
    env.player.pause();
    teardown(env);
    restore();
  }

  // No Web Audio at all: wall clock playback, silent (video-only) export with a warning.
  {
    const r1 = stash(window, 'AudioContext', undefined);
    const r2 = stash(window, 'webkitAudioContext', undefined);
    const r3 = stash(window, 'OfflineAudioContext', undefined);
    const env = setup(new AudioEngine());
    check('no Web Audio: context is null', env.audio.context === null);
    check('no Web Audio: getBuffer → null', (await env.audio.getBuffer(M.music)) === null);
    await env.player.play();
    const t0 = env.player.currentTime;
    await sleep(600);
    check('no Web Audio: plays on the wall clock', env.player.playing && env.player._mode === 'perf' && env.player.currentTime - t0 > 0.4,
      env.player.currentTime - t0);
    env.player.pause();
    const states = [];
    let blob = null;
    try {
      blob = await env.exporter.exportMovie({ presetId: 'email', fps: 30, onProgress: (p, t, info) => states.push(info.state) });
    } catch (e) { check('no Web Audio: export', false, e.message); }
    check('no Web Audio: export works with a warning', blob && blob.size > 5000 && states.includes('warning'), [...new Set(states)].join(','));
    if (blob) window.__exports.push({ name: 'fallback-noaudio.webm', b64: await blobToBase64(blob), expect: env.store.timeline.duration, audio: false });
    teardown(env);
    r3(); r2(); r1();
  }

  // Video whose media says it has no soundtrack: never decoded, plays fine.
  {
    const env = setup();
    const silent = { ...M.video, id: 'silent-video', hasAudio: false };
    env.store.addMedia(silent);
    env.store.update((p) => { p.items.unshift(createVisualItem('video', { mediaId: silent.id, trimEnd: 1 })); });
    check('hasAudio=false: no decode', (await env.audio.getBuffer(silent)) === null);
    await env.player.play();
    await sleep(500);
    check('hasAudio=false: still plays', env.player.playing && env.player.currentTime > 0.3, env.player.currentTime);
    env.player.pause();
    teardown(env);
  }

  // Interrupted audio (phone call) pauses preview playback.
  {
    const env = setup();
    await env.player.play();
    await sleep(300);
    const pauseEv = once(env.player, 'pause', 3000).then(() => true, () => false);
    await env.audio.context.suspend();
    check('audio interrupted: preview pauses', await pauseEv);
    teardown(env);
  }

  window.__done = true;
}

phase1().catch((err) => { check('phase 1 crashed', false, err && (err.stack || err.message)); window.__phase1Done = true; window.__done = true; });
document.getElementById('go').addEventListener('click', () => {
  phase2().catch((err) => { check('phase 2 crashed', false, err && (err.stack || err.message)); window.__done = true; });
});
