// Node tests for js/model.js and js/store.js (A-core).
// Run: node /home/user/JDSamps/moviemaker/tests/core.test.mjs
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import { Store, COALESCE_MS } from '../js/store.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : err}`);
  }
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} expected ${b}, got ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- model ----------------
await test('constants match contract', () => {
  assert.deepEqual(Object.keys(M.ASPECTS), ['16:9', '4:3', '9:16', '1:1']);
  assert.deepEqual(M.FADE_SPEEDS, { none: 0, slow: 2, medium: 1, fast: 0.5 });
  assert.deepEqual(M.SPEEDS, [0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8]);
  assert.equal(M.DEFAULT_IMAGE_DURATION, 7);
  assert.equal(M.DEFAULT_TITLE_DURATION, 7);
  assert.equal(M.DEFAULT_CAPTION_DURATION, 3.5);
  assert.equal(M.DEFAULT_TRANSITION_DURATION, 1.5);
});

await test('uid is unique and prefixed', () => {
  const s = new Set();
  for (let i = 0; i < 5000; i++) s.add(M.uid('x'));
  assert.equal(s.size, 5000);
  assert.ok(M.uid('item').startsWith('item-'));
});

await test('createProject defaults', () => {
  const p = M.createProject();
  assert.equal(p.version, 1);
  assert.equal(p.name, 'My Movie');
  assert.equal(p.aspect, '16:9');
  assert.equal(p.audioMix, 0);
  assert.deepEqual([p.items, p.texts, p.music], [[], [], []]);
  assert.ok(p.createdAt > 0 && p.updatedAt >= p.createdAt);
  assert.equal(M.createProject('Holiday').name, 'Holiday');
});

await test('createVisualItem fills every field', () => {
  const v = M.createVisualItem('video', { mediaId: 'm1' });
  assert.equal(v.kind, 'video');
  assert.equal(v.mediaId, 'm1');
  assert.equal(v.trimStart, 0);
  assert.equal(v.trimEnd, null);
  assert.equal(v.speed, 1);
  assert.equal(v.volume, 1);
  assert.equal(v.fadeIn, 'none');
  assert.equal(v.fadeOut, 'none');
  assert.deepEqual(v.transition, { type: 'none', duration: 1.5 });
  assert.equal(v.panZoom, 'none');
  assert.equal(v.effect, 'none');
  assert.equal(v.brightness, 0);
  assert.equal(v.rotation, 0);
  const t = M.createVisualItem('title');
  assert.equal(t.mediaId, null);
  assert.equal(t.background, '#000000');
  assert.equal(t.text, 'My Movie');
  assert.equal(t.textEffect, 'fade');
  assert.equal(t.duration, 7);
  assert.ok(t.style && t.style.font);
  const i = M.createVisualItem('image', { mediaId: 'p', duration: 3, rotation: 90, brightness: 500 });
  assert.equal(i.duration, 3);
  assert.equal(i.rotation, 90);
  assert.equal(i.brightness, 100);
  assert.equal(M.createVisualItem('image', { rotation: 45 }).rotation, 0);
});

await test('text items & styles', () => {
  const c = M.createTextItem('caption', { start: 2 });
  assert.equal(c.kind, 'caption');
  assert.equal(c.start, 2);
  assert.equal(c.duration, 3.5);
  assert.equal(c.style.color, '#ffffff');
  assert.equal(c.style.bold, true);
  assert.equal(c.style.outline, 'thin');
  assert.equal(c.style.outlineColor, '#000000');
  assert.equal(c.style.valign, 'bottom');
  const cr = M.createTextItem('credits');
  assert.equal(cr.effect, 'scroll');
  assert.ok(cr.text.startsWith('CREDITS'));
  for (const k of ['title', 'caption', 'credits']) {
    const s = M.defaultTextStyle(k);
    for (const key of ['font', 'size', 'bold', 'italic', 'color', 'outline', 'outlineColor', 'align', 'valign', 'opacity', 'background']) {
      assert.ok(key in s, `${k} style has ${key}`);
    }
  }
  // returned styles must be independent objects
  const a = M.defaultTextStyle('caption'); a.size = 99;
  assert.notEqual(M.defaultTextStyle('caption').size, 99);
});

