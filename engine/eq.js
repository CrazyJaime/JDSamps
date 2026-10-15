// engine/eq.js — DJ-style 3-band isolator (Linkwitz-Riley 4th order) and input trim.
//
//  in ─┬─ LP ─ LP ─ AP(high) ─────────── gLow ─┐
//      └─ HP ─ HP ─┬─ LP(high) ─ LP(high) ─ gMid ─┼─► out
//                  └─ HP(high) ─ HP(high) ─ gHi ──┘
// LP/HP Q is in dB in Web Audio: -3.0103 dB = Butterworth (0.7071). The allpass Q is linear.
// LR4 LP + LR4 HP = 2nd-order allpass, so the allpass on the low band makes all bands sum flat.
import { knobToGain } from './sync.js';
import { glide, ramp } from './params.js';

const BW_DB = -3.0103;

function bq(ctx, type, freq, Q) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.frequency.value = freq;
  n.Q.value = Q;
  return n;
}

export function createIsolator(ctx, { low = 250, high = 2500 } = {}) {
  const input = ctx.createGain(), output = ctx.createGain();
  const lp1 = bq(ctx, 'lowpass', low, BW_DB), lp2 = bq(ctx, 'lowpass', low, BW_DB), ap = bq(ctx, 'allpass', high, Math.SQRT1_2);
  const hp1 = bq(ctx, 'highpass', low, BW_DB), hp2 = bq(ctx, 'highpass', low, BW_DB);
  const mlp1 = bq(ctx, 'lowpass', high, BW_DB), mlp2 = bq(ctx, 'lowpass', high, BW_DB);
  const hhp1 = bq(ctx, 'highpass', high, BW_DB), hhp2 = bq(ctx, 'highpass', high, BW_DB);
  const gains = { low: ctx.createGain(), mid: ctx.createGain(), hi: ctx.createGain() };
  input.connect(lp1).connect(lp2).connect(ap).connect(gains.low).connect(output);
  input.connect(hp1).connect(hp2);
  hp2.connect(mlp1).connect(mlp2).connect(gains.mid).connect(output);
  hp2.connect(hhp1).connect(hhp2).connect(gains.hi).connect(output);
  const knob = { low: 0.5, mid: 0.5, hi: 0.5 };
  const killed = { low: false, mid: false, hi: false };
  const target = (band) => (killed[band] ? 0 : knobToGain(knob[band], 6));
  const nodes = [input, lp1, lp2, ap, hp1, hp2, mlp1, mlp2, hhp1, hhp2, gains.low, gains.mid, gains.hi, output];
  return {
    input,
    output,
    set(band, k) { knob[band] = k; if (!killed[band]) glide(ctx, gains[band].gain, target(band)); },
    kill(band, on) { killed[band] = !!on; ramp(ctx, gains[band].gain, target(band), 0.005); },
    dispose() { for (const n of nodes) n.disconnect(); },
  };
}

export function createTrim(ctx) {
  const g = ctx.createGain();
  return { input: g, output: g, set(k) { glide(ctx, g.gain, knobToGain(k, 12)); }, dispose() { g.disconnect(); } };
}
