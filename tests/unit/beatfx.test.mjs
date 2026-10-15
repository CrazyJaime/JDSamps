// beatfx worklet: the GATE is a 16-step pattern stepped by the deck's beat clock, and the FLANGER
// LFO (output 1) sweeps once per period in beats, re-phased on a beat (spec §3.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet } from './worklet-shim.mjs';

const SR = 48000;
const BeatFx = (await loadWorklet('worklets/beatfx.js', { sampleRate: SR }))['jds-beatfx'];
const P = 24000; // frames per beat (120 BPM)
const STEP = P / 4; // GATE steps of 1/4 beat: 16 steps = one bar
const PATTERN = [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0]; // the documented default

/** Run from frame `from` for `n` frames with a DC input of 1; returns the gain (out L) and LFO traces.
 *  `at(frame, proc)` runs at the start of each quantum, before process(), to deliver messages. */
function render(p, from, frames, at) {
  const n = Math.floor(frames / 128) * 128;
  const gain = new Float32Array(n), lfo = new Float32Array(n), one = new Float32Array(128).fill(1);
  for (let s = 0; s + 128 <= n; s += 128) {
    globalThis.currentFrame = from + s;
    if (at) at(from + s, p);
    const outs = [[new Float32Array(128), new Float32Array(128)], [new Float32Array(128)]];
    assert.equal(p.process([[one, one]], outs, {}), true);
    gain.set(outs[0][0], s); lfo.set(outs[1][0], s);
  }
  return { gain, lfo };
}
const mean = (a, i, j) => { let s = 0; for (let k = i; k < j; k++) s += a[k]; return s / (j - i); };
/** On/off of the first half of each step, read between 10% and 40% of the step. */
function steps(gain, start, count) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const s = start + k * STEP;
    out.push(mean(gain, s + STEP * 0.1, s + STEP * 0.4) > 0.5 ? 1 : 0);
  }
  return out;
}

function gateProc(anchor) {
  const p = new BeatFx();
  globalThis.currentFrame = anchor;
  p.port.deliver({ t: 'clock', anchorFrame: anchor, periodFrames: P });
  p.port.deliver({ t: 'gate', depth: 1, stepBeats: 0.25 });
  return p;
}

test('GATE plays a 16-step pattern on the beat clock, not a plain square gate', () => {
  const anchor = 1000;
  const p = gateProc(anchor);
  p.port.deliver({ t: 'mode', mode: 'gate' }); // switched on exactly on the anchor beat
  const { gain } = render(p, anchor, 32 * STEP + 128);
  const seq = steps(gain, 0, 32);
  assert.deepEqual(seq.slice(0, 16), PATTERN, `steps ${seq.join('')}`);
  assert.deepEqual(seq.slice(16), PATTERN, 'the pattern repeats every 16 steps');
  for (let k = 0; k < 32; k++) {
    const s = k * STEP;
    assert.ok(mean(gain, s + STEP * 0.6, s + STEP * 0.9) < 0.01, `step ${k}: closed in its second half`);
    if (!PATTERN[k % 16]) assert.ok(mean(gain, s + STEP * 0.1, s + STEP * 0.4) < 0.01, `step ${k}: a rest stays closed`);
  }
});

test('GATE pattern keeps its place when the deck re-anchors the clock on later beats', () => {
  const anchor = 1000;
  const p = gateProc(anchor);
  p.port.deliver({ t: 'mode', mode: 'gate' });
  // As the deck does every 0.5 s: anchor = the last beat before now (here up to 1 frame of jitter).
  let next = anchor + 12000;
  const { gain } = render(p, anchor, 32 * STEP + 128, (f, proc) => {
    if (f < next) return;
    next += 12000;
    const last = anchor + Math.floor((f - anchor) / P) * P;
    proc.port.deliver({ t: 'clock', anchorFrame: last + (f % 3) - 1, periodFrames: P });
  });
  const seq = steps(gain, 0, 32);
  assert.deepEqual(seq, [...PATTERN, ...PATTERN], `steps ${seq.join('')}`);
});

