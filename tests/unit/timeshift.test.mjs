import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeshift, SourceMap, GridMap, GUARD } from '../../engine/timeshift.js';

/** Fake stretch node enforcing the real node's rule: a schedule() drops changes at/after currentTime. */
function fakeNode(clock) {
  const n = {
    sent: [], dropped: [], buffers: 0, drops: [],
    schedule(seg) {
      const pendingFuture = n.sent.filter((s) => s.output >= clock.now && !s.done);
      for (const s of pendingFuture) { s.done = true; n.dropped.push(s); }
      const stored = { ...seg };
      n.sent.push(stored);
      return Promise.resolve({ ...stored });
    },
    addBuffers(arr) { n.buffers += arr[0].length; return Promise.resolve(n.buffers / 48000); },
    dropBuffers(t) { n.drops.push(t); return Promise.resolve({ start: Math.floor(t * 10) / 10, end: n.buffers / 48000 }); },
  };
  return n;
}
const mk = (o = {}) => {
  const clock = { now: 0 };
  const node = fakeNode(clock);
  const ts = new Timeshift(node, { sampleRate: 48000, latency: 0.12, outLatency: 0.06, ...o });
  return { clock, node, ts };
};
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const chunk = (sec) => [new Float32Array(Math.round(sec * 48000)), new Float32Array(Math.round(sec * 48000))];

test('starts paused at input 0 and tracks the live edge', () => {
  const { ts } = mk();
  assert.equal(ts.posAt(5), 0);
  assert.equal(ts.playingAt(5), false);
  ts.append(...chunk(2));
  assert.ok(near(ts.liveEdge, 2));
  assert.ok(near(ts.reserveAt(0), 2 - 0.12));
});

test('play, rate change and explicit inputs follow p(t) = input + rate·(t − output)', () => {
  const { ts, node, clock } = mk();
  ts.append(...chunk(30));
  ts.change(0, 1, { active: true, input: 0, rate: 1 });
  assert.ok(near(ts.posAt(3), 2));
  clock.now = 1.5;
  ts.change(1.5, 2, { rate: 1.03 });
  assert.ok(near(node.sent[1].input, 1), 'explicit input = model position');
  assert.ok(near(ts.posAt(4), 1 + 2 * 1.03));
  assert.equal(node.dropped.length, 0);
});

test('only one change is pending in the node: bend end waits in the queue', () => {
  const { ts, node, clock } = mk();
  ts.append(...chunk(30));
  ts.change(0, 0.2, { active: true, input: 0, rate: 1 });
  clock.now = 1;
  const end = ts.bend(1, 1.2, 1.04, 0.5);
  assert.ok(near(end, 1.7));
  assert.equal(node.sent.length, 2, 'only the bend start is sent');
  clock.now = 1.1; ts.flush(1.1);
  assert.equal(node.sent.length, 2, 'end not sent while the start is pending');
  clock.now = 1.21; ts.flush(1.21);
  assert.equal(node.sent.length, 3);
  const last = node.sent[2];
  assert.ok(near(last.output, 1.7) && near(last.rate, 1));
  assert.ok(near(last.input, 1.0 + 0.5 * 1.04), 'end input continues the bent segment');
  assert.ok(near(ts.posAt(2.7), 1.52 + 1), 'shift of 0.02 s kept after the bend');
  assert.equal(node.dropped.length, 0);
});

test('a new change cancels a queued bend end and restarts from the model', () => {
  const { ts, node, clock } = mk();
  ts.append(...chunk(30));
  ts.change(0, 0.2, { active: true, input: 0, rate: 1 });
  clock.now = 1;
  ts.bend(1, 1.2, 1.04, 0.5);
  clock.now = 1.3;
  ts.change(1.3, 1.45, { rate: 1.02 });
  clock.now = 2; ts.flush(2);
  assert.equal(node.sent.length, 3, 'queued bend end discarded');
  assert.ok(near(node.sent[2].input, 1.0 + 0.25 * 1.04));
});

test('pause is sent outLatency early but the model freezes at the requested time', () => {
  const { ts, node } = mk();
  ts.append(...chunk(30));
  ts.change(0, 0.5, { active: true, input: 3, rate: 1 });
  ts.flush(0.6);
  ts.change(0.6, 2, { active: false });
  const sent = node.sent[node.sent.length - 1];
  assert.ok(near(sent.output, 2 - 0.06));
  assert.equal(sent.active, false);
  assert.ok(near(ts.posAt(5), 4.5));
  assert.equal(ts.playingAt(5), false);
});

test('loops wrap the model position', () => {
  const { ts } = mk();
  ts.append(...chunk(30));
  ts.change(0, 1, { active: true, input: 10, rate: 1 });
  ts.change(1.1, 1.2, { loopStart: 10, loopEnd: 10.5 });
  assert.ok(near(ts.posAt(1.2), 10.2));
  assert.ok(near(ts.posAt(1.6), 10.1));
  assert.ok(near(ts.posAt(2.45), 10.45));
  ts.change(2.5, 2.6, { input: 11.6, loopStart: 0, loopEnd: 0 });
  assert.ok(near(ts.posAt(3.6), 12.6));
});

