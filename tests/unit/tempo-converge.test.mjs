// A live deck's tempo once it locks. The fine beat fit used to swing 0.2-0.5 % for 20-30 s after the lock on steady
// material (traced 120.18 -> 119.37 -> 120.0 on the e2e Web-Audio page): it fitted the phase comb's beats, and the comb,
// an average over its window at the tempo it is given, leans with that tempo's own error and with where the beats fall
// between analysis frames; a capture gap in the fit window tilted it further. Once LOCKED, the tempo may only move
// toward the truth until it is within 0.1 % of it, and then stays within 0.1 %.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OdfCore } from '../../worklets/odf-core.js';
import { DeckTempo } from '../../engine/tempo.js';
import { GridMap } from '../../engine/timeshift.js';
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

// Under a load spike the capture skips in bursts: two or three gaps a few beats apart (seen in both e2e decks at once).
// Each one is found with its own step, so the deck can jump each: one found step for the lot, or none, leaves beats
// off the master's for the phase loop to bend back.

/** x with several gaps {ms, at} (track seconds) and where each lands in the capture (s). */
function gaps(x, sr, list) {
  let y = x, moved = 0;
  const at = [];
  for (const g of [...list].sort((p, q) => p.at - q.at)) { y = gap(y, sr, g.at - moved, g.ms); at.push(g.at - moved); moved += g.ms / 1000; }
  return { y, at };
}

/** Every capture gap the tracker records: {from (s), D (ms)}; the DeckTempo as `deck`. */
function found(x, sr) {
  let deck;
  const odf = new OdfCore(sr, (f, l, t) => deck.pushFrame(f, l, t));
  deck = new DeckTempo({ sampleRate: sr, fps: odf.fps });
  const out = [], detect = deck.detectJump.bind(deck);
  deck.detectJump = () => {
    const was = deck.track.jump;
    detect();
    const j = deck.track.jump;
    if (!j || j === was) return;
    const p = j.prev, b = p.t0 + Math.round((j.from - p.t0) / p.T) * p.T, t0 = deck.clock.t0 / sr, T = deck.clock.T / sr;
    out.push({ from: j.from, D: (t0 + Math.round((b - t0) / T) * T - b) * 1000 });
  };
  for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
  out.deck = deck;
  return out;
}

test('a gap every ten seconds of a long capture: each is found, and the deck keeps only those its window still holds', () => {
  const list = [15, 25, 35, 45, 55, 65, 75].map((at, i) => ({ ms: i % 2 ? -12 : 12, at: at + 0.13 }));
  const f = found(gaps(blips({ kind: 'low', bpm: 124, seconds: 85, lead: 0.003 }), 44100, list).y, 44100);
  assert.equal(f.length, list.length, `found ${f.map((g) => `${g.D.toFixed(1)} ms at ${g.from.toFixed(2)} s`).join(', ')}`);
  assert.ok(f.deck.gaps.length <= 1, `${f.deck.gaps.length} gaps kept`);
});

test('capture gaps a few beats apart are each found, each with its own step', () => {
  for (const [kind, bpm] of [['high', 128], ['low', 124]]) {
    const T = 60 / bpm;
    for (const list of [
      [{ ms: -20, at: 20.1 }, { ms: -20, at: 20.1 + 2 * T }],
      [{ ms: 22, at: 20.3 }, { ms: 30, at: 20.3 + 3 * T }, { ms: 10, at: 20.3 + 8 * T }],
      [{ ms: -15, at: 18.2 }, { ms: 10, at: 18.2 + 4 * T }],
    ]) {
      const { y, at } = gaps(blips({ kind, bpm, seconds: 40, lead: 0.0052 }), 44100, list);
      const f = found(y, 44100), want = [...list].sort((p, q) => p.at - q.at);
      const say = `${kind} ${bpm} BPM, gaps ${want.map((g, i) => `${g.ms} ms at ${at[i].toFixed(2)} s`).join(', ')}: found ${f.map((g) => `${g.D.toFixed(1)} ms at ${g.from.toFixed(2)} s`).join(', ') || 'none'}`;
      assert.equal(f.length, want.length, say);
      // A drop (ms > 0) brings the beats after it early: the grid's beats step by -ms.
      for (const [i, g] of want.entries()) assert.ok(Math.abs(f[i].D + g.ms) < 3 && Math.abs(f[i].from - at[i]) < T, say);
    }
  }
});

