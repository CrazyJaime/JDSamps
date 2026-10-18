// A whole track recorded from a page's sound (engine/loader.js Recording): under load the tab capture loses or
// repeats a few ms now and then (10 ms of the 2× capture: 20 ms of the track), and every beat after it moves.
// mendSteps finds those steps between steady beats and puts the audio back on the beat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mendSteps } from '../../engine/loader.js';

const SR = 48000, BPM = 124, T = 60 / BPM;

/** 16 s of a pitched kick on every beat (as tests/browser/ext-harness.mjs makes them), stereo. */
function kicks(seconds = 16) {
  const n = Math.round(seconds * SR), L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / SR) % T;
    if (t < 0.2) L[i] = 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-t * 35)) * t) * Math.exp(-t * 18);
  }
  return { L, R: L.slice(), sampleRate: SR };
}
const cut = (x, at, n) => { const y = new Float32Array(x.length - n); y.set(x.subarray(0, at)); y.set(x.subarray(at + n), at); return y; };
const ins = (x, at, n) => { const y = new Float32Array(x.length + n); y.set(x.subarray(0, at)); y.set(x.subarray(at), at + n); return y; };
const both = (pcm, f) => ({ L: f(pcm.L), R: f(pcm.R), sampleRate: pcm.sampleRate });
/** Kick onsets (s): the first sample over 0.01 after a quiet stretch. */
function onsets(x) {
  const out = [];
  for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > 0.01 && (!out.length || i / SR - out[out.length - 1] > 0.3)) out.push(i / SR);
  return out;
}
const offBeat = (pcm) => Math.max(...onsets(pcm.L).map((t) => Math.abs(t - Math.round(t / T) * T) * 1000));

test('a recording with no skips is left as it is', () => {
  const pcm = kicks(), r = mendSteps(pcm, T);
  assert.equal(r.steps.length, 0);
  assert.equal(r.pcm, pcm);
});

test('20 ms of silence the capture put in the middle of a kick is taken out again: the audio is the track, sample for sample', () => {
  const clean = kicks(), at = Math.round((8 * T + 0.05) * SR); // 50 ms into the kick on beat 8
  const r = mendSteps(both(clean, (x) => ins(x, at, 960)), T);
  assert.equal(r.steps.length, 1);
  assert.ok(Math.abs(r.steps[0].ms - 20) < 2, JSON.stringify(r.steps));
  assert.equal(r.pcm.L.length, clean.L.length);
  assert.deepEqual(r.pcm.L, clean.L);
  assert.deepEqual(r.pcm.R, clean.R);
});

test('20 ms the capture lost from a kick is given back as silence, so every later beat is in its place', () => {
  const clean = kicks(), at = Math.round((13 * T + 0.03) * SR);
  const skipped = both(clean, (x) => cut(x, at, 960));
  assert.ok(offBeat(skipped) > 15, 'the beats after it come early');
  const r = mendSteps(skipped, T);
  assert.equal(r.steps.length, 1);
  assert.ok(Math.abs(r.steps[0].ms + 20) < 2, JSON.stringify(r.steps));
  assert.equal(r.pcm.L.length, clean.L.length);
  assert.ok(offBeat(r.pcm) < 0.5, `beats off by ${offBeat(r.pcm).toFixed(2)} ms`);
  // Only the beat it was lost from differs from the track.
  let first = -1, last = -1;
  for (let i = 0; i < clean.L.length; i++) if (r.pcm.L[i] !== clean.L[i]) { if (first < 0) first = i; last = i; }
  assert.ok(first >= Math.floor(13 * T * SR) && last < Math.ceil(14 * T * SR), `changed from ${first / SR} to ${last / SR} s`);
});

test('a skip inside the silence between two kicks, and several in one recording, are all mended', () => {
  const clean = kicks();
  let x = both(clean, (y) => ins(y, Math.round((4 * T + 0.3) * SR), 960));  // in the silence
  x = both(x, (y) => cut(y, Math.round((15 * T + 0.1) * SR) + 960, 960));    // in a kick, later
  x = both(x, (y) => ins(y, Math.round((24 * T + 0.12) * SR), 480));         // 10 ms, later still
  const r = mendSteps(x, T);
  assert.equal(r.steps.length, 3, JSON.stringify(r.steps));
  assert.equal(r.pcm.L.length, clean.L.length);
  assert.ok(offBeat(r.pcm) < 0.5, `beats off by ${offBeat(r.pcm).toFixed(2)} ms`);
});

test('one kick out of place is a kick out of place, not a skip: nothing is cut', () => {
  const clean = kicks(), L = clean.L.slice(), a = Math.round(6 * T * SR), n = Math.round(0.2 * SR), d = Math.round(0.012 * SR);
  L.copyWithin(a + d, a, a + n); L.fill(0, a, a + d); // beat 6 played 12 ms late, the rest on time
  const r = mendSteps({ L, R: L.slice(), sampleRate: SR }, T);
  assert.equal(r.steps.length, 0, JSON.stringify(r.steps));
});

test('a track with no steady beat is left alone', () => {
  const n = 10 * SR, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.3 * Math.sin(2 * Math.PI * 220 * (i / SR)) * (0.5 + 0.5 * Math.sin(i / SR));
  const pcm = { L, R: L.slice(), sampleRate: SR };
  assert.equal(mendSteps(pcm, T).pcm, pcm);
});
