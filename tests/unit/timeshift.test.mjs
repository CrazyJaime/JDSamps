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