await test('music item defaults', () => {
  const m = M.createMusicItem({ mediaId: 'a' });
  assert.deepEqual(
    { kind: m.kind, start: m.start, trimStart: m.trimStart, trimEnd: m.trimEnd, volume: m.volume, fadeIn: m.fadeIn, fadeOut: m.fadeOut },
    { kind: 'music', start: 0, trimStart: 0, trimEnd: null, volume: 1, fadeIn: 'none', fadeOut: 'none' },
  );
  assert.equal(M.createMusicItem({ kind: 'narration' }).kind, 'narration');
});

await test('formatTime', () => {
  assert.equal(M.formatTime(0), '00:00.00');
  assert.equal(M.formatTime(65.37), '01:05.37');
  assert.equal(M.formatTime(59.999), '01:00.00');
  assert.equal(M.formatTime(3.5), '00:03.50');
  assert.equal(M.formatTime(-4), '00:00.00');
  assert.equal(M.formatTime(NaN), '00:00.00');
  assert.equal(M.formatTime(3725.5), '62:05.50');
  close(M.parseTime('01:05.37'), 65.37);
  close(M.parseTime('7.5'), 7.5);
  assert.ok(Number.isNaN(M.parseTime('abc')));
});

const media = new Map([
  ['v10', { id: 'v10', type: 'video', duration: 10 }],
  ['v4', { id: 'v4', type: 'video', duration: 4 }],
  ['img', { id: 'img', type: 'image', duration: 0 }],
  ['a8', { id: 'a8', type: 'audio', duration: 8 }],
]);

await test('itemDuration: video trims and speed', () => {
  assert.equal(M.itemDuration(M.createVisualItem('video', { mediaId: 'v10' }), media.get('v10')), 10);
  assert.equal(M.itemDuration(M.createVisualItem('video', { mediaId: 'v10', trimStart: 2, trimEnd: 6 }), media.get('v10')), 4);
  assert.equal(M.itemDuration(M.createVisualItem('video', { mediaId: 'v10', trimStart: 2, speed: 2 }), media.get('v10')), 4);
  assert.equal(M.itemDuration(M.createVisualItem('video', { mediaId: 'v10', trimEnd: 50 }), media.get('v10')), 10);
  assert.equal(M.itemDuration(M.createVisualItem('video', { mediaId: 'zz' }), undefined), 0);
  assert.equal(M.itemDuration(M.createVisualItem('image', { mediaId: 'img', duration: 5 }), media.get('img')), 5);
  assert.equal(M.itemDuration(M.createVisualItem('title'), undefined), 7);
});

await test('computeTimeline: no transitions, sequential', () => {
  const p = M.createProject();
  p.items.push(M.createVisualItem('title', { duration: 3 }));
  p.items.push(M.createVisualItem('video', { mediaId: 'v10', trimStart: 1, trimEnd: 5 }));
  p.items.push(M.createVisualItem('image', { mediaId: 'img' }));
  const tl = M.computeTimeline(p, media);
  assert.equal(tl.segments.length, 3);
  assert.deepEqual(tl.segments.map((s) => [s.start, s.end, s.duration]), [[0, 3, 3], [3, 7, 4], [7, 14, 7]]);
  assert.equal(tl.segments[0].transitionIn, null);
  assert.equal(tl.segments[1].sourceIn, 1);
  assert.equal(tl.segments[1].sourceOut, 5);
  assert.equal(tl.segments[2].sourceIn, 0);
  assert.equal(tl.segments[2].sourceOut, 7);
  assert.deepEqual(tl.segments.map((s) => s.index), [0, 1, 2]);
  assert.equal(tl.segments[1].item, p.items[1]);
  assert.equal(tl.duration, 14);
});

