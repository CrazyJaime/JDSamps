// Node tests for js/commands.js and js/automovie.js (owner G), against the real model/store/catalog
// and a fake app (player, dialogs, media, persist, audio, exporter, preview).
// Run: node /home/user/JDSamps/moviemaker/tests/commands.test.mjs
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import { Store } from '../js/store.js';
import * as catalog from '../js/catalog.js';
import { createCommands } from '../js/commands.js';
import { applyAutoMovie, fitVisualsToMusic, resolveTheme } from '../js/automovie.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err}`);
  }
}
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => new Promise((r) => setTimeout(r, 0));

// A tiny localStorage for the option fallback.
const lsData = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
  setItem: (k, v) => lsData.set(k, String(v)),
  removeItem: (k) => lsData.delete(k),
};

// ---------------------------------------------------------------- fake app

let mediaSeq = 0;
/** File whose name selects what the fake importer produces: "<type>-<duration>[-noaudio][-bad].ext" */
function file(name, type = 'application/octet-stream') { return new File([new Uint8Array([1, 2, 3])], name, { type }); }

function fakeMedia(type, duration, extra = {}) {
  mediaSeq++;
  return {
    id: `media-${mediaSeq}`,
    type,
    name: extra.name || `${type}${mediaSeq}`,
    mime: type === 'image' ? 'image/png' : type === 'audio' ? 'audio/ogg' : 'video/webm',
    blob: new Blob([new Uint8Array(4)]),
    url: `blob:fake-${mediaSeq}`,
    duration: type === 'image' ? 0 : duration,
    width: 640, height: 360,
    hasAudio: extra.hasAudio !== undefined ? extra.hasAudio : type !== 'image',
    thumb: '', filmstrip: [],
    peaks: extra.peaks !== undefined ? extra.peaks : null,
  };
}

function makeApp() {
  const log = { toasts: [], progress: [], picks: [], prepare: 0, peaks: [], editText: [], trim: [], exportOpen: [], saved: [], lastId: [], confirms: [], prompts: [], revoked: [], openProjects: 0, about: 0, help: 0 };
  const store = new Store();
  const player = {
    currentTime: 0,
    playing: false,
    calls: [],
    get duration() { return store.timeline.duration; },
    play() { this.calls.push('play'); this.playing = true; return Promise.resolve(); },
    pause() { this.calls.push('pause'); this.playing = false; },
    toggle() { this.calls.push('toggle'); this.playing = !this.playing; return Promise.resolve(); },
    seek(t) { this.calls.push(['seek', t]); this.currentTime = t; return Promise.resolve(); },
    stepFrame(d) { this.calls.push(['step', d]); this.currentTime = Math.max(0, this.currentTime + d / 30); return Promise.resolve(); },
  };
  const dialogs = {
    trimActive: false,
    confirmAnswer: true,
    promptAnswer: 'Copy name',
    webcamFile: null,
    narrationFile: null,
    toast(msg, opts = {}) { log.toasts.push({ msg, type: opts.type || 'info' }); return { close() {} }; },
    progress(title, opts) {
      const ctl = new AbortController();
      const entry = { title, opts, sets: [], closed: false, ctl };
      log.progress.push(entry);
      return { set(p, t) { entry.sets.push([p, t]); }, close() { entry.closed = true; }, get signal() { return ctl.signal; } };
    },
    confirm(msg) { log.confirms.push(msg); return Promise.resolve(this.confirmAnswer); },
    promptText(title, value) { log.prompts.push([title, value]); return Promise.resolve(this.promptAnswer); },
    openWebcam() { return Promise.resolve(this.webcamFile); },
    openNarration() { return Promise.resolve(this.narrationFile); },
    openTrim(id) { log.trim.push(id); return Promise.resolve(true); },
    openExport(id) { log.exportOpen.push(id); return Promise.resolve(); },
    openProjects() { log.openProjects++; return Promise.resolve(); },
    openAbout() { log.about++; },
    openHelp() { log.help++; },
  };
  const media = {
    ACCEPT_VISUAL: 'video/*,image/*',
    ACCEPT_AUDIO: 'audio/*,video/*',
    pickResult: [],
    pickFiles(accept, multiple) { log.picks.push([accept, multiple]); return Promise.resolve(this.pickResult); },
    async importFiles(files, opts = {}) {
      const out = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const parts = f.name.replace(/\.[a-z0-9]+$/i, '').split('-');
        if (parts.includes('bad')) {
          const err = new Error(`"${f.name}" isn't a video, photo or music file that Movie Maker can use.`);
          err.friendly = true;
          opts.onError && opts.onError(f, err);
          continue;
        }
        let kind = parts[0];
        if (!['video', 'image', 'audio'].includes(kind)) kind = (f.type || 'image/png').split('/')[0];
        const m = fakeMedia(kind, Number(parts[1]) || 0, {
          name: f.name, hasAudio: parts.includes('noaudio') ? false : undefined, peaks: parts.includes('nopeaks') ? null : [0.5, 0.25],
        });
        if (kind === 'image') m.peaks = null;
        out.push(m);
        opts.onProgress && opts.onProgress((i + 1) / files.length, 'Importing');
      }
      return out;
    },
    computePeaks(m) { log.peaks.push(m.id); m.peaks = [0.1, 0.2, 0.3]; return Promise.resolve(m.peaks); },
    revokeMedia(m) { log.revoked.push(m.id); },
  };
  const persist = {
    async saveProject(p, map) { log.saved.push({ id: p.id, name: p.name, media: map && map.size }); },
    async setLastProjectId(id) { log.lastId.push(id); },
    async exportProjectFile(p) { log.exported = (log.exported || 0) + 1; return new Blob([JSON.stringify(p)], { type: 'application/json' }); },
    projectFileName(p) { return `${p.name}.wlmmweb`; },
    async importProjectFile() { return { project: M.createProject('Imported one'), media: new Map() }; },
  };
  const audio = { prepare() { log.prepare++; return Promise.resolve(); } };
  const exporter = { async snapshot() { return new Blob([new Uint8Array([137, 80])], { type: 'image/png' }); } };
  const preview = { editText(id) { log.editText.push(id); return true; } };
  const app = { store, player, dialogs, media, persist, audio, exporter, preview, options: {}, exporting: false };
  app.commands = createCommands(app);
  return { app, store, player, dialogs, media, persist, log, cmd: app.commands };
}

/** Add a media record + visual item directly (bypassing commands). */
function addVisual(store, kind, props = {}, mediaDuration = 10) {
  let mediaId = null;
  if (kind !== 'title') {
    const m = fakeMedia(kind === 'video' ? 'video' : 'image', mediaDuration);
    store.addMedia(m);
    mediaId = m.id;
  }
  const it = M.createVisualItem(kind, { ...props, mediaId });
  store.update((p) => { p.items.push(it); }, { label: 'setup' });
  return it;
}
function addMusicItem(store, start, duration, props = {}) {
  const m = fakeMedia('audio', duration);
  store.addMedia(m);
  const it = M.createMusicItem({ mediaId: m.id, start, ...props });
  store.update((p) => { p.music.push(it); }, { label: 'setup' });
  return it;
}
const undoCount = (store) => store._undo.length;

// ---------------------------------------------------------------- the contract

const CONTRACT = [
  'addMedia', 'addMusic', 'addMusicAtPlayhead', 'webcam', 'narration', 'snapshot', 'addTitle', 'addCaption',
  'addCredits', 'autoMovie', 'cut', 'copy', 'paste', 'remove', 'selectAll', 'rotateLeft', 'rotateRight',
  'moveItem', 'moveText', 'moveMusic', 'setTransition', 'setTransitionDuration', 'applyTransitionAll',
  'setPanZoom', 'applyPanZoomAll', 'setEffect', 'applyEffectAll', 'setBrightness', 'setAspect', 'setAudioMix',
  'emphasize', 'fitToMusic', 'zoomIn', 'zoomOut', 'setThumbSize', 'toggleWaveforms', 'setPreviewSize',
  'setVolume', 'setFadeIn', 'setFadeOut', 'setSpeed', 'setDuration', 'split', 'trimTool', 'setStartPoint',
  'setEndPoint', 'setBackground', 'musicVolume', 'musicFadeIn', 'musicFadeOut', 'musicStartTime',
  'musicSetStartPoint', 'musicSetEndPoint', 'musicSplit', 'textSet', 'textEdit', 'textDuration',
  'textStartTime', 'textEffect', 'undo', 'redo', 'play', 'pause', 'togglePlay', 'seek', 'prevFrame',
  'nextFrame', 'goStart', 'goEnd', 'prevItem', 'nextItem', 'newProject', 'openProject', 'saveProject',
  'saveProjectAs', 'importProjectFile', 'exportProjectFile', 'saveMovie', 'about', 'help',
];

