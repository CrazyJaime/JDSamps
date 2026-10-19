// A live deck's tempo once it locks. The fine beat fit used to swing 0.2-0.5 % for 20-30 s after the lock on steady
// material (traced 120.18 -> 119.37 -> 120.0 on the e2e Web-Audio page): it fitted the phase comb's beats, and the comb,
// an average over its window at the tempo it is given, leans with that tempo's own error and with where the beats fall
// between analysis frames; a capture gap in the fit window tilted it further. Once LOCKED, the tempo may only move
// toward the truth until it is within 0.1 % of it, and then stays within 0.1 %.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { synth, PATTERNS, FS } from './fixtures/synth.mjs';

/** The e2e test pages' sounds (makeTrackWav in tests/browser/ext-harness.mjs), after `lead` s of silence, at rate sr. */
function blips({ bpm, kind, seconds = 40, sr = 44100, lead = 0 }) {
  const beat = 60 / bpm, l = Math.round(lead * sr), x = new Float32Array(l + Math.round(seconds * sr));
  for (let i = l; i < x.length; i++) {
    const t = ((i - l) / sr) % beat;
    if (kind === 'low' && t < 0.2) x[i] = 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-t * 35)) * t) * Math.exp(-t * 18);
    else if (kind === 'high' && t < 0.04) x[i] = 0.6 * Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t * 90);
    else if (kind === 'mid' && t < 0.08) x[i] = 0.6 * Math.sin(2 * Math.PI * 800 * t) * Math.exp(-t * 50);
  }
  return x;
}

const silenceFirst = (x, n) => { const y = new Float32Array(x.length + n); y.set(x, n); return y; };

/** x with |ms| of audio dropped (ms > 0) or repeated (ms < 0) at input second `at`, as a capture under load does. */
function gap(x, sr, at, ms) {
  const i = Math.round(at * sr), n = Math.round((Math.abs(ms) / 1000) * sr);
  const y = new Float32Array(x.length + (ms > 0 ? -n : n));
  if (ms > 0) { y.set(x.subarray(0, i)); y.set(x.subarray(i + n), i); } else { y.set(x.subarray(0, i)); y.set(x.subarray(i - n), i); }
  return y;
}

/** Every 0.5 s evaluation: {t, state, bpm}. */
function readings(x, sr) {
  let deck;
  const odf = new OdfCore(sr, (f, l, t) => deck.pushFrame(f, l, t));
  deck = new DeckTempo({ sampleRate: sr, fps: odf.fps });
  const out = [], evaluate = deck.evaluate.bind(deck);
  deck.evaluate = () => { evaluate(); const g = deck.get(); out.push({ t: deck.tracker.lastT / sr, state: g.state, bpm: g.inBpm }); };
  for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
  return out;
}

/** The lock time, and every reading after it that is more than 0.1 % off and further off than an earlier one. */
function wander(rs, truth) {
  const i0 = rs.findIndex((r) => r.state === 'LOCKED');
  const bad = [];
  let best = Infinity;
  for (const r of rs.slice(i0)) {
    if (r.state !== 'LOCKED') { bad.push(`${r.t.toFixed(1)} s ${r.state}`); continue; }
    const e = Math.abs(r.bpm / truth - 1);
    if (e > 1e-3 && e > best + 1e-4) bad.push(`${r.t.toFixed(1)} s ${r.bpm.toFixed(3)}`);
    best = Math.min(best, e);
  }
  return { lockAt: i0 < 0 ? Infinity : rs[i0].t, bad };
}

// The capture of the e2e pages runs at 44.1 kHz; where the beats fall between the tracker's frames is what `lead` moves.
const BLIPS = [
  ['the Web-Audio page (800 Hz blip, 120 BPM)', { kind: 'mid', bpm: 120 }, [0, 0.0052, 0.25, 1.575]],
  ['track A (kick, 124 BPM)', { kind: 'low', bpm: 124 }, [0, 0.003, 0.2]],
  ['track B (click, 128 BPM)', { kind: 'high', bpm: 128 }, [0, 0.004, 0.31]],
];

for (const [name, cfg, leads] of BLIPS) {
  test(`${name}: once LOCKED the tempo only converges, and stays within 0.1 %; the lock is no later`, () => {
    for (const lead of leads) {
      for (const sr of [44100, 48000]) {
        const { lockAt, bad } = wander(readings(blips({ ...cfg, lead, sr }), sr), cfg.bpm);
        assert.ok(lockAt <= lead + 6, `${sr} Hz, ${lead} s of silence first: locked at ${lockAt} s`);
        assert.deepEqual(bad, [], `${sr} Hz, ${lead} s of silence first: readings that strayed`);
      }
    }
  });
}

for (const [name, bpm] of [['house', 124], ['techno', 132.7], ['noisy128', 128], ['pop', 102]]) {
  test(`${name}: once LOCKED the tempo only converges, and stays within 0.1 %`, () => {
    const { x } = synth({ ...PATTERNS[name], bars: Math.round((40 * bpm) / 240) });
    for (const lead of [0, 0.004]) {
      const { lockAt, bad } = wander(readings(silenceFirst(x, Math.round(lead * FS)), FS), bpm);
      assert.ok(lockAt <= lead + 8, `${lead} s of silence first: locked at ${lockAt} s`);
      assert.deepEqual(bad, [], `${lead} s of silence first: readings that strayed`);
    }
  });
}

test('a capture gap of 10-40 ms after the lock does not move the tempo off by more than 0.1 %', () => {
  for (const [kind, bpm] of [['mid', 120], ['low', 124]]) {
    const x = blips({ kind, bpm, lead: 0.0052 });
    for (const ms of [10, -10, 20, -20, 40]) {
      for (const at of [7.1, 10.3, 13.77, 20.2]) {
        const { bad } = wander(readings(gap(x, 44100, at, ms), 44100), bpm);
        assert.deepEqual(bad, [], `${kind} ${bpm} BPM, ${ms > 0 ? 'drop' : 'repeat'} of ${Math.abs(ms)} ms at ${at} s: readings that strayed`);
      }
    }
  }
});
