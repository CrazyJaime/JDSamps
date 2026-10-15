import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dbToGain, gainToDb, knobToGain, crossfaderGains, deckXfGain, chooseMultiplier, syncRatio, lastBeatOut,
  wrapToHalf, phaseError, planCorrection, PHASE_DEADBAND, MasterClock, pickAutoMaster, assistStep, ASSIST,
  engineSemitones, djFilterParams,
} from '../../engine/sync.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('knob law: centre unity, +maxDb right, cubic to -inf left', () => {
  assert.ok(near(knobToGain(0.5, 6), 1));
  assert.ok(near(knobToGain(1, 6), dbToGain(6)));
  assert.ok(near(knobToGain(1, 12), dbToGain(12)));
  assert.ok(near(knobToGain(0.25, 6), 0.125));
  assert.equal(knobToGain(0, 6), 0);
  assert.ok(near(gainToDb(dbToGain(-18)), -18, 1e-9));
  assert.equal(gainToDb(0), -Infinity);
});

test('crossfader curves', () => {
  for (const curve of ['SMOOTH', 'SHARP']) {
    assert.deepEqual(crossfaderGains(0, curve), { a: 1, b: 0 });
    assert.deepEqual(crossfaderGains(1, curve), { a: 0, b: 1 });
  }
  const m = crossfaderGains(0.5, 'SMOOTH');
  assert.ok(near(m.a, Math.SQRT1_2, 1e-12) && near(m.b, Math.SQRT1_2, 1e-12));
  for (let p = 0; p <= 1; p += 0.05) { const g = crossfaderGains(p, 'SMOOTH'); assert.ok(near(g.a ** 2 + g.b ** 2, 1, 1e-9)); }
  assert.deepEqual(crossfaderGains(0.5, 'SHARP'), { a: 1, b: 1 });
  assert.ok(near(crossfaderGains(0.975, 'SHARP').a, 0.5, 1e-9));
  assert.equal(deckXfGain('THRU', { a: 0, b: 0 }), 1);
  assert.equal(deckXfGain('A', { a: 0.3, b: 0.9 }), 0.3);
  assert.equal(deckXfGain('B', { a: 0.3, b: 0.9 }), 0.9);
});

test('sync ratio is half/double aware and range-clamped', () => {
  assert.equal(chooseMultiplier(128, 64), 0.5);
  assert.equal(chooseMultiplier(128, 124), 1);
  assert.equal(chooseMultiplier(87, 174), 2);
  assert.deepEqual(syncRatio(128, 124, 0.1), { ratio: 128 / 124, mult: 1, want: 128 / 124, outOfRange: false });
  const far = syncRatio(128, 174, 0.1);
  assert.equal(far.mult, 1);
  assert.equal(far.outOfRange, true);
  assert.ok(near(far.ratio, 0.9));
  assert.equal(syncRatio(128, 174, 0.5).outOfRange, false);
  assert.ok(near(syncRatio(128, 64, 0.06).ratio, 1));
});

test('beat phase helpers', () => {
  // Grid anchored at input 1.0 s, 0.5 s per beat; playhead at 3.2 s input, rate 1 => 0.2 s past a beat.
  assert.ok(near(lastBeatOut({ t0: 1, T: 0.5 }, 3.2, 1, 100), 99.8, 1e-9));
  // At rate 2 the same input offset takes half the output time.
  assert.ok(near(lastBeatOut({ t0: 1, T: 0.5 }, 3.2, 2, 100), 99.9, 1e-9));
  assert.ok(near(wrapToHalf(0.3, 0.5), -0.2, 1e-12));
  assert.ok(near(wrapToHalf(-0.3, 0.5), 0.2, 1e-12));
  assert.ok(near(wrapToHalf(0.1, 0.5), 0.1, 1e-12));
  assert.ok(near(phaseError(10.02, 0.5, 10.0, 0.5), 0.02, 1e-12));
  assert.ok(near(phaseError(10.48, 0.5, 10.0, 0.5), -0.02, 1e-12));
  // Slave at double time: compare on the finer grid.
  assert.ok(near(phaseError(10.26, 0.25, 10.0, 0.5), 0.01, 1e-12));
});

