// Node unit tests for the pure storyboard layout math (StripLayout, packLanes).
// Run: node tests/storyboard.unit.mjs
import assert from 'node:assert/strict';
import { StripLayout, packLanes, thumbLook } from '../js/ui/storyboard.js';
import { computeTimeline, createProject, createVisualItem, createTextItem, createMusicItem } from '../js/model.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  -', name); } catch (err) { console.error('FAIL -', name); console.error(err); process.exitCode = 1; }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function project(items, texts = [], music = []) {
  const p = createProject('t');
  p.items = items; p.texts = texts; p.music = music;
  return p;
}
const media = new Map([
  ['v1', { id: 'v1', type: 'video', duration: 4, width: 640, height: 360 }],
  ['a1', { id: 'a1', type: 'audio', duration: 8 }],
]);

test('linear mapping without transitions (phone, no rows)', () => {
  const p = project([
    createVisualItem('video', { mediaId: 'v1' }),
    createVisualItem('image', { duration: 7 }),
    createVisualItem('title', { duration: 3 }),
  ]);
  const tl = computeTimeline(p, media);
  const L = new StripLayout({ timeline: tl, zoom: 10, gap: 4, minWidth: 20 });
  assert.equal(L.n, 3);
  assert.ok(near(L.x0[0], 0) && near(L.x1[0], 40));
  assert.ok(near(L.x0[1], 44) && near(L.x1[1], 114));
  assert.ok(near(L.x0[2], 118) && near(L.x1[2], 148));
  assert.ok(near(L.timeToX(2), 20));
  assert.ok(near(L.timeToX(4), 44)); // boundary belongs to the incoming item
  assert.ok(near(L.timeToX(5), 54));
  assert.ok(near(L.xToTime(54), 5));
  assert.ok(near(L.xToTime(42), 4)); // gap maps to the boundary time
  assert.ok(near(L.timeToX(16), 168)); // after the visuals (14s, 148px): continue at zoom
  assert.ok(near(L.xToTime(168), 16));
});

test('round trip time → x → time inside items', () => {
  const p = project([
    createVisualItem('image', { duration: 5 }),
    createVisualItem('image', { duration: 5, transition: { type: 'crossfade', duration: 2 } }),
    createVisualItem('image', { duration: 0.2 }),
    createVisualItem('image', { duration: 6 }),
  ]);
  const tl = computeTimeline(p, media);
  const L = new StripLayout({ timeline: tl, zoom: 37, gap: 4, minWidth: 28 });
  for (let t = 0; t < tl.duration; t += 0.13) {
    const x = L.timeToX(t);
    assert.ok(near(L.xToTime(x), t, 1e-6), `t=${t} x=${x} back=${L.xToTime(x)}`);
  }
  // transition overlap belongs to the incoming item: item 1 starts at 3s
  assert.ok(near(L.t0[1], 3) && near(L.t1[0], 3));
  // minimum width for the 0.2s item
  assert.ok(near(L.x1[2] - L.x0[2], 28));
});

test('desktop rows: items avoid tiny slivers at a row end', () => {
  const p = project([
    createVisualItem('image', { duration: 9.7 }), // 97px of a 100px row
    createVisualItem('image', { duration: 5 }),   // would leave a 3px sliver → next row
    createVisualItem('image', { duration: 30 }),  // longer than a row → split
  ]);
  const tl = computeTimeline(p, media);
  const L = new StripLayout({ timeline: tl, zoom: 10, rowWidth: 100, gap: 0, minWidth: 10, sliver: 20 });
  assert.ok(near(L.x0[1], 100), `x0[1]=${L.x0[1]}`);
  const pieces = [];
  L.spans(L.x0[2], L.x1[2], (row, rx, w, off) => pieces.push([row, rx, w, off]));
  assert.deepEqual(pieces.map((q) => q[0]), [1, 2, 3, 4]);
  assert.deepEqual(pieces.map((q) => Math.round(q[2] * 1000) / 1000), [50, 100, 100, 50]);
  const total = pieces.reduce((s, q) => s + q[2], 0);
  assert.ok(near(total, 300));
  assert.ok(near(pieces[0][3], 0));
  // time ↔ x continuity across the pushed boundary
  assert.ok(near(L.timeToX(9.7), 100));
  assert.ok(near(L.xToTime(98.5), 9.7));
});

test('insertion index', () => {
  const p = project([createVisualItem('image', { duration: 2 }), createVisualItem('image', { duration: 2 }), createVisualItem('image', { duration: 2 })]);
  const L = new StripLayout({ timeline: computeTimeline(p, media), zoom: 10, gap: 0, minWidth: 1 });
  assert.equal(L.insertionIndexAt(-5), 0);
  assert.equal(L.insertionIndexAt(5), 0);
  assert.equal(L.insertionIndexAt(15), 1);
  assert.equal(L.insertionIndexAt(29), 1);
  assert.equal(L.insertionIndexAt(31), 2);
  assert.equal(L.insertionIndexAt(55), 3);
});

test('empty timeline maps linearly', () => {
  const p = project([], [createTextItem('caption', { start: 2, duration: 3 })], [createMusicItem({ mediaId: 'a1', start: 1 })]);
  const tl = computeTimeline(p, media);
  const L = new StripLayout({ timeline: tl, zoom: 20 });
  assert.equal(L.n, 0);
  assert.ok(near(L.timeToX(3), 60));
  assert.ok(near(L.xToTime(60), 3));
  assert.ok(near(L.endX, 9 * 20));
});

test('lane packing', () => {
  const mk = (id, start, end) => ({ item: { id }, start, end });
  const r = packLanes([mk('a', 0, 5), mk('b', 3, 6), mk('c', 5, 9), mk('d', 5.5, 7), mk('e', 9, 10)]);
  assert.equal(r.count, 3);
  assert.equal(r.lanes.get('a'), 0);
  assert.equal(r.lanes.get('b'), 1);
  assert.equal(r.lanes.get('c'), 0);
  assert.equal(r.lanes.get('d'), 2);
  assert.equal(r.lanes.get('e'), 0);
});

test('thumbnail look for visual effects and brightness', () => {
  assert.deepEqual(thumbLook('none', 0), { filter: '', mirror: '', badge: false });
  assert.equal(thumbLook('sepia', 0).filter, 'sepia(1)');
  assert.match(thumbLook('bw-orange', 0).filter, /grayscale\(1\)/);
  assert.equal(thumbLook(null, 50).filter, 'brightness(1.5)');
  assert.equal(thumbLook('invert', -100).filter, 'invert(1) brightness(0.15)');
  assert.deepEqual(thumbLook('mirror-h', 0), { filter: '', mirror: 'scaleX(-1)', badge: false });
  assert.equal(thumbLook('fade-in-black', 0).badge, true);
  assert.equal(thumbLook('pixelate', 0).badge, true);
  assert.equal(thumbLook('sepia', 0).badge, false);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
