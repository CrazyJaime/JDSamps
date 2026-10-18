// The harness's own audio measures (tests/browser/ext-harness.mjs), on synthetic tracks: no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTrackWav, parseWav, bandRms } from './ext-harness.mjs';

const db = (x) => 20 * Math.log10(x);

test('bandRms: a recording that starts in the middle of a kick reads no highs it does not have', () => {
  // A recording starts wherever the music is. The kick has nothing above a few hundred Hz, so its high band is
  // silent wherever the recording starts, in a kick or between two.
  const w = parseWav(makeTrackWav({ bpm: 128, kind: 'low', seconds: 4 })), beat = Math.round((w.sr * 60) / 128);
  const at = (ms) => db(bandRms(w.mono.subarray(Math.round((ms / 1000) * w.sr), Math.round((ms / 1000) * w.sr) + 3 * beat), w.sr, 'high'));
  const quiet = at(300), starts = [1, 5, 10, 20, 100];
  assert.ok(quiet < -75, `between kicks: ${quiet.toFixed(1)} dBFS`);
  for (const ms of starts) assert.ok(at(ms) < quiet + 3, `starting ${ms} ms into a kick: ${at(ms).toFixed(1)} dBFS, between kicks ${quiet.toFixed(1)}`);
  // The kick itself is all there in the low band, wherever it starts.
  assert.ok(Math.abs(db(bandRms(w.mono.subarray(0, 3 * beat), w.sr, 'low')) - db(bandRms(w.mono.subarray(Math.round(0.01 * w.sr), Math.round(0.01 * w.sr) + 3 * beat), w.sr, 'low'))) < 1);
});
