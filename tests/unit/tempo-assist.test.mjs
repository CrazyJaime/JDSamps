// A player-assist step (the page's player run a little faster) scales a live deck's tempo by exactly that step: the
// tempo it reports keeps the precision of the fine beat fit it had, rather than falling back to the coarse estimate
// for the 8 s the tracker holds after the step (seen as a live deck's BPM 0.2-0.4 % off through an assist ramp).
import test from 'node:test';
import assert from 'node:assert/strict';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

/** 16 bars of a pattern, then 8 more played `rate` faster; the deck told of the step where it starts. */
function stepped(name, rate) {
  const a = synth({ ...PATTERNS[name], bars: 16, tail: 0 }), b = synth({ ...PATTERNS[name], rate, bars: 8, tail: 0.5 });
  const x = new Float32Array(a.x.length + b.x.length);
  x.set(a.x); x.set(b.x, a.x.length);
  let deck, before = null, told = false;
  const after = [];
  const odf = new OdfCore(FS, (f, l, t) => deck.pushFrame(f, l, t));
  deck = new DeckTempo({ sampleRate: FS, fps: odf.fps });
  const evaluate = deck.evaluate.bind(deck);
  deck.evaluate = () => { evaluate(); if (told) after.push(deck.get().inBpm); else before = deck.get().inBpm; };
  for (let s = 0; s + 128 <= x.length; s += 128) {
    if (!told && s >= a.x.length) { deck.sourceRateChanged(rate, a.x.length); told = true; }
    odf.push(x.subarray(s, s + 128), s);
  }
  return { before, after };
}

for (const [name, bpm] of [['house', 124], ['techno', 132.7], ['pop', 102], ['noisy128', 128]]) {
  test(`${name}: after an assist step of 0.5 % the tempo is the one before it, 0.5 % faster, all the while the tracker holds`, () => {
    const rate = 1.005, { before, after } = stepped(name, rate);
    assert.ok(Math.abs(before - bpm) < 0.05, `before the step ${before}`);
    const held = after.slice(0, 12); // the first 6 s after the step
    for (const [i, x] of held.entries()) assert.ok(Math.abs(x / (before * rate) - 1) < 2e-4, `${(i + 1) * 0.5} s after the step: ${(x / rate).toFixed(3)} BPM before the step's ${before.toFixed(3)}`);
    assert.ok(Math.abs(after.at(-1) / rate - bpm) < 0.05, `at the end ${after.at(-1) / rate}`);
  });
}