await test('list() covers every command of the contract table', () => {
  const { cmd } = makeApp();
  const names = cmd.list();
  for (const n of CONTRACT) assert.ok(names.includes(n), `missing ${n}`);
  assert.equal(typeof cmd.run, 'function');
  assert.equal(typeof cmd.isEnabled, 'function');
  assert.equal(typeof cmd.isChecked, 'function');
});

await test('unknown command warns and returns undefined', () => {
  const { cmd } = makeApp();
  const warn = console.warn;
  let warned = '';
  console.warn = (m) => { warned = String(m); };
  try {
    assert.equal(cmd.run('noSuchThing'), undefined);
  } finally { console.warn = warn; }
  assert.match(warned, /noSuchThing/);
  assert.equal(cmd.isEnabled('noSuchThing'), false);
  assert.equal(cmd.isChecked('noSuchThing', 1), false);
});

// ---------------------------------------------------------------- import

await test('addMedia: imports, inserts after the selection, selects, one undo step', async () => {
  const { store, cmd, log } = makeApp();
  const a = addVisual(store, 'image');
  const b = addVisual(store, 'image');
  store.select('item', a.id);
  const before = undoCount(store);
  const ids = await cmd.run('addMedia', [file('video-4.webm', 'video/webm'), file('image-0.png', 'image/png')]);
  assert.equal(ids.length, 2);
  assert.equal(undoCount(store), before + 1);
  assert.deepEqual(store.project.items.map((i) => i.id), [a.id, ids[0], ids[1], b.id]);
  const v = store.project.items[1];
  assert.equal(v.kind, 'video');
  assert.equal(v.trimStart, 0);
  assert.equal(v.trimEnd, null);
  assert.equal(v.transition.type, 'none');
  const img = store.project.items[2];
  assert.equal(img.kind, 'image');
  assert.equal(img.duration, M.DEFAULT_IMAGE_DURATION);
  assert.deepEqual(store.selection, { type: 'item', ids });
  assert.ok(store.getMedia(v.mediaId), 'media added to the store');
  assert.equal(log.progress.length, 1, 'progress for more than one file');
  assert.equal(log.progress[0].closed, true);
  assert.ok(log.prepare >= 1, 'audio.prepare started');
  assert.equal(store.undoLabel, 'Add videos and photos');
  store.undo();
  assert.deepEqual(store.project.items.map((i) => i.id), [a.id, b.id]);
  store.redo();
  assert.equal(store.project.items.length, 4);
});

await test('addMedia: without files opens the picker with ACCEPT_VISUAL; empty pick does nothing', async () => {
  const { store, cmd, log, media } = makeApp();
  media.pickResult = [];
  assert.equal(await cmd.run('addMedia'), false);
  assert.deepEqual(log.picks[0], ['video/*,image/*', true]);
  media.pickResult = [file('image-0.jpg')];
  const ids = await cmd.run('addMedia');
  assert.equal(ids.length, 1);
  assert.equal(store.project.items.length, 1);
});

await test('addMedia: photo duration from options / localStorage; at end without selection', async () => {
  const { store, cmd, app } = makeApp();
  addVisual(store, 'image');
  app.options = { photoDuration: 4 };
  await cmd.run('addMedia', [file('image-0.png')]);
  assert.equal(store.project.items[1].duration, 4);
  app.options = {};
  lsData.set('wlmm.photoDuration', '3');
  store.select(null, []);
  await cmd.run('addMedia', [file('image-0.png')]);
  assert.equal(store.project.items[2].duration, 3, 'appended at the end');
  lsData.clear();
  app.options = { transitionDuration: 2.25 };
  await cmd.run('addMedia', [file('image-0.png')]);
  assert.equal(store.project.items[3].transition.duration, 2.25);
});

await test('addMedia: per-file failures are toasted, the rest is added', async () => {
  const { store, cmd, log } = makeApp();
  const ids = await cmd.run('addMedia', [file('image-0-bad.png'), file('image-0.png')]);
  assert.equal(ids.length, 1);
  assert.equal(store.project.items.length, 1);
  assert.ok(log.toasts.some((t) => t.type === 'error' && /bad/.test(t.msg)));
  // all bad → no undo step
  const n = undoCount(store);
  assert.equal(await cmd.run('addMedia', [file('x-0-bad.png')]), false);
  assert.equal(undoCount(store), n);
});

await test('addMedia: canceled import adds nothing and releases media', async () => {
  const { store, cmd, dialogs, log } = makeApp();
  const orig = dialogs.progress.bind(dialogs);
  dialogs.progress = (t, o) => { const p = orig(t, o); log.progress[log.progress.length - 1].ctl.abort(); return p; };
  assert.equal(await cmd.run('addMedia', [file('image-0.png'), file('image-0.png')]), false);
  assert.equal(store.project.items.length, 0);
});

await test('addMedia: background peaks for media without peaks → store media event', async () => {
  const { store, cmd, log } = makeApp();
  let mediaEvents = 0;
  store.addEventListener('media', () => { mediaEvents++; });
  await cmd.run('addMedia', [file('video-3-nopeaks.webm'), file('video-3-noaudio-nopeaks.webm')]);
  await flush();
  assert.equal(log.peaks.length, 1, 'only the video with sound');
  const m = store.getMedia(log.peaks[0]);
  assert.deepEqual(m.peaks, [0.1, 0.2, 0.3]);
  assert.ok(mediaEvents >= 3, 'touchMedia after peaks');
});

await test('addMusic: back to back at the start after existing music at 0', async () => {
  const { store, cmd } = makeApp();
  addVisual(store, 'image');
  const existing = addMusicItem(store, 0, 5);
  addMusicItem(store, 30, 5); // not chained from 0
  const ids = await cmd.run('addMusic', [file('audio-8.ogg'), file('audio-3.ogg')]);
  assert.equal(ids.length, 2);
  const [m1, m2] = ids.map((id) => store.find(id).obj);
  assert.equal(m1.start, 5);
  assert.equal(m2.start, 13);
  assert.equal(m1.kind, 'music');
  assert.deepEqual(store.selection, { type: 'music', ids });
  assert.equal(store.undoLabel, 'Add music');
  assert.ok(existing);
  // empty music track → starts at 0
  const t2 = makeApp();
  const [only] = await t2.cmd.run('addMusic', [file('audio-8.ogg')]);
  assert.equal(t2.store.find(only).obj.start, 0);
});

await test('addMusic: picker uses ACCEPT_AUDIO; pictures and silent videos are refused', async () => {
  const { store, cmd, log, media } = makeApp();
  media.pickResult = [file('image-0.png'), file('video-5-noaudio.webm'), file('video-6.webm')];
  const ids = await cmd.run('addMusic');
  assert.deepEqual(log.picks[0], ['audio/*,video/*', true]);
  assert.equal(ids.length, 1, 'a video soundtrack can be music');
  assert.equal(store.project.music.length, 1);
  assert.equal(log.toasts.filter((t) => t.type === 'error').length, 2);
  assert.equal(log.revoked.length, 2);
});

await test('addMusicAtPlayhead starts at the current time', async () => {
  const { store, cmd, player } = makeApp();
  addVisual(store, 'image');
  player.currentTime = 4.25;
  const [id] = await cmd.run('addMusicAtPlayhead', [file('audio-8.ogg')]);
  assert.equal(store.find(id).obj.start, 4.25);
  assert.equal(store.undoLabel, 'Add music at the current point');
});

await test('webcam → video item at the playhead; narration → narration at the playhead', async () => {
  const { store, cmd, player, dialogs } = makeApp();
  const a = addVisual(store, 'image', { duration: 4 });
  const b = addVisual(store, 'image', { duration: 4 });
  dialogs.webcamFile = file('video-5.webm', 'video/webm');
  player.currentTime = 3; // second half of a
  const id = await cmd.run('webcam');
  assert.deepEqual(store.project.items.map((i) => i.id), [a.id, id, b.id]);
  assert.equal(store.find(id).obj.kind, 'video');
  dialogs.webcamFile = null;
  assert.equal(await cmd.run('webcam'), false, 'canceled');
  dialogs.narrationFile = file('audio-6.ogg', 'audio/ogg');
  player.currentTime = 2.5;
  const nid = await cmd.run('narration');
  const n = store.find(nid).obj;
  assert.equal(n.kind, 'narration');
  assert.equal(n.start, 2.5);
  assert.equal(store.undoLabel, 'Record narration');
});

await test('snapshot → image item after the item under the playhead', async () => {
  const { store, cmd, player } = makeApp();
  const a = addVisual(store, 'image', { duration: 4 });
  const b = addVisual(store, 'image', { duration: 4 });
  player.currentTime = 1;
  const id = await cmd.run('snapshot');
  assert.deepEqual(store.project.items.map((i) => i.id), [a.id, id, b.id]);
  assert.equal(store.find(id).obj.kind, 'image');
  assert.equal(store.undoLabel, 'Add snapshot');
  const empty = makeApp();
  assert.equal(empty.cmd.isEnabled('snapshot'), false);
});

