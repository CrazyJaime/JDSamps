// The resident track limit on a track decoded only in part: its notice gives the whole source's length.
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitPcm, wavFrames } from '../../engine/decode.js';

test('a source decoded only to a second past the limit is cut to the limit, and its notice gives the whole source\'s length', () => {
  const sr = 1000, n = 61 * sr, pcm = { L: new Float32Array(n), R: new Float32Array(n), sampleRate: sr };
  const r = limitPcm(pcm, 1, 280);
  assert.equal(r.pcm.L.length, 60 * sr);
  assert.equal(r.pcm.R.length, 60 * sr);
  assert.equal(r.notice, 'this track is 4.7 minutes long: the deck holds its first 1 minute (the resident track limit).');
  assert.match(limitPcm(pcm, 1).notice, /^this track is 1 minutes? long/, 'with no length given, the decoded length');
});

/** A 16-bit stereo WAV of `sec` seconds (sample k holds k), with a LIST chunk of odd size before its data; dataSize overrides the size it gives. */
function wav(sec, { sr = 8000, dataSize } = {}) {
  const n = Math.round(sec * sr), list = 5, head = 12 + 24 + 8 + list + 1 + 8, buf = new ArrayBuffer(head + n * 4), v = new DataView(buf);
  const put = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  put(36, 'LIST'); v.setUint32(40, list, true);
  put(head - 8, 'data'); v.setUint32(head - 4, dataSize ?? n * 4, true);
  for (let k = 0; k < n; k++) { v.setInt16(head + k * 4, k % 32768, true); v.setInt16(head + k * 4 + 2, -(k % 32768), true); }
  return { buf, head, n, sr };
}

test('a WAV longer than the limit is cut at the sample a second past it, its sizes set to match; a shorter one, or another file, is not', () => {
  const { buf, head, sr } = wav(70);
  const w = wavFrames(buf, 61);
  assert.equal(w.samples, 70 * sr);
  assert.equal(w.sampleRate, sr);
  assert.equal(w.cut.samples, 61 * sr);
  const out = new DataView(w.cut.bytes);
  assert.equal(w.cut.bytes.byteLength, head + 61 * sr * 4);
  assert.equal(out.getUint32(4, true), w.cut.bytes.byteLength - 8, 'RIFF size');
  assert.equal(out.getUint32(head - 4, true), 61 * sr * 4, 'data size');
  assert.equal(out.getInt16(w.cut.bytes.byteLength - 4, true), (61 * sr - 1) % 32768, 'the last sample kept');
  assert.equal(buf.byteLength, head + 70 * sr * 4, 'the source is left whole');
  assert.deepEqual(wavFrames(wav(30).buf, 61), { samples: 30 * sr, sampleRate: sr, cut: null });
  // A streamed WAV may give no data size: its length is what the file holds.
  for (const dataSize of [0, 0xffffffff]) assert.equal(wavFrames(wav(70, { dataSize }).buf, 61).samples, 70 * sr, `data size ${dataSize}`);
  assert.equal(wavFrames(new TextEncoder().encode('ID3\u0004 not a wav at all').buffer, 61), null);
  assert.equal(wavFrames(new ArrayBuffer(4), 61), null);
});
