// engine/fx.js — DJ filter and the per-deck FX rack.
//
// rack: in → DJ FILTER → beatfx worklet (GATE/CRUSH) → FLANGER (insert) → post ─┬─ dry ─────────┐
//                                                                               ├─ ECHO send/return ─┼─► out
//                                                                               └─ REVERB send/return ┘
// ECHO and REVERB are send/return so switching them off lets their tails ring out.
import { djFilterParams } from './sync.js';
import { glide, ramp } from './params.js';

const BW_DB = -3.0103;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function bq(ctx, type, freq, Q) {
  const n = ctx.createBiquadFilter();
  n.type = type; n.frequency.value = freq; n.Q.value = Q;
  return n;
}

export function createDjFilter(ctx) {
  const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain();
  const lp1 = bq(ctx, 'lowpass', 20000, -5.33), lp2 = bq(ctx, 'lowpass', 20000, 2.32), lpWet = ctx.createGain();
  const hp1 = bq(ctx, 'highpass', 20, -5.33), hp2 = bq(ctx, 'highpass', 20, 2.32), hpWet = ctx.createGain();
  lpWet.gain.value = 0; hpWet.gain.value = 0;
  input.connect(dry).connect(output);
  input.connect(lp1).connect(lp2).connect(lpWet).connect(output);
  input.connect(hp1).connect(hp2).connect(hpWet).connect(output);
  let mode = 'off';
  return {
    input,
    output,
    set(x, res) {
      const p = djFilterParams(x, res);
      const now = ctx.currentTime;
      const pair = p.mode === 'lp' ? [lp1, lp2] : p.mode === 'hp' ? [hp1, hp2] : null;
      if (pair) {
        if (p.mode !== mode) for (const f of pair) { f.frequency.cancelScheduledValues(now); f.frequency.setValueAtTime(p.freq, now); }
        else for (const f of pair) glide(ctx, f.frequency, p.freq, 0.015);
        glide(ctx, pair[1].Q, p.q2, 0.02);
      }
      if (p.mode !== mode) {
        ramp(ctx, dry.gain, p.mode === 'off' ? 1 : 0, 0.01);
        ramp(ctx, lpWet.gain, p.mode === 'lp' ? 1 : 0, 0.01);
        ramp(ctx, hpWet.gain, p.mode === 'hp' ? 1 : 0, 0.01);
        mode = p.mode;
      }
    },
    dispose() { for (const n of [input, output, dry, lp1, lp2, lpWet, hp1, hp2, hpWet]) n.disconnect(); },
  };
}

function tanhCurve() {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) { const x = (i / (c.length - 1)) * 2 - 1; c[i] = Math.tanh(1.2 * x) / Math.tanh(1.2); }
  return c;
}

function createEcho(ctx) {
  const input = ctx.createGain(); input.gain.value = 0;
  const delay = ctx.createDelay(4);
  const hp = bq(ctx, 'highpass', 150, BW_DB), lp = bq(ctx, 'lowpass', 4500, BW_DB);
  const sat = ctx.createWaveShaper(); sat.curve = tanhCurve();
  const fb = ctx.createGain(); fb.gain.value = 0.5;
  const output = ctx.createGain();
  input.connect(delay);
  delay.connect(hp).connect(lp);
  lp.connect(output);
  lp.connect(sat).connect(fb).connect(delay);
  return {
    input,
    output,
    set({ on, level, bpm, beats }, immediate) {
      const t = clamp((beats * 60) / bpm, 0.02, 3.9);
      if (immediate) delay.delayTime.setValueAtTime(t, ctx.currentTime); else glide(ctx, delay.delayTime, t, 0.05);
      glide(ctx, fb.gain, 0.3 + 0.45 * level, 0.02);
      ramp(ctx, input.gain, on ? Math.min(1, 0.4 + 0.6 * level) : 0, 0.01);
    },
    dispose() { for (const n of [input, delay, hp, lp, sat, fb, output]) n.disconnect(); },
  };
}

export const REVERB_SIZES = Object.freeze({ ROOM: 0.8, HALL: 2.2, WASH: 5 });
const reverbSize = (beats) => (beats <= 0.25 ? REVERB_SIZES.ROOM : beats <= 1 ? REVERB_SIZES.HALL : REVERB_SIZES.WASH);

export function makeImpulse(ctx, t60, seed = 1) {
  const sr = ctx.sampleRate, len = Math.ceil(sr * t60 * 1.1);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    let s = (seed * 9301 + c * 49297) >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const d = buf.getChannelData(c);
    let lpState = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const cutoff = 12000 * (2000 / 12000) ** Math.min(1, t / t60);
      const a = Math.exp((-2 * Math.PI * cutoff) / sr);
      lpState = (1 - a) * rnd() + a * lpState;
      d[i] = lpState * 10 ** ((-3 * t) / t60);
    }
    for (let k = 0; k < 7; k++) {
      const at = Math.round(sr * (0.007 + 0.009 * k + 0.002 * c));
      if (at < len) d[at] += 0.5 * 0.8 ** k * (k % 2 ? -1 : 1);
    }
  }
  return buf;
}