test('GATE restarts its pattern on the beat nearest the moment it is switched on', () => {
  const anchor = 5000;
  const p = gateProc(anchor);
  const n = 24 * P;
  const onAt = [anchor + 3.3 * P, anchor + 10.8 * P], offAt = anchor + 8 * P;
  const { gain } = render(p, anchor, n, (f, proc) => {
    for (const t of onAt) if (f <= t && t < f + 128) proc.port.deliver({ t: 'mode', mode: 'gate' });
    if (f <= offAt && offAt < f + 128) proc.port.deliver({ t: 'mode', mode: 'off' });
  });
  // On at beat 3.3: step 0 is beat 3. Read the 16 steps from beat 4 on (pattern steps 4..15).
  assert.deepEqual(steps(gain, Math.round(4 * P), 12), PATTERN.slice(4), 'restart on beat 3');
  // On at beat 10.8: step 0 is beat 11; the 0.2 beat before it plays the end of the pattern.
  assert.deepEqual(steps(gain, Math.round(11 * P), 16), PATTERN, 'restart on beat 11');
  assert.ok(mean(gain, Math.round(10.8 * P + 600), Math.round(11 * P - 300)) < 0.01, 'step 15 (a rest) before the restart beat');
});

test('GATE edges are click-free (2 ms smoothing)', () => {
  const p = gateProc(0);
  p.port.deliver({ t: 'mode', mode: 'gate' });
  const { gain } = render(p, 0, 16 * STEP);
  let maxStep = 0;
  for (let i = 1; i < gain.length; i++) maxStep = Math.max(maxStep, Math.abs(gain[i] - gain[i - 1]));
  assert.ok(maxStep < 0.02, `max per-sample gain step ${maxStep}`);
});

/** LFO trace for a flanger with a sweep of `beats` beats, switched on at `onFrame`. */
function lfoRun({ anchor, beats, onFrame, n, at }) {
  const p = new BeatFx();
  globalThis.currentFrame = anchor;
  p.port.deliver({ t: 'clock', anchorFrame: anchor, periodFrames: P });
  return render(p, anchor, n, (f, proc) => {
    if (f <= onFrame && onFrame < f + 128) proc.port.deliver({ t: 'flanger', on: true, periodBeats: beats, bpm: 120 });
    if (at) at(f, proc);
  }).lfo;
}

test('FLANGER LFO sweeps once per period in beats, starting on the beat nearest FX ON', () => {
  const anchor = 7000, beats = 2;
  // FX ON at beat 0.2: the sweep starts on beat 0 (the anchor), at the bottom of the triangle.
  const lfo = lfoRun({ anchor, beats, onFrame: anchor + 0.2 * P, n: 9 * P });
  for (let b = 2; b <= 8; b++) {
    const v = lfo[b * P], want = b % beats === 0 ? -1 : 1;
    assert.ok(Math.abs(v - want) < 0.01, `beat ${b}: lfo ${v}, want ${want}`);
    const q = lfo[Math.round((b + 0.5) * P)];
    assert.ok(Math.abs(q) < 0.01, `beat ${b + 0.5}: lfo ${q}, want 0 (mid-sweep)`);
  }
});

test('FLANGER LFO stays on the beat across clock re-anchors and a tempo change', () => {
  const anchor = 3000, beats = 4, P2 = 22000;
  const change = anchor + 8 * P; // from beat 8 the deck runs at P2 frames per beat
  const lfo = lfoRun({
    anchor, beats, onFrame: anchor, n: 8 * P + 13 * P2,
    at: (f, proc) => {
      if (f % 12000 >= 128) return; // every 0.25 s: re-anchor on the last beat
      const last = f < change ? anchor + Math.floor((f - anchor) / P) * P : change + Math.floor((f - change) / P2) * P2;
      proc.port.deliver({ t: 'clock', anchorFrame: last, periodFrames: f < change ? P : P2 });
    },
  });
  const at = (beat) => lfo[Math.round(beat < 8 ? beat * P : 8 * P + (beat - 8) * P2)];
  for (const b of [4, 6, 12, 14, 16, 18, 20]) {
    const want = b % beats === 0 ? -1 : 1;
    assert.ok(Math.abs(at(b) - want) < 0.02, `beat ${b}: lfo ${at(b)}, want ${want}`);
  }
  let maxStep = 0;
  for (let i = 1; i < lfo.length; i++) maxStep = Math.max(maxStep, Math.abs(lfo[i] - lfo[i - 1]));
  assert.ok(maxStep <= 2 * (4 / (beats * P2)) + 1e-7, `LFO moves smoothly (float32 output): max step ${maxStep}`);
});