await test('computeTimeline: transitions overlap & clamp', () => {
  const p = M.createProject();
  // first item's transition is ignored (i == 0)
  p.items.push(M.createVisualItem('image', { mediaId: 'img', duration: 7, transition: { type: 'crossfade', duration: 1.5 } }));
  p.items.push(M.createVisualItem('image', { mediaId: 'img', duration: 7, transition: { type: 'crossfade', duration: 1.5 } }));
  // clamp by cur.duration/2: 2/2 = 1
  p.items.push(M.createVisualItem('image', { mediaId: 'img', duration: 2, transition: { type: 'wipe-left', duration: 1.5 } }));
  // clamp by prev.duration/2: 2/2 = 1 (wanted 5)
  p.items.push(M.createVisualItem('video', { mediaId: 'v4', transition: { type: 'iris-in', duration: 5 } }));
  // 'none' → no overlap
  p.items.push(M.createVisualItem('title', { duration: 3, transition: { type: 'none', duration: 1.5 } }));
  const tl = M.computeTimeline(p, media);
  const s = tl.segments;
  assert.equal(s[0].transitionIn, null);
  close(s[0].start, 0); close(s[0].end, 7);
  assert.deepEqual(s[1].transitionIn, { type: 'crossfade', duration: 1.5 });
  close(s[1].start, 5.5); close(s[1].end, 12.5);
  assert.deepEqual(s[2].transitionIn, { type: 'wipe-left', duration: 1 });
  close(s[2].start, 11.5); close(s[2].end, 13.5);
  assert.deepEqual(s[3].transitionIn, { type: 'iris-in', duration: 1 });
  close(s[3].start, 12.5); close(s[3].end, 16.5);
  close(s[3].sourceIn, 0); close(s[3].sourceOut, 4);
  assert.equal(s[4].transitionIn, null);
  close(s[4].start, 16.5); close(s[4].end, 19.5);
  close(tl.duration, 19.5);
  // segments i+1 start at prev.end - transIn.duration
  for (let i = 1; i < s.length; i++) close(s[i].start, s[i - 1].end - (s[i].transitionIn ? s[i].transitionIn.duration : 0));
});

await test('computeTimeline: missing media → zero-length segment still present', () => {
  const p = M.createProject();
  p.items.push(M.createVisualItem('image', { mediaId: 'img', duration: 4 }));
  p.items.push(M.createVisualItem('video', { mediaId: 'gone', transition: { type: 'crossfade', duration: 1 } }));
  p.items.push(M.createVisualItem('image', { mediaId: 'img', duration: 4, transition: { type: 'crossfade', duration: 1 } }));
  const tl = M.computeTimeline(p, media);
  assert.equal(tl.segments.length, 3);
  assert.equal(tl.segments[1].duration, 0);
  assert.equal(tl.segments[1].transitionIn, null);
  close(tl.segments[1].start, 4);
  close(tl.segments[2].start, 4); // prev duration 0 → overlap clamps to 0
  close(tl.duration, 8);
});

await test('computeTimeline: texts & music extend duration, sorted', () => {
  const p = M.createProject();
  p.items.push(M.createVisualItem('image', { mediaId: 'img', duration: 5 }));
  p.texts.push(M.createTextItem('caption', { start: 4, duration: 3 }));
  p.texts.push(M.createTextItem('caption', { start: 1, duration: 1 }));
  p.music.push(M.createMusicItem({ mediaId: 'a8', start: 2 }));
  p.music.push(M.createMusicItem({ mediaId: 'a8', start: 0, trimStart: 1, trimEnd: 3 }));
  const tl = M.computeTimeline(p, media);
  assert.deepEqual(tl.texts.map((t) => [t.start, t.end]), [[1, 2], [4, 7]]);
  assert.deepEqual(tl.music.map((m) => [m.start, m.end]), [[0, 2], [2, 10]]);
  close(tl.duration, 10);
  // mediaMap as a plain object also works
  const tl2 = M.computeTimeline(p, Object.fromEntries(media));
  close(tl2.duration, 10);
  // empty project
  const e = M.computeTimeline(M.createProject(), new Map());
  assert.deepEqual(e, { duration: 0, segments: [], texts: [], music: [] });
});

await test('segmentIndexAt', () => {
  const p = M.createProject();
  p.items.push(M.createVisualItem('image', { duration: 4 }));
  p.items.push(M.createVisualItem('image', { duration: 4, transition: { type: 'crossfade', duration: 1 } }));
  const tl = M.computeTimeline(p, media);
  assert.equal(M.segmentIndexAt(tl, 0), 0);
  assert.equal(M.segmentIndexAt(tl, 3.5), 1);
  assert.equal(M.segmentIndexAt(tl, 7), 1);
  assert.equal(M.segmentIndexAt(tl, 9), -1);
});