// ---------------------------------------------------------------- titles, captions, credits

await test('addTitle: before the selected item (or at start), selected, inline edit', () => {
  const { store, cmd, log } = makeApp();
  store.update((p) => { p.name = 'Holiday'; });
  const a = addVisual(store, 'image');
  const b = addVisual(store, 'image');
  store.select('item', b.id);
  const id = cmd.run('addTitle');
  assert.deepEqual(store.project.items.map((i) => i.id), [a.id, id, b.id]);
  const t = store.find(id).obj;
  assert.equal(t.kind, 'title');
  assert.equal(t.text, 'Holiday');
  assert.equal(t.duration, M.DEFAULT_TITLE_DURATION);
  assert.deepEqual(store.selection, { type: 'item', ids: [id] });
  assert.deepEqual(log.editText, [id]);
  store.select(null, []);
  const id2 = cmd.run('addTitle');
  assert.equal(store.project.items[0].id, id2);
  assert.equal(store.undoLabel, 'Add title');
});

await test('addCaption: at the playhead, clamped to the movie; disabled when empty', () => {
  const { store, cmd, player, log } = makeApp();
  assert.equal(cmd.isEnabled('addCaption'), false);
  addVisual(store, 'image', { duration: 7 });
  assert.equal(cmd.isEnabled('addCaption'), true);
  player.currentTime = 2;
  const id = cmd.run('addCaption');
  const c = store.find(id).obj;
  assert.equal(c.kind, 'caption');
  assert.equal(c.start, 2);
  assert.equal(c.duration, M.DEFAULT_CAPTION_DURATION);
  assert.deepEqual(store.selection, { type: 'text', ids: [id] });
  assert.ok(log.editText.includes(id));
  player.currentTime = 50;
  const id2 = cmd.run('addCaption');
  near(store.find(id2).obj.start, 6.9, 'clamped');
});

await test('addCredits: after the end of the pictures, then after existing end credits', () => {
  const { store, cmd } = makeApp();
  addVisual(store, 'image', { duration: 5 });
  addVisual(store, 'image', { duration: 5, transition: { type: 'crossfade', duration: 1 } });
  const id = cmd.run('addCredits');
  const c = store.find(id).obj;
  assert.equal(c.kind, 'credits');
  assert.equal(c.effect, 'scroll');
  assert.ok(c.text.startsWith('CREDITS\n'));
  near(c.start, 9);
  const id2 = cmd.run('addCredits');
  near(store.find(id2).obj.start, 9 + c.duration);
});

// ---------------------------------------------------------------- clipboard

await test('copy/paste visual items: deep copy with new ids after the selection', () => {
  const { store, cmd } = makeApp();
  const a = addVisual(store, 'image', { effect: 'sepia', transition: { type: 'crossfade', duration: 1 } });
  const b = addVisual(store, 'image');
  store.select('item', a.id);
  assert.equal(cmd.isEnabled('paste'), false);
  assert.equal(cmd.run('copy'), true);
  assert.equal(cmd.isEnabled('paste'), true);
  const ids = cmd.run('paste');
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], a.id);
  assert.deepEqual(store.project.items.map((i) => i.id), [a.id, ids[0], b.id]);
  const c = store.find(ids[0]).obj;
  assert.equal(c.effect, 'sepia');
  assert.deepEqual(c.transition, { type: 'crossfade', duration: 1 });
  c.effect = 'bw';
  assert.equal(store.find(a.id).obj.effect, 'sepia', 'deep copy');
  assert.equal(store.clipboard.objs[0].effect, 'sepia', 'clipboard not aliased');
  // paste twice → distinct ids
  const ids2 = cmd.run('paste');
  assert.notEqual(ids2[0], ids[0]);
});

await test('cut is one undo step; paste of texts/music at the playhead keeps spacing', () => {
  const { store, cmd, player } = makeApp();
  addVisual(store, 'image', { duration: 20 });
  const c1 = M.createTextItem('caption', { start: 2, text: 'one' });
  const c2 = M.createTextItem('caption', { start: 5, text: 'two' });
  store.update((p) => { p.texts.push(c1, c2); });
  store.select('text', [c1.id, c2.id]);
  const n = undoCount(store);
  cmd.run('cut');
  assert.equal(undoCount(store), n + 1);
  assert.equal(store.undoLabel, 'Cut');
  assert.equal(store.project.texts.length, 0);
  player.currentTime = 10;
  const ids = cmd.run('paste');
  const pasted = ids.map((id) => store.find(id).obj);
  assert.deepEqual(pasted.map((t) => t.start), [10, 13]);
  assert.deepEqual(pasted.map((t) => t.text), ['one', 'two']);
  store.undo();
  assert.equal(store.project.texts.length, 0);
  store.undo();
  assert.equal(store.project.texts.length, 2);
  // music
  const m = addMusicItem(store, 1, 5, { volume: 0.5 });
  store.select('music', m.id);
  cmd.run('copy');
  player.currentTime = 7;
  const [mid] = cmd.run('paste');
  const pm = store.find(mid).obj;
  assert.equal(pm.start, 7);
  assert.equal(pm.volume, 0.5);
  assert.equal(pm.mediaId, m.mediaId);
});

await test('paste into another project re-adds the copied media', () => {
  const { store, cmd } = makeApp();
  const a = addVisual(store, 'video', {}, 6);
  store.select('item', a.id);
  cmd.run('copy');
  store.replaceProject(M.createProject('Other'), new Map());
  assert.equal(store.getMedia(a.mediaId), undefined);
  const [id] = cmd.run('paste');
  assert.ok(store.getMedia(a.mediaId), 'media back in the store');
  assert.equal(store.timeline.segments[0].duration, 6);
  assert.equal(store.find(id).obj.mediaId, a.mediaId);
});

await test('remove deletes only the selection (items / texts / music)', () => {
  const { store, cmd } = makeApp();
  const a = addVisual(store, 'image');
  const b = addVisual(store, 'image');
  const cap = M.createTextItem('caption', { start: 1 });
  store.update((p) => { p.texts.push(cap); });
  const m = addMusicItem(store, 0, 5);
  store.select('item', a.id);
  assert.equal(cmd.run('remove'), true);
  assert.deepEqual(store.project.items.map((i) => i.id), [b.id]);
  assert.equal(store.project.texts.length, 1, 'captions stay');
  store.select('text', cap.id);
  cmd.run('remove');
  assert.equal(store.project.texts.length, 0);
  store.select('music', m.id);
  cmd.run('remove');
  assert.equal(store.project.music.length, 0);
  assert.equal(cmd.isEnabled('remove'), false);
  store.undo(); store.undo(); store.undo();
  assert.equal(store.project.items.length, 2);
  assert.equal(store.project.texts.length, 1);
  assert.equal(store.project.music.length, 1);
});

await test('selectAll, rotateLeft / rotateRight', () => {
  const { store, cmd } = makeApp();
  const a = addVisual(store, 'image');
  const t = addVisual(store, 'title');
  const v = addVisual(store, 'video');
  cmd.run('selectAll');
  assert.deepEqual(store.selection.ids, [a.id, t.id, v.id]);
  assert.equal(cmd.isEnabled('rotateLeft'), true);
  cmd.run('rotateLeft');
  assert.equal(store.find(a.id).obj.rotation, 270);
  assert.equal(store.find(v.id).obj.rotation, 270);
  assert.equal(store.find(t.id).obj.rotation, 0, 'titles are not rotated');
  cmd.run('rotateRight');
  cmd.run('rotateRight');
  assert.equal(store.find(a.id).obj.rotation, 90);
  assert.equal(store.undoLabel, 'Rotate right');
  store.select('item', t.id);
  assert.equal(cmd.isEnabled('rotateLeft'), false);
});

await test('moveItem / moveText / moveMusic', () => {
  const { store, cmd } = makeApp();
  const a = addVisual(store, 'image');
  const b = addVisual(store, 'image');
  const c = addVisual(store, 'image');
  assert.equal(cmd.run('moveItem', { id: a.id, toIndex: 2 }), true);
  assert.deepEqual(store.project.items.map((i) => i.id), [b.id, c.id, a.id]);
  assert.equal(cmd.run('moveItem', { id: a.id, toIndex: 2 }), false, 'no-op');
  cmd.run('moveItem', { id: a.id, toIndex: 0 });
  assert.deepEqual(store.project.items.map((i) => i.id), [a.id, b.id, c.id]);
  store.undo();
  assert.deepEqual(store.project.items.map((i) => i.id), [b.id, c.id, a.id]);
  const cap = M.createTextItem('caption', { start: 1 });
  store.update((p) => { p.texts.push(cap); });
  cmd.run('moveText', { id: cap.id, start: 4.5 });
  assert.equal(store.find(cap.id).obj.start, 4.5);
  cmd.run('moveText', { id: cap.id, start: -3 });
  assert.equal(store.find(cap.id).obj.start, 0);
  const m = addMusicItem(store, 0, 5);
  cmd.run('moveMusic', { id: m.id, start: 2 });
  assert.equal(store.find(m.id).obj.start, 2);
  assert.equal(store.undoLabel, 'Move music');
});

