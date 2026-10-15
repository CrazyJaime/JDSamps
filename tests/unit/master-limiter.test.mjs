import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet } from './worklet-shim.mjs';

const SR = 48000;
const reg = await loadWorklet('worklets/master.js', { sampleRate: SR });
const Master = reg['jds-master'];
const CEIL = 10 ** (-1 / 20);
const L = Math.round(0.005 * SR); // lookahead delay in frames
const PROBE = 0.25; // constant, under the ceiling: outR / PROBE is the applied gain

/** Run the limiter over stereo input in 128-frame quanta; returns both output channels. */
function render(xl, xr, { proc = new Master() } = {}) {
  const n = xl.length, ol = new Float32Array(n), or = new Float32Array(n);
  for (let s = 0; s + 128 <= n; s += 128) {
    const o = [new Float32Array(128), new Float32Array(128)];
    globalThis.currentFrame = s;
    proc.process([[xl.subarray(s, s + 128), xr.subarray(s, s + 128)]], [o], {});
    ol.set(o[0], s); or.set(o[1], s);
  }
  return { ol, or, proc };
}

/** Signal on L, a constant probe on R: the R output traces the gain curve exactly.
 *  The first L frames are the empty delay line, so the gain reads 1 there. */
function gainCurve(x) {
  const { ol, or } = render(x, new Float32Array(x.length).fill(PROBE));
  return { out: ol, g: Float64Array.from(or, (v, i) => (i < L ? 1 : v / PROBE)) };
}

const maxStepDb = (g) => {
  let m = 0;
  for (let i = 1; i < g.length; i++) m = Math.max(m, Math.abs(20 * Math.log10(g[i] / g[i - 1])));
  return m;
};
const peakAbs = (...chs) => chs.reduce((m, c) => c.reduce((a, v) => Math.max(a, Math.abs(v)), m), 0);

const sig = (n, fn) => Float32Array.from({ length: n }, (_, i) => fn(i));
const tone = (f, a, ph = 0) => (i) => a * Math.sin(2 * Math.PI * f * i / SR + ph);
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 31 - 1; };

// Tone at 0.8 plus 3 kHz decaying transients to 2.5 (one straddles a quantum boundary).
const TRANSIENTS = [24030, 36000 + 120, 40000 + 7];
const toneWithTransients = () => {
  const x = sig(SR, tone(200, 0.8));
  for (const at of TRANSIENTS) {
    for (let i = 0; i < 96; i++) x[at + i] += 2.5 * Math.sin(2 * Math.PI * 3000 * i / SR) * Math.exp(-i / 40);
  }
  return x;
};
// Quiet tone that jumps to a sustained ~2.8x overload at 0.25 s, starting on a crest (a step onset).
const sustainedOverload = () => sig(SR, (i) => (i < SR / 4 ? 0.4 : 2.5) * Math.cos(2 * Math.PI * 200 * (i - SR / 4) / SR));

test('a transient over a tone ramps the gain across the lookahead instead of stepping it', () => {
  const x = toneWithTransients();
  const { out, g } = gainCurve(x);
  const step = maxStepDb(g);
  assert.ok(step < 0.5, `largest one-sample gain step ${step.toFixed(2)} dB`);
  assert.ok(Math.min(...g) < 0.4, 'limiting engaged');
  assert.ok(peakAbs(out) <= CEIL + 1e-6, `peak ${peakAbs(out)}`);
});