test('correction planner', () => {
  assert.deepEqual(planCorrection(PHASE_DEADBAND / 2, { audible: true, keyLock: true }), { kind: 'none' });
  assert.deepEqual(planCorrection(0.08, { audible: false, keyLock: true }), { kind: 'jump', seconds: 0.08 });
  const b = planCorrection(0.1, { audible: true, keyLock: true });
  assert.equal(b.kind, 'bend');
  assert.ok(b.bend > 0 && b.bend <= 0.04);
  assert.ok(near(b.bend * b.duration, 0.1, 1e-12));
  const v = planCorrection(-0.1, { audible: true, keyLock: false });
  assert.ok(v.bend < 0 && v.bend >= -0.02);
  assert.ok(near(v.bend * v.duration, -0.1, 1e-12));
  // Just above the dead band: a gentle 1.5% bend for 0.4 s.
  const tiny = planCorrection(0.006, { audible: true, keyLock: true });
  assert.ok(near(tiny.bend, 0.015, 1e-12) && near(tiny.duration, 0.4, 1e-9));
});

test('closed-loop phase sync converges (bends only, 3 ms measurement noise)', () => {
  let seed = 4242; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const P = 60 / 128, dt = 0.01, lockTimes = [];
  for (let trial = 0; trial < 500; trial++) {
    let phase = (rnd() - 0.5) * P, bend = 0, bendEnd = -1, settle = 0, next = 0.5, tLock = null;
    for (let t = 0; t < 20; t += dt) {
      if (t < bendEnd) phase -= bend * dt;
      if (t >= next) {
        next += 0.5;
        if (t >= settle) {
          const plan = planCorrection(wrapToHalf(phase + 0.003 * gauss(), P), { audible: true, keyLock: true });
          if (plan.kind === 'bend') { bend = plan.bend; bendEnd = t + plan.duration; settle = bendEnd + 0.25; }
        }
      }
      if (tLock == null && Math.abs(wrapToHalf(phase, P)) < 0.01 && t >= bendEnd) tLock = t;
    }
    lockTimes.push(tLock ?? 99);
  }
  lockTimes.sort((a, b) => a - b);
  assert.ok(lockTimes[Math.floor(0.95 * (lockTimes.length - 1))] < 8, `p95 lock ${lockTimes[Math.floor(0.95 * (lockTimes.length - 1))]}`);
});

test('master clock follows, goes free, resumes and releases', () => {
  const c = new MasterClock();
  assert.equal(c.beat(1), null);
  c.follow(3);
  c.update(10, { playing: true, bpm: 120, lastBeat: 9.9, period: 0.5 });
  assert.deepEqual(c.state(), { mode: 'deck', deckId: 3, bpm: 120 });
  assert.ok(near(c.beat(10.75).lastBeat, 10.4, 1e-12));
  c.update(11, { playing: false, bpm: 120, lastBeat: 10.9, period: 0.5 });
  assert.equal(c.state().mode, 'free');
  assert.equal(c.assigned, 3);
  assert.ok(near(c.beat(20.1).lastBeat, 19.9, 1e-12)); // free-running on the old grid
  c.update(21, { playing: true, bpm: 126, lastBeat: 20.95, period: 60 / 126 });
  assert.deepEqual(c.state(), { mode: 'deck', deckId: 3, bpm: 126 });
  c.release(3);
  assert.equal(c.state().mode, 'free');
  assert.equal(c.assigned, null);
  c.update(30, null);
  assert.equal(c.state().mode, 'free');
  const fresh = new MasterClock(); fresh.follow(1); fresh.update(1, null);
  assert.equal(fresh.state().mode, 'none');
});