// ---------------------------------------------------------------- animations & effects

await test('setTransition: selected items, default duration when 0, isChecked; first item allowed', () => {
  const { store, cmd, app } = makeApp();
  const a = addVisual(store, 'image', { duration: 4 });
  const b = addVisual(store, 'image', { duration: 4, transition: { type: 'none', duration: 0 } });
  store.select('item', [a.id, b.id]);
  app.options = { transitionDuration: 1.25 };
  assert.equal(cmd.run('setTransition', 'crossfade'), true);
  assert.equal(store.find(b.id).obj.transition.type, 'crossfade');
  assert.equal(store.find(b.id).obj.transition.duration, 1.25, 'duration 0 → default');
  assert.equal(store.find(a.id).obj.transition.type, 'crossfade', 'first item may have one');
  assert.equal(store.find(a.id).obj.transition.duration, M.DEFAULT_TRANSITION_DURATION, 'kept');
  assert.equal(store.undoLabel, 'Apply transition');
  assert.equal(cmd.isChecked('setTransition', 'crossfade'), true);
  assert.equal(cmd.isChecked('setTransition', 'none'), false);
  const n = undoCount(store);
  assert.equal(cmd.run('setTransition', 'crossfade'), false, 'no-op makes no undo step');
  assert.equal(cmd.run('setTransition', 'not-a-transition'), false);
  assert.equal(undoCount(store), n);
  // timeline: the first item's transition has no visible effect
  const tl = store.timeline;
  assert.equal(tl.segments[0].transitionIn, null);
  near(tl.segments[1].start, 4 - 1.25);
});

await test('setTransitionDuration is coalesced; computeTimeline clamps the overlap', async () => {
  const { store, cmd } = makeApp();
  const a = addVisual(store, 'image', { duration: 2 });
  const b = addVisual(store, 'image', { duration: 3, transition: { type: 'crossfade', duration: 1 } });
  store.select('item', b.id);
  const n = undoCount(store);
  cmd.run('setTransitionDuration', 4);
  cmd.run('setTransitionDuration', '5');
  assert.equal(undoCount(store), n + 1, 'stepper drags are one undo step');
  assert.equal(store.find(b.id).obj.transition.duration, 5, 'stored as asked');
  const seg = store.timeline.segments[1];
  near(seg.transitionIn.duration, 1, 'clamped to half the shorter item');
  near(seg.start, 1);
  near(store.timeline.duration, 4);
  store.undo();
  assert.equal(store.find(b.id).obj.transition.duration, 1);
  assert.ok(a);
});

await test('applyTransitionAll / applyPanZoomAll / applyEffectAll copy from the first selected item', () => {
  const { store, cmd } = makeApp();
  const a = addVisual(store, 'image');
  const t = addVisual(store, 'title');
  const v = addVisual(store, 'video');
  store.select('item', v.id);
  cmd.run('setTransition', 'wipe-left');
  cmd.run('setTransitionDuration', 0.75);
  cmd.run('applyTransitionAll');
  for (const it of store.project.items) assert.deepEqual(it.transition, { type: 'wipe-left', duration: 0.75 });
  assert.equal(store.undoLabel, 'Apply transition to all');
  cmd.run('setPanZoom', 'zoom-in');
  cmd.run('applyPanZoomAll');
  assert.equal(store.find(a.id).obj.panZoom, 'zoom-in');
  assert.equal(store.find(t.id).obj.panZoom, 'none', 'titles have no pan and zoom');
  cmd.run('setEffect', 'sepia');
  cmd.run('applyEffectAll');
  for (const it of store.project.items) assert.equal(it.effect, 'sepia');
  assert.equal(cmd.isChecked('setEffect', 'sepia'), true);
  assert.equal(cmd.isChecked('setPanZoom', 'zoom-in'), true);
  const n = undoCount(store);
  cmd.run('applyEffectAll');
  assert.equal(undoCount(store), n, 'already applied → no undo step');
});

await test('setPanZoom skips titles; setBrightness is clamped and coalesced', () => {
  const { store, cmd, log } = makeApp();
  const t = addVisual(store, 'title');
  store.select('item', t.id);
  assert.equal(cmd.isEnabled('setPanZoom'), false);
  assert.equal(cmd.run('setPanZoom', 'zoom-in'), false);
  assert.ok(log.toasts.length);
  const a = addVisual(store, 'image');
  store.select('item', [t.id, a.id]);
  cmd.run('setPanZoom', 'pan-left');
  assert.equal(store.find(a.id).obj.panZoom, 'pan-left');
  assert.equal(store.find(t.id).obj.panZoom, 'none');
  const n = undoCount(store);
  cmd.run('setBrightness', 20);
  cmd.run('setBrightness', 40);
  cmd.run('setBrightness', 400);
  assert.equal(undoCount(store), n + 1);
  assert.equal(store.find(a.id).obj.brightness, 100);
  assert.equal(store.find(t.id).obj.brightness, 100);
});

// ---------------------------------------------------------------- project tab

await test('setAspect / setAudioMix (coalesced) / emphasize', () => {
  const { store, cmd } = makeApp();
  assert.equal(cmd.isChecked('setAspect', '16:9'), true);
  cmd.run('setAspect', '9:16');
  assert.equal(store.project.aspect, '9:16');
  assert.equal(cmd.run('setAspect', '7:3'), false);
  assert.equal(cmd.isChecked('setAspect', '9:16'), true);
  const n = undoCount(store);
  cmd.run('setAudioMix', 0.2);
  cmd.run('setAudioMix', 0.3);
  cmd.run('setAudioMix', 5);
  assert.equal(undoCount(store), n + 1);
  assert.equal(store.project.audioMix, 1);
  cmd.run('emphasize', 'video');
  assert.equal(store.project.audioMix, -0.6);
  assert.equal(cmd.isChecked('emphasize', 'video'), true);
  assert.equal(cmd.isChecked('emphasize', 'music'), false);
  cmd.run('emphasize', 'music');
  assert.equal(store.project.audioMix, 0.6);
  assert.equal(cmd.isChecked('emphasize', 'music'), true);
  cmd.run('emphasize', 'narration');
  assert.equal(store.project.emphasize, 'narration', 'audio engine ducks music under narration');
  assert.equal(cmd.isChecked('emphasize', 'narration'), true);
  assert.equal(cmd.isChecked('emphasize', 'music'), false);
  cmd.run('emphasize', 'narration');
  assert.equal(store.project.emphasize, undefined, 'toggles off');
  cmd.run('emphasize', 'narration');
  cmd.run('emphasize', 'video');
  assert.equal(store.project.emphasize, undefined, 'presets are exclusive');
  store.undo();
  assert.equal(store.project.emphasize, 'narration');
});

await test('fitToMusic: photo/title durations scaled so the pictures end with the music', () => {
  const { store, cmd } = makeApp();
  const v = addVisual(store, 'video', {}, 4);
  const a = addVisual(store, 'image', { duration: 5, transition: { type: 'crossfade', duration: 1 } });
  const t = addVisual(store, 'title', { duration: 5, transition: { type: 'crossfade', duration: 1 } });
  addMusicItem(store, 0, 30);
  assert.equal(cmd.isEnabled('fitToMusic'), true);
  assert.equal(cmd.run('fitToMusic'), true);
  near(store.timeline.segments.at(-1).end, 30, 'ends with the music', 0.002);
  near(store.find(a.id).obj.duration, store.find(t.id).obj.duration, 'proportional', 0.002);
  assert.equal(store.timeline.segments[0].duration, 4, 'videos untouched');
  assert.equal(store.undoLabel, 'Fit to music');
  // shrinking works too
  store.update((p) => { p.music[0].trimEnd = 12; });
  cmd.run('fitToMusic');
  near(store.timeline.segments.at(-1).end, 12, 'shrunk', 0.002);
  assert.ok(v);
});

await test('fitToMusic keeps end credits after the pictures and ends them with the music', () => {
  const { store, cmd } = makeApp();
  addVisual(store, 'image', { duration: 5 });
  addVisual(store, 'image', { duration: 5 });
  const cr = M.createTextItem('credits', { start: 10, duration: 6 });
  store.update((p) => { p.texts.push(cr); });
  addMusicItem(store, 0, 40);
  cmd.run('fitToMusic');
  near(store.timeline.segments.at(-1).end, 34, 'pictures end 6s before the music', 0.002);
  near(store.find(cr.id).obj.start, 34, 'credits follow', 0.002);
  near(store.timeline.duration, 40, 'movie ends with the music', 0.002);
});

