// The vendored stretcher's process() runs on the realtime audio thread once per 128-frame block,
// per deck. Its cost and garbage must not grow with the buffered history (up to 240 s per deck).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from 'node:inspector/promises';
import { loadWorklet } from './worklet-shim.mjs';
import { PATCHES, applyPatches } from '../../vendor/signalsmith-stretch/patch.mjs';

const SR = 48000, CH = 2048;
const VENDORED = 'vendor/signalsmith-stretch/SignalsmithStretch.js';
const COST = PATCHES.filter((p) => p.id === 'process-cost');

/** The vendored processor without the process-cost patch (every other patch kept). */
function withoutCostPatch() {
  const src = COST.reduceRight((s, p) => s.replace(p.new, () => p.old), fs.readFileSync(VENDORED, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jds-stretch-'));
  const file = path.join(dir, 'before.mjs');
  fs.writeFileSync(file, src);
  return file;
}

async function processor(file = VENDORED) {
  const Proc = (await loadWorklet(file, { sampleRate: SR }))['signalsmith-stretch'];
  const p = new Proc({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  for (let i = 0; i < 300 && !p.wasmReady; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(p.wasmReady, 'stretcher WASM ready');
  return p;
}

let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
function chunk(k, n = CH) {
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let j = 0; j < n; j++) { L[j] = 0.3 * Math.sin((k * CH + j) * 0.031) + 0.05 * rnd(); R[j] = 0.3 * Math.sin((k * CH + j) * 0.017) + 0.05 * rnd(); }
  return [L, R];
}
let msgId = 0;
const call = (p, method, ...args) => p.port.deliver([++msgId, method, ...args]);
const addSeconds = (p, seconds, k0 = 0) => { const n = Math.round((seconds * SR) / CH); for (let k = 0; k < n; k++) call(p, 'addBuffers', chunk(k0 + k)); return k0 + n; };

const out = [[new Float32Array(128), new Float32Array(128)]];
const noInput = [[]];
function run(p, blocks, onBlock) {
  for (let i = 0; i < blocks; i++) {
    p.process(noInput, out, {});
    if (onBlock) onBlock(out[0]);
    globalThis.currentTime += 128 / SR;
  }
}

test('patch.mjs: the process-cost patch is listed, marked, in both vendored files, and re-applying is a no-op', () => {
  assert.ok(COST.length > 0, 'patch.mjs has entries with id "process-cost"');
  for (const p of COST) assert.match(p.new, /PATCHED \(JD Samps\)/, `unmarked process-cost hunk: ${p.new.slice(0, 80)}`);
  for (const f of ['SignalsmithStretch.js', 'SignalsmithStretch.mjs']) {
    const src = fs.readFileSync(`vendor/signalsmith-stretch/${f}`, 'utf8');
    for (const p of COST) assert.ok(src.includes(p.new), `${f} lacks a process-cost hunk: ${p.new.slice(0, 80)}`);
    assert.equal(applyPatches(src, f), src, `${f}: re-applying changes nothing`);
  }
});

/** Per block: chunk-list reads (work), and bytes allocated (V8 sampling heap profiler), with `seconds` buffered. */
async function costAt(session, seconds) {
  seed = 1;
  const p = await processor();
  addSeconds(p, seconds);
  globalThis.currentTime = 0;
  call(p, 'schedule', { active: true, input: seconds - 8, output: 0, rate: 1.03, semitones: -0.5 });
  run(p, 200); // warm up (JIT)
  await session.post('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const N = 300;
  run(p, N);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  const bytes = profile.samples.reduce((a, s) => a + s.size, 0) / N;
  // Count reads of the chunk list (index accesses) through a proxy.
  let reads = 0;
  p.audioBuffers = new Proxy(p.audioBuffers, { get(t, k, r) { if (typeof k === 'string' && k >= '0' && k <= '9~') reads++; return Reflect.get(t, k, r); } });
  run(p, 20);
  reads = 0;
  run(p, 100);
  call(p, 'destroy');
  return { bytes, reads: reads / 100 };
}

test('stretcher process(): work and garbage per block with 240 s buffered stay within 1.5x of 10 s', async () => {
  const session = new Session();
  session.connect();
  try {
    await session.post('HeapProfiler.enable');
    const short = await costAt(session, 10), long = await costAt(session, 240);
    const info = JSON.stringify({ short, long });
    assert.ok(long.reads <= 1.5 * short.reads + 2, `chunk-list reads per block grow with history: ${info}`);
    assert.ok(long.bytes <= 1.5 * short.bytes + 256, `bytes allocated per block grow with history: ${info}`);
  } finally {
    session.disconnect();
  }
});

test('stretcher process(): output is bit-identical without the process-cost patch, through drops, jumps, loops and a full drop', async () => {
  const outputs = [];
  for (const file of [withoutCostPatch(), VENDORED]) {
    seed = 7; msgId = 0;
    const p = await processor(file);
    globalThis.currentTime = 0;
    const L = [], R = [];
    const take = (o) => { L.push(...o[0]); R.push(...o[1]); };
    let k = addSeconds(p, 30);
    call(p, 'dropBuffers', 4.1); // a trimmed history start: the scan starts mid-list
    call(p, 'schedule', { active: true, input: 18, output: 0.05, rate: 1.031, semitones: -0.4 });
    run(p, 300, take);
    k = addSeconds(p, 2, k); // the live edge grows while playing
    call(p, 'schedule', { active: true, input: 9.5, output: globalThis.currentTime + 0.01, rate: 0.97, semitones: 0 }); // jump back
    run(p, 300, take);
    const t = globalThis.currentTime + 0.01;
    call(p, 'schedule', { active: true, input: 12, output: t, rate: 1, loopStart: 12, loopEnd: 12.4 }); // loop
    run(p, 600, take);
    call(p, 'dropBuffers', 11); // trim while looping
    call(p, 'schedule', { active: true, input: 25, output: globalThis.currentTime + 0.01, rate: 1.2, loopStart: 0, loopEnd: 0 }); // jump ahead
    run(p, 300, take);
    call(p, 'schedule', { active: false, output: globalThis.currentTime + 0.01 }); // pause
    run(p, 100, take);
    call(p, 'dropBuffers'); // drop everything, then refill: a new list from 0
    addSeconds(p, 6, 0);
    call(p, 'schedule', { active: true, input: 2, output: globalThis.currentTime + 0.01, rate: 1 });
    run(p, 300, take);
    call(p, 'addBuffers', chunk(999, 700)); // an odd-sized chunk at the edge
    call(p, 'schedule', { active: true, input: 5.9, output: globalThis.currentTime + 0.01, rate: 1 }); // read past the edge
    run(p, 200, take);
    outputs.push({ L: Float32Array.from(L), R: Float32Array.from(R) });
    call(p, 'destroy');
  }
  const [a, b] = outputs;
  let energy = 0;
  for (let i = 0; i < a.L.length; i++) energy += a.L[i] * a.L[i];
  assert.ok(energy > 100, `the scenario produces sound (energy ${energy})`);
  let differ = 0, first = -1;
  for (let i = 0; i < a.L.length; i++) if (a.L[i] !== b.L[i] || a.R[i] !== b.R[i]) { differ++; if (first < 0) first = i; }
  assert.equal(differ, 0, `${differ} samples differ, first at block ${Math.floor(first / 128)}`);
});

test('stretcher RPC: addBuffers sent one-way (null id) is applied without a reply; numbered calls are still answered', async () => {
  assert.ok(PATCHES.some((p) => p.id === 'one-way'), 'patch.mjs has the one-way hunks');
  const p = await processor();
  const before = p.port.posted.length;
  for (let k = 0; k < 10; k++) p.port.deliver([null, 'addBuffers', chunk(k)]);
  assert.equal(p.audioBuffersEnd, 10 * CH);
  assert.equal(p.port.posted.length, before, 'no reply to a one-way call');
  p.port.deliver([77, 'addBuffers', chunk(10)]);
  assert.deepEqual(p.port.posted.slice(before).map((x) => x.msg), [[77, (11 * CH) / SR]]);
  call(p, 'destroy');
});