await test('normalizeProject repairs partial / duplicate data', () => {
  const raw = {
    id: 'p1', name: 'X', aspect: 'bogus', items: [{ kind: 'video', id: 'a', mediaId: 'v10' }, { kind: 'image', id: 'a' }, null],
    texts: [{ kind: 'credits' }], music: [{ mediaId: 'a8', volume: 7 }],
  };
  const p = M.normalizeProject(raw);
  assert.equal(p.id, 'p1');
  assert.equal(p.aspect, '16:9');
  assert.equal(p.items.length, 2);
  assert.notEqual(p.items[0].id, p.items[1].id);
  assert.equal(p.items[1].transition.type, 'none');
  assert.equal(p.texts[0].effect, 'scroll');
  assert.equal(p.music[0].volume, 1);
  assert.throws(() => M.normalizeProject(null));
});

// ---------------- store ----------------
await test('Store defaults', () => {
  const s = new Store();
  assert.ok(s instanceof EventTarget);
  assert.equal(s.project.name, 'My Movie');
  assert.ok(s.media instanceof Map);
  assert.deepEqual(s.selection, { type: null, ids: [] });
  assert.deepEqual(s.view, { zoom: 40, thumbSize: 'medium', showWaveforms: true, previewSize: 'normal' });
  assert.equal(s.canUndo, false);
  assert.equal(s.canRedo, false);
  assert.equal(s.timeline.duration, 0);
});

await test('update / undo / redo with events and timeline cache', () => {
  const s = new Store();
  const labels = [];
  s.addEventListener('change', (e) => labels.push(e.detail.label));
  const tl0 = s.timeline;
  assert.equal(s.timeline, tl0, 'timeline cached');
  s.update((p) => { p.items.push(M.createVisualItem('title', { duration: 3 })); }, { label: 'Add title' });
  assert.notEqual(s.timeline, tl0, 'timeline invalidated');
  assert.equal(s.timeline.duration, 3);
  s.update((p) => { p.items.push(M.createVisualItem('title', { duration: 4 })); }, { label: 'Add title 2' });
  assert.equal(s.timeline.duration, 7);
  assert.ok(s.canUndo);
  assert.equal(s.undo(), true);
  assert.equal(s.project.items.length, 1);
  assert.equal(s.timeline.duration, 3);
  assert.ok(s.canRedo);
  s.undo();
  assert.equal(s.project.items.length, 0);
  assert.equal(s.canUndo, false);
  assert.equal(s.undo(), false);
  s.redo(); s.redo();
  assert.equal(s.project.items.length, 2);
  assert.equal(s.timeline.duration, 7);
  assert.equal(s.redo(), false);
  assert.deepEqual(labels, ['Add title', 'Add title 2', 'undo', 'undo', 'redo', 'redo']);
  // new edit clears redo
  s.undo();
  s.update((p) => { p.name = 'Renamed'; }, { label: 'rename' });
  assert.equal(s.canRedo, false);
});

await test('undo snapshot is isolated from later mutations', () => {
  const s = new Store();
  s.update((p) => { p.items.push(M.createVisualItem('title', { text: 'A' })); });
  s.update((p) => { p.items[0].text = 'B'; p.items[0].style.size = 20; });
  s.undo();
  assert.equal(s.project.items[0].text, 'A');
  assert.equal(s.project.items[0].style.size, M.defaultTextStyle('title').size);
});

await test('coalesceKey merges rapid updates into one undo step', async () => {
  const s = new Store();
  s.update((p) => { p.items.push(M.createVisualItem('image', { duration: 5 })); });
  for (let i = 1; i <= 10; i++) s.update((p) => { p.items[0].brightness = i * 5; }, { label: 'Brightness', coalesceKey: 'bright' });
  assert.equal(s.project.items[0].brightness, 50);
  s.undo();
  assert.equal(s.project.items[0].brightness, 0, 'single undo reverts the whole slider drag');
  assert.equal(s.project.items.length, 1);
  // a different key or a gap > 800ms starts a new step
  s.update((p) => { p.items[0].brightness = 10; }, { coalesceKey: 'bright' });
  s.update((p) => { p.items[0].duration = 2; }, { coalesceKey: 'dur' });
  s.update((p) => { p.items[0].brightness = 20; }, { coalesceKey: 'bright' });
  s.undo();
  assert.equal(s.project.items[0].brightness, 10);
  assert.equal(s.project.items[0].duration, 2);
  s.update((p) => { p.items[0].brightness = 30; }, { coalesceKey: 'b2' });
  await sleep(COALESCE_MS + 60);
  s.update((p) => { p.items[0].brightness = 40; }, { coalesceKey: 'b2' });
  s.undo();
  assert.equal(s.project.items[0].brightness, 30);
  // an un-keyed update between same-key updates breaks the chain
  s.update((p) => { p.items[0].brightness = 1; }, { coalesceKey: 'k' });
  s.update((p) => { p.name = 'n'; });
  s.update((p) => { p.items[0].brightness = 2; }, { coalesceKey: 'k' });
  s.undo();
  assert.equal(s.project.items[0].brightness, 1);
});

