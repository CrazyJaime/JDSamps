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

test('the first beat and the last are left alone: the capture settles as the player starts, and the track ends', () => {
  const clean = kicks();
  for (const at of [Math.round(0.3 * SR), Math.round((32 * T + 0.3) * SR)]) { // between beats 0 and 1, and the last two
    const r = mendSteps(both(clean, (x) => ins(x, at, 2400)), T);
    assert.equal(r.steps.length, 0, `${at / SR} s: ${JSON.stringify(r.steps)}`);
  }
});

test('a track with no steady beat is left alone', () => {
  const n = 10 * SR, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.3 * Math.sin(2 * Math.PI * 220 * (i / SR)) * (0.5 + 0.5 * Math.sin(i / SR));
  const pcm = { L, R: L.slice(), sampleRate: SR };
  assert.equal(mendSteps(pcm, T).pcm, pcm);
});

// ---------------------------------------------------------------- drum loops with a continuous bed, as a 2× capture
// The capture is the track played at 2× and taken at the context's rate (44.1 or 48 kHz), in 16 bits. Its skips are
// as a busy computer's tab capture makes them: 10 ms of silence (exact zeros) put in, 10 ms lost, or a burst of both.
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

/** A loop recorded from the page at 2×: low-passed, resampled to sr, and quantised as the recorder hands it over. */
function capture2x(x, sr) {
  const ratio = (2 * FS) / sr, a = Math.exp((-2 * Math.PI * 0.225 * sr) / FS), lp = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; lp[i] = y; }
  y = 0;
  for (let i = x.length - 1; i >= 0; i--) { y = (1 - a) * lp[i] + a * y; lp[i] = y; }
  const out = new Float32Array(Math.floor((x.length - 2) / ratio));
  for (let i = 0; i < out.length; i++) { const p = i * ratio, k = Math.floor(p), f = p - k; out[i] = Math.round((lp[k] * (1 - f) + lp[k + 1] * f) * 32767) / 32768; }
  return out;
}
const tracks = new Map(), loops = new Map();
/** {pcm, T (s, the capture's beat), x}: 16 bars of a PATTERNS loop as a 2× capture at sr. */
function loop(name, sr) {
  const key = `${name}@${sr}`;
  if (!tracks.has(name)) tracks.set(name, synth({ ...PATTERNS[name], bars: 16, tail: 0 }).x);
  if (!loops.has(key)) loops.set(key, capture2x(tracks.get(name), sr));
  const x = loops.get(key);
  return { x, T: 60 / PATTERNS[name].bpm / 2, pcm: { L: x, R: x, sampleRate: sr } };
}
/** The capture with skips [at (fraction of its length), frames (> 0 silence put in, < 0 lost)], placed in the clean capture's time. */
function skipped(x, skips) {
  let y = x;
  for (const [fr, n] of [...skips].sort((p, q) => q[0] - p[0])) { const at = Math.round(x.length * fr); y = n > 0 ? ins(y, at, n) : cut(y, at, -n); }
  return y;
}
/** Where the mended capture differs from the clean one: [first, last] frames, or null where it is the same. */
function differs(a, b) {
  let first = -1, last = -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { if (first < 0) first = i; last = i; }
  return first < 0 ? null : [first, last];
}
const RATES = [44100, 48000];
// Loops on the grid: a skip shows against the bar before it. (Loops played by hand, off the grid by a few ms, are
// only ever left alone: their bars don't line up closely enough to tell a skip.)
const STEADY = ['house', 'techno', 'noisy128', 'dense150', 'dembow', 'trap', 'dnb', 'halftime140'];

test('a clean 2× capture of any drum loop, at 44.1 or 48 kHz, is left as it is', () => {
  for (const sr of RATES) for (const name of Object.keys(PATTERNS)) {
    const { pcm, T } = loop(name, sr), r = mendSteps(pcm, T);
    assert.deepEqual(r.steps, [], `${name} at ${sr}: ${JSON.stringify(r.steps)}`);
    assert.equal(r.pcm, pcm);
  }
});

test('a clean capture is left as it is when the beat it is given is a little off, or an octave off', () => {
  for (const name of ['house', 'techno', 'pop', 'trap', 'swing126']) for (const k of [0.996, 1.004, 0.5, 2]) {
    const { pcm, T } = loop(name, 48000), r = mendSteps(pcm, T * k);
    assert.deepEqual(r.steps, [], `${name}, beat ×${k}: ${JSON.stringify(r.steps)}`);
  }
});

test('10 ms of silence the capture put in a loop with a continuous bed is taken out: the audio is the track, sample for sample', () => {
  for (const sr of RATES) for (const name of [...STEADY, 'pop']) {
    const { x, T } = loop(name, sr), BUF = sr / 100;
    for (const skips of [[[0.31, BUF]], [[0.55, 2 * BUF]]]) {
      const r = mendSteps({ L: skipped(x, skips), R: skipped(x, skips), sampleRate: sr }, T);
      assert.deepEqual(r.steps.map((s) => Math.round(s.ms)), skips.map(([, n]) => (n / sr) * 1000), `${name} at ${sr}: ${JSON.stringify(r.steps)}`);
      assert.equal(differs(r.pcm.L, x), null, `${name} at ${sr}`);
      assert.equal(r.pcm.L.length, x.length);
    }
  }
});

test('10 ms the capture lost from a loop with a continuous bed is given back as silence near it: every later beat in its place', () => {
  for (const sr of RATES) for (const name of STEADY) {
    const { x, T } = loop(name, sr), BUF = sr / 100;
    for (const skips of [[[0.47, -BUF]], [[0.4, -2 * BUF]], [[0.3, BUF], [0.7, -BUF]]]) {
      const r = mendSteps({ L: skipped(x, skips), R: skipped(x, skips), sampleRate: sr }, T);
      assert.deepEqual(r.steps.map((s) => Math.round(s.ms)), skips.map(([, n]) => (n / sr) * 1000), `${name} at ${sr}: ${JSON.stringify(r.steps)}`);
      assert.equal(r.pcm.L.length, x.length, `${name} at ${sr}`);
      // Only the stretch between the loss and the silence given back differs from the track: in the quiet between
      // the onsets about it, within two beats (a sparse loop's onsets can be that far apart).
      const lost = Math.round(x.length * skips.find(([, n]) => n < 0)[0]), d = differs(r.pcm.L, x);
      assert.ok(d && d[0] >= lost - 2 * T * sr && d[1] < lost + 2 * T * sr, `${name} at ${sr}: lost at ${(lost / sr).toFixed(3)} s, differs ${d && d.map((v) => (v / sr).toFixed(3))} s`);
    }
  }
});

test('a burst of skips (10 ms lost, then 24 ms and 10 ms of silence put in) is mended to what it adds up to: every later beat in its place', () => {
  for (const sr of RATES) for (const name of ['house', 'techno', 'noisy128', 'dense150', 'dembow']) {
    const { x, T } = loop(name, sr), BUF = sr / 100, at = Math.round(x.length * 0.6), Z = Math.round(0.0242 * sr);
    let y = ins(x, at + 5000, BUF);
    y = cut(ins(y, at + 3000, Z), at, BUF);
    const r = mendSteps({ L: y, R: y.slice(), sampleRate: sr }, T), d = differs(r.pcm.L, x);
    assert.equal(r.pcm.L.length, x.length, `${name} at ${sr}: ${JSON.stringify(r.steps)}`);
    assert.ok(d && d[0] >= at && d[1] < at + T * sr, `${name} at ${sr}: differs ${d && d.map((v) => (v / sr).toFixed(3))} s`);
  }
});
