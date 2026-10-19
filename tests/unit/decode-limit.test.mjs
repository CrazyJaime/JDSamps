// The resident track limit on a track decoded only in part: its notice gives the whole source's length.
import test from 'node:test';
import assert from 'node:assert/strict';
import { limitPcm } from '../../engine/decode.js';

test('a source decoded only to a second past the limit is cut to the limit, and its notice gives the whole source\'s length', () => {
  const sr = 1000, n = 61 * sr, pcm = { L: new Float32Array(n), R: new Float32Array(n), sampleRate: sr };
  const r = limitPcm(pcm, 1, 280);
  assert.equal(r.pcm.L.length, 60 * sr);
  assert.equal(r.pcm.R.length, 60 * sr);
  assert.equal(r.notice, 'this track is 4.7 minutes long: the deck holds its first 1 minute (the resident track limit).');
  assert.match(limitPcm(pcm, 1).notice, /^this track is 1 minutes? long/, 'with no length given, the decoded length');
});
