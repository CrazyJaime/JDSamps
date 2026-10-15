// engine/sync.js — pure maths for mixing, sync and player assist. No Web Audio, no chrome.*.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/** Gain knob: centre = unity, right end = +maxDb, left side cubic down to silence. */
export function knobToGain(k, maxDb) {
  if (k >= 0.5) return dbToGain((maxDb * (Math.min(1, k) - 0.5)) / 0.5);
  const x = 2 * Math.max(0, k);
  return x * x * x;
}

/** Gains for decks assigned to side A and side B. */
export function crossfaderGains(pos, curve) {
  const p = clamp(pos, 0, 1);
  if (curve === 'SHARP') {
    const edge = 0.05;
    return { a: p <= 1 - edge ? 1 : (1 - p) / edge, b: p >= edge ? 1 : p / edge };
  }
  const a = Math.cos((p * Math.PI) / 2), b = Math.sin((p * Math.PI) / 2);
  return { a: a < 1e-9 ? 0 : a, b: b < 1e-9 ? 0 : b };
}

export function deckXfGain(assign, g) {
  return assign === 'A' ? g.a : assign === 'B' ? g.b : 1;
}

export function chooseMultiplier(masterBpm, nativeBpm) {
  let best = 1, bestErr = Infinity;
  for (const m of [1, 0.5, 2]) {
    const e = Math.abs(Math.log2((masterBpm * m) / nativeBpm));
    if (e < bestErr - 1e-12) { bestErr = e; best = m; }
  }
  return best;
}

/** Tempo ratio (1+pitch) that makes a deck of `nativeBpm` play at `masterBpm`·mult. */
export function syncRatio(masterBpm, nativeBpm, range) {
  const mult = chooseMultiplier(masterBpm, nativeBpm);
  const want = (masterBpm * mult) / nativeBpm;
  const ratio = clamp(want, 1 - range, 1 + range);
  return { ratio, mult, want, outOfRange: Math.abs(ratio - want) > 1e-9 };
}

/** Output time of the most recent beat at or before tOut, from the deck's input-time grid. */
export function lastBeatOut(grid, playhead, engineRate, tOut) {
  const beats = (playhead - grid.t0) / grid.T;
  const frac = beats - Math.floor(beats);
  return tOut - (frac * grid.T) / engineRate;
}

export function wrapToHalf(x, P) {
  return ((((x + P / 2) % P) + P) % P) - P / 2;
}

/** Positive = the slave's beats arrive later than the master's (slave must speed up). */
export function phaseError(slaveLast, slavePeriod, masterLast, masterPeriod) {
  return wrapToHalf(slaveLast - masterLast, Math.min(slavePeriod, masterPeriod));
}

export const PHASE_DEADBAND = 0.005;

/**
 * Plan one correction for phase error e (seconds).
 * bend: play at rate·(1+bend) for `duration` seconds (bend·duration = e exactly).
 * jump: move the playhead forward by e output-seconds (caller multiplies by engineRate).
 */
export function planCorrection(e, { audible, keyLock }) {
  const ae = Math.abs(e);
  if (ae <= PHASE_DEADBAND) return { kind: 'none' };
  if (!audible) return { kind: 'jump', seconds: e };
  const dmax = keyLock ? 0.04 : 0.02, dmin = 0.005, target = 0.4;
  const bend = Math.sign(e) * clamp(ae / target, dmin, dmax);
  return { kind: 'bend', bend, duration: ae / Math.abs(bend) };
}

/**
 * Traktor-style master clock. Follows an assigned deck while it plays; when the deck
 * pauses or disappears the clock keeps running freely on the last tempo and phase.
 */
export class MasterClock {
  constructor() {
    this.mode = 'none';
    this.assigned = null;
    this.bpm = null;
    this.anchor = 0;
    this.period = 0;
  }

  follow(deckId) { this.assigned = deckId; this.mode = this.bpm ? 'free' : 'none'; }

  release(deckId) {
    if (this.assigned !== deckId) return;
    this.assigned = null;
    this.mode = this.bpm ? 'free' : 'none';
  }

  /** info: {playing, bpm, lastBeat, period} for the assigned deck, or null if unavailable. */
  update(tOut, info) {
    if (this.assigned == null) return;
    if (info && info.playing && info.bpm > 0 && info.period > 0) {
      this.mode = 'deck';
      this.bpm = info.bpm;
      this.anchor = info.lastBeat;
      this.period = info.period;
    } else {
      this.mode = this.bpm ? 'free' : 'none';
    }
  }

  beat(tOut) {
    if (this.mode === 'none' || !(this.period > 0)) return null;
    const k = Math.floor((tOut - this.anchor) / this.period);
    return { lastBeat: this.anchor + k * this.period, period: this.period, bpm: this.bpm };
  }

  state() {
    return { mode: this.mode, deckId: this.mode === 'deck' ? this.assigned : null, bpm: this.mode === 'none' ? null : this.bpm };
  }
}

/** Choose the deck that should become master when SYNC is pressed with no master. */
export function pickAutoMaster(cands) {
  const playing = cands.filter((c) => c.playing);
  if (!playing.length) return null;
  playing.sort((x, y) => (y.canBeat - x.canBeat) || (y.conf - x.conf) || (x.since - y.since));
  return playing[0].id;
}

export const ASSIST = Object.freeze({ lowWater: 8, highWater: 20, headroom: 0.03, max: 1.25, step: 0.0025 });

/**
 * Player-assist policy, evaluated every 250 ms per deck.
 * need = total tempo ratio the deck must play at; reserve = seconds of buffered audio ahead.
 * Returns the new target source rate and the next ramped value to send to the tab.
 */
export function assistStep(s, o = ASSIST) {
  let target = s.target ?? 1;
  const engaged = target > 1;
  // Retarget only for real changes (≥ 1%) or when the current target would let the reserve
  // drain; chasing tiny tempo refinements would schedule a rate crossing every step.
  const follow = () => {
    const want = Math.min(o.max, s.need + o.headroom);
    return !engaged || want > target + 1e-9 && target < s.need + 0.005 || Math.abs(want - target) >= 0.01 ? want : target;
  };
  if (!s.enabled || !s.available || !s.playing || s.need <= 1) target = 1;
  else if (s.reserve < o.lowWater) target = follow();
  else if (s.reserve > o.highWater) target = 1;
  else if (engaged) target = follow();
  const d = target - s.sourceRate;
  const next = Math.abs(d) <= o.step + 1e-12 ? target : s.sourceRate + Math.sign(d) * o.step;
  return { target, next };
}

/** Pitch shift for the stretch node so key lock holds the original key (assist resamples). */
export function engineSemitones(keyLock, sourceRate, engineRate) {
  return (keyLock ? -12 * Math.log2(sourceRate) : 12 * Math.log2(engineRate)) + 0; // + 0 normalises -0
}

/** One-knob DJ filter: x<0 low-pass sweep (20 kHz→70 Hz), x>0 high-pass (20 Hz→8 kHz). */
export function djFilterParams(x, res) {
  const ax = Math.abs(x);
  const q1 = -5.33, q2 = 2.32 + 12 * clamp(res, 0, 1);
  if (ax < 0.04) return { mode: 'off', freq: 0, q1, q2 };
  const u = (Math.min(1, ax) - 0.04) / 0.96;
  if (x < 0) return { mode: 'lp', freq: 20000 * (70 / 20000) ** u, q1, q2 };
  return { mode: 'hp', freq: 20 * (8000 / 20) ** u, q1, q2 };
}
