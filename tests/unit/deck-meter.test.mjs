// Deck meters: measured post-fader in the master worklet (one input per deck slot, after the bus)
// instead of reading an AnalyserNode per deck on the engine's main thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorklet } from './worklet-shim.mjs';
import { makeEngine, makeDeck } from './fixtures/deck-harness.mjs';

const SR = 48000, TICK = 1536, DECKS = 6;
const reg = await loadWorklet('worklets/master.js', { sampleRate: SR });
const Master = reg['jds-master'];

/** Runs the master worklet over `frames` with the bus silent and decks[k] = [L, R] (or null) on input k + 1. */
function render(decks, frames) {
  const proc = new Master({ numberOfInputs: 1 + DECKS });
  const zero = new Float32Array(128);
  for (let s = 0; s + 128 <= frames; s += 128) {
    globalThis.currentFrame = s;
    const inputs = [[zero, zero]];
    for (let k = 0; k < DECKS; k++) inputs.push(decks[k] ? decks[k].map((c) => c.subarray(s, s + 128)) : []);
    proc.process(inputs, [[new Float32Array(128), new Float32Array(128)]], {});
  }
  return proc.port.posted.map((p) => p.msg).filter((m) => m.t === 'meter');
}
const sig = (n, fn) => Float32Array.from({ length: n }, (_, i) => fn(i));
const tone = (f, a, ph = 0) => (i) => a * Math.sin(2 * Math.PI * f * i / SR + ph);

/** What the deck read from its AnalyserNode (fftSize 2048) at a tick: the mono mix's last 2048 frames. */
function analyserMethod([l, r], end) {
  let pk = 0, sq = 0;
  for (let i = end - 2048; i < end; i++) { const x = 0.5 * (l[i] + r[i]), a = Math.abs(x); if (a > pk) pk = a; sq += x * x; }
  return { peak: pk, rms: Math.sqrt(sq / 2048) };
}

test('the master worklet posts each deck input\'s post-fader peak and RMS with its tick, as the analyser read them', () => {
  const n = SR;
  const d1 = [sig(n, tone(440, 0.5)), sig(n, tone(440, 0.3, 0.4))];
  const d3 = [sig(n, tone(97, 0.05)), sig(n, tone(97, 0.05))];
  const meters = render([d1, null, d3], n);
  assert.equal(meters.length, Math.floor(n / TICK));
  for (const m of meters.slice(2)) {
    assert.equal(m.decks.length, 3 * DECKS);
    for (const [k, d] of [[0, d1], [2, d3]]) {
      const old = analyserMethod(d, m.frame);
      const [peak, rms, clip] = m.decks.slice(3 * k, 3 * k + 3);
      assert.ok(Math.abs(peak - old.peak) <= 0.01 * old.peak, `deck ${k + 1} peak ${peak} vs ${old.peak}`);
      assert.ok(Math.abs(rms - old.rms) <= 0.02 * old.rms, `deck ${k + 1} rms ${rms} vs ${old.rms}`);
      assert.equal(clip, -1, 'never clipped');
    }
    assert.deepEqual(m.decks.slice(3, 6), [0, 0, -1], 'an unconnected input reads silence');
  }
});

test('a clip between two reads is latched in the worklet: its frame comes with every later tick', () => {
  const n = SR / 2, at = 10000;
  const d = [sig(n, (i) => (i === at ? 1 : 0.01)), sig(n, (i) => (i === at ? 1 : 0.01))];
  const meters = render([d], n);
  const k = meters.findIndex((m) => m.frame > at);
  assert.equal(meters[k].decks[0], 1, 'the clip is in its own tick\'s peak');
  for (const m of meters.slice(0, k)) assert.equal(m.decks[2], -1);
  for (const m of meters.slice(k)) assert.equal(m.decks[2], at);
  assert.ok(meters.at(-1).decks[0] < 0.02, 'later peaks are the signal\'s own');
});

test('Deck.meterTick reads its slot from the master meter and never an AnalyserNode; a clip read late still lights for 2 s from the clip', () => {
  const clock = { t: 10 };
  const engine = makeEngine(clock);
  let last = { t: 'meter', frame: 0, decks: new Array(3 * DECKS).fill(0) };
  engine.master.deckMeter = (slot) => { const i = 3 * (slot - 1); return { peak: last.decks[i], rms: last.decks[i + 1], clipFrame: last.decks[i + 2] }; };
  const d = makeDeck(engine, clock, { id: 2, slot: 2 });
  let analyserReads = 0;
  d.analyser = { getFloatTimeDomainData() { analyserReads++; } };
  const post = (vals, at) => { last = { t: 'meter', frame: Math.round(clock.t * SR), decks: new Array(3 * DECKS).fill(0) }; last.decks.splice(3, 3, ...vals); };
  for (let k = 0; k < 3; k++) last.decks[3 * k + 2] = -1;
  post([0.5, 0.2, -1]);
  d.meterTick(clock.t);
  assert.deepEqual(d.state(clock.t).meter, { peak: 0.5, rms: 0.2, clip: false });
  // A hidden deck page gets a state (and a meter read) every 0.5 s: the clip happened in between.
  const clipAt = clock.t + 0.1;
  clock.t += 0.5;
  post([0.3, 0.1, Math.round(clipAt * SR)]);
  d.meterTick(clock.t);
  assert.equal(d.state(clock.t).meter.clip, true, 'clip read late');
  clock.t = clipAt + 1.9;
  d.meterTick(clock.t);
  assert.equal(d.state(clock.t).meter.clip, true, 'still lit 1.9 s after the clip');
  clock.t = clipAt + 2.05;
  d.meterTick(clock.t);
  assert.equal(d.state(clock.t).meter.clip, false, 'off 2 s after the clip');
  // clipReset clears it; the same latched clip does not light it again.
  clock.t = clipAt + 1;
  d.meter.clipUntil = 0;
  d.meterTick(clock.t);
  assert.equal(d.state(clock.t).meter.clip, false);
  assert.equal(analyserReads, 0, 'no AnalyserNode read');
});
