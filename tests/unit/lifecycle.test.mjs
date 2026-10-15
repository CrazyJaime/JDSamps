// Teardown: every per-deck AudioWorklet processor must stop when its deck is ejected. Chrome keeps
// calling process() on a disconnected AudioWorkletNode for as long as process() returns true, so
// each processor needs an explicit "stop" that makes process() return false.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadWorklet, runBlocks } from './worklet-shim.mjs';

const quantum = (ch = 2) => [Array.from({ length: ch }, () => new Float32Array(128))];
const noise = (n) => new Float32Array(n).map((_, i) => Math.sin(i * 0.37) * 0.5);

// ---------------------------------------------------------------- worklets
test('deck-input worklet: process() returns false after a dispose message and posts nothing more', async () => {
  const Proc = (await loadWorklet('worklets/deck-input.js'))['jds-deck-input'];
  const p = new Proc();
  assert.equal(p.process([[noise(128), noise(128)]], quantum(1), {}), true);
  p.port.deliver({ t: 'dispose' });
  const before = p.port.posted.length;
  for (let i = 0; i < 64; i++) assert.equal(p.process([[noise(128), noise(128)]], quantum(1), {}), false);
  assert.equal(p.port.posted.length, before);
});

test('beatfx worklet: process() returns false after a dispose message', async () => {
  const Proc = (await loadWorklet('worklets/beatfx.js'))['jds-beatfx'];
  const p = new Proc();
  assert.equal(p.process([[noise(128), noise(128)]], quantum(), {}), true);
  p.port.deliver({ t: 'dispose' });
  assert.equal(p.process([[noise(128), noise(128)]], quantum(), {}), false);
});

test('recorder worklet: process() returns false after a dispose message, idle or recording', async () => {
  const Rec = (await loadWorklet('worklets/recorder.js'))['jds-recorder'];
  const idle = new Rec();
  assert.equal(idle.process([[noise(128), noise(128)]], quantum(1), {}), true);
  idle.port.deliver({ t: 'dispose' });
  assert.equal(idle.process([[noise(128), noise(128)]], quantum(1), {}), false);
  const rec = new Rec();
  rec.port.deliver({ t: 'start' });
  runBlocks(rec, [noise(1024), noise(1024)]);
  rec.port.deliver({ t: 'dispose' });
  const before = rec.port.posted.length;
  for (let i = 0; i < 80; i++) assert.equal(rec.process([[noise(128), noise(128)]], quantum(1), {}), false);
  assert.equal(rec.port.posted.length, before);
});

// ---------------------------------------------------------------- vendored stretcher
async function stretchProcessor() {
  const Proc = (await loadWorklet('vendor/signalsmith-stretch/SignalsmithStretch.js'))['signalsmith-stretch'];
  const p = new Proc({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  for (let i = 0; i < 200 && !p.wasmReady; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(p.wasmReady, 'stretcher WASM ready');
  return p;
}
const reply = (p, id) => p.port.posted.map((x) => x.msg).find((m) => Array.isArray(m) && m[0] === id);

test('stretcher worklet: destroy() is a remote method that frees the buffer and ends process()', async () => {
  const p = await stretchProcessor();
  const ready = reply(p, 'ready');
  assert.ok(ready && 'destroy' in ready[1], `remote methods: ${ready && Object.keys(ready[1])}`);
  for (let i = 0; i < 20; i++) p.port.deliver([i, 'addBuffers', [noise(2048), noise(2048)]]);
  p.port.deliver([100, 'schedule', { active: true, input: 0.5, output: 0, rate: 1 }]);
  assert.equal(p.process([[]], quantum(), {}), true);
  p.port.deliver([101, 'destroy']);
  assert.ok(reply(p, 101), 'destroy() answered, so the main thread can await it');
  assert.equal(p.audioBuffers.length, 0, 'buffered audio released');
  for (let i = 0; i < 10; i++) assert.equal(p.process([[]], quantum(), {}), false);
});

test('patch.mjs: the vendored files carry every patch, and re-applying is a no-op', async () => {
  const { applyPatches, PATCHES } = await import('../../vendor/signalsmith-stretch/patch.mjs');
  assert.equal(typeof applyPatches, 'function', 'patch.mjs exports applyPatches()');
  assert.ok(PATCHES.length >= 3);
  for (const f of ['SignalsmithStretch.js', 'SignalsmithStretch.mjs']) {
    const src = fs.readFileSync(`vendor/signalsmith-stretch/${f}`, 'utf8');
    assert.equal(applyPatches(src, f), src, `${f} is fully patched`);
    const upstream = PATCHES.reduceRight((s, p) => s.replace(p.new, () => p.old), src);
    assert.ok(!upstream.includes('PATCHED (JD Samps)'), `${f}: every patch can be undone`);
    assert.equal(applyPatches(upstream, f), src, `${f}: patching upstream reproduces the vendored file`);
  }
});

// ---------------------------------------------------------------- engine-side fakes
const param = (v = 0) => ({ value: v, setValueAtTime() {}, setTargetAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {} });
class FakeNode {
  constructor(log, name = 'node') {
    this.log = log; this.name = name;
    this.gain = param(1); this.frequency = param(); this.Q = param(); this.delayTime = param();
  }
  connect(n) { return n; }
  disconnect() { this.log.push(`${this.name}.disconnect`); }
  start() {}
  stop() {}
}
function fakePort(log, name) {
  return {
    sent: [], closed: false, onmessage: null,
    postMessage(m) { if (this.closed) return; this.sent.push(m); log.push(`${name}.post:${m && m.t}`); },
    close() { this.closed = true; log.push(`${name}.close`); },
  };
}
class FakeWorkletNode extends FakeNode {
  constructor(log, name) { super(log, name); this.port = fakePort(log, name); }
}
function fakeCtx(log) {
  const ctx = { currentTime: 3, sampleRate: 48000 };
  return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : String(k).startsWith('create') ? () => new FakeNode(log, String(k).slice(6)) : undefined) });
}

