import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet, runBlocks } from './worklet-shim.mjs';
import { DeckTempo } from '../../engine/tempo.js';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

const reg = await loadWorklet('worklets/deck-input.js', { sampleRate: FS });
const Proc = reg['jds-deck-input'];

const msgs = (p, t) => p.port.posted.map((x) => x.msg).filter((m) => m.t === t);

test('registers jds-deck-input and announces its timing', () => {
  assert.ok(Proc, 'processor registered');
  const p = new Proc();
  const init = msgs(p, 'init')[0];
  assert.equal(init.chunk, 2048);
  assert.equal(init.spf, 128 * 4);
  assert.ok(Math.abs(init.fps - 93.75) < 1e-9);
});

test('chunks are contiguous, exact copies, and transferred', () => {
  const p = new Proc();
  const n = 2048 * 5 + 128 * 3;
  const L = new Float32Array(n).map((_, i) => Math.sin(i / 10));
  const R = new Float32Array(n).map((_, i) => Math.cos(i / 7));
  runBlocks(p, [L, R]);
  const chunks = msgs(p, 'chunk');
  assert.equal(chunks.length, 5);
  chunks.forEach((c, k) => {
    assert.equal(c.start, k * 2048);
    assert.equal(c.L.length, 2048);
    assert.deepEqual(Array.from(c.L), Array.from(L.subarray(k * 2048, (k + 1) * 2048)));
    assert.deepEqual(Array.from(c.R), Array.from(R.subarray(k * 2048, (k + 1) * 2048)));
  });
  const posted = p.port.posted.find((x) => x.msg.t === 'chunk');
  assert.equal(posted.transfer.length, 2);
});

test('mono input is duplicated and missing input counts as silence', () => {
  const p = new Proc();
  const mono = new Float32Array(2048).fill(0.25);
  runBlocks(p, [mono]);
  for (let s = 0; s < 2048; s += 128) p.process([[]], [[new Float32Array(128)]], {});
  const [a, b] = msgs(p, 'chunk');
  assert.equal(a.R[100], 0.25);
  assert.equal(b.start, 2048);
  assert.equal(b.L[5], 0);
  assert.equal(a.peak, 0.25);
  assert.equal(a.firstAbove, 0);
  assert.equal(b.firstAbove, -1);
});

test('blocks before the capture is connected do not start the input timeline', () => {
  // Chrome runs the processor as soon as the node exists; the Deck connects the capture only
  // after its Timeshift exists, so frames counted before that would never reach the buffer.
  const p = new Proc();
  for (let s = 0; s < 2048 + 512; s += 128) p.process([[]], [[new Float32Array(128)]], {});
  assert.equal(msgs(p, 'chunk').length, 0, 'no chunk before the first real input');
  const L = new Float32Array(2048).map((_, i) => 0.5 * Math.sin(i / 9));
  runBlocks(p, [L, L]);
  const [c] = msgs(p, 'chunk');
  assert.equal(c.start, 0);
  assert.deepEqual(Array.from(c.L), Array.from(L));
  assert.equal(c.firstAbove, 1);
});

test('ODF batches are evenly stamped and drive tempo detection', () => {
  const p = new Proc();
  const { x } = synth({ ...PATTERNS.house, bars: 20 });
  runBlocks(p, [x, x]);
  const odf = msgs(p, 'odf');
  assert.ok(odf.length > 100);
  for (let i = 1; i < odf.length; i++) assert.equal(odf[i].t0 - odf[i - 1].t0, 8 * odf[i].spf);
  assert.equal(odf[0].bands.length, 24);
  const d = new DeckTempo({ sampleRate: FS, fps: 93.75 });
  for (const m of odf) d.pushBatch(m);
  const g = d.get();
  assert.equal(g.state, 'LOCKED');
  assert.ok(Math.abs(g.inBpm - 124) < 0.15, String(g.inBpm));
});

// The deck's stretcher runs in the same AudioWorkletGlobalScope and thread. Its attachInput(id) registers
// an input function under the deck's pipe id; the deck input hands it each chunk, and the main thread only
// hears where the live edge is, so a busy main thread cannot starve the stretcher.
const PIPES = '__jdsStretchInputs';
const stereo = (n) => [new Float32Array(n).map((_, i) => Math.sin(i / 10)), new Float32Array(n).map((_, i) => Math.cos(i / 7))];

test('chunks go straight to the stretcher input registered for its pipe id; the main thread gets the live edge only', () => {
  const got = [];
  globalThis[PIPES] = new Map([[7, (bufs) => got.push(bufs)]]);
  const p = new Proc({ processorOptions: { pipeId: 7 } });
  const [L, R] = stereo(2048 * 3);
  globalThis.currentFrame = 4800;
  runBlocks(p, [L, R]);
  assert.equal(got.length, 3);
  got.forEach(([l, r], k) => {
    assert.deepEqual(Array.from(l), Array.from(L.subarray(k * 2048, (k + 1) * 2048)));
    assert.deepEqual(Array.from(r), Array.from(R.subarray(k * 2048, (k + 1) * 2048)));
  });
  const chunks = msgs(p, 'chunk');
  assert.equal(chunks.length, 3);
  chunks.forEach((c, k) => {
    assert.deepEqual(Object.keys(c).sort(), ['at', 'firstAbove', 'n', 'peak', 'piped', 'start', 't']);
    assert.deepEqual([c.piped, c.n, c.start, c.at], [true, 2048, k * 2048, 4800]);
  });
  assert.ok(p.port.posted.filter((x) => x.msg.t === 'chunk').every((x) => x.transfer.length === 0));
  delete globalThis[PIPES];
});

test('with no stretcher input registered, chunks carry their audio to the main thread, stamped with the audio frame', () => {
  const p = new Proc({ processorOptions: { pipeId: 8 } });
  globalThis.currentFrame = 960;
  runBlocks(p, stereo(2048));
  const [c] = msgs(p, 'chunk');
  assert.equal(c.L.length, 2048);
  assert.equal(c.at, 960);
  assert.equal(c.piped, undefined);
});

test('the route is chosen at the first chunk and kept, so chunks never reach the stretcher out of order', () => {
  const got = [];
  globalThis[PIPES] = new Map();
  const late = new Proc({ processorOptions: { pipeId: 9 } });
  runBlocks(late, stereo(2048));
  globalThis[PIPES].set(9, (bufs) => got.push(bufs)); // registered after the first chunk went the slow way
  runBlocks(late, stereo(2048));
  assert.equal(got.length, 0);
  assert.equal(msgs(late, 'chunk').filter((c) => c.L).length, 2);

  globalThis[PIPES].set(10, (bufs) => got.push(bufs));
  const early = new Proc({ processorOptions: { pipeId: 10 } });
  runBlocks(early, stereo(2048));
  globalThis[PIPES].delete(10);
  runBlocks(early, stereo(2048));
  assert.equal(got.length, 2, 'still handed over (the stretcher ignores audio once destroyed)');
  delete globalThis[PIPES];
});

test('dispose removes the deck\'s stretcher input from the shared registry', () => {
  globalThis[PIPES] = new Map([[11, () => {}], [12, () => {}]]);
  const p = new Proc({ processorOptions: { pipeId: 11 } });
  p.port.deliver({ t: 'dispose' });
  assert.deepEqual([...globalThis[PIPES].keys()], [12]);
  delete globalThis[PIPES];
});
