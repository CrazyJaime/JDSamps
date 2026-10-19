// The harness's own audio measures (tests/browser/ext-harness.mjs), on synthetic tracks: no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTrackWav, parseWav, bandRms, onsetBias, beatMatch, matchFaults, levelFaults } from './ext-harness.mjs';

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

// ---------------------------------------------------------------- beat-matched decks (R6.2): what the check catches
/**
 * A master recording (44.1 kHz) of two decks at `bpm`: a low kick (as makeTrackWav's) on beat k at kick(k) s off the
 * grid and a high click at click(k) (null: none), over a steady tone, as the model track's chirp keeps the floor.
 */
function master({ seconds = 30, bpm = 124, kick = () => 0, click = () => 0, floor = 0.15 } = {}) {
  const sr = 44100, n = Math.round(seconds * sr), x = new Float32Array(n), T = 60 / bpm;
  for (let i = 0; i < n; i++) x[i] = floor * Math.sin((2 * Math.PI * 440 * i) / sr);
  const add = (at, len, f) => { for (let i = Math.max(0, Math.round(at * sr)), e = Math.min(n, Math.round((at + len) * sr)); i < e; i++) x[i] += f(i / sr - at); };
  for (let k = 0; (k + 0.2) * T < seconds; k++) {
    const dk = kick(k), dc = click(k), t = 0.1 + k * T;
    if (dk != null) add(t + dk, 0.2, (u) => 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-u * 35)) * u) * Math.exp(-u * 18));
    if (dc != null) add(t + dc, 0.04, (u) => 0.6 * Math.sin(2 * Math.PI * 3000 * u) * Math.exp(-u * 90));
  }
  return { mono: x, sr, seconds: n / sr };
}
const BIAS = onsetBias(124, 'low', 'low') - onsetBias(124, 'high', 'high');
const faults = (wav, opts) => matchFaults(beatMatch(wav, BIAS), { seconds: 30, ...opts });

test('matchFaults: two decks a few ms apart on every beat hold, as a steady pair or with a live master', () => {
  for (const opts of [{ steady: true }, { excuse: 4 }]) assert.deepEqual(faults(master({ click: () => 0.003 }), opts), [], JSON.stringify(opts));
  // A recording that starts in the middle of a kick: the kick's end is no beat of it.
  const w = master({ click: () => 0.003 }), cut = Math.round(0.19 * w.sr);
  assert.deepEqual(faults({ mono: w.mono.subarray(cut), sr: w.sr, seconds: w.seconds - 0.19 }, { seconds: 29.8, steady: true }), []);
});

test('matchFaults: a follower that stumbles once (three beats 77, 57 and 39 ms off) is caught', () => {
  const off = { 20: -0.077, 21: -0.057, 22: -0.039 }, wav = master({ click: (k) => off[k] || 0 });
  for (const opts of [{ steady: true }, { excuse: 4 }]) assert.notDeepEqual(faults(wav, opts), [], JSON.stringify(opts));
});

test('matchFaults: six beats 120 ms off, spread over 10 s, are caught', () => {
  const wav = master({ click: (k) => ([10, 13, 16, 19, 22, 25].includes(k) ? 0.12 : 0) });
  assert.notDeepEqual(faults(wav, { steady: true }), []);
});

test('matchFaults: a beat the follower drops is caught in a steady pair', () => {
  assert.notDeepEqual(faults(master({ click: (k) => (k === 30 ? null : 0.003) }), { steady: true }), []);
});

test('matchFaults: a live master whose capture skips 40 ms excuses the beats the follower takes to catch up, and no others', () => {
  // The master's kicks 40 ms later from beat 30; the follower is back on them over three beats.
  const lag = (k) => (k < 30 ? 0 : k < 33 ? (0.04 * (k - 30)) / 3 : 0.04);
  assert.deepEqual(faults(master({ kick: (k) => (k < 30 ? 0 : 0.04), click: lag }), { excuse: 4 }), []);
  // The same three beats off with the master steady are the follower's own stumble.
  assert.notDeepEqual(faults(master({ click: (k) => (k >= 30 && k < 33 ? -0.04 + lag(k) : 0) }), { excuse: 4 }), []);
});

test('matchFaults: a recording a little short of 30 s is judged to its end', () => {
  // Six beats 25 ms off in its last 4.9 s: under the 90th percentile, and past the last whole 5 s.
  const wav = master({ seconds: 29.9, click: (k) => (k >= 54 && k < 60 ? 0.025 : 0) });
  assert.notDeepEqual(faults(wav, { steady: true }), []);
});

// ---------------------------------------------------------------- the master's level (R6.2 glitch test): what the check catches
const levels = (wav) => levelFaults(wav, beatMatch(wav, BIAS));
/** wav with [from, to) s scaled by g (0: silence). */
const scaled = (wav, from, to, g) => { const y = wav.mono.slice(); for (let i = Math.round(from * wav.sr); i < Math.round(to * wav.sr); i++) y[i] *= g; return { ...wav, mono: y }; };
const T124 = 60 / 124, between = (k) => 0.1 + k * T124 + 0.06; // 60 ms after beat k's kick: its tail, and the floor under it

test('levelFaults: a steady master holds, over a floor or with silence between its beats', () => {
  assert.deepEqual(levels(master({ click: () => 0.003 })), []);
  assert.deepEqual(levels(master({ click: () => 0.003, floor: 0 })), []);
});

test('levelFaults: 150 ms of the master gone between two beats is caught, as is one deck going under the other', () => {
  const w = master({ click: () => 0.003 });
  assert.notDeepEqual(levels(scaled(w, between(20), between(20) + 0.15, 0)), []);
  // The kick deck (its tail and the floor) silent for 150 ms; the clicks go on.
  const a = master({ click: () => null }), b = master({ kick: () => null, floor: 0, click: () => 0.003 }), y = scaled(a, between(30), between(30) + 0.15, 0);
  for (let i = 0; i < y.mono.length; i++) y.mono[i] += b.mono[i];
  assert.notDeepEqual(levels(y), []);
});

test('levelFaults: a 15 dB dip for 200 ms, and a click between two beats, are caught', () => {
  const w = master({ click: () => 0.003 });
  assert.notDeepEqual(levels(scaled(w, between(12), between(12) + 0.2, 10 ** (-15 / 20))), []);
  const y = { ...w, mono: w.mono.slice() }, at = Math.round((between(40) + 0.1) * w.sr);
  for (let i = 0; i < 88; i++) y.mono[at + i] += i % 2 ? -0.5 : 0.5;
  assert.notDeepEqual(levels(y), []);
});