await test('fitToMusic: friendly messages when it can not apply', () => {
  const { store, cmd, log } = makeApp();
  addVisual(store, 'image', { duration: 5 });
  assert.equal(cmd.isEnabled('fitToMusic'), false);
  assert.equal(cmd.run('fitToMusic'), false);
  assert.match(log.toasts.at(-1).msg, /Add music/);
  const t2 = makeApp();
  addVisual(t2.store, 'video', {}, 20);
  addVisual(t2.store, 'image', { duration: 5 });
  addMusicItem(t2.store, 0, 10);
  const n = undoCount(t2.store);
  assert.equal(t2.cmd.run('fitToMusic'), false);
  assert.match(t2.log.toasts.at(-1).msg, /shorter than your videos/);
  assert.equal(undoCount(t2.store), n, 'no undo step');
  const t3 = makeApp();
  addVisual(t3.store, 'video', {}, 20);
  addMusicItem(t3.store, 0, 30);
  assert.equal(t3.cmd.isEnabled('fitToMusic'), false, 'needs photos or titles');
});

// ---------------------------------------------------------------- view

await test('zoomIn/zoomOut clamp, view setters and checks', () => {
  const { store, cmd } = makeApp();
  cmd.run('zoomIn');
  near(store.view.zoom, 60);
  cmd.run('zoomOut');
  near(store.view.zoom, 40);
  for (let i = 0; i < 20; i++) cmd.run('zoomIn');
  assert.equal(store.view.zoom, 400);
  assert.equal(cmd.isEnabled('zoomIn'), false);
  for (let i = 0; i < 30; i++) cmd.run('zoomOut');
  assert.equal(store.view.zoom, 5);
  assert.equal(cmd.isEnabled('zoomOut'), false);
  cmd.run('setThumbSize', 'large');
  assert.equal(store.view.thumbSize, 'large');
  assert.equal(cmd.isChecked('setThumbSize', 'large'), true);
  assert.equal(cmd.run('setThumbSize', 'huge'), false);
  const w = store.view.showWaveforms;
  cmd.run('toggleWaveforms');
  assert.equal(store.view.showWaveforms, !w);
  assert.equal(cmd.isChecked('toggleWaveforms'), !w);
  cmd.run('setPreviewSize', 'large');
  assert.equal(cmd.isChecked('setPreviewSize', 'large'), true);
  assert.equal(store.canUndo, false, 'view changes are not undo steps');
});

// ---------------------------------------------------------------- video tools

await test('setVolume / setFadeIn / setFadeOut / setSpeed act on selected videos; setDuration on photos & titles', () => {
  const { store, cmd } = makeApp();
  const v = addVisual(store, 'video', {}, 10);
  const a = addVisual(store, 'image', { duration: 5 });
  store.select('item', [v.id, a.id]);
  const n = undoCount(store);
  cmd.run('setVolume', 0.5);
  cmd.run('setVolume', 0.25);
  assert.equal(undoCount(store), n + 1, 'coalesced');
  assert.equal(store.find(v.id).obj.volume, 0.25);
  cmd.run('setFadeIn', 'slow');
  cmd.run('setFadeOut', 'fast');
  assert.equal(store.find(v.id).obj.fadeIn, 'slow');
  assert.equal(store.find(v.id).obj.fadeOut, 'fast');
  assert.equal(cmd.isChecked('setFadeIn', 'slow'), true);
  assert.equal(cmd.run('setFadeIn', 'sideways'), false);
  cmd.run('setSpeed', '2');
  assert.equal(store.find(v.id).obj.speed, 2);
  assert.equal(cmd.isChecked('setSpeed', 2), true);
  near(store.timeline.segments[0].duration, 5);
  cmd.run('setDuration', 3);
  assert.equal(store.find(a.id).obj.duration, 3);
  near(store.timeline.segments[0].duration, 5, 'video not changed by setDuration');
  store.select('item', v.id);
  assert.equal(cmd.isEnabled('setDuration'), false);
  store.select('item', a.id);
  assert.equal(cmd.isEnabled('setVolume'), false);
  assert.equal(cmd.isEnabled('trimTool'), false);
});

await test('split: video at the playhead honoring trims and speed', () => {
  const { store, cmd, player } = makeApp();
  const pre = addVisual(store, 'image', { duration: 4 });
  const v = addVisual(store, 'video', { trimStart: 2, trimEnd: 8, speed: 2, fadeIn: 'slow', fadeOut: 'fast', effect: 'bw' }, 10);
  store.select('item', v.id);
  const seg = store.timeline.segments[1];
  near(seg.duration, 3);
  player.currentTime = seg.start + 1;
  const id = cmd.run('split');
  assert.ok(id);
  const first = store.find(v.id).obj;
  const second = store.find(id).obj;
  near(first.trimStart, 2);
  near(first.trimEnd, 4, 'source split = 2 + 1s × 2');
  near(second.trimStart, 4);
  assert.equal(second.trimEnd, 8);
  assert.equal(second.speed, 2);
  assert.equal(second.effect, 'bw');
  assert.equal(first.fadeIn, 'slow');
  assert.equal(first.fadeOut, 'none');
  assert.equal(second.fadeIn, 'none');
  assert.equal(second.fadeOut, 'fast');
  assert.equal(second.transition.type, 'none');
  const segs = store.timeline.segments;
  near(segs[1].duration, 1);
  near(segs[2].duration, 2);
  near(store.timeline.duration, 7, 'total length unchanged');
  assert.deepEqual(store.selection, { type: 'item', ids: [id] });
  assert.equal(store.undoLabel, 'Split');
  store.undo();
  assert.equal(store.project.items.length, 2);
  assert.equal(store.find(v.id).obj.trimEnd, 8);
  assert.ok(pre);
});

await test('split: untrimmed video (trimEnd null) keeps null on the second half', () => {
  const { store, cmd, player } = makeApp();
  const v = addVisual(store, 'video', {}, 10);
  player.currentTime = 6; // nothing selected → item under the playhead
  const id = cmd.run('split');
  assert.equal(store.find(v.id).obj.trimEnd, 6);
  assert.equal(store.find(id).obj.trimStart, 6);
  assert.equal(store.find(id).obj.trimEnd, null);
});

await test('split: photos and titles split their duration; edges are refused', () => {
  const { store, cmd, player, log } = makeApp();
  const a = addVisual(store, 'image', { duration: 6 });
  const t = addVisual(store, 'title', { duration: 4, text: 'Hello' });
  store.select('item', a.id);
  player.currentTime = 2.5;
  const id = cmd.run('split');
  near(store.find(a.id).obj.duration, 2.5);
  near(store.find(id).obj.duration, 3.5);
  store.select('item', t.id);
  player.currentTime = 6 + 1;
  const id2 = cmd.run('split');
  near(store.find(t.id).obj.duration, 1);
  near(store.find(id2).obj.duration, 3);
  assert.equal(store.find(id2).obj.text, 'Hello');
  const n = undoCount(store);
  store.select('item', id2);
  player.currentTime = 7.05; // 0.05s into the item
  assert.equal(cmd.run('split'), false);
  assert.match(log.toasts.at(-1).msg, /further from the beginning or end/);
  player.currentTime = 9.95; // 0.05s before its end
  assert.equal(cmd.run('split'), false);
  player.currentTime = 1; // outside the selected item
  assert.equal(cmd.run('split'), false);
  assert.match(log.toasts.at(-1).msg, /playhead onto the selected item/);
  assert.equal(undoCount(store), n);
});

await test('setStartPoint / setEndPoint trim the selected video at the playhead (with speed)', () => {
  const { store, cmd, player, log } = makeApp();
  addVisual(store, 'image', { duration: 2 });
  const v = addVisual(store, 'video', { trimStart: 1, speed: 0.5 }, 10);
  store.select('item', v.id);
  // segment: start 2, duration (10-1)/0.5 = 18
  player.currentTime = 2 + 4; // 4s into the item → source 1 + 4×0.5 = 3
  assert.equal(cmd.run('setStartPoint'), true);
  near(store.find(v.id).obj.trimStart, 3);
  assert.equal(store.undoLabel, 'Set start point');
  assert.equal(player.currentTime, 2, 'playhead at the new first frame');
  near(store.timeline.segments[1].duration, 14);
  player.currentTime = 2 + 10; // source 3 + 5 = 8
  cmd.run('setEndPoint');
  near(store.find(v.id).obj.trimEnd, 8);
  near(store.timeline.segments[1].duration, 10);
  player.currentTime = 2.05;
  assert.equal(cmd.run('setEndPoint'), false, 'too close to the start');
  assert.ok(log.toasts.length);
  const img = store.project.items[0];
  store.select('item', img.id);
  player.currentTime = 1;
  assert.equal(cmd.run('setStartPoint'), false, 'photos have no start point');
});

