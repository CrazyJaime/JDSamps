import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet, runBlocks } from './worklet-shim.mjs';
import { wavHeader, WavStreamWriter, WAV_ROLL_BYTES } from '../../engine/recorder.js';

const reg = await loadWorklet('worklets/recorder.js', { sampleRate: 48000 });
const Rec = reg['jds-recorder'];
const data = (p) => p.port.posted.map((x) => x.msg).filter((m) => m.t === 'data');

test('wav header fields', () => {
  const v = new DataView(wavHeader(1000, 44100));
  const str = (o) => String.fromCharCode(...[0, 1, 2, 3].map((i) => v.getUint8(o + i)));
  assert.equal(str(0), 'RIFF');
  assert.equal(v.getUint32(4, true), 1036);
  assert.equal(str(8), 'WAVE');
  assert.equal(str(12), 'fmt ');
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(28, true), 44100 * 4);
  assert.equal(v.getUint16(32, true), 4);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(str(36), 'data');
  assert.equal(v.getUint32(40, true), 1000);
});

test('writer streams parts and finishes with a correct header', async () => {
  const w = new WavStreamWriter(48000);
  w.push(new Int16Array([1, 2, 3, 4]), 2);
  w.push(new Int16Array([5, 6]), 1);
  w.push(new Int16Array(0), 0);
  assert.equal(w.frames, 3);
  assert.equal(w.bytes, 12);
  assert.ok(Math.abs(w.seconds - 3 / 48000) < 1e-12);
  assert.equal(w.shouldRoll(), false);
  const blob = w.finish();
  assert.equal(blob.type, 'audio/wav');
  const buf = new DataView(await blob.arrayBuffer());
  assert.equal(buf.byteLength, 44 + 12);
  assert.equal(buf.getUint32(40, true), 12);
  assert.equal(buf.getInt16(44 + 10, true), 6);
  assert.ok(WAV_ROLL_BYTES < 2 ** 32 && WAV_ROLL_BYTES > 3.9e9);
});

test('recorder worklet: stop without start sends nothing', () => {
  const p = new Rec();
  runBlocks(p, [new Float32Array(1024), new Float32Array(1024)]);
  p.port.deliver({ t: 'stop' });
  assert.equal(data(p).length, 0);
});

test('recorder worklet: converts, clamps, batches and flushes once', () => {
  const p = new Rec();
  p.port.deliver({ t: 'start' });
  const n = 8192 + 256;
  const L = new Float32Array(n); const R = new Float32Array(n);
  L[0] = 1; L[1] = -1; L[2] = 2; L[3] = -2; L[4] = 0.5; R[0] = NaN;
  runBlocks(p, [L, R]);
  p.port.deliver({ t: 'stop' });
  p.port.deliver({ t: 'stop' });
  const d = data(p);
  assert.equal(d.length, 2);
  assert.equal(d[0].frames, 8192);
  assert.equal(d[0].final, false);
  assert.equal(d[0].buf.length, 8192 * 2);
  assert.deepEqual(Array.from(d[0].buf.subarray(0, 10)), [32767, 0, -32768, 0, 32767, 0, -32768, 0, 16384, 0]);
  assert.equal(d[1].frames, 256);
  assert.equal(d[1].final, true);
  assert.equal(d[1].buf.length, 512);
  const posted = p.port.posted.filter((x) => x.msg.t === 'data');
  assert.equal(posted[0].transfer.length, 1);
});

test('recorder worklet: missing input records silence, restart works', () => {
  const p = new Rec();
  p.port.deliver({ t: 'start' });
  for (let i = 0; i < 4; i++) p.process([[]], [[new Float32Array(128)]], {});
  p.port.deliver({ t: 'stop' });
  p.port.deliver({ t: 'start' });
  runBlocks(p, [new Float32Array(128).fill(0.25)]);
  p.port.deliver({ t: 'stop' });
  const d = data(p);
  assert.equal(d.length, 2);
  assert.equal(d[0].frames, 512);
  assert.equal(d[1].frames, 128);
  assert.equal(d[1].buf[1], d[1].buf[0]);
});