test('a step onset into sustained 2.8x overload ramps the gain and keeps the ceiling', () => {
  const x = sustainedOverload();
  const { out, g } = gainCurve(x);
  const step = maxStepDb(g);
  assert.ok(step < 0.5, `largest one-sample gain step ${step.toFixed(2)} dB`);
  // The ramp is monotone and spans the lookahead: it starts as the onset enters the window
  // and reaches the required gain exactly when the onset leaves the delay line.
  const on = SR / 4;
  for (let n = on + 1; n <= on + L; n++) assert.ok(g[n] <= g[n - 1], `gain rose at ${n}`);
  assert.ok(g[on + L / 2] > 0.6, `half-way gain ${g[on + L / 2]}`);
  assert.ok(Math.abs(g[on + L] * 2.5 - CEIL) < 1e-6, `gain at the onset ${g[on + L]}`);
  assert.ok(peakAbs(out) <= CEIL + 1e-6, `peak ${peakAbs(out)}`);
});

test('release still recovers with a 100 ms time constant after the hold', () => {
  const x = sig(SR, tone(200, 0.3));
  for (let i = 0; i < 48; i++) x[12000 + i] = 2.5 * Math.sin(Math.PI * i / 47); // one 1 ms bump to 2.5
  const { g } = gainCurve(x);
  const g0 = Math.min(...g);
  const end = 12000 + 47 + L; // last frame the bump is still in the window feeding the output
  const rec = (g[end + 0.1 * SR] - g0) / (1 - g0);
  assert.ok(rec > 0.55 && rec < 0.7, `recovered ${(rec * 100).toFixed(1)} % after 100 ms`);
});

test('no output sample ever exceeds the -1 dBFS ceiling', () => {
  const n = SR;
  const cases = {
    toneTransients: [toneWithTransients(), toneWithTransients()],
    sustained: [sustainedOverload(), sig(n, tone(330, 2))],
    noise3x: [sig(n, () => 3 * rnd()), sig(n, () => 3 * rnd())],
    spikes: [sig(n, (i) => (i % 997 === 0 ? 10 : 0.5 * Math.sin(i / 9))), sig(n, (i) => (i % 1499 === 3 ? -6 : 0))],
    rightOnly: [sig(n, tone(100, 0.7)), sig(n, (i) => (i > 20000 && i < 20100 ? 4 * rnd() : 0))],
    bursts: [sig(n, (i) => (Math.floor(i / 3000) % 2 ? 2.8 : 0.3) * rnd()), sig(n, tone(60, 1.5))],
  };
  for (const [name, [xl, xr]] of Object.entries(cases)) {
    const { ol, or } = render(xl, xr);
    const pk = peakAbs(ol, or);
    assert.ok(pk <= CEIL + 1e-6, `${name}: peak ${pk} over ceiling ${CEIL}`);
  }
});

test('the limiter is bit-transparent (pure 5 ms delay) below the ceiling', () => {
  const n = SR;
  const xl = sig(n, () => 0.88 * rnd()), xr = sig(n, tone(440, 0.89));
  const { ol, or, proc } = render(xl, xr);
  for (let i = L; i < n; i++) {
    if (ol[i] !== xl[i - L] || or[i] !== xr[i - L]) assert.fail(`frame ${i}: ${ol[i]} vs ${xl[i - L]}, ${or[i]} vs ${xr[i - L]}`);
  }
  const meters = proc.port.posted.map((p) => p.msg).filter((m) => m.t === 'meter');
  assert.ok(meters.every((m) => m.gr === 0), 'no gain reduction reported');
});

test('meters still post every 1536 frames with post-limiter peaks and gain reduction', () => {
  const x = sustainedOverload();
  const { proc } = render(x, x);
  const meters = proc.port.posted.map((p) => p.msg).filter((m) => m.t === 'meter');
  assert.equal(meters.length, Math.floor(SR / 1536));
  meters.forEach((m, k) => {
    assert.equal(m.frame, (k + 1) * 1536);
    assert.ok(m.peakL <= CEIL + 1e-6 && m.peakR <= CEIL + 1e-6);
    for (const key of ['rmsL', 'rmsR', 'gr']) assert.equal(typeof m[key], 'number');
  });
  assert.ok(Math.min(...meters.map((m) => m.gr)) < -8, 'reports the gain reduction');
  assert.equal(meters[0].gr, 0);
});