/** The e2e pages' sounds at a tempo that goes from b0 to b1 BPM at second `at`, at once or over `ramp` s, its beats unbroken. */
function tempoChange({ kind, b0, b1, at = 20, ramp = 0, seconds = 30, sr = 44100, lead = 0.0052 }) {
  const x = new Float32Array(Math.round(seconds * sr));
  let ph = 0, onset = lead;
  for (let i = Math.round(lead * sr); i < x.length; i++) {
    const t = i / sr, f = t < at ? 0 : ramp > 0 ? Math.min(1, (t - at) / ramp) : 1, was = ph;
    ph += (b0 + (b1 - b0) * f) / 60 / sr;
    if (Math.floor(ph) !== Math.floor(was)) onset = t;
    const u = t - onset;
    if (kind === 'low' && u < 0.2) x[i] = 0.8 * Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-u * 35)) * u) * Math.exp(-u * 18);
    else if (kind === 'high' && u < 0.04) x[i] = 0.6 * Math.sin(2 * Math.PI * 3000 * u) * Math.exp(-u * 90);
    else if (kind === 'mid' && u < 0.08) x[i] = 0.6 * Math.sin(2 * Math.PI * 800 * u) * Math.exp(-u * 50);
  }
  return x;
}

test('a real tempo change of 1-3 % in a live source, at once or over 2 s, is no capture gap', () => {
  // A DJ stream moving its pitch bends the beats onto a new slope that keeps drifting off the grid. A step fitted to the
  // first few beats of that drift looked like a capture gap, and a beat-locked deck (the master too) jumped 12-47 ms
  // where nothing was dropped. A tempo change goes through the tempo and phase paths.
  const bad = [];
  for (const kind of ['low', 'high', 'mid']) {
    for (const [b0, b1] of [[124, 125], [124, 126], [124, 127.5], [128, 126.5], [120, 118], [130, 128.7]]) {
      for (const ramp of [0, 2]) {
        const f = found(tempoChange({ kind, b0, b1, ramp }), 44100);
        if (f.length) bad.push(`${kind} ${b0} -> ${b1} BPM${ramp ? ` over ${ramp} s` : ''}: ${f.map((g) => `${g.D.toFixed(1)} ms at ${g.from.toFixed(2)} s`).join(', ')}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('a capture gap found soon after the lock: the grid before it has the tempo the fine fit found, not the lock\'s', () => {
  // The grid the audio before a gap keeps is the one the clock had when the live edge passed it, seconds after the
  // lock: at the tempo the lock read (0.15-0.4 % off), not the fine fit's that came later. A deck playing that audio
  // seconds behind the live edge (a master, for the clock its followers lock to) ran that much fast or slow.
  for (const [kind, bpm, at] of [['high', 128, 8.6], ['low', 124, 8.3], ['mid', 120, 8.9]]) {
    const x = gap(blips({ kind, bpm, seconds: 30, lead: 0.0052 }), 44100, at, 15);
    let deck;
    const odf = new OdfCore(44100, (f, l, t) => deck.pushFrame(f, l, t));
    deck = new DeckTempo({ sampleRate: 44100, fps: odf.fps });
    const grids = new GridMap(), evaluate = deck.evaluate.bind(deck);
    deck.evaluate = () => { evaluate(); const g = deck.get(); grids.update(g.grid, g.track); };
    for (let s = 0; s + 128 <= x.length; s += 128) odf.push(x.subarray(s, s + 128), s);
    const j = deck.get().track.jump;
    assert.ok(j && Math.abs(j.from - at) < 60 / bpm, `${kind} ${bpm} BPM: the gap at ${at} s was found at ${j && j.from}`);
    const before = grids.at(at - 1);
    assert.ok(Math.abs((60 / before.T) / bpm - 1) < 2e-4, `${kind} ${bpm} BPM: the grid before the gap reads ${(60 / before.T).toFixed(3)} BPM`);
  }
});

/** A recorded capture (tests/unit/fixtures) replayed: the tempo read off more than 0.1 % from `after` s past the lock. */
function captureWander(name, bpm, after = 2.5) {
  const c = JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  const deck = new DeckTempo({ sampleRate: c.sr, fps: c.fps }), rs = [], evaluate = deck.evaluate.bind(deck);
  deck.evaluate = () => { evaluate(); const g = deck.get(); rs.push({ t: deck.tracker.lastT / c.sr, state: g.state, bpm: g.inBpm }); };
  deck.pushBatch({ t0: c.t0, spf: c.spf, full: c.full, low: c.low });
  const lock = rs.find((r) => r.state === 'LOCKED');
  const late = rs.filter((r) => r.t >= lock.t + after && Math.abs(r.bpm / bpm - 1) > 1e-3);
  return { lock, late: late.map((r) => `${r.t.toFixed(1)} s ${r.bpm.toFixed(3)}`) };
}

test('the e2e Web-Audio page as one run captured it (its lock read 119.26): within 0.1 % from 2.5 s after the lock', () => {
  // That run's "native 119.264" failure: the lock read 0.6 % slow, and the tempo shown stayed at it until the fine fit
  // had 8 beats, 3.5 s later. Four beats whose slope is sure are enough.
  const { lock, late } = captureWander('webaudio-capture.json', 120);
  assert.deepEqual(late, [], `locked at ${lock.t.toFixed(1)} s on ${lock.bpm.toFixed(3)}`);
});

test('a capture gap just after the lock, found only as the fit reaches seven beats (two runs captured so): within 0.1 %', () => {
  // A fit of fewer than eight beats took no step: the gap's tilted it 0.3-0.4 % for the evaluation before the gap was
  // found. From five beats it may take one.
  for (const name of ['live-gap-at-lock-capture.json', 'live-gap-at-lock-capture-2.json']) {
    const { lock, late } = captureWander(name, 128);
    assert.deepEqual(late, [], `${name}: locked at ${lock.t.toFixed(1)} s on ${lock.bpm.toFixed(3)}`);
  }
});

test('one beat the capture moved by itself, a few seconds after the lock: the tempo stays within 0.03 %', () => {
  // Under load the capture can move a single beat by 10-15 ms and back, too small a step to find. In the fit's first
  // seconds that one beat tilted it by up to 0.1 %. A beat four times further off the fit than the others (and over
  // 4 ms) is left out.
  for (const [kind, bpm, k, ms] of [['high', 128, 20, 12], ['high', 128, 21, -10], ['low', 124, 18, 12], ['low', 124, 20, -12]]) {
    const T = 60 / bpm, lead = 0.003, on = lead + k * T;
    const x = gap(gap(blips({ kind, bpm, seconds: 30, lead }), 44100, on - 0.1, -ms), 44100, on + ms / 1000 + 0.25, ms);
    const rs = readings(x, 44100), lock = rs.find((r) => r.state === 'LOCKED');
    const off = rs.filter((r) => r.t >= lock.t + 2.5 && Math.abs(r.bpm / bpm - 1) > 3e-4).map((r) => `${r.t.toFixed(1)} s ${r.bpm.toFixed(3)}`);
    assert.deepEqual(off, [], `${kind} ${bpm} BPM, beat ${k} moved ${ms} ms`);
  }
});

test('a live deck with two capture gaps in its first beats after the lock, as one run captured it: within 0.1 %', () => {
  // Neither gap was found yet when the fit reached eight beats; its steps cut the beats into runs too short to say
  // the slope, and it read 123.0 (0.8 % slow) for seconds. A fit whose slope is not sure to 0.1 % is not taken.
  const { lock, late } = captureWander('live-early-gaps-capture.json', 124);
  assert.deepEqual(late, [], `locked at ${lock.t.toFixed(1)} s on ${lock.bpm.toFixed(3)}`);
});

test('a live deck through capture gaps as one run captured it (one gap found a few ms off, the next missed): within 0.1 %', () => {
  // The fine fit used to move the beats before a gap by the step found there: a step a few ms off (or a second gap
  // not found, its step taken into the first) tilted the fit, 0.18 % off for ten seconds. The beats now step at the
  // gap by however much their own onsets say.
  const { lock, late } = captureWander('live-gaps-capture.json', 124);
  assert.deepEqual(late, [], `locked at ${lock.t.toFixed(1)} s on ${lock.bpm.toFixed(3)}`);
});