test('inputs are clamped into the buffered range', () => {
  const { ts } = mk();
  ts.append(...chunk(10));
  assert.ok(near(ts.clampInput(50), 10 - 0.12 - 0.3));
  assert.ok(near(ts.clampInput(-3), 0.01));
});

test('reserve and soon()', () => {
  const { ts } = mk();
  ts.append(...chunk(10));
  ts.change(0, 1, { active: true, input: 0, rate: 1.5 });
  assert.ok(near(ts.reserveAt(3), 10 - 3 - 0.12));
  assert.ok(near(ts.soon(2), 2.15));
  assert.equal(ts.reserveAt(100), 0);
  assert.ok(GUARD >= 0.4);
});

test('trim keeps at most capSec and reports the new start', async () => {
  const { ts, node } = mk({ capSec: 20 });
  ts.append(...chunk(30));
  const r = await ts.trim(0, 0);
  assert.equal(r.dropped, true);
  assert.ok(near(node.drops[0], 10));
  assert.ok(near(ts.historyStart, 10));
  const r2 = await ts.trim(0, 5);
  assert.equal(r2.dropped, false);
});

test('trim never drops past the limit it is given, even over the cap', async () => {
  const { ts, node } = mk({ capSec: 20 });
  ts.append(...chunk(30));
  const r = await ts.trim(0, 0, 6);
  assert.equal(r.dropped, true);
  assert.ok(near(node.drops[0], 6), `dropped to ${node.drops[0]}`);
  assert.ok(ts.historyStart <= 6);
  const r2 = await ts.trim(0, 0, 6.5);
  assert.equal(r2.dropped, false, 'less than a second to gain');
});

test('extend() moves the live edge for audio the input worklet handed to the node directly', async () => {
  const { ts, node } = mk({ capSec: 20 });
  ts.append(...chunk(1));
  for (let i = 0; i < 680; i++) ts.extend(2048);
  assert.equal(node.buffers, 48000, 'extend() sends the node nothing');
  assert.ok(near(ts.liveEdge, 1 + (680 * 2048) / 48000, 1e-9), `live edge ${ts.liveEdge}`);
  assert.ok(near(ts.reserveAt(0), ts.liveEdge - 0.12));
  const r = await ts.trim(0, 0); // the cap counts from the extended edge
  assert.equal(r.dropped, true);
  assert.ok(near(node.drops[0], ts.liveEdge - 20), `dropped to ${node.drops[0]}`);
});

test('SourceMap and GridMap are piecewise along the input timeline', () => {
  const sm = new SourceMap();
  assert.equal(sm.rateAt(5), 1);
  sm.set(10, 1.0025);
  sm.set(10.25, 1.005);
  assert.equal(sm.rateAt(9.99), 1);
  assert.equal(sm.rateAt(10.1), 1.0025);
  assert.equal(sm.rateAt(11), 1.005);
  assert.deepEqual(sm.nextChangeAfter(10.1), { inPos: 10.25, rate: 1.005 });
  assert.equal(sm.nextChangeAfter(10.25), null);
  sm.prune(10.3);
  assert.equal(sm.rateAt(0), 1.005);

  const gm = new GridMap();
  assert.equal(gm.at(3), null);
  gm.update({ t0: 1, T: 0.5, bar1: null });
  assert.deepEqual(gm.at(3), { t0: 1, T: 0.5, bar1: null });
  gm.split(10, { t0: 10.1, T: 0.49, bar1: null });
  assert.deepEqual(gm.at(5), { t0: 1, T: 0.5, bar1: null });
  assert.deepEqual(gm.at(12), { t0: 10.1, T: 0.49, bar1: null });
  gm.update({ t0: 10.12, T: 0.488, bar1: null });
  assert.equal(gm.at(12).T, 0.488);
  assert.equal(gm.at(5).T, 0.5);
  gm.prune(11);
  assert.equal(gm.at(5).T, 0.488);
});