await test('trimTool opens the trim dialog for the selected video', async () => {
  const { store, cmd, log } = makeApp();
  const v = addVisual(store, 'video');
  store.select('item', v.id);
  assert.equal(cmd.isEnabled('trimTool'), true);
  await cmd.run('trimTool');
  assert.deepEqual(log.trim, [v.id]);
});

await test('setBackground changes the selected titles', () => {
  const { store, cmd } = makeApp();
  const t = addVisual(store, 'title');
  store.select('item', t.id);
  assert.equal(cmd.isEnabled('setBackground'), true);
  cmd.run('setBackground', '#336699');
  cmd.run('setBackground', '#3366AA');
  assert.equal(store.find(t.id).obj.background, '#3366AA');
  assert.equal(store.undoLabel, 'Change background color');
  assert.equal(cmd.isChecked('setBackground', '#3366aa'), true);
  assert.equal(cmd.run('setBackground', 42), false);
});

// ---------------------------------------------------------------- music tools

await test('music volume / fades / start time', () => {
  const { store, cmd, player } = makeApp();
  addVisual(store, 'image', { duration: 20 });
  const m = addMusicItem(store, 1, 10);
  const m2 = addMusicItem(store, 12, 5);
  store.select('music', [m.id, m2.id]);
  cmd.run('musicVolume', 0.4);
  assert.equal(store.find(m.id).obj.volume, 0.4);
  cmd.run('musicVolume', 80);
  assert.equal(store.find(m2.id).obj.volume, 0.8, 'percent accepted');
  cmd.run('musicFadeIn', 'medium');
  cmd.run('musicFadeOut', 'slow');
  assert.equal(store.find(m.id).obj.fadeIn, 'medium');
  assert.equal(cmd.isChecked('musicFadeOut', 'slow'), true);
  cmd.run('musicStartTime', 3);
  assert.equal(store.find(m.id).obj.start, 3);
  assert.equal(store.find(m2.id).obj.start, 14, 'keeps spacing');
  player.currentTime = 6.5;
  cmd.run('musicStartTime');
  assert.equal(store.find(m.id).obj.start, 6.5, 'defaults to the playhead');
  cmd.run('musicStartTime', '00:02.00');
  assert.equal(store.find(m.id).obj.start, 2);
});

await test('musicSetStartPoint / musicSetEndPoint / musicSplit at the playhead', () => {
  const { store, cmd, player, log } = makeApp();
  addVisual(store, 'image', { duration: 20 });
  const m = addMusicItem(store, 2, 10, { trimStart: 1, fadeIn: 'slow', fadeOut: 'fast' });
  store.select('music', m.id);
  // music plays source 1..10 at timeline 2..11
  player.currentTime = 5; // 3s in → source 4
  const id = cmd.run('musicSplit');
  const a = store.find(m.id).obj;
  const b = store.find(id).obj;
  assert.equal(a.trimEnd, 4);
  assert.equal(b.trimStart, 4);
  assert.equal(b.start, 5);
  assert.equal(b.trimEnd, null);
  assert.equal(a.fadeOut, 'none');
  assert.equal(b.fadeIn, 'none');
  assert.equal(b.fadeOut, 'fast');
  const tl = store.timeline;
  const ea = tl.music.find((x) => x.item.id === m.id);
  const eb = tl.music.find((x) => x.item.id === id);
  near(ea.end, 5);
  near(eb.start, 5);
  near(eb.end, 11);
  assert.deepEqual(store.selection, { type: 'music', ids: [id] });
  player.currentTime = 7; // 2s into b → source 6
  cmd.run('musicSetStartPoint');
  assert.equal(store.find(id).obj.trimStart, 6);
  assert.equal(store.find(id).obj.start, 5, 'start time in the movie stays');
  player.currentTime = 8; // 3s into b → source 9
  cmd.run('musicSetEndPoint');
  assert.equal(store.find(id).obj.trimEnd, 9);
  player.currentTime = 5.05;
  assert.equal(cmd.run('musicSplit'), false);
  assert.ok(log.toasts.length);
  player.currentTime = 15;
  assert.equal(cmd.run('musicSplit'), false, 'playhead outside the music');
});

// ---------------------------------------------------------------- text tools

await test('textSet on captions and on title items, validation and coalescing', () => {
  const { store, cmd } = makeApp();
  const t = addVisual(store, 'title');
  const cap = M.createTextItem('caption', { start: 0 });
  store.update((p) => { p.texts.push(cap); });
  store.select('text', cap.id);
  cmd.run('textSet', { key: 'bold', value: false });
  assert.equal(store.find(cap.id).obj.style.bold, false);
  assert.equal(store.undoLabel, 'Bold');
  assert.equal(cmd.isChecked('textSet', { key: 'bold', value: false }), true);
  cmd.run('textSet', { key: 'align', value: 'left' });
  assert.equal(cmd.isChecked('textSet', { key: 'align', value: 'left' }), true);
  assert.equal(cmd.run('textSet', { key: 'align', value: 'diagonal' }), false);
  assert.equal(cmd.run('textSet', { key: 'nonsense', value: 1 }), false);
  const n = undoCount(store);
  cmd.run('textSet', { key: 'opacity', value: 0.8 });
  cmd.run('textSet', { key: 'opacity', value: 0.6 });
  assert.equal(undoCount(store), n + 1, 'slider coalesced');
  assert.equal(store.find(cap.id).obj.style.opacity, 0.6);
  cmd.run('textSet', { key: 'size', value: 200 });
  assert.equal(store.find(cap.id).obj.style.size, 50, 'clamped');
  cmd.run('textSet', { key: 'background', value: null });
  assert.equal(store.find(cap.id).obj.style.background, null);
  store.select('item', t.id);
  cmd.run('textSet', { key: 'color', value: '#ff0000' });
  assert.equal(store.find(t.id).obj.style.color, '#ff0000');
  assert.equal(cmd.isEnabled('textSet'), true);
  const img = addVisual(store, 'image');
  store.select('item', img.id);
  assert.equal(cmd.isEnabled('textSet'), false);
});

await test('textEdit with and without text; textDuration / textStartTime / textEffect', () => {
  const { store, cmd, player, log } = makeApp();
  const t = addVisual(store, 'title', { text: 'Old' });
  const cap = M.createTextItem('caption', { start: 1, text: 'Hi' });
  store.update((p) => { p.texts.push(cap); });
  store.select('item', t.id);
  cmd.run('textEdit', 'New title');
  assert.equal(store.find(t.id).obj.text, 'New title');
  assert.equal(store.undoLabel, 'Edit text');
  assert.equal(cmd.run('textEdit', 'New title'), false, 'unchanged');
  cmd.run('textEdit');
  assert.deepEqual(log.editText, [t.id], 'inline editing requested');
  cmd.run('textDuration', 9);
  assert.equal(store.find(t.id).obj.duration, 9, 'title duration');
  cmd.run('textEffect', 'typewriter');
  assert.equal(store.find(t.id).obj.textEffect, 'typewriter');
  assert.equal(cmd.isChecked('textEffect', 'typewriter'), true);
  assert.equal(cmd.isEnabled('textStartTime'), false, 'titles are placed by the storyboard');
  store.select('text', cap.id);
  cmd.run('textEdit', 'Line 1\nLine 2');
  assert.equal(store.find(cap.id).obj.text, 'Line 1\nLine 2');
  cmd.run('textDuration', '2.5');
  assert.equal(store.find(cap.id).obj.duration, 2.5);
  cmd.run('textStartTime', 4);
  assert.equal(store.find(cap.id).obj.start, 4);
  player.currentTime = 3;
  cmd.run('textStartTime');
  assert.equal(store.find(cap.id).obj.start, 3);
  cmd.run('textEffect', 'fly-left');
  assert.equal(store.find(cap.id).obj.effect, 'fly-left');
  assert.equal(cmd.run('textEffect', 'no-such-effect'), false);
});

// ---------------------------------------------------------------- undo / redo, navigation

await test('undo / redo commands and enabled state', () => {
  const { store, cmd } = makeApp();
  assert.equal(cmd.isEnabled('undo'), false);
  assert.equal(cmd.isEnabled('redo'), false);
  cmd.run('addTitle');
  assert.equal(cmd.isEnabled('undo'), true);
  cmd.run('undo');
  assert.equal(store.project.items.length, 0);
  assert.equal(cmd.isEnabled('redo'), true);
  cmd.run('redo');
  assert.equal(store.project.items.length, 1);
});