test('fx rack dispose tells the beatfx processor to stop before closing its port', async () => {
  const log = [];
  globalThis.AudioWorkletNode = class extends FakeWorkletNode { constructor(ctx, name) { super(log, name); } };
  const { createFxRack } = await import('../../engine/fx.js');
  const rack = createFxRack(fakeCtx(log));
  rack.dispose();
  assert.deepEqual(rack.beatfx.port.sent.filter((m) => m.t === 'dispose'), [{ t: 'dispose' }]);
  assert.ok(log.indexOf('jds-beatfx.post:dispose') < log.indexOf('jds-beatfx.close'), log.join(' '));
});

test('recorder teardown tells its jds-recorder processor to stop, on stop and on failure', async () => {
  const log = [];
  globalThis.AudioWorkletNode = class extends FakeWorkletNode { constructor(ctx, name) { super(log, name); } };
  const { Recorder } = await import('../../engine/recorder.js');
  const ctx = fakeCtx(log);
  const delivered = [];
  const r = new Recorder(ctx, new FakeNode(log, 'src'), {
    format: 'wav', who: 'D1', title: () => 'T', sink: new FakeNode(log, 'sink'), deliver: (b, n) => delivered.push(n), onChange() {}, onError() {},
  });
  r.start('wav');
  const node = r.node;
  r.stop();
  assert.equal(r.state, 'finalizing');
  node.port.onmessage({ data: { t: 'data', buf: new Int16Array(4), frames: 2, final: true } });
  assert.equal(r.state, 'idle');
  assert.equal(delivered.length, 1);
  assert.deepEqual(node.port.sent.map((m) => m.t), ['start', 'stop', 'dispose']);
  assert.ok(node.port.closed);

  r.start('wav');
  const node2 = r.node;
  r.fail('boom');
  assert.deepEqual(node2.port.sent.map((m) => m.t), ['start', 'dispose']);
  assert.ok(node2.port.closed);
});

// ---------------------------------------------------------------- Deck.dispose()
async function makeDeck({ stretchHangs = false } = {}) {
  const log = [];
  const { Deck } = await import('../../engine/deck.js');
  const ctx = fakeCtx(log);
  const engine = { ctx, params: {}, master: { removeDeck: () => log.push('master.removeDeck') } };
  const d = new Deck(engine, { id: 1, slot: 1, tabId: 9, stream: { getTracks: () => [{ stop: () => log.push('track.stop') }] }, meta: {}, params: {} });
  d.source = new FakeNode(log, 'source');
  d.inputNode = new FakeWorkletNode(log, 'input');
  const answer = (name, v) => (...args) => {
    log.push(`stretch.${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
    return stretchHangs ? new Promise(() => {}) : Promise.resolve(v);
  };
  d.stretch = Object.assign(new FakeWorkletNode(log, 'stretch'), {
    schedule: answer('schedule', {}), dropBuffers: answer('dropBuffers', { start: 0, end: 0 }), destroy: answer('destroy', undefined),
  });
  d.fader = new FakeNode(log, 'fader');
  d.xfGain = new FakeNode(log, 'xfGain');
  d.analyser = new FakeNode(log, 'analyser');
  for (const k of ['trimNode', 'eq', 'rack']) d[k] = { dispose: () => log.push(`${k}.dispose`) };
  d.recorder = { state: 'idle', teardown() {} };
  return { d, log };
}

test('Deck.dispose stops the stretcher, drops its buffer and destroys its processor before disconnecting', async () => {
  const { d, log } = await makeDeck();
  await d.dispose();
  const at = (s) => { const i = log.findIndex((x) => x.startsWith(s)); assert.ok(i >= 0, `${s} missing: ${log.join(' | ')}`); return i; };
  assert.equal(log[at('stretch.schedule')], 'stretch.schedule({"active":false,"output":3})');
  assert.equal(log[at('stretch.dropBuffers')], 'stretch.dropBuffers()', 'no argument: drop everything');
  at('stretch.destroy');
  assert.ok(at('stretch.destroy') < at('stretch.disconnect'));
  assert.ok(at('stretch.destroy') < at('stretch.close'), 'port closed only after destroy() was answered');
  assert.ok(at('input.post:dispose') < at('input.close'));
  assert.ok(at('master.removeDeck') > at('stretch.close'));
});

test('Deck.dispose still completes when the stretcher never answers', async () => {
  const { d, log } = await makeDeck({ stretchHangs: true });
  const t0 = Date.now();
  await d.dispose();
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  for (const s of ['stretch.destroy', 'stretch.disconnect', 'stretch.close', 'input.post:dispose', 'master.removeDeck']) {
    assert.ok(log.some((x) => x.startsWith(s)), `${s} missing: ${log.join(' | ')}`);
  }
});