test('GridMap keeps an old track\'s grid behind a new track, and edits stay within a track', () => {
  const sm = new SourceMap();
  const rateAt = (x) => sm.rateAt(x);
  const gm = new GridMap();
  const A = { t0: 1, T: 0.5, bar1: 3 };
  gm.update(A, { n: 0, from: 0, prev: null });
  sm.set(40, 1.02);
  gm.split(40, { t0: 39.5, T: 0.5 / 1.02, bar1: 3 });
  sm.set(50, 1.04);
  gm.split(50, { t0: 49.9, T: 0.5 / 1.04, bar1: 3 });
  // The tracker accepts a 100 BPM track that started at 45 s (between the two assist steps).
  const B = { t0: 60.3, T: 0.6 / 1.04, bar1: null };
  gm.update(B, { n: 1, from: 45, prev: { t0: 39.5, T: 0.5 / 1.02, bar1: 3 } }, rateAt);
  assert.equal(gm.at(30).T, 0.5, 'the old track before the steps');
  assert.deepEqual(gm.at(44), { t0: 39.5, T: 0.5 / 1.02, bar1: 3 }, 'the old track up to where the new one starts');
  assert.equal(gm.trackAt(44), 0);
  assert.equal(gm.trackAt(46), 1);
  // The new track's grid is carried back across the 50 s step at the source rate there.
  assert.ok(Math.abs(gm.at(46).T - 0.6 / 1.02) < 1e-12, `T before the step ${gm.at(46).T}`);
  assert.deepEqual(gm.at(55), B);
  const ph = (g, x) => { const b = (x - g.t0) / g.T; return b - Math.floor(b); };
  assert.ok(Math.abs(ph(gm.at(49.99999), 50) - ph(gm.at(50), 50)) < 1e-6, 'beat phase continuous across the step');
  // Manual edits stay within one track.
  gm.editTrack(gm.trackAt(44), (g) => ({ ...g, t0: g.t0 + 0.1 }));
  assert.equal(gm.at(30).t0, 1.1);
  assert.equal(gm.at(55).t0, 60.3);
  // Retiming the new track from its first segment carries forward too.
  gm.retime(46, { t0: 46.2, T: 0.6 }, rateAt);
  assert.ok(Math.abs(gm.at(55).T - (0.6 * 1.02) / 1.04) < 1e-12);
  assert.equal(gm.at(44).t0, 39.6, 'the old track is untouched');
  gm.prune(47);
  assert.equal(gm.trackAt(0), 1);
  assert.equal(gm.at(0).t0, 46.2);
});

test('GridMap splits at a capture gap: the audio before it keeps its grid, and edits keep the jump', () => {
  const gm = new GridMap();
  const track = { n: 0, from: 0, prev: null, jump: null };
  const beatNear = (g, x) => g.t0 + Math.round((x - g.t0) / g.T) * g.T;
  gm.update({ t0: 1, T: 0.5, bar1: null }, track);
  // The tracker re-phased 15 ms early after a gap at 20.2 s; before it, the grid stood at prev.
  track.jump = { n: 0, from: 20.2, prev: { t0: 19.5, T: 0.5, bar1: null } };
  gm.update({ t0: 25.485, T: 0.5, bar1: null }, track);
  assert.deepEqual(gm.at(12), { t0: 19.5, T: 0.5, bar1: null }, 'before the gap');
  assert.deepEqual(gm.at(21), { t0: 25.485, T: 0.5, bar1: null }, 'after the gap');
  assert.equal(gm.trackAt(21), 0, 'same track');
  // The live grid moves on after the gap only; the same jump never splits again.
  gm.update({ t0: 26.4851, T: 0.5, bar1: null }, track);
  assert.equal(gm.segs.length, 2);
  assert.equal(gm.at(12).t0, 19.5);
  assert.equal(gm.at(21).t0, 26.4851);
  const jumpAt = (x) => beatNear(gm.at(x + 1e-6), x) - beatNear(gm.at(x - 1e-6), x);
  assert.ok(Math.abs(jumpAt(20.2) + 0.015) < 2e-4, `jump ${jumpAt(20.2)}`);
  // GRID shift, ½×/2× and TAP 1 edit both sides.
  gm.editTrack(0, (g) => ({ ...g, t0: g.t0 + 0.01, bar1: 3 }));
  assert.equal(gm.at(12).t0, 19.51);
  assert.equal(gm.at(21).bar1, 3);
  assert.ok(Math.abs(jumpAt(20.2) + 0.015) < 2e-4);
  // TAP before the gap carries the tapped grid across it, jump kept.
  gm.retime(12, { t0: 12.02, T: 0.48 }, () => 1);
  assert.equal(gm.at(12).t0, 12.02);
  assert.equal(gm.at(21).T, 0.48);
  assert.ok(Math.abs(jumpAt(20.2) + 0.015) < 2e-4, `jump after TAP ${jumpAt(20.2)}`);
  // ... and TAP after it carries back, jump kept.
  gm.retime(21, { t0: 21.3, T: 0.5 }, () => 1);
  assert.ok(Math.abs(jumpAt(20.2) + 0.015) < 2e-4, `jump after a later TAP ${jumpAt(20.2)}`);
  // Once the audio before the gap is dropped, its segment goes and the jump stays applied.
  gm.prune(21);
  gm.update({ t0: 27.4851, T: 0.5, bar1: 3 }, track);
  assert.equal(gm.segs.length, 1);
  assert.equal(gm.at(0).t0, 27.4851);
  // A new track drops the jump.
  gm.update({ t0: 40.1, T: 0.6, bar1: null }, { n: 1, from: 39, prev: { t0: 38.4851, T: 0.5, bar1: 3 }, jump: null });
  assert.equal(gm.at(30).t0, 38.4851);
  assert.equal(gm.trackAt(40), 1);
});