await test('navigation commands drive the player', async () => {
  const { store, cmd, player } = makeApp();
  assert.equal(cmd.isEnabled('play'), false, 'nothing to play');
  addVisual(store, 'image', { duration: 4 });
  addVisual(store, 'image', { duration: 4 });
  addVisual(store, 'image', { duration: 4 });
  assert.equal(cmd.isEnabled('play'), true);
  await cmd.run('play');
  assert.equal(player.playing, true);
  assert.equal(cmd.isChecked('togglePlay'), true);
  cmd.run('pause');
  assert.equal(player.playing, false);
  await cmd.run('togglePlay');
  assert.equal(player.playing, true);
  player.playing = false;
  await cmd.run('seek', 5);
  assert.equal(player.currentTime, 5);
  await cmd.run('seek', '00:06.50');
  assert.equal(player.currentTime, 6.5);
  await cmd.run('seek', 99);
  assert.equal(player.currentTime, 12, 'clamped');
  await cmd.run('goStart');
  assert.equal(player.currentTime, 0);
  await cmd.run('nextFrame');
  near(player.currentTime, 1 / 30);
  await cmd.run('prevFrame');
  near(player.currentTime, 0);
  cmd.run('nextItem');
  assert.equal(player.currentTime, 4);
  cmd.run('nextItem');
  assert.equal(player.currentTime, 8);
  cmd.run('prevItem');
  assert.equal(player.currentTime, 4);
  player.currentTime = 9;
  cmd.run('prevItem');
  assert.equal(player.currentTime, 8, 'start of the current item first');
  await cmd.run('goEnd');
  assert.equal(player.currentTime, 12);
});

// ---------------------------------------------------------------- projects

await test('project commands (fallbacks without dialog helpers)', async () => {
  const { store, cmd, log, dialogs } = makeApp();
  addVisual(store, 'image');
  await cmd.run('saveProject');
  assert.equal(log.saved.length, 1);
  assert.equal(log.saved[0].id, store.project.id);
  assert.ok(log.toasts.some((t) => t.msg === 'Project saved'));
  const oldId = store.project.id;
  dialogs.promptAnswer = 'Copy name';
  await cmd.run('saveProjectAs');
  assert.notEqual(store.project.id, oldId);
  assert.equal(store.project.name, 'Copy name');
  assert.equal(store.project.items.length, 1);
  assert.equal(log.saved.at(-1).id, store.project.id);
  // new project asks first when the project has items
  dialogs.confirmAnswer = false;
  assert.equal(await cmd.run('newProject'), false);
  assert.equal(store.project.items.length, 1);
  dialogs.confirmAnswer = true;
  assert.equal(await cmd.run('newProject'), true);
  assert.equal(store.project.items.length, 0);
  assert.equal(log.confirms.length, 2);
  await cmd.run('newProject');
  assert.equal(log.confirms.length, 2, 'no question for an empty project');
  await cmd.run('openProject');
  assert.equal(log.openProjects, 1);
  await cmd.run('importProjectFile', file('x.wlmmweb'));
  assert.equal(store.project.name, 'Imported one');
  // No DOM in node: the export fallback must fail with a friendly toast, never throw.
  const before = log.toasts.length;
  const ok = await cmd.run('exportProjectFile');
  assert.equal(ok, false);
  assert.equal(log.exported, 1);
  assert.equal(log.toasts.length, before + 1);
  assert.equal(log.toasts.at(-1).type, 'error');
  cmd.run('about');
  cmd.run('help');
  assert.equal(log.about, 1);
  assert.equal(log.help, 1);
});

await test('project commands delegate to dialog helpers when present', async () => {
  const { cmd, dialogs } = makeApp();
  const calls = [];
  dialogs.saveProject = () => { calls.push('save'); return true; };
  dialogs.saveProjectAs = () => { calls.push('saveAs'); return true; };
  dialogs.newProject = () => { calls.push('new'); };
  dialogs.importProjectFromFile = (f) => { calls.push(['import', f && f.name]); return true; };
  dialogs.exportProjectFile = () => { calls.push('export'); return true; };
  await cmd.run('saveProject');
  await cmd.run('saveProjectAs');
  await cmd.run('newProject');
  await cmd.run('importProjectFile');
  await cmd.run('exportProjectFile');
  assert.deepEqual(calls, ['save', 'saveAs', 'new', ['import', undefined], 'export']);
});

await test('saveMovie opens the export dialog; needs items', async () => {
  const { store, cmd, log } = makeApp();
  assert.equal(cmd.isEnabled('saveMovie'), false);
  addVisual(store, 'image');
  assert.equal(cmd.isEnabled('saveMovie'), true);
  await cmd.run('saveMovie', 'hd720');
  await cmd.run('saveMovie');
  assert.deepEqual(log.exportOpen, ['hd720', 'recommended']);
});

await test('busy: exporting blocks editing & playback; trim mode blocks editing only', () => {
  const { store, cmd, app, dialogs, log } = makeApp();
  const a = addVisual(store, 'image');
  store.select('item', a.id);
  app.exporting = true;
  assert.equal(cmd.isEnabled('remove'), false);
  assert.equal(cmd.isEnabled('play'), false);
  assert.equal(cmd.isEnabled('saveProject'), false);
  assert.equal(cmd.isEnabled('help'), true);
  assert.equal(cmd.run('remove'), undefined);
  assert.equal(store.project.items.length, 1);
  assert.match(log.toasts.at(-1).msg, /finished saving/);
  app.exporting = false;
  dialogs.trimActive = true;
  assert.equal(cmd.isEnabled('remove'), false);
  assert.equal(cmd.isEnabled('undo'), false);
  assert.equal(cmd.isEnabled('play'), true);
  assert.equal(cmd.isEnabled('saveProject'), true);
  dialogs.trimActive = false;
  assert.equal(cmd.isEnabled('remove'), true);
});

await test('isEnabled: editing commands need a matching selection', () => {
  const { store, cmd } = makeApp();
  const v = addVisual(store, 'video');
  const cap = M.createTextItem('caption', { start: 0 });
  store.update((p) => { p.texts.push(cap); });
  const m = addMusicItem(store, 0, 5);
  const visualOnly = ['setTransition', 'setEffect', 'setBrightness', 'applyTransitionAll', 'setVolume', 'setSpeed', 'trimTool', 'setStartPoint'];
  const musicOnly = ['musicVolume', 'musicSplit', 'musicStartTime', 'musicSetEndPoint'];
  const textOnly = ['textSet', 'textEdit', 'textStartTime', 'textEffect', 'textDuration'];
  store.select(null, []);
  for (const n of [...visualOnly, ...musicOnly, ...textOnly, 'cut', 'copy', 'remove']) assert.equal(cmd.isEnabled(n), false, n);
  store.select('item', v.id);
  for (const n of visualOnly) assert.equal(cmd.isEnabled(n), true, n);
  for (const n of [...musicOnly, ...textOnly]) assert.equal(cmd.isEnabled(n), false, n);
  store.select('music', m.id);
  for (const n of musicOnly) assert.equal(cmd.isEnabled(n), true, n);
  assert.equal(cmd.isEnabled('split'), false, 'split works on the storyboard');
  store.select('text', cap.id);
  for (const n of textOnly) assert.equal(cmd.isEnabled(n), true, n);
  for (const n of ['addTitle', 'addCredits', 'addMedia', 'addMusic', 'webcam', 'narration', 'setAspect', 'newProject']) {
    assert.equal(cmd.isEnabled(n), true, n);
  }
});

await test('errors inside a command become a toast, not an exception', async () => {
  const { store, cmd, app, log } = makeApp();
  addVisual(store, 'image');
  app.exporter.snapshot = async () => { const e = new Error('The picture couldn’t be created.'); e.friendly = true; throw e; };
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await cmd.run('snapshot'), undefined);
  } finally { console.error = err; }
  assert.equal(log.toasts.at(-1).msg, 'The picture couldn’t be created.');
  assert.equal(log.toasts.at(-1).type, 'error');
});

// ---------------------------------------------------------------- captions travel with their pictures

function captionAt(store, start, text = 'cap') {
  const c = M.createTextItem('caption', { start, text });
  store.update((p) => { p.texts.push(c); }, { label: 'setup' });
  return c;
}
const startOf = (store, id) => store.find(id).obj.start;

await test('anchoring: insert / remove / reorder move captions with their item; credits stay at the end', async () => {
  const { store, cmd } = makeApp();
  const a = addVisual(store, 'image', { duration: 4 });
  const b = addVisual(store, 'image', { duration: 6 });
  const onA = captionAt(store, 1);
  const onB = captionAt(store, 5); // 1s into b
  const cr = M.createTextItem('credits', { start: 10 });
  store.update((p) => { p.texts.push(cr); });
  store.select('item', a.id);
  cmd.run('addTitle'); // 7s title before a
  near(startOf(store, onA.id), 8);
  near(startOf(store, onB.id), 12);
  near(startOf(store, cr.id), 17, 'end credits after the pictures');
  store.undo();
  near(startOf(store, onB.id), 5, 'undo restores');
  cmd.run('moveItem', { id: b.id, toIndex: 0 });
  near(startOf(store, onB.id), 1, 'follows its item');
  near(startOf(store, onA.id), 7);
  store.select('item', b.id);
  cmd.run('remove');
  near(startOf(store, onA.id), 1, 'later captions close the gap');
  near(startOf(store, onB.id), 1, 'caption of a removed item keeps its time');
  near(startOf(store, cr.id), 4);
  store.select(null, []);
  await cmd.run('addMedia', [file('image-0.png')]);
  near(startOf(store, cr.id), 11, 'new pictures at the end push the credits');
});