function createReverb(ctx, t60) {
  const input = ctx.createGain(); input.gain.value = 0;
  const hp = bq(ctx, 'highpass', 250, BW_DB);
  const pre = ctx.createDelay(0.1); pre.delayTime.value = 0.015;
  const conv = ctx.createConvolver(); conv.normalize = true; conv.buffer = makeImpulse(ctx, t60);
  const output = ctx.createGain(); output.gain.value = 0.7;
  input.connect(hp).connect(pre).connect(conv).connect(output);
  return { input, output, t60, dispose() { for (const n of [input, hp, pre, conv, output]) n.disconnect(); } };
}

function createFlanger(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const delay = ctx.createDelay(0.05); delay.delayTime.value = 0.003;
  const wet = ctx.createGain(); wet.gain.value = 0;
  const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 0.25;
  const depth = ctx.createGain(); depth.gain.value = 0.002;
  lfo.connect(depth).connect(delay.delayTime);
  lfo.start();
  input.connect(output);
  input.connect(delay).connect(wet).connect(output);
  return {
    input,
    output,
    set({ on, level, bpm, beats }) {
      const periodBeats = clamp(beats * 8, 1, 32);
      glide(ctx, lfo.frequency, bpm / 60 / periodBeats, 0.05);
      ramp(ctx, wet.gain, on ? level : 0, 0.01);
    },
    dispose() { try { lfo.stop(); } catch (_) {} for (const n of [input, output, delay, wet, lfo, depth]) n.disconnect(); },
  };
}

export function createFxRack(ctx) {
  const filter = createDjFilter(ctx);
  const beatfx = new AudioWorkletNode(ctx, 'jds-beatfx', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
  });
  const flanger = createFlanger(ctx);
  const echo = createEcho(ctx);
  const post = ctx.createGain(), output = ctx.createGain();
  filter.output.connect(beatfx).connect(flanger.input);
  flanger.output.connect(post);
  post.connect(output);
  post.connect(echo.input);
  echo.output.connect(output);
  let reverb = null;
  const retiring = []; // [{rv, at}] reverbs whose tails are ringing out
  const s = { type: 'ECHO', beats: 0.5, level: 0.5, on: false, bpm: 120 };
  let first = true;

  function applyReverb(enabled) {
    const size = reverbSize(s.beats);
    if (enabled && (!reverb || reverb.t60 !== size)) {
      if (reverb) retire(reverb);
      reverb = createReverb(ctx, size);
      post.connect(reverb.input);
      reverb.output.connect(output);
    }
    if (reverb) ramp(ctx, reverb.input.gain, enabled ? 0.5 + 0.5 * s.level : 0, 0.01);
    if (!enabled && reverb) { retire(reverb); reverb = null; }
  }
  function retire(rv) {
    ramp(ctx, rv.input.gain, 0, 0.01);
    retiring.push({ rv, at: ctx.currentTime + rv.t60 + 0.5 });
  }

  function apply() {
    const on = (t) => s.on && s.type === t;
    echo.set({ on: on('ECHO'), level: s.level, bpm: s.bpm, beats: s.beats }, first);
    flanger.set({ on: on('FLANGER'), level: s.level, bpm: s.bpm, beats: s.beats });
    beatfx.port.postMessage({ t: 'gate', depth: s.level, stepBeats: s.beats });
    beatfx.port.postMessage({ t: 'crush', amount: s.level });
    beatfx.port.postMessage({ t: 'mode', mode: on('GATE') ? 'gate' : on('CRUSH') ? 'crush' : 'off' });
    applyReverb(on('REVERB'));
    first = false;
  }

  return {
    input: filter.input,
    output,
    beatfx,
    setFilter(x, res) { filter.set(x, res); },
    setFx(partial) { Object.assign(s, partial); if (!(s.bpm > 0)) s.bpm = 120; apply(); },
    setClock(anchorFrame, periodFrames) { beatfx.port.postMessage({ t: 'clock', anchorFrame, periodFrames }); },
    tick(now) {
      for (let i = retiring.length - 1; i >= 0; i--) if (now >= retiring[i].at) { retiring[i].rv.dispose(); retiring.splice(i, 1); }
    },
    dispose() {
      filter.dispose(); flanger.dispose(); echo.dispose();
      if (reverb) reverb.dispose();
      for (const r of retiring) r.rv.dispose();
      beatfx.port.postMessage({ t: 'dispose' }); // else Chrome keeps running the disconnected processor
      beatfx.port.close();
      for (const n of [beatfx, post, output]) n.disconnect();
    },
  };
}