test('auto master prefers a playing, beat-locked, confident, long-running deck', () => {
  assert.equal(pickAutoMaster([]), null);
  assert.equal(pickAutoMaster([{ id: 1, playing: false, canBeat: true, conf: 1, since: 0 }]), null);
  assert.equal(pickAutoMaster([
    { id: 1, playing: true, canBeat: false, conf: 0.9, since: 0 },
    { id: 2, playing: true, canBeat: true, conf: 0.8, since: 5 },
    { id: 3, playing: true, canBeat: true, conf: 0.8, since: 2 },
  ]), 3);
  assert.equal(pickAutoMaster([{ id: 4, playing: true, canBeat: false, conf: 0.4, since: 0 }]), 4);
});

test('assist policy engages, holds, disengages and ramps', () => {
  const base = { need: 1.04, sourceRate: 1, target: 1, available: true, playing: true, enabled: true };
  let r = assistStep({ ...base, reserve: 5 });
  assert.ok(near(r.target, 1.07));
  assert.ok(near(r.next, 1 + ASSIST.step));
  r = assistStep({ ...base, reserve: 12, target: 1.07, sourceRate: 1.07 });
  assert.ok(near(r.target, 1.07)); // hysteresis: still engaged between the waters
  r = assistStep({ ...base, reserve: 25, target: 1.07, sourceRate: 1.07 });
  assert.equal(r.target, 1);
  assert.ok(near(r.next, 1.07 - ASSIST.step));
  assert.equal(assistStep({ ...base, reserve: 2, need: 0.97 }).target, 1);
  assert.equal(assistStep({ ...base, reserve: 2, available: false }).target, 1);
  assert.equal(assistStep({ ...base, reserve: 2, enabled: false }).target, 1);
  assert.equal(assistStep({ ...base, reserve: 2, playing: false }).target, 1);
  assert.equal(assistStep({ ...base, reserve: 2, need: 1.3 }).target, ASSIST.max);
  assert.equal(assistStep({ ...base, reserve: 2, sourceRate: 1.0699, target: 1.07 }).next, 1.07);
  // Hysteresis: tiny tempo refinements do not retarget an engaged assist...
  assert.equal(assistStep({ ...base, need: 1.0405, reserve: 5, target: 1.07, sourceRate: 1.07 }).target, 1.07);
  // ...but a real change (>= 1%) does, and so does a need that the target no longer covers.
  assert.ok(near(assistStep({ ...base, need: 1.06, reserve: 5, target: 1.07, sourceRate: 1.07 }).target, 1.09));
  assert.ok(near(assistStep({ ...base, need: 1.068, reserve: 5, target: 1.07, sourceRate: 1.07 }).target, 1.098));
});

test('engine pitch compensation', () => {
  assert.equal(engineSemitones(true, 1, 1.05), 0);
  assert.ok(near(engineSemitones(true, 1.06, 0.98), -12 * Math.log2(1.06)));
  assert.ok(near(engineSemitones(false, 1.06, 0.98), 12 * Math.log2(0.98)));
});

test('DJ filter mapping', () => {
  assert.equal(djFilterParams(0, 0.3).mode, 'off');
  assert.equal(djFilterParams(0.03, 0.3).mode, 'off');
  const lp = djFilterParams(-1, 0);
  assert.equal(lp.mode, 'lp');
  assert.ok(near(lp.freq, 70, 1e-6));
  const hp = djFilterParams(1, 0);
  assert.equal(hp.mode, 'hp');
  assert.ok(near(hp.freq, 8000, 1e-6));
  assert.ok(djFilterParams(-0.5, 0).freq < 20000 && djFilterParams(-0.5, 0).freq > 70);
  assert.ok(near(djFilterParams(1, 1).q2 - djFilterParams(1, 0).q2, 12, 1e-9));
  assert.ok(near(djFilterParams(1, 0).q1, -5.33) && near(djFilterParams(1, 0).q2, 2.32));
});