await test('anchoring: transitions, durations, speed and trims keep captions on their frame', () => {
  const { store, cmd, player } = makeApp();
  const a = addVisual(store, 'image', { duration: 4 });
  const v = addVisual(store, 'video', {}, 10);
  const c = addVisual(store, 'image', { duration: 4 });
  const onV = captionAt(store, 10); // 6s into the video (source 6)
  const onC = captionAt(store, 15); // 1s into c
  store.select('item', v.id);
  cmd.run('setTransition', 'crossfade'); // 1.5s overlap a→v
  near(startOf(store, onV.id), 8.5);
  near(startOf(store, onC.id), 13.5);
  cmd.run('setSpeed', 2); // video 5s long; source 6 → 3s into it
  near(startOf(store, onV.id), 2.5 + 3);
  near(startOf(store, onC.id), 2.5 + 5 + 1);
  player.currentTime = 2.5 + 1; // source 2
  cmd.run('setStartPoint');
  near(startOf(store, onV.id), 2.5 + 2, 'same frame after trimming the start');
  store.select('item', c.id);
  cmd.run('setDuration', 8); // caption 1s into a 4s photo → 2s into an 8s photo
  const segC = store.timeline.segments[2];
  near(startOf(store, onC.id), segC.start + 2);
  // split moves nothing
  const before = store.project.texts.map((t) => t.start);
  store.select('item', v.id);
  player.currentTime = store.timeline.segments[1].start + 1;
  cmd.run('split');
  assert.deepEqual(store.project.texts.map((t) => t.start), before);
  assert.ok(a);
});

await test('anchoring: AutoMovie keeps captions on their pictures after adding the opening title', () => {
  const { store } = makeApp();
  const v = addVisual(store, 'video', {}, 6);
  addVisual(store, 'image', { duration: 5 });
  const cap = captionAt(store, 1);
  applyAutoMovie(store, 'default');
  const seg = store.timeline.segments.find((s) => s.item.id === v.id);
  near(startOf(store, cap.id), seg.start + 1);
});

// ---------------------------------------------------------------- AutoMovie

await test('resolveTheme: catalog themes, unknown → default, every field filled', () => {
  for (const t of catalog.AUTOMOVIE_THEMES) {
    const r = resolveTheme(t.id);
    assert.equal(r.id, t.id);
    assert.ok(catalog.TRANSITIONS.some((x) => x.id === r.transition), r.transition);
    assert.ok(catalog.PANZOOM.some((x) => x.id === r.panZoom));
    assert.ok(catalog.EFFECTS.some((x) => x.id === r.effect));
    assert.ok(r.transitionDuration > 0);
  }
  assert.equal(resolveTheme('nope').id, 'default');
});

await test('AutoMovie: transitions, pan & zoom, effects, title and credits in one undo step', () => {
  const { store, cmd, log } = makeApp();
  store.update((p) => { p.name = 'Beach day'; });
  const a = addVisual(store, 'image', { duration: 5 });
  const v = addVisual(store, 'video', {}, 6);
  const b = addVisual(store, 'image', { duration: 5 });
  const n = undoCount(store);
  const res = cmd.run('autoMovie', 'sepia');
  assert.equal(res.ok, true);
  assert.equal(undoCount(store), n + 1, 'one undo step');
  const theme = catalog.AUTOMOVIE_THEMES.find((t) => t.id === 'sepia');
  const items = store.project.items;
  assert.equal(items.length, 4);
  const title = items[0];
  assert.equal(title.kind, 'title');
  assert.equal(title.text, 'Beach day');
  assert.equal(title.textEffect, theme.titleEffect);
  assert.equal(title.background, theme.titleBackground);
  assert.equal(title.style.font, theme.titleStyle.font);
  assert.equal(title.style.italic, theme.titleStyle.italic);
  for (let i = 1; i < items.length; i++) assert.deepEqual(items[i].transition, { type: theme.transition, duration: theme.transitionDuration });
  assert.equal(store.find(a.id).obj.panZoom, theme.panZoom);
  assert.equal(store.find(v.id).obj.panZoom, 'none', 'pan & zoom only on photos');
  assert.equal(store.find(v.id).obj.effect, 'sepia');
  assert.equal(store.find(b.id).obj.effect, 'sepia');
  const credits = store.project.texts.filter((t) => t.kind === 'credits');
  assert.equal(credits.length, 1);
  near(credits[0].start, store.timeline.segments.at(-1).end, 'credits after the pictures');
  assert.equal(credits[0].effect, theme.creditsEffect);
  assert.equal(credits[0].style.font, theme.creditsStyle.font);
  assert.ok(log.toasts.some((t) => /AutoMovie theme “Sepia” applied/.test(t.msg)));
  store.undo();
  assert.equal(store.project.items.length, 3);
  assert.equal(store.project.texts.length, 0);
  assert.equal(store.find(a.id).obj.effect, 'none');
});

await test('AutoMovie: restyles an existing title / credits instead of adding more', () => {
  const { store } = makeApp();
  const t = addVisual(store, 'title', { text: 'My own title' });
  addVisual(store, 'image', { duration: 5 });
  const cr = M.createTextItem('credits', { start: 12, text: 'Mine' }); // at the end of the pictures
  store.update((p) => { p.texts.push(cr); });
  const res = applyAutoMovie(store, 'cinematic');
  assert.equal(res.titleAdded, false);
  assert.equal(res.creditsAdded, false);
  assert.equal(store.project.items.length, 2);
  assert.equal(store.project.items[0].id, t.id);
  assert.equal(store.project.items[0].text, 'My own title');
  assert.equal(store.project.items[0].textEffect, 'cinematic');
  assert.equal(store.project.texts.length, 1);
  assert.equal(store.find(cr.id).obj.text, 'Mine');
  // 7 + 5 - transition overlap(2 clamped to 2.5 → 2) = 10 → end credits move to the new end
  near(store.find(cr.id).obj.start, store.timeline.segments.at(-1).end);
  assert.equal(store.undoLabel, 'AutoMovie theme: Cinematic');
});

await test('AutoMovie: longer music stretches photos so credits end with the music', () => {
  const { store } = makeApp();
  addVisual(store, 'image', { duration: 5 });
  addVisual(store, 'image', { duration: 5 });
  addMusicItem(store, 0, 60);
  const res = applyAutoMovie(store, 'default');
  assert.equal(res.fitted, true);
  const credits = store.project.texts.find((t) => t.kind === 'credits');
  near(credits.start + credits.duration, 60, 'credits end with the music', 0.002);
  near(store.timeline.duration, 60, 'movie ends with the music', 0.002);
  // music shorter than the pictures → durations untouched
  const t2 = makeApp();
  const a = addVisual(t2.store, 'image', { duration: 5 });
  addMusicItem(t2.store, 0, 3);
  const r2 = applyAutoMovie(t2.store, 'fade');
  assert.equal(r2.fitted, false);
  assert.equal(t2.store.find(a.id).obj.duration, 5);
  assert.equal(t2.store.find(a.id).obj.panZoom, 'none', 'Fade theme has no pan & zoom');
});

await test('AutoMovie: empty project is refused with a message', () => {
  const { store, cmd, log } = makeApp();
  assert.equal(cmd.isEnabled('autoMovie'), false);
  assert.equal(cmd.run('autoMovie', 'default'), false);
  assert.ok(log.toasts.length);
  assert.equal(store.canUndo, false);
  assert.equal(applyAutoMovie(store, 'default').ok, false);
});

await test('fitVisualsToMusic is monotonic and exact with many transitions', () => {
  const p = M.createProject();
  const mediaMap = new Map();
  for (let i = 0; i < 12; i++) {
    p.items.push(M.createVisualItem(i % 3 === 0 ? 'title' : 'image', { duration: 1 + (i % 4), transition: { type: 'crossfade', duration: 1.5 } }));
  }
  const am = fakeMedia('audio', 95.5);
  mediaMap.set(am.id, am);
  p.music.push(M.createMusicItem({ mediaId: am.id, start: 0 }));
  const r = fitVisualsToMusic(p, mediaMap);
  assert.equal(r.ok, true);
  near(M.computeTimeline(p, mediaMap).segments.at(-1).end, 95.5, 'end', 0.002);
  const r2 = fitVisualsToMusic(p, mediaMap);
  assert.equal(r2.changed, false, 'already fitted');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