await test('undo stack is capped at 100', () => {
  const s = new Store();
  for (let i = 0; i < 130; i++) s.update((p) => { p.name = `n${i}`; });
  let n = 0;
  while (s.undo()) n++;
  assert.equal(n, 100);
  assert.equal(s.project.name, 'n29');
});

await test('mutator error rolls back and rethrows', () => {
  const s = new Store();
  s.update((p) => { p.items.push(M.createVisualItem('title')); });
  assert.throws(() => s.update((p) => { p.items.length = 0; throw new Error('boom'); }), /boom/);
  assert.equal(s.project.items.length, 1);
  s.undo();
  assert.equal(s.project.items.length, 0);
});

await test('selection, pruning, find, selectedItems', () => {
  const s = new Store();
  const a = M.createVisualItem('title');
  const b = M.createVisualItem('title');
  const c = M.createTextItem('caption');
  const m = M.createMusicItem({ mediaId: 'x' });
  s.update((p) => { p.items.push(a, b); p.texts.push(c); p.music.push(m); });
  const sel = [];
  s.addEventListener('selection', (e) => sel.push(e.detail));
  s.select('item', [b.id, a.id]);
  assert.deepEqual(s.selection, { type: 'item', ids: [b.id, a.id] });
  assert.deepEqual(s.selectedItems().map((x) => x.id), [a.id, b.id], 'storyboard order');
  s.select('item', [b.id, a.id]); // no-op → no event
  assert.equal(sel.length, 1);
  s.select('text', c.id);
  assert.deepEqual(s.selectedItems(), [c]);
  s.select('item', 'nope');
  assert.deepEqual(s.selection, { type: null, ids: [] });
  assert.deepEqual(s.find(a.id), { type: 'item', obj: a, index: 0 });
  assert.deepEqual(s.find(c.id), { type: 'text', obj: c, index: 0 });
  assert.deepEqual(s.find(m.id), { type: 'music', obj: m, index: 0 });
  assert.equal(s.find('zzz'), null);
  // removal prunes selection
  s.select('item', [a.id, b.id]);
  const before = sel.length;
  s.update((p) => { p.items.splice(0, 1); }, { label: 'Remove' });
  assert.deepEqual(s.selection, { type: 'item', ids: [b.id] });
  assert.equal(sel.length, before + 1);
  s.update((p) => { p.items.length = 0; });
  assert.deepEqual(s.selection, { type: null, ids: [] });
  // undo restores selection that was active before the removal
  s.undo();
  assert.deepEqual(s.selection, { type: 'item', ids: [b.id] });
});

await test('media add/remove/get and events', () => {
  const s = new Store();
  const ev = [];
  s.addEventListener('media', (e) => ev.push(e.detail));
  s.update((p) => { p.items.push(M.createVisualItem('video', { mediaId: 'v' })); });
  assert.equal(s.timeline.duration, 0);
  s.addMedia({ id: 'v', type: 'video', duration: 6, url: '' });
  assert.equal(s.timeline.duration, 6, 'timeline recomputed after media added');
  assert.equal(s.getMedia('v').duration, 6);
  assert.equal(s.removeMedia('v'), true);
  assert.equal(s.getMedia('v'), undefined);
  assert.equal(s.removeMedia('v'), false);
  assert.equal(ev.length, 2);
});

await test('replaceProject clears history and normalizes', () => {
  const s = new Store();
  s.update((p) => { p.name = 'old'; });
  s.select('item', []);
  const labels = [];
  s.addEventListener('change', (e) => labels.push(e.detail.label));
  const p = { id: 'loaded', name: 'Loaded', items: [{ kind: 'title', text: 'Hi' }] };
  s.replaceProject(p, new Map([['m', { id: 'm', duration: 1 }]]));
  assert.equal(s.project, p, 'keeps identity');
  assert.equal(s.project.items[0].transition.type, 'none');
  assert.equal(s.project.texts.length, 0);
  assert.equal(s.canUndo, false);
  assert.equal(s.media.get('m').duration, 1);
  assert.deepEqual(labels, ['load']);
  s.replaceProject(null);
  assert.equal(s.project.name, 'My Movie');
});

await test('setView validates and emits', () => {
  const s = new Store();
  const ev = [];
  s.addEventListener('view', (e) => ev.push(e.detail));
  s.setView({ zoom: 1000 });
  assert.equal(s.view.zoom, 400);
  s.setView({ thumbSize: 'huge' });
  assert.equal(s.view.thumbSize, 'medium');
  s.setView({ thumbSize: 'large', showWaveforms: false });
  assert.equal(s.view.thumbSize, 'large');
  assert.equal(s.view.showWaveforms, false);
  s.setView({ zoom: 400 }); // unchanged → no event
  assert.equal(ev.length, 2);
});

await test('listener exceptions do not break the store', async () => {
  const s = new Store();
  // node reports EventTarget listener errors as uncaught exceptions on the next tick
  // (browsers report them to window.onerror); either way the dispatch must not abort the update.
  const caught = [];
  const handler = (err) => caught.push(err);
  process.on('uncaughtException', handler);
  s.addEventListener('change', () => { throw new Error('listener'); });
  try {
    s.update((p) => { p.name = 'ok'; });
    await sleep(20);
  } finally { process.off('uncaughtException', handler); }
  assert.equal(s.project.name, 'ok');
  assert.ok(s.canUndo);
  assert.equal(caught.length, 1);
});

// ---------------- persist: project file format (node has Blob/File/TextDecoder) ----------------
const P = await import('../js/persist.js');

await test('exportProjectFile/importProjectFile round trip (binary-safe, multi-chunk)', async () => {
  const project = M.createProject('Trip "data":"x" ünïcödé 🎬');
  project.items.push(M.createVisualItem('video', { mediaId: 'mv' }));
  project.items.push(M.createVisualItem('title', { text: '"data":"not a blob"\nline2' }));
  project.music.push(M.createMusicItem({ mediaId: 'ma' }));
  const big = new Uint8Array(5 * 1024 * 1024 + 7);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 255;
  const small = new Uint8Array([0, 1, 2, 255, 254, 34, 92, 10]);
  const media = new Map([
    ['mv', { id: 'mv', type: 'video', name: 'clip "1".webm', mime: 'video/webm', blob: new Blob([big], { type: 'video/webm' }),
      url: '', duration: 4, width: 640, height: 360, hasAudio: true, thumb: 'data:image/jpeg;base64,AAAA', filmstrip: ['data:image/jpeg;base64,BBBB'], peaks: [0, 0.5, 1] }],
    ['ma', { id: 'ma', type: 'audio', name: 'música.ogg', mime: 'audio/ogg', blob: new Blob([small], { type: 'audio/ogg' }),
      url: '', duration: 8, width: 0, height: 0, hasAudio: true, thumb: '', filmstrip: [], peaks: null }],
    ['unused', { id: 'unused', type: 'image', name: 'x.png', mime: 'image/png', blob: new Blob([small]), url: '', duration: 0 }],
  ]);
  const progress = [];
  const blob = await P.exportProjectFile(project, media, { onProgress: (p) => progress.push(p) });
  assert.ok(blob.size > big.length * 4 / 3);
  assert.equal(progress[progress.length - 1], 1);
  // it is valid JSON
  const parsed = JSON.parse(await blob.text());
  assert.equal(parsed.format, 'wlmmweb');
  assert.equal(parsed.media.length, 2, 'only referenced media exported');
  const file = new File([blob], 'Trip.wlmmweb');
  const res = await P.importProjectFile(file);
  assert.equal(res.project.name, project.name);
  assert.equal(res.project.items[1].text, project.items[1].text);
  assert.equal(res.project.items.length, 2);
  assert.equal(res.media.size, 2);
  const mv = res.media.get('mv');
  assert.equal(mv.name, 'clip "1".webm');
  assert.equal(mv.blob.type, 'video/webm');
  assert.deepEqual(mv.peaks, [0, 0.5, 1]);
  assert.ok(mv.url.startsWith('blob:'));
  const got = new Uint8Array(await mv.blob.arrayBuffer());
  assert.equal(got.length, big.length);
  let same = true;
  for (let i = 0; i < got.length; i++) if (got[i] !== big[i]) { same = false; break; }
  assert.ok(same, 'video bytes identical');
  assert.deepEqual([...new Uint8Array(await res.media.get('ma').blob.arrayBuffer())], [...small]);
  assert.equal(res.media.get('ma').name, 'música.ogg');
});

await test('importProjectFile rejects junk with a friendly error', async () => {
  await assert.rejects(P.importProjectFile(new File(['hello world'], 'x.txt')), (e) => e.name === 'PersistError' && /isn't a Movie Maker project/.test(e.message));
  await assert.rejects(P.importProjectFile(new File(['{"format":"other","project":{}}'], 'x.json')), (e) => e.friendly === true);
  await assert.rejects(P.importProjectFile(null), (e) => e.friendly === true);
});

await test('undo / redo stamp a new modification time', async () => {
  const s = new Store();
  s.update((p) => { p.name = 'A'; });
  await sleep(5);
  s.update((p) => { p.name = 'B'; });
  await sleep(5);
  const before = Date.now();
  s.undo();
  assert.equal(s.project.name, 'A');
  assert.ok(s.project.updatedAt >= before, 'undo does not go back in time');
  await sleep(5);
  const before2 = Date.now();
  s.redo();
  assert.equal(s.project.name, 'B');
  assert.ok(s.project.updatedAt >= before2, 'redo does not go back in time');
});

await test('changing the selection ends slider coalescing', () => {
  const s = new Store();
  const a = M.createVisualItem('image');
  const b = M.createVisualItem('image');
  s.update((p) => { p.items.push(a, b); });
  const n = s._undo.length;
  s.select('item', a.id);
  s.update((p) => { p.items[0].brightness = 40; }, { coalesceKey: 'brightness' });
  s.select('item', a.id); // same selection: still one drag
  s.update((p) => { p.items[0].brightness = 50; }, { coalesceKey: 'brightness' });
  assert.equal(s._undo.length, n + 1);
  s.select('item', b.id);
  s.update((p) => { p.items[1].brightness = -30; }, { coalesceKey: 'brightness' });
  assert.equal(s._undo.length, n + 2, 'edit on another item is its own undo step');
  s.undo();
  assert.equal(s.project.items[0].brightness, 50, 'undo keeps the first item');
  assert.equal(s.project.items[1].brightness, 0);
});

await test('mediaInUse: project, undo/redo history and clipboard', () => {
  const s = new Store();
  const item = (id) => M.createVisualItem('image', { mediaId: id });
  s.update((p) => { p.items.push(item('m1'), item('m2')); p.music.push(M.createMusicItem({ mediaId: 'm3' })); });
  s.update((p) => { p.items = p.items.filter((i) => i.mediaId !== 'm2'); });
  assert.deepEqual([...s.mediaInUse()].sort(), ['m1', 'm2', 'm3'], 'm2 is still in the undo history');
  s.update((p) => { p.items.push(item('m4')); });
  s.undo();
  assert.ok(s.mediaInUse().has('m4'), 'redo can bring m4 back');
  s.clipboard = { type: 'item', objs: [item('m5')], media: [{ id: 'm6' }] };
  assert.ok(s.mediaInUse().has('m5') && s.mediaInUse().has('m6'), 'clipboard');
  s.replaceProject(M.createProject());
  s.clipboard = null;
  assert.equal(s.mediaInUse().size, 0, 'a loaded project has no history');
});

await test('IndexedDB unavailable → friendly errors, never crashes', async () => {
  await assert.rejects(P.saveProject(M.createProject(), new Map()), (e) => e.friendly && /IndexedDB|storage|private/i.test(e.message));
  await assert.rejects(P.listProjects(), (e) => e.friendly);
  await assert.rejects(P.loadProject('x'), (e) => e.friendly);
  assert.equal(await P.getLastProjectId(), null);
  await P.setLastProjectId('x'); // no localStorage in node: silently ignored
  assert.equal(P.projectFileName({ name: 'a/b:c' }), 'a b c.wlmmweb');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
